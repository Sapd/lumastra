// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the series smart-download queries.
 *
 * These MUST be integration tests. Every assertion is about an ORDERING, an
 * ANCHOR position, an ACCESS gate or a GRADUATION boundary, and the unit suite
 * mocks the query layer wholesale.
 *
 * They also carry an unusual burden: preprod has FIVE series with files, 37
 * episodes, and ZERO users with anything in progress — no
 * `is_watched = false, resume_position_ms > 0` row exists anywhere on a real
 * box. The anchor rule and Continue Watching's completion threshold are
 * therefore exercised by nothing except the fixtures below. Treat a deletion
 * here as a deletion of the only coverage there is.
 *
 * Requires PG 17+ (a local Homebrew Postgres 15 will not do); point
 * TEST_DATABASE_URL at a 17+ instance.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    getSeriesNextUpCandidates,
    type DownloadAccessLimits,
} from './series-downloads.queries.js';

const NO_ACCESS_LIMITS: DownloadAccessLimits = { deniedGroupIds: null, ageRating: null };

let sql: postgres.Sql;
let userId: string;

beforeAll(async () => {
    sql = await getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.all);
    userId = randomUUID();
    // `users` is not in TEST_TABLES (it is not truncated between tests), and
    // `user_media_state.user_id` / `user_media_flags.user_id` both FK it —
    // seedEngagement and dismissSeries fail without a matching row.
    await sql`
        INSERT INTO users (id, username)
        VALUES (${userId}::uuid, ${'series-downloads-' + userId.slice(0, 8)})
    `;
});

// ---------------------------------------------------------------------------
// Fixture helpers
//
// The shared fixtures in tests/integration/fixtures/ cannot express what this
// query needs: `createAndInsertTestSeries` builds a series/season/episode tree
// but attaches NO media_files, and every candidate here requires a default
// file (`media_file_items.is_default = true` joined to a non-missing
// `media_files` row). `insertTestEpisode` also leaves `has_files` at its
// default of false, which alone would make every assertion below pass against
// an empty set. So the helpers are local and explicit.
// ---------------------------------------------------------------------------

interface SeededSeries {
    seriesId: string;
    seasonIds: Map<number, string>;
}

/** A series + its seasons, with no episodes yet. */
async function seedSeries(title: string, seasonNumbers: number[]): Promise<SeededSeries> {
    const seriesId = randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status)
        VALUES (${seriesId}::uuid, ${title}, 'tv', 'active')
    `;
    const seasonIds = new Map<number, string>();
    for (const n of seasonNumbers) {
        const seasonId = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
            VALUES (${seasonId}::uuid, ${'Season ' + n}, 'season', ${seriesId}::uuid, ${n}, 'active')
        `;
        seasonIds.set(n, seasonId);
    }
    return { seriesId, seasonIds };
}

interface SeedEpisodeOpts {
    /** Minutes. 45 by default — inside CW's 0.90 tier. */
    runtimeMinutes?: number;
    /** Attach a default local file. TRUE by default: without one it is not a candidate. */
    withFile?: boolean;
    /** Reuse an existing media_files row — the combined multi-episode case. */
    fileId?: string;
    /** Group the file belongs to, for the library-access gate. */
    libraryGroupId?: string | null;
    /** Video stream height, for the rung clamp. Null writes no media_streams row. */
    height?: number | null;
    /** Mark the file missing from disk. */
    isMissing?: boolean;
    /** Attach the file WITHOUT is_default, so the episode has no default file. */
    nonDefaultFile?: boolean;
}

