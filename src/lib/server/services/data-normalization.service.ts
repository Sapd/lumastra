// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Data Normalization Service
 *
 * Centralized service for normalizing data from different media sources
 * Eliminates duplicate conversion logic across the codebase
 */

import type { MediaItem } from '../types.js';
import { toInternalMediaType, type MediaTypeInternal } from '$lib/shared/media-type-domain';
import type { ExternalIds } from '../../types/api-common.js';
import { createExternalIds } from '../../utils/external-ids.js';

export interface NormalizationOptions {
    includeExtendedMetadata?: boolean;
    extractCast?: boolean;
    generateImageUrls?: boolean;
    sourceTracking?: boolean;
}

type ProviderIdMap = Record<string, unknown>;

type MediaStreamInfo = {
    Type?: string;
    Codec?: string;
    BitRate?: number;
    Width?: number;
    Height?: number;
    VideoRange?: string;
    Channels?: number;
    Language?: string;
    IsDefault?: boolean;
};

/**
 * Universal data normalization service
 */
export class DataNormalizationService {
    /**
     * Normalize duration from Jellyfin RunTimeTicks to seconds
     */
    static normalizeJellyfinDuration(runTimeTicks?: number): number | undefined {
        if (!runTimeTicks) return undefined;
        // RunTimeTicks = nanoseconds / 100, convert to seconds
        return runTimeTicks / 10 / 1000 / 1000;
    }

    /**
     * Normalize date strings to consistent ISO format
     */
    static normalizeDate(dateValue?: string | number | Date): string | undefined {
        if (!dateValue) return undefined;

        // Treat 0 as invalid/missing data (not Unix epoch)
        if (dateValue === 0) return undefined;

        try {
            let date: Date;

            if (typeof dateValue === 'string') {
                // Handle various date formats
                date = new Date(dateValue);
            } else if (typeof dateValue === 'number') {
                // Handle Unix timestamps
                date = new Date(dateValue);
            } else {
                date = dateValue;
            }

            if (isNaN(date.getTime())) return undefined;

            return date.toISOString().split('T')[0]; // YYYY-MM-DD format
        } catch {
            return undefined;
        }
    }

    /**
     * Normalize year from various date formats
     */
    static normalizeYear(dateValue?: string | number | Date): number | undefined {
        // Treat 0 as invalid/missing data
        if (dateValue === 0) return undefined;

        // If it's already a number and looks like a valid year, return it directly
        if (typeof dateValue === 'number' && dateValue > 1800 && dateValue < 2200) {
            return dateValue;
        }

        const normalizedDate = this.normalizeDate(dateValue);
        if (!normalizedDate) return undefined;

        const year = parseInt(normalizedDate.split('-')[0]);

        return year;
    }

    /**
     * Normalize rating values to 0-10 scale
     */
    static normalizeRating(
        rating?: number | null,
        scale: '5' | '10' | '100' = '10',
    ): number | undefined {
        if (rating === null || rating === undefined) return undefined;

        switch (scale) {
            case '5':
                return (rating / 5) * 10;
            case '100':
                return rating / 10;
            case '10':
            default:
                return rating;
        }
    }

    /**
     * Normalize title by removing special characters and extra spaces
     */
    static normalizeTitle(title?: string): string {
        if (!title) return '';

        return title
            .replace(/[^\w\sßäöü]/g, '') // Remove special chars but keep umlauts
            .replace(/\s+/g, ' ') // Normalize whitespace
            .replace(/\(.*?\)/g, '') // Remove parenthetical info
            .trim();
    }

    /**
     * Extract TMDB ID from various provider ID formats
     */
    static extractTmdbId(providerIds?: ProviderIdMap): number | undefined {
        if (!providerIds) return undefined;

        // Handle different casing and formats
        const tmdbId = providerIds['Tmdb'] ?? providerIds['tmdb'] ?? providerIds['TMDB'];

        if (typeof tmdbId === 'string') {
            const parsed = parseInt(tmdbId);
            return isNaN(parsed) ? undefined : parsed;
        }

        if (typeof tmdbId === 'number') {
            return tmdbId;
        }

        return undefined;
    }

