// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Differential access-boundary tests for `personal-stats.service.ts`.
 *
 * `getCompletionStats`, `getFunRecords` and `getTopTitles` now take a REQUIRED
 * {@link MediaAccessBoundary}. Types guarantee the argument ARRIVES; they cannot
 * guarantee it is USED. This module is unusually exposed to that gap because it
 * has NO in-query access predicate at all: every stat query scans
 * `watch_history` unfiltered and the boundary is applied post-hoc in JS via
 * `filterAccessibleMediaIds`, behind a `hasAccessRestrictions` fast path. A
 * dropped argument, an inverted fast-path condition, or a `denyAll` variant
 * falling through a `kind` switch to the permissive branch would all still
 * compile and still return plausible-looking stats.
 *
 * Each surface therefore runs three ways against one fixture:
 *
 *   1. `unrestrictedAccess()`  — POSITIVE CONTROL. Must contain BOTH titles.
 *   2. a restricted boundary   — must be a STRICT SUBSET of (1).
 *   3. `denyAllAccess()`       — must be EMPTY.
 *
 * The positive control is load-bearing: without it, the denyAll assertion would
 * pass just as happily if the fixture were unreachable or the query threw.
 *
 * ## What is deliberately NOT asserted
 *
 * Count equality between (1) and (2) on the non-title fields. Every one of these
 * queries applies its `LIMIT` BEFORE the JS access filter runs
 * (`getCompletionStats` LIMIT 10, `getFunRecords` LIMIT 5, `getTopTitles` LIMIT
 * 10), so a restricted user can legitimately receive a SHORTER list than an
 * unrestricted one rather than the same list with holes. That is pre-existing
 * behaviour and out of scope for this migration; the fixture is kept to two
 * titles per surface so nothing is truncated and the subset relation is exact.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/services/personal-stats-access-boundary.integration.test.ts
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../tests/integration/fixtures/user.fixtures.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

// ---------------------------------------------------------------------------
// Pin the service's getDb() to the harness handle. personal-stats.service reads
// `getDb()` through a getter on every access, so replacing the export is enough.
// ---------------------------------------------------------------------------

const { mockGetTestSql } = vi.hoisted(() => ({ mockGetTestSql: vi.fn() }));

vi.mock('../database/connection.js', async (importActual) => {
    const actual = await importActual<typeof import('../database/connection.js')>();
    return { ...actual, getDb: () => mockGetTestSql() };
});

import { personalStatsService } from './personal-stats.service.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from '../database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '../database/queries/builders/media-access-boundary.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let sql: postgres.Sql;

const ALLOWED_GROUP = randomUUID();
const DENIED_GROUP = randomUUID();

const ALLOWED_TITLE = 'Allowed Group Movie';
const DENIED_TITLE = 'Denied Group Movie';

/** Boundary that hides exactly the DENIED_GROUP movie. */
const RESTRICTED: MediaAccessBoundary = restrictedAccess({
    deniedGroupIds: [DENIED_GROUP],
    maxAgeRating: null,
    allowUnrated: false,
});

/**
 * Insert a movie with one file in the given library group, plus `sessions`
 * watch_history rows for the user.
 *
 * Sessions are seeded at >= 50% completion and >= MIN_SESSION_SECONDS so the row
 * qualifies for all three surfaces at once: the abandoned-content aggregation
 * (getCompletionStats), the rewatch-movies aggregation (getFunRecords, which
 * needs >= 2 sessions at >= 50%), and the top-movies aggregation (getTopTitles).
 */
