// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/integrations/watch-history — the payload builder against a real
 * database: ordering, keyset pagination, the 2026-03-31 bulk-import artefact, the
 * target user's age boundary, genres, counts and the unknown-user outcome.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    __resetWatchHistoryCacheForTests,
    getIntegrationWatchHistory,
    InvalidWatchHistoryCursorError,
} from './integration-watch-history.service.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';
import type { WatchHistoryResponse } from '$lib/schemas/api-watch-history-integration-responses.js';

const ALICE = '7a000000-0000-4000-8000-00000000a001';
const BOB = '7a000000-0000-4000-8000-00000000a002';
const DELETED_USER = '7a000000-0000-4000-8000-00000000a003';

const M = {
    arrival: '7a000000-0000-4000-8000-000000000101',
    artefact: '7a000000-0000-4000-8000-000000000102',
    mixed: '7a000000-0000-4000-8000-000000000103',
    adult: '7a000000-0000-4000-8000-000000000104',
    show: '7a000000-0000-4000-8000-000000000201',
    season: '7a000000-0000-4000-8000-000000000202',
    ep1: '7a000000-0000-4000-8000-000000000203',
    ep2: '7a000000-0000-4000-8000-000000000204',
    book: '7a000000-0000-4000-8000-000000000301',
    track: '7a000000-0000-4000-8000-000000000401',
};
const ALL_MEDIA = Object.values(M);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// One shared test pool for both describe blocks below.
afterAll(async () => {
    await closeTestDb();
});

