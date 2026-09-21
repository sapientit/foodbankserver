import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadGroupings, loadStockItems, readCsvText, resolveDownload } from './load-stock-data.mjs';

const HEADER = [
  'Stock Item',
  'Shelf',
  'Low Stock',
  'Category',
  'Description',
  'Pack description',
  'Pack count',
  'Stock Take',
  '',
  'Single person',
];
const BEANS_ROW = [
  'Beans',
  'A1',
  '5',
  'Cupboard',
  'Tinned beans',
  'box of',
  '24',
  'Non-perishable',
  '',
  '2',
];
const PASTA_ROW = ['Pasta', 'A2', '', 'Cupboard', '', '', '', '', '', '1'];

const csv = (...rows) => [HEADER, ...rows].map((row) => row.join(',')).join('\n') + '\n';

const CSV = csv(BEANS_ROW, PASTA_ROW);

test('reads the stock-item columns by header text, not position', () => {
  const { items, parcelColumns, warnings } = readCsvText(CSV);

  assert.deepEqual(warnings, []);
  assert.deepEqual(
    items.map(
      ({
        name,
        shelfNumber,
        category,
        description,
        lowStockThreshold,
        unitsPerPack,
        packUnitLabel,
        groupingName,
      }) => ({
        name,
        shelfNumber,
        category,
        description,
        lowStockThreshold,
        unitsPerPack,
        packUnitLabel,
        groupingName,
      }),
    ),
    [
      {
        name: 'Beans',
        shelfNumber: 'A1',
        category: 'Cupboard',
        description: 'Tinned beans',
        lowStockThreshold: 5,
        unitsPerPack: 24,
        packUnitLabel: 'box of',
        groupingName: 'Non-perishable',
      },
      {
        name: 'Pasta',
        shelfNumber: 'A2',
        category: 'Cupboard',
        description: null,
        lowStockThreshold: null,
        unitsPerPack: null,
        packUnitLabel: null,
        groupingName: null,
      },
    ],
  );
  assert.deepEqual(parcelColumns, [{ column: 9, name: 'Single person' }]);
  assert.equal(items[0].quantities.get('Single person'), 2);
  assert.equal(items[1].quantities.get('Single person'), 1);
});

test('reads the same result when category and low-stock swap places in the header', () => {
  const swappedHeader = [
    'Stock Item',
    'Shelf',
    'Category',
    'Low Stock',
    'Description',
    'Pack description',
    'Pack count',
    'Stock Take',
    '',
    'Single person',
  ];
  const row = [
    'Beans',
    'A1',
    'Cupboard',
    '5',
    'Tinned beans',
    'box of',
    '24',
    'Non-perishable',
    '',
    '2',
  ];
  const swapped = [swappedHeader, row].map((r) => r.join(',')).join('\n') + '\n';

  const { items, parcelColumns } = readCsvText(swapped);

  assert.equal(items[0].category, 'Cupboard');
  assert.equal(items[0].lowStockThreshold, 5);
  assert.deepEqual(parcelColumns, [{ column: 9, name: 'Single person' }]);
});

test('creates a stock-take grouping the system does not have yet, and reuses one it does', async () => {
  const { items } = readCsvText(CSV);
  const calls = [];
  const call = async (method, path, body) => {
    calls.push({ method, path, body });
    return { id: 'created-grouping' };
  };

  const created = await loadGroupings(call, items, [], false);
  assert.deepEqual(calls, [
    { method: 'POST', path: '/stock/groupings', body: { name: 'Non-perishable' } },
  ]);
  assert.equal(created.tally.created, 1);
  assert.equal(created.idsByName.get('non-perishable'), 'created-grouping');

  const reused = await loadGroupings(
    call,
    items,
    [{ id: 'existing-grouping', name: 'Non-perishable' }],
    false,
  );
  assert.deepEqual(calls, [
    { method: 'POST', path: '/stock/groupings', body: { name: 'Non-perishable' } },
  ]); // no second call
  assert.equal(reused.tally.created, 0);
  assert.equal(reused.idsByName.get('non-perishable'), 'existing-grouping');
});