/** One episode, its file, and its video stream. Returns both ids. */
async function seedEpisode(
    series: SeededSeries,
    seasonNumber: number,
    episodeNumber: number,
    opts: SeedEpisodeOpts = {},
): Promise<{ episodeId: string; fileId: string | null }> {
    const {
        runtimeMinutes = 45,
        withFile = true,
        libraryGroupId = null,
        height = 1080,
        isMissing = false,
        nonDefaultFile = false,
    } = opts;

    const episodeId = randomUUID();
    const seasonId = series.seasonIds.get(seasonNumber);
    if (!seasonId) throw new Error(`seedEpisode: season ${seasonNumber} was not seeded`);

    await sql`
        INSERT INTO media_items
            (id, title, media_type, parent_id, season_number, episode_number, runtime_seconds, has_files, status)
        VALUES (
            ${episodeId}::uuid,
            ${`S${seasonNumber}E${episodeNumber}`},
            'episode',
            ${seasonId}::uuid,
            ${seasonNumber},
            ${episodeNumber},
            ${runtimeMinutes * 60},
            ${withFile},
            'active'
        )
    `;

    if (!withFile) return { episodeId, fileId: null };

    let fileId = opts.fileId ?? null;
    if (!fileId) {
        fileId = randomUUID();
        await sql`
            INSERT INTO media_files
                (id, file_path, library_group_id, duration_seconds, is_missing, created_at, updated_at)
            VALUES (
                ${fileId}::uuid,
                ${`/data/tv/${episodeId}.mkv`},
                ${libraryGroupId}::uuid,
                ${runtimeMinutes * 60},
                ${isMissing},
                NOW(), NOW()
            )
        `;
        if (height !== null) {
            await sql`
                INSERT INTO media_streams (file_id, stream_type, stream_index, codec, height, width)
                VALUES (${fileId}::uuid, 'video', 0, 'h264', ${height}, ${Math.round((height * 16) / 9)})
            `;
        }
    }
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id, is_default)
        VALUES (${fileId}::uuid, ${episodeId}::uuid, ${!nonDefaultFile})
    `;
    return { episodeId, fileId };
}

/**
 * An episode with a NULL `episode_number` -- the "unpositionable" fixture
 * Bug 1 exists for. `media_items.episode_number` (and `season_number`) are
 * genuinely nullable in the schema; `seedEpisode` above cannot express this
 * because its `episodeNumber` parameter is typed `number`. Has a default
 * local file like any other candidate-eligible episode; only the ordinal
 * position is missing.
 */
async function seedEpisodeNullNumber(
    series: SeededSeries,
    seasonNumber: number,
): Promise<{ episodeId: string; fileId: string }> {
    const episodeId = randomUUID();
    const seasonId = series.seasonIds.get(seasonNumber);
    if (!seasonId) {
        throw new Error(`seedEpisodeNullNumber: season ${seasonNumber} was not seeded`);
    }

    await sql`
        INSERT INTO media_items
            (id, title, media_type, parent_id, season_number, episode_number, runtime_seconds, has_files, status)
        VALUES (
            ${episodeId}::uuid,
            ${`S${seasonNumber}E?`},
            'episode',
            ${seasonId}::uuid,
            ${seasonNumber},
            NULL,
            ${45 * 60},
            true,
            'active'
        )
    `;

    const fileId = randomUUID();
    await sql`
        INSERT INTO media_files
            (id, file_path, library_group_id, duration_seconds, is_missing, created_at, updated_at)
        VALUES (${fileId}::uuid, ${`/data/tv/${episodeId}.mkv`}, NULL, ${45 * 60}, false, NOW(), NOW())
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id, is_default)
        VALUES (${fileId}::uuid, ${episodeId}::uuid, true)
    `;
    return { episodeId, fileId };
}

/**
 * Engagement state for one episode.
 *
 * `resumeFraction` is a fraction of the episode's runtime, so a test can sit
 * an episode deliberately just under or just over Continue Watching's tiered
 * completion threshold without restating the arithmetic.
 */
async function seedEngagement(
    episodeId: string,
    opts: { watched?: boolean; resumeFraction?: number; hoursAgo?: number },
): Promise<void> {
    const { watched = false, resumeFraction = 0, hoursAgo = 1 } = opts;
    const [{ runtime_seconds: runtimeSeconds }] = await sql<[{ runtime_seconds: number }]>`
        SELECT runtime_seconds FROM media_items WHERE id = ${episodeId}::uuid
    `;
    const runtimeMs = runtimeSeconds * 1000;
    await sql`
        INSERT INTO user_media_state
            (user_id, media_id, is_watched, resume_position_ms, runtime_ms, last_event_at, last_watched_at)
        VALUES (
            ${userId}::uuid,
            ${episodeId}::uuid,
            ${watched},
            ${Math.round(runtimeMs * resumeFraction)},
            ${runtimeMs},
            NOW() - (${hoursAgo}::text || ' hours')::interval,
            ${watched ? sql`NOW() - (${hoursAgo}::text || ' hours')::interval` : null}
        )
    `;
}

/** Dismiss a series from Continue Watching, which also removes it from the pool. */
async function dismissSeries(seriesId: string): Promise<void> {
    await sql`
        INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
        VALUES (${userId}::uuid, ${seriesId}, 'series', 'dismissed_cw')
    `;
}

async function candidates(access = NO_ACCESS_LIMITS) {
    return getSeriesNextUpCandidates(sql, toUserId(userId), access);
}

// ---------------------------------------------------------------------------

describe('getSeriesNextUpCandidates — the anchor', () => {
    it('makes an UNCONSUMED anchor candidate #0 — the half-watched episode itself', async () => {
        // The whole point: the episode you are 20% through is the first thing
        // the pool should hold, not the one after it. Preprod has NO row in
        // this state, so this fixture is the only place it is ever exercised.
        const series = await seedSeries('Anchor Unconsumed', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { resumeFraction: 0.2 });

        const rows = await candidates();

        expect(rows.map((r) => r.media_id)).toEqual([e1, e2]);
        expect(rows[0]!.distance).toBe(0);
    });

    it('excludes a CONSUMED anchor, starting at the episode after it', async () => {
        const series = await seedSeries('Anchor Consumed', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { watched: true });

        const rows = await candidates();

        expect(rows.map((r) => r.media_id)).toEqual([e2]);
        expect(rows[0]!.distance).toBe(0);
    });

    it('treats past-threshold progress as consumed, matching Continue Watching', async () => {
        // 45 min < 90 min, so the tier is 0.90. 0.95 is past it: CW drops the
        // episode from its rail, and the pool must agree or the two disagree
        // about where the user is.
        const series = await seedSeries('Past Threshold', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1, { runtimeMinutes: 45 });
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { resumeFraction: 0.95 });

        const rows = await candidates();

        expect(rows.map((r) => r.media_id)).toEqual([e2]);
    });

    it('treats just-under-threshold progress as still in progress', async () => {
        const series = await seedSeries('Under Threshold', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1, { runtimeMinutes: 45 });
        await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { resumeFraction: 0.85 });

        const rows = await candidates();

        // Deleting an episode the user is 85% through is the failure the shared
        // threshold exists to prevent.
        expect(rows[0]!.media_id).toBe(e1);
    });

    it('anchors on the MOST RECENTLY ENGAGED episode, not the furthest watched', async () => {
        // A rewatch: the user finished the series, then started S1E2 again
        // today. The anchor walks BACKWARD with them, exactly as
        // getNextUpFromDb does, instead of stranding the pool at the finale.
        const series = await seedSeries('Rewatch', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        const { episodeId: e3 } = await seedEpisode(series, 1, 3);
        await seedEngagement(e1, { watched: true, hoursAgo: 500 });
        await seedEngagement(e3, { watched: true, hoursAgo: 400 });
        await seedEngagement(e2, { resumeFraction: 0.1, hoursAgo: 1 });

        const rows = await candidates();

        expect(rows.map((r) => r.media_id)).toEqual([e2, e3]);
    });

    it('ignores a series whose last engagement is older than the age window', async () => {
        const series = await seedSeries('Abandoned', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { watched: true, hoursAgo: 24 * 365 });

        expect(await candidates()).toEqual([]);
    });

    it('keeps that same series when maxAgeDays is 0 — 0 disables the cutoff', async () => {
        // CONTINUE_WATCHING_MAX_AGE_DAYS = 0 is documented as "disable the
        // cutoff", and it is admin-editable. Without the escape the predicate
        // becomes `>= NOW()`, which nothing satisfies, and the pool goes dark
        // for every user at once.
        const series = await seedSeries('Abandoned But Uncapped', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { watched: true, hoursAgo: 24 * 365 });

        const rows = await getSeriesNextUpCandidates(sql, toUserId(userId), NO_ACCESS_LIMITS, {
            maxAgeDays: 0,
        });

        expect(rows.length).toBeGreaterThan(0);
    });

    it('ignores a series with no engagement at all — the pool is not a recommender', async () => {
        const series = await seedSeries('Untouched', [1]);
        await seedEpisode(series, 1, 1);

        expect(await candidates()).toEqual([]);
    });

    it('drops a series dismissed from Continue Watching', async () => {
        const series = await seedSeries('Dismissed', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { watched: true });
        await dismissSeries(series.seriesId);

        expect(await candidates()).toEqual([]);
    });
});

describe('getSeriesNextUpCandidates — the ordering', () => {
    it("is distance-major: every series' next episode before any series' second", async () => {
        // THE contract. A budget that fits four episodes gives you the next
        // episode of four shows, never four episodes of one. Without this the
        // feature's stated value is not delivered at any budget a phone has.
        //
        // Both series need a distance-1 row too: with only one series
        // contributing to that band, `ORDER BY distance, series_rank` and
        // `ORDER BY series_rank, distance` happen to emit the same sequence,
        // and the mutation check in Step 5 would pass under the broken
        // ordering by coincidence. n3 makes the two orderings diverge:
        // distance-major -> [n2, o2, n3, o3]; series-rank-major (broken)
        // -> [n2, n3, o2, o3].
        const older = await seedSeries('Older Show', [1]);
        const newer = await seedSeries('Newer Show', [1]);
        const { episodeId: o1 } = await seedEpisode(older, 1, 1);
        const { episodeId: o2 } = await seedEpisode(older, 1, 2);
        const { episodeId: o3 } = await seedEpisode(older, 1, 3);
        const { episodeId: n1 } = await seedEpisode(newer, 1, 1);
        const { episodeId: n2 } = await seedEpisode(newer, 1, 2);
        const { episodeId: n3 } = await seedEpisode(newer, 1, 3);
        await seedEngagement(o1, { watched: true, hoursAgo: 48 });
        await seedEngagement(n1, { watched: true, hoursAgo: 2 });

        const rows = await candidates();

        expect(rows.map((r) => r.media_id)).toEqual([n2, o2, n3, o3]);
        expect(rows.map((r) => r.distance)).toEqual([0, 0, 1, 1]);
    });

    it('breaks a distance tie by series recency, most recent first', async () => {
        const a = await seedSeries('Touched Yesterday', [1]);
        const b = await seedSeries('Touched An Hour Ago', [1]);
        const { episodeId: a1 } = await seedEpisode(a, 1, 1);
        const { episodeId: a2 } = await seedEpisode(a, 1, 2);
        const { episodeId: b1 } = await seedEpisode(b, 1, 1);
        const { episodeId: b2 } = await seedEpisode(b, 1, 2);
        await seedEngagement(a1, { watched: true, hoursAgo: 24 });
        await seedEngagement(b1, { watched: true, hoursAgo: 1 });

        const rows = await candidates();

        expect(rows.map((r) => r.media_id)).toEqual([b2, a2]);
        expect(rows[0]!.series_rank).toBeLessThan(rows[1]!.series_rank);
    });

    it('counts distance POSITIONALLY across a season boundary', async () => {
        // An arithmetic gap (ord - anchor_ord) would read the jump from S1E2 to
        // S2E1 as 9999 and push a genuinely-next episode into a distant band.
        const series = await seedSeries('Season Boundary', [1, 2]);
        const { episodeId: s1e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: s1e2 } = await seedEpisode(series, 1, 2);
        const { episodeId: s2e1 } = await seedEpisode(series, 2, 1);
        await seedEngagement(s1e1, { watched: true });

        const rows = await candidates();

        expect(rows.map((r) => r.media_id)).toEqual([s1e2, s2e1]);
        expect(rows.map((r) => r.distance)).toEqual([0, 1]);
    });

    it('counts distance POSITIONALLY across a missing episode row', async () => {
        // The scanner never saw E3. Positional counting is immune; an ordinal
        // gap would make E4 distance 2 and demote it behind another series'
        // distance-1 episode.
        const series = await seedSeries('Gap', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        const { episodeId: e4 } = await seedEpisode(series, 1, 4);
        await seedEngagement(e1, { watched: true });

        const rows = await candidates();

        expect(rows.map((r) => r.media_id)).toEqual([e2, e4]);
        expect(rows.map((r) => r.distance)).toEqual([0, 1]);
    });

    it('is deterministic across calls', async () => {
        const series = await seedSeries('Deterministic', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        await seedEpisode(series, 1, 2);
        await seedEpisode(series, 1, 3);
        await seedEngagement(e1, { watched: true });

        const first = await candidates();
        const second = await candidates();

        expect(first.map((r) => r.media_id)).toEqual(second.map((r) => r.media_id));
    });

    it('bounds how deep it walks into one series', async () => {
        const series = await seedSeries('Long Show', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        for (let n = 2; n <= 40; n++) await seedEpisode(series, 1, n);
        await seedEngagement(e1, { watched: true });

        const rows = await getSeriesNextUpCandidates(sql, toUserId(userId), NO_ACCESS_LIMITS, {
            maxDistancePerSeries: 5,
        });

        expect(rows).toHaveLength(5);
        expect(Math.max(...rows.map((r) => r.distance))).toBe(4);
    });
});

describe('getSeriesNextUpCandidates — frequencyMode', () => {
    it("does NOT drop a series from the pool just because it's untouched in the last 21 days", async () => {
        // The LEFT JOIN safety property: an INNER JOIN against 'frequency'
        // would silently exclude this series from 'tracked' -- indistinguishable
        // from "genuinely untracked" downstream, and in rescore that reads as
        // 'graduated' (delete). 40 days is well inside the 180-day default
        // maxAgeDays cutoff but well outside the 21-day frequency window.
        const series = await seedSeries('Cold But Tracked', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { watched: true, hoursAgo: 24 * 40 });

        const rows = await candidates();
        expect(rows.map((r) => r.media_id)).toEqual([e2]);

        const rescored = await getSeriesNextUpRescore(
            sql,
            toUserId(userId),
            [e2],
            NO_ACCESS_LIMITS,
        );
        expect(statusOf(rescored, e2)).toBe('ranked');
    });

    it("'balanced' (the default) still guarantees every series its distance-0 episode before any series' distance-1", async () => {
        // The fairness floor the 'off' contract already has, unchanged by
        // frequency: even a heavily-watched series' distance-0 row cannot
        // outrank another series' distance-0 row into a later position, and
        // no series' distance-1+ row can outrank ANY series' distance-0.
        const heavy = await seedSeries('Heavy Fairness Check', [1]);
        const light = await seedSeries('Light Fairness Check', [1]);
        const { episodeId: h1 } = await seedEpisode(heavy, 1, 1);
        const { episodeId: h2 } = await seedEpisode(heavy, 1, 2);
        await seedEpisode(heavy, 1, 3);
        const { episodeId: l1 } = await seedEpisode(light, 1, 1);
        const { episodeId: l2 } = await seedEpisode(light, 1, 2);
        await seedEpisode(light, 1, 3);
        // Heavy: two DISTINCT episodes consumed inside the 21-day window.
        await seedEngagement(h1, { watched: true, hoursAgo: 48 });
        // Light: a single engagement.
        await seedEngagement(l1, { watched: true, hoursAgo: 1 });

        const rows = await candidates();

        const distanceZeroIds = rows.filter((r) => r.distance === 0).map((r) => r.media_id);
        expect(distanceZeroIds.sort()).toEqual([h2, l2].sort());
        // No distance>=1 row precedes either distance-0 row.
        const firstNonZeroIndex = rows.findIndex((r) => r.distance > 0);
        const lastZeroIndex = rows.map((r) => r.distance).lastIndexOf(0);
        expect(firstNonZeroIndex === -1 || firstNonZeroIndex > lastZeroIndex).toBe(true);
    });

    it("'balanced' lets a heavily-watched series pull its own extra episodes ahead of a lightly-watched series' later ones, without ever reaching band 0", async () => {
        const heavy = await seedSeries('Heavy Banding', [1]);
        const light = await seedSeries('Light Banding', [1]);
        // Heavy: e1/e2 consumed, e3 the in-progress anchor (unconsumed, so
        // IT is distance 0), e4/e5/e6 the forward pool at distances 1/2/3.
        const { episodeId: hE1 } = await seedEpisode(heavy, 1, 1);
        const { episodeId: hE2 } = await seedEpisode(heavy, 1, 2);
        const { episodeId: hE3 } = await seedEpisode(heavy, 1, 3);
        const { episodeId: hE4 } = await seedEpisode(heavy, 1, 4);
        const { episodeId: hE5 } = await seedEpisode(heavy, 1, 5);
        const { episodeId: hE6 } = await seedEpisode(heavy, 1, 6);
        // Light: same shape, but only the anchor is ever engaged.
        await seedEpisode(light, 1, 1);
        await seedEpisode(light, 1, 2);
        const { episodeId: lE3 } = await seedEpisode(light, 1, 3);
        const { episodeId: lE4 } = await seedEpisode(light, 1, 4);
        const { episodeId: lE5 } = await seedEpisode(light, 1, 5);
        const { episodeId: lE6 } = await seedEpisode(light, 1, 6);

        // Heavy: e1, e2 consumed inside the 21-day window; e3 in progress
        // (the anchor, unconsumed) -> 3 distinct episodes -> freq_allowance
        // = LEAST(2, 3/3) = 1.
        await seedEngagement(hE1, { watched: true, hoursAgo: 100 });
        await seedEngagement(hE2, { watched: true, hoursAgo: 50 });
        await seedEngagement(hE3, { resumeFraction: 0.2, hoursAgo: 2 });
        // Light: only the anchor engaged -> 1 distinct episode -> freq_allowance = 0.
        await seedEngagement(lE3, { resumeFraction: 0.2, hoursAgo: 2 });

        const rows = await candidates();
        const ids = rows.map((r) => r.media_id);

        // Predicted bands: heavy distances 0/1/2/3 map to bands 0/1/1/2;
        // light distances 0/1/2/3 map to bands 0/1/2/3. Within a band,
        // distance is still major, frequency_rank breaks same-distance ties.
        expect(ids).toEqual([
            hE3, // heavy d0, band 0
            lE3, // light d0, band 0 (frequency tiebreak puts heavy first)
            hE4, // heavy d1, band 1
            lE4, // light d1, band 1
            hE5, // heavy d2, band 1 (pulled down by freq_allowance=1)
            lE5, // light d2, band 2
            hE6, // heavy d3, band 2 (pulled down by freq_allowance=1)
            lE6, // light d3, band 3
        ]);
    });

    it("'frequency_first' lets a heavily-watched series claim several episodes ahead of a barely-touched series' first", async () => {
        const heavy = await seedSeries('Frequency First Heavy', [1]);
        const light = await seedSeries('Frequency First Light', [1]);
        const { episodeId: h1 } = await seedEpisode(heavy, 1, 1);
        const { episodeId: h2 } = await seedEpisode(heavy, 1, 2);
        const { episodeId: h3 } = await seedEpisode(heavy, 1, 3);
        const { episodeId: h4 } = await seedEpisode(heavy, 1, 4);
        const { episodeId: l1 } = await seedEpisode(light, 1, 1);
        const { episodeId: l2 } = await seedEpisode(light, 1, 2);
        // Heavy: h1/h2 consumed, h3 the in-progress anchor -> forward pool
        // is h3 (d0) AND h4 (d1) -- both from ONE series.
        await seedEngagement(h1, { watched: true, hoursAgo: 100 });
        await seedEngagement(h2, { watched: true, hoursAgo: 50 });
        await seedEngagement(h3, { resumeFraction: 0.2, hoursAgo: 2 });
        // Light: a single engagement -> forward pool is l2 (d0) alone.
        await seedEngagement(l1, { watched: true, hoursAgo: 1 });

        const rows = await getSeriesNextUpCandidates(sql, toUserId(userId), NO_ACCESS_LIMITS, {
            frequencyMode: 'frequency_first',
        });
        const ids = rows.map((r) => r.media_id);

        // Heavy's WHOLE forward pool (both its d0 and its d1) outranks
        // light's single distance-0 row -- the deliberate exception
        // 'balanced' does not allow (there, light's d0 would come before
        // heavy's d1).
        expect(ids.indexOf(l2)).toBeGreaterThan(ids.indexOf(h3));
        expect(ids.indexOf(l2)).toBeGreaterThan(ids.indexOf(h4));
    });
});

describe('getSeriesNextUpCandidates — the row payload', () => {
    it('returns the duration and source height the byte estimate needs', async () => {
        const series = await seedSeries('Payload', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        await seedEpisode(series, 1, 2, { runtimeMinutes: 50, height: 720 });
        await seedEngagement(e1, { watched: true });

        const rows = await candidates();

        expect(Number(rows[0]!.duration_ms)).toBe(50 * 60 * 1000);
        expect(rows[0]!.source_height).toBe(720);
    });

    it('returns a null source_height when the file has no video stream', async () => {
        // Null must survive to TS: it is what makes the rung clamp pass a
        // request through unclamped instead of guessing.
        const series = await seedSeries('No Stream', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        await seedEpisode(series, 1, 2, { height: null });
        await seedEngagement(e1, { watched: true });

        expect((await candidates())[0]!.source_height).toBeNull();
    });

    it("always includes the row's own id in covers_media_ids", async () => {
        const series = await seedSeries('Covers', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { watched: true });

        const rows = await candidates();

        expect(rows[0]!.covers_media_ids).toEqual([e2]);
    });
});

import { createLibraryGroup } from '../../../../../tests/integration/helpers/access-boundary.js';

/**
 * Activate a non-standard ordering on a series and map episodes into it.
 *
 * `library_groups` is NOT in TEST_TABLES.all and the media TRUNCATE does not
 * reach it (the FK runs media_files -> library_groups, not the other way), so
 * group names must be unique per test.
 */
async function seedCustomOrdering(
    seriesId: string,
    orderingType: 'dvd' | 'absolute',
    mappings: Array<{ episodeId: string; season: number; episode: number }>,
): Promise<void> {
    const groupId = `og-${seriesId.slice(0, 8)}`;
    await sql`
        INSERT INTO series_episode_ordering (media_id, ordering_type, ordering_source, ordering_group_id)
        VALUES (${seriesId}::uuid, ${orderingType}, 'manual', ${groupId})
    `;
    for (const m of mappings) {
        await sql`
            INSERT INTO episode_orderings (
                series_media_id, episode_media_id, provider, provider_episode_id,
                ordering_type, ordering_group_id,
                original_season_number, original_episode_number,
                order_season_number, order_episode_number
            ) VALUES (
                ${seriesId}::uuid, ${m.episodeId}::uuid, 'tvdb', ${m.episodeId.slice(0, 8)},
                ${orderingType}, ${groupId},
                1, ${m.episode},
                ${m.season}, ${m.episode}
            )
        `;
    }
}

async function seedSeriesAgeRating(seriesId: string, ageRating: number): Promise<void> {
    await sql`UPDATE media_items SET age_rating = ${ageRating} WHERE id = ${seriesId}::uuid`;
}

describe('getSeriesNextUpCandidates — what never becomes a candidate', () => {
    it('never offers a special, even when it sits right after the anchor', async () => {
        // Season 0 is excluded on the EFFECTIVE season, matching
        // getNextUpFromDb's explicit rule. A user who finishes a
        // behind-the-scenes special should not have the pool jump to it.
        const series = await seedSeries('Specials', [0, 1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        const { episodeId: sp } = await seedEpisode(series, 0, 1);
        await seedEngagement(e1, { watched: true });

        const ids = (await candidates()).map((r) => r.media_id);

        expect(ids).toContain(e2);
        expect(ids).not.toContain(sp);
    });

    it('never anchors on a special either', async () => {
        const series = await seedSeries('Special Anchor', [0, 1]);
        const { episodeId: sp } = await seedEpisode(series, 0, 1);
        await seedEpisode(series, 1, 1);
        await seedEngagement(sp, { watched: true });

        // The ONLY engagement is on a special, so the series is not tracked at
        // all — not "tracked from S1E1".
        expect(await candidates()).toEqual([]);
    });

    it('excludes an episode with no local file, however watchable it looks', async () => {
        // A deliberate divergence from CW/NextUp, which accept a Jellyfin-only
        // episode. An encode needs media_files.file_path on disk.
        const series = await seedSeries('No File', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2, { withFile: false });
        const { episodeId: e3 } = await seedEpisode(series, 1, 3);
        await seedEngagement(e1, { watched: true });

        const ids = (await candidates()).map((r) => r.media_id);

        // Positive control AND exclusion in one assertion: an empty result
        // would satisfy `not.toContain` just as happily as a working filter.
        expect(ids).toEqual([e3]);
        expect(ids).not.toContain(e2);
    });

    it('excludes an episode whose only file is not the default', async () => {
        // `check_media_file_items_one_default` (a DEFERRABLE INITIALLY
        // DEFERRED constraint trigger on media_file_items) guarantees an
        // episode with any files always has exactly one is_default=true row —
        // and since postgres.js runs each bare `sql\`...\`` call as its own
        // implicit transaction, the deferred check still fires at the end of
        // that single INSERT. A lone non-default file (opts.nonDefaultFile on
        // its own) is therefore not a reachable DB state; the brief's literal
        // fixture 500s the seed step itself, before the query is even
        // exercised. Model the real shape instead: the episode's real content
        // sits in a SECOND, genuinely-default file, alongside an extra
        // non-default row, and assert the query follows the default pointer
        // and never surfaces the row we marked non-default.
        const series = await seedSeries('No Default File', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2, fileId: defaultFileId } = await seedEpisode(series, 1, 2);
        const nonDefaultFileId = randomUUID();
        await sql`
            INSERT INTO media_files (id, file_path, duration_seconds, is_missing, created_at, updated_at)
            VALUES (
                ${nonDefaultFileId}::uuid,
                ${`/data/tv/${e2}-extra.mkv`},
                2700,
                false,
                NOW(), NOW()
            )
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${nonDefaultFileId}::uuid, ${e2}::uuid, false)
        `;
        await seedEngagement(e1, { watched: true });

        const rows = await candidates();

        // Positive control: e2 IS a candidate, via its real default file —
        // never via the sibling row we deliberately marked non-default.
        expect(rows.map((r) => r.media_id)).toEqual([e2]);
        expect(rows[0]!.file_id).toBe(defaultFileId);
        expect(rows[0]!.file_id).not.toBe(nonDefaultFileId);
    });

    it('excludes an episode whose file is marked missing from disk', async () => {
        const series = await seedSeries('Missing File', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2, { isMissing: true });
        await seedEngagement(e1, { watched: true });

        expect((await candidates()).map((r) => r.media_id)).not.toContain(e2);
    });

    it('excludes an episode orphaned by an active custom ordering', async () => {
        // E3 is unmapped while its siblings ARE mapped: it is a leftover that
        // would pollute the ordered view, so buildUnmappedEpisodeFilterFragment
        // drops it. E1/E2 stay.
        const series = await seedSeries('Custom Ordering', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        const { episodeId: e3 } = await seedEpisode(series, 1, 3);
        await seedCustomOrdering(series.seriesId, 'dvd', [
            { episodeId: e1, season: 1, episode: 1 },
            { episodeId: e2, season: 1, episode: 2 },
        ]);
        await seedEngagement(e1, { watched: true });

        const ids = (await candidates()).map((r) => r.media_id);

        expect(ids).toEqual([e2]);
        expect(ids).not.toContain(e3);
    });

    it('orders by the CUSTOM ordering, not the stored season/episode numbers', async () => {
        const series = await seedSeries('DVD Order', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        const { episodeId: e3 } = await seedEpisode(series, 1, 3);
        // DVD order reverses the last two.
        await seedCustomOrdering(series.seriesId, 'dvd', [
            { episodeId: e1, season: 1, episode: 1 },
            { episodeId: e3, season: 1, episode: 2 },
            { episodeId: e2, season: 1, episode: 3 },
        ]);
        await seedEngagement(e1, { watched: true });

        expect((await candidates()).map((r) => r.media_id)).toEqual([e3, e2]);
    });
});