describe('getIntegrationWatchHistory', () => {
    let sql: postgres.Sql;
    const now = Date.now();
    const ago = (ms: number): Date => new Date(now - ms);

    async function fetch(
        user: string,
        params: Partial<{ limit: number; cursor: string; days: number }> = {},
    ): Promise<WatchHistoryResponse> {
        const res = await getIntegrationWatchHistory(sql, user, {
            limit: params.limit ?? 50,
            cursor: params.cursor,
            days: params.days ?? 180,
        });
        if (!res.ok) throw new Error(`unexpected ${res.reason}`);
        return res.value;
    }

    beforeAll(async () => {
        sql = getTestDb();
        await sql`DELETE FROM users WHERE id IN (${ALICE}, ${BOB}, ${DELETED_USER})`;
        await sql`DELETE FROM media_items WHERE id = ANY(${ALL_MEDIA}::uuid[])`;
        await sql`
            INSERT INTO users (id, username, display_name, groups, max_age_rating, deleted_at)
            VALUES
                (${ALICE}, 'wh_alice', 'Alice', ${['household']}, 12, NULL),
                (${BOB}, 'wh_bob', NULL, ${['household']}, NULL, NULL),
                (${DELETED_USER}, 'wh_gone', NULL, ${[]}, NULL, now())
        `;
        await sql`
            INSERT INTO media_items
                (id, title, media_type, parent_id, has_files, status, year, runtime_seconds,
                 season_number, episode_number, age_rating)
            VALUES
                (${M.arrival},  'Awakening',       'movie',     NULL,       true, 'active', 2016, 6960, NULL, NULL, 12),
                (${M.artefact}, 'Bulk Movie',    'movie',     NULL,       true, 'active', 1998, 5400, NULL, NULL, 12),
                (${M.mixed},    'Mixed Movie',   'movie',     NULL,       true, 'active', 2001, 5400, NULL, NULL, 12),
                (${M.adult},    'Adult Movie',   'movie',     NULL,       true, 'active', 2010, 5400, NULL, NULL, 18),
                (${M.show},     'Dark',          'tv',        NULL,       true, 'active', 2017, NULL, NULL, NULL, 12),
                (${M.season},   'Season 1',      'season',    ${M.show},  true, 'active', NULL, NULL, 1,    NULL, 12),
                (${M.ep1},      'Secrets',       'episode',   ${M.season}, true, 'active', NULL, 3600, 1,   1,    12),
                (${M.ep2},      'Lies',          'episode',   ${M.season}, true, 'active', NULL, 3600, 1,   2,    12),
                (${M.book},     'Long Book',     'audiobook', NULL,       true, 'active', 2020, 36000, NULL, NULL, 12),
                (${M.track},    'Song',          'track',     NULL,       true, 'active', NULL, 200, NULL, NULL, NULL)
        `;
        // Alice is age-restricted (12) and unrated items stay hidden for her by default,
        // so every listable item carries a rating; Adult Movie (18) is above her ceiling.
        // Same genre under two provider sources must surface once.
        await sql`
            INSERT INTO media_genres (media_id, source, genre_id, genre_name)
            VALUES
                (${M.arrival}, 'tmdb', 18, 'Drama'),
                (${M.arrival}, 'aggregated', 18, 'Drama'),
                (${M.arrival}, 'tmdb', 878, 'Science Fiction'),
                (${M.show}, 'tmdb', 18, 'Drama'),
                (${M.show}, 'tmdb', 9648, NULL),
                (${M.artefact}, 'tmdb', 16, 'Animation')
        `;
    });

    beforeEach(async () => {
        __resetWatchHistoryCacheForTests();
        await sql`DELETE FROM user_media_state WHERE user_id IN (${ALICE}, ${BOB})`;
        await sql`DELETE FROM music_listen_events WHERE user_id IN (${ALICE}, ${BOB})`;
        const artefactTs = new Date('2026-03-31T19:00:00.000Z');
        const artefactLate = new Date('2026-03-31T22:59:59.000Z');
        const genuineFeb = new Date('2026-02-10T20:15:00.000Z');
        await sql`
            INSERT INTO user_media_state
                (user_id, media_id, is_watched, resume_position_ms, runtime_ms, watch_count,
                 last_watched_at, last_event_at)
            VALUES
                (${ALICE}, ${M.arrival},  true,  0,         6960000,  1, ${ago(DAY)},      ${ago(DAY)}),
                -- bulk import: both stamps inside the 03-31 window → unknown
                (${ALICE}, ${M.artefact}, true,  0,         5400000,  1, ${artefactTs},    ${artefactLate}),
                -- genuine LastPlayedDate next to an import-time last_event_at
                (${ALICE}, ${M.mixed},    true,  0,         5400000,  1, ${genuineFeb},    ${artefactTs}),
                -- above Alice's age ceiling: never listed or counted
                (${ALICE}, ${M.adult},    true,  0,         5400000,  1, ${ago(HOUR)},     ${ago(HOUR)}),
                (${ALICE}, ${M.ep1},      true,  0,         3600000,  1, ${ago(2 * DAY)},  ${ago(2 * DAY)}),
                (${ALICE}, ${M.ep2},      false, 1800000,   3600000,  0, NULL,             ${ago(HOUR)}),
                (${ALICE}, ${M.book},     true,  0,         36000000, 1, ${ago(3 * DAY)},  ${ago(3 * DAY)})
        `;
        await sql`
            INSERT INTO music_listen_events (user_id, track_id, started_at, created_at, duration_ms)
            VALUES
                (${ALICE}, ${M.track}, ${ago(DAY)}, ${ago(DAY)}, 30000),
                (${ALICE}, ${M.track}, ${ago(2 * DAY)}, ${ago(2 * DAY)}, 30000),
                (${ALICE}, ${M.track}, ${ago(400 * DAY)}, ${ago(400 * DAY)}, 30000)
        `;
    });

    afterAll(async () => {
        await sql`DELETE FROM user_media_state WHERE user_id IN (${ALICE}, ${BOB})`;
        await sql`DELETE FROM music_listen_events WHERE user_id IN (${ALICE}, ${BOB})`;
        await sql`DELETE FROM media_items WHERE id = ANY(${ALL_MEDIA}::uuid[])`;
        await sql`DELETE FROM users WHERE id IN (${ALICE}, ${BOB}, ${DELETED_USER})`;
    });

    it('lists dated history newest first and bulk-import (03-31) stamps last as unknown', async () => {
        const res = await fetch('wh_alice');
        const items = res.recentlyWatched.items;
        expect(items.map((i) => i.id)).toEqual([
            M.ep2,
            M.arrival,
            M.ep1,
            M.book,
            M.mixed,
            M.artefact,
        ]);
        expect(res.recentlyWatched.page).toEqual({ limit: 50, hasMore: false });

        const byId = new Map(items.map((i) => [i.id, i]));
        expect(byId.get(M.artefact)!.lastWatchedAt).toBeNull();
        // The genuine Feb date survives; the import-time last_event_at is ignored.
        expect(byId.get(M.mixed)!.lastWatchedAt).toBe('2026-02-10T20:15:00.000Z');
        expect(items.some((i) => i.lastWatchedAt?.startsWith('2026-03-31'))).toBe(false);
    });

    it('maps movies, episodes and audiobooks with series context, genres and progress', async () => {
        const res = await fetch('wh_alice');
        const byId = new Map(res.recentlyWatched.items.map((i) => [i.id, i]));

        expect(byId.get(M.arrival)).toMatchObject({
            type: 'movie',
            title: 'Awakening',
            year: 2016,
            genres: ['Drama', 'Science Fiction'],
            series: null,
            seasonNumber: null,
            episodeNumber: null,
            progressPercent: 100,
            completed: true,
        });
        expect(byId.get(M.ep2)).toMatchObject({
            type: 'episode',
            title: 'Lies',
            year: 2017,
            series: { id: M.show, title: 'Dark', year: 2017 },
            seasonNumber: 1,
            episodeNumber: 2,
            progressPercent: 50,
            completed: false,
        });
        // Episode genres come from the series; an unnamed id resolves via the TMDB table.
        expect(byId.get(M.ep2)!.genres).toEqual(['Drama', 'Mystery']);
        expect(byId.get(M.book)).toMatchObject({ type: 'audiobook', completed: true });
    });

    it("applies the target user's age ceiling", async () => {
        const res = await fetch('wh_alice');
        expect(res.recentlyWatched.items.map((i) => i.id)).not.toContain(M.adult);
        expect(res.stats.moviesWatched).toBe(3);
    });

    it('pages with an opaque cursor through dated and undated rows without gaps', async () => {
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
            const res = await fetch('wh_alice', { limit: 2, cursor });
            seen.push(...res.recentlyWatched.items.map((i) => i.id));
            expect(res.recentlyWatched.page.limit).toBe(2);
            cursor = res.recentlyWatched.page.nextCursor;
            expect(res.recentlyWatched.page.hasMore).toBe(cursor !== undefined);
            pages++;
        } while (cursor && pages < 10);
        expect(pages).toBe(3);
        expect(seen).toEqual([M.ep2, M.arrival, M.ep1, M.book, M.mixed, M.artefact]);
    });

    it('returns the Continue Watching row with the in-progress episode', async () => {
        const res = await fetch('wh_alice');
        expect(res.continueWatching.map((i) => i.id)).toEqual([M.ep2]);
        expect(res.continueWatching[0]).toMatchObject({
            type: 'episode',
            series: { id: M.show, title: 'Dark', year: 2017 },
            progressPercent: 50,
            completed: false,
        });
    });

    it('ranks top genres per title over the window, ignoring undated items', async () => {
        const res = await fetch('wh_alice');
        expect(res.topGenres).toEqual({
            days: 180,
            genres: [
                { name: 'Drama', titles: 2 },
                // ties by name
                { name: 'Mystery', titles: 1 },
                { name: 'Science Fiction', titles: 1 },
            ],
        });
        // Animation only sits on the bulk-imported movie.
        expect(res.topGenres.genres.map((g) => g.name)).not.toContain('Animation');
    });

    it('counts history', async () => {
        const res = await fetch('wh_alice');
        expect(res.stats).toEqual({
            moviesWatched: 3,
            episodesWatched: 1,
            seriesWatched: 1,
            audiobooksFinished: 1,
            inProgress: 1,
            activeInWindow: 4,
            undated: 1,
            tracksPlayedInWindow: 2,
        });
        expect(res.user).toEqual({ id: ALICE, username: 'wh_alice', displayName: 'Alice' });
    });

    it('serves an empty, well-formed payload for a user without history', async () => {
        const res = await fetch('wh_bob');
        expect(res.recentlyWatched).toEqual({ items: [], page: { limit: 50, hasMore: false } });
        expect(res.continueWatching).toEqual([]);
        expect(res.topGenres.genres).toEqual([]);
        expect(Object.values(res.stats).every((n) => n === 0)).toBe(true);
    });

    it('resolves the user case-insensitively or by UUID', async () => {
        expect((await fetch('WH_Alice')).user.id).toBe(ALICE);
        expect((await fetch(ALICE)).user.username).toBe('wh_alice');
    });

    it('reports unknown and deleted users as not found', async () => {
        for (const who of ['wh_nobody', 'wh_gone', '7a000000-0000-4000-8000-0000000000ff']) {
            const res = await getIntegrationWatchHistory(sql, who, {
                limit: 50,
                cursor: undefined,
                days: 180,
            });
            expect(res).toEqual({ ok: false, reason: 'user_not_found' });
        }
    });

    it('rejects a cursor it did not mint', async () => {
        await expect(
            getIntegrationWatchHistory(sql, 'wh_alice', {
                limit: 5,
                cursor: 'not-a-cursor',
                days: 180,
            }),
        ).rejects.toBeInstanceOf(InvalidWatchHistoryCursorError);
    });

    it('caches a payload for 60 s per user and page', async () => {
        const first = await fetch('wh_alice');
        await sql`DELETE FROM user_media_state WHERE user_id = ${ALICE} AND media_id = ${M.arrival}`;
        const second = await fetch('wh_alice');
        expect(second.generatedAt).toBe(first.generatedAt);
        expect(second.recentlyWatched.items.map((i) => i.id)).toContain(M.arrival);
        // A different page size is a different entry, built fresh.
        const other = await fetch('wh_alice', { limit: 10 });
        expect(other.recentlyWatched.items.map((i) => i.id)).not.toContain(M.arrival);
    });
});

