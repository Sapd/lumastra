// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { config } from '$lib/server/config.js';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { createAndInsertTestMusicHierarchy } from '../../../../../tests/integration/fixtures/music.fixtures.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';
import type { RequestEvent } from '@sveltejs/kit';
import type { SubsonicAuthContext } from '$lib/server/subsonic-compat/types.js';
import {
    handleGetPlaylists,
    handleGetPlaylist,
    handleCreatePlaylist,
    handleUpdatePlaylist,
    handleDeletePlaylist,
    handleSavePlayQueue,
    handleGetPlayQueue,
    handleSavePlayQueueByIndex,
    handleGetPlayQueueByIndex,
} from '$lib/server/subsonic-compat/handlers/playlists.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

// users.id UUIDs (mig 16.46.0 — playlists.user_id is now uuid)
const TEST_USER: UserId = toUserId(randomUUID());
const OTHER_USER: UserId = toUserId(randomUUID());

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const cacheStore = new Map<string, string>();

vi.mock('$lib/server/cache/valkey.js', () => ({
    cacheGet: vi.fn((key: string) => Promise.resolve(cacheStore.get(key) ?? null)),
    cacheSet: vi.fn((key: string, value: string, _ttl?: number) => {
        cacheStore.set(key, value);
        return Promise.resolve();
    }),
    cacheDel: vi.fn((key: string) => {
        cacheStore.delete(key);
        return Promise.resolve();
    }),
    subscribeToChannel: vi.fn().mockResolvedValue(undefined),
    publishMessage: vi.fn().mockResolvedValue(undefined),
}));

const mockGetUserStations = vi.hoisted(() => vi.fn().mockResolvedValue([]));

const mockGetStationQueue = vi.hoisted(() =>
    vi.fn().mockResolvedValue({ kind: 'ok', tracks: [], truncated: false }),
);

vi.mock('$lib/server/services/music/stations.service.js', () => ({
    getUserStations: mockGetUserStations,
    getStationQueue: mockGetStationQueue,
    parseStationId: (id: string) => {
        const m = /^([0-9a-f]{12})\.(\d{1,3})$/.exec(id);
        return m ? { version: m[1], n: Number.parseInt(m[2], 10) } : null;
    },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        })),
    },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMockEvent(params: Record<string, string | string[]> = {}): RequestEvent {
    const url = new URL('http://localhost/rest/playlists');
    for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) {
            for (const val of v) {
                url.searchParams.append(k, val);
            }
        } else {
            url.searchParams.set(k, v);
        }
    }
    return {
        url,
        request: new Request(url.toString()),
        locals: { subsonicBodyParams: new URLSearchParams() },
        params: {},
        route: { id: '/rest/playlists' as const },
        cookies: {} as RequestEvent['cookies'],
        fetch: globalThis.fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => {},
    } as unknown as RequestEvent;
}

function buildAuth(userId: UserId = TEST_USER): SubsonicAuthContext {
    return {
        // userId is the UUID (users.id). Tests pass the UUID as both userId and
        // username so handlers using auth.username for DB writes still resolve to
        // the correct users row (mig 16.46.0 — playlists.user_id is now uuid).
        userId,
        username: userId,
        ownerIsAdmin: false,
        displayName: null,
        clientName: 'integration-test',
        format: 'json',
        userGroups: [],
        maxAgeRating: null,
        isAgeRestricted: false,
    };
}