async function seedWatchedMovie(opts: {
    userId: UserId;
    title: string;
    libraryGroupId: string;
    sessions: number;
    watchSeconds: number;
}): Promise<string> {
    const mediaId = randomUUID();
    const fileId = randomUUID();

    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, age_rating, year)
        VALUES (${mediaId}::uuid, ${opts.title}, 'movie', 'active', true, NULL, 2020)
    `;
    await sql`
        INSERT INTO media_files (id, file_path, library_group_id)
        VALUES (
            ${fileId}::uuid,
            ${'/data/movies/' + opts.title + '.mkv'},
            ${opts.libraryGroupId}::uuid
        )
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id)
        VALUES (${fileId}::uuid, ${mediaId}::uuid)
    `;

    for (let i = 0; i < opts.sessions; i++) {
        await sql`
            INSERT INTO watch_history (
                user_id, media_id, media_type, title,
                session_start_time, completion_percentage,
                actual_watch_time_seconds, status,
                client_name, device_name
            )
            VALUES (
                ${opts.userId}::uuid, ${mediaId}::uuid, 'movie', ${opts.title},
                NOW() - (${i} || ' hours')::interval, 80,
                ${opts.watchSeconds}, 'completed',
                'TestClient', 'TestDevice'
            )
        `;
    }

    // One extra ABANDONED session. `getCompletionStats`'s abandoned-content
    // aggregation requires `times_started >= 2 AND times_abandoned > 0`, so
    // without this the surface is empty for every boundary and the differential
    // would be vacuous. Kept below 50% completion (so getFunRecords' rewatch
    // HAVING still counts exactly the two completed sessions) and shorter than
    // the completed sessions (so it never wins `longestSession`).
    await sql`
        INSERT INTO watch_history (
            user_id, media_id, media_type, title,
            session_start_time, completion_percentage,
            actual_watch_time_seconds, status,
            client_name, device_name
        )
        VALUES (
            ${opts.userId}::uuid, ${mediaId}::uuid, 'movie', ${opts.title},
            NOW() - interval '1 day', 20,
            ${Math.floor(opts.watchSeconds / 4)}, 'abandoned',
            'TestClient', 'TestDevice'
        )
    `;
    return mediaId;
}

/**
 * A movie started twice and never finished, for the abandoned-content surface.
 * seedWatchedMovie's titles are finished (two completed sessions), and the
 * completion stats count per TITLE: a finished title is never "abandoned",
 * however many abandoned sessions it also has.
 */
async function seedUnfinishedMovie(opts: {
    userId: UserId;
    title: string;
    libraryGroupId: string;
}): Promise<void> {
    const mediaId = randomUUID();
    const fileId = randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, age_rating, year)
        VALUES (${mediaId}::uuid, ${opts.title}, 'movie', 'active', true, NULL, 2020)
    `;
    await sql`
        INSERT INTO media_files (id, file_path, library_group_id)
        VALUES (${fileId}::uuid, ${'/data/movies/' + opts.title + '.mkv'}, ${opts.libraryGroupId}::uuid)
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id)
        VALUES (${fileId}::uuid, ${mediaId}::uuid)
    `;
    for (const [i, pct] of [20, 30].entries()) {
        await sql`
            INSERT INTO watch_history (
                user_id, media_id, media_type, title,
                session_start_time, completion_percentage,
                actual_watch_time_seconds, status, client_name, device_name
            )
            VALUES (
                ${opts.userId}::uuid, ${mediaId}::uuid, 'movie', ${opts.title},
                NOW() - (${i + 2} || ' days')::interval, ${pct},
                600, 'abandoned', 'TestClient', 'TestDevice'
            )
        `;
    }
}

let userId: UserId;

beforeAll(() => {
    sql = getTestDb() as unknown as postgres.Sql;
    mockGetTestSql.mockReturnValue(sql);
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await truncateTables(sql, [
        ...TEST_TABLES.media,
        ...TEST_TABLES.watchStatus,
        ...TEST_TABLES.userData,
    ]);
    await sql`
        INSERT INTO library_groups (id, name)
        VALUES
            (${ALLOWED_GROUP}::uuid, 'Allowed Group'),
            (${DENIED_GROUP}::uuid, 'Denied Group')
        ON CONFLICT (id) DO NOTHING
    `;

    userId = toUserId(randomUUID());
    await ensureTestUser(sql, userId);

    // The DENIED movie is the LONGER session so it also wins getFunRecords'
    // `longestSession` (ORDER BY actual_watch_time_seconds DESC LIMIT 1). That
    // makes the single-row surface discriminating too: an unfiltered caller sees
    // the denied title there, a restricted one must not.
    await seedWatchedMovie({
        userId,
        title: ALLOWED_TITLE,
        libraryGroupId: ALLOWED_GROUP,
        sessions: 2,
        watchSeconds: 3600,
    });
    await seedWatchedMovie({
        userId,
        title: DENIED_TITLE,
        libraryGroupId: DENIED_GROUP,
        sessions: 2,
        watchSeconds: 7200,
    });
});

// ---------------------------------------------------------------------------
// Shared assertion
// ---------------------------------------------------------------------------

/**
 * Run one surface under all three boundaries and assert the differential.
 *
 * @param run     projects the surface to a list of stable title keys
 * @param expectOpen titles the unrestricted caller must see
 * @param expectRestricted titles the restricted caller must see
 */
