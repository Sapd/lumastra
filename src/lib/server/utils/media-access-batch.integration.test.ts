// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Differential access-boundary tests for `media-access-batch.ts`.
 *
 * This module is the JS-side batch gate: every caller that has already fetched
 * rows and needs them narrowed to what one user may see routes through
 * `filterAccessibleMediaIds` / `filterAccessibleRows`. It inlines its own copies
 * of the library-group and age predicates rather than delegating to
 * `buildLibraryAccessFilter` / `buildAgeRatingFilter` (those hardcode an `mi`
 * alias into a fragment meant for a different surrounding query), so the two
 * enforcement sites can drift. Only a test against real SQL catches that.
 *
 * Types make the boundary REQUIRED — they cannot make it USED. A predicate
 * dropped from the template, a fragment attached to the wrong alias, or a `kind`
 * switch falling through to the permissive branch all still compile and still
 * return a plausible-looking Set.
 *
 * Every surface therefore runs against one fixture three ways:
 *
 *   1. `unrestrictedAccess()`  — POSITIVE CONTROL. Must return every id.
 *   2. a restricted boundary   — must be a STRICT SUBSET of (1).
 *   3. `denyAllAccess()`       — must be EMPTY.
 *
 * The positive control is load-bearing: without it the denyAll assertion would
 * pass just as happily against an empty or unreachable fixture.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/utils/media-access-batch.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { filterAccessibleMediaIds, filterAccessibleRows } from './media-access-batch.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from '../database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '../database/queries/builders/media-access-boundary.js';
import { placeInLibraryGroup } from '../../../../tests/integration/fixtures/index.js';

let sql: postgres.Sql;

const ALLOWED_GROUP = randomUUID();
const DENIED_GROUP = randomUUID();

/**
 * Fixture ids. The five rows cover every branch of the two inlined predicates:
 *
 * - `allowed`    — file in a permitted group, unrated
 * - `denied`     — file in a denied group; the ONLY row the library axis hides
 * - `adult`      — file in a permitted group, age_rating 18; the ONLY row the
 *                  age axis hides at maxAgeRating 13
 * - `noFiles`    — no `media_file_items` rows at all (container-style). Passes
 *                  the library axis via the `NOT EXISTS` branch — the branch a
 *                  naive "join files and check the group" rewrite would drop.
 * - `nullGroup`  — a file whose `library_group_id` IS NULL. Passes via the
 *                  `library_group_id IS NULL` branch.
 */
const IDS = {
    allowed: randomUUID(),
    denied: randomUUID(),
    adult: randomUUID(),
    noFiles: randomUUID(),
    nullGroup: randomUUID(),
};
const ALL_IDS = Object.values(IDS);

/** Id with no `media_items` row — used to pin the existence-check asymmetry. */
const GHOST_ID = randomUUID();

/** Hides exactly `denied`. */
const LIBRARY_RESTRICTED: MediaAccessBoundary = restrictedAccess({
    deniedGroupIds: [DENIED_GROUP],
    maxAgeRating: null,
    allowUnrated: false,
});

/** Hides exactly `adult` (every other fixture row is unrated + allowUnrated). */
const AGE_RESTRICTED: MediaAccessBoundary = restrictedAccess({
    deniedGroupIds: [],
    maxAgeRating: 13,
    allowUnrated: true,
});

/** Hides `denied` AND `adult`. */
const BOTH_RESTRICTED: MediaAccessBoundary = restrictedAccess({
    deniedGroupIds: [DENIED_GROUP],
    maxAgeRating: 13,
    allowUnrated: true,
});

/** Hides every unrated row too — `allowUnrated: false` on an unrated fixture. */
const UNRATED_DENIED: MediaAccessBoundary = restrictedAccess({
    deniedGroupIds: [],
    maxAgeRating: 13,
    allowUnrated: false,
});