    /**
     * Convert Jellyfin ProviderIds to ExternalIds format
     */
    static providerIdsToExternalIds(providerIds?: ProviderIdMap): ExternalIds | undefined {
        if (!providerIds) return undefined;

        // Extract TMDB ID (handle different casing)
        const tmdbId = providerIds['Tmdb'] ?? providerIds['tmdb'] ?? providerIds['TMDB'];

        // Extract IMDB ID (handle different casing)
        const imdbId = providerIds['Imdb'] ?? providerIds['imdb'] ?? providerIds['IMDB'];

        // Extract TVDB ID (handle different casing)
        const tvdbId = providerIds['Tvdb'] ?? providerIds['tvdb'] ?? providerIds['TVDB'];

        // Check if we have any valid IDs
        const hasTmdb = tmdbId !== undefined && tmdbId !== null;
        const hasImdb = imdbId !== undefined && imdbId !== null && typeof imdbId === 'string';
        const hasTvdb = tvdbId !== undefined && tvdbId !== null;

        if (!hasTmdb && !hasImdb && !hasTvdb) {
            return undefined;
        }

        // Use createExternalIds helper for provider-agnostic ID assignment
        return createExternalIds({
            ...(hasTmdb ? { tmdb: String(tmdbId) } : {}),
            ...(hasImdb ? { imdb: String(imdbId) } : {}),
            ...(hasTvdb ? { tvdb: String(tvdbId) } : {}),
        });
    }

    /**
     * Normalize an arbitrary media-type string (Jellyfin PascalCase, legacy
     * UPPERCASE, colloquial aliases) onto the app-layer `MediaItem['mediaType']`
     * union — or `null` when that union has no member for it.
     *
     * This was the THIRD of four independent `normalizeMediaType()`
     * implementations. Parsing is now delegated to the single owner
     * (`toInternalMediaType`); only the projection onto this legacy app-layer
     * union lives here, and it is an exhaustive table rather than a `switch` with
     * a `default: return 'movie'` arm.
     *
     * `MediaItem['mediaType']` is a hand-written union that is *almost* the full
     * internal vocabulary but predates four members. Writing the gap out
     * explicitly is the point: adding a media type is a compile error here until
     * someone decides whether this union should carry it.
     */
    private static readonly MEDIA_ITEM_TYPES: Readonly<
        Record<MediaTypeInternal, MediaItem['mediaType'] | null>
    > = {
        movie: 'movie',
        tv: 'tv',
        episode: 'episode',
        season: 'season',
        audiobook: 'audiobook',
        book: 'book',
        manga: 'manga',
        comic: 'comic',
        podcast: 'podcast',
        artist: 'artist',
        album: 'album',
        track: 'track',
        // Jellyfin's `Audio` item type is a track by another name; MediaItem has
        // no separate 'audio' member and never needed one.
        audio: 'track',
        music: 'music',
        tvchannel: 'tvchannel',
        home_video: 'home_video',
        training: 'training',
        educational: 'educational',
        personal: 'personal',
        anfragen: 'anfragen',
        sonarr: 'sonarr',
        radarr: 'radarr',
        // No member on MediaItem['mediaType']. These reach this transform only
        // from a mis-scoped query; a MediaItem is not the right carrier for them.
        extra: null,
        radio: null,
        product: null,
    };

    static normalizeMediaType(type: string): MediaItem['mediaType'] | null {
        const internal = toInternalMediaType(type);
        if (internal === null) return null;
        return DataNormalizationService.MEDIA_ITEM_TYPES[internal];
    }

    /**
     * Safely handle array fields
     */
    static normalizeArray<T>(value?: T[] | T | null): T[] {
        if (!value) return [];
        return Array.isArray(value) ? value : [value];
    }

    /**
     * Extract video stream information for sessions
     */
    static extractVideoStreamInfo(mediaStreams?: MediaStreamInfo[]): {
        codec?: string;
        bitRate?: number;
        width?: number;
        height?: number;
        videoRange?: string;
    } {
        if (!mediaStreams) return {};

        const videoStream = mediaStreams.find((s) => s.Type === 'Video');
        if (!videoStream) return {};

        return {
            codec: videoStream.Codec,
            bitRate: videoStream.BitRate,
            width: videoStream.Width,
            height: videoStream.Height,
            videoRange: videoStream.VideoRange,
        };
    }

