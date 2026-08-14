import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { expectAtMostOne } from '../../db/expect.ts';
import {
  parcelLines,
  parcels,
  pickLists,
  type NewParcelLine,
  type NewPickList,
  type Parcel,
  type ParcelLine,
  type PickList,
} from '../../db/schema/pick-lists.ts';
import { stockItems, type StockItem } from '../../db/schema/stock.ts';
import type { Patch } from '../../core/types.ts';

export interface ParcelWithLines {
  readonly parcel: Parcel;
  readonly lines: (ParcelLine & { readonly item: StockItem })[];
}

export function createPickListsRepository(db: Database) {
  return {
    async findBySession(sessionId: string): Promise<PickList | undefined> {
      const rows = await db
        .select()
        .from(pickLists)
        .where(eq(pickLists.sessionId, sessionId))
        .limit(1);
      return expectAtMostOne(rows);
    },

    async findById(id: string): Promise<PickList | undefined> {
      const rows = await db.select().from(pickLists).where(eq(pickLists.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    async listParcels(pickListId: string): Promise<Parcel[]> {
      return db
        .select()
        .from(parcels)
        .where(eq(parcels.pickListId, pickListId))
        .orderBy(asc(parcels.pickNumber));
    },

    async findParcelById(id: string): Promise<Parcel | undefined> {
      const rows = await db.select().from(parcels).where(eq(parcels.id, id)).limit(1);
      return expectAtMostOne(rows);
    },

    /**
     * Every parcel with its lines and the stock item behind each, **in two
     * queries** rather than one per parcel.
     *
     * This is what the picking screen and the print payload both read. At 25
     * parcels a per-parcel query would be 25+ on a plan that allows 50.
     * Ordered by shelf so a picker walks the aisle once.
     */
    async listParcelsWithLines(pickListId: string): Promise<ParcelWithLines[]> {
      const parcelRows = await this.listParcels(pickListId);
      if (parcelRows.length === 0) return [];

      const lineRows = await db
        .select({ line: parcelLines, item: stockItems })
        .from(parcelLines)
        .innerJoin(stockItems, eq(stockItems.id, parcelLines.stockItemId))
        .where(
          inArray(
            parcelLines.parcelId,
            parcelRows.map((row) => row.id),
          ),
        )
        .orderBy(asc(stockItems.shelfSortKey));

      const byParcel = new Map<string, (ParcelLine & { item: StockItem })[]>();
      for (const row of lineRows) {
        const existing = byParcel.get(row.line.parcelId) ?? [];
        existing.push({ ...row.line, item: row.item });
        byParcel.set(row.line.parcelId, existing);
      }

      return parcelRows.map((parcel) => ({
        parcel,
        lines: byParcel.get(parcel.id) ?? [],
      }));
    },

    /** A parcel's lines, for the stock movement when attendance is recorded. */
    async listLinesFor(parcelId: string): Promise<ParcelLine[]> {
      return db.select().from(parcelLines).where(eq(parcelLines.parcelId, parcelId));
    },

    async findLine(parcelId: string, stockItemId: string): Promise<ParcelLine | undefined> {
      const rows = await db
        .select()
        .from(parcelLines)
        .where(and(eq(parcelLines.parcelId, parcelId), eq(parcelLines.stockItemId, stockItemId)))
        .limit(1);
      return expectAtMostOne(rows);
    },

    async upsertLine(value: NewParcelLine): Promise<void> {
      await db
        .insert(parcelLines)
        .values(value)
        .onConflictDoUpdate({
          target: [parcelLines.parcelId, parcelLines.stockItemId],
          set: { quantity: value.quantity, updatedAt: value.updatedAt },
        });
    },

    async deleteLine(parcelId: string, stockItemId: string): Promise<void> {
      await db
        .delete(parcelLines)
        .where(and(eq(parcelLines.parcelId, parcelId), eq(parcelLines.stockItemId, stockItemId)));
    },

    async updatePickList(id: string, patch: Patch<NewPickList>): Promise<PickList | undefined> {
      const rows = await db.update(pickLists).set(patch).where(eq(pickLists.id, id)).returning();
      return expectAtMostOne(rows);
    },

    async updateParcel(
      id: string,
      patch: Patch<typeof parcels.$inferInsert>,
    ): Promise<Parcel | undefined> {
      const rows = await db.update(parcels).set(patch).where(eq(parcels.id, id)).returning();
      return expectAtMostOne(rows);
    },

    /**
     * Marks every parcel of a cancelled referral as cancelled.
     *
     * A **Drizzle** builder rather than a raw D1 statement, unlike the
     * generation builders below: this one is composed into the referrals
     * service's `db.batch()`, and Drizzle's batch refuses anything that is not
     * its own query builder.
     *
     * **Only from `pending`, and the condition travels with the write.** There
     * is no transaction to make read-then-write safe, and an outcome already
     * recorded is not a household still to come: a parcel marked `attended`
     * moved stock, and overwriting that would leave `parcel_issued` rows
     * belonging to a parcel that no longer says anybody was fed. The lines, the
     * note and the pick number are untouched — the parcel is the record of what
     * was picked that morning, not a row to tidy up.
     */
    buildCancelParcelsFor(referralId: string, at: string) {
      return db
        .update(parcels)
        .set({ attendance: 'cancelled', updatedAt: at })
        .where(and(eq(parcels.referralId, referralId), eq(parcels.attendance, 'pending')));
    },

    async highestPickNumber(pickListId: string): Promise<number> {
      const rows = await db
        .select({ highest: sql<number | null>`MAX(${parcels.pickNumber})` })
        .from(parcels)
        .where(eq(parcels.pickListId, pickListId));
      return rows[0]?.highest ?? 0;
    },

    // ---- Statement builders for generation ----
    //
    // These return **raw D1 prepared statements**, not Drizzle query builders,
    // and are run through `db.$client.batch()`. Two reasons:
    //
    // 1. D1 allows 100 bound parameters per statement, so a multi-row
    //    `INSERT ... VALUES` blows up at about 8 parcels. Binding the whole
    //    set as a single JSON value and expanding it with SQLite's `json_each`
    //    is one statement with one parameter, whatever the count. Drizzle has
    //    no builder for that.
    // 2. Drizzle's `db.batch()` only accepts its own query builders — a raw
    //    `db.run(sql)` is not a batchable item and fails at runtime.
    //
    // This is the one place worth stepping outside Drizzle, and it is covered
    // by integration tests against real D1.

    buildInsertPickList(value: NewPickList): D1PreparedStatement {
      return db.$client
        .prepare(
          `INSERT INTO pick_lists
             (id, session_id, status, generated_at, generated_by_user_id,
              first_printed_at, confirmed_at, confirmed_by_user_id,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          value.id,
          value.sessionId,
          value.status ?? 'draft',
          value.generatedAt,
          value.generatedByUserId ?? null,
          value.firstPrintedAt ?? null,
          value.confirmedAt ?? null,
          value.confirmedByUserId ?? null,
          value.createdAt,
          value.updatedAt,
        );
    },

    /** ~25 parcels in one statement with one bound parameter. */
    buildInsertParcels(rows: readonly NewParcel[]): D1PreparedStatement {
      return db.$client
        .prepare(
          `INSERT INTO parcels
             (id, pick_list_id, referral_id, pick_number, adults, children,
              attendance, notes, created_at, updated_at)
           SELECT
             json_extract(value, '$.id'),
             json_extract(value, '$.pickListId'),
             json_extract(value, '$.referralId'),
             json_extract(value, '$.pickNumber'),
             json_extract(value, '$.adults'),
             json_extract(value, '$.children'),
             'pending',
             json_extract(value, '$.notes'),
             json_extract(value, '$.createdAt'),
             json_extract(value, '$.updatedAt')
           FROM json_each(?)`,
        )
        .bind(JSON.stringify(rows));
    },

    /**
     * Issues a parcel: one negative ledger row per line, in a single statement.
     *
     * **This is the write the whole stock design exists to protect.** The
     * partial unique index on
     * `(parcel_id, stock_item_id, movement_type)` means a second attempt for
     * the same parcel violates the constraint rather than moving stock twice —
     * which is the failure nobody notices until a stock take will not
     * reconcile.
     *
     * There is no matching un-issue: an outcome, once recorded, is final, and
     * a mistake is put right through an audited stock adjustment.
     */
    buildParcelIssue(input: {
      parcelId: string;
      sessionId: string;
      actorUserId: string | null;
      occurredAt: string;
      lines: readonly { id: string; stockItemId: string; quantity: number }[];
    }): D1PreparedStatement {
      const rows = input.lines.map((line) => ({
        id: crypto.randomUUID(),
        stockItemId: line.stockItemId,
        quantityDelta: -line.quantity,
      }));

      return db.$client
        .prepare(
          `INSERT INTO stock_ledger
             (id, stock_item_id, quantity_delta, movement_type, parcel_id, session_id,
              actor_user_id, occurred_at, created_at)
           SELECT
             json_extract(value, '$.id'),
             json_extract(value, '$.stockItemId'),
             json_extract(value, '$.quantityDelta'),
             'parcel_issued', ?2, ?3, ?4, ?5, ?5
           FROM json_each(?1)
           WHERE EXISTS (
             SELECT 1 FROM parcels
              WHERE parcels.id = ?2 AND parcels.attendance <> 'cancelled'
           )`,
        )
        .bind(
          JSON.stringify(rows),
          input.parcelId,
          input.sessionId,
          input.actorUserId,
          input.occurredAt,
        );
    },

    /**
     * Takes a parcel back: removes every movement it wrote.
     *
     * This is what makes a mis-tapped outcome fixable now that there is no
     * hand correction to fix it with. It is safe to run when there is nothing
     * to delete, which is what makes flipping an outcome idempotent without a
     * guard — unlike issuing, which needs the unique index.
     *
     * Scoped to one `parcel_id`, and that scoping is the whole safety story:
     * this is one of only two statements in the system that delete ledger
     * rows, and a wrong `WHERE` here silently loses stock that really went out.
     */
    buildDeleteParcelIssue(parcelId: string): D1PreparedStatement {
      return db.$client.prepare(`DELETE FROM stock_ledger WHERE parcel_id = ?1`).bind(parcelId);
    },

    /**
     * Records an outcome — **never onto a cancelled parcel.**
     *
     * The condition travels with the write because `record` cannot hold one.
     * It reads the parcel, then makes three more round trips before it commits,
     * and a referral cancelled inside that window would otherwise be overwritten
     * back to `attended` by a request that read `pending` before the
     * cancellation landed. The service's own `cancelled` check catches the
     * cancellation it can see; this catches the one that arrives afterwards.
     *
     * `<> 'cancelled'` rather than `= 'pending'`: this same statement is how an
     * outcome is taken back, so it must still move `attended` to `no_show` and
     * back. **`buildParcelIssue` carries the matching condition**, so when this
     * matches nothing the ledger insert beside it in the batch inserts nothing
     * either — the pair no-ops together rather than issuing stock for a parcel
     * whose attendance was refused. Zero rows changed is the signal `record`
     * reads to tell the caller it lost the race.
     */
    buildSetAttendance(input: {
      parcelId: string;
      attendance: 'attended' | 'no_show';
      actorUserId: string | null;
      at: string;
    }): D1PreparedStatement {
      return db.$client
        .prepare(
          `UPDATE parcels
              SET attendance = ?2,
                  attendance_recorded_at = ?3,
                  attendance_recorded_by_user_id = ?4,
                  updated_at = ?3
            WHERE id = ?1 AND attendance <> 'cancelled'`,
        )
        .bind(input.parcelId, input.attendance, input.at, input.actorUserId);
    },

    /** ~250 lines in one statement with one bound parameter. */
    buildInsertParcelLines(rows: readonly NewParcelLine[]): D1PreparedStatement {
      return db.$client
        .prepare(
          `INSERT INTO parcel_lines
             (id, parcel_id, stock_item_id, quantity, created_at, updated_at)
           SELECT
             json_extract(value, '$.id'),
             json_extract(value, '$.parcelId'),
             json_extract(value, '$.stockItemId'),
             json_extract(value, '$.quantity'),
             json_extract(value, '$.createdAt'),
             json_extract(value, '$.updatedAt')
           FROM json_each(?)`,
        )
        .bind(JSON.stringify(rows));
    },
  };
}

type NewParcel = typeof parcels.$inferInsert;

export type PickListsRepository = ReturnType<typeof createPickListsRepository>;
