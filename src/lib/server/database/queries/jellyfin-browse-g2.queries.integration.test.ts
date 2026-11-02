// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin `/j` user-data parity (2026-10-07 audit gaps 3, 4, 7, 15) against
 * real rows: series/season episode counts, Latest and Resume — each also under
 * a restricted access boundary, so a count never reveals an episode the user
 * cannot list.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/index.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import {
    buildFolderEpisodeCountsQuery,
    getFolderEpisodeCounts,
} from './jellyfin-folder-counts.queries.js';
import { browseMediaItems, getLatestItems, getResumeItemsPage } from './jellyfin-browse.queries.js';
import { getItemDetail } from './jellyfin-item-detail.queries.js';
import {
    buildLatestSeriesGroupsQuery,
    getLatestSeriesGroups,
} from './jellyfin-latest-groups.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';

let sql: postgres.Sql;
let userId: UserId;

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await truncateTables(sql, [
        'play_sessions',
        'playlist_items',
        'playlists',
        'user_media_flags',
        'user_media_state',
        'provider_metadata',
        'episode_orderings',
        'series_episode_ordering',
        'media_file_items',
        'media_files',
        'library_groups',
        'media_items',
        'external_ids',
    ]);
    userId = toUserId(randomUUID());
    await ensureTestUser(sql, userId);
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function libraryGroup(name: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO library_groups (name, sort_order, created_at, updated_at)
        VALUES (${name}, 1, NOW(), NOW()) RETURNING id`;
    return row.id;
}

async function attachFile(
    itemId: string,
    groupId: string | null,
    createdAt?: string,
): Promise<void> {
    const at = createdAt ?? new Date().toISOString();
    const [f] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
        VALUES (${`/g2/${itemId}.mkv`}, ${groupId}, ${at}, ${at}) RETURNING id`;
    await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
              VALUES (${f.id}::uuid, ${itemId}::uuid, true)`;
}

interface ItemSeed {
    title: string;
    type?: string;
    parentId?: string | null;
    season?: number | null;
    episode?: number | null;
    ageRating?: number | null;
    runtime?: number | null;
    /** Library group of the item's file (leaves only). */
    group?: string | null;
    /** When the item's file landed (leaves only). */
    fileAt?: string;
    /** No file at all (a leaf the scanner lost). */
    noFile?: boolean;
}

async function item(seed: ItemSeed): Promise<string> {
    const type = seed.type ?? 'movie';
    const leaf = ['movie', 'episode', 'track'].includes(type);
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, parent_id, has_files, season_number,
                                 episode_number, age_rating, runtime_seconds)
        VALUES (${seed.title}, ${type}, 'active', ${seed.parentId ?? null}, ${leaf && !seed.noFile},
                ${seed.season ?? null}, ${seed.episode ?? null}, ${seed.ageRating ?? null},
                ${seed.runtime ?? 2700})
        RETURNING id`;
    if (leaf && !seed.noFile) await attachFile(row.id, seed.group ?? null, seed.fileAt);
    return row.id;
}

/** Series → seasons → file-backed episodes. */
async function series(
    title: string,
    seasons: number,
    perSeason: number,
    opts: { group?: string | null; ageRating?: number | null; fileAt?: string } = {},
): Promise<{ seriesId: string; seasonIds: string[]; episodeIds: string[][] }> {
    const seriesId = await item({ title, type: 'tv', ageRating: opts.ageRating ?? null });
    const seasonIds: string[] = [];
    const episodeIds: string[][] = [];
    for (let s = 1; s <= seasons; s++) {
        const seasonId = await item({
            title: `Season ${s}`,
            type: 'season',
            parentId: seriesId,
            season: s,
        });
        seasonIds.push(seasonId);
        const eps: string[] = [];
        for (let e = 1; e <= perSeason; e++) {
            eps.push(
                await item({
                    title: `${title} ${s}x${e}`,
                    type: 'episode',
                    parentId: seasonId,
                    season: s,
                    episode: e,
                    group: opts.group ?? null,
                    fileAt: opts.fileAt,
                }),
            );
        }
        episodeIds.push(eps);
    }
    return { seriesId, seasonIds, episodeIds };
}