/**
 * Second fixture set: the edges the first block does not reach — window bounds, equal
 * timestamps across a page break, unrated items, library-group denial, username
 * ambiguity, cache expiry and per-user cache isolation.
 */
describe('getIntegrationWatchHistory — edges', () => {
    let sql: postgres.Sql;
    const now = Date.now();

    const CAROL = '7b000000-0000-4000-8000-00000000c001'; // unrestricted, groups: household
    const DAVE = '7b000000-0000-4000-8000-00000000c002'; // age 12
    const ERIN = '7b000000-0000-4000-8000-00000000c003'; // admin
    const DUP_A = '7b000000-0000-4000-8000-00000000c004';
    const DUP_B = '7b000000-0000-4000-8000-00000000c005';
    const UUIDNAME = '7b000000-0000-4000-8000-00000000c006';
    const USERS = [CAROL, DAVE, ERIN, DUP_A, DUP_B, UUIDNAME];
    const UUID_SHAPED_NAME = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    const GROUP = '7b000000-0000-4000-8000-00000000a001';
    const FILE = '7b000000-0000-4000-8000-00000000f001';
    const E = {
        before: '7b000000-0000-4000-8000-000000000101', // 16:59:59.999 → dated
        start: '7b000000-0000-4000-8000-000000000102', // 17:00:00.000 → unknown
        end: '7b000000-0000-4000-8000-000000000103', // 23:00:00.000 → dated
        nextDay: '7b000000-0000-4000-8000-000000000104', // 04-01 19:00 → dated
        tieA: '7b000000-0000-4000-8000-000000000201',
        tieB: '7b000000-0000-4000-8000-000000000202',
        unrated: '7b000000-0000-4000-8000-000000000301',
        locked: '7b000000-0000-4000-8000-000000000401',
    };
    const MEDIA = Object.values(E);
    const tieTs = new Date(now - 5 * DAY);

    async function ids(user: string, limit = 50): Promise<string[]> {
        const out: string[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 20; i++) {
            const res = await getIntegrationWatchHistory(sql, user, { limit, cursor, days: 180 });
            if (!res.ok) throw new Error(res.reason);
            out.push(...res.value.recentlyWatched.items.map((x) => x.id));
            cursor = res.value.recentlyWatched.page.nextCursor;
            if (!cursor) break;
        }
        return out;
    }

    beforeAll(async () => {
        sql = getTestDb();
        await sql`DELETE FROM media_files WHERE id = ${FILE}`;
        await sql`DELETE FROM media_items WHERE id = ANY(${MEDIA}::uuid[])`;
        await sql`DELETE FROM library_group_permissions WHERE library_group_id = ${GROUP}`;
        await sql`DELETE FROM library_groups WHERE id = ${GROUP}`;
        await sql`DELETE FROM users WHERE id = ANY(${USERS}::uuid[])`;
        await sql`
            INSERT INTO users (id, username, groups, max_age_rating, is_admin)
            VALUES
                (${CAROL}, 'wh_carol', ${['household']}, NULL, false),
                (${DAVE}, 'wh_dave', ${['household']}, 12, false),
                (${ERIN}, 'wh_erin', ${['household']}, NULL, true),
                (${DUP_A}, 'WH_Twin', ${[]}, NULL, false),
                (${DUP_B}, 'wh_twin', ${[]}, NULL, false),
                (${UUIDNAME}, ${UUID_SHAPED_NAME}, ${[]}, NULL, false)
        `;
        await sql`INSERT INTO library_groups (id, name) VALUES (${GROUP}, 'WH VIP library')`;
        await sql`
            INSERT INTO library_group_permissions (library_group_id, allowed_groups)
            VALUES (${GROUP}, ${['vip']})`;
        await sql`
            INSERT INTO media_items (id, title, media_type, has_files, status, year, age_rating, library_group_id)
            VALUES
                (${E.before},  'Edge Before', 'movie', true, 'active', 2000, 12, NULL),
                (${E.start},   'Edge Start',  'movie', true, 'active', 2000, 12, NULL),
                (${E.end},     'Edge End',    'movie', true, 'active', 2000, 12, NULL),
                (${E.nextDay}, 'Next Day',    'movie', true, 'active', 2000, 12, NULL),
                (${E.tieA},    'Tie A',       'movie', true, 'active', 2000, 12, NULL),
                (${E.tieB},    'Tie B',       'movie', true, 'active', 2000, 12, NULL),
                (${E.unrated}, 'Unrated',     'movie', true, 'active', 2000, NULL, NULL),
                (${E.locked},  'Locked',      'movie', true, 'active', 2000, 12, ${GROUP})
        `;
        await sql`
            INSERT INTO media_files (id, file_path, library_group_id)
            VALUES (${FILE}, '/data/vip/locked.mkv', ${GROUP})`;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id) VALUES (${FILE}, ${E.locked})`;
        invalidateLibraryGroupPermissionsCache();
    });

    beforeEach(async () => {
        __resetWatchHistoryCacheForTests();
        await sql`DELETE FROM user_media_state WHERE user_id = ANY(${USERS}::uuid[])`;
        const rows: Array<[string, string, Date]> = [];
        for (const u of [CAROL, DAVE, ERIN]) {
            rows.push(
                [u, E.before, new Date('2026-03-31T16:59:59.999Z')],
                [u, E.start, new Date('2026-03-31T17:00:00.000Z')],
                [u, E.end, new Date('2026-03-31T23:00:00.000Z')],
                [u, E.nextDay, new Date('2026-04-01T19:00:00.000Z')],
                [u, E.tieA, tieTs],
                [u, E.tieB, tieTs],
                [u, E.unrated, new Date(now - 6 * DAY)],
                [u, E.locked, new Date(now - 7 * DAY)],
            );
        }
        for (const [u, m, ts] of rows) {
            await sql`
                INSERT INTO user_media_state
                    (user_id, media_id, is_watched, resume_position_ms, runtime_ms, watch_count,
                     last_watched_at, last_event_at)
                VALUES (${u}, ${m}, true, 0, 5400000, 1, ${ts}, ${ts})`;
        }
    });

    afterAll(async () => {
        await sql`DELETE FROM user_media_state WHERE user_id = ANY(${USERS}::uuid[])`;
        await sql`DELETE FROM media_files WHERE id = ${FILE}`;
        await sql`DELETE FROM media_items WHERE id = ANY(${MEDIA}::uuid[])`;
        await sql`DELETE FROM library_group_permissions WHERE library_group_id = ${GROUP}`;
        await sql`DELETE FROM library_groups WHERE id = ${GROUP}`;
        await sql`DELETE FROM users WHERE id = ANY(${USERS}::uuid[])`;
        invalidateLibraryGroupPermissionsCache();
    });

    it('nulls exactly the half-open [17:00, 23:00) UTC window of 2026-03-31', async () => {
        const res = await getIntegrationWatchHistory(sql, 'wh_carol', {
            limit: 50,
            cursor: undefined,
            days: 3650,
        });
        if (!res.ok) throw new Error(res.reason);
        const at = new Map(res.value.recentlyWatched.items.map((i) => [i.id, i.lastWatchedAt]));
        expect(at.get(E.before)).toBe('2026-03-31T16:59:59.999Z');
        expect(at.get(E.start)).toBeNull();
        expect(at.get(E.end)).toBe('2026-03-31T23:00:00.000Z');
        expect(at.get(E.nextDay)).toBe('2026-04-01T19:00:00.000Z');
    });

    it('pages across equal timestamps and into undated rows without loss or repeats', async () => {
        const all = await ids('wh_carol', 50);
        for (const limit of [1, 2, 3]) {
            expect(await ids('wh_carol', limit)).toEqual(all);
        }
        // Ties ordered by media id; the undated row last.
        expect(all.indexOf(E.tieA)).toBe(all.indexOf(E.tieB) - 1);
        expect(all.at(-1)).toBe(E.start);
        expect(new Set(all).size).toBe(all.length);
    });

    it('hides a library the target user may not open, and shows it to an admin', async () => {
        expect(await ids('wh_carol')).not.toContain(E.locked);
        expect(await ids('wh_erin')).toContain(E.locked);
    });

    it('applies UNRATED_CONTENT_VISIBLE to an age-restricted user only', async () => {
        const { config } = await import('$lib/server/config.js');
        expect(await ids('wh_carol')).toContain(E.unrated);
        expect((await ids('wh_dave')).includes(E.unrated)).toBe(config.UNRATED_CONTENT_VISIBLE);
    });

    it('reports a case-only username clash as ambiguous, but honours an exact match', async () => {
        const res = await getIntegrationWatchHistory(sql, 'Wh_TWIN', {
            limit: 5,
            cursor: undefined,
            days: 180,
        });
        expect(res).toEqual({ ok: false, reason: 'user_ambiguous' });
        const exact = await getIntegrationWatchHistory(sql, 'wh_twin', {
            limit: 5,
            cursor: undefined,
            days: 180,
        });
        expect(exact.ok && exact.value.user.id).toBe(DUP_B);
    });

    it('finds a user whose username is UUID-shaped', async () => {
        const res = await getIntegrationWatchHistory(sql, UUID_SHAPED_NAME, {
            limit: 5,
            cursor: undefined,
            days: 180,
        });
        expect(res.ok && res.value.user.id).toBe(UUIDNAME);
    });

    it('rejects forged cursor timestamps with InvalidWatchHistoryCursorError', async () => {
        const forge = (t: unknown): string =>
            Buffer.from(JSON.stringify({ t, id: E.tieA })).toString('base64url');
        for (const t of ['+275760-09-13T00:00:00.000Z', '2020', '2026-01-01T00:00:00Z', 42]) {
            await expect(
                getIntegrationWatchHistory(sql, 'wh_carol', {
                    limit: 5,
                    cursor: forge(t),
                    days: 180,
                }),
            ).rejects.toBeInstanceOf(InvalidWatchHistoryCursorError);
        }
    });

    it('keeps cache entries per user and rebuilds after 60 s', async () => {
        const first = await ids('wh_carol');
        expect(await ids('wh_erin')).toContain(E.locked); // other user, own entry
        await sql`DELETE FROM user_media_state WHERE user_id = ${CAROL} AND media_id = ${E.tieA}`;
        expect(await ids('wh_carol')).toEqual(first); // still cached

        const realNow = Date.now;
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);
        try {
            expect(await ids('wh_carol')).not.toContain(E.tieA);
        } finally {
            spy.mockRestore();
        }
    });
});
