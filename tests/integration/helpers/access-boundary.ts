// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared differential access-boundary test helper — the single source of truth
 * for the "run a query three ways and prove it honours its boundary" invariant.
 *
 * Types guarantee a {@link MediaAccessBoundary} argument ARRIVES; they cannot
 * guarantee it is USED, that it is applied to the right table alias, or that it
 * lands in the outer WHERE rather than inside a CTE that has already
 * materialized denied ids. That is what {@link expectAccessFiltered} is for.
 *
 * The invariant, per the access-boundary design spec, runs each query three
 * ways against one fixture:
 *
 *   1. `unrestrictedAccess()`  — POSITIVE CONTROL. Must be non-empty. Many
 *      access-taking query functions catch their own errors and return `[]`;
 *      without this control a `denyAll` assertion would pass just as happily
 *      when the SQL threw as when the predicate worked.
 *   2. a restricted boundary   — must be a STRICT SUBSET of (1): nothing new
 *      appears, and at least one row disappears.
 *   3. `denyAllAccess()`       — must be EMPTY.
 *
 * A weaker `denyAll`-only shortcut is deliberately NOT offered: a helper that
 * lets callers opt out of the positive control or the strict-subset check
 * defeats the point. Where a module structurally cannot produce a strict subset
 * from one query (e.g. a single-series `searchEpisode` that drops to `[]` under
 * a denied group), tests use the raw three-call form rather than weakening this
 * helper.
 *
 * The bodies below are lifted verbatim from the canonical copies in
 * `search-access-boundary.integration.test.ts` (lines 74–162) so extraction is
 * behaviour-preserving.
 */

import { expect } from 'vitest';
import type postgres from 'postgres';
import {
    unrestrictedAccess,
    denyAllAccess,
    restrictedAccess,
    type MediaAccessBoundary,
} from '$lib/server/database/queries/builders/media-access-boundary';
import { createTestMediaItem, insertTestMediaItem } from '../fixtures/index.js';

// =============================================================================
// Shared assertion
// =============================================================================

/**
 * Assert a query actually honours its access boundary.
 *
 * @param run - runs the query under the supplied boundary
 * @param keyOf - stable identity for a returned row
 * @param restricted - a boundary that must hide at least the seeded row
 */
export async function expectAccessFiltered<T>(
    run: (access: MediaAccessBoundary) => Promise<T[]>,
    keyOf: (row: T) => string,
    restricted: MediaAccessBoundary,
): Promise<{ open: string[]; narrowed: string[] }> {
    const open = (await run(unrestrictedAccess())).map(keyOf);
    // POSITIVE CONTROL — proves the fixture is reachable and the SQL runs. A
    // swallowed error would surface here as an empty set.
    expect(open.length, 'unrestricted boundary must return rows').toBeGreaterThan(0);

    const narrowed = (await run(restricted)).map(keyOf);
    // STRICT SUBSET: nothing new appears, and at least one row disappears.
    const openSet = new Set(open);
    expect(narrowed.every((k) => openSet.has(k))).toBe(true);
    expect(narrowed.length).toBeLessThan(open.length);

    const denied = (await run(denyAllAccess())).map(keyOf);
    expect(denied).toEqual([]);

    return { open, narrowed };
}

/** Boundary denying exactly the given library groups; age unrestricted. */
export function denyGroups(...ids: string[]): MediaAccessBoundary {
    return restrictedAccess({ deniedGroupIds: ids, maxAgeRating: null, allowUnrated: true });
}

/** Boundary capping the age rating; library unrestricted. */
export function ageLimit(maxAgeRating: number): MediaAccessBoundary {
    return restrictedAccess({ deniedGroupIds: [], maxAgeRating, allowUnrated: false });
}

// =============================================================================
// Fixture helpers
// =============================================================================

/** Insert a library_groups row, return its id. */
export async function createLibraryGroup(sql: postgres.Sql, name: string): Promise<string> {
    const id = crypto.randomUUID();
    await sql`INSERT INTO library_groups (id, name) VALUES (${id}::uuid, ${name})`;
    return id;
}

/**
 * Insert a movie/tv item with a media_files row in `libraryGroupId`, so the
 * library-access predicate has a non-NULL group to exclude.
 */
export async function insertItemInGroup(
    sql: postgres.Sql,
    opts: {
        title: string;
        mediaType: 'movie' | 'tv';
        libraryGroupId: string | null;
        ageRating?: number | null;
    },
): Promise<string> {
    const item = createTestMediaItem({
        title: opts.title,
        media_type: opts.mediaType,
        has_files: true,
    });
    await insertTestMediaItem(sql, item);
    if (opts.ageRating !== undefined) {
        await sql`
            UPDATE media_items SET age_rating = ${opts.ageRating} WHERE id = ${item.id}::uuid
        `;
    }
    await attachFile(sql, item.id, opts.libraryGroupId);
    return item.id;
}

/** Attach a media_files row (optionally in a library group) to a media item. */
export async function attachFile(
    sql: postgres.Sql,
    mediaItemId: string,
    libraryGroupId: string | null,
): Promise<void> {
    const [{ id: fileId }] = await sql<[{ id: string }]>`
        INSERT INTO media_files (file_path, library_group_id)
        VALUES (${`/data/${mediaItemId}.mkv`}, ${libraryGroupId}::uuid)
        ON CONFLICT (file_path) DO UPDATE SET library_group_id = EXCLUDED.library_group_id
        RETURNING id
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id)
        VALUES (${fileId}::uuid, ${mediaItemId}::uuid)
        ON CONFLICT DO NOTHING
    `;
    await sql`UPDATE media_items SET has_files = true WHERE id = ${mediaItemId}::uuid`;
}
