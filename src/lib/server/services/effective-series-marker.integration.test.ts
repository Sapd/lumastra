// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-PG integration tests for the series watch marker: the series filter on
 * `getContinueWatchingFromDb` and the `effectiveSeriesMarker` resolver.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/services/effective-series-marker.integration.test.ts
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../tests/integration/fixtures/user.fixtures.js';
import { createAndInsertTestSeries } from '../../../../tests/integration/fixtures/episode.fixtures.js';
import {
    getContinueWatchingFromDb,
    getSeriesMainlineWatchSummary,
} from '$lib/server/database/queries/watch-state.queries.js';
import { effectiveSeriesMarker } from '$lib/server/services/effective-series-marker.service.js';
import { effectiveNextUpForSeries } from '$lib/server/services/effective-next-up.service.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

vi.setConfig({ testTimeout: 30_000 });

// The resolver's collaborators (session read model, watchManager next-up and
// first-episode reads) reach the DB through these two seams; point both at the
// test database. Whole-module spreads keep every other export real.
vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    const { getTestDb: getSql } =
        await import('../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

vi.mock('$lib/server/services/database.service.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/services/database.service.js')>();
    const { getTestDb: getSql } =
        await import('../../../../tests/integration/setup/test-database.js');
    return { ...mod, aiDbService: { getSql: () => Promise.resolve(getSql()) } };
});

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

const EPISODE_RUNTIME_S = 45 * 60;
const EPISODE_RUNTIME_MS = EPISODE_RUNTIME_S * 1000;

/** Distinct per run so two series in one test never share a tmdb composite key. */
function uniqueTmdbId(offset: number): number {
    return 90_000_000 + (Date.now() % 900_000) * 10 + offset;
}

interface SeededSeries {
    seriesId: string;
    /** Episode media id keyed by `S<season>E<episode>` (e.g. `S1E8`). */
    ep: Map<string, string>;
}

