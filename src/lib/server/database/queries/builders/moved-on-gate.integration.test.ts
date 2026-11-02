// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The moved-on gate, judged through all three consumers: the Home strip
 * (`getContinueWatchingFromDb`), the Continue Watching page
 * (`getExactContinueWatchingPageFromDb`) and the Jellyfin `/j` Resume feed
 * (`getResumeItems`). Every scenario asserts that the surfaces agree, so they
 * cannot drift apart again (`/j` used to have no gate at all).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { closeTestDb, getTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestSeries,
    ensureTestUser,
    generateTestUserId,
} from '../../../../../../tests/integration/fixtures/index.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { getContinueWatchingFromDb } from '../watch-state.queries.js';
import { getResumeItems } from '../jellyfin-browse.queries.js';
import { getExactContinueWatchingPageFromDb } from '$lib/server/api/defs/recommendations/continue-watching-page.query.js';
import { unrestrictedAccess } from './media-access-boundary.js';

const RUNTIME_MS = 22 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

describe('moved-on gate (Home strip, CW page, /j Resume)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'play_sessions',
            'user_media_flags',
            'user_media_events',
            'user_media_events_archive',
            'user_media_state',
            'series_episode_ordering',
            'episode_orderings',
            'media_file_items',
            'media_files',
            'media_items',
            'external_ids',
            'provider_metadata',
            'library_availability',
        ]);
    });

    function hoursAgo(h: number): string {
        return new Date(Date.now() - h * HOUR_MS).toISOString();
    }

    /** Seeds a playable series (files for every episode) and returns its episode ids by [season][episode]. */
    async function seedSeries(seasonCount = 2, episodesPerSeason = 6): Promise<string[][]> {
        const series = await createAndInsertTestSeries(sql, {
            title: 'Moved On Series',
            seasonCount,
            episodesPerSeason,
            episodeRuntimeSeconds: RUNTIME_MS / 1000,
        });
        const ids: string[][] = [];
        for (const season of series.seasons) {
            const seasonIds: string[] = [];
            for (const ep of season.episodes) {
                const [row] = await sql<{ media_id: string }[]>`
                    SELECT media_id FROM external_ids
                    WHERE provider = 'jellyfin' AND external_id = ${ep.jellyfin_id}
                    LIMIT 1
                `;
                const [file] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path)
                    VALUES (${`/series/moved-on/${row.media_id}.mkv`})
                    RETURNING id
                `;
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id)
                    VALUES (${file.id}::uuid, ${row.media_id}::uuid)
                `;
                await sql`UPDATE media_items SET has_files = true WHERE id = ${row.media_id}::uuid`;
                seasonIds.push(row.media_id);
            }
            ids.push(seasonIds);
        }
        return ids;
    }

    /** A paused episode at 50 %, last touched `at`. */
    async function seedPaused(userId: UserId, mediaId: string, at: string): Promise<void> {
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                watch_count, last_event_at, last_event_source, highest_session_elapsed_ms
            ) VALUES (
                ${userId}, ${mediaId}::uuid, false, ${RUNTIME_MS / 2}, ${RUNTIME_MS},
                0, ${at}::timestamptz, 'lumastra-player', ${RUNTIME_MS / 2}
            )
        `;
    }

    /**
     * A watched episode. `completedBy` decides which event backs the
     * completion: a real viewing to the end, an offline report, a mark, a
     * Jellyfin sync, or none.
     */
    async function seedWatched(
        userId: UserId,
        mediaId: string,
        at: string,
        completedBy:
            'lumastra-player' | 'lumastra-offline' | 'lumastra-user-mark' | 'jellyfin-sync',
    ): Promise<void> {
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                watch_count, last_watched_at, first_watched_at, last_event_at, last_event_source
            ) VALUES (
                ${userId}, ${mediaId}::uuid, true, 0, ${RUNTIME_MS},
                1, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz, ${completedBy}
            )
        `;
        if (completedBy === 'lumastra-player' || completedBy === 'lumastra-offline') {
            await sql`
                INSERT INTO user_media_events (
                    user_id, media_id, event_type, source, position_ms, runtime_ms,
                    session_elapsed_ms, occurred_at
                ) VALUES (
                    ${userId}, ${mediaId}::uuid, 'completed', ${completedBy},
                    ${RUNTIME_MS - 30_000}, ${RUNTIME_MS}, ${RUNTIME_MS - 60_000}, ${at}::timestamptz
                )
            `;
        } else if (completedBy === 'jellyfin-sync') {
            // What the sync really writes: a progress event whose
            // session_elapsed_ms is the pulled position (watch-sync-engine).
            await sql`
                INSERT INTO user_media_events (
                    user_id, media_id, event_type, source, position_ms, runtime_ms,
                    session_elapsed_ms, occurred_at
                ) VALUES (
                    ${userId}, ${mediaId}::uuid, 'progress', 'jellyfin-sync',
                    ${Math.round(RUNTIME_MS * 0.95)}, ${RUNTIME_MS},
                    ${Math.round(RUNTIME_MS * 0.95)}, ${at}::timestamptz
                )
            `;
        } else {
            await sql`
                INSERT INTO user_media_events (
                    user_id, media_id, event_type, source, occurred_at
                ) VALUES (
                    ${userId}, ${mediaId}::uuid, 'mark_watched', 'lumastra-user-mark', ${at}::timestamptz
                )
            `;
        }
    }

    async function homeIds(userId: UserId): Promise<string[]> {
        const rows = await getContinueWatchingFromDb.all(sql, {
            userId,
            limit: 20,
            minMs: 30_000,
            minPercent: 5,
            maxAgeDays: 0,
            collapsePerSeries: true,
        });
        return rows.map((r) => r.media_id);
    }

    async function pageIds(userId: UserId): Promise<string[]> {
        const rows = await getExactContinueWatchingPageFromDb.all(sql, {
            userId,
            limit: 20,
            minMs: 30_000,
            minPercent: 5,
            maxAgeDays: 0,
            deniedGroupIds: null,
            ageRating: null,
            page: {
                offset: 0,
                mediaTypes: null,
                staleAfterDays: 30,
                audiobookStaleAfterDays: 30,
                minProgressPercent: 10,
            },
        });
        return rows.map((r) => r.media_id);
    }

    /** Home strip and CW page: the surfaces that carry re-watch rows. */
    async function rewatchSurfaceIds(userId: UserId): Promise<string[][]> {
        return Promise.all([homeIds(userId), pageIds(userId)]);
    }

    async function jellyfinIds(userId: UserId): Promise<string[]> {
        const rows = await getResumeItems(sql, userId, 20, unrestrictedAccess());
        return rows.map((r) => String(r.id));
    }

    /** Asserts both surfaces agree on whether `mediaId` is offered. */
    async function expectOffered(userId: UserId, mediaId: string, offered: boolean): Promise<void> {
        const surfaces = await Promise.all([homeIds(userId), pageIds(userId), jellyfinIds(userId)]);
        for (const ids of surfaces) {
            if (offered) expect(ids).toContain(mediaId);
            else expect(ids).not.toContain(mediaId);
        }
    }

    async function newUser(tag: string): Promise<UserId> {
        const userId = toUserId(generateTestUserId(tag));
        await ensureTestUser(sql, userId);
        return userId;
    }

    it('hides an episode once a LATER episode was finished afterwards (now also on /j)', async () => {
        const userId = await newUser('mo_later');
        const ep = await seedSeries();
        await seedPaused(userId, ep[0][4], hoursAgo(5));
        await seedWatched(userId, ep[1][2], hoursAgo(2), 'lumastra-player');

        await expectOffered(userId, ep[0][4], false);
    });

    it('hides an episode once an EARLIER episode was played to the end afterwards', async () => {
        const userId = await newUser('mo_earlier');
        const ep = await seedSeries();
        await seedPaused(userId, ep[1][3], hoursAgo(5));
        await seedWatched(userId, ep[0][1], hoursAgo(2), 'lumastra-player');

        await expectOffered(userId, ep[1][3], false);
    });

    it('counts an offline report by when it was played', async () => {
        const userId = await newUser('mo_offline');
        const ep = await seedSeries();
        await seedPaused(userId, ep[1][3], hoursAgo(5));
        await seedWatched(userId, ep[0][1], hoursAgo(2), 'lumastra-offline');

        await expectOffered(userId, ep[1][3], false);
    });

    it('keeps the episode when an earlier one was only MARKED watched', async () => {
        const userId = await newUser('mo_mark');
        const ep = await seedSeries();
        await seedPaused(userId, ep[1][3], hoursAgo(5));
        await seedWatched(userId, ep[0][1], hoursAgo(2), 'lumastra-user-mark');

        await expectOffered(userId, ep[1][3], true);
    });

    it('keeps the episode when an earlier one only arrived through Jellyfin sync', async () => {
        const userId = await newUser('mo_sync');
        const ep = await seedSeries();
        await seedPaused(userId, ep[1][3], hoursAgo(5));
        await seedWatched(userId, ep[0][1], hoursAgo(2), 'jellyfin-sync');

        await expectOffered(userId, ep[1][3], true);
    });

    it('keeps the episode when the other one was finished BEFORE it was last played', async () => {
        const userId = await newUser('mo_before');
        const ep = await seedSeries();
        await seedWatched(userId, ep[0][1], hoursAgo(9), 'lumastra-player');
        await seedPaused(userId, ep[1][3], hoursAgo(5));

        await expectOffered(userId, ep[1][3], true);
    });

    it('keeps the episode when the other one was only briefly played (no completion)', async () => {
        const userId = await newUser('mo_peek');
        const ep = await seedSeries();
        await seedPaused(userId, ep[1][3], hoursAgo(5));
        // A 40-second peek at an earlier episode: a progress event, no completion.
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, event_type, source, position_ms, runtime_ms,
                session_elapsed_ms, occurred_at
            ) VALUES (
                ${userId}, ${ep[0][1]}::uuid, 'progress', 'lumastra-player',
                40000, ${RUNTIME_MS}, 40000, ${hoursAgo(2)}::timestamptz
            )
        `;

        await expectOffered(userId, ep[1][3], true);
    });

    it('brings the episode back when it is played again after the other finish', async () => {
        const userId = await newUser('mo_back');
        const ep = await seedSeries();
        await seedWatched(userId, ep[0][1], hoursAgo(5), 'lumastra-player');
        // Paused before the finish originally, touched again an hour ago.
        await seedPaused(userId, ep[1][3], hoursAgo(1));

        await expectOffered(userId, ep[1][3], true);
    });

    it('keeps the episode when the only completion came from a sync, not the player', async () => {
        const userId = await newUser('mo_sync_completed');
        const ep = await seedSeries();
        await seedPaused(userId, ep[1][3], hoursAgo(5));
        await seedWatched(userId, ep[0][1], hoursAgo(2), 'jellyfin-sync');
        // Even a `completed` event does not count when a sync wrote it.
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, event_type, source, position_ms, runtime_ms, occurred_at
            ) VALUES (
                ${userId}, ${ep[0][1]}::uuid, 'completed', 'jellyfin-sync',
                ${RUNTIME_MS}, ${RUNTIME_MS}, ${hoursAgo(2)}::timestamptz
            )
        `;

        await expectOffered(userId, ep[1][3], true);
    });

    it('counts a completion that was already moved to the event archive', async () => {
        const userId = await newUser('mo_archive');
        const ep = await seedSeries();
        await seedPaused(userId, ep[1][3], hoursAgo(5));
        await seedWatched(userId, ep[0][1], hoursAgo(2), 'lumastra-player');
        await sql`
            WITH moved AS (
                DELETE FROM user_media_events
                WHERE user_id = ${userId} AND media_id = ${ep[0][1]}::uuid
                RETURNING *
            )
            INSERT INTO user_media_events_archive
                (id, user_id, media_id, event_type, source, position_ms, runtime_ms,
                 occurred_at, recorded_at, session_elapsed_ms)
            SELECT id, user_id, media_id, event_type, source, position_ms, runtime_ms,
                   occurred_at, recorded_at, session_elapsed_ms
            FROM moved
        `;

        await expectOffered(userId, ep[1][3], false);
    });

    it('keeps the episode when the completion was repudiated', async () => {
        const userId = await newUser('mo_repudiated');
        const ep = await seedSeries();
        await seedPaused(userId, ep[1][3], hoursAgo(5));
        await seedWatched(userId, ep[0][1], hoursAgo(2), 'lumastra-player');
        await sql`
            UPDATE user_media_events SET repudiated_at = NOW()
            WHERE user_id = ${userId} AND media_id = ${ep[0][1]}::uuid
        `;

        await expectOffered(userId, ep[1][3], true);
    });

    /** Turns season 1's episodes into specials (season 0). */
    async function makeFirstSeasonSpecials(ep: string[][]): Promise<void> {
        await sql`
            UPDATE media_items SET season_number = 0
            WHERE id IN ${sql(ep[0])}
        `;
    }

    it('never lets a finished special hide a main-line episode', async () => {
        const userId = await newUser('mo_special_suppress');
        const ep = await seedSeries();
        await makeFirstSeasonSpecials(ep);
        await seedPaused(userId, ep[1][3], hoursAgo(5));
        await seedWatched(userId, ep[0][1], hoursAgo(2), 'lumastra-player');

        await expectOffered(userId, ep[1][3], true);
    });

    it('never hides a paused special, even after a main-line episode is played to the end', async () => {
        const userId = await newUser('mo_special_kept');
        const ep = await seedSeries();
        await makeFirstSeasonSpecials(ep);
        await seedPaused(userId, ep[0][1], hoursAgo(5));
        await seedWatched(userId, ep[1][3], hoursAgo(2), 'lumastra-player');

        await expectOffered(userId, ep[0][1], true);
    });

    it('Home + page: a re-watch row is hidden once another episode is played to the end', async () => {
        const userId = await newUser('mo_rewatch_play');
        const ep = await seedSeries();
        // S2E6 watched long ago, re-watch in progress 5 h ago.
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms, runtime_ms, watch_count,
                last_watched_at, first_watched_at, last_event_at, last_event_source, highest_session_elapsed_ms
            ) VALUES (
                ${userId}, ${ep[1][5]}::uuid, true, ${RUNTIME_MS / 2}, ${RUNTIME_MS}, 1,
                '2024-09-28T19:53:42Z', '2024-09-28T19:53:42Z', ${hoursAgo(5)}::timestamptz,
                'lumastra-player', ${RUNTIME_MS / 2}
            )
        `;
        await seedWatched(userId, ep[0][2], hoursAgo(2), 'lumastra-player');

        for (const ids of await rewatchSurfaceIds(userId)) expect(ids).not.toContain(ep[1][5]);
    });

    it('Home + page: a re-watch row survives a later episode merely MARKED watched', async () => {
        const userId = await newUser('mo_rewatch_mark');
        const ep = await seedSeries();
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, is_watched, resume_position_ms, runtime_ms, watch_count,
                last_watched_at, first_watched_at, last_event_at, last_event_source, highest_session_elapsed_ms
            ) VALUES (
                ${userId}, ${ep[0][2]}::uuid, true, ${RUNTIME_MS / 2}, ${RUNTIME_MS}, 1,
                '2024-09-28T19:53:42Z', '2024-09-28T19:53:42Z', ${hoursAgo(5)}::timestamptz,
                'lumastra-player', ${RUNTIME_MS / 2}
            )
        `;
        await seedWatched(userId, ep[1][5], hoursAgo(2), 'lumastra-user-mark');

        for (const ids of await rewatchSurfaceIds(userId)) expect(ids).toContain(ep[0][2]);
    });

    it('/j: a live session is never hidden, even after another episode is finished', async () => {
        const userId = await newUser('mo_live');
        const ep = await seedSeries();
        await seedPaused(userId, ep[1][3], hoursAgo(5));
        await seedWatched(userId, ep[0][1], hoursAgo(2), 'lumastra-player');
        await sql`
            INSERT INTO play_sessions (
                media_id, user_id, device_id, ip_address, play_method, status,
                position_ms, runtime_ms, last_heartbeat_at
            ) VALUES (
                ${ep[1][3]}::uuid, ${userId}::uuid, 'test-device', '127.0.0.1', 'direct',
                'ACTIVE', ${RUNTIME_MS / 2}, ${RUNTIME_MS}, NOW()
            )
        `;

        expect(await jellyfinIds(userId)).toContain(ep[1][3]);
    });

    it('falls back to a sibling instead of dropping the series when the newest row is gated', async () => {
        const userId = await newUser('mo_sibling');
        const ep = await seedSeries();
        // S2E6 paused 4 h ago, S1E2 paused 3 h ago (the newest row). S2E1
        // marked watched 2 h ago: a later episode for S1E2 (later-episode
        // gate, marks count there) but an earlier one for S2E6, and a mark
        // never counts as finished by playback. So the newest row is gated
        // and the series must fall back to S2E6, not vanish.
        await seedPaused(userId, ep[1][5], hoursAgo(4));
        await seedPaused(userId, ep[0][1], hoursAgo(3));
        await seedWatched(userId, ep[1][0], hoursAgo(2), 'lumastra-user-mark');

        await expectOffered(userId, ep[0][1], false);
        await expectOffered(userId, ep[1][5], true);
    });
});
