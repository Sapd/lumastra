// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect } from 'vitest';
import {
    mapBrowseStreamRow,
    mapMediaType,
    mapRowToMediaItem,
    serializeBaseItem,
    serializeBaseItems,
    streamRowToJellyfin,
} from './base-item';
import type { MediaItemForSerialization } from './base-item';
import type { MediaStreamRow } from '$lib/server/database/queries/media-streams.queries';

// ============================================================================
// mapMediaType
// ============================================================================

describe('mapMediaType', () => {
    it("maps 'movie' to 'Movie'", () => {
        expect(mapMediaType('movie')).toBe('Movie');
    });

    it("maps 'tv' to 'Series'", () => {
        expect(mapMediaType('tv')).toBe('Series');
    });

    it("maps 'series' to 'Series'", () => {
        expect(mapMediaType('series')).toBe('Series');
    });

    it("maps 'episode' to 'Episode'", () => {
        expect(mapMediaType('episode')).toBe('Episode');
    });

    it("maps 'season' to 'Season'", () => {
        expect(mapMediaType('season')).toBe('Season');
    });

    it("maps 'track' to 'Audio'", () => {
        expect(mapMediaType('track')).toBe('Audio');
    });

    it("maps 'music' to 'Audio'", () => {
        expect(mapMediaType('music')).toBe('Audio');
    });

    it("maps 'audio' to 'Audio'", () => {
        expect(mapMediaType('audio')).toBe('Audio');
    });

    it("maps 'album' to 'MusicAlbum'", () => {
        expect(mapMediaType('album')).toBe('MusicAlbum');
    });

    it("maps 'artist' to 'MusicArtist'", () => {
        expect(mapMediaType('artist')).toBe('MusicArtist');
    });

    it('falls back to Video for unknown types', () => {
        expect(mapMediaType('unknown')).toBe('Video');
        expect(mapMediaType('foo')).toBe('Video');
    });

    it("maps 'MOVIE' (uppercase) to 'Movie'", () => {
        expect(mapMediaType('MOVIE')).toBe('Movie');
    });

    it("maps 'Movie' (PascalCase) to 'Movie'", () => {
        expect(mapMediaType('Movie')).toBe('Movie');
    });

    it('handles null/undefined gracefully via default branch', () => {
        // null?.toLowerCase() is undefined, so default branch returns 'Video'
        expect(mapMediaType(null as unknown as string)).toBe('Video');
        expect(mapMediaType(undefined as unknown as string)).toBe('Video');
    });
});

// ============================================================================
// mapRowToMediaItem
// ============================================================================

describe('mapRowToMediaItem', () => {
    const fullRow: Record<string, unknown> = {
        id: 'item-uuid-1',
        title: 'The Lantern',
        media_type: 'movie',
        original_title: 'The Lantern',
        mi_overview: 'A hacker discovers reality.',
        pm_overview: 'A hacker discovers the truth.',
        year: 1999,
        premiere_date: '1999-03-31',
        created_at: '2024-01-01T00:00:00Z',
        runtime_seconds: 8160,
        sort_order: 1,
        parent_id: null,
        season_number: null,
        episode_number: null,
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
        logo_path: '/logo.png',
        thumb_path: '/thumb.jpg',
        vote_average: 8.7,
        content_rating: 'R',
        tagline: 'Welcome to the Real World.',
        genre_names: ['Action', 'Sci-Fi'],
        resume_position_ms: 3000,
        played_percentage: 50,
        is_watched: false,
        is_favorite: true,
        series_id: null,
        series_name: null,
        season_id: null,
        season_name: null,
        series_poster_path: null,
        series_backdrop_path: null,
        child_count: null,
        unplayed_count: null,
        container: 'mkv',
        path: '/data/movies/matrix.mkv',
    };

    it('maps required fields correctly', () => {
        const item = mapRowToMediaItem(fullRow);
        expect(item.id).toBe('item-uuid-1');
        expect(item.title).toBe('The Lantern');
        expect(item.media_type).toBe('movie');
    });

    it('prefers pm_overview over mi_overview', () => {
        const item = mapRowToMediaItem(fullRow);
        expect(item.overview).toBe('A hacker discovers the truth.');
    });

    it('falls back to mi_overview when pm_overview is absent', () => {
        const item = mapRowToMediaItem({ ...fullRow, pm_overview: null });
        expect(item.overview).toBe('A hacker discovers reality.');
    });

    it('prefers poster_path over series_poster_path', () => {
        const item = mapRowToMediaItem(fullRow);
        expect(item.poster_path).toBe('/poster.jpg');
    });

    it('falls back to series_poster_path when poster_path is absent', () => {
        const item = mapRowToMediaItem({
            ...fullRow,
            poster_path: null,
            series_poster_path: '/series-poster.jpg',
        });
        expect(item.poster_path).toBe('/series-poster.jpg');
    });

    it('maps all optional fields when present', () => {
        const item = mapRowToMediaItem(fullRow);
        expect(item.year).toBe(1999);
        expect(item.runtime_seconds).toBe(8160);
        expect(item.vote_average).toBe(8.7);
        expect(item.content_rating).toBe('R');
        expect(item.genres).toEqual(['Action', 'Sci-Fi']);
        expect(item.is_favorite).toBe(true);
        expect(item.container).toBe('mkv');
        expect(item.path).toBe('/data/movies/matrix.mkv');
    });

    it('handles all-null optional fields gracefully', () => {
        const minRow = {
            id: 'min-id',
            title: 'Minimal',
            media_type: 'movie',
        };
        const item = mapRowToMediaItem(minRow);
        expect(item.overview).toBeNull();
        expect(item.poster_path).toBeNull();
        expect(item.year).toBeUndefined();
        expect(item.genres).toBeNull();
        expect(item.is_watched).toBeUndefined();
    });
});

// ============================================================================
// serializeBaseItem
// ============================================================================

const minimalItem: MediaItemForSerialization = {
    id: 'aaaabbbb-cccc-dddd-eeee-ffffffffffff',
    title: 'Test Movie',
    media_type: 'movie',
};

describe('serializeBaseItem', () => {
    it('produces valid output for minimal item', () => {
        const result = serializeBaseItem(minimalItem);
        expect(result.Id).toBe('aaaabbbb-cccc-dddd-eeee-ffffffffffff');
        expect(result.Name).toBe('Test Movie');
        expect(result.Type).toBe('Movie');
    });

    it('sets Type correctly from media_type mapping', () => {
        expect(serializeBaseItem({ ...minimalItem, media_type: 'tv' }).Type).toBe('Series');
        expect(serializeBaseItem({ ...minimalItem, media_type: 'episode' }).Type).toBe('Episode');
        expect(serializeBaseItem({ ...minimalItem, media_type: 'audio' }).Type).toBe('Audio');
    });

    it('converts bare date to ISO datetime string', () => {
        const result = serializeBaseItem({
            ...minimalItem,
            premiere_date: '2023-01-15',
        });
        expect(result.PremiereDate).toBe('2023-01-15T00:00:00.000Z');
    });

    it('passes through ISO datetime unchanged', () => {
        const result = serializeBaseItem({
            ...minimalItem,
            premiere_date: '2023-01-15T10:30:00.000Z',
        });
        expect(result.PremiereDate).toBe('2023-01-15T10:30:00.000Z');
    });

    it('computes RunTimeTicks from runtime_seconds as integer', () => {
        const result = serializeBaseItem({
            ...minimalItem,
            runtime_seconds: 7200,
        });
        expect(result.RunTimeTicks).toBe(72_000_000_000);
        expect(Number.isInteger(result.RunTimeTicks)).toBe(true);
    });

    it('omits RunTimeTicks when runtime_seconds is absent', () => {
        const result = serializeBaseItem(minimalItem);
        expect(result.RunTimeTicks).toBeUndefined();
    });

    it('always sets Primary in ImageTags', () => {
        const result = serializeBaseItem(minimalItem);
        expect(result.ImageTags).toHaveProperty('Primary');
    });

    it('sets BackdropImageTags when backdrop_path exists', () => {
        const result = serializeBaseItem({
            ...minimalItem,
            backdrop_path: '/backdrop.jpg',
        });
        expect(result.BackdropImageTags).toHaveLength(1);
    });

    it('sets BackdropImageTags to empty array when no backdrop_path', () => {
        const result = serializeBaseItem(minimalItem);
        expect(result.BackdropImageTags).toEqual([]);
    });

    it('uses 0.667 PrimaryImageAspectRatio for poster-shaped video types', () => {
        expect(
            serializeBaseItem({ ...minimalItem, media_type: 'movie' }).PrimaryImageAspectRatio,
        ).toBe(0.667);
        expect(
            serializeBaseItem({ ...minimalItem, media_type: 'series' }).PrimaryImageAspectRatio,
        ).toBe(0.667);
    });

    it('uses 16:9 PrimaryImageAspectRatio for episodes (Primary is the still, not a poster)', () => {
        expect(
            serializeBaseItem({ ...minimalItem, media_type: 'episode' }).PrimaryImageAspectRatio,
        ).toBe(16 / 9);
    });

    it('uses 1.0 PrimaryImageAspectRatio for audio types', () => {
        expect(
            serializeBaseItem({ ...minimalItem, media_type: 'audio' }).PrimaryImageAspectRatio,
        ).toBe(1.0);
        expect(
            serializeBaseItem({ ...minimalItem, media_type: 'album' }).PrimaryImageAspectRatio,
        ).toBe(1.0);
        expect(
            serializeBaseItem({ ...minimalItem, media_type: 'artist' }).PrimaryImageAspectRatio,
        ).toBe(1.0);
    });

    it('always sets PlayAccess, CanDownload, LocationType', () => {
        const result = serializeBaseItem(minimalItem);
        expect(result.PlayAccess).toBe('Full');
        expect(result.CanDownload).toBe(true);
        expect(result.LocationType).toBe('FileSystem');
    });

    it('sets series hierarchy fields for episodes', () => {
        const episode: MediaItemForSerialization = {
            ...minimalItem,
            media_type: 'episode',
            series_id: 'series-uuid',
            series_name: 'Drifting Clouds',
            season_id: 'season-uuid',
            episode_number: 5,
            season_number: 1,
        };
        const result = serializeBaseItem(episode);
        expect(result.SeriesId).toBe('series-uuid');
        expect(result.SeriesName).toBe('Drifting Clouds');
        expect(result.SeasonId).toBe('season-uuid');
        expect(result.IndexNumber).toBe(5);
        expect(result.ParentIndexNumber).toBe(1);
    });

    it('includes Chapters when present', () => {
        const result = serializeBaseItem({
            ...minimalItem,
            chapters: [
                { chapter_index: 0, chapter_name: 'Opening', start_ticks: 0 },
                {
                    chapter_index: 1,
                    chapter_name: null,
                    start_ticks: 500000000,
                },
            ],
        });
        expect(result.Chapters).toHaveLength(2);
        expect(result.Chapters?.[0].Name).toBe('Opening');
        expect(result.Chapters?.[0].StartPositionTicks).toBe(0);
    });

    // jellyfin-sdk-kotlin's ChapterInfo declares ImageDateModified as a
    // required DateTime. Without it Android TV cannot decode the item and
    // never opens the details of anything with chapters (prod, 2026-10-02:
    // "2001: A Space Odyssey" — 34 file chapters).
    it('gives every chapter the ImageDateModified Jellyfin always sends', () => {
        const result = serializeBaseItem({
            ...minimalItem,
            chapters: [
                { chapter_index: 0, chapter_name: 'Opening', start_ticks: 0 },
                { chapter_index: 1, chapter_name: null, start_ticks: 500000000 },
            ],
        });
        for (const chapter of result.Chapters ?? []) {
            expect(chapter.ImageDateModified).toBe('0001-01-01T00:00:00.0000000Z');
        }
        expect(result.Chapters).toHaveLength(2);
    });

    it('includes Trickplay when present', () => {
        const result = serializeBaseItem({
            ...minimalItem,
            trickplay_params: [
                {
                    width: 160,
                    height: 90,
                    interval_ms: 10000,
                    tile_width: 10,
                    tile_height: 10,
                    thumbnail_count: 100,
                    bandwidth: 100000,
                },
            ],
        });
        const itemId = minimalItem.id;
        expect(result.Trickplay).toBeDefined();
        expect(result.Trickplay?.[itemId]).toBeDefined();
        expect(result.Trickplay?.[itemId]['160x90']).toBeDefined();
    });

    describe('UserData (buildUserData)', () => {
        it('sets default values when no watch state', () => {
            const result = serializeBaseItem(minimalItem);
            expect(result.UserData?.PlaybackPositionTicks).toBe(0);
            expect(result.UserData?.Played).toBe(false);
            expect(result.UserData?.IsFavorite).toBe(false);
            expect(result.UserData?.PlayCount).toBe(0);
        });

        it('converts resume_position_ms to PlaybackPositionTicks', () => {
            const result = serializeBaseItem({
                ...minimalItem,
                resume_position_ms: 60_000,
            });
            expect(result.UserData?.PlaybackPositionTicks).toBe(600_000_000);
        });

        it('sets Played=true and PlayCount=1 when is_watched=true', () => {
            const result = serializeBaseItem({
                ...minimalItem,
                is_watched: true,
            });
            expect(result.UserData?.Played).toBe(true);
            expect(result.UserData?.PlayCount).toBe(1);
        });

        it('sets IsFavorite=true when is_favorite=true', () => {
            const result = serializeBaseItem({
                ...minimalItem,
                is_favorite: true,
            });
            expect(result.UserData?.IsFavorite).toBe(true);
        });

        it('zeroes PlaybackPositionTicks when is_watched=true (Jellyfin contract)', () => {
            // Lumastra's durable plane keeps resume_position_ms on watched
            // rows so /watch/[id] can resume re-watches correctly. Jellyfin
            // clients treat Played=true + PlaybackPositionTicks>0 as
            // contradictory, so this serializer must zero the position when
            // Played=true to preserve the Jellyfin data-model contract.
            const result = serializeBaseItem({
                ...minimalItem,
                is_watched: true,
                resume_position_ms: 60_000,
            });
            expect(result.UserData?.Played).toBe(true);
            expect(result.UserData?.PlaybackPositionTicks).toBe(0);
        });

        it('zeroes PlayedPercentage when is_watched=true (Jellyfin contract)', () => {
            // Same boundary, same rule. The /j/ item-detail route computes
            // played_percentage from the durable resume position, which is
            // now non-zero on watched items. Played=true + PlayedPercentage>0
            // is the same contradiction as Played=true +
            // PlaybackPositionTicks>0; zero both so Jellyfin clients render
            // a clean "watched" badge with no half-progress bar.
            const result = serializeBaseItem({
                ...minimalItem,
                is_watched: true,
                resume_position_ms: 60_000,
                played_percentage: 50,
            });
            expect(result.UserData?.Played).toBe(true);
            expect(result.UserData?.PlaybackPositionTicks).toBe(0);
            expect(result.UserData?.PlayedPercentage).toBe(0);
        });
    });
});

// ============================================================================
// streamRowToJellyfin
// ============================================================================

function makeStreamRow(overrides: Partial<MediaStreamRow>): MediaStreamRow {
    return {
        id: 'stream-id',
        file_id: 'file-id',
        stream_type: 'video',
        stream_index: 0,
        codec: 'h264',
        codec_tag: null,
        profile: null,
        level: null,
        language: null,
        display_title: null,
        title: null,
        channels: null,
        channel_layout: null,
        sample_rate: null,
        width: null,
        height: null,
        bit_depth: null,
        video_range: null,
        video_range_type: null,
        color_space: null,
        aspect_ratio: null,
        average_frame_rate: null,
        is_anamorphic: null,
        is_external: null,
        is_text_subtitle: null,
        bitrate: null,
        is_default: false,
        is_forced: false,
        is_hearing_impaired: false,
        is_visual_impaired: false,
        has_closed_captions: false,
        dv_profile: null,
        dv_level: null,
        dv_bl_signal_compatibility_id: null,
        master_display: null,
        max_cll: null,
        pixel_format: null,
        ref_frames: null,
        color_primaries: null,
        color_transfer: null,
        created_at: new Date(),
        ...overrides,
    };
}

describe('mapBrowseStreamRow', () => {
    it('maps a video stream row with all metadata fields', () => {
        const row = {
            stream_type: 'video',
            stream_index: 0,
            codec: 'hevc',
            codec_tag: 'hvc1',
            width: 3840,
            height: 2160,
            bitrate: 50_000_000,
            video_range: 'HDR10',
            video_range_type: 'HDR10',
            profile: 'Main 10',
            level: 153,
            bit_depth: 10,
            average_frame_rate: 23.976,
            color_space: 'bt2020nc',
            color_primaries: 'bt2020',
            color_transfer: 'smpte2084',
            pixel_format: 'yuv420p10le',
            ref_frames: 1,
            is_default: true,
            is_forced: false,
        };
        const out = mapBrowseStreamRow(row);
        expect(out.Type).toBe('Video');
        expect(out.PixelFormat).toBe('yuv420p10le');
        expect(out.RefFrames).toBe(1);
        expect(out.ColorPrimaries).toBe('bt2020');
        expect(out.ColorTransfer).toBe('smpte2084');
        expect(out.ColorSpace).toBe('bt2020nc');
    });

    it('omits new video fields (undefined, not null) when columns are NULL', () => {
        const row = {
            stream_type: 'video',
            stream_index: 0,
            codec: 'h264',
            color_space: null,
            color_primaries: null,
            color_transfer: null,
            pixel_format: null,
            ref_frames: null,
            is_default: true,
            is_forced: false,
        };
        const out = mapBrowseStreamRow(row);
        expect(out.PixelFormat).toBeUndefined();
        expect(out.RefFrames).toBeUndefined();
        expect(out.ColorPrimaries).toBeUndefined();
        expect(out.ColorTransfer).toBeUndefined();
        expect(out.ColorSpace).toBeUndefined();
    });

    it('does NOT set video metadata fields on audio streams', () => {
        const row = {
            stream_type: 'audio',
            stream_index: 1,
            codec: 'aac',
            channels: 6,
            sample_rate: 48000,
            channel_layout: '5.1',
            color_space: 'bt709',
            pixel_format: 'yuv420p',
            is_default: true,
            is_forced: false,
        };
        const out = mapBrowseStreamRow(row);
        expect(out.Type).toBe('Audio');
        expect(out.PixelFormat).toBeUndefined();
        expect(out.RefFrames).toBeUndefined();
        expect(out.ColorPrimaries).toBeUndefined();
        expect(out.ColorTransfer).toBeUndefined();
        expect(out.ColorSpace).toBeUndefined();
        expect(out.Channels).toBe(6);
    });

    it('does NOT set video metadata fields on subtitle streams', () => {
        const row = {
            stream_type: 'subtitle',
            stream_index: 2,
            codec: 'subrip',
            is_text_subtitle: true,
            is_default: false,
            is_forced: false,
        };
        const out = mapBrowseStreamRow(row);
        expect(out.Type).toBe('Subtitle');
        expect(out.PixelFormat).toBeUndefined();
        expect(out.RefFrames).toBeUndefined();
        expect(out.ColorSpace).toBeUndefined();
    });

    it('drops empty-string color fields (matches streamRowToJellyfin behavior)', () => {
        const row = {
            stream_type: 'video',
            stream_index: 0,
            codec: 'h264',
            color_space: '',
            color_primaries: '',
            color_transfer: '',
            pixel_format: '',
            is_default: true,
            is_forced: false,
        };
        const out = mapBrowseStreamRow(row);
        expect(out.ColorSpace).toBeUndefined();
        expect(out.ColorPrimaries).toBeUndefined();
        expect(out.ColorTransfer).toBeUndefined();
        expect(out.PixelFormat).toBeUndefined();
    });

    it('omits RefFrames when value is 0 (meaningless)', () => {
        const row = {
            stream_type: 'video',
            stream_index: 0,
            codec: 'h264',
            ref_frames: 0,
            is_default: true,
            is_forced: false,
        };
        expect(mapBrowseStreamRow(row).RefFrames).toBeUndefined();
    });
});

describe('streamRowToJellyfin', () => {
    it('sets video-specific fields for video stream', () => {
        const row = makeStreamRow({
            stream_type: 'video',
            width: 1920,
            height: 1080,
            bitrate: 8_000_000,
            video_range: 'SDR',
            profile: 'High',
            level: 40,
        });
        const stream = streamRowToJellyfin(row);
        expect(stream.Type).toBe('Video');
        expect(stream.Width).toBe(1920);
        expect(stream.Height).toBe(1080);
        expect(stream.BitRate).toBe(8_000_000);
        expect(stream.VideoRange).toBe('SDR');
        expect(stream.Profile).toBe('High');
        expect(stream.Level).toBe(40);
    });

    it('sets audio-specific fields for audio stream', () => {
        const row = makeStreamRow({
            stream_type: 'audio',
            channels: 6,
            sample_rate: 48000,
            channel_layout: '5.1',
        });
        const stream = streamRowToJellyfin(row);
        expect(stream.Type).toBe('Audio');
        expect(stream.Channels).toBe(6);
        expect(stream.SampleRate).toBe(48000);
        expect(stream.ChannelLayout).toBe('5.1');
    });

    it('sets DeliveryMethod=Embed for embedded subtitle', () => {
        const row = makeStreamRow({
            stream_type: 'subtitle',
            is_external: false,
        });
        const stream = streamRowToJellyfin(row);
        expect(stream.Type).toBe('Subtitle');
        expect(stream.DeliveryMethod).toBe('Embed');
    });

    it('sets DeliveryMethod=External and constructs DeliveryUrl for external subtitle', () => {
        const row = makeStreamRow({
            stream_type: 'subtitle',
            stream_index: 2,
            is_external: true,
        });
        const stream = streamRowToJellyfin(row, 'item-uuid', 'api-key-123', 'source-uuid');
        expect(stream.DeliveryMethod).toBe('External');
        expect(stream.DeliveryUrl).toBe(
            '/Videos/item-uuid/source-uuid/Subtitles/2/0/Stream.vtt?api_key=api-key-123',
        );
    });

    it('uses itemId as sourceId when mediaSourceId is absent', () => {
        const row = makeStreamRow({
            stream_type: 'subtitle',
            stream_index: 1,
            is_external: true,
        });
        const stream = streamRowToJellyfin(row, 'item-uuid', 'my-key');
        expect(stream.DeliveryUrl).toBe(
            '/Videos/item-uuid/item-uuid/Subtitles/1/0/Stream.vtt?api_key=my-key',
        );
    });

    it('sets IsDefault, IsForced, IsExternal flags', () => {
        const row = makeStreamRow({
            is_default: true,
            is_forced: true,
            is_external: true,
            stream_type: 'subtitle',
        });
        const stream = streamRowToJellyfin(row);
        expect(stream.IsDefault).toBe(true);
        expect(stream.IsForced).toBe(true);
        expect(stream.IsExternal).toBe(true);
    });

    it('sets PixelFormat/RefFrames/ColorPrimaries/ColorTransfer/ColorSpace for video', () => {
        const row = makeStreamRow({
            stream_type: 'video',
            width: 3840,
            height: 2160,
            color_space: 'bt2020nc',
            color_primaries: 'bt2020',
            color_transfer: 'smpte2084',
            pixel_format: 'yuv420p10le',
            ref_frames: 1,
        });
        const stream = streamRowToJellyfin(row);
        expect(stream.PixelFormat).toBe('yuv420p10le');
        expect(stream.RefFrames).toBe(1);
        expect(stream.ColorPrimaries).toBe('bt2020');
        expect(stream.ColorTransfer).toBe('smpte2084');
        expect(stream.ColorSpace).toBe('bt2020nc');
    });

    it('omits new video fields when columns are NULL', () => {
        const row = makeStreamRow({
            stream_type: 'video',
            color_space: null,
            color_primaries: null,
            color_transfer: null,
            pixel_format: null,
            ref_frames: null,
        });
        const stream = streamRowToJellyfin(row);
        expect(stream.PixelFormat).toBeUndefined();
        expect(stream.RefFrames).toBeUndefined();
        expect(stream.ColorPrimaries).toBeUndefined();
        expect(stream.ColorTransfer).toBeUndefined();
        expect(stream.ColorSpace).toBeUndefined();
    });

    it('does not set new video fields on audio streams', () => {
        const row = makeStreamRow({
            stream_type: 'audio',
            color_space: 'bt709',
            pixel_format: 'yuv420p',
        });
        const stream = streamRowToJellyfin(row);
        expect(stream.PixelFormat).toBeUndefined();
        expect(stream.RefFrames).toBeUndefined();
        expect(stream.ColorSpace).toBeUndefined();
    });

    it('omits RefFrames when row value is 0 (meaningless)', () => {
        const row = makeStreamRow({
            stream_type: 'video',
            ref_frames: 0,
        });
        expect(streamRowToJellyfin(row).RefFrames).toBeUndefined();
    });
});

// ============================================================================
// serializeBaseItem — additional edge cases
// ============================================================================

describe('serializeBaseItem additional edge cases', () => {
    it('rounds float runtime_seconds to integer ticks', () => {
        const result = serializeBaseItem({
            ...minimalItem,
            runtime_seconds: 7342.5,
        });
        expect(result.RunTimeTicks).toBe(Math.round(7342.5 * 10_000_000));
        expect(Number.isInteger(result.RunTimeTicks)).toBe(true);
    });

    it('handles very large runtime (4 hours) as correct integer ticks', () => {
        const fourHours = 3600 * 4;
        const result = serializeBaseItem({
            ...minimalItem,
            runtime_seconds: fourHours,
        });
        expect(result.RunTimeTicks).toBe(fourHours * 10_000_000);
        expect(Number.isInteger(result.RunTimeTicks)).toBe(true);
    });

    it('sets ParentPrimaryImageItemId and ParentBackdropItemId when series_poster_path and series_id are present', () => {
        const episode: MediaItemForSerialization = {
            ...minimalItem,
            media_type: 'episode',
            series_id: 'series-uuid-123',
            series_name: 'The Wisp',
            series_poster_path: '/series-poster.jpg',
            series_backdrop_path: '/series-backdrop.jpg',
        };
        const result = serializeBaseItem(episode);
        expect(result.ParentPrimaryImageItemId).toBe('series-uuid-123');
        expect(result.ParentBackdropItemId).toBe('series-uuid-123');
    });

    it('sets all season_name field in episode serialization', () => {
        const episode: MediaItemForSerialization = {
            ...minimalItem,
            media_type: 'episode',
            series_id: 'series-uuid',
            series_name: 'Drifting Clouds',
            season_id: 'season-uuid',
            season_name: 'Season 1',
            episode_number: 3,
            season_number: 1,
        };
        const result = serializeBaseItem(episode);
        expect(result.SeasonName).toBe('Season 1');
    });

    it('includes Chapters with correct StartPositionTicks as numbers', () => {
        const result = serializeBaseItem({
            ...minimalItem,
            chapters: [
                { chapter_index: 0, chapter_name: 'Intro', start_ticks: 0 },
                {
                    chapter_index: 1,
                    chapter_name: 'Act 1',
                    start_ticks: 720000000,
                },
                {
                    chapter_index: 2,
                    chapter_name: null,
                    start_ticks: 3600000000,
                },
            ],
        });
        expect(result.Chapters).toHaveLength(3);
        expect(result.Chapters?.[1].Name).toBe('Act 1');
        expect(result.Chapters?.[1].StartPositionTicks).toBe(720000000);
        expect(result.Chapters?.[2].Name).toBe('Chapter 3');
    });

    it('includes Trickplay with correct nested key structure', () => {
        const result = serializeBaseItem({
            ...minimalItem,
            trickplay_params: [
                {
                    width: 320,
                    height: 180,
                    interval_ms: 5000,
                    tile_width: 5,
                    tile_height: 5,
                    thumbnail_count: 50,
                    bandwidth: 50000,
                },
            ],
        });
        const itemId = minimalItem.id;
        expect(result.Trickplay?.[itemId]['320x180']).toBeDefined();
        expect(result.Trickplay?.[itemId]['320x180'].Width).toBe(320);
        expect(result.Trickplay?.[itemId]['320x180'].Height).toBe(180);
    });
});

// ============================================================================
// serializeBaseItems
// ============================================================================

describe('serializeBaseItems', () => {
    it('returns empty array for empty input', () => {
        expect(serializeBaseItems([])).toEqual([]);
    });

    it('serializes multiple items, each correctly', () => {
        const items: MediaItemForSerialization[] = [
            { id: 'id-1', title: 'Movie One', media_type: 'movie' },
            { id: 'id-2', title: 'Movie Two', media_type: 'tv' },
            { id: 'id-3', title: 'Movie Three', media_type: 'episode' },
        ];
        const results = serializeBaseItems(items);
        expect(results).toHaveLength(3);
        expect(results[0].Id).toBe('id-1');
        expect(results[0].Type).toBe('Movie');
        expect(results[1].Id).toBe('id-2');
        expect(results[1].Type).toBe('Series');
        expect(results[2].Id).toBe('id-3');
        expect(results[2].Type).toBe('Episode');
    });

    it('preserves input order', () => {
        const items: MediaItemForSerialization[] = [
            { id: 'z-last', title: 'Z Movie', media_type: 'movie' },
            { id: 'a-first', title: 'A Movie', media_type: 'movie' },
        ];
        const results = serializeBaseItems(items);
        expect(results[0].Id).toBe('z-last');
        expect(results[1].Id).toBe('a-first');
    });
});

describe('Dolby Vision and hearing-impaired streams (brief 09)', () => {
    it('streamRowToJellyfin carries the DOVI record and the SDH flag', () => {
        const video = streamRowToJellyfin(
            makeStreamRow({ dv_profile: 8, dv_level: 6, dv_bl_signal_compatibility_id: 1 }),
        );
        expect(video).toMatchObject({ DvProfile: 8, DvLevel: 6, DvBlSignalCompatibilityId: 1 });
        const sdh = streamRowToJellyfin(
            makeStreamRow({ stream_type: 'subtitle', is_hearing_impaired: true }),
        );
        expect(sdh.IsHearingImpaired).toBe(true);
        expect(sdh).not.toHaveProperty('DvProfile');
    });

    it('mapBrowseStreamRow does the same and leaves non-DOVI video alone', () => {
        const dovi = mapBrowseStreamRow({
            stream_type: 'video',
            stream_index: 0,
            dv_profile: 5,
            dv_level: null,
        });
        expect(dovi.DvProfile).toBe(5);
        expect(dovi).not.toHaveProperty('DvLevel');
        const plain = mapBrowseStreamRow({ stream_type: 'video', stream_index: 0 });
        expect(plain).not.toHaveProperty('DvProfile');
        const sdh = mapBrowseStreamRow({
            stream_type: 'subtitle',
            stream_index: 2,
            is_hearing_impaired: true,
        });
        expect(sdh.IsHearingImpaired).toBe(true);
    });
});