async function watched(mediaId: string, at?: string): Promise<void> {
    const when = at ?? new Date().toISOString();
    await sql`
        INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                                      watch_count, last_watched_at, last_event_at, last_event_source)
        VALUES (${userId}::uuid, ${mediaId}::uuid, true, 0, 2700000, 1, ${when}, ${when}, 'lumastra')`;
}

// ---------------------------------------------------------------------------
// Series / season counts (gap 3)
// ---------------------------------------------------------------------------

describe('getFolderEpisodeCounts', () => {
    it('counts seasons, episodes and watched episodes per series and season in one call', async () => {
        const a = await series('Alpha', 2, 3);
        const b = await series('Beta', 1, 2);
        await watched(a.episodeIds[0][0]);
        await watched(a.episodeIds[0][1]);
        await watched(a.episodeIds[0][2]);
        await watched(a.episodeIds[1][0]);
        await watched(b.episodeIds[0][0]);
        await watched(b.episodeIds[0][1]);

        const counts = await getFolderEpisodeCounts(sql, {
            folderIds: [a.seriesId, b.seriesId, a.seasonIds[0], a.seasonIds[1]],
            userId,
            access: unrestrictedAccess(),
        });

        expect(counts.get(a.seriesId)).toEqual({ childCount: 2, totalCount: 6, playedCount: 4 });
        expect(counts.get(b.seriesId)).toEqual({ childCount: 1, totalCount: 2, playedCount: 2 });
        expect(counts.get(a.seasonIds[0])).toEqual({
            childCount: 3,
            totalCount: 3,
            playedCount: 3,
        });
        expect(counts.get(a.seasonIds[1])).toEqual({
            childCount: 3,
            totalCount: 3,
            playedCount: 1,
        });
    });

    it("another user's watched rows never count", async () => {
        const a = await series('Alpha', 1, 2);
        const other = toUserId(randomUUID());
        await ensureTestUser(sql, other);
        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched, last_event_source)
                  VALUES (${other}::uuid, ${a.episodeIds[0][0]}::uuid, true, 'lumastra')`;
        const counts = await getFolderEpisodeCounts(sql, {
            folderIds: [a.seriesId],
            userId,
            access: unrestrictedAccess(),
        });
        expect(counts.get(a.seriesId)?.playedCount).toBe(0);
    });

    it('skips episodes without files and ignores non-folder ids', async () => {
        const a = await series('Alpha', 1, 2);
        await item({
            title: 'Luma',
            type: 'episode',
            parentId: a.seasonIds[0],
            season: 1,
            episode: 3,
            noFile: true,
        });
        const movie = await item({ title: 'Movie' });
        const counts = await getFolderEpisodeCounts(sql, {
            folderIds: [a.seriesId, movie],
            userId,
            access: unrestrictedAccess(),
        });
        expect(counts.get(a.seriesId)?.totalCount).toBe(2);
        expect(counts.has(movie)).toBe(false);
    });

    it('counts only episodes in libraries the user may see', async () => {
        const allowed = await libraryGroup('Allowed');
        const denied = await libraryGroup('Denied');
        const a = await series('Alpha', 1, 1, { group: allowed });
        // A second season whose episodes live in a library the user is denied.
        const hiddenSeason = await item({
            title: 'Season 2',
            type: 'season',
            parentId: a.seriesId,
            season: 2,
        });
        const hiddenEp = await item({
            title: 'Hidden',
            type: 'episode',
            parentId: hiddenSeason,
            season: 2,
            episode: 1,
            group: denied,
        });
        await watched(hiddenEp);

        const access = restrictedAccess({
            deniedGroupIds: [denied],
            maxAgeRating: null,
            allowUnrated: true,
        });
        const restricted = await getFolderEpisodeCounts(sql, {
            folderIds: [a.seriesId, hiddenSeason],
            userId,
            access,
        });
        expect(restricted.get(a.seriesId)).toEqual({
            childCount: 1,
            totalCount: 1,
            playedCount: 0,
        });
        expect(restricted.get(hiddenSeason)).toEqual({
            childCount: 0,
            totalCount: 0,
            playedCount: 0,
        });

        const open = await getFolderEpisodeCounts(sql, {
            folderIds: [a.seriesId],
            userId,
            access: unrestrictedAccess(),
        });
        expect(open.get(a.seriesId)).toEqual({ childCount: 2, totalCount: 2, playedCount: 1 });
    });

    it("applies the age limit to the series' rating (age policy belongs to the series)", async () => {
        const kids = await series('Kids', 1, 2, { ageRating: 6 });
        // An episode's own rating is not policy (canonical series-episode-counts rule).
        await sql`UPDATE media_items SET age_rating = 16 WHERE id = ${kids.episodeIds[0][1]}::uuid`;
        const adult = await series('Adult', 1, 2, { ageRating: 18 });

        const access = restrictedAccess({
            deniedGroupIds: [],
            maxAgeRating: 12,
            allowUnrated: false,
        });
        const counts = await getFolderEpisodeCounts(sql, {
            folderIds: [kids.seriesId, adult.seriesId],
            userId,
            access,
        });
        expect(counts.get(kids.seriesId)?.totalCount).toBe(2);
        expect(counts.get(adult.seriesId)?.totalCount).toBe(0);
    });

    it('skips episodes of a season that is not active', async () => {
        const a = await series('Alpha', 2, 1);
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${a.seasonIds[1]}::uuid`;
        const counts = await getFolderEpisodeCounts(sql, {
            folderIds: [a.seriesId, a.seasonIds[1]],
            userId,
            access: unrestrictedAccess(),
        });
        expect(counts.get(a.seriesId)).toEqual({ childCount: 1, totalCount: 1, playedCount: 0 });
        expect(counts.get(a.seasonIds[1])?.totalCount).toBe(0);
    });

    it('denyAll counts nothing', async () => {
        const a = await series('Alpha', 1, 2);
        const counts = await getFolderEpisodeCounts(sql, {
            folderIds: [a.seriesId],
            userId,
            access: denyAllAccess(),
        });
        expect(counts.get(a.seriesId)).toEqual({ childCount: 0, totalCount: 0, playedCount: 0 });
    });

    it('a 100-series page is one query that walks the parent index (EXPLAIN)', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 100; i++) ids.push((await series(`S${i}`, 2, 3)).seriesId);
        await sql`ANALYZE media_items`;
        await sql`ANALYZE media_file_items`;
        await sql`ANALYZE user_media_state`;

        const started = Date.now();
        const counts = await getFolderEpisodeCounts(sql, {
            folderIds: ids,
            userId,
            access: restrictedAccess({
                deniedGroupIds: [randomUUID()],
                maxAgeRating: 16,
                allowUnrated: true,
            }),
        });
        const elapsed = Date.now() - started;
        expect(counts.size).toBe(100);
        expect([...counts.values()].every((c) => c.totalCount === 6)).toBe(true);

        // Record the plan (EXPLAIN ANALYZE) for the perf sanity check; the
        // parent walk must be an index probe, never a scan of media_items.
        const plan = await explainFolderCounts(ids);
        console.log(`[g2] getFolderEpisodeCounts 100 series: ${elapsed} ms\n${plan}`);
        expect(plan).toMatch(/idx_media_items_parent_id|Index (Only )?Scan.*media_items/);
    });

    it('a wide page aggregates the episode walk once in a materialized CTE, also under forced nested loops', async () => {
        // Prod 2026-10: a 980-series /j page took 89 s because, with the folder
        // list estimated at ~1 row, the planner chose a nested loop and re-ran
        // the whole episode walk for every folder (loops = folders). Hash and
        // merge joins are switched off here so a regression to that shape shows
        // up whatever the estimates are on this test database.
        const ids: string[] = [];
        for (let i = 0; i < 150; i++) ids.push((await series(`W${i}`, 1, 2)).seriesId);

        const counts = await getFolderEpisodeCounts(sql, {
            folderIds: ids,
            userId,
            access: unrestrictedAccess(),
        });
        expect(counts.size).toBe(150);
        expect([...counts.values()].every((c) => c.totalCount === 2 && c.childCount === 1)).toBe(
            true,
        );

        const plan = await sql.begin(async (tx) => {
            await tx`SET LOCAL enable_hashjoin = off`;
            await tx`SET LOCAL enable_mergejoin = off`;
            const query = buildFolderEpisodeCountsQuery(tx as unknown as postgres.Sql, {
                folderIds: ids,
                userId,
                access: unrestrictedAccess(),
            });
            const rows = await tx<
                { 'QUERY PLAN': string }[]
            >`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${query}`;
            return rows.map((r) => r['QUERY PLAN']).join('\n');
        });
        // The prod plan re-ran the whole walk once per folder because the walk
        // sat under the folder join. The fix aggregates in a MATERIALIZED CTE,
        // which Postgres evaluates at most once whatever the estimates; the test
        // database never chooses the bad plan for the old query, so the guard
        // is on that structure: the aggregate exists as a CTE and runs once.
        const agg = plan.match(/CTE agg\n\s+->\s+\w[^\n]*loops=(\d+)\)/);
        expect(agg, plan).not.toBeNull();
        expect(Number(agg![1])).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Latest (gap 4)
// ---------------------------------------------------------------------------

async function fileLandedAt(itemIds: string[], at: string): Promise<void> {
    await sql`UPDATE media_files SET created_at = ${at}
              WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ANY(${itemIds}::uuid[]))`;
}

const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

describe('getLatestItems: IncludeItemTypes and IsPlayed', () => {
    it('ranks only the requested types and drops watched movies / episodes for IsPlayed=false', async () => {
        const seen = await item({ title: 'Seen', fileAt: ago(1) });
        const fresh = await item({ title: 'Fresh', fileAt: ago(2) });
        const show = await series('Show', 1, 2, { fileAt: ago(3) });
        await watched(seen);
        await watched(show.episodeIds[0][0]);

        const base = {
            limit: 10,
            parentId: null,
            groupItems: false,
            access: unrestrictedAccess(),
            userId,
        };
        const unplayed = await getLatestItems(sql, {
            ...base,
            mediaTypes: ['movie', 'episode'],
            isPlayed: false,
        });
        expect(unplayed.map((r) => r.id)).toEqual([fresh, show.episodeIds[0][1]]);

        const played = await getLatestItems(sql, {
            ...base,
            mediaTypes: ['movie', 'episode'],
            isPlayed: true,
        });
        expect(played.map((r) => r.id)).toEqual([seen, show.episodeIds[0][0]]);

        const moviesOnly = await getLatestItems(sql, { ...base, mediaTypes: ['movie'] });
        expect(moviesOnly.map((r) => r.id)).toEqual([seen, fresh]);
    });

    it('a series is unplayed while one of its episodes is, played once one is watched', async () => {
        const done = await series('Done', 1, 2, { fileAt: ago(1) });
        const half = await series('Half', 1, 2, { fileAt: ago(2) });
        await watched(done.episodeIds[0][0]);
        await watched(done.episodeIds[0][1]);
        await watched(half.episodeIds[0][0]);

        const base = {
            limit: 10,
            parentId: null,
            groupItems: true,
            access: unrestrictedAccess(),
            userId,
            mediaTypes: ['tv'],
        };
        const unplayed = await getLatestItems(sql, { ...base, isPlayed: false });
        expect(unplayed.map((r) => r.id)).toEqual([half.seriesId]);
        const played = await getLatestItems(sql, { ...base, isPlayed: true });
        expect(played.map((r) => r.id)).toEqual([done.seriesId, half.seriesId]);
    });
});

describe('getLatestSeriesGroups (GroupItems=true)', () => {
    it("groups the episodes that landed within 24 h of the series' newest one", async () => {
        const show = await series('Show', 2, 3, { fileAt: ago(24 * 10) });
        // Season 2 landed now (three episodes, one of them 20 h earlier).
        await fileLandedAt([show.episodeIds[1][0], show.episodeIds[1][1]], ago(1));
        await fileLandedAt([show.episodeIds[1][2]], ago(21));
        const single = await series('Single', 1, 3, { fileAt: ago(24 * 10) });
        await fileLandedAt([single.episodeIds[0][2]], ago(2));

        const groups = await getLatestSeriesGroups(sql, {
            seriesIds: [show.seriesId, single.seriesId],
            userId,
            access: unrestrictedAccess(),
        });
        expect(groups.get(show.seriesId)).toMatchObject({
            recentCount: 3,
            seasonIds: [show.seasonIds[1]],
        });
        expect([show.episodeIds[1][0], show.episodeIds[1][1]]).toContain(
            groups.get(show.seriesId)?.newestEpisodeId,
        );
        expect(groups.get(single.seriesId)).toMatchObject({
            recentCount: 1,
            seasonIds: [single.seasonIds[0]],
            newestEpisodeId: single.episodeIds[0][2],
        });
    });

    it('the global cutoff skips files older than it (EXPLAIN recorded)', async () => {
        const show = await series('Show', 1, 3, { fileAt: ago(24 * 30) });
        await fileLandedAt([show.episodeIds[0][2]], ago(1));
        const old = await series('Old', 1, 2, { fileAt: ago(24 * 30) });
        const base = {
            seriesIds: [show.seriesId, old.seriesId],
            userId,
            access: restrictedAccess({
                deniedGroupIds: [randomUUID()],
                maxAgeRating: 16,
                allowUnrated: true,
            }),
            isPlayed: false,
        };
        const addedSince = new Date(Date.now() - 48 * HOUR);
        const groups = await getLatestSeriesGroups(sql, { ...base, addedSince });
        expect(groups.get(show.seriesId)).toMatchObject({ recentCount: 1 });
        expect(groups.has(old.seriesId)).toBe(false);
        // Without the cutoff the old series still groups (every file is read).
        expect((await getLatestSeriesGroups(sql, base)).has(old.seriesId)).toBe(true);

        for (let i = 0; i < 100; i++) await series(`Bulk${i}`, 2, 3, { fileAt: ago(24 * 30) });
        await sql`ANALYZE media_files`;
        await sql`ANALYZE media_items`;
        const query = buildLatestSeriesGroupsQuery(sql, { ...base, addedSince });
        const plan = await sql<
            { 'QUERY PLAN': string }[]
        >`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${query}`;
        console.log(
            `[g2] getLatestSeriesGroups with cutoff\n${plan.map((r) => r['QUERY PLAN']).join('\n')}`,
        );
    });

    it('IsPlayed=false groups only unwatched episodes; denied libraries never count', async () => {
        const allowed = await libraryGroup('Allowed');
        const denied = await libraryGroup('Denied');
        const show = await series('Show', 1, 3, { group: allowed, fileAt: ago(1) });
        await watched(show.episodeIds[0][0]);
        const hidden = await item({
            title: 'Hidden',
            type: 'episode',
            parentId: show.seasonIds[0],
            season: 1,
            episode: 4,
            group: denied,
            fileAt: ago(0.5),
        });

        const access = restrictedAccess({
            deniedGroupIds: [denied],
            maxAgeRating: null,
            allowUnrated: true,
        });
        const groups = await getLatestSeriesGroups(sql, {
            seriesIds: [show.seriesId],
            userId,
            access,
            isPlayed: false,
        });
        const g = groups.get(show.seriesId);
        expect(g?.recentCount).toBe(2);
        expect(g?.newestEpisodeId).not.toBe(hidden);
        expect(
            await getLatestSeriesGroups(sql, {
                seriesIds: [show.seriesId],
                userId,
                access: denyAllAccess(),
            }),
        ).toEqual(new Map());
    });
});

// ---------------------------------------------------------------------------
// Resume (gap 7)
// ---------------------------------------------------------------------------

async function inProgress(mediaId: string, at: string, positionMs = 600_000): Promise<void> {
    await sql`
        INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                                      last_watched_at, last_event_at, last_event_source)
        VALUES (${userId}::uuid, ${mediaId}::uuid, false, ${positionMs}, 2700000, ${at}, ${at}, 'lumastra')`;
}

describe('getResumeItemsPage: MediaTypes, ParentId, SearchTerm, paging', () => {
    it('an Audio row gets tracks only, a Video row never a track', async () => {
        const movie = await item({ title: 'Dawn' });
        const track = await item({ title: 'Song', type: 'track' });
        await inProgress(movie, ago(1));
        await inProgress(track, ago(2));

        const audio = await getResumeItemsPage(sql, userId, 10, unrestrictedAccess(), {
            mediaTypes: ['track'],
        });
        expect(audio.rows.map((r) => r.id)).toEqual([track]);
        const video = await getResumeItemsPage(sql, userId, 10, unrestrictedAccess(), {
            mediaTypes: ['movie', 'episode'],
        });
        expect(video.rows.map((r) => r.id)).toEqual([movie]);
        const none = await getResumeItemsPage(sql, userId, 10, unrestrictedAccess(), {
            mediaTypes: [],
        });
        expect(none).toMatchObject({ totalCount: 0 });
    });

    it('ParentId narrows to a library group or a series', async () => {
        const kids = await libraryGroup('Kids');
        const films = await libraryGroup('Films');
        const show = await series('Show', 1, 2, { group: kids });
        const movie = await item({ title: 'Dawn', group: films });
        await inProgress(show.episodeIds[0][1], ago(1));
        await inProgress(movie, ago(2));

        const page = (parentId: string) =>
            getResumeItemsPage(sql, userId, 10, unrestrictedAccess(), {
                mediaTypes: ['movie', 'episode'],
                parentId,
            });
        expect((await page(kids)).rows.map((r) => r.id)).toEqual([show.episodeIds[0][1]]);
        expect((await page(films)).rows.map((r) => r.id)).toEqual([movie]);
        expect((await page(show.seriesId)).rows.map((r) => r.id)).toEqual([show.episodeIds[0][1]]);
        // A non-UUID ParentId (a synced Jellyfin library id) never breaks the query.
        expect((await page('not-a-uuid')).rows).toEqual([]);
    });

    it("SearchTerm matches the title or the episode's series title", async () => {
        const show = await series('Starhaven', 1, 1);
        const movie = await item({ title: 'Dawn 100%' });
        await inProgress(show.episodeIds[0][0], ago(1));
        await inProgress(movie, ago(2));
        const search = async (term: string) =>
            (
                await getResumeItemsPage(sql, userId, 10, unrestrictedAccess(), {
                    mediaTypes: ['movie', 'episode'],
                    searchTerm: term,
                })
            ).rows.map((r) => r.id);
        expect(await search('starh')).toEqual([show.episodeIds[0][0]]);
        expect(await search('100%')).toEqual([movie]);
        expect(await search('_')).toEqual([]);
    });

    it('pages with StartIndex and reports the total, also past the end', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const id = await item({ title: `M${i}` });
            await inProgress(id, ago(i + 1));
            ids.push(id);
        }
        const p2 = await getResumeItemsPage(sql, userId, 2, unrestrictedAccess(), {
            mediaTypes: ['movie'],
            startIndex: 2,
        });
        expect(p2.rows.map((r) => r.id)).toEqual(ids.slice(2, 4));
        expect(p2.totalCount).toBe(5);
        const past = await getResumeItemsPage(sql, userId, 2, unrestrictedAccess(), {
            mediaTypes: ['movie'],
            startIndex: 9,
        });
        expect(past).toMatchObject({ totalCount: 5 });
        expect(past.rows).toHaveLength(0);
    });

    it('a denied library is never resumed', async () => {
        const denied = await libraryGroup('Denied');
        const movie = await item({ title: 'Hidden', group: denied });
        await inProgress(movie, ago(1));
        const access = restrictedAccess({
            deniedGroupIds: [denied],
            maxAgeRating: null,
            allowUnrated: true,
        });
        const page = await getResumeItemsPage(sql, userId, 10, access, { mediaTypes: ['movie'] });
        expect(page).toMatchObject({ totalCount: 0 });
    });
});

