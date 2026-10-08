import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { LOCAL_ADMIN_SQL, splitExport } from './restore-local-db.mjs';

// The shape `wrangler d1 export` writes: a child table and its rows before
// the parent it references, one INSERT per line, a newline inside a value
// written as char(10).
const EXPORT = [
  'PRAGMA defer_foreign_keys=TRUE;',
  'CREATE TABLE IF NOT EXISTS "d1_migrations"(',
  '\tid INTEGER PRIMARY KEY AUTOINCREMENT,',
  '\tname TEXT UNIQUE',
  ');',
  `INSERT INTO "d1_migrations" ("id","name") VALUES(1,'0000_init.sql');`,
  'CREATE TABLE `notes` (`id` text PRIMARY KEY, `user_id` text REFERENCES users(id), `body` text);',
  `INSERT INTO "notes" ("id","user_id","body") VALUES('n1','u1',replace('a\\nb','\\n',char(10)));`,
  'CREATE TABLE IF NOT EXISTS "users" (`id` text PRIMARY KEY);',
  `INSERT INTO "users" ("id") VALUES('u1');`,
  'CREATE INDEX `idx_notes_user` ON `notes` (`user_id`);',
].join('\n');

test('splitExport puts every row after every table', () => {
  const { schema, data, rowCount } = splitExport(EXPORT);

  assert.equal(rowCount, 3);
  assert.doesNotMatch(schema, /INSERT INTO/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS "users"/);
  assert.match(schema, /CREATE INDEX `idx_notes_user`/);
  assert.match(data, /^PRAGMA defer_foreign_keys=TRUE;\n/);
  assert.equal(data.split('\n').filter((line) => line.startsWith('INSERT INTO ')).length, 3);
});

test('splitExport output loads with foreign keys on, where the export as written does not', () => {
  const asWritten = new DatabaseSync(':memory:');
  asWritten.exec('PRAGMA foreign_keys=ON;');
  assert.throws(() => asWritten.exec(EXPORT), /no such table/);

  const split = new DatabaseSync(':memory:');
  split.exec('PRAGMA foreign_keys=ON;');
  const { schema, data } = splitExport(EXPORT);
  split.exec(schema);
  // D1 runs a --file as one unit, which is what lets the deferred foreign
  // keys wait for the parent rows; plain SQLite needs it spelled out.
  split.exec(`BEGIN;\n${data}\nCOMMIT;`);
  assert.equal(split.prepare('SELECT body FROM notes').get()?.body, 'a\nb');
});

test('splitExport refuses an export that cannot be restored on its own', () => {
  assert.throws(() => splitExport(`INSERT INTO "users" ("id") VALUES('u1');`), /Not a full/);
});

function usersTable() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (
    id text PRIMARY KEY, email text NOT NULL UNIQUE, display_name text NOT NULL, role text NOT NULL,
    google_subject text, is_active integer NOT NULL, last_login_at text,
    created_at text NOT NULL, updated_at text NOT NULL)`);
  return db;
}

const insertUser = (db, id, email, role, isActive) =>
  db
    .prepare(`INSERT INTO users VALUES (?, ?, 'Someone', ?, NULL, ?, NULL, 'x', 'x')`)
    .run(id, email, role, isActive);

const admins = (db) =>
  db
    .prepare(`SELECT id, role, is_active FROM users WHERE email = 'pete@x.com'`)
    .all()
    .map((row) => ({ ...row }));

test('the seeded admin gets pete@x.com back when a deployed system renamed it', () => {
  const db = usersTable();
  insertUser(db, '6814d1ea-eb23-4f09-919e-911c750e4a66', 'admin@charity.example', 'admin', 1);
  insertUser(db, 'other', 'lead@charity.example', 'team_lead', 1);

  db.exec(LOCAL_ADMIN_SQL);

  assert.deepEqual(admins(db), [
    { id: '6814d1ea-eb23-4f09-919e-911c750e4a66', role: 'admin', is_active: 1 },
  ]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users').get()?.n, 2);
});

test('the seeded admin is recreated when the snapshot never had it', () => {
  const db = usersTable();
  insertUser(db, 'other', 'lead@charity.example', 'team_lead', 1);

  db.exec(LOCAL_ADMIN_SQL);

  assert.deepEqual(admins(db), [
    { id: '6814d1ea-eb23-4f09-919e-911c750e4a66', role: 'admin', is_active: 1 },
  ]);
});

test('an existing pete@x.com is reactivated as admin rather than duplicated', () => {
  const db = usersTable();
  insertUser(db, 'someone-else', 'pete@x.com', 'team_lead', 0);
  insertUser(db, '6814d1ea-eb23-4f09-919e-911c750e4a66', 'admin@charity.example', 'admin', 1);

  db.exec(LOCAL_ADMIN_SQL);

  assert.deepEqual(admins(db), [{ id: 'someone-else', role: 'admin', is_active: 1 }]);
});