test('creates and updates stock items with the CSV low-stock threshold, pack size and grouping', async () => {
  const { items } = readCsvText(CSV);
  const calls = [];
  const call = async (method, path, body) => {
    calls.push({ method, path, body });
    return method === 'POST' ? { id: 'created-beans' } : undefined;
  };
  const groupingIdsByName = new Map([['non-perishable', 'grouping-id']]);

  await loadStockItems(
    call,
    items,
    [
      {
        id: 'pasta-id',
        name: 'Pasta',
        shelfNumber: 'A2',
        category: 'Cupboard',
        description: null,
        lowStockThreshold: 3,
        unitsPerPack: 6,
        packUnitLabel: 'pack of',
        groupingId: 'old-grouping-id',
      },
    ],
    groupingIdsByName,
    false,
  );

  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/stock/items',
      body: {
        name: 'Beans',
        category: 'Cupboard',
        shelfNumber: 'A1',
        description: 'Tinned beans',
        lowStockThreshold: 5,
        unitsPerPack: 24,
        packUnitLabel: 'box of',
        groupingId: 'grouping-id',
      },
    },
    {
      method: 'PATCH',
      path: '/stock/items/pasta-id',
      body: {
        lowStockThreshold: null,
        unitsPerPack: null,
        packUnitLabel: null,
        groupingId: null,
      },
    },
  ]);
});

test('skips a row with an invalid low-stock threshold', () => {
  const { items, warnings } = readCsvText(
    csv(['Beans', 'A1', '2.5', 'Cupboard', '', '', '', '', '', '1']),
  );

  assert.deepEqual(items, []);
  assert.deepEqual(warnings, [
    'line 2: "Beans" has low-stock threshold "2.5", not a whole number from 0 to 100000 — row skipped',
  ]);
});

test('accepts zero as a low-stock threshold', () => {
  const { items, warnings } = readCsvText(
    csv(['Beans', 'A1', '0', 'Cupboard', '', '', '', '', '', '1']),
  );

  assert.deepEqual(warnings, []);
  assert.equal(items[0].lowStockThreshold, 0);
});

test('skips a row with a pack count that is not a whole number from 1 to 100000', () => {
  const { items, warnings } = readCsvText(
    csv(['Beans', 'A1', '', 'Cupboard', '', 'box of', '0', '', '', '1']),
  );

  assert.deepEqual(items, []);
  assert.deepEqual(warnings, [
    'line 2: "Beans" has pack count "0", not a whole number from 1 to 100000 — row skipped',
  ]);
});

test('drops a pack description left in the CSV with no pack count', () => {
  const { items, warnings } = readCsvText(
    csv(['Beans', 'A1', '', 'Cupboard', '', 'box of', '', '', '', '1']),
  );

  assert.deepEqual(warnings, []);
  assert.equal(items[0].unitsPerPack, null);
  assert.equal(items[0].packUnitLabel, null);
});

test('leaves a stock item ungrouped (a crate member) when the column is blank', () => {
  const { items, warnings } = readCsvText(
    csv(['Beans', 'A1', '', 'Cupboard', '', '', '', '', '', '1']),
  );

  assert.deepEqual(warnings, []);
  assert.equal(items[0].groupingName, null);
});

test('resolves a bare filename against the Downloads folder', () => {
  assert.equal(
    resolveDownload('stockitems_2026-09-17_10-22-11.csv'),
    join(homedir(), 'Downloads', 'stockitems_2026-09-17_10-22-11.csv'),
  );
});

test('leaves an absolute path, or one that already names a directory, alone', () => {
  assert.equal(resolveDownload('/tmp/stockitems.csv'), '/tmp/stockitems.csv');
  assert.equal(resolveDownload('exports/stockitems.csv'), 'exports/stockitems.csv');
  assert.equal(resolveDownload('./stockitems.csv'), './stockitems.csv');
});