describe('getSeriesNextUpCandidates — access', () => {
    it('applies the age gate at the SERIES row', async () => {
        const series = await seedSeries('Adult Show', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        await seedEpisode(series, 1, 2);
        await seedSeriesAgeRating(series.seriesId, 18);
        await seedEngagement(e1, { watched: true });

        expect(await candidates()).not.toEqual([]);
        expect(
            await candidates({
                deniedGroupIds: null,
                ageRating: { maxAgeRating: 12, allowUnrated: false },
            }),
        ).toEqual([]);
    });

    it('applies the library gate at the DEFAULT FILE, not the series', async () => {
        // The bytes we would encode are THIS file's bytes, so THIS file's group
        // is what must be permitted — stricter than buildEpisodeLibraryFilter,
        // which tests the series' files.
        const groupId = await createLibraryGroup(sql, `denied-${randomUUID().slice(0, 8)}`);
        const series = await seedSeries('Mixed Groups', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2, { libraryGroupId: groupId });
        const { episodeId: e3 } = await seedEpisode(series, 1, 3);
        await seedEngagement(e1, { watched: true });

        const open = (await candidates()).map((r) => r.media_id);
        const narrowed = (await candidates({ deniedGroupIds: [groupId], ageRating: null })).map(
            (r) => r.media_id,
        );

        // POSITIVE CONTROL first: an empty `open` would make the assertion
        // below pass just as happily when the SQL threw as when it worked.
        expect(open).toEqual([e2, e3]);
        expect(narrowed).toEqual([e3]);
    });

    it('keeps a file with no library group at all — NULL cannot be denied', async () => {
        const groupId = await createLibraryGroup(sql, `unused-${randomUUID().slice(0, 8)}`);
        const series = await seedSeries('Ungrouped', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { watched: true });

        const rows = await candidates({ deniedGroupIds: [groupId], ageRating: null });

        expect(rows.map((r) => r.media_id)).toEqual([e2]);
    });
});

describe('getSeriesNextUpCandidates — combined multi-episode files', () => {
    it('emits ONE row for a file backing two episodes, charging the budget once', async () => {
        // Spec risk #2. One media_files row backs both halves of a double
        // episode and a rendition is keyed on file_id, so one artifact
        // satisfies both. Two rows here means the budget is double-charged and
        // the client downloads the same artifact twice under two ids.
        const series = await seedSeries('Double Episode', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2, fileId } = await seedEpisode(series, 1, 2);
        const { episodeId: e3 } = await seedEpisode(series, 1, 3, { fileId: fileId! });
        await seedEngagement(e1, { watched: true });

        const rows = await candidates();

        expect(rows).toHaveLength(1);
        expect(rows[0]!.file_id).toBe(fileId);
        expect(rows[0]!.media_id).toBe(e2);
        expect(rows[0]!.covers_media_ids).toEqual([e2, e3]);
    });

    it('reports the NEAREST covered episode as the row, in distance order', async () => {
        const series = await seedSeries('Double Episode Ordering', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2, fileId } = await seedEpisode(series, 1, 2);
        const { episodeId: e3 } = await seedEpisode(series, 1, 3, { fileId: fileId! });
        await seedEngagement(e1, { watched: true });

        const rows = await candidates();

        // The row speaks for the closest episode it covers, so the client's
        // "next up" label matches what the user is about to watch.
        expect(rows[0]!.distance).toBe(0);
        expect(rows[0]!.covers_media_ids[0]).toBe(e2);
        expect(rows[0]!.covers_media_ids[1]).toBe(e3);
    });

    it('does not merge two episodes that merely sit in the same season', async () => {
        const series = await seedSeries('Separate Files', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        await seedEpisode(series, 1, 2);
        await seedEpisode(series, 1, 3);
        await seedEngagement(e1, { watched: true });

        const rows = await candidates();

        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.covers_media_ids.length === 1)).toBe(true);
    });
});

