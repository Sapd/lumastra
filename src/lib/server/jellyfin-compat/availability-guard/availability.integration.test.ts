// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';
import { toUserId } from '$lib/shared/user-id.js';
import type { UserContext } from '$lib/server/types.js';
import type { SubsonicHandler, SubsonicAuthContext } from '$lib/server/subsonic-compat/types.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { tmdbApi } from '$lib/server/providers/implementations/tmdb/index.js';
import { config, features } from '$lib/server/config.js';
import { isAvailable } from '$lib/server/database/queries/availability.queries.js';
import { surfaces, subsonicSurfaces, type Surface } from './surfaces.js';
import { cacheSet } from '$lib/server/cache/valkey.js';
import {
    BOOKMARK_CACHE_PREFIX,
    PLAY_QUEUE_CACHE_PREFIX,
} from '$lib/server/subsonic-compat/constants.js';
import { sonarrClient, radarrClient } from '$lib/server/sonarr.js';
import { jellyseerrClient } from '$lib/server/jellyseerr.js';
import * as holidayConfig from '$lib/server/plugins/holidays/config-loader.js';
import { getSourceAdapter } from '$lib/server/plugins/holidays/sources/index.js';
import { playlistIdToUuid } from '../playlist-id.js';
import { expandAliases } from './registry.js';

// Bypass only credential parsing. Queries, projections and access boundaries
// run unchanged as a real non-admin user. Web routes still run mount/enforce.
const embeddings = vi.hoisted(() => ({
    audio: [1, ...Array<number>(1023).fill(0)],
    lyrics: [1, ...Array<number>(1023).fill(0)],
}));
// Only network embedding generation is replaced. Nearest-neighbour retrieval
// executes against real pgvector rows, including unavailable candidates.
vi.mock('$lib/server/services/sonic-embedding.service.js', async (original) => ({
    ...(await original<typeof import('$lib/server/services/sonic-embedding.service.js')>()),
    embedTextQuery: async () => embeddings.audio,
}));
vi.mock('$lib/server/ai/voyage.js', async (original) => ({
    ...(await original<typeof import('$lib/server/ai/voyage.js')>()),
    isVoyageAvailable: () => true,
    generateVoyageQueryEmbedding: async () => embeddings.lyrics,
}));
vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
const routeModules = import.meta.glob<{ GET?: RequestHandler; POST?: RequestHandler }>(
    '/src/routes/**/+server.ts',
);
const subsonicModules = import.meta.glob<Record<string, SubsonicHandler>>(
    '/src/lib/server/subsonic-compat/handlers/*.ts',
);
const userId = toUserId('00000000-0000-4000-8000-000000a11a01');
const user: UserContext = {
    userId,
    username: 'availability_guard',
    groups: '',
    userGroups: [],
    ownerIsAdmin: false,
    hasWatchPermission: true,
    hasRequestPermission: false,
    hasLiveTvPermission: false,
    maxAgeRating: null,
    isAgeRestricted: false,
    isModerator: false,
    liveTvPriority: 'low',
};
let sql: postgres.Sql;
const ids: Record<string, string> = { userId, cluster: '1' };
const hidden: string[] = [];
const hiddenProviderIds: string[] = [];
const credits: { id: string; type: string; externalId: string }[] = [];
let providerId = 9700000;

function interpolate(value: unknown): unknown {
    if (typeof value === 'string') return value.startsWith('$') ? ids[value.slice(1)] : value;
    if (Array.isArray(value)) return value.map(interpolate);
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [key, interpolate(child)]),
        );
    return value;
}

function event(
    route: string,
    query: Record<string, string> = {},
    method = 'GET',
    body?: Record<string, unknown>,
): RequestEvent {
    const params: Record<string, string> = {};
    let pathname = '/' + route.replace('(modules)/', '');
    for (const [key, value] of Object.entries(query)) {
        if (key.startsWith('$')) {
            params[key.slice(1)] = ids[value] ?? value;
            pathname = pathname.replace('[' + key.slice(1) + ']', params[key.slice(1)]);
        }
    }
    const url = new URL(pathname, 'http://localhost');
    for (const [key, value] of Object.entries(query)) {
        if (!key.startsWith('$'))
            url.searchParams.set(key, value.startsWith('$') ? ids[value.slice(1)] : value);
    }
    return {
        url,
        params,
        request: new Request(url, {
            method,
            ...(body
                ? {
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify(interpolate(body)),
                  }
                : {}),
        }),
        locals: {
            user,
            principal: {
                kind: 'session',
                userId,
                username: user.username,
                userGroups: [],
                scopes: ['read', 'write'],
                isAdmin: false,
            },
            subsonicBodyParams: new URLSearchParams(),
            jfToken: 'guard-session',
        },
        route: { id: '/' + route },
        cookies: { get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} },
        fetch,
        getClientAddress: () => '127.0.0.1',
        setHeaders: () => {},
        isDataRequest: false,
        isSubRequest: false,
    } as unknown as RequestEvent;
}

