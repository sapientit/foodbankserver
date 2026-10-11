import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { SEEDED_ROWS, buildSeed, parentFirstOrder, sqlLiteral } from './build-seed.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const PRUNE_SQL = readFileSync(join(root, 'scripts', 'ops', 'prune-to-config.sql'), 'utf8');

// The shape `wrangler d1 export` writes: a child table and its rows before the
// parent it references — the order that failed the 2026-09-29 rehearsal.
const MINI_EXPORT = [
  'PRAGMA defer_foreign_keys=TRUE;',
  'CREATE TABLE IF NOT EXISTS "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);',
  `INSERT INTO "d1_migrations" ("id","name") VALUES(1,'0000_init.sql');`,
  'CREATE TABLE `notes` (`id` text PRIMARY KEY, `user_id` text NOT NULL REFERENCES users(id), `body` text);',
  `INSERT INTO "notes" ("id","user_id","body") VALUES('n1','u1',replace('a\\nb','\\n',char(10)));`,
  'CREATE TABLE IF NOT EXISTS "users" (`id` text PRIMARY KEY, `is_active` integer NOT NULL);',
  `INSERT INTO "users" ("id","is_active") VALUES('u1',1);`,
  `INSERT INTO "users" ("id","is_active") VALUES('u2',0);`,
].join('\n');

test('the seed puts parents first and loads with foreign keys enforced and nothing deferred', () => {
  const { seed, order, counts } = buildSeed(MINI_EXPORT, 'DELETE FROM users WHERE is_active = 0;');

  assert.deepEqual(order, ['users', 'notes']);
  assert.deepEqual(counts, { users: 1, notes: 1 });
  assert.doesNotMatch(seed, /PRAGMA|d1_migrations|CREATE/);
  assert.ok(seed.indexOf('INSERT INTO "users"') < seed.indexOf('INSERT INTO "notes"'));

  const target = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  target.exec('CREATE TABLE users (id text PRIMARY KEY, is_active integer NOT NULL);');
  target.exec(
    'CREATE TABLE notes (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), body text);',
  );
  target.exec(seed);
  assert.equal(target.prepare('SELECT body FROM notes').get()?.body, 'a\nb');
});

test('a prune that deletes a parent before its child fails rather than writing a seed', () => {
  assert.throws(
    () => buildSeed(MINI_EXPORT, 'DELETE FROM users;'),
    /FOREIGN KEY constraint failed/,
  );
});

test('a foreign-key cycle is refused rather than guessed at', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE a (id text PRIMARY KEY, b_id text REFERENCES b(id));');
  db.exec('CREATE TABLE b (id text PRIMARY KEY, a_id text REFERENCES a(id));');
  assert.throws(() => parentFirstOrder(db), /cycle among: a, b/);
});

test('sqlLiteral round-trips every value exactly, line breaks included', () => {
  const db = new DatabaseSync(':memory:');
  const values = [
    null,
    0,
    -3,
    9007199254740993n,
    '',
    "it's",
    'a\nb',
    'a\r\nb\n',
    'already has \\n in it\nand a break',
    'has \\n and \\012\nboth',
    '{\n  "deep": [\n' + '    1,\n'.repeat(2000) + '  ]\n}',
  ];
  for (const value of values) {
    // eslint-disable-next-line no-restricted-syntax -- the literal's SQL text is what is under test
    const statement = db.prepare(`SELECT ${sqlLiteral(value)} AS v`);
    statement.setReadBigInts(true);
    const back = statement.get()?.v;
    assert.deepEqual(back, typeof value === 'number' ? BigInt(value) : value, String(value));
  }
});

// --- prune-to-config.sql against the real schema --------------------------

function migratedDatabase() {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  const dir = join(root, 'migrations');
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  return db;
}

let placeholders = 0;

