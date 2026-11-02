// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Access-boundary regression for the Active Streams view (RC kids/permissions
 * round 3, 2026-11-02): `/api/home/active-sessions` listed OTHER users' sessions
 * for titles the viewer could not open (an age-18 movie, a forbidden series'
 * episodes) because the view only applied the library axis and passed
 * `maxAgeRating: null`.
 *
 * The SQL that decides is `filterAccessibleMediaIds` (library + series-owned age
 * rule); the session source is mocked, the media rows are real.
 *
 * Run: npm run test:integration -- src/lib/server/services/active-sessions-view.access.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import type { StreamSession } from '../types.js';

const h = vi.hoisted(() => ({
    sql: undefined as unknown,
    sessions: [] as unknown[],
    keys: [] as string[],
}));

vi.mock('../config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../config.js')>()),
    features: { sessionsPublic: true, sessionsDeviceInfoPublic: true, watchTogether: false },
}));
vi.mock('../auth.js', () => ({ isUserAdmin: () => false }));
vi.mock('../cache/single-flight.js', () => ({
    getOrComputeSingleFlight: async (opts: {
        cacheKey: string;
        compute: () => Promise<string>;
    }) => {
        h.keys.push(opts.cacheKey);
        return opts.compute();
    },
}));
vi.mock('./play-session-device.service.js', () => ({
    prefetchAllDeviceSessions: async () => ({
        byPlaySessionId: new Map(),
        byDeviceUser: new Map(),
    }),
}));
vi.mock('./livetv-active-sessions.service.js', () => ({
    mergeLiveTvSessions: async (s: unknown[]) => s,
}));
vi.mock('./audiobookshelf-direct-sessions.service.js', () => ({
    mergeDirectAudiobookshelfSessions: async (s: unknown[]) => s,
}));
vi.mock('./media-aggregation.service.js', () => ({
    MediaAggregationService: {
        getActiveSessions: async () => ({ sessions: h.sessions, cacheTimestamp: 1 }),
    },
}));
vi.mock('./database.service.js', () => ({
    aiDbService: { getSql: async () => h.sql },
}));
vi.mock('../database/connection.js', () => ({ getDb: () => h.sql }));

import { getVisibleActiveSessions, type SessionViewer } from './active-sessions-view.service.js';
import {
    restrictedAccess,
    unrestrictedAccess,
} from '../database/queries/builders/media-access-boundary.js';

let sql: postgres.Sql;

const DENIED_GROUP = randomUUID();
const ids = {
    movie6: randomUUID(),
    movie18: randomUUID(),
    deniedGroupMovie: randomUUID(),
    series18: randomUUID(),
    season18: randomUUID(),
    episode18: randomUUID(),
    // Series rated 0 whose episode row carries a raw 18: the series rating wins.
    series0: randomUUID(),
    season0: randomUUID(),
    episode0Raw18: randomUUID(),
};

async function seedMovie(id: string, title: string, age: number | null, group: string | null) {
    await sql`INSERT INTO media_items (id, title, media_type, status, has_files, age_rating, year)
              VALUES (${id}::uuid, ${title}, 'movie', 'active', true, ${age}, 2020)`;
    const fileId = randomUUID();
    await sql`INSERT INTO media_files (id, file_path, library_group_id)
              VALUES (${fileId}::uuid, ${`/data/${title}.mkv`}, ${group}::uuid)`;
    await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${fileId}::uuid, ${id}::uuid)`;
}

function session(
    username: string,
    userId: string,
    mediaItemId: string,
    mediaType = 'movie',
): StreamSession {
    return {
        mediaItemId,
        mediaType,
        username,
        userId,
        title: `title-${mediaItemId}`,
        playSessionId: `ps-${username}-${mediaItemId}`,
        deviceId: `dev-${username}`,
    } as unknown as StreamSession;
}

const KID_ID = randomUUID();
const ADULT_ID = randomUUID();

const KID_ACCESS = restrictedAccess({ deniedGroupIds: [], maxAgeRating: 6, allowUnrated: false });

function viewer(overrides: Partial<SessionViewer> = {}): SessionViewer {
    return {
        userId: KID_ID,
        username: 'kid',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        access: KID_ACCESS,
        ...overrides,
    };
}

async function visibleItems(v: SessionViewer): Promise<string[]> {
    const result = await getVisibleActiveSessions(v);
    return result.sessions.map((s) => s.mediaItemId).sort();
}

beforeAll(() => {
    sql = getTestDb();
    h.sql = sql;
});
afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.media);
    await sql`INSERT INTO library_groups (id, name) VALUES (${DENIED_GROUP}::uuid, 'Denied')
              ON CONFLICT (id) DO NOTHING`;
    await seedMovie(ids.movie6, 'Movie Six', 6, null);
    await seedMovie(ids.movie18, 'Movie Eighteen', 18, null);
    await seedMovie(ids.deniedGroupMovie, 'Denied Group Movie', 0, DENIED_GROUP);
    await sql`
        INSERT INTO media_items (id, title, media_type, status, parent_id, age_rating, has_files)
        VALUES
          (${ids.series18}::uuid, 'Series 18', 'tv', 'active', NULL, 18, false),
          (${ids.season18}::uuid, 'Season 18', 'season', 'active', ${ids.series18}::uuid, NULL, false),
          (${ids.episode18}::uuid, 'Episode 18', 'episode', 'active', ${ids.season18}::uuid, NULL, true),
          (${ids.series0}::uuid, 'Series 0', 'tv', 'active', NULL, 0, false),
          (${ids.season0}::uuid, 'Season 0', 'season', 'active', ${ids.series0}::uuid, NULL, false),
          (${ids.episode0Raw18}::uuid, 'Episode 0 raw 18', 'episode', 'active', ${ids.season0}::uuid, 18, true)`;
    h.sessions = [
        session('adult', ADULT_ID, ids.movie6),
        session('adult', ADULT_ID, ids.movie18),
        session('adult', ADULT_ID, ids.deniedGroupMovie),
        session('adult', ADULT_ID, ids.episode18, 'episode'),
        session('adult', ADULT_ID, ids.episode0Raw18, 'episode'),
    ];
});

describe('getVisibleActiveSessions: viewer access boundary', () => {
    it('positive control: an unrestricted non-admin sees every session', async () => {
        const all = await visibleItems(viewer({ access: unrestrictedAccess() }));
        expect(all).toEqual(
            [
                ids.movie6,
                ids.movie18,
                ids.deniedGroupMovie,
                ids.episode18,
                ids.episode0Raw18,
            ].sort(),
        );
    });

    it('kid viewer does not see an adult session on an 18 movie or a rating-18 series episode', async () => {
        // allowUnrated false and every fixture rated, so only the age axis is under test.
        const seen = await visibleItems(viewer());
        expect(seen).not.toContain(ids.movie18);
        expect(seen).not.toContain(ids.episode18);
        // 6 and the rating-0 series episode (series rating wins over the raw 18) stay.
        expect(seen).toEqual([ids.movie6, ids.deniedGroupMovie, ids.episode0Raw18].sort());
    });

    it('restricted-library viewer does not see sessions in a denied library group', async () => {
        const access = restrictedAccess({
            deniedGroupIds: [DENIED_GROUP],
            maxAgeRating: null,
            allowUnrated: true,
        });
        const seen = await visibleItems(viewer({ access }));
        expect(seen).not.toContain(ids.deniedGroupMovie);
        expect(seen).toContain(ids.movie18);
    });

    it("the viewer's own session on an item above their limit is still shown", async () => {
        h.sessions = [session('kid', KID_ID, ids.movie18), session('adult', ADULT_ID, ids.movie18)];
        const result = await getVisibleActiveSessions(viewer());
        expect(result.sessions.map((s) => s.username)).toEqual(['kid']);
    });

    it('admin sees everything regardless of the boundary passed', async () => {
        const seen = await visibleItems(
            viewer({ isAdmin: true, userId: ADULT_ID, username: 'root', access: KID_ACCESS }),
        );
        expect(seen).toHaveLength(5);
    });

    it('fails closed: a non-admin caller that supplies no boundary sees no one else', async () => {
        const seen = await visibleItems(viewer({ access: undefined }));
        expect(seen).toEqual([]);
    });

    it('the service-built cache key differs between two kids with different age ceilings', async () => {
        h.keys.length = 0;
        const kid6 = restrictedAccess({ deniedGroupIds: [], maxAgeRating: 6, allowUnrated: false });
        const kid12 = restrictedAccess({
            deniedGroupIds: [],
            maxAgeRating: 12,
            allowUnrated: false,
        });
        await getVisibleActiveSessions(viewer({ access: kid6 }));
        await getVisibleActiveSessions(viewer({ access: kid12 }));
        await getVisibleActiveSessions(viewer({ access: kid6 }));
        expect(h.keys).toHaveLength(3);
        expect(h.keys[0]).not.toBe(h.keys[1]);
        expect(h.keys[0]).toBe(h.keys[2]);
    });
});
