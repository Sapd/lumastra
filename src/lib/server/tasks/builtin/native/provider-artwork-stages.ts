// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The five provider-artwork stage ids, in the order the drain should be worked
 * (seasons first — they are the slot with no durable local backing at all).
 *
 * Deliberately a LEAF module with no imports: `provider-artwork-report.ts` and
 * the tests need the list without dragging `provider-artwork-backfill.ts`'s
 * query/service graph into their module graph.
 *
 * These EXACT strings also appear as literals in `provider-artwork-backfill.ts`
 * (task id + coversStages id), in `STAGE_APPLIES_TO` and `STAGE_RESOURCE_CLASS`
 * (`ingest-map.constants.ts`), and in the stage-seeding migration. The lint rule
 * `callback-safety/stage-applies-to-mirror-in-sync` scrapes RAW SOURCE, so this
 * constant can never become the single source of truth for those — it is a
 * convenience list for the report task and the migration test.
 */
export const PROVIDER_ARTWORK_STAGE_IDS: ReadonlyArray<string> = [
    'provider-artwork-season-poster',
    'provider-artwork-poster',
    'provider-artwork-backdrop',
    'provider-artwork-logo',
    'provider-artwork-thumb',
];
