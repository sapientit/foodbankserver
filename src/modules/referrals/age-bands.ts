/**
 * The four age bands the referral form collects, and the derivation of the
 * two operational counts everything else in this system speaks.
 *
 * Pure, no I/O — see `matching.ts` for the pattern this follows.
 */

/** The household as the referral form asks for it. */
export interface AgeBands {
  readonly infants: number; // 0-3
  readonly children4To11: number; // 4-11
  readonly teenagers12To17: number; // 12-17
  readonly adults18Plus: number; // 18+
}

/** The household as everything downstream of the form still reads it. */
export interface OperationalHousehold {
  readonly adults: number;
  readonly children: number;
}

/**
 * `children` is the 4-11 count; `adults` is the 12-17 count plus the 18+
 * count. Infants are collected and change nothing operational: what a baby
 * needs is nappies and milk, and those reach the parcel through the
 * household's preferences, not through a larger model parcel — see
 * `INITIAL_SPEC1.txt`, the referral form section.
 *
 * The derived pair keeps the names `adults` and `children` rather than
 * gaining new ones, because everything operational already speaks them: the
 * 5x6 grid, the `parcels` snapshot, and the client's `familySize` preference
 * rules. Renaming them here would have made "adults" mean two different
 * things depending on which end of a request you were standing at.
 */
export function deriveHousehold(bands: AgeBands): OperationalHousehold {
  return {
    adults: bands.teenagers12To17 + bands.adults18Plus,
    children: bands.children4To11,
  };
}

/** At least one person aged twelve or over. */
export function hasSomeoneTwelveOrOver(bands: AgeBands): boolean {
  return bands.teenagers12To17 + bands.adults18Plus >= 1;
}