describe.runIf(RUN)('series watch marker (integration)', () => {
    let sql: postgres.Sql;
    let userId: UserId;

    beforeAll(async () => {
        sql = getTestDb();
        await sql`SELECT 1`;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'play_sessions',
            'user_media_state',
            'user_media_events',
            'user_media_flags',
            'media_file_items',
            'media_files',
            'external_ids',
            'media_items',
            'users',
        ]);
        userId = toUserId(generateTestUserId());
        await ensureTestUser(sql, userId);
    });

    async function seedSeries(
        tmdbOffset: number,
        seasonCount = 1,
        episodesPerSeason = 12,
    ): Promise<SeededSeries> {
        const series = await createAndInsertTestSeries(sql, {
            tmdbId: uniqueTmdbId(tmdbOffset),
            seasonCount,
            episodesPerSeason,
            episodeRuntimeSeconds: EPISODE_RUNTIME_S,
        });
        const rows = await sql<
            Array<{ id: string; season_number: number; episode_number: number }>
        >`
            SELECT e.id, e.season_number, e.episode_number
            FROM media_items e
            JOIN media_items s ON s.id = e.parent_id
            WHERE s.parent_id = ${series.seriesId}::uuid AND e.media_type = 'episode'
        `;
        for (const row of rows) await seedEpisodeFile(row.id);
        // File linking is followed by the scanner's canonical availability update.
        await sql`
            UPDATE media_items SET has_files = true
            WHERE id = ${series.seriesId}::uuid OR parent_id = ${series.seriesId}::uuid
        `;
        const ep = new Map<string, string>();
        for (const r of rows) ep.set(`S${r.season_number}E${r.episode_number}`, r.id);
        return { seriesId: series.seriesId, ep };
    }

    async function seedEpisodeFile(mediaId: string): Promise<void> {
        const [file] = await sql<Array<{ id: string }>>`
            INSERT INTO media_files (file_path, duration_seconds)
            VALUES (${`/tmp/marker-${mediaId}.mkv`}, ${EPISODE_RUNTIME_S})
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${file.id}, ${mediaId}, true)
        `;
        await sql`UPDATE media_items SET has_files = true WHERE id = ${mediaId}::uuid`;
    }

    async function setState(
        mediaId: string,
        opts: { watched?: boolean; resumeMs?: number; ageSeconds?: number },
    ): Promise<void> {
        const watched = opts.watched ?? false;
        const resumeMs = opts.resumeMs ?? 0;
        const ageSeconds = opts.ageSeconds ?? 0;
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                last_watched_at, last_event_at
            )
            VALUES (
                ${userId}, ${mediaId}::uuid, ${watched}, ${resumeMs}, ${EPISODE_RUNTIME_MS},
                CASE WHEN ${watched} THEN NOW() - make_interval(secs => ${ageSeconds}) END,
                NOW() - make_interval(secs => ${ageSeconds})
            )
            ON CONFLICT (user_id, media_id) DO UPDATE SET
                is_watched = EXCLUDED.is_watched,
                resume_position_ms = EXCLUDED.resume_position_ms,
                last_watched_at = EXCLUDED.last_watched_at,
                last_event_at = EXCLUDED.last_event_at
        `;
    }

    function epId(series: SeededSeries, key: string): string {
        const id = series.ep.get(key);
        if (!id) throw new Error(`fixture has no ${key}`);
        return id;
    }

    describe('getContinueWatchingFromDb seriesId filter', () => {
        it('returns only the requested series when two series are in progress', async () => {
            const a = await seedSeries(1);
            const b = await seedSeries(2);
            await setState(epId(a, 'S1E3'), { resumeMs: 1_200_000, ageSeconds: 60 });
            await setState(epId(b, 'S1E5'), { resumeMs: 1_200_000 });

            const params = {
                userId,
                limit: 10,
                minMs: 60_000,
                minPercent: 5,
                maxAgeDays: 0,
                collapsePerSeries: true,
            };
            const unfiltered = await getContinueWatchingFromDb.all(sql, params);
            expect(unfiltered.map((r) => r.media_id).sort()).toEqual(
                [epId(a, 'S1E3'), epId(b, 'S1E5')].sort(),
            );

            const filtered = await getContinueWatchingFromDb.all(sql, {
                ...params,
                seriesId: a.seriesId,
            });
            expect(filtered.map((r) => r.media_id)).toEqual([epId(a, 'S1E3')]);
        });
    });

    describe('effectiveSeriesMarker', () => {
        const DAY_S = 86_400;

        /** Marks S1E1..S1E<n> watched, oldest first, so S1E<n> is the latest watch. */
        async function watchThrough(
            series: SeededSeries,
            n: number,
            skip: number[] = [],
        ): Promise<void> {
            for (let e = 1; e <= n; e++) {
                if (skip.includes(e)) continue;
                await setState(epId(series, `S1E${e}`), {
                    watched: true,
                    ageSeconds: 2 * DAY_S + (n - e) * 3600,
                });
            }
        }

        it('M1: E9 skipped and E10 in progress resolves to E10, not next-up E9', async () => {
            const s = await seedSeries(11);
            await watchThrough(s, 8);
            await setState(epId(s, 'S1E10'), { resumeMs: 1_320_000, ageSeconds: DAY_S });

            const marker = await effectiveSeriesMarker({ userId, seriesId: s.seriesId, sql });

            expect(marker.state).toBe('in_progress');
            expect(marker.episode?.id).toBe(epId(s, 'S1E10'));
            expect(marker.episode).toMatchObject({ seasonNumber: 1, episodeNumber: 10 });
            expect(marker.positionMs).toBe(1_320_000);
            expect(marker.updatedAt).not.toBeNull();

            // The divergence this resolver closes: next-up alone still says E9.
            const nextUp = await effectiveNextUpForSeries({ userId, seriesId: s.seriesId, sql });
            expect(nextUp.episode?.media_id).toBe(epId(s, 'S1E9'));
        });

        it('skips an unavailable in-progress episode in both CW and the series marker', async () => {
            const s = await seedSeries(24);
            await watchThrough(s, 8);
            const available = epId(s, 'S1E9');
            const unavailable = epId(s, 'S1E10');
            await setState(available, { resumeMs: 1_200_000, ageSeconds: 3600 });
            await setState(unavailable, { resumeMs: 1_320_000 });
            // Retain its Jellyfin ID and watch state after the scanner loses its file.
            await sql`
                UPDATE media_files SET is_missing = true
                WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${unavailable})
            `;
            await sql`UPDATE media_items SET has_files = false WHERE id = ${unavailable}::uuid`;

            const rows = await getContinueWatchingFromDb.all(sql, {
                userId,
                seriesId: s.seriesId,
                limit: 10,
                minMs: 60_000,
                minPercent: 5,
                maxAgeDays: 0,
                collapsePerSeries: true,
            });
            expect(rows.map((row) => row.media_id)).toEqual([available]);
            const marker = await effectiveSeriesMarker({ userId, seriesId: s.seriesId, sql });
            expect(marker.state).toBe('in_progress');
            expect(marker.episode?.id).toBe(available);
            expect(marker.positionMs).toBe(1_200_000);

            await sql`DELETE FROM user_media_state WHERE media_id = ${available}::uuid`;
            const next = await effectiveSeriesMarker({ userId, seriesId: s.seriesId, sql });
            expect(next.state).toBe('next');
            expect(next.episode?.id).toBe(available);
            expect(next.positionMs).toBe(0);
        });

        /** A watched episode with later progress: the rail's re-watch shape. */
        async function setRewatch(
            mediaId: string,
            resumeMs: number,
            watchedAgeSeconds: number,
            eventAgeSeconds: number,
        ): Promise<void> {
            await sql`
                INSERT INTO user_media_state (
                    user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                    last_watched_at, last_event_at
                )
                VALUES (
                    ${userId}, ${mediaId}::uuid, true, ${resumeMs}, ${EPISODE_RUNTIME_MS},
                    NOW() - make_interval(secs => ${watchedAgeSeconds}),
                    NOW() - make_interval(secs => ${eventAgeSeconds})
                )
            `;
        }

        it('a stale, barely-started rewatch of an early episode loses to next-up (prod: Dexter S01E10 vs S06E11)', async () => {
            const s = await seedSeries(16);
            // Watched E1..E6, E6 two days ago; E3 re-watched to ~15% fifty days ago.
            await watchThrough(s, 6);
            await sql`DELETE FROM user_media_state WHERE media_id = ${epId(s, 'S1E3')}::uuid`;
            await setRewatch(epId(s, 'S1E3'), 400_000, 60 * DAY_S, 50 * DAY_S);

            // The raw CW query still returns it (re-watch exemption); the rail's
            // anchor rule, and now the marker, pick next-up over it.
            const rows = await getContinueWatchingFromDb.all(sql, {
                userId,
                limit: 10,
                minMs: 60_000,
                minPercent: 5,
                maxAgeDays: 180,
                collapsePerSeries: true,
                seriesId: s.seriesId,
            });
            expect(rows.map((r) => r.media_id)).toEqual([epId(s, 'S1E3')]);

            const marker = await effectiveSeriesMarker({ userId, seriesId: s.seriesId, sql });

            expect(marker.state).toBe('next');
            expect(marker.episode?.id).toBe(epId(s, 'S1E7'));
            expect(marker.positionMs).toBe(0);
        });

        it('a substantial backlog rewatch stays the in-progress marker, as on the rail', async () => {
            const s = await seedSeries(17);
            await watchThrough(s, 6);
            await sql`DELETE FROM user_media_state WHERE media_id = ${epId(s, 'S1E3')}::uuid`;
            // ~44% in, fifty days ago: the rail's `cw-backlog-catchup`.
            await setRewatch(epId(s, 'S1E3'), 1_200_000, 60 * DAY_S, 50 * DAY_S);

            const marker = await effectiveSeriesMarker({ userId, seriesId: s.seriesId, sql });

            expect(marker.state).toBe('in_progress');
            expect(marker.episode?.id).toBe(epId(s, 'S1E3'));
            expect(marker.positionMs).toBe(1_200_000);
        });

        it('a fresh, barely-started rewatch stays the in-progress marker', async () => {
            const s = await seedSeries(18);
            await watchThrough(s, 6);
            await sql`DELETE FROM user_media_state WHERE media_id = ${epId(s, 'S1E3')}::uuid`;
            await setRewatch(epId(s, 'S1E3'), 400_000, 60 * DAY_S, 600);

            const marker = await effectiveSeriesMarker({ userId, seriesId: s.seriesId, sql });

            expect(marker.state).toBe('in_progress');
            expect(marker.episode?.id).toBe(epId(s, 'S1E3'));
        });

        it('all main-line episodes watched is `finished` on the last watched episode', async () => {
            const s = await seedSeries(12);
            await watchThrough(s, 12);

            const marker = await effectiveSeriesMarker({ userId, seriesId: s.seriesId, sql });

            expect(marker.state).toBe('finished');
            expect(marker.episode?.id).toBe(epId(s, 'S1E12'));
            expect(marker.positionMs).toBe(0);
        });

        it('nothing watched is `not_started` with the first episode', async () => {
            const s = await seedSeries(13);

            const marker = await effectiveSeriesMarker({ userId, seriesId: s.seriesId, sql });

            expect(marker.state).toBe('not_started');
            expect(marker.episode?.id).toBe(epId(s, 'S1E1'));
        });

        it('a CW-dismissed series does not return its in-progress row', async () => {
            const s = await seedSeries(14);
            await watchThrough(s, 3);
            await setState(epId(s, 'S1E7'), { resumeMs: 1_320_000, ageSeconds: 3600 });
            await sql`
                INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
                VALUES (${userId}, ${s.seriesId}, 'series', 'dismissed_cw')
            `;

            const marker = await effectiveSeriesMarker({ userId, seriesId: s.seriesId, sql });

            expect(marker.state).not.toBe('in_progress');
            expect(marker.episode?.id).not.toBe(epId(s, 'S1E7'));
        });

        it('a season-0 special in progress never becomes the marker', async () => {
            const s = await seedSeries(15);
            await watchThrough(s, 3);
            const [special] = await sql<Array<{ id: string }>>`
                WITH season0 AS (
                    INSERT INTO media_items (title, media_type, status, parent_id, season_number)
                    VALUES ('Specials', 'season', 'active', ${s.seriesId}::uuid, 0)
                    RETURNING id
                )
                INSERT INTO media_items
                    (title, media_type, status, has_files, parent_id, season_number, episode_number, runtime_seconds)
                SELECT 'Special 1', 'episode', 'active', true, season0.id, 0, 1, ${EPISODE_RUNTIME_S}
                FROM season0
                RETURNING id
            `;
            await seedEpisodeFile(special.id);
            await setState(special.id, { resumeMs: 1_320_000 });

            const marker = await effectiveSeriesMarker({
                userId,
                seriesId: s.seriesId,
                fromEpisodeId: epId(s, 'S1E3'),
                sql,
            });

            expect(marker.episode?.id).not.toBe(special.id);
            expect(marker.episode?.seasonNumber).toBe(1);
            expect(marker.state).toBe('next');
            expect(marker.episode?.id).toBe(epId(s, 'S1E4'));
        });

        it('relation to `from`: E8 is forward of it, E12 is behind', async () => {
            const s = await seedSeries(16);
            await watchThrough(s, 8);
            await setState(epId(s, 'S1E10'), { resumeMs: 1_320_000, ageSeconds: DAY_S });

            const fromE8 = await effectiveSeriesMarker({
                userId,
                seriesId: s.seriesId,
                fromEpisodeId: epId(s, 'S1E8'),
                fromPositionMs: 600_000,
                sql,
            });
            expect(fromE8.episode?.id).toBe(epId(s, 'S1E10'));
            expect(fromE8.relation).toBe('forward');
            expect(fromE8.sameFileAsFrom).toBe(false);

            const fromE12 = await effectiveSeriesMarker({
                userId,
                seriesId: s.seriesId,
                fromEpisodeId: epId(s, 'S1E12'),
                fromPositionMs: 0,
                sql,
            });
            expect(fromE12.relation).toBe('behind');
        });

        it("self-contamination: the stale tab's own fresher row does not mask a later in-progress episode", async () => {
            const s = await seedSeries(17);
            await watchThrough(s, 7);
            await setState(epId(s, 'S1E8'), { resumeMs: 600_000 });
            await setState(epId(s, 'S1E10'), { resumeMs: 1_320_000, ageSeconds: DAY_S });

            const marker = await effectiveSeriesMarker({
                userId,
                seriesId: s.seriesId,
                fromEpisodeId: epId(s, 'S1E8'),
                fromPositionMs: 600_000,
                sql,
            });

            expect(marker.state).toBe('in_progress');
            expect(marker.episode?.id).toBe(epId(s, 'S1E10'));
            expect(marker.positionMs).toBe(1_320_000);
            expect(marker.relation).toBe('forward');
        });

        async function seedSession(opts: {
            mediaId: string;
            deviceId: string;
            clientName: string;
            positionMs: number;
            status?: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
            ageSeconds?: number;
        }): Promise<string> {
            const ageSeconds = opts.ageSeconds ?? 0;
            const status = opts.status ?? 'PAUSED';
            const [row] = await sql<Array<{ id: string }>>`
                INSERT INTO play_sessions (
                    media_id, user_id, device_id, ip_address, play_method, client_name,
                    status, position_ms, runtime_ms, started_at, last_heartbeat_at,
                    last_seen_at, paused_at, stopped_at
                )
                VALUES (
                    ${opts.mediaId}::uuid, ${userId}, ${opts.deviceId}, '127.0.0.1', 'direct',
                    ${opts.clientName}, ${status}, ${opts.positionMs}, ${EPISODE_RUNTIME_MS},
                    NOW() - make_interval(secs => ${ageSeconds + 600}),
                    NOW() - make_interval(secs => ${ageSeconds}),
                    NOW() - make_interval(secs => ${ageSeconds}),
                    CASE WHEN ${status} = 'PAUSED' THEN NOW() - make_interval(secs => ${ageSeconds}) END,
                    CASE WHEN ${status} = 'COMPLETED' THEN NOW() - make_interval(secs => ${ageSeconds}) END
                )
                RETURNING id
            `;
            return row.id;
        }

        it("M8: the caller's own session paused in the credits never advances next-up", async () => {
            const s = await seedSeries(19);
            await watchThrough(s, 8);
            const mine = await seedSession({
                mediaId: epId(s, 'S1E9'),
                deviceId: 'browser-1',
                clientName: 'Lumastra Web',
                positionMs: Math.floor(EPISODE_RUNTIME_MS * 0.97),
            });

            const marker = await effectiveSeriesMarker({
                userId,
                seriesId: s.seriesId,
                fromEpisodeId: epId(s, 'S1E9'),
                fromPositionMs: Math.floor(EPISODE_RUNTIME_MS * 0.97),
                excludeSessionId: mine,
                sql,
            });

            expect(marker.state).toBe('next');
            expect(marker.episode?.id).toBe(epId(s, 'S1E9'));
            expect(marker.relation).toBe('same');
        });

        it("device attribution skips the caller's own device, not just its session", async () => {
            const s = await seedSeries(20);
            await watchThrough(s, 8);
            await setState(epId(s, 'S1E10'), { resumeMs: 1_320_000, ageSeconds: 3600 });
            const e10 = epId(s, 'S1E10');
            await seedSession({
                mediaId: e10,
                deviceId: 'iphone-1',
                clientName: 'Lumastra iOS',
                positionMs: 1_320_000,
                status: 'COMPLETED',
                ageSeconds: 3 * 3600,
            });
            await seedSession({
                mediaId: e10,
                deviceId: 'browser-1',
                clientName: 'Lumastra Web',
                positionMs: 1_320_000,
                status: 'COMPLETED',
                ageSeconds: 3600,
            });
            const mine = await seedSession({
                mediaId: epId(s, 'S1E8'),
                deviceId: 'browser-1',
                clientName: 'Lumastra Web',
                positionMs: 600_000,
            });

            const marker = await effectiveSeriesMarker({
                userId,
                seriesId: s.seriesId,
                fromEpisodeId: epId(s, 'S1E8'),
                fromPositionMs: 600_000,
                excludeSessionId: mine,
                sql,
            });

            expect(marker.episode?.id).toBe(e10);
            expect(marker.deviceName).toBe('Lumastra iOS');
        });

        it('an in-progress episode without a season number is still the marker', async () => {
            const s = await seedSeries(21);
            await watchThrough(s, 3);
            await sql`UPDATE media_items SET season_number = NULL WHERE id = ${epId(s, 'S1E7')}::uuid`;
            await setState(epId(s, 'S1E7'), { resumeMs: 1_320_000, ageSeconds: 3600 });

            const marker = await effectiveSeriesMarker({ userId, seriesId: s.seriesId, sql });

            expect(marker.state).toBe('in_progress');
            expect(marker.episode?.id).toBe(epId(s, 'S1E7'));
            expect(marker.episode?.seasonNumber).toBe(1);
        });

        it("the finished context is the furthest watched episode, not a rewatch's", async () => {
            const s = await seedSeries(22);
            await watchThrough(s, 12);
            await setState(epId(s, 'S1E3'), { watched: true, ageSeconds: 60 });

            const summary = await getSeriesMainlineWatchSummary.one(sql, {
                userId,
                seriesId: s.seriesId,
            });

            expect(summary?.watched_episodes).toBe(12);
            expect(summary?.last_watched_episode_id).toBe(epId(s, 'S1E12'));
            // The recency still reflects the rewatch.
            const lastWatchedMs = new Date(String(summary?.last_watched_at)).getTime();
            expect(Date.now() - lastWatchedMs).toBeLessThan(10 * 60_000);
        });

        it('combined file: E10 resumed behind the caller playhead in E9E10 is behind', async () => {
            const s = await seedSeries(23);
            await watchThrough(s, 8);
            // File-absolute: E10 resumed at 25:00, the caller is at 40:00.
            await setState(epId(s, 'S1E10'), { resumeMs: 1_500_000, ageSeconds: DAY_S });
            // Replace the individual episode files with this combined-file layout.
            await sql`
                DELETE FROM media_files WHERE id IN (
                    SELECT file_id FROM media_file_items
                    WHERE media_item_id IN (${epId(s, 'S1E9')}, ${epId(s, 'S1E10')})
                )
            `;
            const [file] = await sql<Array<{ id: string }>>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES (${`/tmp/marker-${crypto.randomUUID()}/S01E09E10.mkv`}, ${EPISODE_RUNTIME_S * 2})
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${file.id}, ${epId(s, 'S1E9')}, true), (${file.id}, ${epId(s, 'S1E10')}, true)
            `;

            const marker = await effectiveSeriesMarker({
                userId,
                seriesId: s.seriesId,
                fromEpisodeId: epId(s, 'S1E9'),
                fromPositionMs: 2_400_000,
                sql,
            });

            expect(marker.episode?.id).toBe(epId(s, 'S1E10'));
            expect(marker.sameFileAsFrom).toBe(true);
            expect(marker.relation).toBe('behind');
        });

        it('episodes sharing one media file report sameFileAsFrom', async () => {
            const s = await seedSeries(18);
            await watchThrough(s, 8);
            await setState(epId(s, 'S1E10'), { resumeMs: 1_320_000, ageSeconds: DAY_S });
            // Replace the individual episode files with this combined-file layout.
            await sql`
                DELETE FROM media_files WHERE id IN (
                    SELECT file_id FROM media_file_items
                    WHERE media_item_id IN (${epId(s, 'S1E9')}, ${epId(s, 'S1E10')})
                )
            `;
            const [file] = await sql<Array<{ id: string }>>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES (${`/tmp/marker-${crypto.randomUUID()}/S01E09E10.mkv`}, ${EPISODE_RUNTIME_S * 2})
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${file.id}, ${epId(s, 'S1E9')}, true), (${file.id}, ${epId(s, 'S1E10')}, true)
            `;

            const marker = await effectiveSeriesMarker({
                userId,
                seriesId: s.seriesId,
                fromEpisodeId: epId(s, 'S1E9'),
                sql,
            });

            expect(marker.episode?.id).toBe(epId(s, 'S1E10'));
            expect(marker.relation).toBe('forward');
            expect(marker.sameFileAsFrom).toBe(true);
        });
    });
});
