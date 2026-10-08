// Replaces the local `wrangler dev` database with a snapshot taken by
// `wrangler d1 export` from a deployed system, so a development machine starts
// with data rather than with one admin and nothing else.
//
//   npm run db:restore:local -- <export.sql>
//
// Local only: it never names `--remote` and never reads a credential.
//
// ## Why it does not just `wrangler d1 execute --file` the export
//
// The export creates tables in their stored order and loads each one's rows
// straight after it. Several early tables have a foreign key into `users`,
// which comes later, and local D1 refuses a row whose parent *table* does not
// exist yet — `PRAGMA defer_foreign_keys` defers the row check, not that one.
// So the export is split: everything that is not a row first (tables and
// indexes, which may name tables that come later), then every row under
// deferred foreign keys. This relies on the export writing one `INSERT` per
// line, which it does — a newline inside a value is written as `char(10)`.
//
// ## What happens to the database it replaces
//
// It is moved aside to `.wrangler/state/v3/d1.before-restore-<timestamp>`, not
// deleted. Delete those folders by hand once you no longer want them.
//
// ## After the rows are in
//
// Migrations are applied on top, so a snapshot older than the checked-out code
// is brought up to date the same way a deployed database is. Then the local
// sign-in is made to work: the dummy provider signs in as any address that is
// already an active user, and a deployed system's admins have real addresses
// a developer cannot use. The seeded admin from migration 0007 gets its
// `pete@x.com` address back — or is recreated, if the snapshot never had it —
// exactly as the local database was set up by hand on 2026-09-24.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const DATABASE = 'foodbank-test';
const LOCAL_D1_STATE = join(root, '.wrangler', 'state', 'v3', 'd1');
const DEV_PORT = 8787;

// Migration 0007's row. Kept in step with that file by hand; it is data that
// has not changed since it was written and is never meant to.
const BOOTSTRAP_ADMIN_ID = '6814d1ea-eb23-4f09-919e-911c750e4a66';
const BOOTSTRAP_ADMIN_EMAIL = 'pete@x.com';

export const LOCAL_ADMIN_SQL = `
UPDATE users SET email = '${BOOTSTRAP_ADMIN_EMAIL}', role = 'admin', is_active = 1
  WHERE id = '${BOOTSTRAP_ADMIN_ID}'
    AND NOT EXISTS (SELECT 1 FROM users WHERE email = '${BOOTSTRAP_ADMIN_EMAIL}');
INSERT INTO users (id, email, display_name, role, google_subject, is_active, last_login_at, created_at, updated_at)
  SELECT '${BOOTSTRAP_ADMIN_ID}', '${BOOTSTRAP_ADMIN_EMAIL}', 'Pete', 'admin', NULL, 1, NULL,
         '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
  WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = '${BOOTSTRAP_ADMIN_EMAIL}');
UPDATE users SET role = 'admin', is_active = 1 WHERE email = '${BOOTSTRAP_ADMIN_EMAIL}';
`;

/**
 * Splits a `wrangler d1 export` into its schema and its rows. Refuses anything
 * that is not a full export: a data-only export has nothing to create the
 * tables, and without `d1_migrations` the migrations step would try to rerun
 * every migration over existing tables.
 */
export function splitExport(text) {
  if (!text.includes('CREATE TABLE IF NOT EXISTS "d1_migrations"')) {
    throw new Error(
      'Not a full `wrangler d1 export`: it does not create d1_migrations. ' +
        'Export without --no-schema and without --table.',
    );
  }
  const schema = [];
  const rows = [];
  for (const line of text.split('\n')) {
    (line.startsWith('INSERT INTO ') ? rows : schema).push(line);
  }
  return {
    schema: schema.join('\n'),
    data: ['PRAGMA defer_foreign_keys=TRUE;', ...rows].join('\n'),
    rowCount: rows.length,
  };
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function wrangler(args) {
  const result = spawnSync('npx', ['wrangler', ...args], { cwd: root, stdio: 'inherit' });
  // Thrown, not fail(): process.exit would skip the caller's cleanup of the
  // temporary copies, and those hold the snapshot's rows.
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed; see its output above.`);
  }
}

/** True if something is listening on the dev server's port. */
function devServerRunning() {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port: DEV_PORT });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] === '--help' || argv[0] === '-h') {
    fail('Usage: npm run db:restore:local -- <export.sql>');
  }
  const file = resolve(argv[0]);
  if (!existsSync(file)) fail(`No such file: ${file}`);

  // wrangler dev holds the database open; replacing it underneath leaves the
  // running server on the old one.
  if (await devServerRunning()) fail(`Stop \`npm run dev\` first (port ${DEV_PORT} is in use).`);

  let parts;
  try {
    parts = splitExport(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (existsSync(LOCAL_D1_STATE)) {
    const aside = `${LOCAL_D1_STATE}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(LOCAL_D1_STATE, aside);
    console.log(`Previous local database moved to ${aside}`);
  }

  const work = mkdtempSync(join(tmpdir(), 'foodbank-restore-'));
  let failure;
  try {
    const schemaFile = join(work, 'schema.sql');
    const dataFile = join(work, 'data.sql');
    const adminFile = join(work, 'admin.sql');
    writeFileSync(schemaFile, parts.schema);
    writeFileSync(dataFile, parts.data);
    writeFileSync(adminFile, LOCAL_ADMIN_SQL);

    console.log('Creating tables and indexes...');
    wrangler(['d1', 'execute', DATABASE, '--local', '--yes', '--file', schemaFile]);
    console.log(`Loading ${parts.rowCount} rows...`);
    wrangler(['d1', 'execute', DATABASE, '--local', '--yes', '--file', dataFile]);
    console.log('Applying any migrations newer than the snapshot...');
    wrangler(['d1', 'migrations', 'apply', DATABASE, '--local']);
    console.log(`Making ${BOOTSTRAP_ADMIN_EMAIL} an active admin for local sign-in...`);
    wrangler(['d1', 'execute', DATABASE, '--local', '--yes', '--file', adminFile]);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (failure !== undefined) fail(failure);

  console.log(
    `\nRestored. Start the server with \`npm run dev\` and sign in as ${BOOTSTRAP_ADMIN_EMAIL}.`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