async function expectDifferential(
    run: (access: MediaAccessBoundary) => Promise<string[]>,
    expectOpen: string[],
    expectRestricted: string[],
): Promise<void> {
    const open = await run(unrestrictedAccess());
    // POSITIVE CONTROL — proves the fixture is reachable and the query ran.
    expect([...open].sort()).toEqual([...expectOpen].sort());

    const narrowed = await run(RESTRICTED);
    expect([...narrowed].sort()).toEqual([...expectRestricted].sort());
    // STRICT SUBSET: every surviving row was visible to the open caller, and at
    // least one row was actually removed. The second half is what fails when the
    // boundary arrives but is never applied.
    for (const t of narrowed) expect(open).toContain(t);
    expect(narrowed.length).toBeLessThan(open.length);

    const denied = await run(denyAllAccess());
    expect(denied).toEqual([]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('personalStatsService access boundary (Integration)', () => {
    it('getCompletionStats filters abandonedContent by the boundary', async () => {
        const allowedUnfinished = `${ALLOWED_TITLE} (unfinished)`;
        const deniedUnfinished = `${DENIED_TITLE} (unfinished)`;
        await seedUnfinishedMovie({
            userId,
            title: allowedUnfinished,
            libraryGroupId: ALLOWED_GROUP,
        });
        await seedUnfinishedMovie({
            userId,
            title: deniedUnfinished,
            libraryGroupId: DENIED_GROUP,
        });
        await expectDifferential(
            async (access) => {
                const stats = await personalStatsService.getCompletionStats(userId, 'all', access);
                return stats.abandonedContent.map((a) => a.title);
            },
            // The seedWatchedMovie titles are finished, so only these two are
            // abandoned — the positive control inside expectDifferential proves it.
            [allowedUnfinished, deniedUnfinished],
            [allowedUnfinished],
        );
    });

    it('getTopTitles filters movies by the boundary', async () => {
        await expectDifferential(
            async (access) => {
                const stats = await personalStatsService.getTopTitles(userId, 'all', access);
                return stats.movies.map((m) => m.title);
            },
            [ALLOWED_TITLE, DENIED_TITLE],
            [ALLOWED_TITLE],
        );
    });

    it('getFunRecords filters mostRewatchedMovies by the boundary', async () => {
        await expectDifferential(
            async (access) => {
                const records = await personalStatsService.getFunRecords(userId, 'all', access);
                return records.mostRewatchedMovies.map((m) => m.title);
            },
            [ALLOWED_TITLE, DENIED_TITLE],
            [ALLOWED_TITLE],
        );
    });

    it('getFunRecords filters the single longestSession row by the boundary', async () => {
        // Single-row surfaces are the easiest place for a filter to be skipped:
        // there is no list to look short, so an unapplied boundary just surfaces
        // the restricted title silently.
        const open = await personalStatsService.getFunRecords(userId, 'all', unrestrictedAccess());
        expect(open.longestSession?.title).toBe(DENIED_TITLE);

        const narrowed = await personalStatsService.getFunRecords(userId, 'all', RESTRICTED);
        expect(narrowed.longestSession).toBeUndefined();

        const denied = await personalStatsService.getFunRecords(userId, 'all', denyAllAccess());
        expect(denied.longestSession).toBeUndefined();
    });

    it('applies the age axis independently of the library axis', async () => {
        // The two axes are separate fields on the boundary and are consumed by
        // separate SQL fragments in filterAccessibleMediaIds. Exercise the age
        // axis alone so a library-only implementation cannot pass the suite.
        await sql`
            UPDATE media_items SET age_rating = 18 WHERE title = ${DENIED_TITLE}
        `;
        await sql`
            UPDATE media_items SET age_rating = 6 WHERE title = ${ALLOWED_TITLE}
        `;

        await expectDifferential(
            async (access) => {
                const stats = await personalStatsService.getTopTitles(userId, 'all', access);
                return stats.movies.map((m) => m.title);
            },
            [ALLOWED_TITLE, DENIED_TITLE],
            [ALLOWED_TITLE],
        );
    });

    it('getAllStats partitions its cache by the boundary fingerprint', async () => {
        // The module's sharpest failure mode is not a missing filter but a
        // COLLIDING cache key: compute unrestricted, cache it under the empty
        // fingerprint, then serve that entry to a restricted caller. Drive both
        // boundaries through the real getAllStats cache path, unrestricted first,
        // and assert the restricted read is not the warm unrestricted entry.
        const store = new Map<string, unknown>();
        const statsCache = {
            get: async (key: string, scope?: string) => store.get(`${scope ?? ''}:${key}`) ?? null,
            set: async (key: string, value: unknown, _ttl?: number, scope?: string) => {
                store.set(`${scope ?? ''}:${key}`, value);
            },
        } as unknown as Parameters<typeof personalStatsService.getAllStats>[3];

        const open = await personalStatsService.getAllStats(
            userId,
            'all',
            'personalStats',
            statsCache,
            unrestrictedAccess(),
        );
        const narrowed = await personalStatsService.getAllStats(
            userId,
            'all',
            'personalStats',
            statsCache,
            RESTRICTED,
        );
        const denied = await personalStatsService.getAllStats(
            userId,
            'all',
            'personalStats',
            statsCache,
            denyAllAccess(),
        );

        const titlesOf = (r: {
            stats: { topTitles?: { movies: { title: string }[] } };
        }): string[] => (r.stats.topTitles?.movies ?? []).map((m) => m.title);

        expect(titlesOf(open).sort()).toEqual([ALLOWED_TITLE, DENIED_TITLE].sort());
        expect(titlesOf(narrowed)).toEqual([ALLOWED_TITLE]);
        expect(titlesOf(denied)).toEqual([]);
    });
});
