// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { closeTestDb, getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestSeries,
    createTestMediaItem,
    insertTestMediaItem,
    ensureTestUser,
    generateTestUserId,
    insertTestEpisodeWatchStatus,
    placeInLibraryGroup,
} from '../../../../../tests/integration/fixtures/index.js';
import { rebuildStateFromEvents } from '../../services/watch-state-rebuilder.service.js';
import {
    getContinueWatchingFromDb,
    getNextUpFromDb,
    getNextUpForSeriesFromDb,
    getSeriesMainlineWatchSummary,
    computeAllSeriesProgress,
    getWatchedSeriesFromDb,
} from './watch-state.queries.js';

describe('Watch State Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'user_media_flags',
            'user_media_events',
            'user_media_state',
            'media_file_items',
            'media_files',
            'media_items',
            'external_ids',
            'provider_metadata',
            'library_availability',
        ]);
    });

    async function createAndInsertPlayableTestSeries(
        testSql: postgres.Sql,
        options: Parameters<typeof createAndInsertTestSeries>[1],
    ): Promise<Awaited<ReturnType<typeof createAndInsertTestSeries>>> {
        const series = await createAndInsertTestSeries(testSql, options);
        await testSql`
            UPDATE media_items
            SET has_files = true
            WHERE media_type = 'episode'
              AND parent_id IN (
                  SELECT id FROM media_items
                  WHERE parent_id = ${series.seriesId}::uuid
                    AND media_type = 'season'
              )
        `;
        return series;
    }

    it('keeps a recent resume on an earlier episode even when later episodes are watched', async () => {
        const userId = generateTestUserId('cw_rewatch');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Star Harbor: Enterprise',
            seasonCount: 1,
            episodesPerSeason: 5,
            episodeRuntimeSeconds: 45 * 60,
        });

        const resumeEpisodeJellyfinId = series.seasons[0].episodes[1].jellyfin_id;
        const laterWatchedEpisodeJellyfinId = series.seasons[0].episodes[3].jellyfin_id;

        const [resumeEpisode] = await sql<{ media_id: string }[]>`
            SELECT media_id
            FROM external_ids
            WHERE provider = 'jellyfin'
              AND external_id = ${resumeEpisodeJellyfinId}
            LIMIT 1
        `;
        const [laterWatchedEpisode] = await sql<{ media_id: string }[]>`
            SELECT media_id
            FROM external_ids
            WHERE provider = 'jellyfin'
              AND external_id = ${laterWatchedEpisodeJellyfinId}
            LIMIT 1
        `;

        expect(resumeEpisode).toBeDefined();
        expect(laterWatchedEpisode).toBeDefined();

        await sql`
            INSERT INTO user_media_state (
                user_id,
                media_id,
                is_watched,
                resume_position_ms,
                runtime_ms,
                watch_count,
                last_watched_at,
                first_watched_at,
                last_event_at,
                last_event_source,
                highest_session_elapsed_ms
            )
            VALUES
                (
                    ${userId},
                    ${resumeEpisode.media_id}::uuid,
                    false,
                    ${15 * 60 * 1000},
                    ${45 * 60 * 1000},
                    0,
                    null,
                    null,
                    NOW() - INTERVAL '1 day',
                    'lumastra-player',
                    ${15 * 60 * 1000}
                ),
                (
                    ${userId},
                    ${laterWatchedEpisode.media_id}::uuid,
                    true,
                    0,
                    ${45 * 60 * 1000},
                    1,
                    NOW() - INTERVAL '10 days',
                    NOW() - INTERVAL '10 days',
                    NOW() - INTERVAL '10 days',
                    'lumastra-player',
                    null
                )
        `;

        const rows = await getContinueWatchingFromDb.all(sql, {
            userId,
            limit: 10,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 180,
            collapsePerSeries: true,
        });

        expect(rows.map((row) => row.media_id)).toContain(resumeEpisode.media_id);
    });

    // ─────────────────────────────────────────────────────────────────
    // getContinueWatchingFromDb: migration-sourced movies must not ride
    // the engagement branch. The M0 backfill seeds
    // highest_session_elapsed_ms = resume_position_ms, so a stale sub-1%
    // legacy resume (66s of a synthetic 193-min movie) would otherwise
    // clear the flat 60s engagement gate
    // and surface as a phantom "Continue Watching · 0%" the user never
    // started. Migration rows must qualify on real percentage progress
    // (the legacy percent branch) instead.
    // ─────────────────────────────────────────────────────────────────

    /** Seed a single movie resume row. Returns the movie's media_id. */
    async function seedMovieResume(
        sql: postgres.Sql,
        userId: ReturnType<typeof generateTestUserId>,
        opts: {
            title: string;
            resumeMs: number;
            runtimeMs: number;
            source: string;
            highestSessionElapsedMs: number | null;
        },
    ): Promise<string> {
        const movie = await createAndInsertTestMovie(sql, {
            title: opts.title,
            withFileItem: true,
        });
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                watch_count, last_watched_at, first_watched_at, last_event_at,
                last_event_source, highest_session_elapsed_ms
            )
            VALUES (
                ${userId}, ${movie.id}::uuid, false, ${opts.resumeMs}, ${opts.runtimeMs},
                0, null, null, NOW() - INTERVAL '5 days',
                ${opts.source}, ${opts.highestSessionElapsedMs}
            )
        `;
        return movie.id;
    }

    const CW_PARAMS = {
        limit: 10,
        minMs: 30_000,
        minPercent: 10,
        maxAgeDays: 180,
        collapsePerSeries: true,
    } as const;

    it('CW: a sub-10% migration-sourced movie does NOT surface (Avatar phantom)', async () => {
        const userId = generateTestUserId('cw_mig_phantom');
        await ensureTestUser(sql, userId);

        const movieId = await seedMovieResume(sql, userId, {
            title: 'Voyager: The Way of Lanterns',
            resumeMs: 66_000, // 66s
            runtimeMs: 193 * 60 * 1000, // ~0.57%
            source: 'migration',
            highestSessionElapsedMs: 66_000, // backfill copies position → elapsed
        });

        const rows = await getContinueWatchingFromDb.all(sql, { userId, ...CW_PARAMS });

        expect(rows.map((r) => r.media_id)).not.toContain(movieId);
    });

    it('CW: a migration-sourced movie with real ≥10% progress still surfaces', async () => {
        const userId = generateTestUserId('cw_mig_real');
        await ensureTestUser(sql, userId);

        const movieId = await seedMovieResume(sql, userId, {
            title: 'First Light',
            resumeMs: 50 * 60 * 1000, // 50 min of...
            runtimeMs: 100 * 60 * 1000, // ...100 min = 50%
            source: 'migration',
            highestSessionElapsedMs: 50 * 60 * 1000,
        });

        const rows = await getContinueWatchingFromDb.all(sql, { userId, ...CW_PARAMS });

        expect(rows.map((r) => r.media_id)).toContain(movieId);
    });

    it('CW: an unavailable movie with a retained Jellyfin link does not surface', async () => {
        const userId = generateTestUserId('cw_jf_no_file');
        await ensureTestUser(sql, userId);

        const movieId = await seedMovieResume(sql, userId, {
            title: 'File Removed, Provider Link Retained',
            resumeMs: 50 * 60 * 1000,
            runtimeMs: 100 * 60 * 1000,
            source: 'lumastra-player',
            highestSessionElapsedMs: 50 * 60 * 1000,
        });
        await sql`UPDATE media_items SET has_files = false WHERE id = ${movieId}::uuid`;

        const rows = await getContinueWatchingFromDb.all(sql, { userId, ...CW_PARAMS });

        expect(rows.map((row) => row.media_id)).not.toContain(movieId);
    });

    it('CW: a sub-10% lumastra-player movie does not surface after a brief real play', async () => {
        const userId = generateTestUserId('cw_player_engage');
        await ensureTestUser(sql, userId);

        const movieId = await seedMovieResume(sql, userId, {
            title: 'A Genuinely Started Movie',
            resumeMs: 66_000,
            runtimeMs: 193 * 60 * 1000, // ~0.57% but real 66s of play
            source: 'lumastra-player',
            highestSessionElapsedMs: 66_000,
        });

        const rows = await getContinueWatchingFromDb.all(sql, { userId, ...CW_PARAMS });

        expect(rows.map((r) => r.media_id)).not.toContain(movieId);
    });

    // ─────────────────────────────────────────────────────────────────
    // getContinueWatchingFromDb: audiobooks bypass the percent-of-runtime
    // gate. A 10-20h audiobook needs 1-2h of real listening to clear the
    // 10% threshold above, so a book the user just started never surfaced
    // (regression from commit 4725c4e04, which dropped the engagement
    // promotion path movies rely on). Audiobooks instead just need the flat
    // minMs floor, same as the unknown-runtime branch.
    // ─────────────────────────────────────────────────────────────────

    async function seedAudiobookResume(
        sql: postgres.Sql,
        userId: ReturnType<typeof generateTestUserId>,
        opts: { title: string; resumeMs: number; runtimeMs: number },
    ): Promise<string> {
        const item = createTestMediaItem({
            title: opts.title,
            media_type: 'audiobook',
            has_files: true,
        });
        await insertTestMediaItem(sql, item);
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                watch_count, last_watched_at, first_watched_at, last_event_at,
                last_event_source, highest_session_elapsed_ms
            )
            VALUES (
                ${userId}, ${item.id}::uuid, false, ${opts.resumeMs}, ${opts.runtimeMs},
                0, null, null, NOW() - INTERVAL '5 minutes',
                'lumastra-player', ${opts.resumeMs}
            )
        `;
        return item.id;
    }

    it('CW: a just-started long audiobook (sub-10%) surfaces', async () => {
        const userId = generateTestUserId('cw_audiobook_started');
        await ensureTestUser(sql, userId);

        const bookId = await seedAudiobookResume(sql, userId, {
            title: 'Jenseits der Zeit',
            resumeMs: 6 * 60 * 1000, // 6 min listened...
            runtimeMs: 14 * 60 * 60 * 1000, // ...of a 14h book (~0.7%)
        });

        const rows = await getContinueWatchingFromDb.all(sql, { userId, ...CW_PARAMS });

        expect(rows.map((r) => r.media_id)).toContain(bookId);
    });

    it('CW: an audiobook below the minMs floor does not surface', async () => {
        const userId = generateTestUserId('cw_audiobook_too_brief');
        await ensureTestUser(sql, userId);

        const bookId = await seedAudiobookResume(sql, userId, {
            title: 'A Barely-Opened Book',
            resumeMs: 5_000, // 5s, under the 30s minMs floor
            runtimeMs: 14 * 60 * 60 * 1000,
        });

        const rows = await getContinueWatchingFromDb.all(sql, { userId, ...CW_PARAMS });

        expect(rows.map((r) => r.media_id)).not.toContain(bookId);
    });

    // ─────────────────────────────────────────────────────────────────
    // getNextUpFromDb: migration-source filter (commit 8fdefd4bd)
    // ─────────────────────────────────────────────────────────────────

    async function seedWatchedEpisode(
        sql: postgres.Sql,
        userId: string,
        mediaId: string,
        source: string | null,
        opts: { lastWatchedDaysAgo?: number } = {},
    ): Promise<void> {
        const days = opts.lastWatchedDaysAgo ?? 5;
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms,
                runtime_ms, watch_count, last_watched_at, first_watched_at,
                last_event_at, last_event_source, highest_session_elapsed_ms
            ) VALUES (
                ${userId},
                ${mediaId}::uuid,
                true,
                0,
                ${45 * 60 * 1000},
                1,
                NOW() - (${days} || ' days')::interval,
                NOW() - (${days} || ' days')::interval,
                NOW() - (${days} || ' days')::interval,
                ${source},
                null
            )
        `;
    }

    async function resolveJfId(sql: postgres.Sql, jellyfinId: string): Promise<string> {
        const [row] = await sql<{ media_id: string }[]>`
            SELECT media_id FROM external_ids
            WHERE provider = 'jellyfin' AND external_id = ${jellyfinId}
            LIMIT 1
        `;
        if (!row) throw new Error(`No internal id for jellyfin ${jellyfinId}`);
        return row.media_id;
    }

    it('NextUp: excludes a series whose only watched episodes are migration-sourced', async () => {
        const userId = generateTestUserId('nu_migration_only');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Weihnachtsmann & Co. KG',
            seasonCount: 1,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 22 * 60,
        });

        const e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);

        // Only event for the series: a migration-imported watched flag.
        await seedWatchedEpisode(sql, userId, e1, 'migration');

        const rows = await getNextUpFromDb.all(sql, {
            userId,
            limit: 20,
            maxAgeDays: 60,
        });

        // Series should NOT surface in NextUp — the migration-only filter
        // excludes it even though E1 is recently watched and E2 exists.
        expect(rows.map((r) => r.title)).not.toContain(series.seasons[0].episodes[1].title);
    });

    it('NextUp: includes a series with mixed migration + real Lumastra activity', async () => {
        const userId = generateTestUserId('nu_mixed');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Mixed Series',
            seasonCount: 1,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });

        const e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        const e2 = await resolveJfId(sql, series.seasons[0].episodes[1].jellyfin_id);

        // E1 imported via migration, E2 watched in Lumastra.
        await seedWatchedEpisode(sql, userId, e1, 'migration');
        await seedWatchedEpisode(sql, userId, e2, 'lumastra-player');

        const rows = await getNextUpFromDb.all(sql, {
            userId,
            limit: 20,
            maxAgeDays: 60,
        });

        // Real Lumastra activity rescues the series — E3 surfaces as next up.
        expect(rows.map((r) => r.media_id)).toContain(
            await resolveJfId(sql, series.seasons[0].episodes[2].jellyfin_id),
        );
    });

    it('NextUp: includes a series with NULL last_event_source (legacy data passes through)', async () => {
        const userId = generateTestUserId('nu_null_source');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Legacy Series',
            seasonCount: 1,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });

        const e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);

        // Pre-migration / legacy row with no recorded source. Treated as
        // legitimate engagement so we don't silently drop legacy data.
        await seedWatchedEpisode(sql, userId, e1, null);

        const rows = await getNextUpFromDb.all(sql, {
            userId,
            limit: 20,
            maxAgeDays: 60,
        });

        // Series surfaces — NULL source is not 'migration', so the filter
        // passes through.
        expect(rows.map((r) => r.media_id)).toContain(
            await resolveJfId(sql, series.seasons[0].episodes[1].jellyfin_id),
        );
    });

    it('NextUp home query skips metadata-only E2 with a retained Jellyfin ID', async () => {
        const userId = generateTestUserId('nu_home_retained_id');
        await ensureTestUser(sql, userId);
        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'File-Less Middle Episode',
            seasonCount: 1,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });
        const e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        const e2 = await resolveJfId(sql, series.seasons[0].episodes[1].jellyfin_id);
        const e3 = await resolveJfId(sql, series.seasons[0].episodes[2].jellyfin_id);
        await seedWatchedEpisode(sql, userId, e1, 'lumastra-player');
        await sql`UPDATE media_items SET has_files = false WHERE id = ${e2}::uuid`;

        const rows = await getNextUpFromDb.all(sql, { userId, limit: 10, maxAgeDays: 60 });

        expect(rows.map((row) => row.media_id)).toContain(e3);
        expect(rows.map((row) => row.media_id)).not.toContain(e2);
    });

    it('mainline summary excludes an unavailable episode with a retained Jellyfin ID', async () => {
        const userId = generateTestUserId('mainline_retained_id');
        await ensureTestUser(sql, userId);
        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Mainline File Eligibility',
            seasonCount: 1,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });
        const e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        const e2 = await resolveJfId(sql, series.seasons[0].episodes[1].jellyfin_id);
        await seedWatchedEpisode(sql, userId, e1, 'lumastra-player');
        await seedWatchedEpisode(sql, userId, e2, 'lumastra-player');
        await sql`UPDATE media_items SET has_files = false WHERE id = ${e2}::uuid`;

        const summary = await getSeriesMainlineWatchSummary.one(sql, {
            userId,
            seriesId: series.seriesId,
        });

        expect(summary).toEqual(
            expect.objectContaining({
                total_episodes: 2,
                watched_episodes: 1,
                last_watched_episode_id: e1,
            }),
        );
    });

    // ─────────────────────────────────────────────────────────────────
    // getNextUpFromDb: most-recently-watched anchor
    // (anchor switches from MAX(order) → DISTINCT ON last_watched_at desc)
    // ─────────────────────────────────────────────────────────────────

    /**
     * Seed an explicit timestamp on a watched episode so we can express
     * "watched at exactly time T" (the seedWatchedEpisode helper above
     * only takes a relative day count).
     */
    async function seedWatchedAt(
        sql: postgres.Sql,
        userId: string,
        mediaId: string,
        source: string,
        atIso: string,
    ): Promise<void> {
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms,
                runtime_ms, watch_count, last_watched_at, first_watched_at,
                last_event_at, last_event_source, highest_session_elapsed_ms
            ) VALUES (
                ${userId}, ${mediaId}::uuid, true, 0,
                ${45 * 60 * 1000}, 1,
                ${atIso}::timestamptz, ${atIso}::timestamptz,
                ${atIso}::timestamptz, ${source}, null
            )
        `;
    }

    it('NextUp: anchors on the most recently watched episode (re-watch advances NextUp)', async () => {
        // User finished the series in 2025 (each episode last_watched in
        // 2025), then re-watched S2E2 to completion today. NextUp must
        // anchor on S2E2 (today's last_watched_at) and surface S2E3 — not
        // be empty because the OLD finale completion was furthest forward.
        const userId = generateTestUserId('nu_rewatch_anchor');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Re-watch Anchor Series',
            seasonCount: 3,
            episodesPerSeason: 4,
            episodeRuntimeSeconds: 45 * 60,
        });

        // Seed every episode as watched in 2025 except S2E2 — the
        // re-watch we'll bump separately.
        const episodes = series.seasons.flatMap((s) => s.episodes);
        for (const ep of episodes) {
            const mediaId = await resolveJfId(sql, ep.jellyfin_id);
            const isS2E2 = ep.season_number === 2 && ep.episode_number === 2;
            if (isS2E2) continue;
            await seedWatchedAt(sql, userId, mediaId, 'lumastra-player', '2025-12-15T20:00:00Z');
        }

        // Re-watch S2E2 today.
        const s2e2 = await resolveJfId(sql, series.seasons[1].episodes[1].jellyfin_id);
        await seedWatchedAt(sql, userId, s2e2, 'lumastra-player', new Date().toISOString());

        const rows = await getNextUpFromDb.all(sql, {
            userId,
            limit: 20,
            maxAgeDays: 365,
        });

        const s2e3 = await resolveJfId(sql, series.seasons[1].episodes[2].jellyfin_id);
        expect(rows.map((r) => r.media_id)).toContain(s2e3);
    });

    it('NextUp: surfaces an already-watched next episode during re-watch', async () => {
        // After a full prior watchthrough, every episode is is_watched=true.
        // The re-watch completion of S1E1 today must surface S1E2 in
        // NextUp even though S1E2 was watched long ago — the old "exclude
        // already-watched" filter was the bug that hid the entire series
        // post-watchthrough.
        const userId = generateTestUserId('nu_rewatch_already_watched');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Already Watched',
            seasonCount: 2,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });

        for (const ep of series.seasons.flatMap((s) => s.episodes)) {
            const mediaId = await resolveJfId(sql, ep.jellyfin_id);
            const isS1E1 = ep.season_number === 1 && ep.episode_number === 1;
            if (isS1E1) continue;
            await seedWatchedAt(sql, userId, mediaId, 'lumastra-player', '2025-09-01T20:00:00Z');
        }

        const s1e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        await seedWatchedAt(sql, userId, s1e1, 'lumastra-player', new Date().toISOString());

        const rows = await getNextUpFromDb.all(sql, {
            userId,
            limit: 20,
            maxAgeDays: 365,
        });

        const s1e2 = await resolveJfId(sql, series.seasons[0].episodes[1].jellyfin_id);
        expect(rows.map((r) => r.media_id)).toContain(s1e2);
    });

    it('NextUp: bulk-mark-series-watched returns no next (anchor ties → finale)', async () => {
        // Modal "mark series watched" writes every episode at the same
        // instant. last_watched_at ties on every row → DISTINCT ON
        // tiebreak by order DESC picks the finale → no episode has
        // higher order → NextUp empty. Confirms the bulk-mark UX
        // promise: marking the series done means done, not "now NextUp
        // dragged backward to S1E2".
        const userId = generateTestUserId('nu_bulk_mark_no_next');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Bulk Marked',
            seasonCount: 2,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });

        const bulkInstant = new Date().toISOString();
        for (const ep of series.seasons.flatMap((s) => s.episodes)) {
            const mediaId = await resolveJfId(sql, ep.jellyfin_id);
            await seedWatchedAt(sql, userId, mediaId, 'lumastra-user-mark', bulkInstant);
        }

        const rows = await getNextUpFromDb.all(sql, {
            userId,
            limit: 20,
            maxAgeDays: 365,
        });

        const seriesEpisodeIds = await Promise.all(
            series.seasons.flatMap((s) => s.episodes).map((ep) => resolveJfId(sql, ep.jellyfin_id)),
        );
        for (const id of seriesEpisodeIds) {
            expect(rows.map((r) => r.media_id)).not.toContain(id);
        }
    });

    it('NextUp: a watched special does not anchor (no jump back to S1E1)', async () => {
        // User watched a behind-the-scenes special last week and a
        // regular S2E2 today. Anchor must follow S2E2 (the most recent
        // *main-line* completion), not the special — even though the
        // special's last_watched_at might be newer than older main-line
        // rows. The `season_number > 0` gate inside watched_per_series
        // enforces this.
        const userId = generateTestUserId('nu_special_no_anchor');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Series With Specials As Anchor',
            seasonCount: 3,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 30 * 60,
        });

        // Patch S1 to season 0 → it's the specials season.
        const [specialsRow] = await sql<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE parent_id = ${series.seriesId}::uuid
              AND media_type = 'season'
              AND season_number = 1
            LIMIT 1
        `;
        const specialsSeasonId = specialsRow.id;
        await sql`UPDATE media_items SET season_number = 0 WHERE id = ${specialsSeasonId}::uuid`;
        await sql`
            UPDATE media_items SET season_number = 0
            WHERE parent_id = ${specialsSeasonId}::uuid AND media_type = 'episode'
        `;

        const specialEp1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        const s2e2 = await resolveJfId(sql, series.seasons[1].episodes[1].jellyfin_id);
        const s2e3 = await resolveJfId(sql, series.seasons[1].episodes[2].jellyfin_id);

        // Special watched today (most recent in absolute terms).
        await seedWatchedAt(sql, userId, specialEp1, 'lumastra-player', new Date().toISOString());
        // S2E2 watched 1 hour ago — still recent, but older than the special.
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await seedWatchedAt(sql, userId, s2e2, 'lumastra-player', oneHourAgo);

        const rows = await getNextUpFromDb.all(sql, {
            userId,
            limit: 20,
            maxAgeDays: 365,
        });

        // Anchor ignores the special; S2E2 wins (newest *main-line* row).
        // NextUp = S2E3 — NOT some earlier episode that would result if
        // the special anchored.
        expect(rows.map((r) => r.media_id)).toContain(s2e3);
        // And NextUp must not surface S2E1 (which would happen if the
        // special's order=1 anchored).
        const s2e1 = await resolveJfId(sql, series.seasons[1].episodes[0].jellyfin_id);
        expect(rows.map((r) => r.media_id)).not.toContain(s2e1);
    });

    it('NextUpForSeries: uniform-bulk migration drops out via the order-DESC tiebreak (no stale next)', async () => {
        // Excluding migration rows entirely would drop genuine per-row
        // watch dates and recent season backfills whose older engagement
        // falls outside maxAgeDays. Both remain valid anchor candidates.
        //
        // The remaining real concern is uniform-bulk migration (every
        // row written at the same wall-clock instant — the bulk-import
        // shape). Order-DESC tiebreak handles it: the finale wins,
        // next > finale = nothing, query returns null. /watch/[seriesId]
        // then falls back to getFirstEpisode for "start over" semantics.
        const userId = generateTestUserId('nu_per_series_bulk_migration');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Bulk Migration Series',
            seasonCount: 3,
            episodesPerSeason: 4,
            episodeRuntimeSeconds: 45 * 60,
        });

        // Every episode written at the SAME instant — single bulk
        // import wall-clock, no real per-episode watch dates.
        const bulkInstant = '2025-09-01T10:00:00Z';
        const allEpisodes = series.seasons.flatMap((s) => s.episodes);
        for (const ep of allEpisodes) {
            const mediaId = await resolveJfId(sql, ep.jellyfin_id);
            await seedWatchedAt(sql, userId, mediaId, 'migration', bulkInstant);
        }

        const result = await getNextUpForSeriesFromDb.one(sql, {
            seriesMediaId: series.seriesId,
            userId,
        });

        // Finale anchored via order-DESC tiebreak → next > finale → none.
        expect(result).toBeNull();
    });

    it('NextUpForSeries: migration with realistic per-row timestamps anchors on the latest watched (dated history)', async () => {
        // Synthetic dated history: every episode watched with a real
        // LastPlayedDate per row, migration imported those timestamps
        // verbatim. The latest by timestamp is S3E4 (the finale) →
        // next > finale → null → /watch/[seriesId] falls back to
        // getFirstEpisode and the home strip drops the series. No
        // stale mid-series "next" surfaces.
        const userId = generateTestUserId('nu_per_series_dated_history');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Cloud Lantern Academy',
            seasonCount: 3,
            episodesPerSeason: 4,
            episodeRuntimeSeconds: 45 * 60,
        });

        // Realistic spread: each episode has its own timestamp matching
        // when the user actually watched it. Last episode watched is
        // S3E4 (the finale).
        const allEpisodes = series.seasons.flatMap((s) => s.episodes);
        for (let i = 0; i < allEpisodes.length; i++) {
            const mediaId = await resolveJfId(sql, allEpisodes[i].jellyfin_id);
            await seedWatchedAt(
                sql,
                userId,
                mediaId,
                'migration',
                new Date(2025, 9, 1, 10, i, 0).toISOString(),
            );
        }

        const result = await getNextUpForSeriesFromDb.one(sql, {
            seriesMediaId: series.seriesId,
            userId,
        });

        expect(result).toBeNull();
    });

    it('NextUp (home strip): migration anchors when lumastra is out of window (recent backfill)', async () => {
        // Older Jellyfin engagement is outside maxAgeDays. A newer S3
        // backfill lands via migration inside the window. Without migration as
        // a valid anchor candidate, the series gets no anchor → no
        // Next Up, even though S4 just dropped. With migration trusted,
        // the bulk S3 timestamps tie at one instant, order-DESC picks
        // S3-finale, next > S3-finale = S4E1.
        const userId = generateTestUserId('nu_home_migration_fallback');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Old Lumastra + Recent Migration Backfill',
            seasonCount: 4,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });

        // Lumastra engagement from 18 months ago — outside any
        // reasonable maxAgeDays window.
        const s1e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        await seedWatchedAt(sql, userId, s1e1, 'jellyfin-sync', '2024-10-15T20:00:00Z');

        // Fresh-but-bulk migration of S2 + S3 (within the default
        // 60-day window). Use a
        // relative offset (not an absolute date) so it stays inside the
        // maxAgeDays window over time rather than silently aging out.
        const s3FinaleInstant = new Date(Date.now() - 27 * 24 * 60 * 60 * 1000).toISOString();
        for (const ep of series.seasons[1].episodes) {
            const id = await resolveJfId(sql, ep.jellyfin_id);
            await seedWatchedAt(sql, userId, id, 'migration', s3FinaleInstant);
        }
        for (const ep of series.seasons[2].episodes) {
            const id = await resolveJfId(sql, ep.jellyfin_id);
            await seedWatchedAt(sql, userId, id, 'migration', s3FinaleInstant);
        }

        const rows = await getNextUpFromDb.all(sql, {
            userId,
            limit: 20,
            maxAgeDays: 60,
        });

        // S3-finale wins via order-DESC tiebreak → next is S4E1.
        const s4e1 = await resolveJfId(sql, series.seasons[3].episodes[0].jellyfin_id);
        expect(rows.map((r) => r.media_id)).toContain(s4e1);
    });

    it('NextUp (home strip): real older non-migration timestamp wins over bulk-migration cluster (older genuine watch)', async () => {
        // A genuine S1E10 watch predates a bulk import of S1E4-S1E9.
        // Missing LastPlayedDate values made COALESCE fall back to the
        // import wall-clock. Without bulk-cluster deprioritization, the
        // newer import rows beat the finale's actual watch timestamp,
        // suggesting S1E10 even though it was already watched.
        //
        // The deprioritization tags any migration row whose
        // last_watched_at is shared by 3+ siblings (the bulk-import
        // signature) and lets the real older non-migration row anchor
        // instead. Anchor S1E10 → no episode beyond → series drops.
        const userId = generateTestUserId('nu_older_genuine_watch');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Moonlit Harbor',
            seasonCount: 1,
            episodesPerSeason: 10,
            episodeRuntimeSeconds: 45 * 60,
        });

        // S1E1-3: real per-row migration timestamps (each unique).
        for (let i = 0; i < 3; i++) {
            const id = await resolveJfId(sql, series.seasons[0].episodes[i].jellyfin_id);
            await seedWatchedAt(
                sql,
                userId,
                id,
                'migration',
                new Date(Date.now() - (10 - i) * 24 * 60 * 60 * 1000).toISOString(),
            );
        }
        // S1E4-9: bulk migration — six rows tied at the same instant.
        const bulkInstant = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
        for (let i = 3; i < 9; i++) {
            const id = await resolveJfId(sql, series.seasons[0].episodes[i].jellyfin_id);
            await seedWatchedAt(sql, userId, id, 'migration', bulkInstant);
        }
        // S1E10: real older jellyfin-sync row (between the unique
        // migration timestamps and the bulk one in calendar terms, but
        // older than the bulk timestamp specifically).
        const s1e10 = await resolveJfId(sql, series.seasons[0].episodes[9].jellyfin_id);
        await seedWatchedAt(
            sql,
            userId,
            s1e10,
            'jellyfin-sync',
            new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        );

        const rows = await getNextUpFromDb.all(sql, {
            userId,
            limit: 20,
            maxAgeDays: 60,
        });

        // None of the series's episodes should appear: S1E10 anchors
        // (real timestamp wins over bulk cluster), there's no S1E11.
        const episodeIds = await Promise.all(
            series.seasons[0].episodes.map((ep) => resolveJfId(sql, ep.jellyfin_id)),
        );
        for (const id of episodeIds) {
            expect(rows.map((r) => r.media_id)).not.toContain(id);
        }
    });

    it('NextUp (home strip): real Jellyfin per-row migration timestamps drop a fully-watched series (dated history)', async () => {
        // Mirror of the per-series Dark test for the home strip:
        // every episode imported via migration with realistic per-row
        // timestamps; the latest by timestamp IS the finale; the
        // series should drop out of Next Up entirely instead of
        // surfacing a stale mid-series "next".
        const userId = generateTestUserId('nu_home_dark_shape');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Home-strip Dark Shape',
            seasonCount: 3,
            episodesPerSeason: 4,
            episodeRuntimeSeconds: 45 * 60,
        });

        const allEpisodes = series.seasons.flatMap((s) => s.episodes);
        for (let i = 0; i < allEpisodes.length; i++) {
            const mediaId = await resolveJfId(sql, allEpisodes[i].jellyfin_id);
            // Recent enough to stay inside the 60-day maxAgeDays window
            // — minutes apart, finale (last iteration) is the latest.
            await seedWatchedAt(
                sql,
                userId,
                mediaId,
                'migration',
                new Date(Date.now() - (allEpisodes.length - i) * 60_000).toISOString(),
            );
        }

        const rows = await getNextUpFromDb.all(sql, {
            userId,
            limit: 20,
            maxAgeDays: 60,
        });

        // None of the series's episodes should appear (anchor = finale,
        // no episode beyond it).
        const ids = new Set(
            await Promise.all(allEpisodes.map((ep) => resolveJfId(sql, ep.jellyfin_id))),
        );
        for (const row of rows) {
            expect(ids.has(row.media_id)).toBe(false);
        }
    });

    it('CW: a re-watch in progress survives a later mark-watched on an unrelated finale', async () => {
        // User is mid-rewatch of S2E3 (is_watched=true from a prior
        // watchthrough; resume>0 from today's progress; last_event_at
        // bumped past last_watched_at). Then they mark S5E22 watched.
        // The stale-resume suppression filter must NOT drop S2E3 — it's
        // the user's actively-playing row, not a stale paused state.
        const userId = generateTestUserId('cw_rewatch_suppression_exempt');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Rewatch + Late Mark',
            seasonCount: 5,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });

        const s2e3 = await resolveJfId(sql, series.seasons[1].episodes[2].jellyfin_id);
        const s5e3 = await resolveJfId(sql, series.seasons[4].episodes[2].jellyfin_id);

        // Prior completion months ago + fresh re-watch progress today.
        // is_watched stays true (carried), resume>0 (current playhead),
        // last_event_at = 1 hour ago (most recent progress),
        // last_watched_at = 2025 (the original completion).
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms,
                runtime_ms, watch_count, last_watched_at, first_watched_at,
                last_event_at, last_event_source, highest_session_elapsed_ms
            ) VALUES (
                ${userId},
                ${s2e3}::uuid,
                true,
                ${20 * 60 * 1000},
                ${45 * 60 * 1000},
                1,
                '2025-12-15T20:00:00Z'::timestamptz,
                '2025-12-15T20:00:00Z'::timestamptz,
                ${oneHourAgo}::timestamptz,
                'lumastra-player',
                ${20 * 60 * 1000}
            )
        `;
        // Later episode (finale) marked watched 30 minutes ago — strictly
        // after S2E3's last_event_at. Without the re-watch exemption
        // this would suppress S2E3.
        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        await seedWatchedAt(sql, userId, s5e3, 'lumastra-user-mark', thirtyMinAgo);

        const rows = await getContinueWatchingFromDb.all(sql, {
            userId,
            limit: 20,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 365,
            collapsePerSeries: true,
        });

        expect(rows.map((r) => r.media_id)).toContain(s2e3);
    });

    it('CW: is_watched=true row with NULL last_watched_at stays hidden', async () => {
        // This assertion used to be the opposite. The permissive branch was
        // justified by "12.44.0 backfills last_watched_at, so a NULL is
        // theoretical" — but jellyfin-sync can
        // writes is_watched=true together with resume_position_ms > 0 and
        // last_watched_at unset, and every such row surfaced in Continue
        // Watching as an episode the user had already finished. Multiple such
        // rows can crowd the rail with watched episodes of one series.
        //
        // NULL last_watched_at is not evidence of a re-watch, so it must not
        // grant one. Rows we cannot prove are being re-watched stay hidden —
        // Next Up and the series page still surface the show.
        const userId = generateTestUserId('cw_legacy_null_last_watched');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Legacy Null Last Watched',
            seasonCount: 1,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });

        const e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms,
                runtime_ms, watch_count, last_watched_at, first_watched_at,
                last_event_at, last_event_source, highest_session_elapsed_ms
            ) VALUES (
                ${userId},
                ${e1}::uuid,
                true,
                ${10 * 60 * 1000},
                ${45 * 60 * 1000},
                1,
                NULL,
                NULL,
                ${oneHourAgo}::timestamptz,
                'lumastra-player',
                ${10 * 60 * 1000}
            )
        `;

        const rows = await getContinueWatchingFromDb.all(sql, {
            userId,
            limit: 20,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 365,
            collapsePerSeries: true,
        });

        expect(rows.map((r) => r.media_id)).not.toContain(e1);
    });

    it('CW: one series cannot occupy more than one slot of the limit', async () => {
        // Per-series collapse must happen BEFORE the LIMIT. It used to happen
        // only downstream in TS, after this query had already truncated — so a
        // show with many in-progress episodes took every slot and starved every
        // other show off the rail, collapsing a full result set to too few cards.
        const userId = generateTestUserId('cw_series_starvation');
        await ensureTestUser(sql, userId);

        // Explicit tmdbIds: the fixture otherwise draws one at random from a
        // fixed sample list, which collides on the external_ids unique key when
        // the same sample is drawn twice — across runs, or (as here) twice
        // within one test that builds two series.
        const noisy = await createAndInsertPlayableTestSeries(sql, {
            title: 'Noisy Series',
            tmdbId: 9_900_001,
            seasonCount: 1,
            episodesPerSeason: 5,
            episodeRuntimeSeconds: 45 * 60,
        });
        const quiet = await createAndInsertPlayableTestSeries(sql, {
            title: 'Quiet Series',
            tmdbId: 9_900_002,
            seasonCount: 1,
            episodesPerSeason: 1,
            episodeRuntimeSeconds: 45 * 60,
        });

        // Five in-progress episodes of one show, all more recent than the
        // single episode of the other show.
        for (const [i, ep] of noisy.seasons[0].episodes.entries()) {
            const mediaId = await resolveJfId(sql, ep.jellyfin_id);
            const at = new Date(Date.now() - (i + 1) * 60 * 60 * 1000).toISOString();
            await sql`
                INSERT INTO user_media_state (
                    user_id, media_id, is_watched, resume_position_ms,
                    runtime_ms, watch_count, last_event_at, last_event_source,
                    highest_session_elapsed_ms
                ) VALUES (
                    ${userId}, ${mediaId}::uuid, false, ${20 * 60 * 1000},
                    ${45 * 60 * 1000}, 0, ${at}::timestamptz, 'lumastra-player',
                    ${20 * 60 * 1000}
                )
            `;
        }
        const quietId = await resolveJfId(sql, quiet.seasons[0].episodes[0].jellyfin_id);
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms,
                runtime_ms, watch_count, last_event_at, last_event_source,
                highest_session_elapsed_ms
            ) VALUES (
                ${userId}, ${quietId}::uuid, false, ${20 * 60 * 1000},
                ${45 * 60 * 1000}, 0, ${new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString()}::timestamptz,
                'lumastra-player', ${20 * 60 * 1000}
            )
        `;

        // Limit of 2: pre-fix the noisy series took both slots.
        const rows = await getContinueWatchingFromDb.all(sql, {
            userId,
            limit: 2,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 365,
            collapsePerSeries: true,
        });

        const seriesIds = rows.map((r) => r.series_id);
        expect(new Set(seriesIds).size).toBe(seriesIds.length);
        expect(rows.map((r) => r.media_id)).toContain(quietId);
    });

    it('CW: collapsePerSeries=false returns every episode so an access filter can choose', async () => {
        // Callers that apply an access boundary (denied library group / age cap)
        // filter the RESULT per media_id. If the query had already collapsed the
        // series to one representative and that representative is the denied
        // one, the whole series would vanish from Continue Watching rather than
        // falling back to an accessible sibling. Uncollapsed mode keeps the
        // siblings available for that fallback.
        const userId = generateTestUserId('cw_uncollapsed_for_access');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Access Fallback Series',
            tmdbId: 9_900_003,
            seasonCount: 1,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });

        const ids: string[] = [];
        for (const [i, ep] of series.seasons[0].episodes.entries()) {
            const mediaId = await resolveJfId(sql, ep.jellyfin_id);
            ids.push(mediaId);
            const at = new Date(Date.now() - (i + 1) * 60 * 60 * 1000).toISOString();
            await sql`
                INSERT INTO user_media_state (
                    user_id, media_id, is_watched, resume_position_ms,
                    runtime_ms, watch_count, last_event_at, last_event_source,
                    highest_session_elapsed_ms
                ) VALUES (
                    ${userId}, ${mediaId}::uuid, false, ${20 * 60 * 1000},
                    ${45 * 60 * 1000}, 0, ${at}::timestamptz, 'lumastra-player',
                    ${20 * 60 * 1000}
                )
            `;
        }

        const collapsed = await getContinueWatchingFromDb.all(sql, {
            userId,
            ...CW_PARAMS,
            collapsePerSeries: true,
        });
        expect(collapsed).toHaveLength(1);

        const uncollapsed = await getContinueWatchingFromDb.all(sql, {
            userId,
            ...CW_PARAMS,
            collapsePerSeries: false,
        });
        expect(uncollapsed).toHaveLength(3);
        expect(new Set(uncollapsed.map((r) => r.media_id))).toEqual(new Set(ids));

        // The point of the fallback: drop the collapsed representative the way
        // an access filter would, and the series still has surviving rows.
        const denied = collapsed[0].media_id;
        expect(uncollapsed.filter((r) => r.media_id !== denied).length).toBeGreaterThan(0);
    });

    it('NextUpForSeries: skips an unavailable next episode even with a Jellyfin link', async () => {
        // /watch/[seriesId], /api/series/[id]/next-episode, and the
        // modal context route all consume getNextUpForSeriesFromDb. If
        // the next sequential candidate has no local file AND no
        // Jellyfin link (a phantom future-aired metadata stub or a
        // post-deletion orphan), it must be skipped — otherwise we
        // redirect users to an episode they cannot play.
        const userId = generateTestUserId('nu_per_series_playability');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Phantom Episode Series',
            seasonCount: 1,
            episodesPerSeason: 4,
            episodeRuntimeSeconds: 45 * 60,
        });

        const s1e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        const s1e2 = await resolveJfId(sql, series.seasons[0].episodes[1].jellyfin_id);
        const s1e3 = await resolveJfId(sql, series.seasons[0].episodes[2].jellyfin_id);

        // Mark S1E1 watched today via lumastra so recent_watched anchors
        // on it → next sequential = S1E2.
        await seedWatchedAt(sql, userId, s1e1, 'lumastra-player', new Date().toISOString());

        // Make S1E2 unavailable while retaining its Jellyfin id. Provider
        // identity alone must not make the candidate playable.
        await sql`UPDATE media_items SET has_files = false WHERE id = ${s1e2}::uuid`;

        const result = await getNextUpForSeriesFromDb.one(sql, {
            seriesMediaId: series.seriesId,
            userId,
        });

        // Must skip S1E2 (unplayable) and surface S1E3 instead.
        expect(result?.media_id).toBe(s1e3);
        expect(result?.has_files).toBe(true);
    });

    it('NextUpForSeries: mixed migration + recent lumastra anchors on the lumastra row', async () => {
        const userId = generateTestUserId('nu_per_series_mixed');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Mixed History Series',
            seasonCount: 3,
            episodesPerSeason: 4,
            episodeRuntimeSeconds: 45 * 60,
        });

        // S1E1..S2E2 imported via migration months ago.
        for (const ep of series.seasons[0].episodes) {
            const id = await resolveJfId(sql, ep.jellyfin_id);
            await seedWatchedAt(sql, userId, id, 'migration', '2025-09-01T10:00:00Z');
        }
        for (const ep of series.seasons[1].episodes.slice(0, 2)) {
            const id = await resolveJfId(sql, ep.jellyfin_id);
            await seedWatchedAt(sql, userId, id, 'migration', '2025-09-01T10:00:00Z');
        }

        // S2E3 watched in Lumastra today.
        const s2e3 = await resolveJfId(sql, series.seasons[1].episodes[2].jellyfin_id);
        await seedWatchedAt(sql, userId, s2e3, 'lumastra-player', new Date().toISOString());

        const result = await getNextUpForSeriesFromDb.one(sql, {
            seriesMediaId: series.seriesId,
            userId,
        });

        // Anchor follows the only non-migration row (S2E3) → next is S2E4.
        const s2e4 = await resolveJfId(sql, series.seasons[1].episodes[3].jellyfin_id);
        expect(result?.media_id).toBe(s2e4);
    });

    it('NextUp: includes backdrop_blurhash in NextUpRow projection', async () => {
        // Proves the SELECT projects backdrop_blurhash (value may be null).
        // Uses a minimal single-episode series so the query has something to return.
        const userId = generateTestUserId('nu_backdrop_blurhash');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Backdrop Blurhash Series',
            seasonCount: 1,
            episodesPerSeason: 2,
            episodeRuntimeSeconds: 30 * 60,
        });

        const e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        await seedWatchedEpisode(sql, userId, e1, 'lumastra-player');

        const rows = await getNextUpFromDb.all(sql, { userId, limit: 5, maxAgeDays: 0 });

        for (const r of rows) {
            expect('backdrop_blurhash' in r).toBe(true);
        }
    });

    it('NextUp: includes trailer_url in NextUpRow projection (column present)', async () => {
        // Proves the SELECT projects trailer_url (value may be null when the
        // series has no stored provider_metadata trailer).
        const userId = generateTestUserId('nu_trailer_col');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Trailer Column Series',
            seasonCount: 1,
            episodesPerSeason: 2,
            episodeRuntimeSeconds: 30 * 60,
        });

        const e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        await seedWatchedEpisode(sql, userId, e1, 'lumastra-player');

        const rows = await getNextUpFromDb.all(sql, { userId, limit: 5, maxAgeDays: 0 });

        for (const r of rows) {
            expect('trailer_url' in r).toBe(true);
        }
    });

    it('NextUp: resolves the SERIES trailer_url from provider_metadata', async () => {
        // Proves a real trailer value stored on the SERIES row's
        // provider_metadata flows through the lateral join into NextUpRow.
        const userId = generateTestUserId('nu_trailer_value');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Trailer Value Series',
            seasonCount: 1,
            episodesPerSeason: 2,
            episodeRuntimeSeconds: 30 * 60,
        });

        const trailerUrl = 'https://www.youtube.com/watch?v=nuSeriesTrailer';
        // Seed a tmdb provider_metadata row on the SERIES (not the episode) so
        // the override-aware lateral join keyed on series_mi.id picks it up.
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${series.seriesId}, 'tmdb', ${sql.json({ trailer_url: trailerUrl })})
            ON CONFLICT (media_id, provider) DO UPDATE SET metadata = EXCLUDED.metadata
        `;

        const e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        await seedWatchedEpisode(sql, userId, e1, 'lumastra-player');

        const rows = await getNextUpFromDb.all(sql, { userId, limit: 5, maxAgeDays: 0 });

        // The next-up row(s) for this series should carry the series trailer.
        const seriesRows = rows.filter((r) => r.series_id === series.seriesId);
        expect(seriesRows.length).toBeGreaterThan(0);
        for (const r of seriesRows) {
            expect(r.trailer_url).toBe(trailerUrl);
        }
    });

    it('NextUp: out-of-order watching anchors on the most recent completion', async () => {
        // User watched S1E5 first, then went back and watched S1E1.
        // Anchor should be S1E1 (most recent last_watched_at), so NextUp
        // surfaces S1E2 — not S1E6 (which would be the result of the old
        // MAX(order) logic after watching S1E5).
        const userId = generateTestUserId('nu_out_of_order');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Out Of Order Series',
            seasonCount: 1,
            episodesPerSeason: 6,
            episodeRuntimeSeconds: 45 * 60,
        });

        const s1e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        const s1e5 = await resolveJfId(sql, series.seasons[0].episodes[4].jellyfin_id);

        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await seedWatchedAt(sql, userId, s1e5, 'lumastra-player', oneHourAgo);
        await seedWatchedAt(sql, userId, s1e1, 'lumastra-player', tenMinutesAgo);

        const rows = await getNextUpFromDb.all(sql, {
            userId,
            limit: 20,
            maxAgeDays: 365,
        });

        const s1e2 = await resolveJfId(sql, series.seasons[0].episodes[1].jellyfin_id);
        const s1e6 = await resolveJfId(sql, series.seasons[0].episodes[5].jellyfin_id);
        expect(rows.map((r) => r.media_id)).toContain(s1e2);
        expect(rows.map((r) => r.media_id)).not.toContain(s1e6);
    });

    // ─────────────────────────────────────────────────────────────────
    // getContinueWatchingFromDb: stale-resume suppression when a later
    // episode has been completed in the meantime
    // ─────────────────────────────────────────────────────────────────

    async function seedPausedEpisode(
        sql: postgres.Sql,
        userId: string,
        mediaId: string,
        opts: {
            resumeMs?: number;
            runtimeMs?: number;
            lastEventDaysAgo?: number;
        } = {},
    ): Promise<void> {
        const resumeMs = opts.resumeMs ?? 15 * 60 * 1000;
        const runtimeMs = opts.runtimeMs ?? 45 * 60 * 1000;
        const days = opts.lastEventDaysAgo ?? 30;
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms,
                runtime_ms, watch_count, last_watched_at, first_watched_at,
                last_event_at, last_event_source, highest_session_elapsed_ms
            ) VALUES (
                ${userId},
                ${mediaId}::uuid,
                false,
                ${resumeMs},
                ${runtimeMs},
                0,
                null,
                null,
                NOW() - (${days} || ' days')::interval,
                'lumastra-player',
                ${resumeMs}
            )
        `;
    }

    it('CW: drops a stale paused episode once a later episode has been completed', async () => {
        const userId = generateTestUserId('cw_stale_drop');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Stale Resume Series',
            seasonCount: 5,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });

        const s3e2 = await resolveJfId(sql, series.seasons[2].episodes[1].jellyfin_id);
        const s5e1 = await resolveJfId(sql, series.seasons[4].episodes[0].jellyfin_id);

        // S3E2 paused 90 days ago.
        await seedPausedEpisode(sql, userId, s3e2, { lastEventDaysAgo: 90 });
        // S5E1 watched 7 days ago — strictly after the S3E2 pause.
        await seedWatchedEpisode(sql, userId, s5e1, 'lumastra-player', {
            lastWatchedDaysAgo: 7,
        });

        const rows = await getContinueWatchingFromDb.all(sql, {
            userId,
            limit: 20,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 365,
            collapsePerSeries: true,
        });

        expect(rows.map((r) => r.media_id)).not.toContain(s3e2);
    });

    it('CW: keeps a paused episode that was started AFTER a later completion (re-watch)', async () => {
        const userId = generateTestUserId('cw_rewatch_after_complete');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Rewatch Series',
            seasonCount: 5,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });

        const s2e1 = await resolveJfId(sql, series.seasons[1].episodes[0].jellyfin_id);
        const s5e1 = await resolveJfId(sql, series.seasons[4].episodes[0].jellyfin_id);

        // S5E1 watched 30 days ago.
        await seedWatchedEpisode(sql, userId, s5e1, 'lumastra-player', {
            lastWatchedDaysAgo: 30,
        });
        // User went back to S2E1 yesterday — fresh re-watch attempt.
        await seedPausedEpisode(sql, userId, s2e1, { lastEventDaysAgo: 1 });

        const rows = await getContinueWatchingFromDb.all(sql, {
            userId,
            limit: 20,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 365,
            collapsePerSeries: true,
        });

        expect(rows.map((r) => r.media_id)).toContain(s2e1);
    });

    it('CW: keeps a paused special when a later main-line episode is watched', async () => {
        const userId = generateTestUserId('cw_special_paused');
        await ensureTestUser(sql, userId);

        // Build a series whose first season is "Specials" (season 0). The
        // fixture helper numbers seasons starting at 1, so we patch S1 to
        // season_number = 0 manually. The fixture exposes `seasonNumber`
        // and `jellyfinId` but not the internal UUID, so resolve it via a
        // SELECT before the UPDATE.
        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Series With Specials',
            seasonCount: 2,
            episodesPerSeason: 2,
            episodeRuntimeSeconds: 30 * 60,
        });
        const [specialsSeasonRow] = await sql<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE parent_id = ${series.seriesId}::uuid
              AND media_type = 'season'
              AND season_number = 1
            LIMIT 1
        `;
        const specialsSeasonId = specialsSeasonRow.id;
        await sql`
            UPDATE media_items SET season_number = 0
            WHERE id = ${specialsSeasonId}::uuid
        `;
        await sql`
            UPDATE media_items SET season_number = 0
            WHERE parent_id = ${specialsSeasonId}::uuid
              AND media_type = 'episode'
        `;

        const specialEp = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        const s2e1 = await resolveJfId(sql, series.seasons[1].episodes[0].jellyfin_id);

        // Special paused 60 days ago.
        await seedPausedEpisode(sql, userId, specialEp, {
            lastEventDaysAgo: 60,
        });
        // Main-line S2E1 watched 5 days ago.
        await seedWatchedEpisode(sql, userId, s2e1, 'lumastra-player', {
            lastWatchedDaysAgo: 5,
        });

        const rows = await getContinueWatchingFromDb.all(sql, {
            userId,
            limit: 20,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 365,
            collapsePerSeries: true,
        });

        // Specials live outside the season>0 ordering, so a main-line
        // completion must NOT swallow the special's resume.
        expect(rows.map((r) => r.media_id)).toContain(specialEp);
    });

    it('CW: honors active custom episode ordering when comparing "later"', async () => {
        // Series with two seasons of two episodes each (storage order):
        //   S1E1, S1E2, S2E1, S2E2
        //
        // Custom ordering interleaves them so storage S2E1 is order 2 and
        // storage S1E2 is order 3:
        //   order(1,1) = S1E1, order(1,2) = S2E1,
        //   order(1,3) = S1E2, order(1,4) = S2E2
        //
        // Scenario: user pauses S2E1 (custom-order 2), then completes S1E2
        // (custom-order 3). Storage compare: S1E2 < S2E1 → would *not*
        // suppress. Custom-ordering compare: S1E2 > S2E1 → must suppress.
        const userId = generateTestUserId('cw_custom_order');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Custom Order Series',
            seasonCount: 2,
            episodesPerSeason: 2,
            episodeRuntimeSeconds: 30 * 60,
        });

        const s1e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        const s1e2 = await resolveJfId(sql, series.seasons[0].episodes[1].jellyfin_id);
        const s2e1 = await resolveJfId(sql, series.seasons[1].episodes[0].jellyfin_id);
        const s2e2 = await resolveJfId(sql, series.seasons[1].episodes[1].jellyfin_id);

        // Activate a non-standard ordering on the series. ordering_type
        // 'absolute' is one of the CHECK-allowed values; group/provider
        // are arbitrary identifiers for this synthetic test.
        const orderingType = 'absolute';
        const orderingGroup = 'test-custom-order';
        await sql`
            INSERT INTO series_episode_ordering
                (media_id, ordering_type, ordering_source, ordering_provider, ordering_group_id)
            VALUES (
                ${series.seriesId}::uuid,
                ${orderingType},
                'manual',
                'test',
                ${orderingGroup}
            )
        `;
        const customOrder: Array<{ id: string; o: number }> = [
            { id: s1e1, o: 1 },
            { id: s2e1, o: 2 },
            { id: s1e2, o: 3 },
            { id: s2e2, o: 4 },
        ];
        for (const e of customOrder) {
            await sql`
                INSERT INTO episode_orderings
                    (series_media_id, episode_media_id, provider,
                     provider_episode_id, ordering_type, ordering_group_id,
                     original_season_number, original_episode_number,
                     order_season_number, order_episode_number)
                VALUES (
                    ${series.seriesId}::uuid,
                    ${e.id}::uuid,
                    'test',
                    ${`ep-${e.o}`},
                    ${orderingType},
                    ${orderingGroup},
                    1, 1,
                    1, ${e.o}
                )
            `;
        }

        // Pause S2E1 (custom order 2) 30 days ago.
        await seedPausedEpisode(sql, userId, s2e1, { lastEventDaysAgo: 30 });
        // Complete S1E2 (custom order 3) 5 days ago — strictly after the pause.
        await seedWatchedEpisode(sql, userId, s1e2, 'lumastra-player', {
            lastWatchedDaysAgo: 5,
        });

        const rows = await getContinueWatchingFromDb.all(sql, {
            userId,
            limit: 20,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 365,
            collapsePerSeries: true,
        });

        // Custom-ordering aware suppression must drop S2E1 even though
        // its storage (season 2) is "after" S1E2's storage (season 1).
        expect(rows.map((r) => r.media_id)).not.toContain(s2e1);
    });

    it('CW: keeps a paused special even when a custom ordering is active for the series', async () => {
        // Specials are excluded from suppression via the `> 0` guard on the
        // *effective* season number (COALESCE(eo*.order_season_number,
        // *.season_number) > 0). When the special is unmapped in the
        // active ordering, COALESCE falls through to the stored
        // season_number = 0 — same outcome as the no-ordering case. This
        // test locks down that combination so a future change to the
        // suppression SQL can't silently regress specials behaviour for
        // re-ordered series.
        const userId = generateTestUserId('cw_special_custom_order');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Specials + Custom Order',
            seasonCount: 2,
            episodesPerSeason: 2,
            episodeRuntimeSeconds: 30 * 60,
        });

        // Patch the first season + its episodes to season_number = 0
        // (specials), same recipe as the no-ordering specials test.
        const [specialsSeasonRow] = await sql<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE parent_id = ${series.seriesId}::uuid
              AND media_type = 'season'
              AND season_number = 1
            LIMIT 1
        `;
        const specialsSeasonId = specialsSeasonRow.id;
        await sql`
            UPDATE media_items SET season_number = 0
            WHERE id = ${specialsSeasonId}::uuid
        `;
        await sql`
            UPDATE media_items SET season_number = 0
            WHERE parent_id = ${specialsSeasonId}::uuid
              AND media_type = 'episode'
        `;

        const specialEp = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        const s2e1 = await resolveJfId(sql, series.seasons[1].episodes[0].jellyfin_id);
        const s2e2 = await resolveJfId(sql, series.seasons[1].episodes[1].jellyfin_id);

        // Activate a non-standard ordering that maps only the main-line
        // episodes (specials intentionally left unmapped — the common
        // shape for absolute / DVD orderings of mixed shows).
        const orderingType = 'absolute';
        const orderingGroup = 'specials-coexist';
        await sql`
            INSERT INTO series_episode_ordering
                (media_id, ordering_type, ordering_source, ordering_provider, ordering_group_id)
            VALUES (
                ${series.seriesId}::uuid,
                ${orderingType},
                'manual',
                'test',
                ${orderingGroup}
            )
        `;
        for (const [epId, order] of [
            [s2e1, 1],
            [s2e2, 2],
        ] as const) {
            await sql`
                INSERT INTO episode_orderings
                    (series_media_id, episode_media_id, provider,
                     provider_episode_id, ordering_type, ordering_group_id,
                     original_season_number, original_episode_number,
                     order_season_number, order_episode_number)
                VALUES (
                    ${series.seriesId}::uuid,
                    ${epId}::uuid,
                    'test',
                    ${`ep-${order}`},
                    ${orderingType},
                    ${orderingGroup},
                    2, ${order},
                    1, ${order}
                )
            `;
        }

        // Special paused 60 days ago.
        await seedPausedEpisode(sql, userId, specialEp, {
            lastEventDaysAgo: 60,
        });
        // Main-line S2E1 watched 5 days ago — strictly after the pause.
        await seedWatchedEpisode(sql, userId, s2e1, 'lumastra-player', {
            lastWatchedDaysAgo: 5,
        });

        const rows = await getContinueWatchingFromDb.all(sql, {
            userId,
            limit: 20,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 365,
            collapsePerSeries: true,
        });

        // Special's effective season_number stays 0 (eo_l null →
        // COALESCE → stored 0) so the `> 0` guard inside NOT EXISTS
        // fails — the special's resume must remain in CW.
        expect(rows.map((r) => r.media_id)).toContain(specialEp);
    });

    it('CW/NextUp: a backdated upstream played mark wins over earlier local progress', async () => {
        const userId = generateTestUserId('cw_backdated_played');
        await ensureTestUser(sql, userId);
        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Backdated Played',
            seasonCount: 1,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });
        const e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
        const e2 = await resolveJfId(sql, series.seasons[0].episodes[1].jellyfin_id);
        const e3 = await resolveJfId(sql, series.seasons[0].episodes[2].jellyfin_id);
        // Jellyfin can change Played without advancing LastPlayedDate. Its
        // observed completion is newer, even though occurred_at sorts before
        // the local partial. The rebuilder legitimately retains that position.
        await sql`
            INSERT INTO user_media_events (user_id, media_id, source, event_type,
                occurred_at, recorded_at, position_ms, runtime_ms)
            VALUES (${userId}, ${e2}::uuid, 'lumastra-player', 'progress',
                NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '2 minutes', 476056, 2700000),
                (${userId}, ${e2}::uuid, 'jellyfin-sync', 'mark_watched',
                NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 minute', NULL, 2700000),
                (${userId}, ${e1}::uuid, 'lumastra-player', 'completed',
                NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes', NULL, 2700000)
        `;
        await rebuildStateFromEvents(sql, { userId, mediaId: e1 });
        const state = await rebuildStateFromEvents(sql, { userId, mediaId: e2 });
        expect(state?.is_watched).toBe(true);
        expect(state?.resume_position_ms).toBe(476056);
        expect(state?.last_event_source).toBe('lumastra-player');
        const options = {
            userId,
            limit: 20,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 365,
            collapsePerSeries: true,
        };
        expect(
            (await getContinueWatchingFromDb.all(sql, options)).map((r) => r.media_id),
        ).not.toContain(e2);
        expect((await getNextUpFromDb.all(sql, options)).map((r) => r.media_id)).toContain(e3);
        expect(
            (await getNextUpForSeriesFromDb.one(sql, { userId, seriesMediaId: series.seriesId }))
                ?.media_id,
        ).toBe(e3);
        // Playback started after receiving the mark IS a rewatch.
        await sql`
            INSERT INTO user_media_events (user_id, media_id, source, event_type,
                occurred_at, position_ms, runtime_ms)
            VALUES (${userId}, ${e2}::uuid, 'lumastra-player', 'progress',
                NOW() - INTERVAL '30 seconds', 500000, 2700000)
        `;
        await rebuildStateFromEvents(sql, { userId, mediaId: e2 });
        expect(
            (await getContinueWatchingFromDb.all(sql, options)).map((r) => r.media_id),
        ).toContain(e2);
        // Completing E1 again after the imported E2 completion is a genuine
        // rewatch anchor; NextUp may now offer the previously watched E2.
        await sql`
            INSERT INTO user_media_events (user_id, media_id, source, event_type, occurred_at, runtime_ms)
            VALUES (${userId}, ${e1}::uuid, 'lumastra-player', 'completed', NOW() - INTERVAL '10 seconds', 2700000)
        `;
        await rebuildStateFromEvents(sql, { userId, mediaId: e1 });
        expect((await getNextUpFromDb.all(sql, options)).map((r) => r.media_id)).toContain(e2);
        expect(
            (await getNextUpForSeriesFromDb.one(sql, { userId, seriesMediaId: series.seriesId }))
                ?.media_id,
        ).toBe(e2);
    });

    it('CW/NextUp: upstream watched beats a stale partial position', async () => {
        const userId = generateTestUserId('cw_upstream_watched');
        await ensureTestUser(sql, userId);
        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Upstream Watched',
            seasonCount: 1,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });
        const e2 = await resolveJfId(sql, series.seasons[0].episodes[1].jellyfin_id);
        const e3 = await resolveJfId(sql, series.seasons[0].episodes[2].jellyfin_id);
        // A later upstream mark advances last_event_at, but the old partial
        // position is still stored. A timestamp alone does not prove a rewatch.
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms,
                runtime_ms, watch_count, last_watched_at, first_watched_at, last_event_at,
                last_event_source, highest_session_elapsed_ms)
            VALUES (${userId}, ${e2}::uuid, true, 476056, 2700000, 1,
                NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', NOW() - INTERVAL '2 minutes', 'jellyfin-sync', 476056)
        `;
        const options = {
            userId,
            limit: 20,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 365,
            collapsePerSeries: true,
        };
        expect(
            (await getContinueWatchingFromDb.all(sql, options)).map((r) => r.media_id),
        ).not.toContain(e2);
        expect((await getNextUpFromDb.all(sql, options)).map((r) => r.media_id)).toContain(e3);
        // A sync can report a mark and a stale partial at the same instant.
        // That pair is not proof of playback after the watched verdict.
        await sql`
            INSERT INTO user_media_events (user_id, media_id, source, event_type, occurred_at, position_ms)
            SELECT user_id, media_id, last_event_source, 'mark_unwatched', last_event_at, NULL
            FROM user_media_state WHERE user_id = ${userId} AND media_id = ${e2}::uuid
        `;
        await sql`
            INSERT INTO user_media_events (user_id, media_id, source, event_type, occurred_at, position_ms)
            SELECT user_id, media_id, last_event_source, 'progress', last_event_at, resume_position_ms
            FROM user_media_state WHERE user_id = ${userId} AND media_id = ${e2}::uuid
        `;
        expect(
            (await getContinueWatchingFromDb.all(sql, options)).map((r) => r.media_id),
        ).not.toContain(e2);
        // Genuine later upstream playback is still a valid rewatch.
        await sql`UPDATE user_media_state SET last_event_at = last_event_at + INTERVAL '1 minute'
                  WHERE user_id = ${userId} AND media_id = ${e2}::uuid`;
        await sql`
            INSERT INTO user_media_events (user_id, media_id, source, event_type, occurred_at, position_ms)
            SELECT user_id, media_id, last_event_source, 'progress', last_event_at, resume_position_ms
            FROM user_media_state WHERE user_id = ${userId} AND media_id = ${e2}::uuid
        `;
        expect(
            (await getContinueWatchingFromDb.all(sql, options)).map((r) => r.media_id),
        ).toContain(e2);
    });

    it('CW: surfaces a re-watch (is_watched=true, resume>0, fresh progress)', async () => {
        // User finished S3E14 long ago, then started re-watching today.
        // last_event_at advances past the prior completion's
        // last_watched_at, so the row should appear in CW even though
        // is_watched=true.
        const userId = generateTestUserId('cw_rewatch_surface');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Re-watch Series',
            seasonCount: 3,
            episodesPerSeason: 4,
            episodeRuntimeSeconds: 45 * 60,
        });
        const s2e3 = await resolveJfId(sql, series.seasons[1].episodes[2].jellyfin_id);

        // Watched 6 months ago, then re-watching 1 hour ago (progress
        // heartbeats wrote a new last_event_at, last_watched_at stayed
        // back at the prior completion).
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms,
                runtime_ms, watch_count, last_watched_at, first_watched_at,
                last_event_at, last_event_source, highest_session_elapsed_ms
            ) VALUES (
                ${userId},
                ${s2e3}::uuid,
                true,
                ${15 * 60 * 1000},
                ${45 * 60 * 1000},
                1,
                NOW() - INTERVAL '180 days',
                NOW() - INTERVAL '180 days',
                NOW() - INTERVAL '1 hour',
                'lumastra-player',
                ${15 * 60 * 1000}
            )
        `;

        const rows = await getContinueWatchingFromDb.all(sql, {
            userId,
            limit: 20,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 365,
            collapsePerSeries: true,
        });

        expect(rows.map((r) => r.media_id)).toContain(s2e3);
    });

    it('CW: hides a row that was just bulk-marked watched even with leftover resume', async () => {
        // Modal "mark series watched" / per-episode mark in the player
        // browser writes the positive event AND the resume in the same
        // transaction (resume gets zeroed by the rebuilder when the
        // mark's source matches is_watched_source). But to be defensive
        // against any path that leaves a non-zero resume on a freshly-
        // marked row, the filter must still hide it: last_event_at and
        // last_watched_at fire together, so the strict-greater check
        // fails.
        const userId = generateTestUserId('cw_bulk_mark_no_resurface');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Bulk Mark Series',
            seasonCount: 1,
            episodesPerSeason: 3,
            episodeRuntimeSeconds: 45 * 60,
        });
        const e1 = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);

        // Synthetic state: bulk-mark wrote the row with both timestamps
        // identical AND a leftover (theoretical) resume_position_ms > 0.
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms,
                runtime_ms, watch_count, last_watched_at, first_watched_at,
                last_event_at, last_event_source, highest_session_elapsed_ms
            ) VALUES (
                ${userId},
                ${e1}::uuid,
                true,
                ${10 * 60 * 1000},
                ${45 * 60 * 1000},
                1,
                NOW() - INTERVAL '5 minutes',
                NOW() - INTERVAL '5 minutes',
                NOW() - INTERVAL '5 minutes',
                'lumastra-user-mark',
                ${10 * 60 * 1000}
            )
        `;

        const rows = await getContinueWatchingFromDb.all(sql, {
            userId,
            limit: 20,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 365,
            collapsePerSeries: true,
        });

        expect(rows.map((r) => r.media_id)).not.toContain(e1);
    });

    it('CW: never suppresses a paused movie based on an unrelated series watch', async () => {
        const userId = generateTestUserId('cw_movie_immune');
        await ensureTestUser(sql, userId);

        const series = await createAndInsertPlayableTestSeries(sql, {
            title: 'Some Series',
            seasonCount: 2,
            episodesPerSeason: 2,
            episodeRuntimeSeconds: 30 * 60,
        });
        const s2e2 = await resolveJfId(sql, series.seasons[1].episodes[1].jellyfin_id);

        // Insert a stand-alone movie row directly. has_files = true so it
        // passes getContinueWatchingFromDb's playability gate (a local file
        // OR a Jellyfin external_id); without it the movie is correctly
        // filtered out as unplayable.
        const [movie] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, runtime_seconds, has_files)
            VALUES ('Some Movie', 'movie', 7200, true)
            RETURNING id
        `;

        await seedPausedEpisode(sql, userId, movie.id, {
            lastEventDaysAgo: 60,
            resumeMs: 30 * 60 * 1000,
            runtimeMs: 120 * 60 * 1000,
        });
        await seedWatchedEpisode(sql, userId, s2e2, 'lumastra-player', {
            lastWatchedDaysAgo: 1,
        });

        const rows = await getContinueWatchingFromDb.all(sql, {
            userId,
            limit: 20,
            minMs: 30_000,
            minPercent: 10,
            maxAgeDays: 365,
            collapsePerSeries: true,
        });

        // Movie has no series parent — the join can't link them; the
        // movie's resume must remain visible.
        expect(rows.map((r) => r.media_id)).toContain(movie.id);
    });

    // ─────────────────────────────────────────────────────────────────
    // computeAllSeriesProgress — E2 keyset pagination (Gate B1 / C / D2b)
    // ─────────────────────────────────────────────────────────────────
    describe('keyset pagination (last_watched)', () => {
        /**
         * Seed a series the user has STARTED but not watched any episode of:
         * an is_watched=false user_media_state row on E1. This satisfies the
         * EXISTS engagement guard (a uws row exists for an episode under the
         * series) while keeping watched_episodes=0 → completion_status
         * 'not_started' → last_watched_at NULL. This is exactly the D2b NULL
         * group the cursor must CARRY, not hide.
         */
        async function seedStartedNotWatched(
            seedSql: postgres.Sql,
            userId: string,
            mediaId: string,
            atIso: string,
        ): Promise<void> {
            await seedSql`
                INSERT INTO user_media_state (
                    user_id, media_id, is_watched, resume_position_ms,
                    runtime_ms, watch_count, last_watched_at, first_watched_at,
                    last_event_at, last_event_source, highest_session_elapsed_ms
                ) VALUES (
                    ${userId}, ${mediaId}::uuid, false, 60000,
                    ${45 * 60 * 1000}, 0, null, null,
                    ${atIso}::timestamptz, 'lumastra-player', 120000
                )
            `;
        }

        // Unique tmdbId per seeded series — createAndInsertTestSeries otherwise
        // derives tmdb/imdb ids from a RANDOM sample show, so two series can
        // collide on external_ids. Monotonic counter keeps them distinct.
        let seriesTmdbSeq = 900_000;

        /** Seed a fresh single-episode series and return its series_media_id. */
        async function seedSeries(
            userId: string,
            title: string,
        ): Promise<{ seriesId: string; episodeId: string }> {
            const series = await createAndInsertPlayableTestSeries(sql, {
                title,
                tmdbId: ++seriesTmdbSeq,
                seasonCount: 1,
                episodesPerSeason: 2,
                episodeRuntimeSeconds: 45 * 60,
            });
            const episodeId = await resolveJfId(sql, series.seasons[0].episodes[0].jellyfin_id);
            const [{ id: seriesId }] = await sql<{ id: string }[]>`
                SELECT id FROM media_items WHERE title = ${title} AND media_type IN ('tv','series') LIMIT 1
            `;
            return { seriesId, episodeId };
        }

        /**
         * Seed a watched episode at a MICROSECOND-precise instant. A plain string
         * bound with `::timestamptz` is truncated by postgres.js (the exact defect
         * this effort fixes); pinning the bind OID to TEXT (25) makes Postgres
         * parse the raw string server-side, losslessly — same technique as
         * pgTextTimestamp / the cursor bind.
         */
        async function seedWatchedAtMicro(
            userId: string,
            mediaId: string,
            atText: string,
        ): Promise<void> {
            await sql`
                INSERT INTO user_media_state (
                    user_id, media_id, is_watched, resume_position_ms,
                    runtime_ms, watch_count, last_watched_at, first_watched_at,
                    last_event_at, last_event_source, highest_session_elapsed_ms
                ) VALUES (
                    ${userId}, ${mediaId}::uuid, true, 0,
                    ${45 * 60 * 1000}, 1,
                    ${sql.typed(atText, 25)}::timestamptz, ${sql.typed(atText, 25)}::timestamptz,
                    ${sql.typed(atText, 25)}::timestamptz, 'lumastra-player', null
                )
            `;
        }

        /**
         * Page the whole feed PURELY via keyset from an explicit start cursor
         * (no offset bootstrap), so tie/NULL groups page in the cursor's own
         * deterministic id-DESC order rather than offset's tiebreak-less order.
         */
        async function collectFromCursor(
            userId: UserId,
            initial: { lastWatchedAt: string | null; seriesMediaId: string },
            pageSize: number,
        ): Promise<string[]> {
            const ids: string[] = [];
            let cursor = initial;
            for (;;) {
                const rows = await computeAllSeriesProgress(sql, userId, {
                    sort: 'last_watched',
                    limit: pageSize,
                    page: { mode: 'cursor', cursor },
                });
                const pageRows = rows.slice(0, pageSize);
                if (pageRows.length === 0) break;
                for (const r of pageRows) ids.push(r.series_media_id);
                if (rows.length <= pageSize) break; // no lookahead extra → done
                const last = pageRows[pageRows.length - 1];
                cursor = {
                    lastWatchedAt: last.last_watched_at_cursor ?? null,
                    seriesMediaId: last.series_media_id,
                };
            }
            return ids;
        }

        // A start cursor positioned strictly above every seeded row (far-future
        // timestamp) so a pure-cursor sweep returns the whole set in cursor order.
        const TOP_CURSOR = {
            lastWatchedAt: '2099-01-01T00:00:00.000000Z',
            seriesMediaId: '00000000-0000-0000-0000-000000000000',
        };

        /**
         * Page the whole feed via keyset, bootstrapping (Gate J1 style) from an
         * offset:0 page then following the cursor. Returns the collected
         * series_media_id order. Mirrors the def's hasMore/slice logic. Only valid
         * when the offset page order is itself deterministic (distinct sort keys).
         */
        async function collectViaCursor(userId: UserId, pageSize: number): Promise<string[]> {
            const ids: string[] = [];
            let rows = await computeAllSeriesProgress(sql, userId, {
                sort: 'last_watched',
                limit: pageSize,
                page: { mode: 'offset', offset: 0 },
            });
            while (rows.length > 0) {
                const pageRows = rows.slice(0, pageSize);
                for (const r of pageRows) ids.push(r.series_media_id);
                const last = pageRows[pageRows.length - 1];
                const next = await computeAllSeriesProgress(sql, userId, {
                    sort: 'last_watched',
                    limit: pageSize,
                    page: {
                        mode: 'cursor',
                        cursor: {
                            lastWatchedAt: last.last_watched_at_cursor ?? null,
                            seriesMediaId: last.series_media_id,
                        },
                    },
                });
                if (next.length === 0) break;
                rows = next;
            }
            return ids;
        }

        it('cursor paging matches the full offset order over a static distinct-timestamp set (no dup/skip)', async () => {
            const userId = generateTestUserId('ks_parity');
            await ensureTestUser(sql, userId);

            // 5 series, strictly descending last_watched_at (distinct → no ties).
            for (let i = 0; i < 5; i++) {
                const { episodeId } = await seedSeries(userId, `Parity ${i}`);
                await seedWatchedAt(
                    sql,
                    userId,
                    episodeId,
                    'lumastra-player',
                    `2026-07-2${i}T00:00:00.000000Z`,
                );
            }

            const full = await computeAllSeriesProgress(sql, userId, {
                sort: 'last_watched',
                limit: 100,
                page: { mode: 'offset', offset: 0 },
            });
            const fullOrder = full.map((r) => r.series_media_id);

            const paged = await collectViaCursor(userId, 2);

            expect(paged).toHaveLength(5);
            expect(paged).toEqual(fullOrder);
            expect(new Set(paged).size).toBe(5); // no duplicates
        });

        it('microsecond boundary: a row 1µs earlier than the cursor is NOT skipped', async () => {
            const userId = generateTestUserId('ks_micro');
            await ensureTestUser(sql, userId);

            const a = await seedSeries(userId, 'Micro A');
            const b = await seedSeries(userId, 'Micro B');
            // A is 1µs newer than B, same millisecond. Text-pinned seed so the µs
            // survives (a plain string bind truncates — the defect under test).
            await seedWatchedAtMicro(userId, a.episodeId, '2026-07-20T12:00:00.000001Z');
            await seedWatchedAtMicro(userId, b.episodeId, '2026-07-20T12:00:00.000000Z');

            const full = await computeAllSeriesProgress(sql, userId, {
                sort: 'last_watched',
                limit: 100,
                page: { mode: 'offset', offset: 0 },
            });
            const rowA = full.find((r) => r.series_name === 'Micro A')!;
            expect(rowA.last_watched_at_cursor).toBeDefined();

            // Cursor positioned exactly at A → the next page must include B (the
            // 1µs-earlier row). A ms-truncated cursor would collapse A and B to
            // the same instant and could drop B.
            const next = await computeAllSeriesProgress(sql, userId, {
                sort: 'last_watched',
                limit: 100,
                page: {
                    mode: 'cursor',
                    cursor: {
                        lastWatchedAt: rowA.last_watched_at_cursor ?? null,
                        seriesMediaId: rowA.series_media_id,
                    },
                },
            });
            expect(next.map((r) => r.series_name)).toContain('Micro B');
        });

        it('tiebreak determinism: identical last_watched_at pages cleanly (id tiebreak, no repeat/skip)', async () => {
            const userId = generateTestUserId('ks_ties');
            await ensureTestUser(sql, userId);

            const ids: string[] = [];
            for (let i = 0; i < 4; i++) {
                const { seriesId, episodeId } = await seedSeries(userId, `Tie ${i}`);
                ids.push(seriesId);
                await seedWatchedAt(
                    sql,
                    userId,
                    episodeId,
                    'lumastra-player',
                    '2026-07-20T00:00:00.000000Z', // all identical
                );
            }

            // Pure-cursor sweep: the tiebreak (series_media_id DESC) is
            // cursor-branch-only, so page entirely in cursor mode rather than
            // bootstrapping from the tiebreak-less offset page.
            const paged = await collectFromCursor(userId, TOP_CURSOR, 2);
            expect(paged).toHaveLength(4);
            expect(new Set(paged)).toEqual(new Set(ids)); // every series once, none skipped
        });

        it('D2b: carries the NULL last_watched_at group (started-but-unwatched), never excludes it', async () => {
            const userId = generateTestUserId('ks_nullcarry');
            await ensureTestUser(sql, userId);

            const nonNull: string[] = [];
            for (let i = 0; i < 2; i++) {
                const { seriesId, episodeId } = await seedSeries(userId, `Watched ${i}`);
                nonNull.push(seriesId);
                await seedWatchedAt(
                    sql,
                    userId,
                    episodeId,
                    'lumastra-player',
                    `2026-07-2${i}T00:00:00.000000Z`,
                );
            }
            const nullGroup: string[] = [];
            for (let i = 0; i < 2; i++) {
                const { seriesId, episodeId } = await seedSeries(userId, `Started ${i}`);
                nullGroup.push(seriesId);
                await seedStartedNotWatched(sql, userId, episodeId, '2026-07-20T00:00:00Z');
            }

            const paged = await collectViaCursor(userId, 2);

            // All four appear exactly once — the NULL group is CARRIED, not hidden.
            expect(new Set(paged)).toEqual(new Set([...nonNull, ...nullGroup]));
            expect(paged).toHaveLength(4);

            // Non-NULL rows precede the NULL group (NULLS LAST), transition once.
            const firstNullIdx = paged.findIndex((id) => nullGroup.includes(id));
            expect(firstNullIdx).toBeGreaterThan(-1);
            expect(paged.slice(0, firstNullIdx).every((id) => nonNull.includes(id))).toBe(true);
            expect(paged.slice(firstNullIdx).every((id) => nullGroup.includes(id))).toBe(true);
        });

        it('D2b: a cursor inside the NULL group pages the remaining NULL rows only', async () => {
            const userId = generateTestUserId('ks_nullcursor');
            await ensureTestUser(sql, userId);

            const nullGroup: string[] = [];
            for (let i = 0; i < 3; i++) {
                const { seriesId, episodeId } = await seedSeries(userId, `OnlyStarted ${i}`);
                nullGroup.push(seriesId);
                await seedStartedNotWatched(sql, userId, episodeId, '2026-07-20T00:00:00Z');
            }

            // Deterministic cursor order: a value cursor above everything sweeps
            // the whole NULL group (via the `OR last_watched_at IS NULL` arm),
            // ordered by series_media_id DESC — offset mode has no NULL-group
            // tiebreak, so we cannot use it to pick "the first" row.
            const ordered = await computeAllSeriesProgress(sql, userId, {
                sort: 'last_watched',
                limit: 100,
                page: { mode: 'cursor', cursor: TOP_CURSOR },
            });
            expect(ordered).toHaveLength(3);
            expect(ordered.every((r) => r.last_watched_at === null)).toBe(true);
            const first = ordered[0];

            // Cursor built from a NULL-group row (lastWatchedAt: null).
            const next = await computeAllSeriesProgress(sql, userId, {
                sort: 'last_watched',
                limit: 100,
                page: {
                    mode: 'cursor',
                    cursor: {
                        lastWatchedAt: first.last_watched_at_cursor ?? null,
                        seriesMediaId: first.series_media_id,
                    },
                },
            });
            // Exactly the two NULL rows after the first, no dup of the first.
            expect(next.every((r) => r.last_watched_at === null)).toBe(true);
            expect(next.map((r) => r.series_media_id)).not.toContain(first.series_media_id);
            expect(next).toHaveLength(2);
        });
    });

    // =========================================================================
    // getWatchedSeriesFromDb — library axis on the SERIES row (a container)
    //
    // The row this query returns IS the `tv` row, so the correct rule is the
    // container-aware one `buildLibraryAccessFilter` implements: judge a series
    // by its descendants' files (plus its own `library_group_id`). The predicate
    // used to be hand-inlined as `NOT EXISTS (files owned by series_mi.id) OR
    // ...` — but `tv` containers do not own `media_file_items`, so the first
    // arm was always TRUE and the library axis did
    // nothing. Files therefore go on the EPISODE, where a real scan puts them.
    // =========================================================================
    describe('getWatchedSeriesFromDb access boundary', () => {
        let tmdbSeq = 990_100;
        async function seedWatchedSeries(
            userId: string,
            title: string,
            libraryGroupId: string | null,
        ): Promise<string> {
            const series = await createAndInsertPlayableTestSeries(sql, {
                title,
                // SAMPLE_TV_SHOWS is picked at random and its tmdb_id is the
                // default, so two series seeded in one test collide on
                // external_ids_provider_external_id_media_type_key.
                tmdbId: tmdbSeq++,
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const episodeJellyfinId = series.seasons[0].episodes[0].jellyfin_id;
            await insertTestEpisodeWatchStatus(sql, userId, episodeJellyfinId, {
                isWatched: true,
            });
            if (libraryGroupId) {
                const [{ id: episodeId }] = await sql<{ id: string }[]>`
                    SELECT media_id::text AS id FROM external_ids
                    WHERE provider = 'jellyfin'
                      AND external_id = ${episodeJellyfinId}
                      AND media_type = 'episode'
                    LIMIT 1
                `;
                await placeInLibraryGroup(sql, {
                    mediaItemId: episodeId,
                    mediaType: 'episode',
                    libraryGroupId,
                });
            }
            return series.seriesId;
        }

        it('drops a series whose episodes all live in a denied group', async () => {
            const userId = generateTestUserId('gwsfd_lib');
            await ensureTestUser(sql, userId);
            const groupA = crypto.randomUUID();
            const groupB = crypto.randomUUID();
            await sql`
                INSERT INTO library_groups (id, name)
                VALUES (${groupA}::uuid, 'GWSFD A'), (${groupB}::uuid, 'GWSFD B')
            `;

            const deniedSeriesId = await seedWatchedSeries(userId, 'Halcyon Ledger', groupA);
            const allowedSeriesId = await seedWatchedSeries(userId, 'Verdigris Almanac', groupB);

            // POSITIVE CONTROL — both series are reachable with no restriction.
            const open = await getWatchedSeriesFromDb.all(sql, {
                userId: userId as UserId,
                deniedGroupIds: null,
                ageRating: null,
            });
            const openIds = open.map((r) => r.parent_id);
            expect(openIds).toContain(deniedSeriesId);
            expect(openIds).toContain(allowedSeriesId);

            const narrowed = await getWatchedSeriesFromDb.all(sql, {
                userId: userId as UserId,
                deniedGroupIds: [groupA],
                ageRating: null,
            });
            const narrowedIds = narrowed.map((r) => r.parent_id);
            for (const id of narrowedIds) expect(openIds).toContain(id);
            expect(narrowedIds.length).toBeLessThan(openIds.length);
            expect(narrowedIds).not.toContain(deniedSeriesId);
            expect(narrowedIds).toContain(allowedSeriesId);
        });

        it('keeps a watched series whose episodes carry no file at all', async () => {
            const userId = generateTestUserId('gwsfd_nofile');
            await ensureTestUser(sql, userId);
            const groupA = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupA}::uuid, 'GWSFD Unrelated')`;

            const seriesId = await seedWatchedSeries(userId, 'Cobalt Vigil', null);

            const narrowed = await getWatchedSeriesFromDb.all(sql, {
                userId: userId as UserId,
                deniedGroupIds: [groupA],
                ageRating: null,
            });
            expect(narrowed.map((r) => r.parent_id)).toContain(seriesId);
        });
    });
});
