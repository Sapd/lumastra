// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
/**
 * Contract suite phase 2: multi-part movies, music, Live TV, search, display
 * preferences and media segments, through the real /j route handlers over real
 * PG + Valkey.
 *
 * Live TV runs the real DB-backed StandaloneLiveTvProvider over seeded rows. Only
 * the factory is replaced: it hands out that provider only when STREAM_PROXY_URL
 * is set, and the guide routes never talk to the proxy.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../integration/setup/test-database.js';
import { config } from '$lib/server/config';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { playbackTelemetryService } from '$lib/server/services/playback-telemetry.service.js';
import { truncateTables, TEST_TABLES } from '../integration/helpers/cleanup.js';
import { ensureTestUser } from '../integration/fixtures/user.fixtures.js';
import { callAndCheck, jfEvent, mintJfSession, type RouteHandler } from './harness';
import {
    LIVETV_TABLES,
    seedEpisodeExternalSrt,
    seedLiveTv,
    seedMovieEmbeddedSubs,
    seedMultiPartMovie,
    seedMusicAlbum,
    seedSegments,
} from './seed';
import { GET as itemGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/+server';
import { GET as userItemGet } from '../../src/routes/(proprietary)/j/Users/[userId]/Items/[itemId]/+server';
import { POST as playbackInfoPost } from '../../src/routes/(proprietary)/j/Items/[itemId]/PlaybackInfo/+server';
import { GET as userItemsGet } from '../../src/routes/(proprietary)/j/Users/[userId]/Items/+server';
import { GET as liveTvChannelsGet } from '../../src/routes/(proprietary)/j/LiveTv/Channels/+server';
import {
    GET as liveTvProgramsGet,
    POST as liveTvProgramsPost,
} from '../../src/routes/(proprietary)/j/LiveTv/Programs/+server';
import { GET as liveTvProgramGet } from '../../src/routes/(proprietary)/j/LiveTv/Programs/[programId]/+server';
import { GET as liveTvRecommendedGet } from '../../src/routes/(proprietary)/j/LiveTv/Programs/Recommended/+server';
import { GET as liveTvChannelGet } from '../../src/routes/(proprietary)/j/LiveTv/Channels/[channelId]/+server';
import { GET as liveTvInfoGet } from '../../src/routes/(proprietary)/j/LiveTv/Info/+server';
import { GET as liveTvGuideInfoGet } from '../../src/routes/(proprietary)/j/LiveTv/GuideInfo/+server';
import { GET as liveTvRecordingsGet } from '../../src/routes/(proprietary)/j/LiveTv/Recordings/+server';
import { GET as liveTvRecordingsSeriesGet } from '../../src/routes/(proprietary)/j/LiveTv/Recordings/Series/+server';
import { GET as liveTvRecordingsGroupsGet } from '../../src/routes/(proprietary)/j/LiveTv/Recordings/Groups/+server';
import { GET as liveTvRecordingsFoldersGet } from '../../src/routes/(proprietary)/j/LiveTv/Recordings/Folders/+server';
import { GET as liveTvTimersGet } from '../../src/routes/(proprietary)/j/LiveTv/Timers/+server';
import { GET as liveTvTimerDefaultsGet } from '../../src/routes/(proprietary)/j/LiveTv/Timers/Defaults/+server';
import { GET as liveTvSeriesTimersGet } from '../../src/routes/(proprietary)/j/LiveTv/SeriesTimers/+server';
import { POST as liveStreamsOpenPost } from '../../src/routes/(proprietary)/j/LiveStreams/Open/+server';
import { StandaloneLiveTvProvider } from '$lib/server/services/livetv/standalone-livetv-provider';
import { GET as searchHintsGet } from '../../src/routes/(proprietary)/j/Search/Hints/+server';
import { GET as userSettingsGet } from '../../src/routes/(proprietary)/j/DisplayPreferences/usersettings/+server';
import { GET as mediaSegmentsGet } from '../../src/routes/(proprietary)/j/MediaSegments/[itemId]/+server';
import { GET as additionalPartsGet } from '../../src/routes/(proprietary)/j/Videos/[itemId]/AdditionalParts/+server';
import { POST as playingPost } from '../../src/routes/(proprietary)/j/Sessions/Playing/+server';
import { POST as progressPost } from '../../src/routes/(proprietary)/j/Sessions/Playing/Progress/+server';
import { POST as stoppedPost } from '../../src/routes/(proprietary)/j/Sessions/Playing/Stopped/+server';

vi.mock('$lib/server/services/livetv/index', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/services/livetv/index')>();
    const { StandaloneLiveTvProvider } =
        await import('$lib/server/services/livetv/standalone-livetv-provider');
    return {
        ...actual,
        // A fresh provider per call: its in-memory channel/guide caches must not
        // carry one test's rows into the next.
        getLiveTvProvider: async () => new StandaloneLiveTvProvider(),
    };
});

const USER_ID = '00000000-0000-4000-8000-00000000c0de';
// Live TV needs hasLiveTvPermission; a pinned admin has it without touching config groups.
const LIVETV_USER_ID = '00000000-0000-4000-8000-00000000c0e0';
let sql: postgres.Sql;
let token: string;
let username: string;

const VIDEO_PROFILE = {
    MaxStreamingBitrate: 120000000,
    DirectPlayProfiles: [
        { Container: 'mkv,mp4', Type: 'Video', VideoCodec: 'h264,hevc', AudioCodec: 'aac,eac3' },
    ],
    TranscodingProfiles: [
        {
            Container: 'ts',
            Type: 'Video',
            VideoCodec: 'h264',
            AudioCodec: 'aac',
            Protocol: 'hls',
            Context: 'Streaming',
        },
    ],
    SubtitleProfiles: [{ Format: 'srt', Method: 'External' }],
};

// jellyfin-androidtv's audio profile shape: direct-play common codecs, else AAC/MP3 HLS.
const AUDIO_PROFILE = {
    MaxStreamingBitrate: 120000000,
    DirectPlayProfiles: [{ Container: 'mp3,flac,m4a,ogg', Type: 'Audio' }],
    TranscodingProfiles: [
        {
            Container: 'mp3',
            Type: 'Audio',
            AudioCodec: 'mp3',
            Protocol: 'http',
            Context: 'Streaming',
        },
    ],
};

beforeAll(async () => {
    sql = getTestDb();
    // /j sessions live in Valkey; the client connects only on demand.
    if (!(await connectValkey())) throw new Error('Valkey not reachable (CACHE_URL)');
});
afterAll(async () => {
    await playbackTelemetryService.settleBackgroundWork();
    await disconnectValkey();
    await closeTestDb();
});
beforeEach(async () => {
    // Sessions/Playing/Stopped scores the session in the background (Phase 2 runs
    // BEACON_WAIT_MS later, inside the next test). Its transaction reads
    // playback_telemetry then play_sessions; the TRUNCATE CASCADE takes those
    // locks the other way round, so it has to finish before the reset.
    await playbackTelemetryService.settleBackgroundWork();
    await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData, ...LIVETV_TABLES]);
    await sql`
        UPDATE play_sessions SET status = 'COMPLETED', stopped_at = now()
        WHERE status IN ('ACTIVE', 'PAUSED')`;
    await ensureTestUser(sql, USER_ID);
    [{ username }] = await sql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${USER_ID}`;
    token = await mintJfSession(sql, { userId: USER_ID, username });
});

function get(
    name: string,
    kotlinClass: string,
    handler: RouteHandler,
    path: string,
    params: Record<string, string> = {},
    as: string = token,
): Promise<unknown> {
    return callAndCheck(
        name,
        kotlinClass,
        handler,
        jfEvent({ method: 'GET', path, token: as, params }),
    );
}

interface PartSource {
    Id: string;
    Path?: string;
    RunTimeTicks?: number;
}
interface PartItem {
    Id: string;
    PartCount?: number;
    RunTimeTicks?: number;
    MediaSources: PartSource[];
}

describe('/j multi-part movie contract', () => {
    // Jellyfin's shape (DtoService PartCount, VideosController.GetAdditionalPart):
    // the movie lists part 1 only and carries PartCount; parts 2..N are items of
    // their own (id = the part's file id) from /Videos/{id}/AdditionalParts.
    // jellyfin-androidtv then queues [movie, ...AdditionalParts] instead of
    // offering the parts as alternative versions.
    it('Items/{id}, PlaybackInfo and AdditionalParts for a two-file movie', async () => {
        const { itemId, fileIds } = await seedMultiPartMovie(sql);
        const item = (await get('item-multipart', 'BaseItemDto', itemGet, `/j/Items/${itemId}`, {
            itemId,
        })) as PartItem;
        expect(item.PartCount).toBe(2);
        expect(item.MediaSources.map((m) => m.Id)).toEqual([fileIds[0]]);
        expect(item.MediaSources[0].Path).toMatch(/part1\.mkv$/);

        const info = (await callAndCheck(
            'playbackinfo-multipart',
            'PlaybackInfoResponse',
            playbackInfoPost,
            jfEvent({
                method: 'POST',
                path: `/j/Items/${itemId}/PlaybackInfo`,
                token,
                params: { itemId },
                body: { DeviceProfile: VIDEO_PROFILE, UserId: USER_ID },
            }),
        )) as { MediaSources: PartSource[] };
        // PlaybackInfo mints its own per-session source ids, so compare paths, not ids.
        expect(info.MediaSources.map((m) => m.Path)).toEqual([item.MediaSources[0].Path]);
        expect(info.MediaSources[0].RunTimeTicks).toBe(2700 * 10_000_000);

        const parts = (await get(
            'additional-parts',
            'BaseItemDtoQueryResult',
            additionalPartsGet,
            `/j/Videos/${itemId}/AdditionalParts`,
            { itemId },
        )) as { Items: PartItem[]; TotalRecordCount: number };
        expect(parts.TotalRecordCount).toBe(1);
        expect(parts.Items.map((p) => p.Id)).toEqual([fileIds[1]]);
        expect(parts.Items[0].PartCount).toBeUndefined();
        expect(parts.Items[0].MediaSources.map((m) => m.Path)).toEqual([
            expect.stringMatching(/part2\.mkv$/),
        ]);
        // Part 2's own length, not the movie's or part 1's.
        expect(parts.Items[0].RunTimeTicks).toBe(2400 * 10_000_000);
        expect(parts.Items[0].MediaSources[0].RunTimeTicks).toBe(2400 * 10_000_000);

        // The queued part, as the app then fetches and plays it by its own id.
        const part = (await get('item-part2', 'BaseItemDto', itemGet, `/j/Items/${fileIds[1]}`, {
            itemId: fileIds[1],
        })) as PartItem;
        expect(part.Id).toBe(fileIds[1]);
        expect(part.PartCount).toBeUndefined();
        expect(part.MediaSources.map((m) => m.Id)).toEqual([fileIds[1]]);
        const partInfo = (await callAndCheck(
            'playbackinfo-part2',
            'PlaybackInfoResponse',
            playbackInfoPost,
            jfEvent({
                method: 'POST',
                path: `/j/Items/${fileIds[1]}/PlaybackInfo`,
                token,
                params: { itemId: fileIds[1] },
                body: { DeviceProfile: VIDEO_PROFILE, UserId: USER_ID },
            }),
        )) as { MediaSources: PartSource[] };
        expect(partInfo.MediaSources.map((m) => m.Path)).toEqual([part.MediaSources[0].Path]);
        expect(partInfo.MediaSources[0].RunTimeTicks).toBe(2400 * 10_000_000);

        // An item cached from before the split names part 2 as a source of the movie.
        const staleInfo = (await callAndCheck(
            'playbackinfo-movie-part2-source',
            'PlaybackInfoResponse',
            playbackInfoPost,
            jfEvent({
                method: 'POST',
                path: `/j/Items/${itemId}/PlaybackInfo`,
                token,
                params: { itemId },
                body: { DeviceProfile: VIDEO_PROFILE, UserId: USER_ID, MediaSourceId: fileIds[1] },
            }),
        )) as { MediaSources: PartSource[] };
        expect(staleInfo.MediaSources.map((m) => m.Path)).toEqual([part.MediaSources[0].Path]);

        // Part 2 has no further parts; the file id of part 1 answers for its stack.
        const none = (await get(
            'additional-parts-of-part2',
            'BaseItemDtoQueryResult',
            additionalPartsGet,
            `/j/Videos/${fileIds[1]}/AdditionalParts`,
            { itemId: fileIds[1] },
        )) as { Items: PartItem[] };
        expect(none.Items).toEqual([]);
        const viaPart1 = (await get(
            'additional-parts-of-part1',
            'BaseItemDtoQueryResult',
            additionalPartsGet,
            `/j/Videos/${fileIds[0]}/AdditionalParts`,
            { itemId: fileIds[0] },
        )) as { Items: PartItem[] };
        expect(viaPart1.Items.map((p) => p.Id)).toEqual([fileIds[1]]);

        for (const bad of ['not-a-uuid', '00000000-0000-4000-8000-0000000bad00']) {
            const res = await (additionalPartsGet as unknown as (e: unknown) => Promise<Response>)(
                jfEvent({
                    method: 'GET',
                    path: `/j/Videos/${bad}/AdditionalParts`,
                    token,
                    params: { itemId: bad },
                }),
            );
            expect(res.status, bad).toBe(404);
        }
    });

    it('browse lists show part 1 only with PartCount, like Items/{id}', async () => {
        const { itemId, fileIds } = await seedMultiPartMovie(sql);
        const list = (await callAndCheck(
            'user-items-multipart',
            'BaseItemDtoQueryResult',
            userItemsGet,
            jfEvent({
                method: 'GET',
                path: `/j/Users/${USER_ID}/Items?Ids=${itemId}&Fields=MediaSources`,
                token,
                params: { userId: USER_ID },
            }),
            { legacySchema: 'BaseItemDtoQueryResult' },
        )) as { Items: PartItem[] };
        const movie = list.Items.find((i) => i.Id === itemId);
        expect(movie?.PartCount).toBe(2);
        expect(movie?.MediaSources.map((m) => m.Id)).toEqual([fileIds[0]]);
    });

    it('positions reported on part 2 are saved on the movie after part 1', async () => {
        const { itemId, fileIds } = await seedMultiPartMovie(sql);
        const report = async (handler: unknown, path: string, seconds: number): Promise<number> => {
            const res = await (handler as (e: unknown) => Promise<Response>)(
                jfEvent({
                    method: 'POST',
                    path,
                    token,
                    params: {},
                    body: {
                        ItemId: fileIds[1],
                        PositionTicks: seconds * 10_000_000,
                        PlaySessionId: 'contract-part2',
                    },
                }),
            );
            expect(res.status, path).toBe(204);
            const [row] = await sql<{ position_ms: number }[]>`
                SELECT position_ms FROM play_sessions
                WHERE media_id = ${itemId} ORDER BY started_at DESC LIMIT 1`;
            return Number(row?.position_ms);
        };
        expect(await report(playingPost, '/j/Sessions/Playing', 60)).toBe((2700 + 60) * 1000);
        expect(await report(progressPost, '/j/Sessions/Playing/Progress', 120)).toBe(
            (2700 + 120) * 1000,
        );
        // Past the part's end (buffered tail): clamped to the part, never into the next.
        expect(await report(progressPost, '/j/Sessions/Playing/Progress', 2500)).toBe(
            (2700 + 2400) * 1000,
        );
        expect(await report(stoppedPost, '/j/Sessions/Playing/Stopped', 300)).toBe(
            (2700 + 300) * 1000,
        );
    });
});

interface MusicItem {
    Artists?: string[];
    ArtistItems?: { Name: string; Id: string }[];
    AlbumArtist?: string;
    AlbumArtists?: { Name: string; Id: string }[];
    Album?: string;
    AlbumId?: string;
}

describe('/j music contract', () => {
    it('Items/{trackId}, album track list and audio PlaybackInfo POST', async () => {
        const { artistId, albumId, trackId } = await seedMusicAlbum(sql);
        const track = (await get('item-track', 'BaseItemDto', itemGet, `/j/Items/${trackId}`, {
            itemId: trackId,
        })) as MusicItem;
        // Jellyfin apps render the artist line from these; empty = no artist shown.
        expect(track.Artists).toEqual(['Contract Artist']);
        expect(track.ArtistItems).toEqual([{ Name: 'Contract Artist', Id: artistId }]);
        expect(track.AlbumArtist).toBe('Contract Artist');
        expect(track.AlbumArtists).toEqual([{ Name: 'Contract Artist', Id: artistId }]);
        expect(track.Album).toBe('Contract Album');
        expect(track.AlbumId).toBe(albumId);
        const album = (await get('item-album', 'BaseItemDto', itemGet, `/j/Items/${albumId}`, {
            itemId: albumId,
        })) as MusicItem;
        expect(album.Artists).toEqual(['Contract Artist']);
        expect(album.AlbumArtist).toBe('Contract Artist');
        expect(album.AlbumArtists).toEqual([{ Name: 'Contract Artist', Id: artistId }]);
        const tracks = (await callAndCheck(
            'user-items-album-tracks',
            'BaseItemDtoQueryResult',
            userItemsGet,
            jfEvent({
                method: 'GET',
                path: `/j/Users/${USER_ID}/Items?ParentId=${albumId}&SortBy=ParentIndexNumber,IndexNumber,SortName&Fields=MediaSources,ItemCounts`,
                token,
                params: { userId: USER_ID },
            }),
            { legacySchema: 'BaseItemDtoQueryResult' },
        )) as { Items: MusicItem[] };
        expect(tracks.Items.length).toBeGreaterThan(0);
        for (const t of tracks.Items) {
            expect(t.Artists?.length).toBeGreaterThan(0);
            expect(t.ArtistItems?.[0]?.Id).toBe(artistId);
            expect(t.AlbumArtist).toBe('Contract Artist');
        }
        await callAndCheck(
            'playbackinfo-audio',
            'PlaybackInfoResponse',
            playbackInfoPost,
            jfEvent({
                method: 'POST',
                path: `/j/Items/${trackId}/PlaybackInfo`,
                token,
                params: { itemId: trackId },
                body: { DeviceProfile: AUDIO_PROFILE, UserId: USER_ID },
            }),
        );
    });
});

interface LiveTvMetadataItem {
    Id: string;
    MediaSources: Array<{ Id: string; MediaStreams: unknown[] }>;
}

function expectLiveTvMetadata(item: LiveTvMetadataItem): void {
    expect(item.MediaSources).toHaveLength(1);
    expect(item.MediaSources[0]).toMatchObject({ Id: item.Id, MediaStreams: [] });
    for (const field of ['Path', 'DirectStreamUrl', 'TranscodingUrl', 'LiveStreamId']) {
        expect(item.MediaSources[0]).not.toHaveProperty(field);
    }
}

describe('/j Live TV contract', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });
    let liveToken: string;
    let channelIds: [string, string];
    let programIds: string[];

    beforeEach(async () => {
        // Live TV is hidden from every viewer while the feature is off (the default).
        vi.spyOn(config, 'FEATURE_LIVETV', 'get').mockReturnValue(true);
        await ensureTestUser(sql, LIVETV_USER_ID);
        await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${LIVETV_USER_ID}`;
        const [{ username: liveUser }] = await sql<{ username: string }[]>`
            SELECT username FROM users WHERE id = ${LIVETV_USER_ID}`;
        liveToken = await mintJfSession(sql, { userId: LIVETV_USER_ID, username: liveUser });
        ({ channelIds, programIds } = await seedLiveTv(sql, LIVETV_USER_ID));
    });

    it('LiveTv/Channels', async () => {
        const body = (await get(
            'livetv-channels',
            'BaseItemDtoQueryResult',
            liveTvChannelsGet,
            `/j/LiveTv/Channels?UserId=${LIVETV_USER_ID}&EnableFavoriteSorting=true&AddCurrentProgram=true`,
            {},
            liveToken,
        )) as { Items: LiveTvMetadataItem[] };
        expect(body.Items).toHaveLength(2);
        body.Items.forEach(expectLiveTvMetadata);
    });

    it('LiveTv/Programs', async () => {
        const body = (await get(
            'livetv-programs',
            'BaseItemDtoQueryResult',
            liveTvProgramsGet,
            `/j/LiveTv/Programs?UserId=${LIVETV_USER_ID}&ChannelIds=${channelIds.join(',')}&EnableImages=true`,
            {},
            liveToken,
        )) as { Items: unknown[] };
        expect(body.Items.length).toBeGreaterThan(0);
    });

    it('LiveTv/Programs (POST GetProgramsDto with filters)', async () => {
        const body = (await callAndCheck(
            'livetv-programs-post',
            'BaseItemDtoQueryResult',
            liveTvProgramsPost,
            jfEvent({
                method: 'POST',
                path: '/j/LiveTv/Programs',
                token: liveToken,
                params: {},
                body: {
                    ChannelIds: channelIds,
                    HasAired: false,
                    IsNews: true,
                    Genres: ['News'],
                    SortBy: ['StartDate'],
                    SortOrder: ['Descending'],
                    EnableTotalRecordCount: true,
                },
            }),
        )) as { Items: unknown[]; TotalRecordCount: number };
        expect(body.TotalRecordCount).toBe(4);
    });

    it('LiveTv/Programs/{programId}', async () => {
        const body = (await get(
            'livetv-program',
            'BaseItemDto',
            liveTvProgramGet,
            `/j/LiveTv/Programs/${programIds[0]}?UserId=${LIVETV_USER_ID}`,
            { programId: programIds[0] },
            liveToken,
        )) as { Id: string; Type: string };
        expect(body).toMatchObject({ Id: programIds[0], Type: 'Program' });
    });

    it('LiveTv/Programs/Recommended (on now)', async () => {
        const body = (await get(
            'livetv-programs-recommended',
            'BaseItemDtoQueryResult',
            liveTvRecommendedGet,
            `/j/LiveTv/Programs/Recommended?UserId=${LIVETV_USER_ID}&IsAiring=true&Limit=10&EnableTotalRecordCount=false`,
            {},
            liveToken,
        )) as { Items: unknown[] };
        expect(body.Items).toHaveLength(2);
    });

    it('LiveTv/Channels/{channelId}', async () => {
        const body = (await get(
            'livetv-channel',
            'BaseItemDto',
            liveTvChannelGet,
            `/j/LiveTv/Channels/${channelIds[0]}?UserId=${LIVETV_USER_ID}`,
            { channelId: channelIds[0] },
            liveToken,
        )) as {
            Id: string;
            CurrentProgram?: unknown;
            MediaSources: Array<{ Id: string; MediaStreams: unknown[] }>;
        };
        expect(body.Id).toBe(channelIds[0]);
        expect(body.CurrentProgram).toBeDefined();
        expect(body.MediaSources).toHaveLength(1);
        expect(body.MediaSources[0]).toMatchObject({ Id: channelIds[0], MediaStreams: [] });
        expect(body.MediaSources[0]).not.toHaveProperty('TranscodingUrl');
        expect(body.MediaSources[0]).not.toHaveProperty('LiveStreamId');
    });

    it('LiveTv/Info', async () => {
        const body = (await get(
            'livetv-info',
            'LiveTvInfo',
            liveTvInfoGet,
            '/j/LiveTv/Info',
            {},
            liveToken,
        )) as { IsEnabled: boolean };
        expect(body.IsEnabled).toBe(true);
    });

    it('LiveTv/GuideInfo', async () => {
        await get(
            'livetv-guideinfo',
            'GuideInfo',
            liveTvGuideInfoGet,
            '/j/LiveTv/GuideInfo',
            {},
            liveToken,
        );
    });

    it('LiveTv DVR: empty recordings and timers', async () => {
        const cases: Array<[string, string, RouteHandler, string]> = [
            [
                'livetv-recordings',
                'BaseItemDtoQueryResult',
                liveTvRecordingsGet,
                '/j/LiveTv/Recordings',
            ],
            [
                'livetv-recordings-series',
                'BaseItemDtoQueryResult',
                liveTvRecordingsSeriesGet,
                '/j/LiveTv/Recordings/Series',
            ],
            [
                'livetv-recordings-groups',
                'BaseItemDtoQueryResult',
                liveTvRecordingsGroupsGet,
                '/j/LiveTv/Recordings/Groups',
            ],
            [
                'livetv-recordings-folders',
                'BaseItemDtoQueryResult',
                liveTvRecordingsFoldersGet,
                '/j/LiveTv/Recordings/Folders',
            ],
            ['livetv-timers', 'TimerInfoDtoQueryResult', liveTvTimersGet, '/j/LiveTv/Timers'],
            [
                'livetv-series-timers',
                'SeriesTimerInfoDtoQueryResult',
                liveTvSeriesTimersGet,
                '/j/LiveTv/SeriesTimers',
            ],
        ];
        for (const [name, kotlinClass, handler, path] of cases) {
            const body = (await get(name, kotlinClass, handler, path, {}, liveToken)) as {
                TotalRecordCount: number;
            };
            expect(body.TotalRecordCount).toBe(0);
        }
    });

    it('LiveTv/Timers/Defaults (with a programId)', async () => {
        const body = (await get(
            'livetv-timer-defaults',
            'SeriesTimerInfoDto',
            liveTvTimerDefaultsGet,
            `/j/LiveTv/Timers/Defaults?programId=${programIds[0]}`,
            {},
            liveToken,
        )) as { ChannelId: string };
        expect(body.ChannelId).toBe(channelIds[0]);
    });

    it('LiveStreams/Open', async () => {
        // The guide routes never reach the stream proxy; Open joins a viewer, so
        // stand in for the proxy's join here.
        const join = vi
            .spyOn(StandaloneLiveTvProvider.prototype, 'getStreamInfo')
            .mockResolvedValue({} as never);
        try {
            // Android TV loads these detail surfaces before PlaybackInfo.
            // None may open a provider or consume a stream slot.
            const details: Array<[string, RouteHandler, string, Record<string, string>]> = [
                [
                    'channel',
                    liveTvChannelGet,
                    `/j/LiveTv/Channels/${channelIds[0]}`,
                    { channelId: channelIds[0] },
                ],
                ['item', itemGet, `/j/Items/${channelIds[0]}`, { itemId: channelIds[0] }],
                [
                    'user-item',
                    userItemGet,
                    `/j/Users/${LIVETV_USER_ID}/Items/${channelIds[0]}`,
                    { userId: LIVETV_USER_ID, itemId: channelIds[0] },
                ],
            ];
            for (const [name, handler, path, params] of details) {
                const metadata = (await callAndCheck(
                    `livetv-source-${name}`,
                    'BaseItemDto',
                    handler,
                    jfEvent({ method: 'GET', path, params, token: liveToken }),
                    // This older user-scoped route is absent from the current SDK route map.
                    name === 'user-item' ? { legacySchema: 'BaseItemDto' } : {},
                )) as LiveTvMetadataItem;
                expectLiveTvMetadata(metadata);
                expect(join).not.toHaveBeenCalled();
            }
            const body = (await callAndCheck(
                'livestreams-open',
                'LiveStreamResponse',
                liveStreamsOpenPost,
                jfEvent({
                    method: 'POST',
                    path: `/j/LiveStreams/Open?ItemId=${channelIds[0]}`,
                    token: liveToken,
                    params: {},
                    body: { ItemId: channelIds[0], UserId: LIVETV_USER_ID },
                }),
            )) as { MediaSource: { Id: string; IsLiveTv: boolean } };
            expect(body.MediaSource).toMatchObject({ Id: channelIds[0], IsLiveTv: true });
            expect(join).toHaveBeenCalledOnce();
        } finally {
            join.mockRestore();
        }
    });
});

describe('/j search, preferences and segments contract', () => {
    it('Search/Hints (a movie and a series match)', async () => {
        await seedMovieEmbeddedSubs(sql);
        const { seriesId } = await seedEpisodeExternalSrt(sql);
        await sql`UPDATE media_items SET has_files = true WHERE id = ${seriesId}`;
        const body = (await get(
            'search-hints',
            'SearchHintResult',
            searchHintsGet,
            `/j/Search/Hints?searchTerm=Contract&UserId=${USER_ID}&Limit=20`,
        )) as { SearchHints: { Type: string }[] };
        expect(body.SearchHints.map((h) => h.Type).sort()).toEqual(['Movie', 'Series']);
    });

    it('Search/Hints returns music (Audio, MusicAlbum, MusicArtist)', async () => {
        await seedMovieEmbeddedSubs(sql);
        const { artistId, albumId, trackId } = await seedMusicAlbum(sql);
        type Hint = {
            Id: string;
            Type: string;
            Album?: string;
            AlbumArtist?: string;
            Artists: string[];
        };

        // Audio only: tracks match through their album/artist names.
        const audio = (await get(
            'search-hints-audio',
            'SearchHintResult',
            searchHintsGet,
            `/j/Search/Hints?searchTerm=Contract&IncludeItemTypes=Audio&UserId=${USER_ID}&Limit=20`,
        )) as { SearchHints: Hint[] };
        expect(audio.SearchHints.length).toBe(2);
        expect(new Set(audio.SearchHints.map((h) => h.Type))).toEqual(new Set(['Audio']));
        const track = audio.SearchHints.find((h) => h.Id === trackId);
        expect(track).toMatchObject({
            Album: 'Contract Album',
            AlbumArtist: 'Contract Artist',
            Artists: ['Contract Artist'],
        });

        // No IncludeItemTypes = every type, like Jellyfin's SearchEngine.
        const all = (await get(
            'search-hints-all',
            'SearchHintResult',
            searchHintsGet,
            `/j/Search/Hints?searchTerm=Contract&UserId=${USER_ID}&Limit=20`,
        )) as { SearchHints: Hint[] };
        expect(all.SearchHints.map((h) => h.Type).sort()).toEqual([
            'Audio',
            'Audio',
            'Movie',
            'MusicAlbum',
            'MusicArtist',
        ]);
        expect(all.SearchHints.map((h) => h.Id)).toEqual(
            expect.arrayContaining([artistId, albumId, trackId]),
        );

        // Video-only requests stay video-only.
        const movies = (await get(
            'search-hints-movie',
            'SearchHintResult',
            searchHintsGet,
            `/j/Search/Hints?searchTerm=Contract&IncludeItemTypes=Movie&UserId=${USER_ID}&Limit=20`,
        )) as { SearchHints: Hint[] };
        expect(movies.SearchHints.map((h) => h.Type)).toEqual(['Movie']);
    });

    it('DisplayPreferences/usersettings?client=emby', async () => {
        await get(
            'displayprefs-usersettings',
            'DisplayPreferencesDto',
            userSettingsGet,
            `/j/DisplayPreferences/usersettings?userId=${USER_ID}&client=emby`,
        );
    });

    it('MediaSegments/{itemId}', async () => {
        const { itemId } = await seedMovieEmbeddedSubs(sql);
        await seedSegments(sql, itemId);
        const body = (await get(
            'media-segments',
            'MediaSegmentDtoQueryResult',
            mediaSegmentsGet,
            `/j/MediaSegments/${itemId}`,
            { itemId },
        )) as { Items: unknown[] };
        expect(body.Items).toHaveLength(2);
    });
});
