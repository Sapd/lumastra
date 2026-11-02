// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
/**
 * Related media (similar, recommendations, trailers, extras, theme media)
 * against the jellyfin-sdk-kotlin contract, through the real /j route handlers
 * over real PG + Valkey.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { truncateTables, TEST_TABLES } from '../integration/helpers/cleanup.js';
import { ensureTestUser } from '../integration/fixtures/user.fixtures.js';
import { callAndCheck, jfEvent, mintJfSession, type RouteHandler } from './harness';
import { seedRelatedMedia } from './seed';
import { GET as itemGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/+server';
import { GET as itemSimilarGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/Similar/+server';
import { GET as movieSimilarGet } from '../../src/routes/(proprietary)/j/Movies/[itemId]/Similar/+server';
import { GET as showSimilarGet } from '../../src/routes/(proprietary)/j/Shows/[seriesId]/Similar/+server';
import { GET as trailerSimilarGet } from '../../src/routes/(proprietary)/j/Trailers/[itemId]/Similar/+server';
import { GET as recommendationsGet } from '../../src/routes/(proprietary)/j/Movies/Recommendations/+server';
import { GET as trailersGet } from '../../src/routes/(proprietary)/j/Trailers/+server';
import { GET as localTrailersGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/LocalTrailers/+server';
import { GET as specialFeaturesGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/SpecialFeatures/+server';
import { GET as legacyLocalTrailersGet } from '../../src/routes/(proprietary)/j/Users/[userId]/Items/[itemId]/LocalTrailers/+server';
import { GET as themeSongsGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/ThemeSongs/+server';
import { GET as themeVideosGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/ThemeVideos/+server';
import { GET as themeMediaGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/ThemeMedia/+server';
import { GET as criticReviewsGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/CriticReviews/+server';

const USER_ID = '00000000-0000-4000-8000-00000000c0de';
let sql: postgres.Sql;
let token: string;
let seeded: Awaited<ReturnType<typeof seedRelatedMedia>>;

interface Dto {
    Id: string;
    Type: string;
    ExtraType?: string;
    Name: string;
    MediaSources?: unknown[];
    LocalTrailerCount?: number;
    SpecialFeatureCount?: number;
    RemoteTrailers?: { Url: string }[];
}

beforeAll(async () => {
    sql = getTestDb();
    if (!(await connectValkey())) throw new Error('Valkey not reachable (CACHE_URL)');
});
afterAll(async () => {
    await disconnectValkey();
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
    await ensureTestUser(sql, USER_ID);
    const [{ username }] = await sql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${USER_ID}`;
    token = await mintJfSession(sql, { userId: USER_ID, username });
    seeded = await seedRelatedMedia(sql, USER_ID);
});

function get(
    name: string,
    kotlinClass: string,
    handler: RouteHandler,
    path: string,
    params: Record<string, string> = {},
    opts: { legacySchema?: string } = {},
): Promise<unknown> {
    return callAndCheck(
        name,
        kotlinClass,
        handler,
        jfEvent({ method: 'GET', path, token, params }),
        opts,
    );
}

describe('/j related-media contract', () => {
    it('Items/{id} — movie detail carries trailer/extras counts and RemoteTrailers', async () => {
        const body = (await get(
            'related-item-detail',
            'BaseItemDto',
            itemGet,
            `/j/Items/${seeded.movieId}`,
            { itemId: seeded.movieId },
        )) as Dto;
        expect(body.LocalTrailerCount).toBe(1);
        expect(body.SpecialFeatureCount).toBe(1);
        expect(body.RemoteTrailers).toEqual([
            { Url: 'https://www.youtube.com/watch?v=contract', Name: 'Trailer' },
        ]);
    });

    it('Items/{id}/Similar and its Movies/Shows/Trailers aliases', async () => {
        const id = seeded.movieId;
        const a = (await get(
            'similar-items',
            'BaseItemDtoQueryResult',
            itemSimilarGet,
            `/j/Items/${id}/Similar?Limit=5`,
            { itemId: id },
        )) as { Items: Dto[] };
        expect(a.Items.map((i) => i.Id)).toEqual([seeded.otherId]);
        const m = (await get(
            'similar-movies',
            'BaseItemDtoQueryResult',
            movieSimilarGet,
            `/j/Movies/${id}/Similar?Limit=5`,
            { itemId: id },
        )) as { Items: Dto[] };
        expect(m.Items.map((i) => i.Id)).toEqual([seeded.otherId]);
        await get(
            'similar-shows',
            'BaseItemDtoQueryResult',
            showSimilarGet,
            `/j/Shows/${id}/Similar?Limit=5`,
            { seriesId: id },
        );
        // A trailer answers for the movie it belongs to.
        const t = (await get(
            'similar-trailers',
            'BaseItemDtoQueryResult',
            trailerSimilarGet,
            `/j/Trailers/${seeded.trailerId}/Similar?Limit=5`,
            { itemId: seeded.trailerId },
        )) as { Items: Dto[] };
        expect(t.Items.map((i) => i.Id)).toEqual([seeded.otherId]);
    });

    it('Movies/Recommendations', async () => {
        const body = (await get(
            'movie-recommendations',
            'List<RecommendationDto>',
            recommendationsGet,
            `/j/Movies/Recommendations?userId=${USER_ID}&categoryLimit=5&itemLimit=8`,
        )) as { RecommendationType: string; BaselineItemName: string; Items: Dto[] }[];
        expect(body.map((c) => [c.RecommendationType, c.BaselineItemName])).toEqual([
            ['SimilarToRecentlyPlayed', 'Contract Movie'],
        ]);
        expect(body[0].Items.map((i) => i.Id)).toEqual([seeded.otherId]);
    });

    it('Trailers', async () => {
        const body = (await get(
            'trailers',
            'BaseItemDtoQueryResult',
            trailersGet,
            `/j/Trailers?StartIndex=0&Limit=20&SortBy=SortName`,
        )) as { Items: Dto[]; TotalRecordCount: number };
        expect(body.TotalRecordCount).toBe(1);
        expect(body.Items[0]).toMatchObject({
            Id: seeded.trailerId,
            Type: 'Trailer',
            ExtraType: 'Trailer',
            Name: 'Contract Movie',
        });
        expect(body.Items[0].MediaSources?.length).toBe(1);
    });

    it('Items/{id}/LocalTrailers (+ legacy Users path)', async () => {
        const body = (await get(
            'local-trailers',
            'List<BaseItemDto>',
            localTrailersGet,
            `/j/Items/${seeded.movieId}/LocalTrailers?userId=${USER_ID}`,
            { itemId: seeded.movieId },
        )) as Dto[];
        expect(body.map((i) => [i.Id, i.Type, i.ExtraType])).toEqual([
            [seeded.trailerId, 'Trailer', 'Trailer'],
        ]);
        await get(
            'local-trailers-legacy',
            'List<BaseItemDto>',
            legacyLocalTrailersGet,
            `/j/Users/${USER_ID}/Items/${seeded.movieId}/LocalTrailers`,
            { userId: USER_ID, itemId: seeded.movieId },
            { legacySchema: 'BaseItemDto' },
        );
    });

    it('Items/{id}/SpecialFeatures', async () => {
        const body = (await get(
            'special-features',
            'List<BaseItemDto>',
            specialFeaturesGet,
            `/j/Items/${seeded.movieId}/SpecialFeatures?userId=${USER_ID}`,
            { itemId: seeded.movieId },
        )) as Dto[];
        expect(body.map((i) => [i.Id, i.Type, i.ExtraType, i.Name])).toEqual([
            [seeded.featuretteId, 'Video', 'Featurette', 'Making Of'],
        ]);
    });

    it('Items/{id}/ThemeSongs, ThemeVideos, ThemeMedia', async () => {
        const params = { itemId: seeded.movieId };
        const songs = (await get(
            'theme-songs',
            'ThemeMediaResult',
            themeSongsGet,
            `/j/Items/${seeded.movieId}/ThemeSongs`,
            params,
        )) as { OwnerId: string };
        expect(songs.OwnerId).toBe(seeded.movieId);
        await get(
            'theme-videos',
            'ThemeMediaResult',
            themeVideosGet,
            `/j/Items/${seeded.movieId}/ThemeVideos`,
            params,
        );
        await get(
            'theme-media',
            'AllThemeMediaResult',
            themeMediaGet,
            `/j/Items/${seeded.movieId}/ThemeMedia?InheritFromParent=true`,
            params,
        );
    });

    it('Items/{id}/CriticReviews (dropped from Jellyfin 10.9)', async () => {
        await get(
            'critic-reviews',
            'BaseItemDtoQueryResult',
            criticReviewsGet,
            `/j/Items/${seeded.movieId}/CriticReviews`,
            { itemId: seeded.movieId },
            { legacySchema: 'BaseItemDtoQueryResult' },
        );
    });
});
