// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Two-way Jellyfin conflicts, through the real plugin, the real engine and a real
 * PostgreSQL; only Jellyfin's HTTP surface is faked.
 *
 * Found by the day-1 fresh-install test (2026-10-31):
 *  - a local stop and a Jellyfin stop 0.368 s apart converged on the OLDER one;
 *  - a played flag set in Jellyfin on a title whose play date was already behind
 *    the pull cursor never reached Lumastra.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    ensureTestUser,
    generateTestUserId,
    derivedUsername,
} from '../../../../tests/integration/fixtures/index.js';
import { appendEventAndRebuild } from './watch-state-rebuilder.service.js';
import { getState } from '../database/queries/user-media-state.queries.js';
import { getUnpushedLumastraItems } from '../database/queries/user-media-events.queries.js';
import { createCatalogService } from './catalog.service.js';
import { queryJellyfinDeliveryStatus } from '../database/queries/jellyfin-file-pairing.queries.js';
import { watchSyncEngine } from './watch-sync-engine.service.js';
import { jellyfinWatchSync } from '../tasks/builtin/native/watch-sync/jellyfin.js';
import { aiDbService } from './database.service.js';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
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

const RUNTIME_TICKS = 6_345_666_660; // 634 566 ms, the day-1 film

interface FakeItem {
    id: string;
    positionTicks: number;
    played: boolean;
    playCount: number;
    lastPlayedDate: string | undefined;
}

