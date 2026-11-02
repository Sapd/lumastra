// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "New episodes available" against a real database: the rule in
 * `new-release-rule.ts` fed by `new-release-episodes.queries.ts`, applied by
 * `getNewReleaseGroupsForUser` / `getNewEpisodesForUser`. Library-only, no
 * Sonarr. All dates are fixed relative to `NOW` so the cases are deterministic.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import {
    derivedUsername,
    ensureTestUser,
    generateTestUserId,
} from '../../../../tests/integration/fixtures/index.js';
import type { UserId } from '$lib/shared/user-id';
import { getNewEpisodesForUser, getNewReleaseGroupsForUser } from './new-episodes.service.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** ISO timestamp `days` before NOW (fractions allowed). */
function ago(days: number): string {
    return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

/** Calendar date (YYYY-MM-DD) `days` before NOW. */
function dayAgo(days: number): string {
    return ago(days).slice(0, 10);
}

interface TestSeries {
    seriesId: string;
    seasonId: string;
}

interface EpisodeSpec {
    season?: number;
    episode: number;
    /** YYYY-MM-DD or null for an undated episode. */
    premiere: string | null;
    /** When the file arrived (ISO). */
    addedAt: string;
    hasFiles?: boolean;
}

describe('new-episodes — new-release rule against the database', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            ...TEST_TABLES.userData,
            ...TEST_TABLES.preferences,
        ]);
    });

    async function newUser(): Promise<UserId> {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        return userId;
    }

    async function insertSeries(
        status: 'Returning Series' | 'Ended' | null,
        seasonNumber = 1,
    ): Promise<TestSeries> {
        const seriesId = crypto.randomUUID();
        const seasonId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${seriesId}::uuid, ${'Series ' + seriesId.slice(0, 8)}, 'tv', 'active')
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, parent_id, season_number)
            VALUES (${seasonId}::uuid, 'Season', 'season', 'active', ${seriesId}::uuid, ${seasonNumber})
        `;
        if (status) {
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${seriesId}::uuid, 'tmdb', ${sql.json({ status })})
            `;
        }
        return { seriesId, seasonId };
    }

    async function insertEpisode(series: TestSeries, spec: EpisodeSpec): Promise<string> {
        const id = crypto.randomUUID();
        const season = spec.season ?? 1;
        await sql`
            INSERT INTO media_items
                (id, title, media_type, status, parent_id, season_number, episode_number,
                 premiere_date, has_files, library_added_at)
            VALUES
                (${id}::uuid, ${'Episode ' + spec.episode}, 'episode', 'active', ${series.seasonId}::uuid,
                 ${season}, ${spec.episode}, ${spec.premiere}::date, ${spec.hasFiles ?? true},
                 ${spec.addedAt}::timestamptz)
        `;
        return id;
    }

    async function markWatched(userId: UserId, episodeId: string, at: string): Promise<void> {
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at)
            VALUES (${userId}::uuid, ${episodeId}::uuid, true, ${at}::timestamptz)
        `;
    }

    /** `count` old, watched episodes (aired and added long ago), one viewing moment each. */
    async function watchOldEpisodes(
        userId: UserId,
        series: TestSeries,
        count: number,
        moments: 'separate' | 'bulk',
    ): Promise<string[]> {
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
            const id = await insertEpisode(series, {
                episode: i + 1,
                premiere: dayAgo(90 - i),
                addedAt: ago(80 - i * 2),
            });
            await markWatched(
                userId,
                id,
                moments === 'bulk' ? ago(40) : ago(40 - i * 2), // days apart, or one instant
            );
            ids.push(id);
        }
        return ids;
    }

    async function follow(userId: UserId, seriesId: string): Promise<void> {
        await sql`
            INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
            VALUES (${userId}::uuid, ${seriesId}, 'series', 'series_episode_notifications')
        `;
    }

    async function addToWatchlist(userId: UserId, seriesId: string): Promise<void> {
        const [playlist] = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, playlist_type)
            VALUES (${userId}::uuid, 'Watchlist', 'watchlist')
            RETURNING id
        `;
        await sql`
            INSERT INTO playlist_items (playlist_id, media_id, title, position)
            VALUES (${playlist.id}, ${seriesId}::uuid, 'Series', 0)
        `;
    }

    const label = (e: { seasonNumber: number; episodeNumber: number }): string =>
        `S${e.seasonNumber}E${e.episodeNumber}`;

    it('airing show, 3 separate viewings, a new aired episode with file qualifies (followReason watched)', async () => {
        const userId = await newUser();
        const series = await insertSeries('Returning Series');
        await watchOldEpisodes(userId, series, 3, 'separate');
        // Unwatched but old: aired months ago, must not be listed.
        await insertEpisode(series, { episode: 4, premiere: dayAgo(100), addedAt: ago(90) });
        await insertEpisode(series, { episode: 5, premiere: dayAgo(3), addedAt: ago(2.5) });
        // New episode aired 3 days ago, but without a file: not listed.
        await insertEpisode(series, {
            episode: 6,
            premiere: dayAgo(2),
            addedAt: ago(2),
            hasFiles: false,
        });

        const groups = await getNewReleaseGroupsForUser(sql, userId, { now: NOW });

        expect(groups).toHaveLength(1);
        expect(groups[0].series.seriesId).toBe(series.seriesId);
        expect(groups[0].followReason).toBe('watched');
        expect(groups[0].series.watchedEpisodeCount).toBe(3);
        expect(groups[0].episodes.map(label)).toEqual(['S1E5']);
    });

    it('ENDED 2017 show whose whole season got files 2 days ago: 1 watched episode gives no group', async () => {
        const userId = await newUser();
        const series = await insertSeries('Ended');
        const ids: string[] = [];
        for (let e = 1; e <= 13; e++) {
            ids.push(
                await insertEpisode(series, {
                    episode: e,
                    premiere: `2017-0${1 + Math.floor((e - 1) / 5)}-${String(((e - 1) % 5) * 5 + 1).padStart(2, '0')}`,
                    addedAt: new Date(NOW.getTime() - 2 * DAY_MS + e * 60_000).toISOString(),
                }),
            );
        }
        await markWatched(userId, ids[0], ago(1));

        const groups = await getNewReleaseGroupsForUser(sql, userId, { now: NOW });

        expect(groups).toEqual([]);
    });

    it('same 2017 season pack with 3 watched episodes is still no group (old air dates)', async () => {
        const userId = await newUser();
        const series = await insertSeries('Ended');
        const ids: string[] = [];
        for (let e = 1; e <= 13; e++) {
            ids.push(
                await insertEpisode(series, {
                    episode: e,
                    premiere: `2017-0${1 + Math.floor((e - 1) / 5)}-${String(((e - 1) % 5) * 5 + 1).padStart(2, '0')}`,
                    addedAt: new Date(NOW.getTime() - 2 * DAY_MS + e * 60_000).toISOString(),
                }),
            );
        }
        await markWatched(userId, ids[0], ago(1.5));
        await markWatched(userId, ids[1], ago(1));
        await markWatched(userId, ids[2], ago(0.5));

        const groups = await getNewReleaseGroupsForUser(sql, userId, { now: NOW });

        expect(groups).toEqual([]);
    });

    it('bulk import of an airing show is no group; a later single arrival aired yesterday qualifies', async () => {
        const userId = await newUser();
        const series = await insertSeries('Returning Series');
        await follow(userId, series.seriesId);

        // 10 old episodes + 1 aired 5 days ago, all arriving within the same hour.
        const batchStart = NOW.getTime() - 4 * DAY_MS;
        for (let e = 1; e <= 10; e++) {
            await insertEpisode(series, {
                episode: e,
                premiere: dayAgo(200 - e * 5),
                addedAt: new Date(batchStart + e * 5 * 60_000).toISOString(),
            });
        }
        await insertEpisode(series, {
            episode: 11,
            premiere: dayAgo(5),
            addedAt: new Date(batchStart + 11 * 5 * 60_000).toISOString(),
        });

        expect(await getNewReleaseGroupsForUser(sql, userId, { now: NOW })).toEqual([]);

        // Three days after the batch: one episode aired yesterday arrives on its own.
        await insertEpisode(series, {
            episode: 12,
            premiere: dayAgo(1),
            addedAt: new Date(batchStart + 3 * DAY_MS).toISOString(),
        });

        const groups = await getNewReleaseGroupsForUser(sql, userId, { now: NOW });

        expect(groups).toHaveLength(1);
        expect(groups[0].followReason).toBe('followed');
        expect(groups[0].episodes.map(label)).toEqual(['S1E12']);
    });

    it('episodes marked watched in bulk are ONE viewing moment: not followed, unless on the watchlist', async () => {
        const userId = await newUser();
        const series = await insertSeries('Returning Series');
        await watchOldEpisodes(userId, series, 5, 'bulk');
        await insertEpisode(series, { episode: 6, premiere: dayAgo(2), addedAt: ago(1.5) });

        const [before] = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM user_media_state WHERE user_id = ${userId}::uuid AND is_watched
        `;
        expect(before.n).toBe(5);
        expect(await getNewReleaseGroupsForUser(sql, userId, { now: NOW })).toEqual([]);

        await addToWatchlist(userId, series.seriesId);

        const groups = await getNewReleaseGroupsForUser(sql, userId, { now: NOW });
        expect(groups).toHaveLength(1);
        expect(groups[0].followReason).toBe('watchlist');
        expect(groups[0].series.watchedEpisodeCount).toBe(5);
        expect(groups[0].series.watchedMomentCount).toBe(1);
        expect(groups[0].episodes.map(label)).toEqual(['S1E6']);
    });

    it('an undated episode qualifies on an airing show (file added yesterday) but not on an ended one', async () => {
        const userId = await newUser();
        const airing = await insertSeries('Returning Series');
        const ended = await insertSeries('Ended');
        await follow(userId, airing.seriesId);
        await follow(userId, ended.seriesId);
        await insertEpisode(airing, { episode: 1, premiere: null, addedAt: ago(1) });
        await insertEpisode(ended, { episode: 1, premiere: null, addedAt: ago(1) });

        const groups = await getNewReleaseGroupsForUser(sql, userId, { now: NOW });

        expect(groups.map((g) => g.series.seriesId)).toEqual([airing.seriesId]);
        expect(groups[0].episodes.map(label)).toEqual(['S1E1']);
        expect(groups[0].series.airing).toBe(true);
    });

    it('a muted series and a dismissed series are left out', async () => {
        const userId = await newUser();
        const muted = await insertSeries('Returning Series');
        const dismissed = await insertSeries('Returning Series');
        const shown = await insertSeries('Returning Series');
        for (const s of [muted, dismissed, shown]) {
            await follow(userId, s.seriesId);
            await insertEpisode(s, { episode: 1, premiere: dayAgo(2), addedAt: ago(1) });
        }
        await sql`
            INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
            VALUES (${userId}::uuid, ${muted.seriesId}, 'series', 'series_excluded')
        `;
        await sql`
            INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
            VALUES (${userId}::uuid, ${dismissed.seriesId}, 'series', 'new_episode_alert_dismissed')
        `;

        const groups = await getNewReleaseGroupsForUser(sql, userId, { now: NOW });

        expect(groups.map((g) => g.series.seriesId)).toEqual([shown.seriesId]);
    });

    it('getNewEpisodesForUser returns one item per qualifying episode with episodeCount and userWatchCount', async () => {
        const userId = await newUser();
        const series = await insertSeries('Returning Series');
        await watchOldEpisodes(userId, series, 3, 'separate');
        await insertEpisode(series, {
            season: 2,
            episode: 1,
            premiere: dayAgo(3),
            addedAt: ago(2.5),
        });
        await insertEpisode(series, {
            season: 2,
            episode: 2,
            premiere: dayAgo(2),
            addedAt: ago(1.5),
        });

        const items = await getNewEpisodesForUser(sql, derivedUsername(userId), { now: NOW });

        expect(items.map(label)).toEqual(['S2E2', 'S2E1']);
        for (const item of items) {
            expect(item.seriesId).toBe(series.seriesId);
            expect(item.episodeCount).toBe(2);
            expect(item.userWatchCount).toBe(3);
            expect(item.followReason).toBe('watched');
        }
        expect(items.find((i) => i.episodeNumber === 1)?.isSeasonPremiere).toBe(true);
    });
});
