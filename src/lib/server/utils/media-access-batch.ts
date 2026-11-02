// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Batch access-filter helper.
 *
 * Returns only the subset of media_items IDs the caller is allowed to see
 * under both the library-group boundary (deniedGroupIds) and the age policy
 * (ageRating). Single batch query — avoids per-row checkMediaAccess loops
 * on result sets of ~20 items (music carousels, taste-similar, etc.).
 *
 * Library semantics ARE buildLibraryAccessFilter's — the builder itself is
 * called, not a copy of its predicate. That matters: this helper is handed
 * arbitrary caller-supplied ids, and several callers pass CONTAINER rows
 * (`music-artist-detail.handler.ts` and `/music/artists/[id]` filter `album`
 * rows; `person.service.ts` and `user-notifier.service.ts` filter `tv` rows).
 * The inlined copy that used to live here was the pre-container predicate
 * whose first arm is `NOT EXISTS (files owned by mi.id)` — and no `tv`,
 * `season`, `artist` or `album` row owns `media_file_items` (0 of 19,836 on
 * production, 2026-09-15, against 80,777 leaf rows that do), so that arm was
 * ALWAYS true and the library axis was a no-op for exactly those ids.
 * Age semantics are buildSeriesOwnedAgeRatingFilter's: a row passes if its
 * rating is null AND the policy allows unrated, OR its rating is at or below
 * maxAgeRating — where a season's or episode's rating is its series' (their
 * own `age_rating` is never written).
 *
 * The boundary is REQUIRED and required-by-shape: `MediaAccessBoundary` has no
 * permissive default and no "absent" value. A caller that genuinely wants
 * unfiltered rows must construct `unrestrictedAccess()`, which is greppable.
 *
 * Fast paths, in order:
 * - `denyAll` on EITHER axis -> empty set, no query. Checked FIRST, otherwise a
 *   deny-everything caller would fall through and be handed every id.
 * - unrestricted on BOTH axes -> the input ids untouched, no query. Note this
 *   also skips the incidental `media_items` existence check the query performs,
 *   so an unrestricted caller may get back ids whose row no longer exists. That
 *   is a deliberate, explicit opt-out: it is what `unrestrictedAccess()` means.
 *   A caller that needs the existence check must not use this helper for it.
 */

import type { Sql } from 'postgres';
import {
    deniesEverything,
    isUnrestricted,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import { buildSeriesOwnedAgeRatingFilter } from '$lib/server/database/queries/builders/age-rating.builder.js';

export type {
    AgeScope,
    LibraryScope,
    MediaAccessBoundary,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
export {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';

export async function filterAccessibleMediaIds(
    sql: Sql,
    mediaIds: readonly string[],
    boundary: MediaAccessBoundary,
): Promise<Set<string>> {
    // denyAll must be checked BEFORE the unrestricted fast path — otherwise a
    // deny-everything caller would fall through and be handed every id.
    if (deniesEverything(boundary)) return new Set();
    if (mediaIds.length === 0) return new Set();
    if (isUnrestricted(boundary)) return new Set(mediaIds);

    // `denyGroups` with an empty list denies nothing, so the builder emits no
    // predicate — the query then degrades to the bare `media_items` existence
    // check, NOT to the unrestricted fast path above. `restrictedAccess`
    // already collapses that input to `{ kind: 'all' }`; the builder's own
    // empty-list guard only covers a hand-written literal.
    const rows = await sql<{ id: string }[]>`
        SELECT mi.id::text
        FROM media_items mi
        WHERE mi.id = ANY(${mediaIds as string[]}::uuid[])
          ${buildLibraryAccessFilter(sql, boundary.library, 'mi')}
          ${buildSeriesOwnedAgeRatingFilter(sql, boundary.age, 'mi')}
    `;
    return new Set(rows.map((r) => r.id));
}

/**
 * Convenience filter over a list of rows with `.id`. Drops rows the
 * caller cannot access.
 */
export async function filterAccessibleRows<T extends { id: string }>(
    sql: Sql,
    rows: readonly T[],
    boundary: MediaAccessBoundary,
): Promise<T[]> {
    if (rows.length === 0) return [];
    const allowed = await filterAccessibleMediaIds(
        sql,
        rows.map((r) => r.id),
        boundary,
    );
    return rows.filter((r) => allowed.has(r.id));
}
