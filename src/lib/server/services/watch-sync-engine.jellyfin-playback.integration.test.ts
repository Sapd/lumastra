// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type {
    PluginContext,
    ResumePositionItem,
    WatchStateChange,
} from '@sapd/lumastra-plugin-sdk';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    ensureTestUser,
    generateTestUserId,
    derivedUsername,
} from '../../../../tests/integration/fixtures/index.js';
import { ingestOfflineSessions } from './offline-playback.service.js';
import { watchManager } from './watch-manager.service.js';
import { appendEventAndRebuild } from './watch-state-rebuilder.service.js';
import { getState } from '../database/queries/user-media-state.queries.js';
import { getUnpushedLumastraItems } from '../database/queries/user-media-events.queries.js';
import { createCatalogService } from './catalog.service.js';
import { watchSyncEngine } from './watch-sync-engine.service.js';
import { jellyfinWatchSync } from '../tasks/builtin/native/watch-sync/jellyfin.js';
import { aiDbService } from './database.service.js';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import { watchSyncPushTask } from '../tasks/builtin/native/watch-sync-push.js';
import { jellyfinFileInventoryTask } from '../tasks/builtin/native/jellyfin-file-inventory.js';
import { registry } from '../tasks/registry.js';
import { watchSyncPullTask } from '../tasks/builtin/native/watch-sync-pull.js';

