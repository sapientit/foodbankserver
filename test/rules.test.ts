import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/client.ts';
import { modelParcels, parcelGrid } from '../src/db/schema/rules.ts';
import { stockItems, stockLedger } from '../src/db/schema/stock.ts';
import { refreshTokens, users } from '../src/db/schema/users.ts';
import { allGridKeys, type ParcelGrid } from '../src/modules/rules/engine.ts';
import { authHeaders, buildTestApp, devLogin, type TestApp } from './helpers/app.ts';

const db = createDatabase(env.DB);

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

async function adminApp(): Promise<{ testApp: TestApp; token: string }> {
  const testApp = buildTestApp();
  const { accessToken } = await devLogin(testApp, { email: 'admin@foodbank.org' });
  return { testApp, token: accessToken };
}

async function createStockItem(testApp: TestApp, token: string, name: string): Promise<string> {
  const response = await testApp.request('/api/v1/stock/items', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ name, shelfNumber: 'A1' }),
  });
  const { id }: { id: string } = await response.json();
  return id;
}

async function addParcel(
  testApp: TestApp,
  token: string,
  name: string,
  contents: { stockItemId: string; quantity: number }[],
): Promise<Response> {
  return testApp.request('/api/v1/model-parcels', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ name, contents }),
  });
}

async function saveGrid(testApp: TestApp, token: string, grid: ParcelGrid): Promise<Response> {
  return testApp.request('/api/v1/parcel-grid', {
    method: 'PUT',
    headers: json(token),
    body: JSON.stringify({ grid }),
  });
}

function gridOf(smallName: string, largeName: string): ParcelGrid {
  const grid: ParcelGrid = {};
  for (const key of allGridKeys()) {
    const [adults, children] = key.split('-').map(Number);
    grid[key] = (adults ?? 0) + (children ?? 0) <= 2 ? smallName : largeName;
  }
  return grid;
}

async function preview(testApp: TestApp, token: string, adults: number, children: number) {
  const response = await testApp.request('/api/v1/parcel-grid/preview', {
    method: 'POST',
    headers: json(token),
    body: JSON.stringify({ adults, children }),
  });
  const body: {
    modelParcelName?: string;
    lines?: { stockItemId: string; quantity: number }[];
  } = await response.json();
  return { status: response.status, ...body };
}

async function setUp(testApp: TestApp, token: string) {
  const beans = await createStockItem(testApp, token, 'Beans');
  const pasta = await createStockItem(testApp, token, 'Pasta');

  await addParcel(testApp, token, 'Single parcel', [{ stockItemId: beans, quantity: 2 }]);
  await addParcel(testApp, token, 'Family parcel', [
    { stockItemId: beans, quantity: 4 },
    { stockItemId: pasta, quantity: 2 },
  ]);
  await saveGrid(testApp, token, gridOf('Single parcel', 'Family parcel'));

  return { beans, pasta };
}

beforeEach(async () => {
  await db.delete(parcelGrid);
  await db.delete(modelParcels);
  await db.delete(stockLedger);
  await db.delete(stockItems);
  await db.delete(refreshTokens);
  await db.delete(users);
});

