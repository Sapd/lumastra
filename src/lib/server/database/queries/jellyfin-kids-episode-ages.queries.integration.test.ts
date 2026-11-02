// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Age-limited profiles on `/j` (cloud-parity brief 13): seasons and episodes
 * never get `age_rating` written, so their age policy belongs to the SERIES.
 * A kid profile (`maxAgeRating` set, `allowUnrated=false`) used to see
 * "N unplayed" on a series card (counts judge the series) but an empty episode
 * list, and no episodes in Next Up / Latest / Resume or on playback (those
 * judged the episode row's NULL rating). Every path below must agree with the
 * folder counts; an above-limit series must show no episodes anywhere.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/index.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import type { UserContext } from '$lib/server/types.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getFolderEpisodeCounts } from './jellyfin-folder-counts.queries.js';
import { getLatestSeriesGroups } from './jellyfin-latest-groups.queries.js';
import { getDistinctYears } from './jellyfin-years.queries.js';
import {
    browseMediaItems,
    getLatestItems,
    getNextUpEpisodes,
    getResumeItems,
    getSeriesEpisodes,
    getSeriesSeasons,
    type BrowseItemsOptions,
} from './jellyfin-browse.queries.js';
import { searchMedia } from './search.queries.js';
import { restrictedAccess } from './builders/media-access-boundary.js';
import { filterAccessibleMediaIds } from '$lib/server/utils/media-access-batch.js';

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, config: { ...actual.config, UNRATED_CONTENT_VISIBLE: false } };
});

let sql: postgres.Sql;
let userId: UserId;

/** The kid profile: up to 12, unrated content hidden. */
const KIDS = restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: false });

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await truncateTables(sql, [
        'play_sessions',
        'user_media_state',
        'provider_metadata',
        'episode_orderings',
        'series_episode_ordering',
        'media_file_items',
        'media_files',
        'media_items',
    ]);
    userId = toUserId(randomUUID());
    await ensureTestUser(sql, userId);
});

async function item(
    title: string,
    type: string,
    parentId: string | null,
    extra: { season?: number; episode?: number; ageRating?: number | null } = {},
): Promise<string> {
    const leaf = type === 'episode';
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, parent_id, has_files, season_number,
                                 episode_number, age_rating, runtime_seconds, year)
        VALUES (${title}, ${type}, 'active', ${parentId}, ${leaf}, ${extra.season ?? null},
                ${extra.episode ?? null}, ${extra.ageRating ?? null}, 2700, 2020)
        RETURNING id`;
    if (leaf) {
        const [f] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, created_at, updated_at)
            VALUES (${`/kids/${row.id}.mkv`}, NOW(), NOW()) RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
                  VALUES (${f.id}::uuid, ${row.id}::uuid, true)`;
    }
    return row.id;
}

/** Series rated `ageRating` → one season → three episodes with NULL `age_rating`. */
async function series(
    title: string,
    ageRating: number,
): Promise<{ seriesId: string; seasonId: string; episodeIds: string[] }> {
    const seriesId = await item(title, 'tv', null, { ageRating });
    const seasonId = await item('Season 1', 'season', seriesId, { season: 1 });
    const episodeIds: string[] = [];
    for (let e = 1; e <= 3; e++) {
        episodeIds.push(
            await item(`${title} 1x${e}`, 'episode', seasonId, { season: 1, episode: e }),
        );
    }
    return { seriesId, seasonId, episodeIds };
}

async function watched(mediaId: string): Promise<void> {
    await sql`
        INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                                      watch_count, last_watched_at, last_event_at, last_event_source)
        VALUES (${userId}::uuid, ${mediaId}::uuid, true, 0, 2700000, 1, NOW(), NOW(), 'lumastra')`;
}

async function inProgress(mediaId: string): Promise<void> {
    await sql`
        INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                                      watch_count, last_watched_at, last_event_at, last_event_source)
        VALUES (${userId}::uuid, ${mediaId}::uuid, false, 600000, 2700000, 0, NOW(), NOW(), 'lumastra')`;
}

function browseOptions(overrides: Partial<BrowseItemsOptions>): BrowseItemsOptions {
    return {
        mediaTypes: [],
        parentId: null,
        searchTerm: null,
        genres: [],
        years: [],
        nameStartsWith: null,
        isFavoriteFilter: false,
        isPlayedFilter: false,
        isUnplayedFilter: false,
        enableUserData: false,
        userId,
        idList: [],
        sortBy: 'SortName',
        sortOrder: 'Ascending',
        limit: 50,
        startIndex: 0,
        access: KIDS,
        ...overrides,
    };
}