// ---------------------------------------------------------------------------
// LastPlayedDate (gap 15)
// ---------------------------------------------------------------------------

describe('last_played_at (UserData.LastPlayedDate)', () => {
    it('is the newer of the last completion and the last playback event, only for played rows', async () => {
        const done = await item({ title: 'Done' });
        const going = await item({ title: 'Going' });
        const unmarked = await item({ title: 'Unmarked' });
        const never = await item({ title: 'Never' });
        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms, watch_count,
                                                last_watched_at, last_event_at, last_event_source)
                  VALUES (${userId}::uuid, ${done}::uuid, true, 0, 1, '2026-09-01T10:00:00Z', '2026-09-03T10:00:00Z', 'lumastra'),
                         (${userId}::uuid, ${going}::uuid, false, 600000, 0, NULL, '2026-09-05T10:00:00Z', 'lumastra'),
                         (${userId}::uuid, ${unmarked}::uuid, false, 0, 0, NULL, '2026-09-06T10:00:00Z', 'lumastra')`;

        const { rows } = await browseMediaItems(sql, {
            mediaTypes: ['movie'],
            parentId: null,
            searchTerm: null,
            genres: [],
            years: [],
            nameStartsWith: null,
            isFavoriteFilter: false,
            isPlayedFilter: false,
            isUnplayedFilter: false,
            enableUserData: true,
            userId,
            idList: [],
            sortBy: 'SortName',
            sortOrder: 'Ascending',
            limit: 10,
            startIndex: 0,
            access: unrestrictedAccess(),
        });
        const at = new Map(
            rows.map((r) => [
                r.id as string,
                r.last_played_at ? new Date(r.last_played_at as string).toISOString() : null,
            ]),
        );
        expect(at.get(done)).toBe('2026-09-03T10:00:00.000Z');
        expect(at.get(going)).toBe('2026-09-05T10:00:00.000Z');
        expect(at.get(unmarked)).toBeNull();
        expect(at.get(never)).toBeNull();

        const detail = await getItemDetail(sql, done, userId);
        expect(new Date(detail!.last_played_at as string).toISOString()).toBe(
            '2026-09-03T10:00:00.000Z',
        );
    });
});

async function explainFolderCounts(ids: string[]): Promise<string> {
    const query = buildFolderEpisodeCountsQuery(sql, {
        folderIds: ids,
        userId,
        access: restrictedAccess({
            deniedGroupIds: [randomUUID()],
            maxAgeRating: 16,
            allowUnrated: true,
        }),
    });
    const rows = await sql<
        { 'QUERY PLAN': string }[]
    >`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${query}`;
    return rows.map((r) => r['QUERY PLAN']).join('\n');
}
