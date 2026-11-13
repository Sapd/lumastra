// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /j browse, user, system and session routes against the jellyfin-sdk-kotlin
 * contract, through the real route handlers over real PG + Valkey.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { truncateTables, TEST_TABLES } from '../integration/helpers/cleanup.js';
import { ensureTestUser } from '../integration/fixtures/user.fixtures.js';
import { getOrCreatePassword } from '$lib/server/proprietary/jellyfin-compat/auth';
import { callAndCheck, jfEvent, mintJfSession, type RouteHandler } from './harness';
import { seedEpisodeExternalSrt, seedMovieEmbeddedSubs } from './seed';
import { GET as itemGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/+server';
import { GET as userItemsGet } from '../../src/routes/(proprietary)/j/Users/[userId]/Items/+server';
import { GET as itemsGet } from '../../src/routes/(proprietary)/j/Items/+server';
import { GET as itemCountsGet } from '../../src/routes/(proprietary)/j/Items/Counts/+server';
import { GET as itemsRootGet } from '../../src/routes/(proprietary)/j/Items/Root/+server';
import { GET as usersMeGet } from '../../src/routes/(proprietary)/j/Users/Me/+server';
import { GET as systemInfoGet } from '../../src/routes/(proprietary)/j/System/Info/+server';
import { GET as systemInfoPublicGet } from '../../src/routes/(proprietary)/j/System/Info/Public/+server';
import { GET as seasonsGet } from '../../src/routes/(proprietary)/j/Shows/[seriesId]/Seasons/+server';
import { GET as episodesGet } from '../../src/routes/(proprietary)/j/Shows/[seriesId]/Episodes/+server';
import { GET as nextUpGet } from '../../src/routes/(proprietary)/j/Shows/NextUp/+server';
import { GET as userViewsGet } from '../../src/routes/(proprietary)/j/UserViews/+server';
import { GET as latestGet } from '../../src/routes/(proprietary)/j/Items/Latest/+server';
import { GET as resumeGet } from '../../src/routes/(proprietary)/j/UserItems/Resume/+server';
import { GET as sessionsGet } from '../../src/routes/(proprietary)/j/Sessions/+server';
import { POST as authByNamePost } from '../../src/routes/(proprietary)/j/Users/AuthenticateByName/+server';

const USER_ID = '00000000-0000-4000-8000-00000000c0de';
let sql: postgres.Sql;
let token: string;
let username: string;
let movie: { itemId: string };
let episode: { itemId: string; seriesId: string; seasonId: string };

beforeAll(async () => {
    sql = getTestDb();
    // /j sessions live in Valkey; the client connects only on demand.
    if (!(await connectValkey())) throw new Error('Valkey not reachable (CACHE_URL)');
});
afterAll(async () => {
    await disconnectValkey();
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
    await ensureTestUser(sql, USER_ID);
    [{ username }] = await sql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${USER_ID}`;
    token = await mintJfSession(sql, { userId: USER_ID, username });
    episode = await seedEpisodeExternalSrt(sql);
    movie = await seedMovieEmbeddedSubs(sql);
});

function get(
    name: string,
    kotlinClass: string,
    handler: RouteHandler,
    path: string,
    params: Record<string, string> = {},
): Promise<unknown> {
    return callAndCheck(
        name,
        kotlinClass,
        handler,
        jfEvent({ method: 'GET', path, token, params }),
    );
}

describe('/j browse contract', () => {
    it('Items/{id} — movie', async () => {
        await get('item-movie', 'BaseItemDto', itemGet, `/j/Items/${movie.itemId}`, {
            itemId: movie.itemId,
        });
    });

    it('Items/{id} — episode', async () => {
        await get('item-episode', 'BaseItemDto', itemGet, `/j/Items/${episode.itemId}`, {
            itemId: episode.itemId,
        });
    });

    it('Users/{id}/Items (legacy route, not in SDK 1.6.3+ specs)', async () => {
        await callAndCheck(
            'user-items',
            'BaseItemDtoQueryResult',
            userItemsGet,
            jfEvent({
                method: 'GET',
                path: `/j/Users/${USER_ID}/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Fields=MediaSources,MediaStreams`,
                token,
                params: { userId: USER_ID },
            }),
            { legacySchema: 'BaseItemDtoQueryResult' },
        );
    });

    it('Items', async () => {
        await get(
            'items',
            'BaseItemDtoQueryResult',
            itemsGet,
            '/j/Items?Recursive=true&Fields=MediaSources',
        );
    });

    it('Items — multi-key SortBy with per-key SortOrder', async () => {
        const body = (await get(
            'items-sorted',
            'BaseItemDtoQueryResult',
            itemsGet,
            '/j/Items?Recursive=true&IncludeItemTypes=Movie,Series&SortBy=ProductionYear,SortName&SortOrder=Ascending,Descending',
        )) as { Items: { Name: string }[]; TotalRecordCount: number };
        // Same production year → SortName descending decides.
        expect(body.Items.map((i) => i.Name)).toEqual(['Contract Series', 'Contract Movie']);
        expect(body.TotalRecordCount).toBe(2);
    });

    it('Items — Recursive under a series, Filters=IsNotFolder (play all)', async () => {
        const body = (await get(
            'items-series-recursive',
            'BaseItemDtoQueryResult',
            itemsGet,
            `/j/Items?ParentId=${episode.seriesId}&Recursive=true&Filters=IsNotFolder&MediaTypes=Video&SortBy=SortName`,
        )) as { Items: { Id: string; Type: string }[] };
        expect(body.Items.map((i) => [i.Id, i.Type])).toEqual([[episode.itemId, 'Episode']]);
    });

    it('Items — isPlayed=false and ExcludeItemTypes', async () => {
        const body = (await get(
            'items-filtered',
            'BaseItemDtoQueryResult',
            itemsGet,
            '/j/Items?Recursive=true&IncludeItemTypes=Movie,Series&isPlayed=false&ExcludeItemTypes=Series',
        )) as { Items: { Id: string }[]; TotalRecordCount: number };
        expect(body.Items.map((i) => i.Id)).toEqual([movie.itemId]);
        expect(body.TotalRecordCount).toBe(1);
    });

    it('Items — SearchTerm reports the real total, not the page size', async () => {
        const body = (await get(
            'items-search',
            'BaseItemDtoQueryResult',
            itemsGet,
            '/j/Items?SearchTerm=Contract&IncludeItemTypes=Movie,Series&Recursive=true&Limit=1',
        )) as { Items: unknown[]; TotalRecordCount: number };
        expect(body.Items).toHaveLength(1);
        expect(body.TotalRecordCount).toBe(2);
    });

    it('Items — series and seasons carry episode counts and derived UserData', async () => {
        type Dto = {
            Id: string;
            ChildCount?: number;
            RecursiveItemCount?: number;
            UserData: { UnplayedItemCount?: number; PlayedPercentage: number; Played: boolean };
        };
        const list = async (name: string): Promise<Dto> => {
            const body = (await get(
                name,
                'BaseItemDtoQueryResult',
                itemsGet,
                '/j/Items?Recursive=true&IncludeItemTypes=Series',
            )) as { Items: Dto[] };
            return body.Items.find((i) => i.Id === episode.seriesId)!;
        };
        const before = await list('items-series-userdata');
        expect(before).toMatchObject({ ChildCount: 1, RecursiveItemCount: 1 });
        expect(before.UserData).toMatchObject({
            UnplayedItemCount: 1,
            PlayedPercentage: 0,
            Played: false,
        });

        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched, watch_count, last_watched_at, last_event_at, last_event_source)
                  VALUES (${USER_ID}, ${episode.itemId}, true, 1, NOW(), NOW(), 'lumastra')`;
        const after = await list('items-series-userdata-watched');
        expect(after.UserData).toMatchObject({
            UnplayedItemCount: 0,
            PlayedPercentage: 100,
            Played: true,
        });

        const season = (await get(
            'item-season-userdata',
            'BaseItemDto',
            itemGet,
            `/j/Items/${episode.seasonId}`,
            { itemId: episode.seasonId },
        )) as Dto;
        expect(season).toMatchObject({ ChildCount: 1, RecursiveItemCount: 1 });
        expect(season.UserData).toMatchObject({ UnplayedItemCount: 0, Played: true });
    });

    it('Items — SortName is the sort key, not the original-language title', async () => {
        await sql`UPDATE media_items SET original_title = 'Vertragsfilm', sort_title = 'contract movie'
                  WHERE id = ${movie.itemId}`;
        const body = (await get(
            'items-sortname',
            'BaseItemDtoQueryResult',
            itemsGet,
            '/j/Items?Recursive=true&IncludeItemTypes=Movie',
        )) as { Items: { Id: string; SortName: string; OriginalTitle?: string }[] };
        expect(body.Items.find((i) => i.Id === movie.itemId)).toMatchObject({
            SortName: 'contract movie',
            OriginalTitle: 'Vertragsfilm',
        });
    });

    it('Items/Counts', async () => {
        const body = await get('item-counts', 'ItemCounts', itemCountsGet, '/j/Items/Counts');
        expect(body).toMatchObject({ MovieCount: 1, SeriesCount: 1, EpisodeCount: 1 });
    });

    it('Items/Root', async () => {
        const body = await get('items-root', 'BaseItemDto', itemsRootGet, '/j/Items/Root');
        expect(body).toMatchObject({ Type: 'UserRootFolder', IsFolder: true });
    });

    it('Users/Me', async () => {
        await get('users-me', 'UserDto', usersMeGet, '/j/Users/Me');
    });

    it('Users/Me — Configuration carries the playback language preferences', async () => {
        await sql`INSERT INTO user_playback_preferences (user_id, audio_language, subtitle_language, subtitles_enabled, forced_subtitles_enabled)
                  VALUES (${USER_ID}, 'de', 'en', true, true)
                  ON CONFLICT (user_id) DO UPDATE SET audio_language = 'de', subtitle_language = 'en',
                      subtitles_enabled = true, forced_subtitles_enabled = true`;
        try {
            const body = (await get('users-me-config', 'UserDto', usersMeGet, '/j/Users/Me')) as {
                Configuration: Record<string, unknown>;
            };
            expect(body.Configuration).toMatchObject({
                AudioLanguagePreference: 'deu',
                SubtitleLanguagePreference: 'eng',
                SubtitleMode: 'Always',
                PlayDefaultAudioTrack: false,
            });
        } finally {
            await sql`DELETE FROM user_playback_preferences WHERE user_id = ${USER_ID}`;
        }
    });

    it('System/Info', async () => {
        await get('system-info', 'SystemInfo', systemInfoGet, '/j/System/Info');
    });

    it('System/Info/Public', async () => {
        await get(
            'system-info-public',
            'PublicSystemInfo',
            systemInfoPublicGet,
            '/j/System/Info/Public',
        );
    });

    it('Shows/{id}/Seasons', async () => {
        await get(
            'show-seasons',
            'BaseItemDtoQueryResult',
            seasonsGet,
            `/j/Shows/${episode.seriesId}/Seasons?UserId=${USER_ID}`,
            { seriesId: episode.seriesId },
        );
    });

    it('Shows/{id}/Episodes', async () => {
        await get(
            'show-episodes',
            'BaseItemDtoQueryResult',
            episodesGet,
            `/j/Shows/${episode.seriesId}/Episodes?UserId=${USER_ID}&Fields=MediaSources`,
            { seriesId: episode.seriesId },
        );
    });

    it('Shows/NextUp', async () => {
        await get(
            'nextup',
            'BaseItemDtoQueryResult',
            nextUpGet,
            `/j/Shows/NextUp?UserId=${USER_ID}`,
        );
    });

    it('Shows/NextUp — StartIndex past the end keeps the total and echoes StartIndex', async () => {
        const body = (await get(
            'nextup-paged',
            'BaseItemDtoQueryResult',
            nextUpGet,
            `/j/Shows/NextUp?UserId=${USER_ID}&StartIndex=5&Limit=5&enableRewatching=false&enableResumable=false&ParentId=${episode.seriesId}`,
        )) as { Items: unknown[]; StartIndex: number; TotalRecordCount: number };
        expect(body.StartIndex).toBe(5);
        expect(body.Items).toEqual([]);
        expect(body.TotalRecordCount).toBe(0);
    });

    it('UserViews', async () => {
        await get(
            'userviews',
            'BaseItemDtoQueryResult',
            userViewsGet,
            `/j/UserViews?userId=${USER_ID}`,
        );
    });

    it('Items/Latest', async () => {
        await get('latest', 'List<BaseItemDto>', latestGet, `/j/Items/Latest?userId=${USER_ID}`);
    });

    it('Items/Latest — real user data, HidePlayedInLatest, GroupItems', async () => {
        type Dto = {
            Id: string;
            Type: string;
            UserData: { Played: boolean; UnplayedItemCount?: number };
        };
        const latest = (name: string, query = ''): Promise<Dto[]> =>
            get(
                name,
                'List<BaseItemDto>',
                latestGet,
                `/j/Items/Latest?userId=${USER_ID}${query}`,
            ) as Promise<Dto[]>;

        // The series' only episode is its whole season: Jellyfin shows the series.
        const grouped = await latest('latest-grouped');
        expect(grouped.map((i) => i.Id).sort()).toEqual([episode.seriesId, movie.itemId].sort());
        expect(grouped.find((i) => i.Id === episode.seriesId)?.UserData.UnplayedItemCount).toBe(1);

        const flat = await latest('latest-ungrouped', '&GroupItems=false&IncludeItemTypes=Episode');
        expect(flat.map((i) => [i.Id, i.Type])).toEqual([[episode.itemId, 'Episode']]);

        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched, watch_count, last_watched_at, last_event_at, last_event_source)
                  VALUES (${USER_ID}, ${movie.itemId}, true, 1, NOW(), NOW(), 'lumastra')`;
        const hidden = await latest('latest-hide-played', '&IncludeItemTypes=Movie');
        expect(hidden).toEqual([]);
        const played = await latest('latest-played', '&IncludeItemTypes=Movie&IsPlayed=true');
        expect(played.map((i) => [i.Id, i.UserData.Played])).toEqual([[movie.itemId, true]]);
    });

    it('UserItems/Resume — MediaTypes keeps videos out of an Audio row', async () => {
        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms, runtime_ms, last_watched_at, last_event_at, last_event_source)
                  VALUES (${USER_ID}, ${movie.itemId}, false, 600000, 5400000, NOW(), NOW(), 'lumastra')`;
        const resume = (name: string, query: string) =>
            get(
                name,
                'BaseItemDtoQueryResult',
                resumeGet,
                `/j/UserItems/Resume${query}`,
            ) as Promise<{
                Items: { Id: string }[];
                TotalRecordCount: number;
            }>;
        const video = await resume('resume-video', '?MediaTypes=Video');
        expect(video.Items.map((i) => i.Id)).toEqual([movie.itemId]);
        expect(video.TotalRecordCount).toBe(1);
        const audio = await resume('resume-audio', '?MediaTypes=Audio');
        expect(audio).toMatchObject({ Items: [], TotalRecordCount: 0 });
    });

    it('Sessions', async () => {
        await get('sessions', 'List<SessionInfoDto>', sessionsGet, '/j/Sessions');
    });

    it('Users/AuthenticateByName', async () => {
        const pin = await getOrCreatePassword(USER_ID);
        await callAndCheck(
            'auth-by-name',
            'AuthenticationResult',
            authByNamePost,
            jfEvent({
                method: 'POST',
                path: '/j/Users/AuthenticateByName',
                params: {},
                body: { Username: username, Pw: pin },
            }),
        );
    });
});
