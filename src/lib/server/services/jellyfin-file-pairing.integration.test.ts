// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { WatchSyncDefinition, WatchStatePullItem } from '@sapd/lumastra-plugin-sdk';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
    derivedUsername,
} from '../../../../tests/integration/fixtures/index.js';
import { registry } from '../tasks/registry.js';
import { keepPersonalMediaItem } from '../database/queries/unmatched-files.queries.js';
import {
    countAdminMediaItems,
    getMediaBrowserStats,
    listAdminMediaItems,
} from '../database/queries/admin-media.queries.js';
import { issuesForAdminRow } from './admin-media-issues.js';
import {
    getPersonalMediaLibraryGroups,
    countPersonalMediaItems,
} from '../database/queries/media-items.queries.js';
import { createCatalogService } from './catalog.service.js';
import { features } from '../config.js';
import { getJellyfinPairingStatus } from './jellyfin-pairing-status.service.js';
import { getLinkedJellyfinUsers } from '../database/queries/jellyfin-file-pairing.queries.js';
import { listPersonalMediaItems } from '../database/queries/media-items.queries.js';
import { refreshJellyfinFilePairings } from './jellyfin-file-pairing.service.js';
import { appendEventAndRebuild } from './watch-state-rebuilder.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import { INVARIANTS } from './health-invariants/invariants.js';
import { watchSyncEngine } from './watch-sync-engine.service.js';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../jellyfin/retry.js', () => ({
    withJellyfinRetry: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../jellyfin/user.service.js', () => ({
    jellyfinUserService: {
        getAxiosInstance: () => api,
        getBaseUrl: () => 'http://jellyfin.test',
        getApiToken: () => 'test-token',
    },
}));

