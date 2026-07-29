/**
 * Branded identifier types.
 *
 * These are plain strings at runtime but are not interchangeable at compile
 * time, so a `SessionId` can never be passed where a `ReferralId` is expected.
 */

declare const brandSymbol: unique symbol;

export type Brand<T, TBrand extends string> = T & { readonly [brandSymbol]: TBrand };

export type OrganisationId = Brand<string, 'OrganisationId'>;
export type ReferrerId = Brand<string, 'ReferrerId'>;
export type ReferralId = Brand<string, 'ReferralId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type ParcelId = Brand<string, 'ParcelId'>;
export type PickListId = Brand<string, 'PickListId'>;
export type StockItemId = Brand<string, 'StockItemId'>;
export type UserId = Brand<string, 'UserId'>;

/*
 * The two helpers below are return-type-only generics on purpose: the caller
 * names the brand it wants (`brandId<SessionId>(row.id)`). That is exactly the
 * shape `no-unnecessary-type-parameters` warns about, so it is disabled here
 * and nowhere else.
 */
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */

/**
 * Marks a validated string as an identifier of the given kind. Call this only
 * at a trust boundary — after schema validation, or when reading from storage.
 */
export function brandId<TId extends Brand<string, string>>(value: string): TId {
  return value as TId;
}

/** Mints a fresh identifier of the given kind. */
export function newId<TId extends Brand<string, string>>(): TId {
  return crypto.randomUUID() as TId;
}

/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */
