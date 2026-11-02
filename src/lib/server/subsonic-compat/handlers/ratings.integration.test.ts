// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subsonic Ratings Handlers — Integration Tests
 *
 * Covers star / unstar / setRating / scrobble / getStarred / getStarred2
 * against a real PostgreSQL test database.
 *
 * Run:
 *   npm run test:integration -- src/lib/server/subsonic-compat/handlers/ratings.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import type { RequestEvent } from '@sveltejs/kit';
import type { SubsonicAuthContext } from '$lib/server/subsonic-compat/types.js';

import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { createAndInsertTestMusicHierarchy } from '../../../../../tests/integration/fixtures/music.fixtures.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLogger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLogger),
    },
}));

const mockMusicInteractionManager = vi.hoisted(() => ({
    complete: vi.fn().mockResolvedValue(undefined),
    recordPlayEnd: vi.fn().mockResolvedValue(undefined),
    recordExternalPlayEnd: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    reportPlayStart: vi.fn(),
}));

vi.mock('$lib/server/services/music-interaction-manager.service.js', () => ({
    musicInteractionManager: mockMusicInteractionManager,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// users.id UUIDs (mig 16.46.0 — user_id columns are now uuid)
const TEST_USER: UserId = toUserId(randomUUID());
const TEST_USER_RESTRICTED: UserId = toUserId(randomUUID());

function buildMockEvent(params: Record<string, string> = {}): RequestEvent {
    const url = new URL('http://localhost/rest/ratings');
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }
    return {
        url,
        request: new Request(url.toString()),
        locals: { subsonicBodyParams: new URLSearchParams() },
        params: {},
        route: { id: '/rest/ratings' as const },
        cookies: {} as RequestEvent['cookies'],
        fetch: globalThis.fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => {},
    } as unknown as RequestEvent;
}

function buildAuth(overrides: Partial<SubsonicAuthContext> = {}): SubsonicAuthContext {
    return {
        // userId is the UUID (users.id); ratings handler now uses auth.userId for DB writes.
        userId: TEST_USER,
        username: TEST_USER,
        ownerIsAdmin: false,
        displayName: null,
        clientName: 'integration-test',
        format: 'json',
        userGroups: [],
        maxAgeRating: null,
        isAgeRestricted: false,
        ...overrides,
    };
}

async function parseJson<T>(response: Response): Promise<T> {
    return response.json() as Promise<T>;
}

interface SubsonicResponse<T> {
    status: string;
    starred?: T;
    starred2?: T;
    error?: { code: number; message: string };
}

interface SubsonicEnvelope<T> {
    'subsonic-response': T;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Subsonic ratings handlers', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        await sql`SELECT 1`;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        vi.clearAllMocks();
        mockMusicInteractionManager.reportPlayStart.mockImplementation(
            async (userId, trackId, _context, db) => {
                const { recordPlayStart } =
                    await import('$lib/server/database/queries/music-tracking.queries.js');
                await recordPlayStart(db, userId, trackId);
            },
        );

        // Clean up user data by UUID (mig 16.46.0 — user_id columns are now uuid).
        const testUserIds = [TEST_USER, TEST_USER_RESTRICTED];
        await sql`DELETE FROM user_ratings WHERE user_id = ANY(${testUserIds}::uuid[])`;
        await sql`DELETE FROM user_music_state WHERE user_id = ANY(${testUserIds}::uuid[])`;
        await sql`DELETE FROM play_sessions WHERE user_id = ANY(${testUserIds}::uuid[])`;
        await sql`DELETE FROM user_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
        await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;

        // Clean up media created by this suite (prefix not guaranteed, so
        // truncate the whole media hierarchy — fast and safe in test DB).
        await sql`
            DELETE FROM media_file_items
            WHERE media_item_id IN (
                SELECT id FROM media_items
                WHERE title LIKE 'Ratings Test%'
            )
        `;
        await sql`
            DELETE FROM media_files
            WHERE file_path LIKE '/test/music/ratings-test-%'
        `;
        await sql`DELETE FROM media_items WHERE title LIKE 'Ratings Test%'`;
    });

    // -----------------------------------------------------------------------
    // 1. handleStar on track → appears in getStarred song array
    // -----------------------------------------------------------------------
    it('handleStar stars a track and handleGetStarred returns it in the song array', async () => {
        const { handleStar, handleGetStarred } =
            await import('$lib/server/subsonic-compat/handlers/ratings.js');

        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Ratings Test Artist 1',
            albumTitle: 'Ratings Test Album 1',
            trackCount: 1,
        });
        const trackId = trackIds[0];

        await ensureTestUser(sql, TEST_USER);

        const starEvent = buildMockEvent({ id: trackId });
        const starResp = await handleStar(starEvent, buildAuth(), sql);
        expect(starResp.status).toBe(200);

        const getResp = await handleGetStarred(buildMockEvent(), buildAuth(), sql);
        const json = (
            await parseJson<SubsonicEnvelope<SubsonicResponse<{ song?: unknown[] }>>>(getResp)
        )['subsonic-response'];
        expect(json.status).toBe('ok');
        expect(json.starred?.song?.length).toBe(1);
        expect(json.starred?.song?.[0]).toMatchObject({ id: trackId });
    });

    // -----------------------------------------------------------------------
    // 2. handleStar on album → appears in getStarred2 album array
    // -----------------------------------------------------------------------
    it('handleStar on an album and handleGetStarred2 returns it in album array', async () => {
        const { handleStar, handleGetStarred2 } =
            await import('$lib/server/subsonic-compat/handlers/ratings.js');

        const { albumId } = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Ratings Test Artist 2',
            albumTitle: 'Ratings Test Album 2',
            trackCount: 1,
        });
        await sql`UPDATE media_items SET has_files = true WHERE id = ${albumId}::uuid`;

        await ensureTestUser(sql, TEST_USER);

        const starEvent = buildMockEvent({ albumId });
        const starResp = await handleStar(starEvent, buildAuth(), sql);
        expect(starResp.status).toBe(200);

        const getResp = await handleGetStarred2(buildMockEvent(), buildAuth(), sql);
        const json = (
            await parseJson<SubsonicEnvelope<SubsonicResponse<{ album?: unknown[] }>>>(getResp)
        )['subsonic-response'];
        expect(json.status).toBe('ok');
        expect(json.starred2?.album?.length).toBe(1);
        expect(json.starred2?.album?.[0]).toMatchObject({ id: albumId });
    });

    // -----------------------------------------------------------------------
    // 2b. A starred album whose track files are gone is no longer listed
    // -----------------------------------------------------------------------
    it('starred lists drop an album with no playable track left', async () => {
        const { handleStar, handleGetStarred2 } =
            await import('$lib/server/subsonic-compat/handlers/ratings.js');
        const { handleGetAlbumList2 } =
            await import('$lib/server/subsonic-compat/handlers/browse.js');

        const { albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Ratings Test Artist 2b',
            albumTitle: 'Ratings Test Album 2b',
            trackCount: 1,
        });
        await ensureTestUser(sql, TEST_USER);
        await handleStar(buildMockEvent({ albumId }), buildAuth(), sql);
        await sql`DELETE FROM media_file_items WHERE media_item_id = ANY(${trackIds}::uuid[])`;

        const starred = (
            await parseJson<SubsonicEnvelope<SubsonicResponse<{ album?: { id: string }[] }>>>(
                await handleGetStarred2(buildMockEvent(), buildAuth(), sql),
            )
        )['subsonic-response'];
        expect(starred.starred2?.album?.some((a) => a.id === albumId) ?? false).toBe(false);

        const list = (
            await parseJson<SubsonicEnvelope<{ albumList2?: { album?: { id: string }[] } }>>(
                await handleGetAlbumList2(
                    buildMockEvent({ type: 'starred', size: '10', offset: '0' }),
                    buildAuth(),
                    sql,
                ),
            )
        )['subsonic-response'];
        expect(list.albumList2?.album?.some((a) => a.id === albumId) ?? false).toBe(false);
    });

    // -----------------------------------------------------------------------
    // 3. handleUnstar removes previously starred track
    // -----------------------------------------------------------------------
    it('handleUnstar removes a previously starred track from getStarred', async () => {
        const { handleStar, handleUnstar, handleGetStarred } =
            await import('$lib/server/subsonic-compat/handlers/ratings.js');

        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Ratings Test Artist 3',
            albumTitle: 'Ratings Test Album 3',
            trackCount: 1,
        });
        const trackId = trackIds[0];

        await ensureTestUser(sql, TEST_USER);

        // Star
        await handleStar(buildMockEvent({ id: trackId }), buildAuth(), sql);

        // Unstar
        const unstarResp = await handleUnstar(buildMockEvent({ id: trackId }), buildAuth(), sql);
        expect(unstarResp.status).toBe(200);

        // Verify gone
        const getResp = await handleGetStarred(buildMockEvent(), buildAuth(), sql);
        const json = (
            await parseJson<SubsonicEnvelope<SubsonicResponse<{ song?: unknown[] }>>>(getResp)
        )['subsonic-response'];
        expect(json.starred?.song?.length ?? 0).toBe(0);
    });

    // -----------------------------------------------------------------------
    // 4. handleSetRating with rating=5 stores internal rating 10
    // -----------------------------------------------------------------------
    it('handleSetRating with rating=5 stores internal rating 10', async () => {
        const { handleSetRating } = await import('$lib/server/subsonic-compat/handlers/ratings.js');

        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Ratings Test Artist 4',
            albumTitle: 'Ratings Test Album 4',
            trackCount: 1,
        });
        const trackId = trackIds[0];

        await ensureTestUser(sql, TEST_USER);

        const resp = await handleSetRating(
            buildMockEvent({ id: trackId, rating: '5' }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);

        const rows = await sql<{ rating: number }[]>`
            SELECT rating FROM user_ratings
            WHERE user_id = ${TEST_USER}::uuid AND media_id = ${trackId}::uuid
        `;
        expect(rows.length).toBe(1);
        expect(rows[0].rating).toBe(10);
    });

    // -----------------------------------------------------------------------
    // 5. handleSetRating with rating=0 deletes the rating
    // -----------------------------------------------------------------------
    it('handleSetRating with rating=0 deletes the rating', async () => {
        const { handleSetRating } = await import('$lib/server/subsonic-compat/handlers/ratings.js');

        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Ratings Test Artist 5',
            albumTitle: 'Ratings Test Album 5',
            trackCount: 1,
        });
        const trackId = trackIds[0];

        await ensureTestUser(sql, TEST_USER);

        // Set first
        await handleSetRating(buildMockEvent({ id: trackId, rating: '5' }), buildAuth(), sql);

        // Now delete with 0
        const resp = await handleSetRating(
            buildMockEvent({ id: trackId, rating: '0' }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);

        const rows = await sql<{ rating: number }[]>`
            SELECT rating FROM user_ratings
            WHERE user_id = ${TEST_USER}::uuid AND media_id = ${trackId}::uuid
        `;
        expect(rows.length).toBe(0);
    });

    // -----------------------------------------------------------------------
    // 6. handleSetRating with invalid rating (e.g. 6) returns error 10
    // -----------------------------------------------------------------------
    it('handleSetRating with invalid rating returns error 10', async () => {
        const { handleSetRating } = await import('$lib/server/subsonic-compat/handlers/ratings.js');

        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Ratings Test Artist 6',
            albumTitle: 'Ratings Test Album 6',
            trackCount: 1,
        });
        const trackId = trackIds[0];

        await ensureTestUser(sql, TEST_USER);

        const resp = await handleSetRating(
            buildMockEvent({ id: trackId, rating: '6' }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);
        const json = (
            await parseJson<SubsonicEnvelope<{ status: string; error?: { code: number } }>>(resp)
        )['subsonic-response'];
        expect(json.status).toBe('failed');
        expect(json.error?.code).toBe(10);
    });

    // -----------------------------------------------------------------------
    // 7. handleSetRating on inaccessible track returns error 70
    // -----------------------------------------------------------------------
    it('handleSetRating on inaccessible track returns error 70', async () => {
        const { handleSetRating } = await import('$lib/server/subsonic-compat/handlers/ratings.js');

        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Ratings Test Artist 7',
            albumTitle: 'Ratings Test Album 7',
            trackCount: 1,
        });
        const trackId = trackIds[0];

        // Make track age-restricted (18+)
        await sql`
            UPDATE media_items SET age_rating = 18 WHERE id = ${trackId}
        `;

        await ensureTestUser(sql, TEST_USER_RESTRICTED);
        // users.id is the UUID; update by id (mig 16.46.0)
        await sql`
            UPDATE users SET max_age_rating = 13 WHERE id = ${TEST_USER_RESTRICTED}::uuid
        `;

        const auth = buildAuth({
            userId: TEST_USER_RESTRICTED,
            username: TEST_USER_RESTRICTED,
            isAgeRestricted: true,
            maxAgeRating: 13,
        });

        const resp = await handleSetRating(buildMockEvent({ id: trackId, rating: '5' }), auth, sql);
        expect(resp.status).toBe(200);
        const json = (
            await parseJson<SubsonicEnvelope<{ status: string; error?: { code: number } }>>(resp)
        )['subsonic-response'];
        expect(json.status).toBe('failed');
        expect(json.error?.code).toBe(70);
    });

    // -----------------------------------------------------------------------
    // 8. handleScrobble with submission=false (now-playing)
    // -----------------------------------------------------------------------
    it('handleScrobble with submission=false calls recordPlayStart and creates play session', async () => {
        const { handleScrobble } = await import('$lib/server/subsonic-compat/handlers/ratings.js');

        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Ratings Test Artist 8',
            albumTitle: 'Ratings Test Album 8',
            trackCount: 1,
        });
        const trackId = trackIds[0];

        await ensureTestUser(sql, TEST_USER);

        const resp = await handleScrobble(
            buildMockEvent({ id: trackId, submission: 'false' }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);

        // Verify recordPlayStart side-effect (user_music_state.user_id is now uuid)
        const stateRows = await sql<{ play_count: number }[]>`
            SELECT play_count FROM user_music_state
            WHERE user_id = ${TEST_USER}::uuid AND track_id = ${trackId}::uuid
        `;
        expect(stateRows.length).toBe(1);
        expect(stateRows[0].play_count).toBe(1);

        // Verify play session created (play_sessions.user_id is now uuid)
        const sessionRows = await sql<{ id: string }[]>`
            SELECT id FROM play_sessions
            WHERE user_id = ${TEST_USER}::uuid
              AND source = 'subsonic'
              AND source_session_id = ${`${TEST_USER}:${trackId}`}
        `;
        expect(sessionRows.length).toBe(1);
    });

    // -----------------------------------------------------------------------
    // 9. handleScrobble with submission=true calls completion mocks
    // -----------------------------------------------------------------------
    it('handleScrobble with submission=true records external play-end (complete + play-end in one call)', async () => {
        const { handleScrobble } = await import('$lib/server/subsonic-compat/handlers/ratings.js');

        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Ratings Test Artist 9',
            albumTitle: 'Ratings Test Album 9',
            trackCount: 1,
        });
        const trackId = trackIds[0];

        await ensureTestUser(sql, TEST_USER);

        const resp = await handleScrobble(
            buildMockEvent({ id: trackId, submission: 'true' }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);

        expect(mockMusicInteractionManager.recordExternalPlayEnd).toHaveBeenCalledWith(
            TEST_USER,
            trackId,
            expect.any(Object),
            expect.any(Function),
        );
    });

    // -----------------------------------------------------------------------
    // 10. handleGetStarred returns empty arrays when no starred items
    // -----------------------------------------------------------------------
    it('handleGetStarred returns empty arrays when user has no starred items', async () => {
        const { handleGetStarred } =
            await import('$lib/server/subsonic-compat/handlers/ratings.js');

        await ensureTestUser(sql, TEST_USER);

        const resp = await handleGetStarred(buildMockEvent(), buildAuth(), sql);
        const json = (
            await parseJson<
                SubsonicEnvelope<
                    SubsonicResponse<{
                        artist?: unknown[];
                        album?: unknown[];
                        song?: unknown[];
                    }>
                >
            >(resp)
        )['subsonic-response'];
        expect(json.status).toBe('ok');
        expect(json.starred?.artist?.length ?? 0).toBe(0);
        expect(json.starred?.album?.length ?? 0).toBe(0);
        expect(json.starred?.song?.length ?? 0).toBe(0);
    });
});