async function item(
    type: string,
    state: string,
    parent: string | null = null,
    number = 1,
): Promise<string> {
    const available = state.startsWith('available');
    const runtime = type === 'movie' ? 3600 : type === 'track' ? 210 : 1200;
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, parent_id, status, has_files, is_dismissed,
            year, runtime_seconds, season_number, episode_number, files_lost_at, dismissed_at, custom_metadata)
        VALUES (${`Availguard ${state} ${type}`}, ${type}, ${parent}, 'active', ${available},
            ${state === 'dismissed'}, 2026, ${runtime}, ${type === 'season' || type === 'episode' ? 1 : null},
            ${type === 'episode' ? number : null}, ${state === 'retention' ? new Date() : null}, ${state === 'dismissed' ? new Date() : null}, '{"genre":"Drama","genres":["Drama"]}') RETURNING id`;
    const id = row.id;
    if (available) ids[type] = id;
    else hidden.push(id);
    if (['movie', 'episode', 'track', 'audiobook'].includes(type) && state !== 'catalog') {
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, is_missing, file_size_bytes, container_format, duration_seconds)
            VALUES (${`/availguard/${id}.${type === 'track' || type === 'audiobook' ? 'mp3' : 'mkv'}`},
                ${!available && state !== 'dismissed'}, 1000000, ${type === 'track' || type === 'audiobook' ? 'mp3' : 'matroska'}, ${runtime})
            RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${file.id}, ${id}, true)`;
    }
    if (type === 'tv')
        await sql`INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type) VALUES (${userId}, ${id}, 'series', 'series_episode_notifications')`;
    if (type === 'movie' || type === 'tv') {
        const externalId = String(++providerId);
        credits.push({ id, type, externalId });
        if (!available) hiddenProviderIds.push(externalId);
        const movieEmbedding = [...embeddings.lyrics];
        movieEmbedding[1] = (providerId - 9700000) * 0.1;
        await sql`INSERT INTO media_embeddings (media_id, source, embedding) VALUES (${id}, ${available ? 'library' : 'discovery'}, ${JSON.stringify(movieEmbedding)}::vector)`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary) VALUES (${id}, 'tmdb', ${externalId}, ${type}, true)`;
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${id}, 'tmdb', ${sql.json({ genres: [{ id: 18, name: 'Drama' }], keywords: ['friendship', 'heartwarming'], overview: 'Availguard story', popularity: 100, vote_average: 8, vote_count: 1000, imdb_rating: 8, imdb_votes: 10000, mdblist_score: 90, runtime: 60, runtime_minutes: 60, number_of_episodes: 6, number_of_seasons: 1, origin_country: state === 'catalog' || state === 'available-extra-1' ? ['JP'] : ['US'], original_language: state === 'catalog' || state === 'available-extra-1' ? 'ja' : 'en', anime_genres: state === 'catalog' || state === 'available-extra-1' ? ['Drama'] : undefined, backdrop_path: '/availguard-backdrop.jpg', poster_path: '/availguard-poster.jpg', release_date: new Date().toISOString().slice(0, 10), first_air_date: new Date().toISOString().slice(0, 10) })})`;
    }
    if (['movie', 'episode', 'track', 'audiobook'].includes(type)) {
        await sql`INSERT INTO user_media_state (user_id, media_id, resume_position_ms, runtime_ms, is_watched, last_event_at, last_watched_at, last_event_source)
            VALUES (${userId}, ${id}, ${runtime * 250}, ${runtime * 1000}, false, NOW(), NOW(), 'lumastra')`;
    }
    if (type === 'track') {
        await sql`UPDATE media_items SET custom_metadata = custom_metadata || '{"genre":["Drama"],"essentia":{"bpm":120,"energy":0.6,"danceability":0.6}}'::jsonb WHERE id = ${id}`;
        await sql`INSERT INTO media_embeddings (media_id, source, embedding) VALUES (${id}, 'music', ${JSON.stringify(embeddings.lyrics)}::vector)`;
        await sql`INSERT INTO media_audio_clusters (media_id, model_id, cluster_id, computed_at) VALUES (${id}, 'msclap-2023', 1, NOW())`;
        await sql`INSERT INTO media_audio_map_coords (media_id, model_id, x, y) VALUES (${id}, 'msclap-2023', 0.1, 0.2)`;
        await sql`INSERT INTO media_audio_embeddings (media_id, model_id, embedding) VALUES (${id}, 'msclap-2023', ${JSON.stringify(embeddings.audio)}::vector)`;
        await sql`INSERT INTO media_lyrics_embeddings (media_id, source, embedding) VALUES (${id}, 'db-fetch', ${JSON.stringify(embeddings.lyrics)}::vector)`;
    }
    if (type === 'movie')
        await sql`INSERT INTO user_suggestions (user_id, media_id, combined_score, explanation, reason_data, expires_at) VALUES (${userId}, ${id}, 0.9, 'Guard suggestion', '{"kind":"rated-similar","title":"Guard seed","rating":9}', now() + interval '1 day')`;
    if (['album', 'track'].includes(type))
        await sql`INSERT INTO user_ratings (user_id, media_id, rating) VALUES (${userId}, ${id}, 10)`;
    if (type === 'audiobook') {
        for (const [resource, role] of [
            ['authors', 'author'],
            ['narrators', 'narrator'],
        ]) {
            if (!ids[resource]) {
                const [contributor] = await sql<
                    { id: string }[]
                >`INSERT INTO audiobook_contributors (name, normalized_name) VALUES (${resource}, ${resource}) RETURNING id`;
                ids[resource] = contributor.id;
            }
            await sql`INSERT INTO audiobook_book_contributors (media_id, contributor_id, role, position) VALUES (${id}, ${ids[resource]}, ${role}, 0)`;
        }
        if (!ids.series) {
            const [series] = await sql<
                { id: string }[]
            >`INSERT INTO audiobook_series (name, normalized_name, sort_name) VALUES ('Availguard series', 'availguard series', 'availguard series') RETURNING id`;
            ids.series = series.id;
        }
        await sql`INSERT INTO audiobook_book_series (media_id, series_id, sequence) VALUES (${id}, ${ids.series}, 1)`;
    }
    if (type === 'track')
        await sql`INSERT INTO user_music_state (user_id, track_id, play_count, last_played_at) VALUES (${userId}, ${id}, 3, NOW() - interval '14 days')`;
    return id;
}

