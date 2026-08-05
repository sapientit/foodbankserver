import { allGridKeys, type ParcelGrid } from '../../src/modules/rules/engine.ts';
import { authHeaders, type TestApp } from './app.ts';
import {
  setUpReferralWorld,
  submitReferral,
  UNKNOWN_REFERRER,
  type ReferralWorld,
} from './referral-fixtures.ts';

function json(token: string): Record<string, string> {
  return { ...authHeaders(token), 'content-type': 'application/json' };
}

/** The three stock items every picking test works with. */
export interface StockItemIds {
  readonly Beans: string;
  readonly Pasta: string;
  readonly Cereal: string;
}

export interface PickingWorld extends ReferralWorld {
  readonly stockItems: StockItemIds;
}

/**
 * A session, a published form, a published rule set with two model parcels and
 * a complete grid, and an authorised referrer — everything a pick list needs.
 */
export async function setUpPickingWorld(
  testApp: TestApp,
  token: string,
  options: { capacity?: number } = {},
): Promise<PickingWorld> {
  const base = await setUpReferralWorld(testApp, token, options);

  const created: Record<'Beans' | 'Pasta' | 'Cereal', string> = {
    Beans: '',
    Pasta: '',
    Cereal: '',
  };
  for (const [name, shelf] of [
    ['Beans', 'A2'],
    ['Pasta', 'A10'],
    ['Cereal', 'A1'],
  ] as const) {
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ name, shelfNumber: shelf }),
    });
    const { id }: { id: string } = await response.json();
    created[name] = id;
  }
  const stockItems: StockItemIds = created;

  await addModelParcel(testApp, token, 'Single parcel', [
    { stockItemId: stockItems.Beans, quantity: 2 },
  ]);
  await addModelParcel(testApp, token, 'Family parcel', [
    { stockItemId: stockItems.Beans, quantity: 4 },
    { stockItemId: stockItems.Pasta, quantity: 2 },
    { stockItemId: stockItems.Cereal, quantity: 1 },
  ]);

  await saveGrid(testApp, token, gridOf('Single parcel', 'Family parcel'));

  return { ...base, stockItems };
}

export async function addModelParcel(
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

export async function saveGrid(
  testApp: TestApp,
  token: string,
  grid: ParcelGrid,
): Promise<Response> {
  return testApp.request('/api/v1/parcel-grid', {
    method: 'PUT',
    headers: json(token),
    body: JSON.stringify({ grid }),
  });
}

/** Households of 1-2 get the small parcel, everyone else the family one. */
export function gridOf(smallName: string, largeName: string): ParcelGrid {
  const grid: ParcelGrid = {};
  for (const key of allGridKeys()) {
    const [adults, children] = key.split('-').map(Number);
    grid[key] = (adults ?? 0) + (children ?? 0) <= 2 ? smallName : largeName;
  }
  return grid;
}

export async function generatePickList(
  testApp: TestApp,
  token: string,
  sessionId: string,
): Promise<{ status: number; id: string; parcelsCreated: number; skipped: unknown[] }> {
  const response = await testApp.request(`/api/v1/sessions/${sessionId}/pick-list`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  const body: { id?: string; parcelsCreated?: number; skipped?: unknown[] } = await response.json();

  return {
    status: response.status,
    id: body.id ?? '',
    parcelsCreated: body.parcelsCreated ?? 0,
    skipped: body.skipped ?? [],
  };
}

export async function readPickList(testApp: TestApp, token: string, pickListId: string) {
  const response = await testApp.request(`/api/v1/pick-lists/${pickListId}`, {
    headers: authHeaders(token),
  });
  const body: {
    pickList: { status: string };
    parcels: {
      id: string;
      pickNumber: number;
      adults: number;
      children: number;
      lines: { stockItemId: string; name: string; quantity: number; source: string }[];
    }[];
  } = await response.json();
  return body;
}

export { submitReferral, UNKNOWN_REFERRER };
