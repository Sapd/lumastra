// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A combined multi-episode file (`S28E12-13`) is ONE provider item: Jellyfin
 * reports it with the first episode's number, so its Played flag resolved to
 * E12 alone and E13 stayed unwatched forever. A pulled watched mark now covers
 * the later episodes on the same default file, on the live pull and on the
 * pending drain alike.
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import type {
    WatchSyncDefinition,
    WatchStatePullItem,
    WatchSyncPullResult,
} from '@sapd/lumastra-plugin-sdk';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestSeries,
    generateTestUserId,
    ensureTestUser,
    derivedUsername,
} from '../../../../tests/integration/fixtures/index.js';
import { registry } from '../tasks/registry.js';
import { watchSyncEngine } from './watch-sync-engine.service.js';
import { drainPendingResolution } from './watch-sync-pending-drain.service.js';
import { upsertPendingResolution } from '../database/queries/watch-state-pending.queries.js';
import type { PendingResolutionInsert } from './watch-sync-pending.js';

vi.mock('./notification-events.service.js', () => ({ publishUserEvent: vi.fn(async () => {}) }));
import { publishUserEvent } from './notification-events.service.js';
import { watchStateEvents } from './watch-state-events.service.js';

const SKIP_TESTS = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

const LAST_PLAYED = new Date('2026-02-01T20:00:00.000Z');

function makePullPlugin(
    providerId: string,
    providerName: string,
    pull: () => Promise<WatchSyncPullResult>,
): WatchSyncDefinition {
    return {
        id: providerId,
        name: 'Fake Combined File Sync',
        version: '1.0.0',
        capabilities: { http: true },
        providerName,
        isAvailable: async () => true,
        pullWatchState: pull,
        resolveIds: async () => [],
        pushWatchState: async () => ({
            succeeded: 0,
            failed: 0,
            skipped: 0,
            staleIds: [],
            errors: [],
            successful: [],
            drainedAsSkipped: [],
        }),
    };
}

