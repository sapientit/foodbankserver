// Loads the charity's stock item list and model parcels from a CSV into a
// running system, through the ordinary API.
//
// This is a loader, not a migration and not part of the Worker. It is expected
// to be run again and again as the spreadsheet is corrected, so the only
// property that really matters is that running it twice is the same as running
// it once.
//
// ## What it will and will not do
//
// **It never deletes anything.** Stock items and model parcels present in the
// system but absent from the CSV are left exactly alone, because the CSV is one
// person's working spreadsheet and the system may hold things it does not know
// about. What it does replace, on a row it recognises, is the shelf, the
// category, the description and the parcel quantities — those are the columns
// the spreadsheet is authoritative for.
//
// **A name is an identity, not a label.** Items and parcels are matched by
// name, the same way the API's own uniqueness works. So correcting a spelling
// in the CSV does not rename anything: it adds a second item under the new
// name and leaves the old one behind, to be retired by hand. Get the names
// right before the first load; everything else is safe to iterate on.
//
// **A model parcel's contents are replaced whole.** Clearing a cell in the
// spreadsheet takes that item out of that parcel on the next run. Only the
// parcels named in the CSV header are touched.
//
// Deliberately plain Node with no dependencies, like `check-openapi.mjs`. It
// talks HTTP to a running server rather than to D1, so every rule the API
// enforces — the category's capitalisation, the name uniqueness, the contents
// validation — applies to loaded data exactly as it does to typed data. A
// loader writing straight to the database would be the one path that skips
// them.
import { readFileSync } from 'node:fs';

const HELP = `
Load stock items and model parcels from a CSV.

  node scripts/load-stock-data.mjs --email <admin@example.org> [options]

  --email <address>   Admin to sign in as. Required. Must already exist as a
                      user; dev login never creates one.
  --file <path>       CSV to read. Default: stockitems.csv
  --base-url <url>    Server to load into. Default: http://127.0.0.1:8787
  --dry-run           Report what would change and write nothing.
  --help

The CSV's first four columns are the stock item: name, shelf, category,
description. Every column after the blank spacer is a model parcel, named by
its header, holding a quantity per stock item row.
`;

const COLUMN = { name: 0, shelf: 1, category: 2, description: 3 };
/** Columns 0-3 are the item and column 4 is the spacer the spreadsheet uses. */
const FIRST_PARCEL_COLUMN = 5;

