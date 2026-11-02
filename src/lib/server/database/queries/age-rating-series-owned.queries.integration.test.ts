// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Episodes and seasons are judged by their SERIES' age rating, also with
 * `allowUnrated=true`: an unrated episode of an 18-rated series must not pass
 * through the "unrated is visible" arm. Covers the shared builder, the age gate, and the call sites that can return
 * episode rows (search, watch history, dismissal info).
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
import { buildSeriesOwnedAgeRatingFilter } from './builders/age-rating.builder.js';
import { restrictedAccess } from './builders/media-access-boundary.js';
import { searchMedia } from './search.queries.js';
import { getWatchHistoryPage } from './integration-watch-history.queries.js';
import { fetchDismissalMediaInfo } from './user-media-flags.queries.js';

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, config: { ...actual.config, UNRATED_CONTENT_VISIBLE: true } };
});

let sql: postgres.Sql;
let userId: UserId;

/** A kid profile that may also see unrated content. */
const KIDS = restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: true });

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
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, parent_id, has_files, season_number,
                                 episode_number, age_rating, runtime_seconds, year)
        VALUES (${title}, ${type}, 'active', ${parentId}, ${type === 'episode'},
                ${extra.season ?? null}, ${extra.episode ?? null}, ${extra.ageRating ?? null},
                2700, 2020)
        RETURNING id`;
    return row.id;
}

/** Series (own type + rating) -> season -> one unrated episode. */
async function show(
    title: string,
    ageRating: number,
): Promise<{ seriesId: string; seasonId: string; episodeId: string }> {
    const seriesId = await item(title, 'tv', null, { ageRating });
    const seasonId = await item(`${title} S1`, 'season', seriesId, { season: 1 });
    const episodeId = await item(`${title} 1x1`, 'episode', seasonId, { season: 1, episode: 1 });
    return { seriesId, seasonId, episodeId };
}

async function watched(mediaId: string): Promise<void> {
    await sql`
        INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms, runtime_ms,
                                      watch_count, last_watched_at, last_event_at, last_event_source)
        VALUES (${userId}::uuid, ${mediaId}::uuid, true, 0, 2700000, 1, NOW(), NOW(), 'lumastra')`;
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

async function visible(ids: string[]): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT mi.id FROM media_items mi
        WHERE mi.id = ANY(${ids}::uuid[])
          ${buildSeriesOwnedAgeRatingFilter(sql, KIDS.age)}`;
    return rows.map((r) => r.id).sort();
}

describe('series-owned age rating with allowUnrated=true', () => {
    it('hides episodes and seasons of an over-limit series, keeps within-limit ones', async () => {
        const kids = await show('Kids', 6);
        const adult = await show('Adult', 18);
        expect(
            await visible([
                kids.episodeId,
                kids.seasonId,
                adult.episodeId,
                adult.seasonId,
                adult.seriesId,
            ]),
        ).toEqual([kids.episodeId, kids.seasonId].sort());
    });

    it('an episode filed directly under its series takes the series rating', async () => {
        const kidsId = await item('Flat Kids', 'tv', null, { ageRating: 6 });
        const kidsEp = await item('Flat Kids 1', 'episode', kidsId, { season: 1, episode: 1 });
        const adultId = await item('Flat Adult', 'tv', null, { ageRating: 18 });
        const adultEp = await item('Flat Adult 1', 'episode', adultId, { season: 1, episode: 1 });
        expect(await visible([kidsEp, adultEp])).toEqual([kidsEp]);
        expect(await checkMediaAccess(sql, adultEp, kidUser())).toBe(false);
        expect(await checkMediaAccess(sql, kidsEp, kidUser())).toBe(true);
    });

    it('the age gate judges an episode of an over-limit series by the series', async () => {
        const adult = await show('Adult', 18);
        const kids = await show('Kids', 6);
        expect(await checkMediaAccess(sql, adult.episodeId, kidUser())).toBe(false);
        expect(await checkMediaAccess(sql, adult.seasonId, kidUser())).toBe(false);
        expect(await checkMediaAccess(sql, kids.episodeId, kidUser())).toBe(true);
    });

    it('search does not return episodes of an over-limit series', async () => {
        const kids = await show('Puddlejump', 6);
        await show('Puddlejump Adult', 18);
        const found = await searchMedia(sql, 'Puddlejump', KIDS, {
            mediaTypes: ['episode'],
            fileBackedOnly: false,
        });
        expect(found.map((r) => r.internal_id)).toEqual([kids.episodeId]);
    });

    it('watch history does not list episodes of an over-limit series', async () => {
        const kids = await show('Kids', 6);
        const adult = await show('Adult', 18);
        await watched(kids.episodeId);
        await watched(adult.episodeId);
        const rows = await getWatchHistoryPage(
            sql,
            userId,
            { deniedGroupIds: null, ageRating: { maxAgeRating: 12, allowUnrated: true } },
            50,
            null,
        );
        expect(rows.map((r) => r.media_id)).toEqual([kids.episodeId]);
    });

    it('dismissal info does not resolve episodes of an over-limit series', async () => {
        const kids = await show('Kids', 6);
        const adult = await show('Adult', 18);
        const info = await fetchDismissalMediaInfo(sql, [kids.episodeId, adult.episodeId], KIDS);
        expect(info.map((i) => i.id)).toEqual([kids.episodeId]);
    });
});