function kidUser(): UserContext {
    return {
        username: 'kid',
        userId,
        userGroups: [],
        isAdmin: false,
        isAgeRestricted: true,
        maxAgeRating: 12,
    } as unknown as UserContext;
}

const ids = (rows: readonly postgres.Row[]): string[] => rows.map((r) => r.id as string);

describe('age-limited profile on /j: episodes follow the series rating', () => {
    it('Shows/{id}/Episodes and Seasons list a within-limit series and match its counts', async () => {
        const kids = await series('Kids', 6);
        await watched(kids.episodeIds[0]);

        const counts = await getFolderEpisodeCounts(sql, {
            folderIds: [kids.seriesId, kids.seasonId],
            userId,
            access: KIDS,
        });
        expect(counts.get(kids.seriesId)).toEqual({
            childCount: 1,
            totalCount: 3,
            playedCount: 1,
        });

        const episodes = await getSeriesEpisodes(sql, {
            seriesId: kids.seriesId,
            seasonId: null,
            seasonNumber: null,
            enableUserData: true,
            userId,
            limit: 100,
            startIndex: 0,
            access: KIDS,
        });
        expect(ids(episodes)).toEqual(kids.episodeIds);
        expect(episodes.filter((r) => !r.is_watched)).toHaveLength(
            counts.get(kids.seriesId)!.totalCount - counts.get(kids.seriesId)!.playedCount,
        );

        const seasons = await getSeriesSeasons(sql, {
            seriesId: kids.seriesId,
            enableUserData: false,
            userId,
            access: KIDS,
        });
        expect(ids(seasons)).toEqual([kids.seasonId]);
    });

    it('Items (episodes by type, by season parent), search and Years include them', async () => {
        const kids = await series('Kids', 6);

        const byType = await browseMediaItems(
            sql,
            browseOptions({ mediaTypes: ['episode'], recursive: true }),
        );
        expect(ids(byType.rows).sort()).toEqual([...kids.episodeIds].sort());
        expect(byType.totalCount).toBe(3);

        const bySeason = await browseMediaItems(sql, browseOptions({ parentId: kids.seasonId }));
        expect(ids(bySeason.rows).sort()).toEqual([...kids.episodeIds].sort());

        const bySeries = await browseMediaItems(sql, browseOptions({ parentId: kids.seriesId }));
        expect(ids(bySeries.rows)).toEqual([kids.seasonId]);

        const years = await getDistinctYears(sql, {
            parentId: null,
            mediaTypes: ['episode'],
            excludeMediaTypes: [],
            access: KIDS,
        });
        expect(years).toEqual([{ year: 2020, itemCount: 3 }]);

        // Items?SearchTerm / Search/Hints.
        const found = await searchMedia(sql, 'Kids', KIDS, {
            mediaTypes: ['episode'],
            fileBackedOnly: true,
        });
        expect(found.map((r) => r.internal_id).sort()).toEqual([...kids.episodeIds].sort());
    });

    it('batch access filtering (continue-watching rail) admits the episodes', async () => {
        const kids = await series('Kids', 6);
        const adult = await series('Adult', 18);
        const allowed = await filterAccessibleMediaIds(
            sql,
            [...kids.episodeIds, kids.seasonId, ...adult.episodeIds, adult.seasonId],
            KIDS,
        );
        expect([...allowed].sort()).toEqual([...kids.episodeIds, kids.seasonId].sort());
    });

    it('an episode filed directly under its series takes the series rating', async () => {
        const kidsId = await item('Flat Kids', 'tv', null, { ageRating: 6 });
        const kidsEp = await item('Flat Kids 1', 'episode', kidsId, { season: 1, episode: 1 });
        const adultId = await item('Flat Adult', 'tv', null, { ageRating: 18 });
        const adultEp = await item('Flat Adult 1', 'episode', adultId, { season: 1, episode: 1 });

        const byType = await browseMediaItems(
            sql,
            browseOptions({ mediaTypes: ['episode'], recursive: true }),
        );
        expect(ids(byType.rows)).toEqual([kidsEp]);

        const user = kidUser();
        expect(await checkMediaAccess(sql, kidsEp, user)).toBe(true);
        expect(await checkMediaAccess(sql, adultEp, user)).toBe(false);
    });

    it('NextUp, Latest (flat and grouped) and Resume include them', async () => {
        const kids = await series('Kids', 6);
        await watched(kids.episodeIds[0]);
        await inProgress(kids.episodeIds[2]);

        const nextUp = await getNextUpEpisodes(sql, userId, 20, KIDS);
        expect(ids(nextUp)).toEqual([kids.episodeIds[1]]);

        const flat = await getLatestItems(sql, {
            limit: 20,
            parentId: null,
            groupItems: false,
            access: KIDS,
            mediaTypes: ['episode'],
        });
        expect(ids(flat).sort()).toEqual([...kids.episodeIds].sort());

        const grouped = await getLatestItems(sql, {
            limit: 20,
            parentId: null,
            groupItems: true,
            access: KIDS,
        });
        expect(ids(grouped)).toEqual([kids.seriesId]);
        const groups = await getLatestSeriesGroups(sql, {
            seriesIds: [kids.seriesId],
            userId,
            access: KIDS,
        });
        expect(groups.get(kids.seriesId)?.recentCount).toBe(3);

        const resume = await getResumeItems(sql, userId, 20, KIDS);
        expect(ids(resume)).toEqual([kids.episodeIds[2]]);
    });

    it('the age gate (playback, item detail) admits the episode and season', async () => {
        const kids = await series('Kids', 6);
        const user = kidUser();
        expect(await checkMediaAccess(sql, kids.episodeIds[0], user)).toBe(true);
        expect(await checkMediaAccess(sql, kids.seasonId, user)).toBe(true);
        expect(await checkMediaAccess(sql, kids.seriesId, user)).toBe(true);
    });

    it('a series above the limit shows no episodes anywhere', async () => {
        const adult = await series('Adult', 18);
        await watched(adult.episodeIds[0]);
        await inProgress(adult.episodeIds[2]);

        const counts = await getFolderEpisodeCounts(sql, {
            folderIds: [adult.seriesId],
            userId,
            access: KIDS,
        });
        expect(counts.get(adult.seriesId)?.totalCount ?? 0).toBe(0);

        expect(
            await getSeriesEpisodes(sql, {
                seriesId: adult.seriesId,
                seasonId: null,
                seasonNumber: null,
                enableUserData: false,
                userId,
                limit: 100,
                startIndex: 0,
                access: KIDS,
            }),
        ).toHaveLength(0);
        expect(
            await getSeriesSeasons(sql, {
                seriesId: adult.seriesId,
                enableUserData: false,
                userId,
                access: KIDS,
            }),
        ).toHaveLength(0);
        expect(
            (
                await browseMediaItems(
                    sql,
                    browseOptions({ mediaTypes: ['episode'], recursive: true }),
                )
            ).rows,
        ).toHaveLength(0);
        expect(
            (await browseMediaItems(sql, browseOptions({ parentId: adult.seasonId }))).rows,
        ).toHaveLength(0);
        expect(
            await getDistinctYears(sql, {
                parentId: null,
                mediaTypes: ['episode'],
                excludeMediaTypes: [],
                access: KIDS,
            }),
        ).toEqual([]);
        expect(await getNextUpEpisodes(sql, userId, 20, KIDS)).toHaveLength(0);
        expect(
            await getLatestItems(sql, {
                limit: 20,
                parentId: null,
                groupItems: false,
                access: KIDS,
            }),
        ).toHaveLength(0);
        expect(
            await getLatestItems(sql, {
                limit: 20,
                parentId: null,
                groupItems: true,
                access: KIDS,
            }),
        ).toHaveLength(0);
        expect(
            (
                await getLatestSeriesGroups(sql, {
                    seriesIds: [adult.seriesId],
                    userId,
                    access: KIDS,
                })
            ).size,
        ).toBe(0);
        expect(await getResumeItems(sql, userId, 20, KIDS)).toHaveLength(0);

        const user = kidUser();
        expect(await checkMediaAccess(sql, adult.episodeIds[0], user)).toBe(false);
        expect(await checkMediaAccess(sql, adult.seasonId, user)).toBe(false);
        expect(await checkMediaAccess(sql, adult.seriesId, user)).toBe(false);
    });
});
