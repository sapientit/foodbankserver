// Turns a `wrangler d1 export` of one deployed system into the file that
// seeds another with configuration only — UAT into production, as test was
// into UAT on 2026-09-29.
//
//   node scripts/ops/build-seed.mjs <export.sql> <out-dir>
//
// Local only: it reads a file and writes files, and never names a database.
// The export holds whatever personal data the source had, so keep both it and
// <out-dir> outside the repository.
//
// ## Why the export is not loaded as it stands
//
// The 2026-09-29 rehearsal failed on foreign keys. The export loads each table's
// rows straight after creating it, in stored order rather than dependency
// order, and relies on `PRAGMA defer_foreign_keys` — which remote D1 does not
// honour across a file import. So this script never hands the export to D1.
// It loads it into memory, prunes it with `prune-to-config.sql` under enforced
// foreign keys, then writes every surviving row itself, parents first, in an
// order worked out from the schema's own `PRAGMA foreign_key_list` rather than
// a hand-kept list that a later migration could quietly make wrong.
//
// Before writing anything it proves the result: the seed is loaded into an
// empty copy of the schema with foreign keys on and nothing deferred, the way
// remote D1 will load it, and every table's row count is compared.
//
// ## What it writes
//
// - `seed.sql` — one INSERT per line, parents first. No schema, no PRAGMA, no
//   `d1_migrations`, `sqlite_sequence` or `_cf_*`: the target is migrated
//   first and keeps its own migration record.
// - `wipe-seeded-rows.sql` — removes the rows migrations seed into a freshly
//   migrated database (0007's stand-in admin, 0034's grouping, 0040's baseline
//   release). Run it on the target first: the source carries its own copies
//   of the last two, and the stand-in admin must not survive anywhere real.
// - `counts.json` — rows per table in `seed.sql`, to compare after loading.
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PRUNE_SQL = resolve(import.meta.dirname, 'prune-to-config.sql');

// Kept in step with the migrations named by hand; they have not changed since
// they were written and are never meant to.
export const SEEDED_ROWS = [
  { table: 'configuration_releases', id: '6f1d2c3a-8b4e-4f5a-9c7d-0e1f2a3b4c40' }, // 0040
  { table: 'stock_take_groupings', id: '4c55e811-9b7c-482c-ab4c-a700876d49bd' }, // 0034
  { table: 'users', id: '6814d1ea-eb23-4f09-919e-911c750e4a66' }, // 0007
];

const isSystemTable = (name) =>
  name === 'd1_migrations' ||
  name === 'sqlite_sequence' ||
  name.startsWith('sqlite_') ||
  name.startsWith('_cf_');

const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * Loads a full export (schema and rows) into an in-memory database. Tables
 * and indexes first, then rows under deferred foreign keys — the export's own
 * order fails with foreign keys on, which is the problem this script exists for.
 */
export function loadExport(text) {
  if (!text.includes('CREATE TABLE IF NOT EXISTS "d1_migrations"')) {
    throw new Error('Not a full `wrangler d1 export`: export without --no-schema and --table.');
  }
  const lines = text.split('\n');
  const schema = lines.filter((line) => !line.startsWith('INSERT INTO ')).join('\n');
  const rows = lines.filter((line) => line.startsWith('INSERT INTO ')).join('\n');
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  db.exec(schema);
  db.exec(`PRAGMA defer_foreign_keys=ON; BEGIN; ${rows}\nCOMMIT;`);
  assertNoForeignKeyViolations(db, 'the export as loaded');
  return { db, schema };
}

export function dataTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !isSystemTable(name));
}

/**
 * Every data table, parents before children. Throws on a self-reference or a
 * cycle: neither exists today, and either would need rows ordered within a
 * table, which this does not attempt.
 */
export function parentFirstOrder(db) {
  const tables = dataTables(db);
  const parents = new Map(
    tables.map((table) => {
      const refs = db
        .prepare('SELECT "table" FROM pragma_foreign_key_list(?)')
        .all(table)
        .map((fk) => String(fk.table));
      if (refs.includes(table)) throw new Error(`${table} references itself.`);
      return [table, new Set(refs.filter((ref) => tables.includes(ref)))];
    }),
  );
  const order = [];
  const placed = new Set();
  while (order.length < tables.length) {
    const ready = tables.filter(
      (table) => !placed.has(table) && [...(parents.get(table) ?? [])].every((p) => placed.has(p)),
    );
    if (ready.length === 0) {
      const stuck = tables.filter((table) => !placed.has(table));
      throw new Error(`Foreign-key cycle among: ${stuck.join(', ')}`);
    }
    for (const table of ready) {
      order.push(table);
      placed.add(table);
    }
  }
  return order;
}