describe('model parcels and the grid', () => {
  it('resolves a household through the grid to a model parcel', async () => {
    const { testApp, token } = await adminApp();
    const { beans, pasta } = await setUp(testApp, token);

    const single = await preview(testApp, token, 1, 0);
    expect(single.modelParcelName).toBe('Single parcel');
    expect(single.lines).toEqual([{ stockItemId: beans, quantity: 2 }]);

    const family = await preview(testApp, token, 2, 3);
    expect(family.modelParcelName).toBe('Family parcel');
    expect(family.lines).toEqual(
      expect.arrayContaining([
        { stockItemId: beans, quantity: 4 },
        { stockItemId: pasta, quantity: 2 },
      ]),
    );
  });

  it('feeds an oversized household from the clamped corner cell', async () => {
    const { testApp, token } = await adminApp();
    await setUp(testApp, token);

    const huge = await preview(testApp, token, 9, 9);
    const corner = await preview(testApp, token, 5, 5);

    expect(huge.status).toBe(200);
    expect(huge.modelParcelName).toBe(corner.modelParcelName);
  });

  it('several household sizes share one model parcel', async () => {
    const { testApp, token } = await adminApp();
    await setUp(testApp, token);

    for (const [adults, children] of [
      [2, 3],
      [3, 2],
      [4, 0],
    ] as const) {
      expect((await preview(testApp, token, adults, children)).modelParcelName).toBe(
        'Family parcel',
      );
    }
  });

  it('editing one model parcel changes every household size using it', async () => {
    const { testApp, token } = await adminApp();
    const { beans } = await setUp(testApp, token);

    const family = (await db.select().from(modelParcels)).find((p) => p.name === 'Family parcel');
    await testApp.request(`/api/v1/model-parcels/${family?.id ?? ''}`, {
      method: 'PATCH',
      headers: json(token),
      body: JSON.stringify({ contents: [{ stockItemId: beans, quantity: 9 }] }),
    });

    for (const [adults, children] of [
      [2, 3],
      [4, 1],
    ] as const) {
      expect((await preview(testApp, token, adults, children)).lines).toEqual([
        { stockItemId: beans, quantity: 9 },
      ]);
    }
  });

  it('merges duplicate items within a model parcel', async () => {
    const { testApp, token } = await adminApp();
    const beans = await createStockItem(testApp, token, 'Beans');

    await addParcel(testApp, token, 'Doubled', [
      { stockItemId: beans, quantity: 2 },
      { stockItemId: beans, quantity: 3 },
    ]);
    await saveGrid(testApp, token, gridOf('Doubled', 'Doubled'));

    expect((await preview(testApp, token, 1, 0)).lines).toEqual([
      { stockItemId: beans, quantity: 5 },
    ]);
  });

  it('refuses a duplicate model parcel name', async () => {
    const { testApp, token } = await adminApp();
    const beans = await createStockItem(testApp, token, 'Beans');

    await addParcel(testApp, token, 'Single parcel', [{ stockItemId: beans, quantity: 1 }]);
    const duplicate = await addParcel(testApp, token, 'Single parcel', [
      { stockItemId: beans, quantity: 2 },
    ]);

    expect(duplicate.status).toBe(409);
  });

  it('refuses to delete a model parcel the grid still uses', async () => {
    const { testApp, token } = await adminApp();
    await setUp(testApp, token);
    const family = (await db.select().from(modelParcels)).find((p) => p.name === 'Family parcel');

    const response = await testApp.request(`/api/v1/model-parcels/${family?.id ?? ''}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    });

    expect(response.status).toBe(409);
    const body: { error: { details: { cells: string[] } } } = await response.json();
    expect(body.error.details.cells.length).toBeGreaterThan(0);
    expect(await db.select().from(modelParcels)).toHaveLength(2);
  });
});

describe('grid maintenance', () => {
  it('is saved whole, as a single row', async () => {
    const { testApp, token } = await adminApp();
    await setUp(testApp, token);

    const response = await testApp.request('/api/v1/parcel-grid', { headers: authHeaders(token) });
    const body: { grid: ParcelGrid; cells: string[]; isComplete: boolean } = await response.json();

    expect(Object.keys(body.grid)).toHaveLength(30);
    expect(body.cells).toHaveLength(30);
    expect(body.isComplete).toBe(true);
    // Exactly one row, whatever happens.
    expect(await db.select().from(parcelGrid)).toHaveLength(1);
  });

  it('saving again replaces it rather than adding a second row', async () => {
    const { testApp, token } = await adminApp();
    await setUp(testApp, token);

    await saveGrid(testApp, token, gridOf('Single parcel', 'Single parcel'));

    expect(await db.select().from(parcelGrid)).toHaveLength(1);
    expect((await preview(testApp, token, 5, 5)).modelParcelName).toBe('Single parcel');
  });

  it('refuses a grid naming a model parcel that does not exist', async () => {
    const { testApp, token } = await adminApp();
    await setUp(testApp, token);

    const response = await saveGrid(testApp, token, gridOf('Single parcel', 'Imaginary'));

    expect(response.status).toBe(422);
    const body: { error: { details: { unknownParcels: { name: string }[] } } } =
      await response.json();
    expect(body.error.details.unknownParcels[0]?.name).toBe('Imaginary');
  });

  it('refuses a cell that is not a real household size', async () => {
    const { testApp, token } = await adminApp();
    await setUp(testApp, token);

    const response = await saveGrid(testApp, token, {
      ...gridOf('Single parcel', 'Family parcel'),
      '9-9': 'Single parcel',
    });

    expect(response.status).toBe(422);
  });

  it('allows a partly filled grid while the charity is still setting up', async () => {
    const { testApp, token } = await adminApp();
    await setUp(testApp, token);

    const partial = Object.fromEntries(
      Object.entries(gridOf('Single parcel', 'Family parcel')).filter(([key]) => key !== '3-3'),
    );
    expect((await saveGrid(testApp, token, partial)).status).toBe(200);

    const response = await testApp.request('/api/v1/parcel-grid', { headers: authHeaders(token) });
    const body: { isComplete: boolean; missingCells: string[] } = await response.json();

    expect(body.isComplete).toBe(false);
    expect(body.missingCells).toEqual(['3-3']);

    // And a household landing on the hole is reported, not guessed at.
    expect((await preview(testApp, token, 3, 3)).status).toBe(422);
  });
});

describe('authorisation', () => {
  it('refuses a team lead changing the parcels or the grid', async () => {
    const { testApp, token } = await adminApp();
    const { beans } = await setUp(testApp, token);

    const lead = buildTestApp();
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    const added = await addParcel(lead, accessToken, 'Sneaky', [
      { stockItemId: beans, quantity: 1 },
    ]);
    const grid = await saveGrid(lead, accessToken, gridOf('Single parcel', 'Family parcel'));

    expect(added.status).toBe(403);
    expect(grid.status).toBe(403);
  });

  it('lets a team lead read and preview, so a picker can be answered', async () => {
    const { testApp, token } = await adminApp();
    await setUp(testApp, token);

    const lead = buildTestApp();
    const { accessToken } = await devLogin(lead, {
      email: 'lead@foodbank.org',
      role: 'team_lead',
    });

    expect(
      (await lead.request('/api/v1/model-parcels', { headers: authHeaders(accessToken) })).status,
    ).toBe(200);
    expect((await preview(lead, accessToken, 2, 3)).status).toBe(200);
  });
});