describe.skipIf(SKIP_TESTS)('watch-sync — combined multi-episode files', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterEach(() => { watchStateEvents.__resetForTests(); });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'watch_sync_activity',
            'watch_state_pending_resolution',
            'watch_state_pull_log',
            'user_media_events',
            'user_media_state',
            'user_media_flags',
            'media_file_items',
            'media_files',
            'media_items',
            'external_ids',
            'user_profiles',
        ]);
    });

    /**
     * One season of four episodes: E1+E2 share a combined default file, E3 has
     * its own file, and E4 is linked to the combined file only as a
     * NON-default version. Returns the episode ids by number.
     */
    async function seedSeries(tmdbId: number): Promise<Map<number, string>> {
        await createAndInsertTestSeries(sql, {
            title: `Combined ${tmdbId}`,
            tmdbId,
            seasonCount: 1,
            episodesPerSeason: 4,
        });
        const rows = await sql<Array<{ id: string; episode_number: number }>>`
            SELECT ep.id, ep.episode_number
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id
            JOIN external_ids ei ON ei.media_id = season.parent_id
                AND ei.provider = 'tmdb' AND ei.external_id = ${String(tmdbId)}
            WHERE ep.media_type = 'episode'
        `;
        const ids = new Map(rows.map((r) => [r.episode_number, r.id]));
        const combined = randomUUID();
        const single = randomUUID();
        const fourth = randomUUID();
        await sql`
            INSERT INTO media_files (id, file_path) VALUES
                (${combined}, ${`/test/combined-${combined}/S01E01-02.mkv`}),
                (${single}, ${`/test/combined-${single}/S01E03.mkv`}),
                (${fourth}, ${`/test/combined-${fourth}/S01E04.mkv`})
        `;
        await sql`
            INSERT INTO media_file_items
                (file_id, media_item_id, is_default, start_offset_ms, end_offset_ms, offset_source)
            VALUES
                (${combined}, ${ids.get(1)!}, true, 0, 1200000, 'runtime-split'),
                (${combined}, ${ids.get(2)!}, true, 1200000, 2500000, 'runtime-split'),
                (${single}, ${ids.get(3)!}, true, NULL, NULL, NULL),
                (${fourth}, ${ids.get(4)!}, true, NULL, NULL, NULL),
                (${combined}, ${ids.get(4)!}, false, NULL, NULL, NULL)
        `;
        return ids;
    }

    const watched = async (userId: string, mediaId: string): Promise<boolean> => {
        const [row] = await sql<Array<{ is_watched: boolean }>>`
            SELECT is_watched FROM user_media_state
            WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
        `;
        return row?.is_watched ?? false;
    };

    function episodeItem(
        tmdbId: number,
        episodeNumber: number,
        providerUsername: string,
        overrides: Partial<WatchStatePullItem> = {},
    ): WatchStatePullItem {
        return {
            providerId: `jf-combined-${tmdbId}-${episodeNumber}`,
            tmdbId: null,
            imdbId: null,
            mediaType: 'episode',
            isWatched: true,
            resumePositionMs: 0,
            runtimeMs: 2_500_000,
            watchCount: 1,
            providerUsername,
            seasonNumber: 1,
            episodeNumber,
            seriesTmdbId: String(tmdbId),
            lastWatchedAt: LAST_PLAYED,
            firstWatchedAt: LAST_PLAYED,
            ...overrides,
        };
    }

    it('a watched combined-file item marks every episode on the file, and nothing else', async () => {
        const tmdbId = 880101;
        const ids = await seedSeries(tmdbId);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const providerUsername = derivedUsername(userId);

        registry.registerWatchSync(
            makePullPlugin('fake-combined-pull', 'fakecombinedjellyfin', async () => ({
                items: [episodeItem(tmdbId, 1, providerUsername)],
                errors: [],
                newCursors: new Map(),
            })),
        );
        await watchSyncEngine.runPull('fake-combined-pull', undefined, sql);

        expect(await watched(userId, ids.get(1)!)).toBe(true);
        expect(await watched(userId, ids.get(2)!)).toBe(true);
        expect(await watched(userId, ids.get(3)!)).toBe(false);
        // Shares the file only as an alternate version — no evidence.
        expect(await watched(userId, ids.get(4)!)).toBe(false);

        // The sibling's event carries the provider's play date and its window.
        const [ev] = await sql<Array<{ occurred_at: Date; runtime_ms: string | null }>>`
            SELECT occurred_at, runtime_ms FROM user_media_events
            WHERE user_id = ${userId}::uuid AND media_id = ${ids.get(2)!}::uuid
              AND event_type = 'mark_watched' AND repudiated_at IS NULL
        `;
        expect(ev.occurred_at.toISOString()).toBe(LAST_PLAYED.toISOString());
        expect(Number(ev.runtime_ms)).toBe(1_300_000);

        // A repeat pull adds no second mark.
        await watchSyncEngine.runPull('fake-combined-pull', undefined, sql);
        const [{ n }] = await sql<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM user_media_events
            WHERE user_id = ${userId}::uuid AND media_id = ${ids.get(2)!}::uuid
              AND event_type = 'mark_watched' AND repudiated_at IS NULL
        `;
        expect(n).toBe(1);
    });

    it('marks only LATER episodes: a watched second half says nothing about the first', async () => {
        const tmdbId = 880102;
        const ids = await seedSeries(tmdbId);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const providerUsername = derivedUsername(userId);

        registry.registerWatchSync(
            makePullPlugin('fake-combined-later', 'fakecombinedlaterjellyfin', async () => ({
                items: [episodeItem(tmdbId, 2, providerUsername)],
                errors: [],
                newCursors: new Map(),
            })),
        );
        await watchSyncEngine.runPull('fake-combined-later', undefined, sql);

        expect(await watched(userId, ids.get(2)!)).toBe(true);
        expect(await watched(userId, ids.get(1)!)).toBe(false);
    });

    it('an episode the provider reports itself keeps its own verdict', async () => {
        const tmdbId = 880103;
        const ids = await seedSeries(tmdbId);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const providerUsername = derivedUsername(userId);

        registry.registerWatchSync(
            makePullPlugin('fake-combined-own', 'fakecombinedownjellyfin', async () => ({
                items: [
                    episodeItem(tmdbId, 1, providerUsername),
                    episodeItem(tmdbId, 2, providerUsername, {
                        isWatched: false,
                        resumePositionMs: 300_000,
                        watchCount: 0,
                        lastWatchedAt: null,
                        firstWatchedAt: null,
                    }),
                ],
                errors: [],
                newCursors: new Map(),
            })),
        );
        await watchSyncEngine.runPull('fake-combined-own', undefined, sql);

        expect(await watched(userId, ids.get(1)!)).toBe(true);
        expect(await watched(userId, ids.get(2)!)).toBe(false);
    });

    function pendingRow(
        userId: string,
        tmdbId: number,
        episodeNumber: number,
        overrides: Partial<PendingResolutionInsert> = {},
    ): PendingResolutionInsert {
        return {
            user_id: userId,
            provider: 'jellyfin',
            media_type: 'episode',
            provider_id: `jf-combined-drain-${tmdbId}-${episodeNumber}`,
            tmdb_id: null,
            imdb_id: null,
            internal_media_id: null,
            series_tmdb_id: String(tmdbId),
            season_number: 1,
            episode_number: episodeNumber,
            is_watched: true,
            resume_position_ms: 0,
            runtime_ms: 2_500_000,
            watch_count: 1,
            last_watched_at: LAST_PLAYED,
            first_watched_at: LAST_PLAYED,
            ...overrides,
        };
    }

    async function pullOnce(pluginId: string, items: WatchStatePullItem[]): Promise<void> {
        registry.registerWatchSync(
            makePullPlugin(pluginId, `${pluginId.replaceAll('-', '')}jellyfin`, async () => ({
                items,
                errors: [],
                newCursors: new Map(),
            })),
        );
        await watchSyncEngine.runPull(pluginId, undefined, sql);
    }

    it('an auto-completed item does not spread: the threshold was judged on the whole file', async () => {
        const tmdbId = 880105;
        const ids = await seedSeries(tmdbId);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        // 95% of the 2500s file: past the file's threshold, but only 81% into E2.
        await pullOnce('fake-combined-autocomplete', [
            episodeItem(tmdbId, 1, derivedUsername(userId), {
                isWatched: false,
                resumePositionMs: 2_375_000,
                watchCount: 0,
            }),
        ]);

        expect(await watched(userId, ids.get(1)!)).toBe(true);
        expect(await watched(userId, ids.get(2)!)).toBe(false);
    });

    it('leaves an inactive sibling and a sibling in another season alone', async () => {
        const tmdbId = 880106;
        await createAndInsertTestSeries(sql, {
            title: `Combined ${tmdbId}`,
            tmdbId,
            seasonCount: 2,
            episodesPerSeason: 3,
        });
        const rows = await sql<
            Array<{ id: string; season_number: number; episode_number: number }>
        >`
            SELECT ep.id, ep.season_number, ep.episode_number
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id
            JOIN external_ids ei ON ei.media_id = season.parent_id
                AND ei.provider = 'tmdb' AND ei.external_id = ${String(tmdbId)}
            WHERE ep.media_type = 'episode'
        `;
        const id = (season: number, ep: number): string =>
            rows.find((r) => r.season_number === season && r.episode_number === ep)!.id;
        const file = randomUUID();
        await sql`INSERT INTO media_files (id, file_path) VALUES (${file}, ${`/test/combined-${file}/S01E01-03.mkv`})`;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES
                (${file}, ${id(1, 1)}, true),
                (${file}, ${id(1, 2)}, true),
                (${file}, ${id(1, 3)}, true),
                (${file}, ${id(2, 2)}, true)
        `;
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${id(1, 2)}`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        await pullOnce('fake-combined-scope', [episodeItem(tmdbId, 1, derivedUsername(userId))]);

        expect(await watched(userId, id(1, 1))).toBe(true);
        expect(await watched(userId, id(1, 3))).toBe(true);
        expect(await watched(userId, id(1, 2))).toBe(false);
        expect(await watched(userId, id(2, 2))).toBe(false);
    });

    it("the pending drain keeps a buffered sibling's own verdict", async () => {
        const tmdbId = 880107;
        const ids = await seedSeries(tmdbId);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        await upsertPendingResolution(sql, [
            pendingRow(userId, tmdbId, 1),
            pendingRow(userId, tmdbId, 2, {
                is_watched: false,
                resume_position_ms: 300_000,
                watch_count: 0,
                last_watched_at: null,
                first_watched_at: null,
            }),
        ]);
        await drainPendingResolution('jellyfin', { sql });

        expect(await watched(userId, ids.get(1)!)).toBe(true);
        expect(await watched(userId, ids.get(2)!)).toBe(false);
        const [{ n }] = await sql<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM user_media_events
            WHERE user_id = ${userId}::uuid AND media_id = ${ids.get(2)!}::uuid
              AND event_type = 'mark_watched'
        `;
        expect(n).toBe(0);
    });

    it('the pending drain marks the later episodes too', async () => {
        watchStateEvents.__resetForTests();
        vi.mocked(publishUserEvent).mockClear();
        const tmdbId = 880104;
        const ids = await seedSeries(tmdbId);
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        await upsertPendingResolution(sql, [pendingRow(userId, tmdbId, 1)]);
        const stats = await drainPendingResolution('jellyfin', { sql });

        expect(stats.imported).toBe(1);
        await vi.waitFor(
            () =>
                expect(publishUserEvent).toHaveBeenCalledWith(
                    expect.objectContaining({
                        userId,
                        kind: 'watch_state_set_changed',
                        persist: false,
                    }),
                ),
            { timeout: 5000 },
        );
        expect(await watched(userId, ids.get(1)!)).toBe(true);
        expect(await watched(userId, ids.get(2)!)).toBe(true);
        expect(await watched(userId, ids.get(3)!)).toBe(false);
        expect(await watched(userId, ids.get(4)!)).toBe(false);

        const [ev] = await sql<Array<{ occurred_at: Date; runtime_ms: string | null }>>`
            SELECT occurred_at, runtime_ms FROM user_media_events
            WHERE user_id = ${userId}::uuid AND media_id = ${ids.get(2)!}::uuid
              AND event_type = 'mark_watched' AND repudiated_at IS NULL
        `;
        expect(ev.occurred_at.toISOString()).toBe(LAST_PLAYED.toISOString());
        expect(Number(ev.runtime_ms)).toBe(1_300_000);
    });
});