export function assertNoForeignKeyViolations(db, what) {
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    const tables = [...new Set(violations.map((v) => String(v.table)))].join(', ');
    throw new Error(`${what}: ${violations.length} foreign-key violation(s) in ${tables}.`);
  }
}

const placeholderFor = (text) => {
  for (let i = 0; ; i += 1) {
    const candidate = i === 0 ? '\\n' : i === 1 ? '\\012' : `\\nl${String(i)}\\`;
    if (!text.includes(candidate)) return candidate;
  }
};

/**
 * A SQL literal, on one line. A line break in a value is written the way the
 * export writes it — `replace('a\nb','\n',char(10))`, with a placeholder the
 * value does not already contain — rather than as `'a'||char(10)||'b'`, which
 * nests one level per break and exceeds SQLite's expression depth on a JSON
 * document.
 */
export function sqlLiteral(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  let text = String(value);
  const replacements = [];
  for (const [char, code] of [
    ['\r', 13],
    ['\n', 10],
  ]) {
    if (!text.includes(char)) continue;
    const placeholder = placeholderFor(text);
    text = text.replaceAll(char, placeholder);
    replacements.push([placeholder, code]);
  }
  // Innermost replace is the last placeholder chosen, so no placeholder's
  // expansion can be mistaken for another's.
  return replacements.reduceRight(
    (inner, [placeholder, code]) => `replace(${inner},'${placeholder}',char(${String(code)}))`,
    `'${text.replaceAll("'", "''")}'`,
  );
}

// A table name cannot be a bound parameter. Every name reaching the two
// statements below comes from `sqlite_master`, never from input, and is
// quoted by `quoteIdent`.
export function insertsFor(db, table) {
  // eslint-disable-next-line no-restricted-syntax -- an identifier; see above
  const statement = db.prepare(`SELECT * FROM ${quoteIdent(table)} ORDER BY rowid`);
  statement.setReadBigInts(true);
  return statement.all().map((row) => {
    const columns = Object.keys(row).map(quoteIdent).join(',');
    const values = Object.values(row).map(sqlLiteral).join(',');
    return `INSERT INTO ${quoteIdent(table)} (${columns}) VALUES(${values});`;
  });
}

function countRows(db, tables) {
  return Object.fromEntries(
    tables.map((table) => [
      table,
      // eslint-disable-next-line no-restricted-syntax -- an identifier; see insertsFor
      Number(db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get()?.n),
    ]),
  );
}

/** The whole transformation, file text in and file texts out. */
export function buildSeed(exportText, pruneSql) {
  const { db, schema } = loadExport(exportText);
  // Not deferred: a delete in the wrong order fails at that statement.
  db.exec(`BEGIN; ${pruneSql}\nCOMMIT;`);
  assertNoForeignKeyViolations(db, 'the pruned copy');

  const order = parentFirstOrder(db);
  const lines = order.flatMap((table) => insertsFor(db, table));
  const counts = countRows(db, order);
  const seed = lines.join('\n') + '\n';

  // Prove it the way remote D1 will load it: empty tables, foreign keys
  // enforced, nothing deferred, statements in file order.
  const proof = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  proof.exec(schema);
  for (const table of dataTables(proof)) proof.exec(`DELETE FROM ${quoteIdent(table)}`);
  proof.exec(seed);
  assertNoForeignKeyViolations(proof, 'the seed loaded into an empty schema');
  const reloaded = countRows(proof, order);
  for (const table of order) {
    if (reloaded[table] !== counts[table]) {
      throw new Error(`${table}: ${counts[table]} rows written but ${reloaded[table]} loaded.`);
    }
  }

  const wipe =
    SEEDED_ROWS.map(
      ({ table, id }) => `DELETE FROM ${quoteIdent(table)} WHERE id = ${sqlLiteral(id)};`,
    ).join('\n') + '\n';

  return { seed, wipe, counts, order };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    console.error('Usage: node scripts/ops/build-seed.mjs <export.sql> <out-dir>');
    process.exit(1);
  }
  const [exportFile, outDir] = argv.map((arg) => resolve(arg));
  const { seed, wipe, counts } = buildSeed(
    readFileSync(exportFile, 'utf8'),
    readFileSync(PRUNE_SQL, 'utf8'),
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'seed.sql'), seed);
  writeFileSync(join(outDir, 'wipe-seeded-rows.sql'), wipe);
  writeFileSync(join(outDir, 'counts.json'), JSON.stringify(counts, null, 2) + '\n');
  console.table(counts);
  console.log(`\nWritten to ${outDir}. Load wipe-seeded-rows.sql first, then seed.sql.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