const http = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
}));
vi.mock('../jellyfin/user.service.js', () => ({
    jellyfinUserService: {
        getAxiosInstance: () => http,
        getBaseUrl: () => 'http://jellyfin.test',
        getApiToken: () => 'test-key',
        getUserByName: async () => undefined,
    },
}));
vi.mock('../jellyfin/base-client.js', () => ({
    circuitBreaker: {
        shouldAllowRequest: () => true,
        getState: () => ({ isOpen: false }),
    },
}));
vi.mock('../jellyfin/retry.js', () => ({
    withJellyfinRetry: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../operation-mode.js', () => ({ operationMode: { isJellyfinEnabled: true } }));
vi.mock('../config.js', async (original) => {
    const actual = await original<typeof import('../config.js')>();
    return { ...actual, features: { ...actual.features, jellyfinSync: true } };
});

describe('Jellyfin playback push seam (real PostgreSQL, mocked HTTP)', () => {
    let sql: postgres.Sql;
    let userId: ReturnType<typeof generateTestUserId>;
    let mediaId: string;
    let tmdbId: number;
    const remoteId = 'a'.repeat(32);
    const remoteUserId = 'b'.repeat(32);
    let found = true;
    let remoteUsers: Array<{ Id: string; Name: string }>;

    beforeAll(() => {
        sql = getTestDb();
        vi.spyOn(aiDbService, 'getSql').mockImplementation(async () => sql);
    });
    afterAll(async () => {
        vi.restoreAllMocks();
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, [
            'jellyfin_file_inventory',
            'media_files',
            'library_groups',
            'library_paths',
            'personal_media_dispositions',
            'watch_sync_activity',
            'watch_state_pending_resolution',
            'watch_state_pull_log',
            'user_media_events',
            'user_media_state',
            'user_media_flags',
            'media_items',
            'external_ids',
            'user_profiles',
        ]);
        userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await sql`UPDATE users SET jellyfin_user_id = ${remoteUserId} WHERE id = ${userId}`;
        ({ id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, {
            title: 'Identified movie',
        }));
        await createCatalogService(sql, { skipLifecycleHooks: true }).deleteExternalId(
            mediaId,
            'jellyfin',
            'movie',
        );
        found = true;
        remoteUsers = [{ Id: remoteUserId, Name: derivedUsername(userId) }];
        http.post.mockReset().mockResolvedValue({ data: {} });
        http.delete.mockReset().mockResolvedValue({ data: {} });
        http.get.mockReset().mockImplementation(async (url: string) => {
            if (url.endsWith('/Library/VirtualFolders')) return { data: [] };
            if (url.endsWith('/System/Info/Public')) return { data: { Version: '12.4.0' } };
            if (url.endsWith('/Users')) return { data: remoteUsers };
            if (url.endsWith('/Sessions')) return { data: [] };
            if (url.endsWith('/Items/Resume')) return { data: { Items: [], TotalRecordCount: 0 } };
            return {
                data: {
                    Items: found
                        ? [{ Id: remoteId, Type: 'Movie', ProviderIds: { Tmdb: String(tmdbId) } }]
                        : [],
                    TotalRecordCount: found ? 1 : 0,
                },
            };
        });
    });

    async function offline(positionMs = 36_009, runtimeMs = 90_023): Promise<void> {
        const endedAt = new Date().toISOString();
        const results = await ingestOfflineSessions(sql, {
            userId,
            user: undefined,
            records: [
                {
                    eventId: crypto.randomUUID(),
                    mediaId,
                    startedAt: new Date(Date.now() - 60_000).toISOString(),
                    endedAt,
                    knownAsOf: endedAt,
                    positionMs,
                    runtimeMs,
                    sessionElapsedMs: positionMs,
                    endReason: 'stopped',
                },
            ],
        });
        expect(results[0]).toMatchObject({ status: 'accepted', applied: true });
        expect((await getState.one(sql, { userId, mediaId }))?.resume_position_ms).toBe(positionMs);
    }

    async function pending(): Promise<number> {
        return (await getUnpushedLumastraItems.all(sql, { provider: 'jellyfin', limit: 200 }))
            .length;
    }

    it('resolves an offline-ingested partial without a cached Jellyfin ID and pushes exact ticks', async () => {
        await offline();
        const [result] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(result).toMatchObject({
            processed: 1,
            succeeded: 1,
            skipped: 0,
            failed: 0,
            notPaired: 0,
        });
        expect(http.post).toHaveBeenCalledWith(
            `http://jellyfin.test/UserItems/${remoteId}/UserData?userId=${remoteUserId}`,
            { PlaybackPositionTicks: 360_090_000 },
            expect.anything(),
        );
        expect(http.delete).not.toHaveBeenCalled();
        expect(await pending()).toBe(0);
    });

    it('pushes a partial and a played mark for a file-paired item that has no provider ids', async () => {
        await sql`DELETE FROM external_ids WHERE media_id = ${mediaId}`;
        await createCatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(mediaId, {
            provider: 'jellyfin',
            id: remoteId,
            mediaType: 'movie',
            source: 'watch-sync-file',
        });
        // Any resolver call would find nothing: the pairing is the only evidence.
        found = false;
        await offline();
        const [partial] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(partial).toMatchObject({ succeeded: 1, skipped: 0, failed: 0, notPaired: 0 });
        expect(http.post).toHaveBeenCalledWith(
            `http://jellyfin.test/UserItems/${remoteId}/UserData?userId=${remoteUserId}`,
            { PlaybackPositionTicks: 360_090_000 },
            expect.anything(),
        );
        expect(await pending()).toBe(0);

        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'mark_watched',
            source: 'lumastra-user-mark',
            position_ms: null,
            runtime_ms: 90_023,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: new Date().toISOString(),
        });
        const [played] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(played).toMatchObject({ succeeded: 1, skipped: 0, failed: 0 });
        expect(http.post).toHaveBeenCalledWith(
            `http://jellyfin.test/Users/${remoteUserId}/PlayedItems/${remoteId}`,
            undefined,
            expect.anything(),
        );
        expect(await pending()).toBe(0);
    });

    async function seedFileOnlyMovie(localRoot: string, localPath: string): Promise<void> {
        await sql`DELETE FROM external_ids WHERE media_id = ${mediaId}`;
        const [group] = await sql`INSERT INTO library_groups (name) VALUES ('m') RETURNING id`;
        await sql`INSERT INTO library_paths (path, media_type, library_group_id) VALUES (${localRoot}, 'movie', ${group.id})`;
        await sql`UPDATE media_items SET has_files = true, status = 'active' WHERE id = ${mediaId}`;
        const [file] =
            await sql`INSERT INTO media_files (file_path, file_size_bytes, library_group_id) VALUES (${localPath}, 1234, ${group.id}) RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${file.id}, ${mediaId}, true)`;
        await sql`INSERT INTO personal_media_dispositions (media_id, disposition, decided_by) VALUES (${mediaId}, 'kept', 'test')`;
        found = false;
    }
    /** Jellyfin library inventory; `current.id` can be swapped to simulate a rename. */
    function serveInventory(remoteRoot: string, remotePath: string, current: { id: string }): void {
        const base = http.get.getMockImplementation()!;
        http.get.mockImplementation(
            async (url: string, options?: { params?: { Ids?: string; ParentId?: string } }) => {
                const items = [
                    {
                        Id: current.id,
                        Type: 'Movie',
                        Name: 'Film',
                        Path: remotePath,
                        MediaSources: [{ Path: remotePath, Size: 1234 }],
                        ProviderIds: {},
                    },
                ];
                if (url.endsWith('/Library/VirtualFolders'))
                    return { data: [{ ItemId: 'lib', Locations: [remoteRoot] }] };
                if (url.endsWith('/Items') && (options?.params?.Ids || options?.params?.ParentId))
                    return { data: { Items: items, TotalRecordCount: 1 } };
                return base(url, options);
            },
        );
    }

    it('retains a record pushed before the file pairing exists and delivers it once the pairing is installed', async () => {
        await seedFileOnlyMovie('/data/movies', '/data/movies/Holiday/Film.mkv');
        serveInventory('/media/movies', '/media/movies/Holiday/Film.mkv', { id: remoteId });
        await offline();
        const [before] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(before).toMatchObject({ succeeded: 0, skipped: 1, failed: 0 });
        // The same count the admin banner shows: one title without evidence yet.
        expect(before.notPaired).toBe(1);
        expect(await pending()).toBe(1);
        await jellyfinFileInventoryTask.execute(mockContext({ input: {}, sql }));
        const [after] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(after).toMatchObject({ succeeded: 1, skipped: 0, failed: 0, notPaired: 0 });
        expect(await pending()).toBe(0);
    });

    it('pairs by identical absolute path when the Lumastra and Jellyfin library roots differ', async () => {
        await seedFileOnlyMovie('/data', '/data/movies/Holiday/Film.mkv');
        serveInventory('/data/movies', '/data/movies/Holiday/Film.mkv', { id: remoteId });
        await offline();
        await jellyfinFileInventoryTask.execute(mockContext({ input: {}, sql }));
        const [result] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(result).toMatchObject({ succeeded: 1, skipped: 0, failed: 0 });
    });

    it('pull resolves a dashed Jellyfin id against the stored dashless file link', async () => {
        await createCatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(mediaId, {
            provider: 'jellyfin',
            id: remoteId,
            mediaType: 'movie',
            source: 'watch-sync-file',
        });
        const dashed = '8b2c1f3a-1111-4222-8333-444455556666';
        await sql`UPDATE external_ids SET external_id = ${dashed.replaceAll('-', '')} WHERE media_id = ${mediaId} AND provider = 'jellyfin'`;
        const { resolvePulledItems } = await import('./watch-sync-resolution.js');
        const { resolved } = await resolvePulledItems(sql, 'jellyfin', [
            { providerId: dashed, mediaType: 'movie', tmdbId: null, imdbId: null },
        ]);
        expect(resolved.get(dashed)).toBe(mediaId);
    });

    it('pulls a played, id-less file-paired movie reported with a dashed Jellyfin id', async () => {
        await sql`DELETE FROM external_ids WHERE media_id = ${mediaId}`;
        await createCatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(mediaId, {
            provider: 'jellyfin',
            id: remoteId,
            mediaType: 'movie',
            source: 'watch-sync-file',
        });
        const dashed = `${remoteId.slice(0, 8)}-${remoteId.slice(8, 12)}-${remoteId.slice(12, 16)}-${remoteId.slice(16, 20)}-${remoteId.slice(20)}`;
        http.get.mockImplementation(
            async (url: string, opts?: { params?: { includeItemTypes?: string } }) => {
                if (url.endsWith('/Library/VirtualFolders')) return { data: [] };
                if (url.endsWith('/Users')) return { data: remoteUsers };
                if (url.endsWith('/Sessions')) return { data: [] };
                const items =
                    url.endsWith('/Items') && opts?.params?.includeItemTypes === 'Movie'
                        ? [
                              {
                                  Id: dashed,
                                  Type: 'Movie',
                                  Name: 'Identified movie',
                                  ProviderIds: {},
                                  RunTimeTicks: 900_000_000,
                                  UserData: {
                                      Played: true,
                                      PlayCount: 1,
                                      PlaybackPositionTicks: 0,
                                      LastPlayedDate: new Date().toISOString(),
                                  },
                              },
                          ]
                        : [];
                return { data: { Items: items, TotalRecordCount: items.length } };
            },
        );
        const [result] = await watchSyncEngine.runPull(jellyfinWatchSync.id, undefined, sql);
        expect(result).toMatchObject({ totalSkippedNoMatch: 0, notPaired: 0 });
        expect((await getState.one(sql, { userId, mediaId }))?.is_watched).toBe(true);
    });

    it('drops a stale file link on 404 and delivers after the renamed file is re-inventoried', async () => {
        await seedFileOnlyMovie('/data/movies', '/data/movies/Holiday/Film.mkv');
        const current = { id: remoteId };
        serveInventory('/media/movies', '/media/movies/Holiday/Film.mkv', current);
        await offline();
        await jellyfinFileInventoryTask.execute(mockContext({ input: {}, sql }));
        // Rename on the Jellyfin side: the old id is gone (404), a new id exists.
        const renamed = 'd'.repeat(32);
        current.id = renamed;
        http.post.mockImplementation(async (url: string) => {
            if (url.includes(remoteId)) throw { response: { status: 404 }, message: 'not found' };
            return { data: {} };
        });
        const [stale] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(stale.succeeded).toBe(0);
        expect(await pending()).toBe(1);
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${mediaId} AND provider = 'jellyfin'`,
        ).toHaveLength(0);
        await jellyfinFileInventoryTask.execute(mockContext({ input: {}, sql }));
        const [fixed] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(fixed).toMatchObject({ succeeded: 1, failed: 0 });
        expect(http.post).toHaveBeenCalledWith(
            expect.stringContaining(`/UserItems/${renamed}/UserData`),
            expect.anything(),
            expect.anything(),
        );
        expect(await pending()).toBe(0);
    });

    it('keeps a file link when a 404 is contradicted by GET /Items?Ids=', async () => {
        await sql`DELETE FROM external_ids WHERE media_id = ${mediaId}`;
        await createCatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(mediaId, {
            provider: 'jellyfin',
            id: remoteId,
            mediaType: 'movie',
            source: 'watch-sync-file',
        });
        // The write 404s, but the id lookup still returns the item: not a rename.
        http.post.mockImplementation(async (url: string) => {
            if (url.includes(remoteId)) throw { response: { status: 404 }, message: 'not found' };
            return { data: {} };
        });
        await offline();
        const [result] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(result).toMatchObject({ succeeded: 0, failed: 1 });
        expect(result.errors.join(' ')).not.toContain('pairing dropped');
        expect(
            http.get.mock.calls.some(
                ([url, opts]) => String(url).endsWith('/Items') && opts?.params?.Ids === remoteId,
            ),
        ).toBe(true);
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${mediaId} AND provider = 'jellyfin' AND source = 'watch-sync-file' AND external_id = ${remoteId}`,
        ).toHaveLength(1);
        expect(await pending()).toBe(1);
    });

    it('keeps a file link when the id lookup after a 404 fails with a server error', async () => {
        await sql`DELETE FROM external_ids WHERE media_id = ${mediaId}`;
        await createCatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(mediaId, {
            provider: 'jellyfin',
            id: remoteId,
            mediaType: 'movie',
            source: 'watch-sync-file',
        });
        http.post.mockImplementation(async (url: string) => {
            if (url.includes(remoteId)) throw { response: { status: 404 }, message: 'not found' };
            return { data: {} };
        });
        const get = http.get.getMockImplementation()!;
        http.get.mockImplementation(async (url: string, options?: unknown) => {
            const params = (options as { params?: { Ids?: string } } | undefined)?.params;
            if (url.endsWith('/Items') && params?.Ids === remoteId)
                throw Object.assign(new Error('upstream failure'), { response: { status: 503 } });
            return get(url, options);
        });
        await offline();
        const [result] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(result).toMatchObject({ succeeded: 0, failed: 1 });
        expect(result.errors.join(' ')).not.toContain('pairing dropped');
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${mediaId} AND provider = 'jellyfin' AND source = 'watch-sync-file' AND external_id = ${remoteId}`,
        ).toHaveLength(1);
        expect(await pending()).toBe(1);
    });

    it('never drops an ID-based Jellyfin link on 404, even when the lookup says the item is gone', async () => {
        await sql`DELETE FROM external_ids WHERE media_id = ${mediaId}`;
        await createCatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(mediaId, {
            provider: 'jellyfin',
            id: remoteId,
            mediaType: 'movie',
            source: 'test',
        });
        http.post.mockImplementation(async (url: string) => {
            if (url.includes(remoteId)) throw { response: { status: 404 }, message: 'not found' };
            return { data: {} };
        });
        const get = http.get.getMockImplementation()!;
        http.get.mockImplementation(async (url: string, options?: unknown) => {
            const params = (options as { params?: { Ids?: string } } | undefined)?.params;
            if (url.endsWith('/Items') && params?.Ids === remoteId)
                return { data: { Items: [], TotalRecordCount: 0 } };
            return get(url, options);
        });
        await offline();
        const [result] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(result).toMatchObject({ succeeded: 0, failed: 1 });
        expect(result.errors.join(' ')).not.toContain('pairing dropped');
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${mediaId} AND provider = 'jellyfin' AND source = 'test' AND external_id = ${remoteId}`,
        ).toHaveLength(1);
        expect(await pending()).toBe(1);
    });

    it('continues native ID-based push when inventory HTTP fails and retains file links', async () => {
        const [other] =
            await sql`INSERT INTO media_items (title, media_type, status) VALUES ('Other file-paired movie', 'movie', 'active') RETURNING id`;
        await createCatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(
            other.id as string,
            {
                provider: 'jellyfin',
                id: 'c'.repeat(32),
                mediaType: 'movie',
                source: 'watch-sync-file',
            },
        );
        const get = http.get.getMockImplementation()!;
        http.get.mockImplementation(async (url: string, options?: unknown) => {
            if (url.endsWith('/Library/VirtualFolders')) throw new Error('inventory unavailable');
            return get(url, options);
        });
        await offline();
        await jellyfinFileInventoryTask.execute(mockContext({ input: {}, sql }));
        const [result] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(result.errors).toEqual([]);
        expect(result.succeeded).toBe(1);
        expect(http.get.mock.calls.some(([url]) => url.endsWith('/Library/VirtualFolders'))).toBe(
            true,
        );
        expect(
            await sql`SELECT * FROM external_ids WHERE media_id = ${other.id} AND source = 'watch-sync-file'`,
        ).toHaveLength(1);
        expect(await pending()).toBe(0);
    });

    it('reports a clean scheduled task success after resolving and pushing a partial', async () => {
        await offline();
        const result = await watchSyncPushTask.execute(mockContext({ input: {}, sql }));
        expect(result.success).toBe(true);
        expect(result.result).toMatchObject({
            totalSucceeded: 1,
            totalSkipped: 0,
            totalFailed: 0,
            allErrors: [],
        });
    });

    it('pushes live-session progress through the same position-only lane', async () => {
        expect(
            await watchManager.reportProgress(
                {
                    userId,
                    mediaId,
                    mediaType: 'movie',
                    positionMs: 36_009,
                    runtimeMs: 90_023,
                    sessionId: crypto.randomUUID(),
                    eventSeq: 1,
                    sessionElapsedMs: 36_009,
                },
                sql,
            ),
        ).toBe('accepted');
        const [result] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(result.succeeded).toBe(1);
        expect(http.post.mock.calls[0]?.[1]).toEqual({ PlaybackPositionTicks: 360_090_000 });
        expect(http.delete).not.toHaveBeenCalled();
        expect(await pending()).toBe(0);
    });

    it('resolves an identified episode through its series and episode number', async () => {
        const [series] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status) VALUES ('Breaking Bad', 'tv', 'active') RETURNING id`;
        const [season] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, parent_id, season_number, status) VALUES ('Season 1', 'season', ${series.id}, 1, 'active') RETURNING id`;
        const catalog = createCatalogService(sql, { skipLifecycleHooks: true });
        await catalog.deleteExternalId(mediaId, 'tmdb', 'movie');
        await sql`UPDATE media_items SET media_type = 'episode', parent_id = ${season.id}, season_number = 1, episode_number = 1 WHERE id = ${mediaId}`;
        await catalog.upsertExternalId(series.id, {
            provider: 'tmdb',
            id: '1396',
            mediaType: 'tv',
            source: 'test',
        });
        await catalog.upsertExternalId(mediaId, {
            provider: 'tmdb',
            id: '62085',
            mediaType: 'episode',
            source: 'test',
        });
        const get = http.get.getMockImplementation()!;
        http.get.mockImplementation(
            async (url: string, opts?: { params?: { IncludeItemTypes?: string } }) => {
                if (url.includes('/Shows/'))
                    return { data: { Items: [{ Id: remoteId, IndexNumber: 1 }] } };
                if (opts?.params?.IncludeItemTypes === 'Series')
                    return {
                        data: {
                            Items: [
                                {
                                    Id: 'c'.repeat(32),
                                    Type: 'Series',
                                    ProviderIds: { Tmdb: '1396' },
                                },
                            ],
                        },
                    };
                return get(url, opts);
            },
        );
        await offline(58_037, 145_092);
        const [result] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(result).toMatchObject({ succeeded: 1, skipped: 0 });
        expect(http.post.mock.calls[0]?.[1]).toEqual({ PlaybackPositionTicks: 580_370_000 });
        expect(http.delete).not.toHaveBeenCalled();
    });

    it('keeps partial positions and upstream user IDs isolated for two users', async () => {
        const firstUser = userId;
        await offline();
        userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const secondRemoteUser = 'd'.repeat(32);
        remoteUsers.push({ Id: secondRemoteUser, Name: derivedUsername(userId) });
        await sql`UPDATE users SET jellyfin_user_id = ${secondRemoteUser} WHERE id = ${userId}`;
        await offline(45_012);
        const [result] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(result.succeeded).toBe(2);
        expect(http.post).toHaveBeenCalledWith(
            `http://jellyfin.test/UserItems/${remoteId}/UserData?userId=${remoteUserId}`,
            { PlaybackPositionTicks: 360_090_000 },
            expect.anything(),
        );
        expect(http.post).toHaveBeenCalledWith(
            `http://jellyfin.test/UserItems/${remoteId}/UserData?userId=${secondRemoteUser}`,
            { PlaybackPositionTicks: 450_120_000 },
            expect.anything(),
        );
        expect((await getState.one(sql, { userId: firstUser, mediaId }))?.resume_position_ms).toBe(
            36_009,
        );
        expect(await pending()).toBe(0);
    });

    it('does not require a known runtime to push a valid resume position', async () => {
        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            source: 'lumastra-player',
            event_type: 'progress',
            position_ms: 36_009,
            runtime_ms: null,
            source_event_id: null,
            session_id: null,
            event_seq: null,
            occurred_at: new Date().toISOString(),
        });
        const [result] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(result.succeeded).toBe(1);
        expect(http.post.mock.calls[0]?.[1]).toEqual({ PlaybackPositionTicks: 360_090_000 });
    });

    it('retains progress when user mapping is missing and retries after mapping is restored', async () => {
        await sql`UPDATE users SET jellyfin_user_id = NULL WHERE id = ${userId}`;
        await offline();
        const [first] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(first.failed).toBe(1);
        expect(first.errors.join(' ')).toMatch(/user mapping.*retry/i);
        expect(await pending()).toBe(1);
        await sql`UPDATE users SET jellyfin_user_id = ${remoteUserId} WHERE id = ${userId}`;
        await sql`UPDATE user_media_events SET sync_delivery = '{}' WHERE user_id = ${userId}`;
        const [second] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(second.succeeded).toBe(1);
        expect(await pending()).toBe(0);
    });

    it('retains an unresolved partial, explains the skip, and retries after the item appears', async () => {
        await offline();
        found = false;
        const [first] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(first.skipped).toBe(1);
        expect(first.errors).toEqual([]);
        expect(await sql`SELECT error FROM watch_sync_activity WHERE user_id = ${userId}`).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ error: expect.stringMatching(/no provider id.*retry/i) }),
            ]),
        );
        expect(await pending()).toBe(1);
        found = true;
        await sql`UPDATE user_media_events SET sync_delivery = '{}' WHERE user_id = ${userId}`;
        const [second] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(second.succeeded).toBe(1);
        expect(await pending()).toBe(0);
    });

    it('reports an unpaired skip without failing the scheduled push task', async () => {
        await offline();
        found = false;
        const result = await watchSyncPushTask.execute(mockContext({ input: {}, sql }));
        expect(result.success).toBe(true);
        expect(result.result?.allErrors).toEqual([]);
        expect(result.result?.totalSkipped).toBe(1);
        expect(await pending()).toBe(1);
    });

    it('keeps an unresolved full page retryable without starving the following paired item', async () => {
        const blocked = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            SELECT 'Unpaired ' || n, 'movie', 'active' FROM generate_series(1, 200) AS n
            RETURNING id
        `;
        for (const item of blocked) {
            await appendEventAndRebuild(sql, {
                user_id: userId,
                media_id: item.id,
                event_type: 'progress',
                source: 'lumastra-player',
                position_ms: 36_009,
                runtime_ms: 90_023,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: '2026-10-27T20:00:00.000Z',
            });
        }
        await offline();
        const [result] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(result).toMatchObject({ processed: 201, succeeded: 1, skipped: 200 });
        expect(await pending()).toBe(200);
        // The manual/linked-user scope uses the second SQL branch; exclusions
        // must apply there too without acknowledging any of the held events.
        const scoped = await getUnpushedLumastraItems.all(sql, {
            provider: 'jellyfin',
            limit: 200,
            userScopes: [{ userId, since: null }],
            excludeKeys: blocked.slice(0, 199).map((i) => `${userId}:${i.id}`),
        });
        expect(scoped.map((i) => i.media_id)).toEqual([blocked[199].id]);
        expect(http.post).toHaveBeenCalledTimes(1);
    });

    it.each([401, 403, 404, 500])(
        'retains a failed UserData write (HTTP %s) and retries',
        async (status) => {
            await offline();
            await createCatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(
                mediaId,
                {
                    provider: 'jellyfin',
                    id: remoteId,
                    mediaType: 'movie',
                    source: 'test',
                },
            );
            http.post.mockRejectedValue(
                Object.assign(new Error(`UserData HTTP ${status}`), { response: { status } }),
            );
            const [first] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
            expect(first).toMatchObject({ succeeded: 0, failed: 1 });
            expect(first.errors.join(' ')).toContain('UserData');
            expect(await pending()).toBe(1);
            http.post.mockResolvedValue({ data: {} });
            await sql`UPDATE user_media_events SET sync_delivery = '{}' WHERE user_id = ${userId}`;
            const [second] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
            expect(second.succeeded).toBe(1);
            expect(await pending()).toBe(0);
        },
    );

    it.each([false, true])(
        'arbitrates upstream played against an acknowledged local reset (after acknowledgement: %s)',
        async (afterAcknowledgement) => {
            await sql`UPDATE media_items SET media_type = 'episode', season_number = 1, episode_number = 1 WHERE id = ${mediaId}`;
            await createCatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(
                mediaId,
                {
                    provider: 'jellyfin',
                    id: remoteId,
                    mediaType: 'episode',
                    source: 'test',
                },
            );
            const mark = async (
                event_type: 'mark_watched' | 'mark_unwatched',
                occurred_at: string,
            ) =>
                appendEventAndRebuild(sql, {
                    user_id: userId,
                    media_id: mediaId,
                    event_type,
                    source: 'lumastra-user-mark',
                    position_ms: null,
                    runtime_ms: 145_092,
                    source_event_id: null,
                    session_id: null,
                    event_seq: null,
                    occurred_at,
                });
            await mark('mark_watched', '2026-10-28T22:06:38.185Z');
            await mark('mark_unwatched', '2026-10-28T22:06:38.815Z');
            await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
            let upstreamPlayedAt = '2026-10-28T22:06:39.2958639Z';
            http.get.mockImplementation(
                async (url: string, opts?: { params?: { includeItemTypes?: string } }) => {
                    if (url.endsWith('/Library/VirtualFolders')) return { data: [] };
                    if (url.endsWith('/Users')) return { data: remoteUsers };
                    if (url.endsWith('/Sessions')) return { data: [] };
                    const items =
                        url.endsWith('/Items') && opts?.params?.includeItemTypes === 'Episode'
                            ? [
                                  {
                                      Id: remoteId,
                                      Type: 'Episode',
                                      Name: 'Pilot',
                                      ParentIndexNumber: 1,
                                      IndexNumber: 1,
                                      RunTimeTicks: 1_450_920_000,
                                      UserData: {
                                          Played: true,
                                          PlayCount: 1,
                                          PlaybackPositionTicks: 0,
                                          LastPlayedDate: upstreamPlayedAt,
                                      },
                                  },
                              ]
                            : [];
                    return { data: { Items: items, TotalRecordCount: items.length } };
                },
            );
            if (afterAcknowledgement) {
                // The provider already reported Played before the new act.
                // Its later date must pass the source's convergence gate too.
                await watchSyncEngine.runPull(jellyfinWatchSync.id, undefined, sql);
                expect((await getState.one(sql, { userId, mediaId }))?.is_watched).toBe(false);
                upstreamPlayedAt = new Date(Date.now() + 5000).toISOString();
            }
            for (let i = 0; i < 2; i++) {
                const [result] = await watchSyncEngine.runPull(
                    jellyfinWatchSync.id,
                    undefined,
                    sql,
                );
                expect(result.totalUpserted).toBe(1);
                if (!afterAcknowledgement)
                    expect(JSON.stringify(result)).toMatch(
                        /lost.*arbitration.*lumastra-user-mark/i,
                    );
                expect(await getState.one(sql, { userId, mediaId })).toMatchObject({
                    is_watched: afterAcknowledgement,
                    resume_position_ms: 0,
                });
            }
            if (afterAcknowledgement) return;
            const taskResult = await watchSyncPullTask.execute(mockContext({ input: {}, sql }));
            expect(taskResult.result?.summary).toContain('1 lost arbitration');
            expect(taskResult.result?.meta.totalLostArbitration).toBe(1);
            expect(taskResult.result?.meta.arbitrationLosses[0]?.reason).toMatch(
                /lumastra-user-mark/,
            );
            const [events] = await sql<
                { count: number }[]
            >`SELECT count(*)::int AS count FROM user_media_events WHERE source = 'jellyfin-sync' AND media_id = ${mediaId} AND event_type = 'mark_watched'`;
            expect(events.count).toBe(1);
        },
    );
    it('backs off unresolved Jellyfin titles across runs without another resolver call', async () => {
        await offline();
        found = false;
        await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        http.get.mockClear();
        const [second] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(second).toMatchObject({ processed: 0, failed: 0, errors: [] });
        expect(http.get.mock.calls.filter(([url]) => String(url).includes('/Items'))).toHaveLength(
            0,
        );
    });

    it('reports a persistent write failure once, backs off, and keeps the reason durable', async () => {
        await offline();
        http.post.mockRejectedValue(
            Object.assign(new Error('UserData HTTP 403'), { response: { status: 403 } }),
        );
        const [first] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(first.failed).toBe(1);
        const count = http.post.mock.calls.length;
        const [second] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(second).toMatchObject({ processed: 0, failed: 0, errors: [] });
        expect(http.post).toHaveBeenCalledTimes(count);
        await sql`UPDATE user_media_events SET sync_delivery = jsonb_set(sync_delivery, '{jellyfin,next_attempt_at}', to_jsonb(now() - INTERVAL '1 minute')) WHERE user_id = ${userId}`;
        const [third] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(third).toMatchObject({ processed: 1, skipped: 1, failed: 0, errors: [] });
        expect(http.post).toHaveBeenCalledTimes(count + 1);
        const [retry] =
            await sql`SELECT sync_delivery -> 'jellyfin' AS delivery FROM user_media_events WHERE user_id = ${userId} LIMIT 1`;
        expect(retry.delivery).toMatchObject({
            attempts: 2,
            last_reason: expect.stringContaining('403'),
        });
    });

    it('does not fetch an inventory inline before an ID-based push', async () => {
        await offline();
        const [result] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(result.succeeded).toBe(1);
        expect(
            http.get.mock.calls.some(([url]) => String(url).includes('/Library/VirtualFolders')),
        ).toBe(false);
    });

    it.each(['progress', 'mark_watched'] as const)(
        'drains non-resolvable ABS %s once without errors',
        async (event_type) => {
            const id = 'review-abs-watch-sync';
            const resolveIds = vi.fn(async () => []);
            const push = vi.fn(async () => ({
                succeeded: 0,
                failed: 0,
                skipped: 0,
                staleIds: [],
                errors: [],
                successful: [],
                drainedAsSkipped: [],
            }));
            if (!registry.getAllWatchSyncs().some((p) => p.id === id))
                registry.registerWatchSync({
                    id,
                    name: 'Review ABS',
                    version: '1.0.0',
                    capabilities: {},
                    providerName: 'audiobookshelf',
                    isAvailable: async () => true,
                    listLinkedUsers: async () => [userId],
                    resolveIds,
                    pushWatchState: push,
                });
            else {
                const plugin = registry.getAllWatchSyncs().find((p) => p.id === id)!;
                plugin.listLinkedUsers = async () => [userId];
                plugin.resolveIds = resolveIds;
                plugin.pushWatchState = push;
            }
            await appendEventAndRebuild(sql, {
                user_id: userId,
                media_id: mediaId,
                event_type,
                source: 'lumastra-user-mark',
                position_ms: event_type === 'progress' ? 5000 : null,
                runtime_ms: 60000,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: new Date().toISOString(),
            });
            const [first] = await watchSyncEngine.runPush(id, undefined, sql);
            expect(first).toMatchObject({ skipped: 1, failed: 0, errors: [] });
            expect(resolveIds).not.toHaveBeenCalled();
            expect(push).not.toHaveBeenCalled();
            expect(
                await getUnpushedLumastraItems.all(sql, { provider: 'audiobookshelf', limit: 200 }),
            ).toHaveLength(0);
        },
    );

    it.each(['progress', 'mark_watched'] as const)(
        'records a benign provider terminal %s drain without making the task red',
        async (kind) => {
            if (kind === 'progress') await offline();
            else
                await appendEventAndRebuild(sql, {
                    user_id: userId,
                    media_id: mediaId,
                    event_type: kind,
                    source: 'lumastra-user-mark',
                    position_ms: null,
                    runtime_ms: 60000,
                    source_event_id: null,
                    session_id: null,
                    event_seq: null,
                    occurred_at: new Date().toISOString(),
                });
            const plugin = registry.getAllWatchSyncs().find((p) => p.id === jellyfinWatchSync.id)!;
            const spy = vi
                .spyOn(plugin, kind === 'progress' ? 'pushResumePosition' : 'pushWatchState')
                .mockImplementation(
                    async (
                        _ctx: PluginContext,
                        items: Array<ResumePositionItem | WatchStateChange>,
                    ) => ({
                        succeeded: 0,
                        failed: 0,
                        skipped: items.length,
                        staleIds: [],
                        errors: [],
                        successful: [],
                        drainedAsSkipped: items.map((i) => ({
                            username: i.username,
                            mediaId: i.mediaId,
                        })),
                    }),
                );
            try {
                const [result] = await watchSyncEngine.runPush(plugin.id, undefined, sql);
                expect(result).toMatchObject({ skipped: 1, failed: 0, errors: [] });
            } finally {
                spy.mockRestore();
            }
        },
    );
    it('reports only a new failure when a batch also retries an already-reported record', async () => {
        const mark = async (id: string): Promise<void> => {
            await appendEventAndRebuild(sql, {
                user_id: userId,
                media_id: id,
                event_type: 'mark_unwatched',
                source: 'lumastra-user-mark',
                position_ms: null,
                runtime_ms: 60000,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: new Date().toISOString(),
            });
        };
        await createCatalogService(sql).upsertExternalId(mediaId, {
            provider: 'jellyfin',
            id: remoteId,
            mediaType: 'movie',
            source: 'test',
        });
        await mark(mediaId);
        http.delete.mockRejectedValue(
            Object.assign(new Error('old failure'), { response: { status: 403 } }),
        );
        await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        await sql`UPDATE user_media_events SET sync_delivery = jsonb_set(sync_delivery, '{jellyfin,next_attempt_at}', to_jsonb(now() - INTERVAL '1 minute')) WHERE user_id = ${userId}`;
        const second = await createAndInsertTestMovie(sql);
        const secondRemote = 'c'.repeat(32);
        await createCatalogService(sql).deleteExternalId(second.id, 'jellyfin', 'movie');
        await createCatalogService(sql).upsertExternalId(second.id, {
            provider: 'jellyfin',
            id: secondRemote,
            mediaType: 'movie',
            source: 'test',
        });
        await mark(second.id);
        http.delete.mockImplementation(async (url: string) => {
            throw Object.assign(
                new Error(url.endsWith(secondRemote) ? 'new failure' : 'old failure'),
                { response: { status: 403 } },
            );
        });
        const [result] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
        expect(result).toMatchObject({ processed: 2, failed: 1, skipped: 1 });
        expect(result.errors.join(' ')).toContain('new failure');
        expect(result.errors.join(' ')).not.toContain('old failure');
    });
});