async function parseJson<T>(resp: Response): Promise<T> {
    const json = (await resp.json()) as { 'subsonic-response': T };
    return json['subsonic-response'];
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('OpenSubsonic playlist handlers', () => {
    let sql: postgres.Sql;
    let testMediaIds: string[] = [];
    let trackIds: string[] = [];

    beforeAll(async () => {
        sql = getTestDb();
        await sql`SELECT 1`;
    });

    afterAll(async () => {
        // Final cleanup of any remaining test media
        if (testMediaIds.length > 0) {
            await sql`DELETE FROM media_file_items WHERE media_item_id = ANY(${testMediaIds}::uuid[])`;
            await sql`DELETE FROM media_files WHERE file_path LIKE '/test/music/%'`;
            await sql`DELETE FROM media_items WHERE id = ANY(${testMediaIds}::uuid[])`;
        }
        const testUserIds = [TEST_USER, OTHER_USER];
        await sql`DELETE FROM playlists WHERE user_id = ANY(${testUserIds}::uuid[])`;
        await closeTestDb();
    });

    beforeEach(async () => {
        cacheStore.clear();
        mockGetUserStations.mockResolvedValue([]);
        mockGetStationQueue.mockReset();
        mockGetStationQueue.mockResolvedValue({ kind: 'ok', tracks: [], truncated: false });

        // Delete playlists and related data for test users (user_id is now uuid)
        const testUserIds = [TEST_USER, OTHER_USER];
        await sql`
            DELETE FROM playlist_items
            WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id = ANY(${testUserIds}::uuid[]))
        `;
        await sql`
            DELETE FROM playlist_members
            WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id = ANY(${testUserIds}::uuid[]))
        `;
        await sql`DELETE FROM playlists WHERE user_id = ANY(${testUserIds}::uuid[])`;

        // Delete test media from previous test
        if (testMediaIds.length > 0) {
            await sql`DELETE FROM media_file_items WHERE media_item_id = ANY(${testMediaIds}::uuid[])`;
            await sql`DELETE FROM media_files WHERE file_path LIKE '/test/music/%'`;
            await sql`DELETE FROM media_items WHERE id = ANY(${testMediaIds}::uuid[])`;
        }
        testMediaIds = [];
        trackIds = [];

        await ensureTestUser(sql, TEST_USER);
        await ensureTestUser(sql, OTHER_USER);
    });

    async function availabilityFixture() {
        vi.spyOn(config, 'SHOW_UNAVAILABLE_MEDIA', 'get').mockReturnValue(false);
        const music = await createAndInsertTestMusicHierarchy(sql, { trackCount: 4 });
        trackIds = music.trackIds;
        testMediaIds = [music.artistId, music.albumId, ...trackIds];
        const response = await handleCreatePlaylist(
            buildMockEvent({ name: 'Visible ordering', songId: trackIds }),
            buildAuth(),
            sql,
        );
        const { playlist } = await parseJson<{ playlist: { id: string } }>(response);
        const playlistId = Number(playlist.id.replace('playlist:', ''));
        await sql`UPDATE media_items SET has_files = false WHERE id = ${trackIds[1]}`;
        const rows =
            await sql`SELECT * FROM playlist_items WHERE playlist_id = ${playlistId} ORDER BY position, id`;
        return { playlistId, id: playlist.id, hidden: rows[1] };
    }

    it('removes displayed indexes, including multiple removals, without changing hidden rows', async () => {
        const f = await availabilityFixture();
        const read = await parseJson<{ playlist: { entry: { id: string }[] } }>(
            await handleGetPlaylist(buildMockEvent({ id: f.id }), buildAuth(), sql),
        );
        expect(read.playlist.entry.map((e) => e.id)).toEqual([
            trackIds[0],
            trackIds[2],
            trackIds[3],
        ]);
        await handleUpdatePlaylist(
            buildMockEvent({ playlistId: f.id, songIndexToRemove: ['0', '2'] }),
            buildAuth(),
            sql,
        );
        const rows =
            await sql`SELECT * FROM playlist_items WHERE playlist_id = ${f.playlistId} ORDER BY position, id`;
        expect(rows.map((r) => r.media_id)).toEqual([trackIds[1], trackIds[2]]);
        expect(rows.find((r) => r.media_id === trackIds[1])).toEqual(f.hidden);
    });

    it('replaces only the visible ordering and retains the complete hidden row', async () => {
        const f = await availabilityFixture();
        await handleCreatePlaylist(
            buildMockEvent({ playlistId: f.id, songId: [trackIds[3], trackIds[0]] }),
            buildAuth(),
            sql,
        );
        const rows =
            await sql`SELECT * FROM playlist_items WHERE playlist_id = ${f.playlistId} ORDER BY position, id`;
        expect(rows.find((r) => r.media_id === trackIds[1])).toEqual(f.hidden);
        expect(rows.filter((r) => r.media_id !== trackIds[1]).map((r) => r.media_id)).toEqual([
            trackIds[3],
            trackIds[0],
        ]);
        await handleCreatePlaylist(buildMockEvent({ playlistId: f.id }), buildAuth(), sql);
        expect(await sql`SELECT * FROM playlist_items WHERE playlist_id = ${f.playlistId}`).toEqual(
            [f.hidden],
        );
    });

    it('playlist summary counts match visible contents, including entirely hidden lists', async () => {
        const f = await availabilityFixture();
        const count = async () => {
            const data = await parseJson<{
                playlists: { playlist: { id: string; songCount: number }[] };
            }>(await handleGetPlaylists(buildMockEvent(), buildAuth(), sql));
            return data.playlists.playlist.find((p) => p.id === f.id)?.songCount;
        };
        expect(await count()).toBe(3);
        await sql`UPDATE media_items SET has_files = false WHERE id = ANY(${trackIds}::uuid[])`;
        expect(await count()).toBe(0);
    });

    for (const indexed of [false, true]) {
        it(`preserves hidden duplicate queue occurrences through ${indexed ? 'indexed' : 'regular'} read/save and clear`, async () => {
            await availabilityFixture();
            const save = indexed ? handleSavePlayQueueByIndex : handleSavePlayQueue;
            const get = indexed ? handleGetPlayQueueByIndex : handleGetPlayQueue;
            const key = `subsoniccompat:playqueue:${TEST_USER}`;
            const entries = [trackIds[0], trackIds[1], trackIds[2], trackIds[1], trackIds[0]];
            cacheStore.set(
                key,
                JSON.stringify({
                    entries,
                    currentIndex: 4,
                    current: trackIds[0],
                    position: 180000,
                    changed: 'now',
                }),
            );
            const data = await parseJson<
                Record<string, { entry: { id: string }[]; currentIndex?: number; position: number }>
            >(await get(buildMockEvent(), buildAuth(), sql));
            const queue = data[indexed ? 'playQueueByIndex' : 'playQueue'];
            expect(queue.entry.map((e) => e.id)).toEqual([trackIds[0], trackIds[2], trackIds[0]]);
            if (indexed) expect(queue.currentIndex).toBe(2);
            await save(
                buildMockEvent({
                    id: queue.entry.map((e) => e.id),
                    currentIndex: '2',
                    current: trackIds[0],
                    position: '180000',
                }),
                buildAuth(),
                sql,
            );
            const stored = JSON.parse(cacheStore.get(key)!);
            expect(stored.entries).toEqual(entries);
            if (indexed) expect(stored.currentIndex).toBe(4);
            await save(
                buildMockEvent({
                    id: [trackIds[2], trackIds[0], trackIds[0]],
                    currentIndex: '2',
                    current: trackIds[0],
                }),
                buildAuth(),
                sql,
            );
            expect(JSON.parse(cacheStore.get(key)!).entries).toEqual([
                trackIds[2],
                trackIds[1],
                trackIds[0],
                trackIds[1],
                trackIds[0],
            ]);
            await save(buildMockEvent(), buildAuth(), sql);
            expect(JSON.parse(cacheStore.get(key)!).entries).toEqual([trackIds[1], trackIds[1]]);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${trackIds[1]}`;
            const restored = await parseJson<Record<string, { entry: { id: string }[] }>>(
                await get(buildMockEvent(), buildAuth(), sql),
            );
            expect(
                restored[indexed ? 'playQueueByIndex' : 'playQueue'].entry.map((e) => e.id),
            ).toEqual([trackIds[1], trackIds[1]]);
        });
        it(`resets seek when the selected ${indexed ? 'indexed' : 'regular'} queue occurrence is hidden`, async () => {
            await availabilityFixture();
            cacheStore.set(
                `subsoniccompat:playqueue:${TEST_USER}`,
                JSON.stringify({
                    entries: trackIds,
                    currentIndex: 1,
                    current: trackIds[1],
                    position: 180000,
                    changed: 'now',
                }),
            );
            const get = indexed ? handleGetPlayQueueByIndex : handleGetPlayQueue;
            const data = await parseJson<
                Record<string, { current?: string; currentIndex?: number; position: number }>
            >(await get(buildMockEvent(), buildAuth(), sql));
            const queue = data[indexed ? 'playQueueByIndex' : 'playQueue'];
            expect(queue.position).toBe(0);
            if (indexed) expect(queue.currentIndex).toBe(0);
            else expect(queue.current).toBeUndefined();
        });
    }

    // -----------------------------------------------------------------------
    // 1. getPlaylists empty
    // -----------------------------------------------------------------------

    it('handleGetPlaylists returns empty playlist array when user has no playlists', async () => {
        const event = buildMockEvent();
        const resp = await handleGetPlaylists(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const data = await parseJson<{ playlists: { playlist: unknown[] } }>(resp);
        expect(data.playlists.playlist).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // 2. createPlaylist
    // -----------------------------------------------------------------------

    it('handleCreatePlaylist creates a playlist with name and optional songIds', async () => {
        const {
            trackIds: newTrackIds,
            artistId,
            albumId,
        } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 2 });
        trackIds = newTrackIds;
        testMediaIds = [artistId, albumId, ...newTrackIds];

        const event = buildMockEvent({
            name: 'Test Playlist',
            songId: trackIds[0],
        });
        const resp = await handleCreatePlaylist(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const data = await parseJson<{
            playlist: { id: string; name: string; songCount: number };
        }>(resp);
        expect(data.playlist.name).toBe('Test Playlist');
        expect(data.playlist.songCount).toBe(1);
        expect(data.playlist.id).toMatch(/^playlist:\d+$/);
    });

    // -----------------------------------------------------------------------
    // 3. getPlaylist with songs
    // -----------------------------------------------------------------------

    it('handleGetPlaylist returns the created playlist with songs', async () => {
        const {
            trackIds: newTrackIds,
            artistId,
            albumId,
        } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 2 });
        trackIds = newTrackIds;
        testMediaIds = [artistId, albumId, ...newTrackIds];

        const createEvent = buildMockEvent({
            name: 'Songs Playlist',
            songId: trackIds,
        });
        const createResp = await handleCreatePlaylist(createEvent, buildAuth(), sql);
        const createData = await parseJson<{ playlist: { id: string } }>(createResp);
        const playlistId = createData.playlist.id;

        const getEvent = buildMockEvent({ id: playlistId });
        const getResp = await handleGetPlaylist(getEvent, buildAuth(), sql);
        expect(getResp.status).toBe(200);
        const getData = await parseJson<{
            playlist: {
                id: string;
                name: string;
                entry: unknown[];
                songCount: number;
            };
        }>(getResp);
        expect(getData.playlist.id).toBe(playlistId);
        expect(getData.playlist.name).toBe('Songs Playlist');
        expect(getData.playlist.songCount).toBe(2);
        expect(getData.playlist.entry).toHaveLength(2);
    });

    // -----------------------------------------------------------------------
    // 4. getPlaylist playlist:{id} format
    // -----------------------------------------------------------------------

    it('handleGetPlaylist accepts playlist:{id} format', async () => {
        const result = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${TEST_USER}::uuid, 'Direct Playlist', 'private', 'music')
            RETURNING id
        `;
        const numericId = result[0].id;

        const event = buildMockEvent({ id: `playlist:${numericId}` });
        const resp = await handleGetPlaylist(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const data = await parseJson<{
            playlist: { id: string; name: string };
        }>(resp);
        expect(data.playlist.id).toBe(`playlist:${numericId}`);
        expect(data.playlist.name).toBe('Direct Playlist');
    });

    // -----------------------------------------------------------------------
    // 5. getPlaylist non-existent → error 70
    // -----------------------------------------------------------------------

    it('handleGetPlaylist returns error 70 for non-existent playlist', async () => {
        const event = buildMockEvent({ id: 'playlist:999999' });
        const resp = await handleGetPlaylist(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const data = await parseJson<{
            status: string;
            error?: { code: number; message: string };
        }>(resp);
        expect(data.status).toBe('failed');
        expect(data.error?.code).toBe(70);
    });

    // -----------------------------------------------------------------------
    // 5b. getPlaylist station:{id}
    // -----------------------------------------------------------------------

    describe('station playlists', () => {
        const STATION_ID = 'abcdef012345.2';
        type PlaylistBody = {
            status: string;
            error?: { code: number };
            playlist?: { id: string; name: string };
        };

        it('returns the station with its listed label when the id is in the current list', async () => {
            mockGetUserStations.mockResolvedValue([
                {
                    id: STATION_ID,
                    label: 'Listed Artist',
                    playedTrackCount: 3,
                    tagline: 't',
                    coverTrackIds: [],
                },
            ]);
            const resp = await handleGetPlaylist(
                buildMockEvent({ id: `station:${STATION_ID}` }),
                buildAuth(),
                sql,
            );
            const data = await parseJson<PlaylistBody>(resp);
            expect(data.status).toBe('ok');
            expect(data.playlist?.id).toBe(`station:${STATION_ID}`);
            expect(data.playlist?.name).toBe('Listed Artist');
        });

        it('still serves an id missing from the current list, with a positional label', async () => {
            const resp = await handleGetPlaylist(
                buildMockEvent({ id: `station:${STATION_ID}` }),
                buildAuth(),
                sql,
            );
            const data = await parseJson<PlaylistBody>(resp);
            expect(mockGetStationQueue).toHaveBeenCalledTimes(1);
            expect(data.status).toBe('ok');
            expect(data.playlist?.name).toBe('Station 3');
        });

        it('answers 70 for an expired station', async () => {
            mockGetStationQueue.mockResolvedValue({ kind: 'expired' });
            const resp = await handleGetPlaylist(
                buildMockEvent({ id: `station:${STATION_ID}` }),
                buildAuth(),
                sql,
            );
            const data = await parseJson<PlaylistBody>(resp);
            expect(data.status).toBe('failed');
            expect(data.error?.code).toBe(70);
        });

        it('answers a server error (not 70) when the queue lookup throws', async () => {
            mockGetStationQueue.mockRejectedValue(new Error('db down'));
            const resp = await handleGetPlaylist(
                buildMockEvent({ id: `station:${STATION_ID}` }),
                buildAuth(),
                sql,
            );
            const data = await parseJson<PlaylistBody>(resp);
            expect(data.status).toBe('failed');
            expect(data.error?.code).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // 6. getPlaylist private playlist of another user → error 70
    // -----------------------------------------------------------------------

    it('handleGetPlaylist returns error 70 for private playlist of another user', async () => {
        const result = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${TEST_USER}::uuid, 'Private Playlist', 'private', 'music')
            RETURNING id
        `;
        const playlistId = result[0].id;

        const event = buildMockEvent({ id: `playlist:${playlistId}` });
        const resp = await handleGetPlaylist(event, buildAuth(OTHER_USER), sql);
        const data = await parseJson<{
            status: string;
            error?: { code: number };
        }>(resp);
        expect(data.status).toBe('failed');
        expect(data.error?.code).toBe(70);
    });

    // -----------------------------------------------------------------------
    // 7. updatePlaylist owner
    // -----------------------------------------------------------------------

    it('handleUpdatePlaylist allows owner to update name and visibility', async () => {
        const result = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${TEST_USER}::uuid, 'Original Name', 'private', 'music')
            RETURNING id
        `;
        const playlistId = result[0].id;

        const event = buildMockEvent({
            playlistId: `playlist:${playlistId}`,
            name: 'Updated Name',
            public: 'true',
        });
        const resp = await handleUpdatePlaylist(event, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const data = await parseJson<{ status: string }>(resp);
        expect(data.status).toBe('ok');

        const verify = await sql<{ name: string; visibility: string }[]>`
            SELECT name, visibility FROM playlists WHERE id = ${playlistId}
        `;
        expect(verify[0].name).toBe('Updated Name');
        expect(verify[0].visibility).toBe('public');
    });

    it('handleUpdatePlaylist bumps playlists.revision when entries are added', async () => {
        const {
            trackIds: newTrackIds,
            artistId,
            albumId,
        } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
        trackIds = newTrackIds;
        testMediaIds = [artistId, albumId, ...newTrackIds];
        const result = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${TEST_USER}::uuid, 'Rev', 'private', 'music')
            RETURNING id
        `;
        const playlistId = result[0].id;

        const resp = await handleUpdatePlaylist(
            buildMockEvent({ playlistId: `playlist:${playlistId}`, songIdToAdd: trackIds[0] }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);
        const rows = await sql<{ revision: number }[]>`
            SELECT revision FROM playlists WHERE id = ${playlistId}
        `;
        expect(rows[0].revision).toBeGreaterThan(0);
    });

    async function revisionOf(playlistId: number): Promise<number> {
        const rows = await sql<{ revision: number }[]>`
            SELECT revision FROM playlists WHERE id = ${playlistId}
        `;
        return rows[0].revision;
    }

    it('handleCreatePlaylist in replace mode (playlistId) bumps playlists.revision once', async () => {
        const {
            trackIds: newTrackIds,
            artistId,
            albumId,
        } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 2 });
        trackIds = newTrackIds;
        testMediaIds = [artistId, albumId, ...newTrackIds];
        const [{ id: playlistId }] = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${TEST_USER}::uuid, 'Replace', 'private', 'music')
            RETURNING id
        `;
        const before = await revisionOf(playlistId);

        const resp = await handleCreatePlaylist(
            buildMockEvent({
                playlistId: `playlist:${playlistId}`,
                songId: [trackIds[0], trackIds[1]],
            }),
            buildAuth(),
            sql,
        );

        expect(resp.status).toBe(200);
        expect(await revisionOf(playlistId)).toBe(before + 1);
        const items = await sql<{ media_id: string }[]>`
            SELECT media_id FROM playlist_items WHERE playlist_id = ${playlistId} ORDER BY position
        `;
        expect(items.map((r) => r.media_id)).toEqual([trackIds[0], trackIds[1]]);
    });

    it('handleUpdatePlaylist bumps revision once when entries are removed', async () => {
        const {
            trackIds: newTrackIds,
            artistId,
            albumId,
        } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 2 });
        trackIds = newTrackIds;
        testMediaIds = [artistId, albumId, ...newTrackIds];
        const [{ id: playlistId }] = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${TEST_USER}::uuid, 'Remove', 'private', 'music')
            RETURNING id
        `;
        await handleUpdatePlaylist(
            buildMockEvent({
                playlistId: `playlist:${playlistId}`,
                songIdToAdd: [trackIds[0], trackIds[1]],
            }),
            buildAuth(),
            sql,
        );
        const before = await revisionOf(playlistId);

        const resp = await handleUpdatePlaylist(
            buildMockEvent({ playlistId: `playlist:${playlistId}`, songIndexToRemove: '0' }),
            buildAuth(),
            sql,
        );

        expect(resp.status).toBe(200);
        expect(await revisionOf(playlistId)).toBe(before + 1);
    });

    it('handleUpdatePlaylist leaves revision alone for a rename-only update', async () => {
        const [{ id: playlistId }] = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${TEST_USER}::uuid, 'Plain', 'private', 'music')
            RETURNING id
        `;
        const before = await revisionOf(playlistId);
        const resp = await handleUpdatePlaylist(
            buildMockEvent({ playlistId: `playlist:${playlistId}`, name: 'Renamed' }),
            buildAuth(),
            sql,
        );
        expect(resp.status).toBe(200);
        expect(await revisionOf(playlistId)).toBe(before);
    });

    // -----------------------------------------------------------------------
    // 8. updatePlaylist non-owner → error 50
    // -----------------------------------------------------------------------

    it('handleUpdatePlaylist returns error 50 for non-owner', async () => {
        const result = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${TEST_USER}::uuid, 'Owner Playlist', 'private', 'music')
            RETURNING id
        `;
        const playlistId = result[0].id;

        const event = buildMockEvent({
            playlistId: `playlist:${playlistId}`,
            name: 'Hacked Name',
        });
        const resp = await handleUpdatePlaylist(event, buildAuth(OTHER_USER), sql);
        const data = await parseJson<{
            status: string;
            error?: { code: number };
        }>(resp);
        expect(data.status).toBe('failed');
        expect(data.error?.code).toBe(50);
    });

    // -----------------------------------------------------------------------
    // 9. deletePlaylist owner
    // -----------------------------------------------------------------------

    it('handleDeletePlaylist allows owner to delete', async () => {
        const result = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${TEST_USER}::uuid, 'To Delete', 'private', 'music')
            RETURNING id
        `;
        const playlistId = result[0].id;

        const event = buildMockEvent({ id: `playlist:${playlistId}` });
        const resp = await handleDeletePlaylist(event, buildAuth(), sql);
        const data = await parseJson<{ status: string }>(resp);
        expect(data.status).toBe('ok');

        const verify = await sql<{ count: number }[]>`
            SELECT COUNT(*)::int as count FROM playlists WHERE id = ${playlistId}
        `;
        expect(verify[0].count).toBe(0);
    });

    // -----------------------------------------------------------------------
    // 10. deletePlaylist non-owner → error 70
    // -----------------------------------------------------------------------

    it('handleDeletePlaylist returns error 70 for non-owner', async () => {
        const result = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${TEST_USER}::uuid, 'Owner Playlist', 'private', 'music')
            RETURNING id
        `;
        const playlistId = result[0].id;

        const event = buildMockEvent({ id: `playlist:${playlistId}` });
        const resp = await handleDeletePlaylist(event, buildAuth(OTHER_USER), sql);
        const data = await parseJson<{
            status: string;
            error?: { code: number };
        }>(resp);
        expect(data.status).toBe('failed');
        expect(data.error?.code).toBe(70);
    });

    // -----------------------------------------------------------------------
    // 11. savePlayQueue saves track IDs
    // -----------------------------------------------------------------------

    it('handleSavePlayQueue saves track IDs to Valkey cache', async () => {
        const {
            trackIds: newTrackIds,
            artistId,
            albumId,
        } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 2 });
        trackIds = newTrackIds;
        testMediaIds = [artistId, albumId, ...newTrackIds];

        const event = buildMockEvent({
            id: trackIds,
            current: trackIds[0],
            position: '120000',
        });
        const resp = await handleSavePlayQueue(event, buildAuth(), sql);
        const data = await parseJson<{ status: string }>(resp);
        expect(data.status).toBe('ok');

        const cached = cacheStore.get(`subsoniccompat:playqueue:${TEST_USER}`);
        expect(cached).toBeTruthy();
        const stored = JSON.parse(cached!) as {
            entries: string[];
            current: string;
            position: number;
        };
        expect(stored.entries).toEqual(trackIds);
        expect(stored.current).toBe(trackIds[0]);
        expect(stored.position).toBe(120000);
    });

    // -----------------------------------------------------------------------
    // 12. getPlayQueue retrieves saved queue
    // -----------------------------------------------------------------------

    it('handleGetPlayQueue retrieves saved queue with track details', async () => {
        const {
            trackIds: newTrackIds,
            artistId,
            albumId,
        } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 2 });
        trackIds = newTrackIds;
        testMediaIds = [artistId, albumId, ...newTrackIds];

        const saveEvent = buildMockEvent({
            id: trackIds,
            current: trackIds[0],
            position: '60000',
        });
        await handleSavePlayQueue(saveEvent, buildAuth(), sql);

        const getEvent = buildMockEvent();
        const resp = await handleGetPlayQueue(getEvent, buildAuth(), sql);
        expect(resp.status).toBe(200);
        const data = await parseJson<{
            playQueue: {
                entry: Array<{ id: string }>;
                current: string;
                position: number;
                username: string;
            };
        }>(resp);
        expect(data.playQueue.username).toBe(TEST_USER);
        expect(data.playQueue.current).toBe(trackIds[0]);
        expect(data.playQueue.position).toBe(60000);
        expect(data.playQueue.entry).toHaveLength(2);
        expect(data.playQueue.entry[0].id).toBe(trackIds[0]);
        expect(data.playQueue.entry[1].id).toBe(trackIds[1]);
    });

    // -----------------------------------------------------------------------
    // 13. savePlayQueue with empty ids clears the queue
    // -----------------------------------------------------------------------

    it('handleSavePlayQueue with empty ids clears the queue', async () => {
        const {
            trackIds: newTrackIds,
            artistId,
            albumId,
        } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
        trackIds = newTrackIds;
        testMediaIds = [artistId, albumId, ...newTrackIds];

        // Save queue with a track
        const saveEvent1 = buildMockEvent({ id: trackIds[0] });
        await handleSavePlayQueue(saveEvent1, buildAuth(), sql);

        // Save empty queue
        const saveEvent2 = buildMockEvent({});
        const resp = await handleSavePlayQueue(saveEvent2, buildAuth(), sql);
        const data = await parseJson<{ status: string }>(resp);
        expect(data.status).toBe('ok');

        // Get queue should return empty entry list
        const getEvent = buildMockEvent();
        const getResp = await handleGetPlayQueue(getEvent, buildAuth(), sql);
        const getData = await parseJson<{ playQueue: { entry?: unknown[] } }>(getResp);
        expect(getData.playQueue.entry).toEqual([]);
    });
});