    /**
     * Extract audio stream information for sessions
     */
    static extractAudioStreamInfo(mediaStreams?: MediaStreamInfo[]): {
        codec?: string;
        bitRate?: number;
        channels?: number;
        language?: string;
    } {
        if (!mediaStreams) return {};

        // Try default audio stream first, then fall back to first audio stream
        const audioStream =
            mediaStreams.find((s) => s.Type === 'Audio' && s.IsDefault) ||
            mediaStreams.find((s) => s.Type === 'Audio');

        if (!audioStream) return {};

        return {
            codec: audioStream.Codec,
            bitRate: audioStream.BitRate,
            channels: audioStream.Channels,
            language: audioStream.Language,
        };
    }

    /**
     * Calculate playback progress percentage
     */
    static calculateProgress(currentTicks?: number, totalTicks?: number): number | undefined {
        if (!currentTicks || !totalTicks || totalTicks === 0) return undefined;

        return Math.min(100, Math.max(0, (currentTicks / totalTicks) * 100));
    }

    /**
     * Convert Jellyfin ticks to seconds
     */
    static ticksToSeconds(ticks?: number): number | undefined {
        if (!ticks) return undefined;
        return ticks / 10 / 1000 / 1000;
    }

    /**
     * Normalize user-related fields
     */
    static normalizeUserInfo(username?: string, fallback = 'Unknown User'): string {
        return username?.trim() || fallback;
    }

    /**
     * Normalize client information
     */
    static normalizeClientInfo(
        client?: string,
        version?: string,
        device?: string,
    ): {
        clientname: string;
        browsername: string;
    } {
        const clientName =
            client && version ? `${client} ${version}`.trim() : client || 'Unknown Client';

        const browserName = device || 'Unknown Device';

        return {
            clientname: clientName,
            browsername: browserName,
        };
    }

    /**
     * Safe string conversion with fallback
     */
    static safeString(value: unknown, fallback = ''): string {
        if (value === null || value === undefined || value === '') return fallback;
        const stringValue = String(value);
        // Prevent storing literal "undefined" or "null" strings
        if (stringValue === 'undefined' || stringValue === 'null' || stringValue.trim() === '') {
            return fallback;
        }
        return stringValue;
    }

    /**
     * Safe number conversion with fallback
     */
    static safeNumber(value: unknown): number | undefined {
        if (value === null || value === undefined) return undefined;
        const num = Number(value);
        return isNaN(num) ? undefined : num;
    }

    /**
     * Normalize boolean values from various sources
     */
    static normalizeBoolean(value: unknown): boolean {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            return value.toLowerCase() === 'true' || value === '1';
        }
        if (typeof value === 'number') return value !== 0;
        return false;
    }

    /**
     * Clean and normalize overview/description text
     */
    static normalizeOverview(overview?: string): string | undefined {
        if (!overview) return undefined;

        return overview
            .replace(/\r\n/g, '\n') // Normalize line breaks
            .replace(/\n{3,}/g, '\n\n') // Reduce excessive line breaks
            .trim();
    }

    /**
     * Merge multiple data sources with priority
     */
    static mergeWithPriority<T>(primary?: T, fallback?: T, tertiary?: T): T | undefined {
        return primary ?? fallback ?? tertiary;
    }

    /**
     * Normalize track display titles by replacing German terms with English
     * Used for subtitle and audio track names from Jellyfin
     */
    static normalizeTrackDisplayTitle(title?: string): string | undefined {
        if (!title) return undefined;

        // Map of German terms to English equivalents (case-insensitive replacements)
        const germanToEnglish: Record<string, string> = {
            erzwungen: 'Forced',
            Erzwungen: 'Forced',
            standard: 'Default',
            Standard: 'Default',
            untertitel: 'Subtitles',
            Untertitel: 'Subtitles',
            'ohne untertitel': 'No Subtitles',
            'Ohne Untertitel': 'No Subtitles',
            eingebettet: 'Embedded',
            Eingebettet: 'Embedded',
            extern: 'External',
            Extern: 'External',
            kommentar: 'Commentary',
            Kommentar: 'Commentary',
            hörgeschädigt: 'SDH',
            Hörgeschädigt: 'SDH',
            'für hörgeschädigte': 'SDH',
            'Für Hörgeschädigte': 'SDH',
        };

        let result = title;
        for (const [german, english] of Object.entries(germanToEnglish)) {
            result = result.replaceAll(new RegExp(german, 'g'), english);
        }

        return result;
    }
}