/** Inserts a row, filling any other required column with a distinct placeholder of its type. */
function insert(db, table, values) {
  const row = { ...values };
  for (const column of db.prepare('SELECT * FROM pragma_table_info(?)').all(table)) {
    const name = String(column.name);
    if (name in row || column.notnull === 0 || column.dflt_value !== null) continue;
    placeholders += 1;
    row[name] = /INT/i.test(String(column.type)) ? 1 : `${name}-${String(placeholders)}`;
  }
  const columns = Object.keys(row);
  // Table and column names cannot be bound; they are this file's own fixture
  // names and the schema's. Every value is bound.
  db.prepare(
    // eslint-disable-next-line no-restricted-syntax -- identifiers only; see above
    `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
  ).run(...Object.values(row));
}

/** Rows in `table`, or only those whose id is in `ids`. */
function count(db, table, ids) {
  // A table name cannot be bound; these are the fixture's own. The ids are bound.
  const all = `SELECT count(*) AS n FROM "${table}"`;
  if (ids === undefined) return Number(db.prepare(all).get()?.n);
  const some = `${all} WHERE id IN (SELECT value FROM json_each(?))`;
  return Number(db.prepare(some).get(JSON.stringify(ids))?.n);
}

test('prune-to-config.sql keeps configuration, retired stock and every release, and nothing else', () => {
  const db = migratedDatabase();
  const baseline = SEEDED_ROWS.find((row) => row.table === 'configuration_releases')?.id;

  insert(db, 'users', { id: 'publisher', email: 'p@x', role: 'admin', is_active: 0 });
  insert(db, 'users', { id: 'leaver', email: 'l@x', role: 'admin', is_active: 0 });
  insert(db, 'users', { id: 'staff', email: 's@x', role: 'admin', is_active: 1 });
  insert(db, 'refresh_tokens', { id: 't1', user_id: 'staff', revoked_reason: null });

  db.exec(`UPDATE configuration_releases SET status = 'superseded' WHERE id = '${baseline}'`);
  insert(db, 'configuration_releases', {
    id: 'r2',
    status: 'published',
    created_by_user_id: 'publisher',
    published_by_user_id: 'publisher',
  });
  insert(db, 'configuration_releases', {
    id: 'r3',
    status: 'draft',
    created_by_user_id: 'staff',
    published_by_user_id: null,
  });
  insert(db, 'configuration_release_publications', {
    id: 'p1',
    release_id: 'r2',
    action: 'publish',
    actor_user_id: 'publisher',
  });

  insert(db, 'stock_items', { id: 'retired', name: 'Old beans', is_active: 0, grouping_id: null });
  insert(db, 'stock_items', { id: 'current', name: 'Beans', is_active: 1, grouping_id: null });
  insert(db, 'stock_take_groupings', { id: 'g1', name: 'Tins' });
  insert(db, 'crates', { id: 'c1', grouping_id: 'g1' });
  insert(db, 'crate_members', { crate_id: 'c1', stock_item_id: 'retired' });
  insert(db, 'crate_members', { crate_id: 'c1', stock_item_id: 'current' });

  insert(db, 'referral_reasons', { id: 'rr-old', code: 'old', is_active: 0 });
  insert(db, 'referral_reasons', { id: 'rr-new', code: 'new', is_active: 1 });
  insert(db, 'authorised_referrers', {
    id: 'ar-old',
    match_type: 'email',
    match_value: 'o@x',
    is_active: 0,
  });
  insert(db, 'authorised_referrers', {
    id: 'ar-new',
    match_type: 'email',
    match_value: 'n@x',
    is_active: 1,
  });

  insert(db, 'recurring_sessions', {
    id: 'rs-ended',
    weekday: 2,
    duration_minutes: 60,
    active_until: '2000-01-01',
  });
  insert(db, 'recurring_sessions', {
    id: 'rs-open',
    weekday: 3,
    duration_minutes: 60,
    active_until: null,
  });
  insert(db, 'sessions', {
    id: 's1',
    recurring_session_id: 'rs-open',
    status: 'planned',
    capacity: 25,
    duration_minutes: 60,
    confirmed_by_user_id: null,
    extract_claimed_by_user_id: null,
  });
  insert(db, 'referrals', { id: 'ref1', session_id: 's1', reason_id: 'rr-old', form_id: 'r2' });

  insert(db, 'pick_lists', { id: 'pl1', session_id: 's1', generated_by_user_id: 'staff' });
  insert(db, 'parcels', {
    id: 'pa1',
    pick_list_id: 'pl1',
    referral_id: 'ref1',
    attendance_recorded_by_user_id: 'leaver',
  });
  insert(db, 'parcel_lines', { id: 'line1', parcel_id: 'pa1', stock_item_id: 'retired' });
  insert(db, 'stock_ledger', {
    id: 'led1',
    stock_item_id: 'retired',
    session_id: 's1',
    actor_user_id: 'leaver',
    movement_type: 'parcel_issued',
    quantity_delta: -1,
  });
  insert(db, 'sms_messages', {
    id: 'sms1',
    referral_id: 'ref1',
    session_id: 's1',
    sent_by_user_id: 'leaver',
    kind: 'staff_reply',
    recipient_role: null,
  });
  insert(db, 'audit_events', { id: 'au1', actor_user_id: 'leaver', actor_kind: 'user' });

  for (const table of [
    'referrals',
    'pick_lists',
    'parcels',
    'parcel_lines',
    'stock_ledger',
    'sms_messages',
    'audit_events',
  ]) {
    assert.equal(
      count(db, table),
      1,
      `the fixture's ${table} row must exist for the test to mean anything`,
    );
  }

  db.exec(`BEGIN; ${PRUNE_SQL}\nCOMMIT;`);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  // Gone.
  for (const table of [
    'referrals',
    'sessions',
    'refresh_tokens',
    'pick_lists',
    'parcels',
    'parcel_lines',
    'stock_ledger',
    'sms_messages',
    'audit_events',
  ])
    assert.equal(count(db, table), 0, table);
  assert.equal(count(db, 'users', ['leaver']), 0);
  assert.equal(count(db, 'referral_reasons', ['rr-old']), 0);
  assert.equal(count(db, 'authorised_referrers', ['ar-old']), 0);
  assert.equal(count(db, 'recurring_sessions', ['rs-ended']), 0);

  // Kept.
  assert.equal(count(db, 'users', ['publisher', 'staff']), 2);
  assert.equal(count(db, 'configuration_releases'), 3);
  assert.equal(count(db, 'configuration_release_publications'), 1);
  assert.equal(count(db, 'stock_items', ['retired']), 1);
  assert.equal(count(db, 'crate_members'), 2);
  assert.equal(count(db, 'referral_reasons', ['rr-new']), 1);
  assert.equal(count(db, 'authorised_referrers', ['ar-new']), 1);
  assert.equal(count(db, 'recurring_sessions', ['rs-open']), 1);
});