async function seedItem(opts: {
    id: string;
    title: string;
    ageRating: number | null;
    libraryGroupId: string | null;
    withFile: boolean;
}): Promise<void> {
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, age_rating, year)
        VALUES (
            ${opts.id}::uuid,
            ${opts.title},
            'movie',
            'active',
            ${opts.withFile},
            ${opts.ageRating},
            2020
        )
    `;
    if (!opts.withFile) return;

    const fileId = randomUUID();
    await sql`
        INSERT INTO media_files (id, file_path, library_group_id)
        VALUES (
            ${fileId}::uuid,
            ${`/data/movies/${opts.title}.mkv`},
            ${opts.libraryGroupId}::uuid
        )
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id)
        VALUES (${fileId}::uuid, ${opts.id}::uuid)
    `;
}

/** Assert `subset` is contained in `superset` and strictly smaller. */
function expectStrictSubset(subset: Set<string>, superset: Set<string>): void {
    for (const id of subset) expect(superset.has(id)).toBe(true);
    expect(subset.size).toBeLessThan(superset.size);
}

beforeAll(async () => {
    sql = getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.media);
    await sql`
        INSERT INTO library_groups (id, name)
        VALUES
            (${ALLOWED_GROUP}::uuid, 'Allowed Group'),
            (${DENIED_GROUP}::uuid, 'Denied Group')
        ON CONFLICT (id) DO NOTHING
    `;

    await seedItem({
        id: IDS.allowed,
        title: 'Allowed Group Movie',
        ageRating: null,
        libraryGroupId: ALLOWED_GROUP,
        withFile: true,
    });
    await seedItem({
        id: IDS.denied,
        title: 'Denied Group Movie',
        ageRating: null,
        libraryGroupId: DENIED_GROUP,
        withFile: true,
    });
    await seedItem({
        id: IDS.adult,
        title: 'Adult Movie',
        ageRating: 18,
        libraryGroupId: ALLOWED_GROUP,
        withFile: true,
    });
    await seedItem({
        id: IDS.noFiles,
        title: 'Catalog Only Movie',
        ageRating: null,
        libraryGroupId: null,
        withFile: false,
    });
    await seedItem({
        id: IDS.nullGroup,
        title: 'Ungrouped File Movie',
        ageRating: null,
        libraryGroupId: null,
        withFile: true,
    });
});

describe('filterAccessibleMediaIds honours its boundary', () => {
    it('POSITIVE CONTROL: unrestricted returns every id', async () => {
        const result = await filterAccessibleMediaIds(sql, ALL_IDS, unrestrictedAccess());
        expect(result).toEqual(new Set(ALL_IDS));
    });

    it('denyAll returns EMPTY', async () => {
        const result = await filterAccessibleMediaIds(sql, ALL_IDS, denyAllAccess());
        expect(result.size).toBe(0);
    });

    it('a library-restricted boundary is a strict subset, missing exactly the denied group', async () => {
        const unrestricted = await filterAccessibleMediaIds(sql, ALL_IDS, unrestrictedAccess());
        const restricted = await filterAccessibleMediaIds(sql, ALL_IDS, LIBRARY_RESTRICTED);

        expectStrictSubset(restricted, unrestricted);
        expect(restricted.has(IDS.denied)).toBe(false);
        // The two library-axis pass-through branches must survive.
        expect(restricted.has(IDS.noFiles)).toBe(true);
        expect(restricted.has(IDS.nullGroup)).toBe(true);
        expect(restricted.has(IDS.allowed)).toBe(true);
        expect(restricted.has(IDS.adult)).toBe(true);
    });

    it('an age-restricted boundary is a strict subset, missing exactly the over-age row', async () => {
        const unrestricted = await filterAccessibleMediaIds(sql, ALL_IDS, unrestrictedAccess());
        const restricted = await filterAccessibleMediaIds(sql, ALL_IDS, AGE_RESTRICTED);

        expectStrictSubset(restricted, unrestricted);
        expect(restricted.has(IDS.adult)).toBe(false);
        // The library axis is unrestricted here, so the denied-group row stays.
        expect(restricted.has(IDS.denied)).toBe(true);
    });

    it('both axes compose — the result is the intersection, not either one alone', async () => {
        const libraryOnly = await filterAccessibleMediaIds(sql, ALL_IDS, LIBRARY_RESTRICTED);
        const ageOnly = await filterAccessibleMediaIds(sql, ALL_IDS, AGE_RESTRICTED);
        const both = await filterAccessibleMediaIds(sql, ALL_IDS, BOTH_RESTRICTED);

        expectStrictSubset(both, libraryOnly);
        expectStrictSubset(both, ageOnly);
        expect(both).toEqual(new Set([IDS.allowed, IDS.noFiles, IDS.nullGroup]));
    });

    it('allowUnrated: false hides rows with a NULL age_rating', async () => {
        const result = await filterAccessibleMediaIds(sql, ALL_IDS, UNRATED_DENIED);
        // Every fixture row is either unrated or 18-rated, so nothing survives.
        expect(result.size).toBe(0);
    });

    it('drops ids with no media_items row when a predicate is active', async () => {
        const result = await filterAccessibleMediaIds(
            sql,
            [IDS.allowed, GHOST_ID],
            LIBRARY_RESTRICTED,
        );
        expect(result).toEqual(new Set([IDS.allowed]));
    });

    it('KEEPS dangling ids for an unrestricted boundary — the documented fast-path opt-out', async () => {
        // `unrestrictedAccess()` skips the query entirely, so the incidental
        // media_items existence check does not run. This is deliberate and is
        // what the explicit constructor means; a caller needing an existence
        // check must not get it from this helper.
        const result = await filterAccessibleMediaIds(
            sql,
            [IDS.allowed, GHOST_ID],
            unrestrictedAccess(),
        );
        expect(result).toEqual(new Set([IDS.allowed, GHOST_ID]));
    });
});

describe('filterAccessibleRows honours its boundary', () => {
    const rows = ALL_IDS.map((id, i) => ({ id, ordinal: i }));

    it('POSITIVE CONTROL: unrestricted keeps every row, in input order', async () => {
        const result = await filterAccessibleRows(sql, rows, unrestrictedAccess());
        expect(result).toEqual(rows);
    });

    it('denyAll drops every row', async () => {
        const result = await filterAccessibleRows(sql, rows, denyAllAccess());
        expect(result).toEqual([]);
    });

    it('a restricted boundary yields a strict subset, order preserved', async () => {
        const unrestricted = await filterAccessibleRows(sql, rows, unrestrictedAccess());
        const restricted = await filterAccessibleRows(sql, rows, BOTH_RESTRICTED);

        expectStrictSubset(
            new Set(restricted.map((r) => r.id)),
            new Set(unrestricted.map((r) => r.id)),
        );
        expect(restricted.map((r) => r.ordinal)).toEqual(
            [...restricted].sort((a, b) => a.ordinal - b.ordinal).map((r) => r.ordinal),
        );
    });
});

/**
 * Container rows (`tv`/`season`/`artist`/`album`) never own `media_file_items`
 * — verified on production 2026-09-15: 0 of 19,836 container rows do, against
 * 80,777 leaf rows that do. The predicate this module inlined therefore
 * evaluated `NOT EXISTS (own files)` = TRUE for every container id a caller
 * handed it, making the library axis a no-op for exactly the ids that DO reach
 * here: `music-artist-detail.handler.ts` and `/music/artists/[id]` filter
 * ALBUM rows, `person.service.ts` and `user-notifier.service.ts` filter `tv`
 * rows.
 *
 * Fixtures go through `placeInLibraryGroup` so the file lands where the
 * container-aware predicate actually looks (on a generated descendant leaf),
 * not on the container row — a state production cannot produce and which makes
 * the test false-green.
 */
describe('filterAccessibleMediaIds honours the library axis for CONTAINER rows', () => {
    async function seedContainer(
        mediaType: 'tv' | 'season' | 'artist' | 'album',
        libraryGroupId: string,
    ): Promise<string> {
        const id = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${id}::uuid, ${`${mediaType} ${id.slice(0, 8)}`}, ${mediaType}, 'active', false)
        `;
        await placeInLibraryGroup(sql, { mediaItemId: id, mediaType, libraryGroupId });
        return id;
    }

    for (const mediaType of ['tv', 'season', 'artist', 'album'] as const) {
        it(`hides a ${mediaType} row whose only descendant file is in a denied group`, async () => {
            const denied = await seedContainer(mediaType, DENIED_GROUP);
            const allowed = await seedContainer(mediaType, ALLOWED_GROUP);

            // POSITIVE CONTROL — both rows exist and are reachable.
            const open = await filterAccessibleMediaIds(
                sql,
                [denied, allowed],
                restrictedAccess({
                    deniedGroupIds: [randomUUID()],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            );
            expect(open).toEqual(new Set([denied, allowed]));

            const narrowed = await filterAccessibleMediaIds(
                sql,
                [denied, allowed],
                LIBRARY_RESTRICTED,
            );
            expectStrictSubset(narrowed, open);
            expect(narrowed).toEqual(new Set([allowed]));

            expect(await filterAccessibleMediaIds(sql, [denied, allowed], denyAllAccess())).toEqual(
                new Set(),
            );
        });
    }

    it('keeps an empty container stub visible — the fail-open branch for file-less rows', async () => {
        const stub = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${stub}::uuid, 'Empty Series Stub', 'tv', 'active', false)
        `;
        const result = await filterAccessibleMediaIds(sql, [stub], LIBRARY_RESTRICTED);
        expect(result).toEqual(new Set([stub]));
    });
});

// The request-time gate must also retain checkMediaAccess's unknown-id behavior.
describe('checkMediaAccessBatch matches the single-item gate', () => {
    it('matches library and age decisions, including missing ids, in one content read', async () => {
        const { checkMediaAccess, checkMediaAccessBatch } =
            await import('../middleware/media-access.js');
        const { invalidateLibraryGroupPermissionsCache } =
            await import('../cache/library-group-permissions-cache.js');
        const { upsertLibraryGroupPermission, deleteLibraryGroupPermission } =
            await import('../database/queries/library-group-permissions.queries.js');
        const { config } = await import('../config.js');
        const series = randomUUID();
        const season = randomUUID();
        const episode = randomUUID();
        const album = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, parent_id, age_rating, library_group_id)
            VALUES
                (${series}::uuid, 'Series', 'tv', 'active', NULL, 18, NULL),
                (${season}::uuid, 'Season', 'season', 'active', ${series}::uuid, NULL, NULL),
                (${episode}::uuid, 'Episode', 'episode', 'active', ${season}::uuid, NULL, NULL),
                (${album}::uuid, 'Denied album', 'album', 'active', NULL, NULL, ${DENIED_GROUP}::uuid)
        `;
        const ids = [
            ...ALL_IDS,
            GHOST_ID,
            series,
            season,
            episode,
            album,
            ...ALL_IDS.map((id) => id.toUpperCase()),
        ];
        await upsertLibraryGroupPermission(sql, {
            libraryGroupId: DENIED_GROUP,
            allowedGroups: ['privileged'],
        });
        invalidateLibraryGroupPermissionsCache();
        const user = {
            ownerIsAdmin: false,
            userGroups: [],
            isAgeRestricted: false,
            maxAgeRating: 13,
        } as unknown as import('../types.js').UserContext;
        try {
            for (const ageRestricted of [false, true]) {
                user.isAgeRestricted = ageRestricted;
                const singles = await Promise.all(ids.map((id) => checkMediaAccess(sql, id, user)));
                const batch = await checkMediaAccessBatch(sql, ids, user);
                expect(batch).toEqual(new Set(ids.filter((_, i) => singles[i])));
                expect(batch.has(IDS.denied)).toBe(false);
                expect(batch.has(album)).toBe(false);
                expect(batch.has(episode)).toBe(!ageRestricted);
                expect(batch.has(season)).toBe(!ageRestricted);
                expect(batch.has(IDS.adult)).toBe(!ageRestricted);
                expect(batch.has(GHOST_ID)).toBe(!ageRestricted || config.UNRATED_CONTENT_VISIBLE);
            }
        } finally {
            await deleteLibraryGroupPermission(sql, DENIED_GROUP);
            invalidateLibraryGroupPermissionsCache();
        }
    });
});