beforeAll(async () => {
    sql = getTestDb();
    vi.spyOn(config, 'SHOW_UNAVAILABLE_MEDIA', 'get').mockReturnValue(false);
    // Known local TMDB identities need the provider enabled; no provider fetch
    // is involved in the DB-backed similarity lookup.
    vi.spyOn(tmdbApi, 'isAvailable').mockReturnValue(true);
    for (const feature of [
        'sonicEmbeddings',
        'sonicQueue',
        'musicClusters',
        'lyricsSearch',
        'textToSound',
        'musicMap',
        'audiobooks',
        'aiRecommendations',
        'musicAlchemy',
        'holidays',
    ] as const)
        vi.spyOn(features, feature, 'get').mockReturnValue(true);
    await truncateTables(sql, [
        ...TEST_TABLES.media,
        ...TEST_TABLES.userData,
        'audiobook_contributors',
        'audiobook_series',
    ]);
    const [dimension] = await sql<
        { dimension: number }[]
    >`SELECT atttypmod AS dimension FROM pg_attribute WHERE attrelid = 'media_lyrics_embeddings'::regclass AND attname = 'embedding'`;
    embeddings.lyrics = [1, ...Array<number>(dimension.dimension - 1).fill(0)];
    await Promise.all(
        Object.values(CACHE_NAMESPACES).map((namespace) => cacheManager.for(namespace).clear()),
    );
    await ensureTestUser(sql, userId);
    await sql`UPDATE users SET username = ${user.username} WHERE id = ${userId}`;
    for (const state of ['available', 'catalog', 'missing', 'dismissed', 'retention']) {
        await item('movie', state);
        const show = await item('tv', state);
        const season = await item('season', state, show);
        await item('episode', state, season);
        const artist = await item('artist', state);
        const album = await item('album', state, artist);
        const track = await item('track', state, album);
        await sql`UPDATE media_items SET custom_metadata = custom_metadata || ${sql.json({ artist: `Availguard ${state} artist`, album: `Availguard ${state} album`, track_number: 1, genre: ['Drama'] })} WHERE id = ${track}`;
        await item('audiobook', state);
        if (state !== 'available') {
            await item('episode', state, ids.season, hidden.length + 2);
            await item('album', state, ids.artist);
            await item('track', state, ids.album);
        }
    }
    const originals = { ...ids };
    // Otherwise-identical eligibility for available and unavailable controls:
    // real releases, established shows, seasonal curation and watched seeds.
    await sql`UPDATE media_items SET year = 2020 WHERE media_type = 'tv'`;
    await sql`UPDATE media_items SET premiere_date = CURRENT_DATE WHERE media_type IN ('movie', 'episode')`;
    ids.calendarMovie = ids.movie;
    const futureRows: Awaited<ReturnType<typeof sonarrClient.getCalendar>> = [];
    for (const credit of credits.filter((c) => c.type === 'tv')) {
        const [season] = await sql<
            { id: string; series_title: string }[]
        >`SELECT season.id, series.title AS series_title FROM media_items season JOIN media_items series ON series.id = season.parent_id WHERE season.parent_id = ${credit.id} AND season.media_type = 'season' LIMIT 1`;
        const available = credit.id === originals.tv;
        const episode = await item(
            'episode',
            available ? 'available-future' : 'catalog',
            season.id,
            20,
        );
        await sql`UPDATE media_items SET premiere_date = CURRENT_DATE + 1 WHERE id = ${episode}`;
        if (available) ids.futureEpisode = episode;
        futureRows.push({
            id: futureRows.length + 1,
            title: 'Availguard future episode',
            seasonNumber: 1,
            episodeNumber: 20,
            hasFile: available,
            airDateUtc: new Date(Date.now() + 86400000).toISOString(),
            series: {
                id: futureRows.length + 1,
                title: season.series_title,
                tmdbId: Number(credit.externalId),
            },
        });
    }
    Object.assign(ids, originals);
    vi.spyOn(sonarrClient, 'getCalendar').mockResolvedValue(futureRows);
    vi.spyOn(radarrClient, 'getCalendar').mockResolvedValue([]);
    vi.spyOn(holidayConfig, 'getHolidaySettings').mockReturnValue({
        enabled: true,
        defaultLimit: 100,
        enableAiPersonalization: false,
        cacheTtlMinutes: 5,
        jellyfinCacheTtlHours: 1,
    });
    vi.spyOn(holidayConfig, 'getHolidays').mockReturnValue([
        {
            id: 'availguard',
            name: 'Availguard holiday',
            emoji: '🎬',
            startMonth: 1,
            startDay: 1,
            endMonth: 12,
            endDay: 31,
            backgroundColor: '#000000',
            textColor: '#ffffff',
            sources: [{ type: 'custom' }],
        },
    ]);
    vi.spyOn(getSourceAdapter('custom')!, 'discover').mockResolvedValue(
        credits
            .filter((c) => c.type === 'movie')
            .map((c) => ({
                id: Number(c.externalId),
                mediaType: 'movie',
                title: 'Availguard seasonal movie',
                overview: 'Availguard story',
                posterPath: '/guard.jpg',
                backdropPath: '/guard.jpg',
                voteAverage: 8,
                voteCount: 1000,
                popularity: 100,
                genreIds: [18],
                source: 'custom',
                boostFactor: 1,
                isFeatured: true,
                isNewRelease: false,
                isFromCollection: false,
            })),
    );
    vi.spyOn(jellyseerrClient, 'getMediaByTmdbId').mockResolvedValue(null);
    vi.spyOn(jellyseerrClient, 'getFulfilledRequestsForUser').mockResolvedValue(
        credits
            .filter((c) => c.type === 'movie')
            .map((c, index) => ({
                id: index + 1,
                status: 2,
                is4k: false,
                type: 'movie',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                requestedBy: { id: 1, email: 'guard@example.invalid', displayName: user.username },
                media: {
                    id: index + 1,
                    tmdbId: Number(c.externalId),
                    mediaType: 'movie',
                    status: 5,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
                title: 'Availguard fulfilled movie',
            })),
    );
    await sql`INSERT INTO mood_vectors (mood_key, display_name, vector, model_id) VALUES ('music:chill', 'Chill', ${JSON.stringify(embeddings.audio)}::vector, 'msclap-2023') ON CONFLICT (mood_key, model_id) DO UPDATE SET vector = EXCLUDED.vector`;

    const neighborArtist = await item('artist', 'available-neighbor');
    const neighborAlbum = await item('album', 'available-neighbor', neighborArtist);
    const neighborTrack = await item('track', 'available-neighbor', neighborAlbum);
    Object.assign(ids, originals, { neighborArtist, neighborAlbum, neighborTrack });
    for (let index = 1; index <= 5; index++) {
        const extraMovie = await item('movie', `available-extra-${index}`);
        const extraArtist = await item('artist', `available-extra-${index}`);
        const extraAlbum = await item('album', `available-extra-${index}`, extraArtist);
        const extraTrack = await item('track', `available-extra-${index}`, extraAlbum);
        await sql`DELETE FROM user_music_state WHERE track_id = ${extraTrack}`;
        Object.assign(ids, originals, {
            [`extraMovie${index}`]: extraMovie,
            [`extraTrack${index}`]: extraTrack,
        });
    }
    ids.neighborTv = await item('tv', 'available-neighbor');
    const neighborSeason = await item('season', 'available-neighbor', ids.neighborTv);
    await item('episode', 'available-neighbor', neighborSeason);
    Object.assign(ids, originals);
    await sql`UPDATE media_items SET year = 2020 WHERE media_type = 'tv'`;
    await sql`UPDATE media_items SET premiere_date = CURRENT_DATE WHERE media_type = 'movie'`;
    // Keyword rails need multiple watched matches and at least five library candidates.
    await sql`UPDATE user_media_state SET is_watched = true WHERE media_id = ${ids.extraMovie4}`;
    await sql`DELETE FROM media_embeddings WHERE media_id = ${ids.extraMovie4}`;
    ids.keyword = 'heartwarming';
    await sql`UPDATE provider_metadata SET metadata = metadata || '{"mdblist_keywords":["friendship","heartwarming"],"keyword_slugs":["friendship","heartwarming"],"tmdb_keyword_ids":[10683]}'::jsonb`;
    await sql`UPDATE provider_metadata SET metadata = metadata || '{"mdblist_keywords":["anime","friendship","heartwarming"],"anime_genres":["Drama"]}'::jsonb WHERE media_id = ANY(${[ids.extraMovie1, ids.extraMovie3, ids.extraMovie4, ids.extraMovie5]}::uuid[]) OR metadata->>'original_language' = 'ja'`;
    for (const id of [ids.extraMovie3, ids.extraMovie4, ids.extraMovie5]) {
        await sql`INSERT INTO watch_history (user_id, media_id, title, media_type, session_start_time) SELECT ${userId}, id, title, media_type, NOW() FROM media_items WHERE id = ${id}`;
    }
    await sql`UPDATE media_items SET custom_metadata = jsonb_set(custom_metadata, '{essentia,energy}', '0.4') WHERE media_type = 'track'`;
    await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
        SELECT media_id, 'aggregated', metadata FROM provider_metadata WHERE provider = 'tmdb'
        ON CONFLICT (media_id, provider) DO UPDATE SET metadata = EXCLUDED.metadata`;
    // Hidden watched sources need library embeddings too: a discovery-only vector
    // or an unwatched row cannot exercise the source rail's availability gate.
    await sql`INSERT INTO media_embeddings (media_id, source, embedding)
        SELECT media_id, 'library', embedding FROM media_embeddings WHERE source = 'discovery'
        ON CONFLICT (media_id, source) DO NOTHING`;
    const [hiddenSource] = await sql<
        { id: string }[]
    >`SELECT id FROM media_items WHERE media_type = 'movie' AND NOT has_files AND NOT is_dismissed ORDER BY id LIMIT 1`;
    await sql`UPDATE user_media_state SET is_watched = true WHERE user_id = ${userId} AND media_id = ${hiddenSource.id}`;
    // Similarity music rails reject near-duplicates; identical vectors would prove nothing.
    const musical = await sql<
        { id: string }[]
    >`SELECT id FROM media_items WHERE media_type = 'track' ORDER BY id`;
    for (const [index, track] of musical.entries()) {
        const vector = [...embeddings.lyrics];
        vector[1] = track.id === originals.track ? 0 : 0.2 + index * 0.04;
        await sql`UPDATE media_embeddings SET embedding = ${JSON.stringify(vector)}::vector WHERE media_id = ${track.id} AND source = 'music'`;
    }
    for (let number = 3; number <= 6; number++)
        await item('episode', 'available', ids.season, number);
    Object.assign(ids, originals);
    await sql`DELETE FROM user_music_state WHERE track_id = ${neighborTrack}`;
    await cacheManager
        .for(CACHE_NAMESPACES.musicTasteStationSnapshots)
        .set(
            'snapshot:abcdef123456',
            { space: 'sonic', centroids: [embeddings.audio] },
            undefined,
            userId,
        );
    const next = await item('episode', 'available', ids.season, 2);
    ids.nextEpisode = next;
    await sql`UPDATE media_items SET premiere_date = CURRENT_DATE WHERE id = ${next}`;
    await sql`UPDATE user_music_state SET last_played_at = NOW() WHERE track_id = ${ids.track}`;
    await sql`UPDATE media_items SET premiere_date = CURRENT_DATE WHERE media_type = 'episode' AND premiere_date IS NULL`;
    // Keep the first episode as the regular search/list control.
    const first = await sql<
        { id: string }[]
    >`SELECT id FROM media_items WHERE parent_id = ${ids.season} AND episode_number = 1`;
    ids.episode = first[0].id;
    await sql`UPDATE user_media_state SET is_watched = true, resume_position_ms = 1200000 WHERE media_id = ${ids.episode}`;
    await sql`INSERT INTO user_ratings (user_id, media_id, rating) VALUES (${userId}, ${ids.extraMovie3}, 9)`;
    await sql`UPDATE user_media_state SET is_watched = true WHERE user_id = ${userId} AND media_id = ${ids.extraMovie3}`;
    await sql`UPDATE user_profiles SET catalog_embedding = ${JSON.stringify(embeddings.lyrics)}::vector WHERE user_id = ${userId}`;
    for (const listId of ['trending-movies', 'trending-shows', 'popular-shows', 'popular-movies']) {
        await sql`INSERT INTO cached_lists (list_id, name, list_path, item_count, last_synced_at) VALUES (${listId}, ${listId}, ${listId}, 5, NOW()) ON CONFLICT (list_id) DO UPDATE SET last_synced_at = NOW()`;
        for (const [rank, credit] of credits
            .filter((c) => c.type === (listId.endsWith('shows') ? 'tv' : 'movie'))
            .entries()) {
            await sql`INSERT INTO cached_list_items (list_id, media_id, rank) VALUES (${listId}, ${credit.id}, ${rank})`;
        }
    }
    await cacheManager.for(CACHE_NAMESPACES.personDetails).set('v2:person-details:9700999', {
        id: 9700999,
        name: 'Availguard Person',
        movieCredits: credits
            .filter((c) => c.type === 'movie')
            .map((c) => ({
                externalIds: { internal: c.id, tmdb: c.externalId },
                mediaType: 'movie',
                title: 'Availguard credit',
                isAvailable: true,
                canRequest: false,
            })),
        tvCredits: credits
            .filter((c) => c.type === 'tv')
            .map((c) => ({
                externalIds: { internal: c.id, tmdb: c.externalId },
                mediaType: 'series',
                title: 'Availguard credit',
                isAvailable: true,
                canRequest: false,
            })),
    });
    const [watchlist] = await sql<
        { id: number }[]
    >`INSERT INTO playlists (user_id, name, playlist_type, is_system) VALUES (${userId}, 'Watchlist', 'watchlist', true) RETURNING id`;
    const [playlist] = await sql<
        { id: number }[]
    >`INSERT INTO playlists (user_id, name, playlist_type) VALUES (${userId}, 'Availguard playlist', 'music') RETURNING id`;
    ids.playlist = String(playlist.id);
    ids.playlistSubsonic = 'playlist:' + playlist.id;
    ids.playlistJellyfin = playlistIdToUuid(playlist.id);
    for (const [position, row] of (
        await sql<
            { id: string; title: string; media_type: string }[]
        >`SELECT id, title, media_type FROM media_items`
    ).entries()) {
        const playlistId =
            row.media_type === 'track'
                ? playlist.id
                : ['movie', 'tv', 'audiobook'].includes(row.media_type)
                  ? watchlist.id
                  : null;
        if (playlistId)
            await sql`INSERT INTO playlist_items (playlist_id, media_id, title, "position") VALUES (${playlistId}, ${row.id}, ${row.title}, ${position})`;
    }
    await cacheManager.for(CACHE_NAMESPACES.curatedLists).set(
        'v1:items:trending-movies',
        credits
            .filter((c) => c.type === 'movie')
            .map((c, rank) => ({
                list_id: 'trending-movies',
                rank,
                internal_id: c.id,
                primary_ext_id: c.externalId,
                imdb_id: null,
                media_type: 'movie',
                title: 'Availguard curated movie',
                release_year: 2026,
                score: 8,
                poster_path: null,
                overview: null,
            })),
    );
    const originalAlbum = ids.album;
    const originalTrack = ids.track;
    ids.volumeAlbum = await item('album', 'available-volume', ids.artist);
    ids.volumeTrack = await item('track', 'available-volume', ids.volumeAlbum);
    await item('track', 'catalog', ids.volumeAlbum);
    ids.album = originalAlbum;
    ids.track = originalTrack;
    const albumVolumes = await sql<
        { id: string }[]
    >`SELECT id FROM media_items WHERE parent_id = ${ids.artist} AND media_type = 'album' ORDER BY has_files DESC, id`;
    for (const [index, album] of albumVolumes.entries())
        await sql`UPDATE media_items SET title = ${`Availguard Saga Vol. ${index + 1}`} WHERE id = ${album.id}`;
    // Retention leaves metadata/file links during its grace period.
    await sql`UPDATE media_items SET has_files = false WHERE id = ANY(${hidden}::uuid[])`;
    const savedTracks = (
        await sql<
            { id: string }[]
        >`SELECT id FROM media_items WHERE media_type = 'track' ORDER BY has_files, id`
    ).map((row) => row.id);
    await cacheSet(
        PLAY_QUEUE_CACHE_PREFIX + userId,
        JSON.stringify({
            entries: savedTracks,
            current: ids.track,
            currentIndex: savedTracks.indexOf(ids.track),
            changed: new Date().toISOString(),
        }),
        3600,
    );
    await cacheSet(
        BOOKMARK_CACHE_PREFIX + userId,
        JSON.stringify(
            Object.fromEntries(
                savedTracks.map((id) => [
                    id,
                    {
                        position: 1000,
                        created: new Date().toISOString(),
                        changed: new Date().toISOString(),
                    },
                ]),
            ),
        ),
        3600,
    );
    for (const type of [
        'movie',
        'tv',
        'season',
        'episode',
        'artist',
        'album',
        'track',
        'audiobook',
    ])
        expect(await isAvailable(sql, ids[type]), type).toBe(true);
    for (const id of hidden) expect(await isAvailable(sql, id), id).toBe(false);
}, 120000);

afterAll(async () => {
    vi.restoreAllMocks();
    await closeTestDb();
});

/** Read IDs from displayed records, excluding source/seed/reason metadata and URLs.
 * Otherwise a sourceAlbumId or "because you watched" seed makes an empty list
 * appear to contain its available control.
 */
function displayedIds(value: unknown, result = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
        for (const child of value) displayedIds(child, result);
    } else if (value && typeof value === 'object') {
        const row = value as Record<string, unknown>;
        const display =
            [
                'title',
                'name',
                'Name',
                'seriesName',
                'seriesTitle',
                'series_name',
                'label',
                'displayName',
            ].some((key) => typeof row[key] === 'string') || typeof row.rank === 'number';
        if (display) {
            const external = row.externalIds as Record<string, unknown> | undefined;
            for (const id of [
                row.id,
                row.Id,
                row.ItemId,
                row.catalogId,
                row.internalId,
                row.keyword,
                row.mediaId,
                row.media_id,
                row.album_id,
                row.seriesId,
                row.series_id,
                external?.internal,
            ]) {
                if (typeof id === 'string' || typeof id === 'number')
                    result.add(
                        String(id)
                            .replace(/^music-byl-/, '')
                            .replaceAll('-', '')
                            .toLowerCase(),
                    );
            }
        }
        for (const [key, child] of Object.entries(row)) {
            if (
                ![
                    'source',
                    'reason',
                    'seed',
                    'images',
                    'availability',
                    'progress',
                    'page',
                ].includes(key)
            )
                displayedIds(child, result);
        }
    }
    return result;
}

async function assertResponse(response: Response, spec: Surface): Promise<void> {
    const body: unknown = await response.json();
    const serialized = JSON.stringify(body).replaceAll('-', '').toLowerCase();
    const visible = displayedIds(body);
    if (spec.route === 'getPlayQueueByIndex') {
        const queue = (
            body as {
                'subsonic-response': {
                    playQueueByIndex: { entry: { id: string }[]; currentIndex: number };
                };
            }
        )['subsonic-response'].playQueueByIndex;
        expect(
            queue.entry[queue.currentIndex]?.id,
            'queue selection survives availability filtering',
        ).toBe(ids.track);
    }
    expect(response.status, JSON.stringify(body)).toBe(200);

    expect
        .soft(
            (body as { 'subsonic-response'?: { status: string } } | null)?.['subsonic-response']
                ?.status ?? 'ok',
        )
        .toBe('ok');
    for (const id of hidden)
        expect
            .soft(serialized.includes(id.replaceAll('-', '')), `${spec.route} leaked ${id}`)
            .toBe(false);
    // Provider IDs are unique in this fixture, so also reject external-only
    // handles that dropped their internal UUID during conversion.
    for (const id of hiddenProviderIds)
        expect.soft(serialized.includes(id), `${spec.route} leaked provider ID ${id}`).toBe(false);
    for (const type of spec.positive)
        expect
            .soft(visible, `${spec.route} must include available ${type}`)
            .toContain(ids[type].replaceAll('-', ''));
    if (spec.positiveOneOf)
        expect(
            spec.positiveOneOf.some((type) =>
                visible.has(ids[type].replaceAll('-', '').toLowerCase()),
            ),
            `${spec.route} needs an available control: ${JSON.stringify(body)}`,
        ).toBe(true);
    expect(
        spec.positive.length > 0 ||
            Boolean(spec.positiveOneOf?.length) ||
            Boolean(spec.emptyReason),
    ).toBe(true);
}

it('Jellyfin playlist ChildCount agrees with filtered contents', async () => {
    const route = '(modules)/j/Items';
    const handler = (await routeModules[`/src/routes/${route}/+server.ts`]()).GET!;
    const response = await handler(event(route, { IncludeItemTypes: 'Playlist', Limit: '100' }));
    const body = (await response.json()) as { Items: { Id: string; ChildCount: number }[] };
    const contentsRoute = '(modules)/j/Playlists/[playlistId]/Items';
    const contentsHandler = (await routeModules[`/src/routes/${contentsRoute}/+server.ts`]()).GET!;
    const readContents = async (): Promise<{ Items: unknown[]; TotalRecordCount: number }> => {
        const response = await contentsHandler(
            event(contentsRoute, { $playlistId: 'playlistJellyfin' }),
        );
        expect(response.status).toBe(200);
        return response.json();
    };
    const contents = await readContents();
    const count = contents.Items.length;
    expect(contents.TotalRecordCount).toBe(count);
    expect(count).toBeGreaterThan(0);
    expect(
        body.Items.find(
            (p) => p.Id.replaceAll('-', '') === ids.playlistJellyfin.replaceAll('-', ''),
        )?.ChildCount,
    ).toBe(count);
    const available = await sql<
        { id: string }[]
    >`SELECT mi.id FROM playlist_items pi JOIN media_items mi ON mi.id = pi.media_id WHERE pi.playlist_id = ${Number(ids.playlist)} AND mi.has_files`;
    try {
        await sql`UPDATE media_items SET has_files = false WHERE id = ANY(${available.map((r) => r.id)}::uuid[])`;
        expect(await readContents()).toMatchObject({ Items: [], TotalRecordCount: 0 });
        const empty = (await (
            await handler(event(route, { IncludeItemTypes: 'Playlist', Limit: '100' }))
        ).json()) as typeof body;
        expect(
            empty.Items.find(
                (p) => p.Id.replaceAll('-', '') === ids.playlistJellyfin.replaceAll('-', ''),
            )?.ChildCount,
        ).toBe(0);
    } finally {
        await sql`UPDATE media_items SET has_files = true WHERE id = ANY(${available.map((r) => r.id)}::uuid[])`;
    }
});

describe('unavailable media never surfaces (real DB, normal user, library-only discovery)', () => {
    for (const spec of expandAliases(surfaces)) {
        it(`${spec.route} ${JSON.stringify(spec.query ?? {})}`, async () => {
            const load = routeModules[`/src/routes/${spec.route}/+server.ts`];
            expect(load, 'surface must exist in route registry').toBeDefined();
            const handler = (await load())[spec.method ?? 'GET'];
            expect(handler).toBeTypeOf('function');
            await assertResponse(
                await handler!(event(spec.route, spec.query, spec.method, spec.body)),
                spec,
            );
        });
    }
    for (const spec of subsonicSurfaces) {
        it(`Subsonic ${spec.route} ${JSON.stringify(spec.query ?? {})}`, async () => {
            const name = 'handle' + spec.route[0].toUpperCase() + spec.route.slice(1);
            let handler: SubsonicHandler | undefined;
            for (const [path, load] of Object.entries(subsonicModules)) {
                if (path.includes('.test.')) continue;
                const module = await load();
                if (module[name]) {
                    handler = module[name];
                    break;
                }
            }
            expect(handler).toBeTypeOf('function');
            const auth: SubsonicAuthContext = {
                userId,
                username: user.username,
                ownerIsAdmin: false,
                displayName: null,
                clientName: 'availguard',
                format: 'json',
                userGroups: [],
                maxAgeRating: null,
                isAgeRestricted: false,
            };
            let response = await handler!(
                event('subsonic/rest/' + spec.route, spec.query),
                auth,
                sql,
            );
            // BERNOULLI(20) may select no rows in a one-track fixture. Exercise
            // real sampling until the available control is selected.
            if (spec.route === 'getRandomSongs') {
                for (let attempt = 0; attempt < 100; attempt++) {
                    await assertResponse(response.clone(), {
                        ...spec,
                        positive: [],
                        emptyReason: 'Sampling attempt',
                    });
                    if ((await response.clone().text()).includes(ids.track)) break;
                    response = await handler!(
                        event('subsonic/rest/' + spec.route, spec.query),
                        auth,
                        sql,
                    );
                }
            }
            await assertResponse(response, spec);
        });
    }
});