const PROVIDER = 'jellyfin-watch-sync';
const REMOTE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe.skipIf(!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL)(
    'Jellyfin physical file pairing',
    () => {
        let sql: postgres.Sql;
        let pulled: WatchStatePullItem[];
        let remoteItems: Array<{
            Id: string;
            Type: string;
            Name: string;
            Path: string;
            MediaSources: Array<{ Path: string; Size: number }>;
            ProviderIds?: { Tmdb?: string; Imdb?: string };
            IndexNumber?: number;
            IndexNumberEnd?: number;
        }>;
        let userId: string;
        let linkedUsers: string[];
        const pushed = vi.fn();
        const positions = vi.fn();
        beforeAll(() => {
            sql = getTestDb();
        });
        afterAll(async () => {
            await closeTestDb();
        });
        beforeEach(async () => {
            await truncateTables(sql, [
                'jellyfin_file_inventory',
                'media_files',
                'media_items',
                'library_groups',
                'library_paths',
                'watch_state_pending_resolution',
                'watch_sync_activity',
                'watch_state_pull_log',
                'user_media_events',
                'user_media_state',
            ]);
            vi.spyOn(features, 'jellyfinSync', 'get').mockReturnValue(true);
            remoteItems = [
                {
                    Id: REMOTE_ID,
                    Type: 'Movie',
                    Name: 'Personal film',
                    Path: '/media/movies/Holiday/Film.mkv',
                    MediaSources: [{ Path: '/media/movies/Holiday/Film.mkv', Size: 1234 }],
                },
            ];
            pushed.mockReset();
            positions.mockReset();
            api.get.mockImplementation(
                async (url: string, options?: { params?: { Ids?: string } }) => ({
                    data: url.endsWith('/Library/VirtualFolders')
                        ? [{ ItemId: 'library', Locations: ['/media/movies'] }]
                        : {
                              Items: options?.params?.Ids
                                  ? remoteItems.filter((item) =>
                                        options.params!.Ids!.split(',').includes(item.Id),
                                    )
                                  : remoteItems,
                              TotalRecordCount: remoteItems.length,
                          },
                }),
            );
            userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            linkedUsers = [userId];
            pulled = [
                {
                    providerId: REMOTE_ID,
                    tmdbId: null,
                    imdbId: null,
                    mediaType: 'movie',
                    isWatched: true,
                    resumePositionMs: 0,
                    runtimeMs: 60000,
                    watchCount: 1,
                    providerUsername: derivedUsername(userId),
                    title: 'Personal film',
                    lastWatchedAt: new Date(),
                },
            ];
            if (!registry.getAllWatchSyncs().some((p) => p.id === PROVIDER))
                registry.registerWatchSync({
                    id: PROVIDER,
                    name: 'Jellyfin file seam',
                    version: '1.0.0',
                    capabilities: { http: true },
                    providerName: 'jellyfin',
                    isAvailable: async () => true,
                    listLinkedUsers: async () => linkedUsers,
                    resolveIds: async () => [],
                    pullWatchState: async () => ({
                        items: pulled,
                        errors: [],
                        newCursors: new Map(),
                    }),
                    pushWatchState: async (_ctx, items) => {
                        pushed(items);
                        return {
                            succeeded: items.length,
                            failed: 0,
                            skipped: 0,
                            staleIds: [],
                            errors: [],
                            successful: items.map((item) => ({
                                username: item.username,
                                mediaId: item.mediaId,
                            })),
                            drainedAsSkipped: [],
                        };
                    },
                    pushResumePosition: async (_ctx, items) => {
                        positions(items);
                        return {
                            succeeded: items.length,
                            failed: 0,
                            skipped: 0,
                            staleIds: [],
                            errors: [],
                            successful: items.map((item) => ({
                                username: item.username,
                                mediaId: item.mediaId,
                            })),
                            drainedAsSkipped: [],
                        };
                    },
                } satisfies WatchSyncDefinition);
        });

        async function runPull(
            ...args: Parameters<typeof watchSyncEngine.runPull>
        ): ReturnType<typeof watchSyncEngine.runPull> {
            await refreshJellyfinFilePairings(
                sql,
                undefined,
                pulled.map((item) => item.providerId),
            );
            return watchSyncEngine.runPull(...args);
        }
        async function runPush(
            ...args: Parameters<typeof watchSyncEngine.runPush>
        ): ReturnType<typeof watchSyncEngine.runPush> {
            await refreshJellyfinFilePairings(sql);
            return watchSyncEngine.runPush(...args);
        }

        async function addFile(
            root = '/data/movies',
            mediaType: 'movie' | 'episode' = 'movie',
        ): Promise<string> {
            const [group] =
                await sql`INSERT INTO library_groups (name) VALUES (${root}) RETURNING id`;
            const [library] =
                await sql`INSERT INTO library_paths (path, media_type, library_group_id) VALUES (${root}, 'movie', ${group.id}) RETURNING library_group_id`;
            const [media] =
                await sql`INSERT INTO media_items (title, media_type, has_files, status) VALUES ('Personal film', ${mediaType}, true, 'active') RETURNING id`;
            const [file] =
                await sql`INSERT INTO media_files (file_path, file_size_bytes, library_group_id) VALUES (${root + '/Holiday/Film.mkv'}, 1234, ${library.library_group_id}) RETURNING id`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${file.id}, ${media.id}, true)`;
            return media.id as string;
        }

        async function expireInventory(): Promise<void> {
            await sql`UPDATE jellyfin_file_inventory SET attempted_at = now() - INTERVAL '31 minutes'`;
        }

        it('clears an id-free series Jellyfin issue after its episode file pairs', async () => {
            const episodeId = await addFile('/data/movies', 'episode');
            const [series] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, year, media_type, has_files, status)
                VALUES ('Personal series', 2020, 'tv', true, 'active') RETURNING id`;
            const [season] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, parent_id, status)
                VALUES ('Season 1', 'season', ${series.id}, 'active') RETURNING id`;
            await sql`UPDATE media_items SET parent_id = ${season.id} WHERE id = ${episodeId}`;
            remoteItems[0].Type = 'Episode';
            const options = {
                types: ['tv'],
                itemIds: [series.id],
                issue: 'not_in_jellyfin' as const,
            };
            expect(await countAdminMediaItems(sql, options)).toBe(1);
            const refresh = await refreshJellyfinFilePairings(sql);
            expect(refresh.changedPairings).toBe(true);
            const links = await sql<{ media_id: string; external_id: string }[]>`
                SELECT media_id, external_id FROM external_ids WHERE provider = 'jellyfin'`;
            expect(links).toEqual([{ media_id: episodeId, external_id: REMOTE_ID }]);
            expect(await countAdminMediaItems(sql, options)).toBe(0);
            const [row] = await listAdminMediaItems(sql, { types: ['tv'], limit: 50, offset: 0 });
            expect(row.jellyfin_id).toBeNull();
            expect(issuesForAdminRow(row, true).map((issue) => issue.kind)).not.toContain(
                'not_in_jellyfin',
            );
        });

        it('imports an id-free personal film by its relative path across different roots', async () => {
            const mediaId = await addFile();
            const [result] = await runPull(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(result.totalUpserted).toBe(1);
            expect(result.totalSkippedNoMatch).toBe(0);
            const states =
                await sql`SELECT media_id, is_watched FROM user_media_state WHERE media_id = ${mediaId}`;
            expect(states).toMatchObject([{ media_id: mediaId, is_watched: true }]);
            const ids =
                await sql`SELECT provider, external_id FROM external_ids WHERE media_id = ${mediaId}`;
            expect(ids).toEqual([{ provider: 'jellyfin', external_id: REMOTE_ID }]);
        });

        /**
         * Real Jellyfin lists items WITHOUT their media sources (no size); only an
         * `Ids` lookup returns them. The default fake above leaks sizes into the
         * listing, which hides every "size not known yet" problem.
         */
        function listWithoutSizes(): void {
            api.get.mockImplementation(
                async (url: string, options?: { params?: { Ids?: string } }) => ({
                    data: url.endsWith('/Library/VirtualFolders')
                        ? [{ ItemId: 'library', Locations: ['/media/movies'] }]
                        : {
                              Items: options?.params?.Ids
                                  ? remoteItems.filter((item) =>
                                        options.params!.Ids!.split(',').includes(item.Id),
                                    )
                                  : remoteItems.map(({ MediaSources: _sources, ...item }) => item),
                              TotalRecordCount: remoteItems.length,
                          },
                }),
            );
        }
        async function jellyfinLinks(mediaId: string) {
            return sql`SELECT provider, external_id FROM external_ids WHERE media_id = ${mediaId} AND provider = 'jellyfin'`;
        }

        it('pairs an episode that was scanned after the inventory was cached, without waiting for the next full inventory', async () => {
            // Fresh install: the Jellyfin inventory runs while Lumastra is still
            // ingesting the series, so the cached inventory has no sizes for it.
            listWithoutSizes();
            remoteItems[0].Type = 'Episode';
            pulled[0].mediaType = 'episode';
            await refreshJellyfinFilePairings(sql, undefined, [REMOTE_ID]);
            const episodeId = await addFile('/data/movies', 'episode');
            // Still inside the 30-minute inventory throttle.
            const result = await refreshJellyfinFilePairings(sql, undefined, [REMOTE_ID]);
            expect(result.changedPairings).toBe(true);
            expect(await jellyfinLinks(episodeId)).toEqual([
                { provider: 'jellyfin', external_id: REMOTE_ID },
            ]);
        });

        it('re-compares a cached inventory when an id-less local file appears, even with no incoming play', async () => {
            listWithoutSizes();
            remoteItems[0].Type = 'Episode';
            await refreshJellyfinFilePairings(sql, undefined, [REMOTE_ID]);
            const episodeId = await addFile('/data/movies', 'episode');
            // Scheduled export/import cycle: nothing is incoming, nothing is pending.
            await refreshJellyfinFilePairings(sql);
            expect(await jellyfinLinks(episodeId)).toEqual([
                { provider: 'jellyfin', external_id: REMOTE_ID },
            ]);
        });

        it('retries a failed size lookup on the next cycle instead of remembering it as done', async () => {
            listWithoutSizes();
            remoteItems[0].Type = 'Episode';
            await refreshJellyfinFilePairings(sql, undefined, [REMOTE_ID]);
            const episodeId = await addFile('/data/movies', 'episode');
            const listing = api.get.getMockImplementation()!;
            let failing = true;
            api.get.mockImplementation(
                async (url: string, options?: { params?: { Ids?: string } }) => {
                    if (failing && options?.params?.Ids) throw new Error('Jellyfin is restarting');
                    return listing(url, options);
                },
            );
            await refreshJellyfinFilePairings(sql);
            expect(await jellyfinLinks(episodeId)).toEqual([]);
            failing = false;
            await refreshJellyfinFilePairings(sql);
            expect(await jellyfinLinks(episodeId)).toEqual([
                { provider: 'jellyfin', external_id: REMOTE_ID },
            ]);
        });

        it('pairs more size-less candidates than one lookup covers over consecutive cycles', async () => {
            const count = 520;
            const idOf = (n: number) => n.toString(16).padStart(32, '0');
            remoteItems = Array.from({ length: count }, (_, n) => ({
                Id: idOf(n + 1),
                Type: 'Episode',
                Name: `Episode ${n}`,
                Path: `/media/movies/Show/E${n}.mkv`,
                MediaSources: [{ Path: `/media/movies/Show/E${n}.mkv`, Size: 1000 + n }],
            }));
            listWithoutSizes();
            await refreshJellyfinFilePairings(sql, undefined, [idOf(1)]);
            const [group] =
                await sql`INSERT INTO library_groups (name) VALUES ('/data/movies') RETURNING id`;
            await sql`INSERT INTO library_paths (path, media_type, library_group_id) VALUES ('/data/movies', 'movie', ${group.id})`;
            for (let n = 0; n < count; n++) {
                const [media] =
                    await sql`INSERT INTO media_items (title, media_type, has_files, status) VALUES (${'Episode ' + n}, 'episode', true, 'active') RETURNING id`;
                const [file] =
                    await sql`INSERT INTO media_files (file_path, file_size_bytes, library_group_id) VALUES (${`/data/movies/Show/E${n}.mkv`}, ${1000 + n}, ${group.id}) RETURNING id`;
                await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${file.id}, ${media.id}, true)`;
            }
            const linked = async () =>
                (await sql`SELECT 1 FROM external_ids WHERE provider = 'jellyfin'`).length;
            await refreshJellyfinFilePairings(sql);
            expect(await linked()).toBeLessThan(count);
            await refreshJellyfinFilePairings(sql);
            expect(await linked()).toBe(count);
        });

        /** One file, two episodes (S01E03-E04), an ID-less series: the day-1 re-test fixture. */
        async function addSharedEpisodes(): Promise<{ series: string; e3: string; e4: string }> {
            const root = '/data/movies';
            const [group] =
                await sql`INSERT INTO library_groups (name) VALUES (${root}) RETURNING id`;
            await sql`INSERT INTO library_paths (path, media_type, library_group_id) VALUES (${root}, 'tv', ${group.id})`;
            const [series] =
                await sql`INSERT INTO media_items (title, media_type, status, has_files) VALUES ('Quillon Harbour', 'tv', 'active', true) RETURNING id`;
            const [season] =
                await sql`INSERT INTO media_items (title, media_type, status, parent_id, season_number) VALUES ('Season 1', 'season', 'active', ${series.id}, 1) RETURNING id`;
            const episode = async (n: number) =>
                (
                    await sql`INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number, episode_number) VALUES (${'Episode ' + n}, 'episode', 'active', true, ${season.id}, 1, ${n}) RETURNING id`
                )[0].id as string;
            const e3 = await episode(3);
            const e4 = await episode(4);
            const [file] =
                await sql`INSERT INTO media_files (file_path, file_size_bytes, library_group_id) VALUES (${root + '/Holiday/Film.mkv'}, 1234, ${group.id}) RETURNING id`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, start_offset_ms, end_offset_ms) VALUES (${file.id}, ${e3}, true, 0, 60000), (${file.id}, ${e4}, true, 60000, 120000)`;
            return { series: series.id as string, e3, e4 };
        }
        const REMOTE_E3 = 'e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3';
        const REMOTE_E4 = 'e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4';
        const remoteEpisode = (id: string, index: number, end?: number) => ({
            Id: id,
            Type: 'Episode',
            Name: `Episode ${index}`,
            Path: '/media/movies/Holiday/Film.mkv',
            MediaSources: [{ Path: '/media/movies/Holiday/Film.mkv', Size: 1234 }],
            ParentIndexNumber: 1,
            IndexNumber: index,
            ...(end ? { IndexNumberEnd: end } : {}),
        });
        const untaggedSeries = async () =>
            countAdminMediaItems(sql, { types: ['tv'], missingJf: true, unidentified: true });

        it('pairs each episode of a shared file with its own Jellyfin item when Jellyfin lists both', async () => {
            remoteItems = [remoteEpisode(REMOTE_E3, 3), remoteEpisode(REMOTE_E4, 4)];
            listWithoutSizes();
            const { e3, e4 } = await addSharedEpisodes();
            expect(await untaggedSeries()).toBe(1);
            await refreshJellyfinFilePairings(sql, undefined, [REMOTE_E3, REMOTE_E4]);
            expect(await jellyfinLinks(e3)).toEqual([
                { provider: 'jellyfin', external_id: REMOTE_E3 },
            ]);
            expect(await jellyfinLinks(e4)).toEqual([
                { provider: 'jellyfin', external_id: REMOTE_E4 },
            ]);
            expect(await untaggedSeries()).toBe(0);
        });

        it('pairs the first episode of a shared file with the one Jellyfin item that spans it, and a played mark covers both', async () => {
            remoteItems = [remoteEpisode(REMOTE_E3, 3, 4)];
            listWithoutSizes();
            const { e3, e4 } = await addSharedEpisodes();
            pulled = [
                {
                    ...pulled[0],
                    providerId: REMOTE_E3,
                    mediaType: 'episode',
                    runtimeMs: 120000,
                },
            ];
            const [result] = await runPull(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(result.totalUpserted).toBeGreaterThan(0);
            expect(await jellyfinLinks(e3)).toEqual([
                { provider: 'jellyfin', external_id: REMOTE_E3 },
            ]);
            expect(await jellyfinLinks(e4)).toEqual([]);
            const watched =
                await sql`SELECT media_id FROM user_media_state WHERE is_watched ORDER BY media_id`;
            expect(watched.map((r) => r.media_id).sort()).toEqual([e3, e4].sort());
            // The second half is covered by the first's link; neither is a finding.
            expect(await untaggedSeries()).toBe(0);
            expect(await getJellyfinPairingStatus(sql)).toMatchObject({ count: 0 });
        });

        const linkEpisode = (mediaId: string, id: string) =>
            createCatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(mediaId, {
                provider: 'jellyfin',
                id,
                mediaType: 'episode',
                source: 'watch-sync-file',
            });
        const mark = (mediaId: string, event_type: 'mark_watched' | 'mark_unwatched') =>
            appendEventAndRebuild(sql, {
                user_id: toUserId(userId),
                media_id: mediaId,
                event_type,
                source: 'lumastra-user-mark',
                position_ms: null,
                runtime_ms: 120000,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: new Date().toISOString(),
            });
        const pushedFlags = () =>
            pushed.mock.calls.flatMap(([items]) =>
                (items as Array<{ mediaId: string; isWatched: boolean }>).map((i) => [
                    i.mediaId,
                    i.isWatched,
                ]),
            );

        it('does not mark a whole shared file played in Jellyfin for the first episode alone, nor unplay it while the second is watched', async () => {
            remoteItems = [remoteEpisode(REMOTE_E3, 3, 4)];
            listWithoutSizes();
            const { e3, e4 } = await addSharedEpisodes();
            await linkEpisode(e3, REMOTE_E3);

            await mark(e3, 'mark_watched');
            await runPush(PROVIDER, undefined, sql);
            expect(pushedFlags()).toEqual([]);

            await mark(e4, 'mark_watched');
            await runPush(PROVIDER, undefined, sql);
            expect(pushedFlags()).toEqual([[e3, true]]);

            pushed.mockClear();
            await mark(e3, 'mark_unwatched');
            await runPush(PROVIDER, undefined, sql);
            expect(pushedFlags()).toEqual([]);

            await mark(e4, 'mark_unwatched');
            await runPush(PROVIDER, undefined, sql);
            expect(pushedFlags()).toEqual([[e3, false]]);
        });

        it('keeps a held unwatch local across pull cycles: the pull does not flip it back and the push does not loop', async () => {
            remoteItems = [remoteEpisode(REMOTE_E3, 3, 4)];
            listWithoutSizes();
            const { e3, e4 } = await addSharedEpisodes();
            await linkEpisode(e3, REMOTE_E3);
            await mark(e3, 'mark_watched');
            await mark(e4, 'mark_watched');
            await runPush(PROVIDER, undefined, sql);
            expect(pushedFlags()).toEqual([[e3, true]]);
            pushed.mockClear();

            // The user unmarks the first episode only: Jellyfin keeps the whole file played.
            await mark(e3, 'mark_unwatched');
            pulled = [
                {
                    ...pulled[0],
                    providerId: REMOTE_E3,
                    mediaType: 'episode',
                    isWatched: true,
                    runtimeMs: 120000,
                    lastWatchedAt: new Date(Date.now() + 5000),
                },
            ];
            const states = async () =>
                (
                    await sql`SELECT media_id, is_watched FROM user_media_state WHERE media_id IN (${e3}, ${e4}) ORDER BY media_id`
                ).map((r) => [r.media_id, r.is_watched]);
            const events = async () =>
                (
                    await sql`SELECT count(*)::int AS n FROM user_media_events WHERE media_id = ${e3}`
                )[0].n;
            const expected = [
                [e3, false],
                [e4, true],
            ].sort();
            let after = 0;
            for (let cycle = 0; cycle < 3; cycle++) {
                await runPush(PROVIDER, undefined, sql);
                await runPull(PROVIDER, undefined, sql);
                expect((await states()).sort()).toEqual(expected);
                expect(pushedFlags()).toEqual([]);
                if (cycle === 1) after = await events();
                if (cycle === 2) expect(await events()).toBe(after);
            }
        });

        it('judges a held push by the same user only: another user watching the later episode does not release it', async () => {
            remoteItems = [remoteEpisode(REMOTE_E3, 3, 4)];
            listWithoutSizes();
            const { e3, e4 } = await addSharedEpisodes();
            await linkEpisode(e3, REMOTE_E3);
            const other = generateTestUserId();
            await ensureTestUser(sql, other);
            await appendEventAndRebuild(sql, {
                user_id: other,
                media_id: e4,
                event_type: 'mark_watched',
                source: 'lumastra-user-mark',
                position_ms: null,
                runtime_ms: 120000,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: new Date().toISOString(),
            });
            await mark(e3, 'mark_watched');
            await runPush(PROVIDER, undefined, sql);
            expect(pushedFlags()).toEqual([]);
            await mark(e4, 'mark_watched');
            await runPush(PROVIDER, undefined, sql);
            expect(pushedFlags()).toEqual([[e3, true]]);
        });

        it('does not count an inactive earlier sibling as a link', async () => {
            const { e3, e4 } = await addSharedEpisodes();
            await linkEpisode(e3, REMOTE_E3);
            expect(await untaggedSeries()).toBe(0);
            await sql`DELETE FROM external_ids WHERE media_id = ${e3}`;
            await linkEpisode(e3, REMOTE_E3);
            await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${e3}`;
            // E03 no longer exists as an active episode, so E04 has no active earlier link.
            expect(await sql`SELECT 1 FROM media_items WHERE id = ${e4}`).toHaveLength(1);
            expect(await untaggedSeries()).toBe(1);
        });

        it('counts a later episode as linked through an earlier one, never the other way round', async () => {
            const { e3, e4 } = await addSharedEpisodes();
            await linkEpisode(e4, REMOTE_E4);
            // Only E04 is linked: the pull spreads forward, so E03 would never sync.
            expect(await untaggedSeries()).toBe(1);
            await sql`DELETE FROM external_ids WHERE media_id = ${e4}`;
            await linkEpisode(e3, REMOTE_E3);
            expect(await untaggedSeries()).toBe(0);
        });

        it('reports the first inventory and actual pairing changes, not a no-op refresh', async () => {
            await addFile();
            expect(await refreshJellyfinFilePairings(sql, undefined, [REMOTE_ID])).toMatchObject({
                firstInventory: true,
                changedPairings: true,
            });
            expect(await refreshJellyfinFilePairings(sql, undefined, [REMOTE_ID])).toMatchObject({
                firstInventory: false,
                changedPairings: false,
            });
        });

        it('buffers and counts an ambiguous file without importing it', async () => {
            await addFile();
            await addFile('/other/movies');
            const [result] = await runPull(PROVIDER, undefined, sql);
            expect(result.totalUpserted).toBe(0);
            expect(result.totalSkippedNoMatch).toBe(1);
            expect(result.totalBuffered).toBe(1);
            expect(result.notPaired).toBe(1);
            expect(await getJellyfinPairingStatus(sql)).toMatchObject({
                count: 1,
                examples: ['Personal film'],
            });
            expect(await sql`SELECT * FROM external_ids WHERE provider = 'jellyfin'`).toHaveLength(
                0,
            );
        });
        it('rejects a new remote duplicate even when only the original item is pulled', async () => {
            await addFile();
            await runPull(PROVIDER, undefined, sql);
            await expireInventory();
            remoteItems.push({ ...remoteItems[0], Id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
            const [result] = await runPull(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(result.totalSkippedNoMatch).toBe(1);
            expect(result.notPaired).toBe(1);
            expect(await sql`SELECT * FROM external_ids WHERE provider = 'jellyfin'`).toHaveLength(
                0,
            );
        });

        it('leaves a local combined file unmatched even if Jellyfin omits its episode range', async () => {
            const id = await addFile('/data/movies', 'episode');
            remoteItems[0].Type = 'Episode';
            pulled[0].mediaType = 'episode';
            const [sibling] =
                await sql`INSERT INTO media_items (title, media_type, has_files, status) VALUES ('Second episode', 'episode', true, 'active') RETURNING id`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) SELECT file_id, ${sibling.id} FROM media_file_items WHERE media_item_id = ${id}`;
            const [result] = await runPull(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(result.totalSkippedNoMatch).toBe(1);
            expect(result.notPaired).toBe(1);
        });

        it('keeps shared provider identities ahead of a conflicting file match', async () => {
            const fileTarget = await addFile();
            const [identified] =
                await sql`INSERT INTO media_items (title, media_type, status) VALUES ('Identified film', 'movie', 'active') RETURNING id`;
            await createCatalogService(sql).upsertExternalId(identified.id as string, {
                provider: 'tmdb',
                id: '1234567',
                mediaType: 'movie',
                source: 'manual',
            });
            await expireInventory();
            remoteItems[0].ProviderIds = { Tmdb: '1234567' };
            pulled[0].tmdbId = '1234567';
            const [result] = await runPull(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(result.totalUpserted).toBe(1);
            expect(
                await sql`SELECT media_id FROM user_media_state WHERE media_id = ${fileTarget}`,
            ).toHaveLength(0);
            expect(
                await sql`SELECT media_id FROM external_ids WHERE provider = 'jellyfin'`,
            ).toEqual([{ media_id: identified.id }]);
        });

        it('does not turn a sync-paired personal item into a metadata-identified item', async () => {
            const id = await addFile();
            await refreshJellyfinFilePairings(sql, undefined, [REMOTE_ID]);
            expect(await countAdminMediaItems(sql, { types: ['movie'], unidentified: true })).toBe(
                1,
            );
            expect((await getMediaBrowserStats(sql)).unidentified).toBe(1);
            expect(await getPersonalMediaLibraryGroups(sql)).toHaveLength(1);
            expect(await countPersonalMediaItems(sql)).toBe(1);
            expect(await listPersonalMediaItems(sql, { limit: 10, offset: 0 })).toHaveLength(1);
            expect(await keepPersonalMediaItem(sql, id, 'test')).toBe('kept');
            expect(await countPersonalMediaItems(sql, { disposition: 'kept' })).toBe(1);
        });

        it('keeps personal media kept while adding only a Jellyfin sync link', async () => {
            const id = await addFile();
            await sql`INSERT INTO personal_media_dispositions (media_id, disposition, decided_by) VALUES (${id}, 'kept', 'test')`;
            const [result] = await runPull(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(result.totalUpserted).toBe(1);
            expect(
                await sql`SELECT * FROM personal_media_dispositions WHERE media_id = ${id}`,
            ).toHaveLength(1);
            expect(await sql`SELECT provider FROM external_ids WHERE media_id = ${id}`).toEqual([
                { provider: 'jellyfin' },
            ]);
        });

        it.each(['path', 'size'] as const)(
            'invalidates the cached file link after a local %s change',
            async (change) => {
                const id = await addFile();
                await runPull(PROVIDER, undefined, sql);
                if (change === 'path')
                    await sql`UPDATE media_files SET file_path = '/data/movies/Replaced.mkv'`;
                else await sql`UPDATE media_files SET file_size_bytes = 9999`;
                const [result] = await runPull(PROVIDER, undefined, sql);
                expect(result.errors).toEqual([]);
                expect(result.totalSkippedNoMatch).toBe(1);
                expect(await sql`SELECT * FROM external_ids WHERE media_id = ${id}`).toHaveLength(
                    0,
                );
            },
        );

        it.each(['path', 'size'] as const)(
            'invalidates the cached file link after a remote %s change',
            async (change) => {
                await addFile();
                await runPull(PROVIDER, undefined, sql);
                await expireInventory();
                if (change === 'path') {
                    remoteItems[0].Path = '/media/movies/Replaced.mkv';
                    remoteItems[0].MediaSources[0].Path = '/media/movies/Replaced.mkv';
                } else remoteItems[0].MediaSources[0].Size = 9999;
                const [result] = await runPull(PROVIDER, undefined, sql);
                expect(result.totalSkippedNoMatch).toBe(1);
                expect(
                    await sql`SELECT * FROM external_ids WHERE provider = 'jellyfin'`,
                ).toHaveLength(0);
            },
        );

        it('imports a single episode and leaves combined files unmatched and counted', async () => {
            await addFile('/data/movies', 'episode');
            remoteItems[0].Type = 'Episode';
            pulled[0].mediaType = 'episode';
            const [first] = await runPull(PROVIDER, undefined, sql);
            expect(first.totalUpserted).toBe(1);
            await expireInventory();
            remoteItems[0].IndexNumber = 1;
            remoteItems[0].IndexNumberEnd = 2;
            const [combined] = await runPull(PROVIDER, undefined, sql);
            expect(combined.totalSkippedNoMatch).toBe(1);
            expect(combined.notPaired).toBe(1);
        });

        it('drains the pending buffer automatically once an ambiguity is removed', async () => {
            const target = await addFile();
            const duplicate = await addFile('/other/movies');
            await runPull(PROVIDER, undefined, sql);
            await sql`UPDATE media_files SET is_missing = true WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${duplicate})`;
            pulled = []; // No fresh provider history: recovery must come from the buffer.
            const [result] = await runPull(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(
                await sql`SELECT is_watched FROM user_media_state WHERE media_id = ${target}`,
            ).toEqual([{ is_watched: true }]);
            expect(await sql`SELECT * FROM watch_state_pending_resolution`).toHaveLength(0);
            expect(result.notPaired).toBe(0);
        });

        it('exposes a persistent warning and examples, then clears it after pairing', async () => {
            await addFile();
            const duplicate = await addFile('/other/movies');
            await runPull(PROVIDER, undefined, sql);
            const invariant = INVARIANTS.find(
                (entry) => entry.id === 'jellyfin-unpaired-watch-records',
            )!;
            expect(await invariant.query(sql)).toBe(0); // Allow normal first-scan latency.
            await sql`UPDATE watch_state_pending_resolution SET created_at = now() - INTERVAL '16 minutes'`;
            expect(await invariant.query(sql)).toBe(1);
            expect(await invariant.details!(sql)).toEqual([
                {
                    label: 'Personal film',
                    href: '/admin/settings/connections?category=conn-jellyfin',
                },
            ]);
            expect(invariant.thresholdAmber).toBe(0);
            await sql`UPDATE media_files SET is_missing = true WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${duplicate})`;
            pulled = [];
            await runPull(PROVIDER, undefined, sql);
            expect(await invariant.query(sql)).toBe(0);
            expect(await getJellyfinPairingStatus(sql)).toMatchObject({ count: 0, examples: [] });
        });

        async function localEvent(id: string, kind: 'mark_watched' | 'progress'): Promise<void> {
            await appendEventAndRebuild(sql, {
                user_id: toUserId(userId),
                media_id: id,
                event_type: kind,
                source: 'lumastra-offline',
                position_ms: kind === 'progress' ? 25000 : null,
                runtime_ms: 60000,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: new Date().toISOString(),
                session_elapsed_ms: kind === 'progress' ? 25000 : null,
            });
        }

        it.each(['mark_watched', 'progress'] as const)(
            'pushes an id-free %s after file pairing',
            async (kind) => {
                const id = await addFile();
                await localEvent(id, kind);
                const [result] = await runPush(PROVIDER, undefined, sql);
                expect(result.errors).toEqual([]);
                expect(result.notPaired).toBe(0);
                const calls = kind === 'progress' ? positions : pushed;
                expect(calls).toHaveBeenCalledWith([
                    expect.objectContaining({ providerId: REMOTE_ID, mediaId: id }),
                ]);
            },
        );

        it('counts previously skipped local records and retries them after a new pairing', async () => {
            const id = await addFile();
            const duplicate = await addFile('/other/movies');
            await localEvent(id, 'mark_watched');
            const [missed] = await runPush(PROVIDER, undefined, sql);
            expect(missed.errors).toEqual([]);
            expect(missed.notPaired).toBe(1);
            expect(await getJellyfinPairingStatus(sql)).toMatchObject({
                count: 1,
                examples: ['Personal film'],
            });
            expect(pushed).not.toHaveBeenCalled();
            await sql`UPDATE media_files SET is_missing = true WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${duplicate})`;
            const [recovered] = await runPush(PROVIDER, undefined, sql);
            expect(recovered.errors).toEqual([]);
            expect(recovered.succeeded).toBe(1);
            expect(pushed).toHaveBeenCalledWith([
                expect.objectContaining({ providerId: REMOTE_ID, mediaId: id }),
            ]);
        });

        it('replaces a file pairing when later shared ids identify a different item', async () => {
            const original = await addFile();
            await refreshJellyfinFilePairings(sql, undefined, [REMOTE_ID]);
            const [identified] =
                await sql`INSERT INTO media_items (title, media_type, status) VALUES ('Identified film', 'movie', 'active') RETURNING id`;
            await createCatalogService(sql).upsertExternalId(identified.id as string, {
                provider: 'tmdb',
                id: '1234567',
                mediaType: 'movie',
                source: 'manual',
            });
            await expireInventory();
            remoteItems[0].ProviderIds = { Tmdb: '1234567' };
            pulled[0].tmdbId = '1234567';
            const [result] = await runPull(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(result.totalUpserted).toBe(1);
            expect(
                await sql`SELECT * FROM external_ids WHERE provider = 'jellyfin' AND media_id = ${original}`,
            ).toHaveLength(0);
            expect(
                await sql`SELECT media_id FROM external_ids WHERE provider = 'jellyfin'`,
            ).toEqual([{ media_id: identified.id }]);
        });

        it('keeps a valid file pairing when matching metadata ids are added later', async () => {
            const id = await addFile();
            await refreshJellyfinFilePairings(sql, undefined, [REMOTE_ID]);
            await createCatalogService(sql).upsertExternalId(id, {
                provider: 'tmdb',
                id: '1234567',
                mediaType: 'movie',
                source: 'manual',
            });
            remoteItems[0].ProviderIds = { Tmdb: '1234567' };
            await localEvent(id, 'progress');
            const [result] = await runPush(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(result.notPaired).toBe(0);
            expect(positions).toHaveBeenCalledWith([
                expect.objectContaining({ providerId: REMOTE_ID, mediaId: id }),
            ]);
        });

        it('caches remote evidence for 30 minutes while still checking local files', async () => {
            await addFile();
            await runPull(PROVIDER, undefined, sql);
            api.get.mockClear();
            await runPull(PROVIDER, undefined, sql);
            expect(api.get).not.toHaveBeenCalled();
            await expireInventory();
            await runPull(PROVIDER, undefined, sql);
            expect(api.get).toHaveBeenCalled();
        });

        it('counts duplicate Jellyfin entries for one local title only once across pull and push', async () => {
            const id = await addFile();
            const duplicateId = 'b'.repeat(32);
            remoteItems.push({ ...remoteItems[0], Id: duplicateId });
            pulled.push({ ...pulled[0], providerId: duplicateId });
            await localEvent(id, 'mark_watched');
            await runPull(PROVIDER, undefined, sql);
            expect((await getJellyfinPairingStatus(sql)).count).toBe(1);
            expect((await getJellyfinPairingStatus(sql)).examples).toEqual(['Personal film']);
        });

        it('deduplicates unpaired titles across users and directions and honors the watermark', async () => {
            const id = await addFile();
            await addFile('/other/movies');
            await localEvent(id, 'mark_watched');
            const first = userId;
            userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            linkedUsers.push(userId);
            await localEvent(id, 'progress');
            await runPush(PROVIDER, undefined, sql);
            expect((await getJellyfinPairingStatus(sql)).count).toBe(1);
            linkedUsers = [];
            expect((await getJellyfinPairingStatus(sql)).count).toBe(0);
            linkedUsers = [first, userId];
            await sql`INSERT INTO watch_sync_preferences (user_id, provider, direction) VALUES (${first}, 'jellyfin', 'pull'), (${userId}, 'jellyfin', 'pull')`;
            expect((await getJellyfinPairingStatus(sql)).count).toBe(0);
            await sql`UPDATE watch_sync_preferences SET direction = 'both', push_watermark = now() + INTERVAL '1 minute' WHERE user_id IN (${first}, ${userId})`;
            expect((await getJellyfinPairingStatus(sql)).count).toBe(0);
        });

        it('does not count an eligible local title absent from Jellyfin libraries', async () => {
            const id = await addFile();
            await localEvent(id, 'mark_watched');
            remoteItems = [];
            await runPush(PROVIDER, undefined, sql);
            expect(await getJellyfinPairingStatus(sql)).toMatchObject({ count: 0, examples: [] });
        });

        it('syncs different states for two users through the same file pair', async () => {
            const id = await addFile();
            await localEvent(id, 'mark_watched');
            const first = userId;
            userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            linkedUsers.push(userId);
            await localEvent(id, 'progress');
            const [result] = await runPush(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(pushed).toHaveBeenCalledWith([
                expect.objectContaining({
                    username: first,
                    mediaId: id,
                    providerId: REMOTE_ID,
                    isWatched: true,
                }),
            ]);
            expect(positions).toHaveBeenCalledWith([
                expect.objectContaining({
                    username: userId,
                    mediaId: id,
                    providerId: REMOTE_ID,
                    resumePositionMs: 25000,
                }),
            ]);
            const states =
                await sql`SELECT user_id, is_watched, resume_position_ms FROM user_media_state WHERE media_id = ${id} ORDER BY user_id`;
            expect(states).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ user_id: first, is_watched: true }),
                    expect.objectContaining({
                        user_id: userId,
                        is_watched: false,
                        resume_position_ms: 25000,
                    }),
                ]),
            );
        });

        it('keeps a missing link through one complete inventory and drops it after the second', async () => {
            const id = await addFile();
            await runPull(PROVIDER, undefined, sql);
            remoteItems = [];
            await expireInventory();
            await refreshJellyfinFilePairings(sql);
            expect(await sql`SELECT * FROM external_ids WHERE media_id = ${id}`).toHaveLength(1);
            await refreshJellyfinFilePairings(sql); // Cached snapshot is not a second observation.
            expect(await sql`SELECT * FROM external_ids WHERE media_id = ${id}`).toHaveLength(1);
            await expireInventory();
            await refreshJellyfinFilePairings(sql);
            expect(await sql`SELECT * FROM external_ids WHERE media_id = ${id}`).toHaveLength(0);
        });

        it('still drops a locally moved file while its remote link awaits absence confirmation', async () => {
            const id = await addFile();
            await runPull(PROVIDER, undefined, sql);
            remoteItems = [];
            await expireInventory();
            await refreshJellyfinFilePairings(sql);
            expect(await sql`SELECT * FROM external_ids WHERE media_id = ${id}`).toHaveLength(1);
            await sql`UPDATE media_files SET file_path = '/data/movies/Moved.mkv'`;
            await refreshJellyfinFilePairings(sql);
            expect(await sql`SELECT * FROM external_ids WHERE media_id = ${id}`).toHaveLength(0);
        });

        it('does not emit metadata identity events for file links or churn during an incomplete scan', async () => {
            const id = await addFile();
            await sql`INSERT INTO feature_flags (key, value) VALUES ('event_outbox_enabled', 'on') ON CONFLICT (key) DO UPDATE SET value = 'on'`;
            await runPull(PROVIDER, undefined, sql);
            const events = () =>
                sql`SELECT * FROM event_outbox WHERE media_item_id = ${id} AND event_name LIKE 'identity.%'`;
            expect(await events()).toHaveLength(0);
            await expireInventory();
            api.get.mockResolvedValue({ data: { Items: [], TotalRecordCount: 1 } });
            await refreshJellyfinFilePairings(sql);
            expect(await sql`SELECT * FROM external_ids WHERE media_id = ${id}`).toHaveLength(1);
            expect(await events()).toHaveLength(0);
            const catalog = createCatalogService(sql, { skipLifecycleHooks: true });
            await catalog.upsertExternalId(id, {
                provider: 'tmdb',
                id: '9876543',
                mediaType: 'movie',
                source: 'manual',
            });
            expect(await events()).toEqual([
                expect.objectContaining({
                    event_name: 'identity.assigned',
                    payload: expect.objectContaining({ firstIdentityForItem: true }),
                }),
            ]);
            await catalog.deleteExternalId(id, 'tmdb', 'movie');
            expect(await events()).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        event_name: 'identity.cleared',
                        payload: expect.objectContaining({ lastIdentityForItem: true }),
                    }),
                ]),
            );
            await catalog.deleteExternalId(id, 'jellyfin', 'movie');
            expect(await events()).toHaveLength(2);
            await sql`UPDATE feature_flags SET value = 'off' WHERE key = 'event_outbox_enabled'`;
        });

        it('elects one concurrent HTTP refresh and holds no transaction lock during HTTP', async () => {
            await addFile();
            const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!;
            const a = postgres(url, { max: 1 });
            const b = postgres(url, { max: 1 });
            let release!: () => void;
            let arrived!: () => void;
            const started = new Promise<void>((resolve) => {
                arrived = resolve;
            });
            const paused = new Promise<void>((resolve) => {
                release = resolve;
            });
            const original = api.get.getMockImplementation()!;
            api.get.mockImplementation(async (...args: unknown[]) => {
                if (String(args[0]).endsWith('/Library/VirtualFolders')) {
                    arrived();
                    await paused;
                }
                return original(...args);
            });
            try {
                const refresh = refreshJellyfinFilePairings(a, undefined, [REMOTE_ID]);
                await started;
                const [{ locked }] =
                    await b`SELECT pg_try_advisory_lock(hashtext('jellyfin-watch-sync-file-pairing')) AS locked`;
                expect(locked).toBe(true);
                await b`SELECT pg_advisory_unlock(hashtext('jellyfin-watch-sync-file-pairing'))`;
                await refreshJellyfinFilePairings(b, undefined, [REMOTE_ID]);
                release();
                await refresh;
                expect(
                    api.get.mock.calls.filter(([url]) => url.endsWith('/Library/VirtualFolders')),
                ).toHaveLength(1);
                expect(
                    await sql`SELECT * FROM external_ids WHERE provider = 'jellyfin'`,
                ).toHaveLength(1);
            } finally {
                release();
                await a.end();
                await b.end();
            }
        });

        it('bounds lock contention and continues without fetching inventory', async () => {
            await addFile();
            const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!;
            const owner = postgres(url, { max: 1 });
            const contender = postgres(url, { max: 1 });
            try {
                await owner`SELECT pg_advisory_lock(hashtext('jellyfin-watch-sync-file-pairing'))`;
                api.get.mockClear();
                const started = Date.now();
                await refreshJellyfinFilePairings(contender, undefined, [REMOTE_ID]);
                expect(Date.now() - started).toBeLessThan(5000);
                expect(api.get).not.toHaveBeenCalled();
            } finally {
                await owner`SELECT pg_advisory_unlock(hashtext('jellyfin-watch-sync-file-pairing'))`;
                await owner.end();
                await contender.end();
            }
        });

        it('fences an older HTTP snapshot after another worker refreshes the inventory', async () => {
            await addFile();
            const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!;
            const a = postgres(url, { max: 1 });
            const b = postgres(url, { max: 1 });
            let release!: () => void;
            let arrived!: () => void;
            const started = new Promise<void>((resolve) => {
                arrived = resolve;
            });
            const paused = new Promise<void>((resolve) => {
                release = resolve;
            });
            const original = api.get.getMockImplementation()!;
            let block = true;
            api.get.mockImplementation(async (...args: unknown[]) => {
                const response = await original(...args);
                const options = args[1] as { params?: { Ids?: string } } | undefined;
                if (block && options?.params?.Ids) {
                    block = false;
                    arrived();
                    await paused;
                }
                return response;
            });
            let refresh: ReturnType<typeof refreshJellyfinFilePairings> | undefined;
            try {
                refresh = refreshJellyfinFilePairings(a, undefined, [REMOTE_ID]);
                await started;
                await expireInventory();
                remoteItems = [
                    {
                        ...remoteItems[0],
                        Path: '/media/movies/Moved.mkv',
                        MediaSources: [{ Path: '/media/movies/Moved.mkv', Size: 1234 }],
                    },
                ];
                await refreshJellyfinFilePairings(b, undefined, [REMOTE_ID]);
                release();
                await refresh;
                expect(
                    await sql`SELECT * FROM external_ids WHERE provider = 'jellyfin'`,
                ).toHaveLength(0);
                const [state] = await sql`SELECT inventory FROM jellyfin_file_inventory`;
                expect(state.inventory[0].files[0].path).toBe('/media/movies/Moved.mkv');
            } finally {
                release();
                await refresh;
                await a.end();
                await b.end();
            }
        });

        it('continues id-based pull and push when file inventory fails', async () => {
            const id = await addFile();
            await createCatalogService(sql).upsertExternalId(id, {
                provider: 'tmdb',
                id: '1111111',
                mediaType: 'movie',
                source: 'manual',
            });
            // An unresolved item requests inventory; the other item is identified by TMDB.
            pulled.push({
                ...pulled[0],
                providerId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                tmdbId: '1111111',
            });
            api.get.mockRejectedValue(new Error('inventory unavailable'));
            const [result] = await runPull(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(result.totalUpserted).toBe(1);
            await localEvent(id, 'progress');
            const [push] = await runPush(PROVIDER, undefined, sql);
            expect(push.errors).toEqual([]);
            expect(positions).toHaveBeenCalledWith([
                expect.objectContaining({
                    mediaId: id,
                    providerId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                }),
            ]);
        });

        it('skips inventory with no unresolved records or file links', async () => {
            const id = await addFile();
            // An id-resolvable item needs no file evidence.
            await createCatalogService(sql).upsertExternalId(id, {
                provider: 'tmdb',
                id: '2222222',
                mediaType: 'movie',
                source: 'manual',
            });
            api.get.mockClear();
            await refreshJellyfinFilePairings(sql);
            expect(api.get).not.toHaveBeenCalled();
        });

        it('skips inventory on an entirely ID-resolved pull', async () => {
            const id = await addFile();
            await createCatalogService(sql).upsertExternalId(id, {
                provider: 'tmdb',
                id: '1111111',
                mediaType: 'movie',
                source: 'manual',
            });
            pulled[0].tmdbId = '1111111';
            api.get.mockClear();
            const [result] = await watchSyncEngine.runPull(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(result.totalUpserted).toBe(1);
            expect(api.get).not.toHaveBeenCalled();
        });

        it('links only existing Jellyfin accounts, with overrides and cached UUIDs honored', async () => {
            const accountId = crypto.randomUUID().replaceAll('-', '');
            const other = generateTestUserId();
            await ensureTestUser(sql, other);
            expect(
                await getLinkedJellyfinUsers(sql, [
                    { Id: accountId, Name: derivedUsername(userId) },
                ]),
            ).toEqual([userId]);
            await sql`UPDATE users SET jellyfin_username = 'mapped-login' WHERE id = ${userId}`;
            expect(
                await getLinkedJellyfinUsers(sql, [{ Id: accountId, Name: 'mapped-login' }]),
            ).toEqual([userId]);
            await sql`UPDATE users SET jellyfin_user_id = ${accountId} WHERE id = ${userId}`;
            expect(
                await getLinkedJellyfinUsers(sql, [{ Id: accountId, Name: 'renamed-upstream' }]),
            ).toEqual([userId]);
            await sql`UPDATE users SET disabled_at = now() WHERE id = ${userId}`;
            expect(
                await getLinkedJellyfinUsers(sql, [{ Id: accountId, Name: 'renamed-upstream' }]),
            ).toEqual([]);
        });

        it('does not count buffered pull titles after unlinking or disabling pull direction', async () => {
            await addFile();
            await addFile('/other/movies');
            await runPull(PROVIDER, undefined, sql);
            expect((await getJellyfinPairingStatus(sql)).count).toBe(1);
            linkedUsers = [];
            expect((await getJellyfinPairingStatus(sql)).count).toBe(0);
            await expireInventory();
            api.get.mockClear();
            await refreshJellyfinFilePairings(sql);
            expect(api.get).not.toHaveBeenCalled();
            linkedUsers = [userId];
            await sql`INSERT INTO watch_sync_preferences (user_id, provider, direction) VALUES (${userId}, 'jellyfin', 'push')`;
            expect((await getJellyfinPairingStatus(sql)).count).toBe(0);
            await sql`UPDATE watch_sync_preferences SET direction = 'pull' WHERE user_id = ${userId}`;
            expect((await getJellyfinPairingStatus(sql)).count).toBe(1);
        });

        it('never counts an unlinked user or a title absent from Jellyfin', async () => {
            linkedUsers = [];
            const id = await addFile();
            await localEvent(id, 'mark_watched');
            expect(await getJellyfinPairingStatus(sql)).toMatchObject({ count: 0, examples: [] });
        });

        it('refuses contradictory provider ids even when the other id has no local owner', async () => {
            const id = await addFile();
            await createCatalogService(sql).upsertExternalId(id, {
                provider: 'tmdb',
                id: '1111111',
                mediaType: 'movie',
                source: 'manual',
            });
            remoteItems[0].ProviderIds = { Tmdb: '2222222' };
            await runPull(PROVIDER, undefined, sql);
            expect(await sql`SELECT * FROM external_ids WHERE provider = 'jellyfin'`).toHaveLength(
                0,
            );
            expect((await getJellyfinPairingStatus(sql)).examples).toEqual([
                'Personal film (conflicting provider IDs)',
            ]);
        });

        it('keeps existing links and continues syncing when inventory fails', async () => {
            const id = await addFile();
            await refreshJellyfinFilePairings(sql, undefined, [REMOTE_ID]);
            await localEvent(id, 'mark_watched');
            await expireInventory();
            api.get.mockRejectedValue(new Error('inventory unavailable'));
            const [result] = await runPush(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(pushed).toHaveBeenCalled();
            expect(
                await sql`SELECT * FROM user_media_events WHERE media_id = ${id} AND 'jellyfin' = ANY(pushed_to_providers)`,
            ).toHaveLength(1);
        });
        it('does not repeat inventories for a known one-sided local title', async () => {
            const mediaId = await addFile();
            remoteItems = [];
            await appendEventAndRebuild(sql, {
                user_id: toUserId(userId),
                media_id: mediaId,
                event_type: 'progress',
                source: 'lumastra-player',
                position_ms: 5000,
                runtime_ms: 60000,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: new Date().toISOString(),
            });
            await refreshJellyfinFilePairings(sql);
            await expireInventory();
            api.get.mockClear();
            await refreshJellyfinFilePairings(sql);
            expect(api.get).not.toHaveBeenCalled();
        });

        it.each(['missing', 'disabled'] as const)(
            'keeps a locally %s file link until two complete inventories confirm absence',
            async (absence) => {
                const mediaId = await addFile();
                await refreshJellyfinFilePairings(sql, undefined, [REMOTE_ID]);
                if (absence === 'missing') await sql`UPDATE media_files SET is_missing = true`;
                else await sql`UPDATE library_paths SET enabled = false`;
                await expireInventory();
                await refreshJellyfinFilePairings(sql);
                expect(
                    await sql`SELECT 1 FROM external_ids WHERE media_id = ${mediaId} AND provider = 'jellyfin'`,
                ).toHaveLength(1);
                await expireInventory();
                await refreshJellyfinFilePairings(sql);
                expect(
                    await sql`SELECT 1 FROM external_ids WHERE media_id = ${mediaId} AND provider = 'jellyfin'`,
                ).toHaveLength(0);
            },
        );
        it('disambiguates duplicate public IDs by a unique path and known size', async () => {
            const mediaId = await addFile();
            await createCatalogService(sql).upsertExternalId(mediaId, {
                provider: 'tmdb',
                id: '7654321',
                mediaType: 'movie',
                source: 'manual',
            });
            remoteItems[0].ProviderIds = { Tmdb: '7654321' };
            const alternatePath = '/media/movies/4K/Film.mkv';
            remoteItems.push({
                ...remoteItems[0],
                Id: 'b'.repeat(32),
                Path: alternatePath,
                MediaSources: [{ Path: alternatePath, Size: 9876 }],
            });
            await refreshJellyfinFilePairings(sql, undefined, [REMOTE_ID]);
            expect(
                await sql`SELECT external_id FROM external_ids WHERE provider = 'jellyfin' AND media_id = ${mediaId}`,
            ).toEqual([{ external_id: REMOTE_ID }]);
        });
        it('counts known remote-only titles separately without repeated inventories', async () => {
            const [result] = await runPull(PROVIDER, undefined, sql);
            expect(result.totalBuffered).toBe(1);
            expect(await getJellyfinPairingStatus(sql)).toMatchObject({ count: 0, oneSided: 1 });
            await expireInventory();
            api.get.mockClear();
            await refreshJellyfinFilePairings(sql);
            expect(api.get).not.toHaveBeenCalled();
            await sql`UPDATE jellyfin_file_inventory SET refreshed_at = now() - INTERVAL '7 hours'`;
            await refreshJellyfinFilePairings(sql);
            expect(api.get).toHaveBeenCalled();
        });

        it('pairs an id-less local file on a plain inventory, with no prior watch event', async () => {
            const mediaId = await addFile();
            await refreshJellyfinFilePairings(sql);
            expect(
                await sql`SELECT external_id, source FROM external_ids WHERE media_id = ${mediaId} AND provider = 'jellyfin'`,
            ).toEqual([{ external_id: REMOTE_ID, source: 'watch-sync-file' }]);
        });

        it('does not enumerate Jellyfin for discovery without a linked account', async () => {
            await addFile();
            linkedUsers = [];
            api.get.mockClear();
            await refreshJellyfinFilePairings(sql);
            expect(api.get).not.toHaveBeenCalled();
        });

        it('does not repeat discovery for id-less files Jellyfin does not have', async () => {
            await addFile();
            remoteItems = [];
            await refreshJellyfinFilePairings(sql);
            await expireInventory();
            api.get.mockClear();
            await refreshJellyfinFilePairings(sql);
            expect(api.get).not.toHaveBeenCalled();
        });

        it('discovers a newly scanned id-less file after the hourly floor', async () => {
            await addFile();
            await refreshJellyfinFilePairings(sql);
            remoteItems.push({
                ...remoteItems[0],
                Id: 'c'.repeat(32),
                Path: '/media/movies/Second/Film2.mkv',
                MediaSources: [{ Path: '/media/movies/Second/Film2.mkv', Size: 4321 }],
            });
            const [group] = await sql`SELECT id FROM library_groups LIMIT 1`;
            const [media] =
                await sql`INSERT INTO media_items (title, media_type, has_files, status) VALUES ('Second', 'movie', true, 'active') RETURNING id`;
            const [file] =
                await sql`INSERT INTO media_files (file_path, file_size_bytes, library_group_id) VALUES ('/data/movies/Second/Film2.mkv', 4321, ${group.id}) RETURNING id`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${file.id}, ${media.id}, true)`;
            await sql`UPDATE jellyfin_file_inventory SET attempted_at = now() - INTERVAL '2 hours', refreshed_at = now() - INTERVAL '2 hours'`;
            await refreshJellyfinFilePairings(sql);
            expect(
                await sql`SELECT external_id FROM external_ids WHERE media_id = ${media.id} AND provider = 'jellyfin'`,
            ).toEqual([{ external_id: 'c'.repeat(32) }]);
        });

        it('re-pairs a dropped stale link to the new Jellyfin id on the next inventory', async () => {
            const mediaId = await addFile();
            await refreshJellyfinFilePairings(sql);
            const { invalidateStaleFileLink } =
                await import('../database/queries/jellyfin-file-pairing.queries.js');
            expect(await invalidateStaleFileLink(sql, mediaId, REMOTE_ID)).toBe(true);
            const newId = 'd'.repeat(32);
            remoteItems[0] = { ...remoteItems[0], Id: newId };
            await refreshJellyfinFilePairings(sql);
            expect(
                await sql`SELECT external_id FROM external_ids WHERE media_id = ${mediaId} AND provider = 'jellyfin'`,
            ).toEqual([{ external_id: newId }]);
        });

        it('delivers a Jellyfin partial position to a file-paired item', async () => {
            const mediaId = await addFile();
            await refreshJellyfinFilePairings(sql);
            await appendEventAndRebuild(sql, {
                user_id: toUserId(userId),
                media_id: mediaId,
                event_type: 'progress',
                source: 'lumastra-player',
                position_ms: 24000,
                runtime_ms: 60000,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: new Date(Date.now() - 60000).toISOString(),
            });
            pulled = [{ ...pulled[0], isWatched: false, resumePositionMs: 36000, watchCount: 0 }];
            const [result] = await runPull(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(result.totalUpserted).toBe(1);
            expect(
                await sql`SELECT resume_position_ms, is_watched FROM user_media_state WHERE media_id = ${mediaId}`,
            ).toMatchObject([{ resume_position_ms: 36000, is_watched: false }]);
        });

        it('delivers a Jellyfin partial position for an id-less item with no earlier pairing', async () => {
            const mediaId = await addFile();
            pulled = [{ ...pulled[0], isWatched: false, resumePositionMs: 36000, watchCount: 0 }];
            const [result] = await runPull(PROVIDER, undefined, sql);
            expect(result.errors).toEqual([]);
            expect(
                await sql`SELECT resume_position_ms FROM user_media_state WHERE media_id = ${mediaId}`,
            ).toMatchObject([{ resume_position_ms: 36000 }]);
        });
    },
);
