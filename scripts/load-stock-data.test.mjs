import assert from 'node:assert/strict';
import test from 'node:test';

import { loadStockItems, readCsvText } from './load-stock-data.mjs';

const CSV = `Stock Item,Shelf,Low Stock,Category,Description,,Single person
Beans,A1,5,Cupboard,Tinned beans,,2
Pasta,A2,,Cupboard,,,1
`;

test('reads a low-stock threshold before the shifted category and parcel columns', () => {
  const { items, parcelColumns, warnings } = readCsvText(CSV);

  assert.deepEqual(warnings, []);
  assert.deepEqual(
    items.map(({ name, shelfNumber, category, description, lowStockThreshold }) => ({
      name,
      shelfNumber,
      category,
      description,
      lowStockThreshold,
    })),
    [
      {
        name: 'Beans',
        shelfNumber: 'A1',
        category: 'Cupboard',
        description: 'Tinned beans',
        lowStockThreshold: 5,
      },
      {
        name: 'Pasta',
        shelfNumber: 'A2',
        category: 'Cupboard',
        description: null,
        lowStockThreshold: null,
      },
    ],
  );
  assert.deepEqual(parcelColumns, [{ column: 6, name: 'Single person' }]);
  assert.equal(items[0].quantities.get('Single person'), 2);
  assert.equal(items[1].quantities.get('Single person'), 1);
});

test('creates and updates stock items with the CSV low-stock threshold', async () => {
  const { items } = readCsvText(CSV);
  const calls = [];
  const call = async (method, path, body) => {
    calls.push({ method, path, body });
    return method === 'POST' ? { id: 'created-beans' } : undefined;
  };

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
      },
    ],
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
      },
    },
    { method: 'PATCH', path: '/stock/items/pasta-id', body: { lowStockThreshold: null } },
  ]);
});

test('skips a row with an invalid low-stock threshold', () => {
  const { items, warnings } = readCsvText(
    `Stock Item,Shelf,Low Stock,Category,Description,,Single person\nBeans,A1,2.5,Cupboard,,,1\n`,
  );

  assert.deepEqual(items, []);
  assert.deepEqual(warnings, [
    'line 2: "Beans" has low-stock threshold "2.5", not a whole number from 0 to 100000 — row skipped',
  ]);
});

test('accepts zero as a low-stock threshold', () => {
  const { items, warnings } = readCsvText(
    `Stock Item,Shelf,Low Stock,Category,Description,,Single person\nBeans,A1,0,Cupboard,,,1\n`,
  );

  assert.deepEqual(warnings, []);
  assert.equal(items[0].lowStockThreshold, 0);
});