import { getSeriesNextUpRescore } from './series-downloads.queries.js';

async function rescore(ids: string[], access = NO_ACCESS_LIMITS) {
    return getSeriesNextUpRescore(sql, toUserId(userId), ids, access);
}

function statusOf(rows: Awaited<ReturnType<typeof rescore>>, id: string): string | undefined {
    return rows.find((r) => r.media_id === id)?.status;
}

describe('getSeriesNextUpRescore — the maxAgeDays = 0 escape', () => {
    it('ranks a year-old engagement instead of graduating it', async () => {
        // The destructive half of the same bug: `graduated` is what this lane
        // spells `delete`. If 0 empties `engagement`, every id a device holds
        // comes back graduated and the device releases its whole offline
        // library — with candidates simultaneously returning nothing to
        // refill it.
        const series = await seedSeries('Uncapped Rescore', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { watched: true, hoursAgo: 24 * 365 });

        const rows = await getSeriesNextUpRescore(sql, toUserId(userId), [e2], NO_ACCESS_LIMITS, {
            maxAgeDays: 0,
        });

        expect(statusOf(rows, e2)).not.toBe('graduated');
    });
});

describe('getSeriesNextUpRescore — classification', () => {
    it('ranks episodes still ahead of the anchor, from 0, best first', async () => {
        const series = await seedSeries('Ranked', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        const { episodeId: e3 } = await seedEpisode(series, 1, 3);
        await seedEngagement(e1, { watched: true });

        const rows = await rescore([e3, e2]);

        expect(rows.filter((r) => r.status === 'ranked').map((r) => r.media_id)).toEqual([e2, e3]);
        expect(rows.find((r) => r.media_id === e2)!.rank).toBe(0);
        expect(rows.find((r) => r.media_id === e3)!.rank).toBe(1);
    });

    it('graduates an episode the user has watched', async () => {
        const series = await seedSeries('Graduate Watched', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { watched: true });
        await seedEngagement(e2, { watched: true });

        const rows = await rescore([e1, e2]);

        expect(statusOf(rows, e1)).toBe('graduated');
        expect(statusOf(rows, e2)).toBe('graduated');
        expect(rows.every((r) => r.rank === null)).toBe(true);
    });

    it('graduates an episode past the completion threshold but not one under it', async () => {
        // 45 min -> the 0.90 tier. Getting this slightly LOW deletes an episode
        // the user is still watching; that is the whole reason the threshold is
        // shared with Continue Watching rather than invented here.
        const series = await seedSeries('Threshold Graduation', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1, { runtimeMinutes: 45 });
        const { episodeId: e2 } = await seedEpisode(series, 1, 2, { runtimeMinutes: 45 });
        const { episodeId: e3 } = await seedEpisode(series, 1, 3, { runtimeMinutes: 45 });
        await seedEngagement(e1, { watched: true, hoursAgo: 5 });
        await seedEngagement(e2, { resumeFraction: 0.95, hoursAgo: 4 });
        await seedEngagement(e3, { resumeFraction: 0.85, hoursAgo: 1 });

        const rows = await rescore([e2, e3]);

        expect(statusOf(rows, e2)).toBe('graduated');
        expect(statusOf(rows, e3)).toBe('ranked');
    });

    it('graduates everything behind a REWOUND anchor, without deleting the rewatch', async () => {
        // The user finished the show, then restarted at S1E2 today. E1 is
        // deliberately left WITHOUT its own engagement row — it must graduate
        // purely because it sits behind the anchor (`ord < anchor_ord`), not
        // because it is self-consumed. Seeding e1 as watched would let
        // self-consumption mask the anchor guard entirely: the mutation check
        // in Step 6 (delete `ord < anchor_ord`) must turn e1 `ranked`, and a
        // self-consumed e1 would stay `graduated` either way, silently hiding
        // that mutant.
        //
        // E3 was watched during the PRIOR watchthrough but sits AHEAD of the
        // rewound anchor, exactly what `getSeriesNextUpCandidates`' `forward`
        // CTE offers as a pool member during a rewatch (it never filters on a
        // row's own watched state). Graduation is purely anchor-position
        // based, so E3 stays `ranked` — grading it `graduated` on its stale
        // watched flag would make the server offer it as a candidate and then
        // immediately tell the client to delete it on the very next rescore,
        // a download-then-delete loop that never resolves until the user
        // actually replays it. E2 (the anchor, unconsumed) stays ranked too.
        //
        // Graduation is not permanent — a graduated episode legitimately
        // reappears as a candidate on a later rewatch.
        const series = await seedSeries('Rewound', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        const { episodeId: e3 } = await seedEpisode(series, 1, 3);
        await seedEngagement(e3, { watched: true, hoursAgo: 400 });
        await seedEngagement(e2, { resumeFraction: 0.1, hoursAgo: 1 });

        const rows = await rescore([e1, e2, e3]);

        expect(statusOf(rows, e1)).toBe('graduated');
        expect(statusOf(rows, e2)).toBe('ranked');
        expect(statusOf(rows, e3)).toBe('ranked');
    });

    it('graduates every episode of a series that is no longer tracked', async () => {
        // The user stopped watching it and the engagement aged out. The pool
        // must release the bytes, but this is NOT `gone` — nothing is broken.
        const series = await seedSeries('Untracked', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { watched: true, hoursAgo: 24 * 365 });

        expect(statusOf(await rescore([e2]), e2)).toBe('graduated');
    });

    it('graduates every episode of a series dismissed from Continue Watching', async () => {
        const series = await seedSeries('Dismissed Rescore', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { watched: true });
        await dismissSeries(series.seriesId);

        expect(statusOf(await rescore([e2]), e2)).toBe('graduated');
    });
});

describe('getSeriesNextUpRescore — absence means gone', () => {
    it('omits an id that is not an episode in this catalog', async () => {
        const series = await seedSeries('Bogus', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        await seedEngagement(e1, { watched: true });
        const bogus = randomUUID();

        const rows = await rescore([e2, bogus]);

        // The caller turns absence into an explicit `gone` — absence must never
        // reach the client as a signal.
        expect(rows.map((r) => r.media_id)).toEqual([e2]);
    });

    it('omits an episode whose default file has disappeared', async () => {
        const series = await seedSeries('File Gone', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2, { isMissing: true });
        await seedEngagement(e1, { watched: true });

        expect(await rescore([e2])).toEqual([]);
    });

    it('omits an access-denied episode rather than graduating it', async () => {
        // `gone` and `graduated` must not be confused: returning `gone` where
        // `graduated` belongs makes an ordinary "you watched it" look like
        // library breakage, which suppresses the telemetry that would reveal
        // real breakage.
        const groupId = await createLibraryGroup(sql, `rescore-denied-${randomUUID().slice(0, 8)}`);
        const series = await seedSeries('Denied Rescore', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2, { libraryGroupId: groupId });
        await seedEngagement(e1, { watched: true });

        expect(await rescore([e2])).not.toEqual([]);
        expect(await rescore([e2], { deniedGroupIds: [groupId], ageRating: null })).toEqual([]);
    });

    it('returns an empty array for an empty cohort rather than throwing', async () => {
        expect(await rescore([])).toEqual([]);
    });

    it('produces a strict total order — no duplicate ranks', async () => {
        const series = await seedSeries('Total Order', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const ids: string[] = [];
        for (let n = 2; n <= 5; n++) ids.push((await seedEpisode(series, 1, n)).episodeId);
        await seedEngagement(e1, { watched: true });

        const ranked = (await rescore(ids)).filter((r) => r.status === 'ranked');

        expect(new Set(ranked.map((r) => r.rank)).size).toBe(ids.length);
    });
});

describe('rescore and candidates agree about ordering', () => {
    it('ranks the same ids in the same relative order both endpoints produce', async () => {
        // A testable invariant, not a coincidence: both use the literal
        // expression `ORDER BY distance ASC, series_rank ASC, media_id ASC`.
        // If they diverged, a client would reorder its pool on every rescore.
        const older = await seedSeries('Equivalence Older', [1]);
        const newer = await seedSeries('Equivalence Newer', [1]);
        const { episodeId: o1 } = await seedEpisode(older, 1, 1);
        await seedEpisode(older, 1, 2);
        await seedEpisode(older, 1, 3);
        const { episodeId: n1 } = await seedEpisode(newer, 1, 1);
        await seedEpisode(newer, 1, 2);
        await seedEngagement(o1, { watched: true, hoursAgo: 48 });
        await seedEngagement(n1, { watched: true, hoursAgo: 2 });

        const fromCandidates = (await candidates()).map((r) => r.media_id);
        const fromRescore = (await rescore([...fromCandidates].reverse()))
            .filter((r) => r.status === 'ranked')
            .sort((a, b) => a.rank! - b.rank!)
            .map((r) => r.media_id);

        expect(fromRescore).toEqual(fromCandidates);
    });

    it('reports the two halves of a combined file independently', async () => {
        // The SERVER states per-id truth. The "do not graduate until every
        // covered id has graduated" rule is the CLIENT's, built from
        // `coversMediaIds` on the candidates response — which is why that field
        // has to be complete.
        const series = await seedSeries('Combined Rescore', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2, fileId } = await seedEpisode(series, 1, 2);
        const { episodeId: e3 } = await seedEpisode(series, 1, 3, { fileId: fileId! });
        await seedEngagement(e1, { watched: true, hoursAgo: 5 });
        await seedEngagement(e2, { watched: true, hoursAgo: 1 });

        const rows = await rescore([e2, e3]);

        expect(statusOf(rows, e2)).toBe('graduated');
        expect(statusOf(rows, e3)).toBe('ranked');
    });

    it('membership property: every id candidates() offers during a rewatch comes back ranked, never graduated', async () => {
        // The regression this guards: candidates' `forward` CTE never filters
        // on a row's own watched state, so during a rewatch it offers
        // episodes ahead of the anchor that were watched during a PRIOR
        // watchthrough. If rescore's `classified` CTE graduated on that stale
        // self-consumed flag (as it used to), every one of those offered
        // episodes would be downloaded and then immediately marked for
        // deletion on the very next rescore call — a download-then-delete
        // loop that burns the box's single encoder slot forever. The whole
        // series was watched a while ago; the user just rewound to E1.
        const series = await seedSeries('Rewatch Membership', [1]);
        const eps: string[] = [];
        for (let n = 1; n <= 5; n++) eps.push((await seedEpisode(series, 1, n)).episodeId);
        // Whole series watched on a prior watchthrough...
        for (let i = 1; i < eps.length; i++) {
            await seedEngagement(eps[i]!, { watched: true, hoursAgo: 200 });
        }
        // ...then rewound: E1 re-engaged today, unconsumed.
        await seedEngagement(eps[0]!, { resumeFraction: 0.1, hoursAgo: 1 });

        const offered = (await candidates()).map((r) => r.media_id);
        expect(offered.length).toBeGreaterThan(0);

        const rescored = await rescore(offered);
        for (const id of offered) {
            expect(statusOf(rescored, id)).toBe('ranked');
        }
    });
});

describe('unpositionable episodes (NULL episode_number) — Bug 1', () => {
    it(
        'never lets an unpositionable episode become the anchor, and does not collapse ' +
            '"anchor unpositionable" into "series untracked"',
        async () => {
            // The series' ONLY engagement is on an episode with no effective
            // episode number. Under the old code this collapsed into "series
            // untracked": the series vanished from candidates entirely, and
            // its whole cohort mass-graduated in rescore (graduationPolicy is
            // `delete` for series) even though the user is actively watching
            // right now.
            const series = await seedSeries('Anchor Unpositionable', [1]);
            const { episodeId: e1 } = await seedEpisode(series, 1, 1);
            const { episodeId: eNull } = await seedEpisodeNullNumber(series, 1);
            await seedEngagement(eNull, { watched: true });

            const rows = await candidates();
            // Still visible: with the anchor unpositionable we cannot say
            // what is "ahead", so the fix fails toward preserving data
            // (offer the series' positionable episodes) instead of
            // silently dropping the whole series from the pool.
            expect(rows.map((r) => r.media_id)).toEqual([e1]);

            const rescored = await rescore([e1]);
            // Ranked, not graduated for the "series no longer tracked"
            // reason -- the series IS tracked; only its anchor's position
            // is unknown.
            expect(statusOf(rescored, e1)).toBe('ranked');
        },
    );

    it('prefers a positionable engagement over a more recent unpositionable one for the anchor', async () => {
        // E1 (positionable) was watched five hours ago; the unpositionable
        // episode was engaged an hour ago -- more recently. The anchor must
        // still land on E1: an episode with no effective episode number can
        // never define "where you are", no matter how recently it was
        // touched.
        const series = await seedSeries('Anchor Prefers Positionable', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        const { episodeId: eNull } = await seedEpisodeNullNumber(series, 1);
        await seedEngagement(e1, { watched: true, hoursAgo: 5 });
        await seedEngagement(eNull, { watched: true, hoursAgo: 1 });

        const rows = await candidates();

        expect(rows.map((r) => r.media_id)).toEqual([e2]);
    });

    it('does not graduate a cohort member that itself has no effective episode number', async () => {
        // The anchor here IS positionable and normal (E1, consumed) -- the
        // unpositionable episode is a plain COHORT MEMBER, unrelated to the
        // anchor pick. It must be retained (ranked last is fine), never
        // classified `graduated`: an episode this server cannot position
        // must never be classified in a way that gets it deleted.
        const series = await seedSeries('Cohort Member Unpositionable', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: e2 } = await seedEpisode(series, 1, 2);
        const { episodeId: eNull } = await seedEpisodeNullNumber(series, 1);
        await seedEngagement(e1, { watched: true });

        const rows = await rescore([e2, eNull]);

        expect(statusOf(rows, e2)).toBe('ranked');
        expect(statusOf(rows, eNull)).toBe('ranked');
    });

    it('still graduates a genuinely untracked series, distinguishing it from an unpositionable anchor', async () => {
        // Sanity check on the branch split: a series with NO engagement at
        // all for this user must still graduate normally in rescore -- the
        // fix must not have accidentally made every series "sticky".
        const series = await seedSeries('Genuinely Untracked', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);

        expect(statusOf(await rescore([e1]), e1)).toBe('graduated');
    });
});

describe('coversMediaIds straddling the distance boundary — Bug 3', () => {
    it('reports every covered episode even when siblings straddle MAX_DISTANCE_PER_SERIES', async () => {
        // One combined file backs both a near episode (inside the distance
        // bound) and a far one (outside it). `bounded` truncates the ROWS
        // this query returns for cost, but MAX_DISTANCE_PER_SERIES must not
        // also truncate what `covers_media_ids` reports: the client charges
        // the budget once per artifact and waits for EVERY covered episode
        // to graduate before deleting it. Losing the far sibling here would
        // let the client delete the artifact while that episode is still
        // unwatched.
        const series = await seedSeries('Straddling Combined File', [1]);
        const { episodeId: e1 } = await seedEpisode(series, 1, 1);
        const { episodeId: near, fileId } = await seedEpisode(series, 1, 2);
        // `far`'s OWN distance (2 + maxDistancePerSeries) sits past the
        // bound, but it shares `near`'s file, so the combined file's
        // covers_media_ids must still include it.
        const farEpisodeNumber = 2 + 3; // maxDistancePerSeries below is 3
        const { episodeId: far } = await seedEpisode(series, 1, farEpisodeNumber, {
            fileId: fileId!,
        });
        // Fill the gap between `near` and `far` with plain (uncombined)
        // episodes so `far`'s positional distance actually exceeds the
        // bound rather than collapsing due to a sparse sequence.
        for (let n = 3; n < farEpisodeNumber; n++) {
            await seedEpisode(series, 1, n);
        }
        await seedEngagement(e1, { watched: true });

        const rows = await getSeriesNextUpCandidates(sql, toUserId(userId), NO_ACCESS_LIMITS, {
            maxDistancePerSeries: 3,
        });

        const combinedRow = rows.find((r) => r.file_id === fileId);
        expect(combinedRow).toBeDefined();
        expect(combinedRow!.covers_media_ids).toEqual([near, far]);
    });
});