describe('Jellyfin conflicts and late upstream flags (real PostgreSQL, faked Jellyfin HTTP)', () => {
    let sql: postgres.Sql;
    let userId: ReturnType<typeof generateTestUserId>;
    let remoteUserId: string;
    let remoteUsers: Array<{ Id: string; Name: string }>;
    let upstream: Map<string, FakeItem>;

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
        // The pull remembers per Jellyfin account; a new account per test isolates it.
        remoteUserId = crypto.randomUUID().replaceAll('-', '');
        await ensureTestUser(sql, userId);
        await sql`UPDATE users SET jellyfin_user_id = ${remoteUserId} WHERE id = ${userId}`;
        remoteUsers = [{ Id: remoteUserId, Name: derivedUsername(userId) }];
        upstream = new Map();
        http.post.mockReset().mockResolvedValue({ data: {} });
        http.delete.mockReset().mockResolvedValue({ data: {} });
        http.get.mockReset().mockImplementation(fakeJellyfin);
    });

    function dto(item: FakeItem) {
        return {
            Id: item.id,
            Type: 'Movie',
            Name: 'Long film',
            RunTimeTicks: RUNTIME_TICKS,
            UserData: {
                Played: item.played,
                PlayCount: item.playCount,
                PlaybackPositionTicks: item.positionTicks,
                ...(item.lastPlayedDate ? { LastPlayedDate: item.lastPlayedDate } : {}),
            },
        };
    }

    /** Just enough of Jellyfin: users, the played list, the resume list, one item. */
    async function fakeJellyfin(
        url: string,
        opts?: { params?: Record<string, string | number | boolean> },
    ) {
        const params = opts?.params ?? {};
        const empty = { data: { Items: [], TotalRecordCount: 0 } };
        if (url.endsWith('/Library/VirtualFolders')) return { data: [] };
        if (url.endsWith('/System/Info/Public')) return { data: { Version: '12.4.0' } };
        if (url.endsWith('/Users')) return { data: remoteUsers };
        if (url.endsWith('/Sessions')) return { data: [] };
        const items = [...upstream.values()];
        if (url.endsWith(`/Users/${remoteUserId}/Items/Resume`)) {
            const resumable = items.filter((i) => !i.played && i.positionTicks > 0);
            return { data: { Items: resumable.map(dto), TotalRecordCount: resumable.length } };
        }
        if (url.endsWith(`/Users/${remoteUserId}/Items`)) {
            if (params.ids) {
                const asked = String(params.ids).split(',');
                const found = items.filter((i) => asked.includes(i.id));
                return { data: { Items: found.map(dto), TotalRecordCount: found.length } };
            }
            if (params.includeItemTypes === 'Movie' && params.filters === 'IsPlayed') {
                // Jellyfin sorts the played list by LastPlayedDate, newest first.
                const played = items
                    .filter((i) => i.played)
                    .sort((a, b) => (b.lastPlayedDate ?? '').localeCompare(a.lastPlayedDate ?? ''));
                return { data: { Items: played.map(dto), TotalRecordCount: played.length } };
            }
        }
        return empty;
    }

    async function addMovie(remoteId: string, title: string): Promise<string> {
        const { id } = await createAndInsertTestMovie(sql, { title });
        const catalog = createCatalogService(sql, { skipLifecycleHooks: true });
        await catalog.deleteExternalId(id, 'jellyfin', 'movie');
        await catalog.upsertExternalId(id, {
            provider: 'jellyfin',
            id: remoteId,
            mediaType: 'movie',
            source: 'test',
        });
        return id;
    }

    async function localStop(mediaId: string, positionMs: number, occurredAt: string) {
        await appendEventAndRebuild(sql, {
            user_id: userId,
            media_id: mediaId,
            event_type: 'progress',
            source: 'lumastra-player',
            position_ms: positionMs,
            runtime_ms: 634_566,
            source_event_id: null,
            session_id: null,
            event_seq: 1,
            session_elapsed_ms: positionMs,
            occurred_at: occurredAt,
        });
    }

    const pending = async () =>
        (await getUnpushedLumastraItems.all(sql, { provider: 'jellyfin', limit: 200 })).length;
    const userDataWrites = () =>
        http.post.mock.calls.filter(([url]) => String(url).includes('/UserData'));

    describe('conflicting stops, within a second of each other', () => {
        const remoteId = 'c'.repeat(32);
        const LOCAL_STOP = '2026-10-31T00:16:27.114Z';
        const UPSTREAM_STOP = '2026-10-31T00:16:27.4818498Z';

        it('does not overwrite a newer Jellyfin position with the older local one; the newer stop wins on both sides', async () => {
            const mediaId = await addMovie(remoteId, 'Long film');
            await localStop(mediaId, 235_429, LOCAL_STOP);
            upstream.set(remoteId, {
                id: remoteId,
                positionTicks: 4_441_966_662,
                played: false,
                playCount: 1,
                lastPlayedDate: UPSTREAM_STOP,
            });

            // The scheduled export happens to run before the import. The local stop
            // is held back, not dropped: it stays queued for the retry.
            await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
            expect(userDataWrites()).toHaveLength(0);
            expect(await pending()).toBe(1);

            await watchSyncEngine.runPull(jellyfinWatchSync.id, undefined, sql);
            const state = await getState.one(sql, { userId, mediaId });
            expect(state?.resume_position_ms).toBe(444_196);
            expect(new Date(state!.last_event_at!).toISOString()).toBe('2026-10-31T00:16:27.481Z');

            // The retry delivers the winning position (Jellyfin's own) and clears the queue.
            await sql`UPDATE user_media_events SET sync_delivery = '{}' WHERE user_id = ${userId}`;
            await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
            expect(userDataWrites()).toHaveLength(1);
            expect(userDataWrites()[0][1]).toEqual({ PlaybackPositionTicks: 4_441_960_000 });
            expect(await pending()).toBe(0);
        });

        it('keeps a push-only user pushing: their import never runs, so deferring would lose the local stop', async () => {
            await sql`INSERT INTO watch_sync_preferences (user_id, provider, direction) VALUES (${userId}, 'jellyfin', 'push')`;
            const mediaId = await addMovie(remoteId, 'Long film');
            await localStop(mediaId, 235_429, LOCAL_STOP);
            upstream.set(remoteId, {
                id: remoteId,
                positionTicks: 4_441_966_662,
                played: false,
                playCount: 1,
                lastPlayedDate: UPSTREAM_STOP,
            });
            await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
            expect(userDataWrites()).toHaveLength(1);
            expect(userDataWrites()[0][1]).toEqual({ PlaybackPositionTicks: 2_354_290_000 });
            expect(await pending()).toBe(0);
        });

        it('with Jellyfin clock 30 s ahead, a stop it holds is held back only until the import has seen it, never drained', async () => {
            const mediaId = await addMovie(remoteId, 'Long film');
            await localStop(mediaId, 235_429, LOCAL_STOP);
            upstream.set(remoteId, {
                id: remoteId,
                positionTicks: 3_000_000_000,
                played: false,
                playCount: 1,
                lastPlayedDate: '2026-10-31T00:16:57.114Z',
            });
            await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
            expect(userDataWrites()).toHaveLength(0);
            expect(await pending()).toBe(1);

            await watchSyncEngine.runPull(jellyfinWatchSync.id, undefined, sql);
            await sql`UPDATE user_media_events SET sync_delivery = '{}' WHERE user_id = ${userId}`;
            // The date is now imported: the skewed clock can no longer block delivery.
            await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
            expect(await pending()).toBe(0);
            expect((await getState.one(sql, { userId, mediaId }))?.resume_position_ms).toBe(
                300_000,
            );
        });

        const reopen = () =>
            sql`UPDATE user_media_events SET sync_delivery = jsonb_set(sync_delivery, '{jellyfin,next_attempt_at}', to_jsonb(now() - INTERVAL '1 minute')) WHERE user_id = ${userId}`;

        it('holds a stop back at most once when the import can never catch up (watched in Lumastra)', async () => {
            const mediaId = await addMovie(remoteId, 'Long film');
            await appendEventAndRebuild(sql, {
                user_id: userId,
                media_id: mediaId,
                event_type: 'mark_watched',
                source: 'lumastra-user-mark',
                position_ms: null,
                runtime_ms: 634_566,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: '2026-10-31T00:10:00.000Z',
            });
            upstream.set(remoteId, {
                id: remoteId,
                positionTicks: 0,
                played: true,
                playCount: 1,
                lastPlayedDate: '2026-10-31T00:10:00.000Z',
            });
            await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
            http.post.mockClear();
            // Rewatched a little here, then started and stopped over in Jellyfin.
            await localStop(mediaId, 235_429, LOCAL_STOP);
            upstream.set(remoteId, {
                id: remoteId,
                positionTicks: 4_441_966_662,
                played: false,
                playCount: 1,
                lastPlayedDate: UPSTREAM_STOP,
            });
            const [first] = await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
            expect(userDataWrites()).toHaveLength(0);
            // A benign hold is not a fault: no error, no failure count.
            expect(first.errors).toEqual([]);
            expect(first.failed).toBe(0);
            const [{ outcome }] =
                await sql`SELECT outcome FROM watch_sync_activity WHERE user_id = ${userId} AND direction = 'push' ORDER BY id DESC LIMIT 1`;
            expect(outcome).toBe('skipped');
            const delivery = await queryJellyfinDeliveryStatus(
                sql,
                [{ user_id: userId, since: null }],
                [userId],
            );
            expect(delivery.failed.count).toBe(0);

            // The import cannot write an event for a title Lumastra holds as watched.
            await watchSyncEngine.runPull(jellyfinWatchSync.id, undefined, sql);
            await reopen();
            await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
            expect(userDataWrites()).toHaveLength(1);
            expect(await pending()).toBe(0);
        });

        it('holds a stop back at most once when Jellyfin only moved its date, not the position', async () => {
            const mediaId = await addMovie(remoteId, 'Long film');
            upstream.set(remoteId, {
                id: remoteId,
                positionTicks: 4_000_000_000,
                played: false,
                playCount: 1,
                lastPlayedDate: '2026-10-31T00:10:00.000Z',
            });
            await watchSyncEngine.runPull(jellyfinWatchSync.id, undefined, sql);
            await localStop(mediaId, 235_429, '2026-10-31T00:12:00.000Z');
            upstream.set(remoteId, {
                id: remoteId,
                positionTicks: 4_000_005_000,
                played: false,
                playCount: 1,
                lastPlayedDate: UPSTREAM_STOP,
            });
            await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
            expect(userDataWrites()).toHaveLength(0);
            await watchSyncEngine.runPull(jellyfinWatchSync.id, undefined, sql);
            await reopen();
            await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
            expect(userDataWrites()).toHaveLength(1);
            expect(await pending()).toBe(0);
        });

        it('offers the conflict check only for items whose failed attempts are counted', async () => {
            const spy = vi.spyOn(jellyfinWatchSync, 'pushResumePosition');
            try {
                const movie = await addMovie(remoteId, 'Long film');
                await localStop(movie, 235_429, LOCAL_STOP);
                await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
                const sent = spy.mock.calls.flatMap(([, items]) => items);
                expect(sent).toHaveLength(1);
                expect(sent[0].eventAt).toBeDefined();

                spy.mockClear();
                const other = await addMovie('9'.repeat(32), 'Not a movie');
                await sql`UPDATE media_items SET media_type = 'extra' WHERE id = ${other}`;
                await localStop(other, 100_000, LOCAL_STOP);
                await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
                for (const [, items] of spy.mock.calls)
                    for (const item of items)
                        if (item.mediaId === other) expect(item.eventAt).toBeUndefined();
            } finally {
                spy.mockRestore();
            }
        });

        it('still pushes a local stop that is newer than what Jellyfin holds', async () => {
            const mediaId = await addMovie(remoteId, 'Long film');
            upstream.set(remoteId, {
                id: remoteId,
                positionTicks: 4_441_966_662,
                played: false,
                playCount: 1,
                lastPlayedDate: '2026-10-31T00:10:00.000Z',
            });
            await localStop(mediaId, 235_429, LOCAL_STOP);

            await watchSyncEngine.runPush(jellyfinWatchSync.id, undefined, sql);
            expect(userDataWrites()).toHaveLength(1);
            expect(userDataWrites()[0][1]).toEqual({ PlaybackPositionTicks: 2_354_290_000 });
            expect(await pending()).toBe(0);
        });
    });

    describe('an import that fails after the full walk', () => {
        it('walks the whole list again next cycle instead of trusting the failed one', async () => {
            const longId = 'd'.repeat(32);
            const otherId = 'e'.repeat(32);
            const longMedia = await addMovie(longId, 'Long film');
            await addMovie(otherId, 'Other film');
            upstream.set(longId, {
                id: longId,
                positionTicks: 3_807_399_996,
                played: false,
                playCount: 1,
                lastPlayedDate: '2026-10-31T00:16:27.4818498Z',
            });
            upstream.set(otherId, {
                id: otherId,
                positionTicks: 0,
                played: true,
                playCount: 1,
                lastPlayedDate: '2026-10-31T00:18:27.279Z',
            });
            await watchSyncEngine.runPull(jellyfinWatchSync.id, undefined, sql);
            await watchSyncEngine.runPull(jellyfinWatchSync.id, undefined, sql);

            const item = upstream.get(longId)!;
            item.played = true;
            item.playCount = 2;
            item.positionTicks = 0;

            // The full walk reads the flag, then the database refuses the import.
            await sql`ALTER TABLE user_media_state RENAME TO user_media_state_away`;
            try {
                const [failed] = await watchSyncEngine.runPull(
                    jellyfinWatchSync.id,
                    undefined,
                    sql,
                );
                expect(failed.errors.join()).toMatch(/user=/);
            } finally {
                await sql`ALTER TABLE user_media_state_away RENAME TO user_media_state`;
            }

            await watchSyncEngine.runPull(jellyfinWatchSync.id, undefined, sql);
            expect((await getState.one(sql, { userId, mediaId: longMedia }))?.is_watched).toBe(
                true,
            );
        });
    });

    describe('an upstream played flag whose play date is behind the pull cursor', () => {
        it('imports it: marking a partly watched film played in Jellyfin does not change its LastPlayedDate', async () => {
            const longId = 'd'.repeat(32);
            const otherId = 'e'.repeat(32);
            const longMedia = await addMovie(longId, 'Long film');
            const otherMedia = await addMovie(otherId, 'Other film');

            // Cycle 1: the long film is half watched in Jellyfin, another film was
            // played later; the cursor moves to that later date.
            upstream.set(longId, {
                id: longId,
                positionTicks: 3_807_399_996,
                played: false,
                playCount: 1,
                lastPlayedDate: '2026-10-31T00:16:27.4818498Z',
            });
            upstream.set(otherId, {
                id: otherId,
                positionTicks: 0,
                played: true,
                playCount: 1,
                lastPlayedDate: '2026-10-31T00:18:27.279Z',
            });
            // ... and one played long ago, which only a full walk reads.
            await addMovie('f'.repeat(32), 'Old film');
            upstream.set('f'.repeat(32), {
                id: 'f'.repeat(32),
                positionTicks: 0,
                played: true,
                playCount: 1,
                lastPlayedDate: '2026-01-02T03:04:05.000Z',
            });
            const [first] = await watchSyncEngine.runPull(jellyfinWatchSync.id, undefined, sql);
            expect(first.totalFromProvider).toBe(3);
            expect((await getState.one(sql, { userId, mediaId: otherMedia }))?.is_watched).toBe(
                true,
            );
            expect((await getState.one(sql, { userId, mediaId: longMedia }))?.is_watched).toBe(
                false,
            );
            // Cycle 2: quiet, so the cursor ends the walk before the old film.
            const [quiet] = await watchSyncEngine.runPull(jellyfinWatchSync.id, undefined, sql);
            expect(quiet.totalFromProvider).toBe(2);

            // The user marks the long film played in Jellyfin. Jellyfin keeps the
            // earlier LastPlayedDate and only raises the play count.
            const item = upstream.get(longId)!;
            item.played = true;
            item.playCount = 2;
            item.positionTicks = 0;

            for (let cycle = 0; cycle < 2; cycle++)
                await watchSyncEngine.runPull(jellyfinWatchSync.id, undefined, sql);
            expect((await getState.one(sql, { userId, mediaId: longMedia }))?.is_watched).toBe(
                true,
            );
        });
    });
});