function parseArgs(argv) {
  const args = { file: 'stockitems.csv', baseUrl: 'http://127.0.0.1:8787', dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--email') args.email = argv[(i += 1)];
    else if (arg === '--file') args.file = argv[(i += 1)];
    else if (arg === '--base-url') args.baseUrl = argv[(i += 1)].replace(/\/$/, '');
    else fail(`Unrecognised argument: ${arg}`);
  }

  if (args.email === undefined) fail('--email is required. See --help.');
  return args;
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- the CSV --

/**
 * A CSV parser small enough to read, because the file has quoted fields with
 * commas in them ("kidney, butter, cannellini") and splitting on commas would
 * silently mangle those into extra columns.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  // Strip a byte-order mark and normalise line endings: the file comes out of a
  // spreadsheet, so it has both.
  const input = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quoted) {
      if (char !== '"') field += char;
      else if (input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // A spreadsheet export ends with a blank line, and a row of empty strings is
  // not a stock item.
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** Two names are the same name if they differ only by case or spacing. */
const key = (value) => value.trim().toLowerCase().replace(/\s+/g, ' ');

const blankToNull = (value) => {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

function readCsv(path) {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const header = rows[0];
  if (header === undefined) fail(`${path} is empty.`);

  const parcelColumns = [];
  for (let column = FIRST_PARCEL_COLUMN; column < header.length; column += 1) {
    const name = (header[column] ?? '').trim();
    if (name !== '') parcelColumns.push({ column, name });
  }

  const items = [];
  const warnings = [];
  const seen = new Map();

  for (const [index, cells] of rows.slice(1).entries()) {
    const line = index + 2;
    const name = (cells[COLUMN.name] ?? '').trim();
    if (name === '') {
      warnings.push(`line ${line}: no stock item name — row skipped`);
      continue;
    }

    const previous = seen.get(key(name));
    if (previous !== undefined) {
      // Two rows for one name would fight each other, and the second would win
      // by accident rather than by intent.
      warnings.push(`line ${line}: "${name}" repeats line ${previous} — row skipped`);
      continue;
    }
    seen.set(key(name), line);

    const shelf = (cells[COLUMN.shelf] ?? '').trim();
    if (shelf === '') {
      warnings.push(`line ${line}: "${name}" has no shelf — row skipped`);
      continue;
    }

    const category = (cells[COLUMN.category] ?? '').trim();
    if (category === '') {
      warnings.push(`line ${line}: "${name}" has no category — row skipped`);
      continue;
    }

    const quantities = new Map();
    for (const { column, name: parcelName } of parcelColumns) {
      const raw = (cells[column] ?? '').trim();
      if (raw === '') continue;

      const quantity = Number(raw);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
        warnings.push(`line ${line}: "${name}" in ${parcelName} is "${raw}", not a quantity`);
        continue;
      }
      quantities.set(parcelName, quantity);
    }

    items.push({
      line,
      name,
      shelfNumber: shelf,
      category,
      description: blankToNull(cells[COLUMN.description]),
      quantities,
    });
  }

  return { items, parcelColumns, warnings };
}

// ---------------------------------------------------------------- the API --

/**
 * A fetch whose failure is a sentence rather than a stack trace. The commonest
 * way to run this is against a server that is not running, and the raw
 * `TypeError: fetch failed` says nothing about which URL was tried.
 */
async function request(url, init) {
  try {
    return await fetch(url, init);
  } catch (error) {
    fail(`Could not reach ${url}\n  ${error.cause?.message ?? error.message}`);
  }
}

function createClient(baseUrl, token) {
  return async function call(method, path, body) {
    const response = await request(`${baseUrl}/api/v1${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      const detail = await response.text();
      fail(`${method} ${path} failed with ${response.status}\n  ${detail.slice(0, 600)}`);
    }

    return response.status === 204 ? undefined : await response.json();
  };
}

async function signIn(baseUrl, email) {
  const response = await request(`${baseUrl}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });

  if (!response.ok) {
    fail(
      `Could not sign in as ${email} (${response.status}).\n` +
        `  The address must already have a user record, and the server must be running\n` +
        `  with dev login enabled. Is ${baseUrl} the right system?`,
    );
  }

  const { accessToken, user } = await response.json();
  if (user.role !== 'admin') {
    fail(`${email} is ${user.role}. Loading stock and model parcels is admin-only.`);
  }
  return accessToken;
}

// ------------------------------------------------------------- the loading --

async function loadStockItems(call, items, dryRun) {
  const { items: existing } = await call('GET', '/stock/items?includeInactive=true&order=shelf');
  const byName = new Map(existing.map((item) => [key(item.name), item]));
  const tally = { created: 0, updated: 0, unchanged: 0 };
  const idsByName = new Map();

  for (const item of items) {
    const found = byName.get(key(item.name));

    if (found === undefined) {
      if (dryRun) {
        // A stand-in id, so the model parcels below can still be counted and
        // reported. Without it a dry run against an empty system reports every
        // parcel as empty, which reads as a fault in the CSV rather than as the
        // items simply not existing yet.
        idsByName.set(key(item.name), `would-create:${key(item.name)}`);
      } else {
        const created = await call('POST', '/stock/items', {
          name: item.name,
          category: item.category,
          shelfNumber: item.shelfNumber,
          ...(item.description === null ? {} : { description: item.description }),
        });
        idsByName.set(key(item.name), created.id);
      }
      tally.created += 1;
      console.log(`  + ${item.name}  [${item.category}, ${item.shelfNumber}]`);
      continue;
    }

    idsByName.set(key(item.name), found.id);

    // Only the columns the spreadsheet owns are compared, and the category is
    // compared loosely because the server settles its capitalisation — a
    // `Cupboard` here and a `cupboard` there is not a change to write.
    const changes = {};
    if (found.shelfNumber !== item.shelfNumber) changes.shelfNumber = item.shelfNumber;
    if (key(found.category) !== key(item.category)) changes.category = item.category;
    if ((found.description ?? null) !== item.description) changes.description = item.description;

    if (Object.keys(changes).length === 0) {
      tally.unchanged += 1;
      continue;
    }

    if (!dryRun) await call('PATCH', `/stock/items/${found.id}`, changes);
    tally.updated += 1;
    console.log(`  ~ ${item.name}  ${Object.keys(changes).join(', ')}`);
  }

  return { tally, idsByName };
}

async function loadModelParcels(call, items, parcelColumns, idsByName, dryRun) {
  const { modelParcels: existing } = await call('GET', '/model-parcels');
  const byName = new Map(existing.map((parcel) => [key(parcel.name), parcel]));
  const tally = { created: 0, updated: 0, unchanged: 0, skipped: 0 };

  for (const [order, { name }] of parcelColumns.entries()) {
    const contents = [];
    for (const item of items) {
      const quantity = item.quantities.get(name);
      if (quantity === undefined) continue;

      const stockItemId = idsByName.get(key(item.name));
      if (stockItemId === undefined) continue;
      contents.push({ stockItemId, quantity });
    }

    if (contents.length === 0) {
      // The API refuses an empty model parcel, and rightly: a parcel with
      // nothing in it feeds nobody.
      console.log(`  ! ${name}: no quantities in the CSV — skipped`);
      tally.skipped += 1;
      continue;
    }

    const found = byName.get(key(name));

    if (found === undefined) {
      if (!dryRun) {
        await call('POST', '/model-parcels', { name, contents, displayOrder: order });
      }
      tally.created += 1;
      console.log(`  + ${name}  (${contents.length} items)`);
      continue;
    }

    if (sameContents(found.contents, contents) && found.displayOrder === order) {
      tally.unchanged += 1;
      continue;
    }

    if (!dryRun) {
      await call('PATCH', `/model-parcels/${found.id}`, { contents, displayOrder: order });
    }
    tally.updated += 1;
    console.log(`  ~ ${name}  (${contents.length} items, was ${found.contents.length})`);
  }

  return tally;
}

function sameContents(before, after) {
  if (before.length !== after.length) return false;
  const held = new Map(before.map((line) => [line.stockItemId, line.quantity]));
  return after.every((line) => held.get(line.stockItemId) === line.quantity);
}

// --------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const { items, parcelColumns, warnings } = readCsv(args.file);

console.log(`\n${args.file}: ${items.length} stock items, ${parcelColumns.length} model parcels`);
console.log(`into ${args.baseUrl}${args.dryRun ? '  (dry run — nothing will be written)' : ''}\n`);

if (warnings.length > 0) {
  console.log('Warnings:');
  for (const warning of warnings) console.log(`  ! ${warning}`);
  console.log('');
}

const token = await signIn(args.baseUrl, args.email);
const call = createClient(args.baseUrl, token);

console.log('Stock items');
const { tally: itemTally, idsByName } = await loadStockItems(call, items, args.dryRun);
console.log(
  `  ${itemTally.created} created, ${itemTally.updated} updated, ${itemTally.unchanged} unchanged\n`,
);

console.log('Model parcels');
const parcelTally = await loadModelParcels(call, items, parcelColumns, idsByName, args.dryRun);
console.log(
  `  ${parcelTally.created} created, ${parcelTally.updated} updated, ` +
    `${parcelTally.unchanged} unchanged, ${parcelTally.skipped} skipped\n`,
);

if (args.dryRun) console.log('Nothing was written. Run again without --dry-run to load.\n');
