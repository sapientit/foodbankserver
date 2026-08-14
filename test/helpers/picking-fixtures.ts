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
  // Categories that genuinely differ from one another and from shelf order,
  // so a test asserting category grouping cannot pass by accident against
  // shelf grouping: category order is Breakfast, Dried Goods, Tinned Goods
  // while shelf order is Cereal (A1), Beans (A2), Pasta (A10).
  for (const [name, category, shelf] of [
    ['Beans', 'Tinned Goods', 'A2'],
    ['Pasta', 'Dried Goods', 'A10'],
    ['Cereal', 'Breakfast', 'A1'],
  ] as const) {
    const response = await testApp.request('/api/v1/stock/items', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ name, category, shelfNumber: shelf }),
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

/** One household's preference lines, as the client's own rules resolved them. */
export interface PreferenceLineInput {
  readonly referralId: string;
  readonly lines: { stockItemId: string; quantity: number }[];
}

/** One household's pick-list information, as the client composed it from the form answers. */
export interface PickListInformationInput {
  readonly referralId: string;
  readonly notes: string;
}

/**
 * Generates or reconciles, with or without preference lines and pick-list
 * information.
 *
 * With neither supplied it POSTs **no body at all**, which is what the
 * picking screen does and what keeps the optional-body path covered by every
 * existing caller.
 */
export async function generatePickList(
  testApp: TestApp,
  token: string,
  sessionId: string,
  preferenceLines?: PreferenceLineInput[],
  pickListInformation?: PickListInformationInput[],
): Promise<{
  status: number;
  id: string;
  parcelsCreated: number;
  skipped: unknown[];
  preferenceLinesApplied: number;
  preferenceLinesDropped: number;
  preferenceReferralsIgnored: number;
}> {
  const hasBody = preferenceLines !== undefined || pickListInformation !== undefined;
  const response = await testApp.request(`/api/v1/sessions/${sessionId}/pick-list`, {
    method: 'POST',
    headers: hasBody ? json(token) : authHeaders(token),
    ...(hasBody
      ? {
          body: JSON.stringify({
            ...(preferenceLines === undefined ? {} : { preferenceLines }),
            ...(pickListInformation === undefined ? {} : { pickListInformation }),
          }),
        }
      : {}),
  });
  const body: {
    id?: string;
    parcelsCreated?: number;
    skipped?: unknown[];
    preferenceLinesApplied?: number;
    preferenceLinesDropped?: number;
    preferenceReferralsIgnored?: number;
  } = await response.json();

  return {
    status: response.status,
    id: body.id ?? '',
    parcelsCreated: body.parcelsCreated ?? 0,
    skipped: body.skipped ?? [],
    preferenceLinesApplied: body.preferenceLinesApplied ?? 0,
    preferenceLinesDropped: body.preferenceLinesDropped ?? 0,
    preferenceReferralsIgnored: body.preferenceReferralsIgnored ?? 0,
  };
}

/**
 * Reviews every parcel on a list, which is what printing now requires.
 *
 * Most print tests are about the sheet's contents rather than the review rule,
 * so they get their prerequisite from here; the rule itself has its own tests.
 */
export async function reviewEveryParcel(
  testApp: TestApp,
  token: string,
  pickListId: string,
): Promise<void> {
  const { parcels } = await readPickList(testApp, token, pickListId);
  for (const parcel of parcels) {
    await testApp.request(`/api/v1/parcels/${parcel.id}/review`, {
      method: 'POST',
      headers: authHeaders(token),
    });
  }
}

export async function readPickList(testApp: TestApp, token: string, pickListId: string) {
  const response = await testApp.request(`/api/v1/pick-lists/${pickListId}`, {
    headers: authHeaders(token),
  });
  const body: {
    pickList: { status: string };
    parcels: {
      id: string;
      referralId: string;
      pickNumber: number;
      adults: number;
      children: number;
      notes: string | null;
      attendance: string;
      lines: {
        stockItemId: string;
        name: string;
        description: string | null;
        quantity: number;
      }[];
    }[];
  } = await response.json();
  return body;
}

export { submitReferral, UNKNOWN_REFERRER };
