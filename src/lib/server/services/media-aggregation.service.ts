// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Aggregation Service
 *
 * Unified service for aggregating media data from multiple sources
 * Replaces scattered Promise.allSettled patterns with centralized logic
 */

import { sessionCarPlayContext } from '$lib/server/database/queries/play-session-client-context.queries.js';
import { getLiveTvProvider } from './livetv/index.js';
import { audiobookshelfClient } from '../audiobookshelf.js';
import { jellyseerrClient } from '../jellyseerr.js';
import { transformAudiobookToMediaItem, transformJellyseerrToMediaItem } from '../transformers.js';
import type { MediaItem, StreamSession } from '../types.js';
import { DataNormalizationService } from './data-normalization.service.js';
import { cacheManager, CACHE_NAMESPACES } from '../cache/index.js';
import { config } from '../config.js';
import { Logger } from '../utils/logger.js';
import { isAudio, isAudiobook } from '$lib/server/utils/media-types';
import { getSessionReadModel } from './session-read-model.service.js';
import { aiDbService } from './database.service.js';
import { getAllActiveSessionsWithMedia } from '../database/queries/play-sessions.queries.js';
import {
    resolveMusicSessionLiveInfo,
    type MusicSessionLiveInfo,
} from './music-session-live-info.js';
import { detectFormFactor, parseUserAgent } from '$lib/utils/user-agent.js';
import {
    buildSearchAccessCacheKey,
    type SearchAccessContext,
} from '$lib/server/utils/search-access-context.js';

const logger = Logger.for('MediaAggregationService');

type AggregationSource = 'livetv' | 'jellyfin' | 'audiobookshelf' | 'sonarr' | 'jellyseerr';

export interface AggregationOptions {
    maxResults?: number;
    includeMetadata?: boolean;
    sources?: AggregationSource[];
    timeout?: number;
    adminMode?: boolean;
    /**
     * Whether the caller may receive Live TV channels in the result set.
     * Independent of `sources` so we can gate channel enumeration on the
     * user's `hasLiveTvPermission`, not just on whether LiveTV is enabled.
     * Default false — callers must opt in explicitly. Included in the
     * cache key so a permission upgrade doesn't get a stale-without-livetv
     * hit.
     */
    liveTvAllowed?: boolean;
}

/**
 * Options for {@link MediaAggregationService.searchAcrossServices} — the
 * cached, cross-source search fan-out. Extends {@link AggregationOptions}
 * with a REQUIRED `accessCtx`, kept a separate type (rather than adding
 * `accessCtx` to the shared `AggregationOptions`) so other callers of that
 * shared shape are unaffected.
 */
export interface SearchAcrossServicesOptions extends AggregationOptions {
    /**
     * Full access scope (denied library groups, age rating, Live TV
     * permission, showUnavailableMedia) for the caller, built once per
     * request via `buildSearchAccessContext`. REQUIRED — it is folded into
     * the search cache key via `buildSearchAccessCacheKey` so a restricted
     * user can never be served a less-restricted user's cached results.
     * `liveTvAllowed` above already carried this partition for the Live TV
     * branch; `accessCtx` extends it to `deniedGroupIds`/`ageRating` as well.
     *
     * None of the currently-aggregated sources (Live TV channel search,
     * Audiobookshelf, Jellyseerr) filter their own results by
     * deniedGroupIds/ageRating server-side today — only `liveTvAllowed`
     * actually gates a branch — but the cache key partitions on the full
     * scope anyway so a future access-aware source, or a source that starts
     * consulting these fields, can never leak a stale cross-user cache
     * entry. Callers with no authenticated user MUST pass
     * `unauthenticatedSearchAccessContext()` (fail-closed), never omit this.
     */
    accessCtx: SearchAccessContext;
}

export interface AggregatedSearchResults {
    items: MediaItem[];
    totalResults: number;
    sources: {
        livetv: { count: number; success: boolean };
        jellyfin: { count: number; success: boolean };
        audiobookshelf: { count: number; success: boolean };
        jellyseerr: { count: number; success: boolean };
        sonarr: { count: number; success: boolean };
    };
}

export interface SessionAggregationResult {
    sessions: StreamSession[];
    totalSessions: number;
    sources: {
        jellyfin: { count: number; success: boolean };
    };
    /** Timestamp when sessions data was fetched from upstream APIs (used for time interpolation) */
    cacheTimestamp?: number;
}

/**
 * Media Aggregation Service
 * Centralizes multi-source data aggregation logic
 */
export class MediaAggregationService {
    /**
     * Search across multiple media sources
     */
    static async searchAcrossServices(
        query: string,
        options: SearchAcrossServicesOptions,
    ): Promise<AggregatedSearchResults> {
        const {
            maxResults = 50,
            includeMetadata = true,
            sources = ['jellyseerr'],
            timeout = 3000, // Reduced from 5s to 3s for faster searches
            liveTvAllowed = false,
            accessCtx,
        } = options;

        // Generate cache key based on search parameters
        // v3: Added Live TV permission flag — caller permission upgrades
        // must not get a stale cache entry built without livetv branch.
        // v4: Added the full access-scope suffix (deniedGroupIds + ageRating,
        // via the shared buildSearchAccessCacheKey helper) so a restricted
        // user can never be served a less-restricted user's cached results —
        // defense in depth even though no aggregated source currently filters
        // on those two dimensions itself (see AggregationOptions.accessCtx doc).
        const accessSuffix = buildSearchAccessCacheKey(accessCtx);
        const cacheKey = `${query.toLowerCase()}:${maxResults}:${sources.join(',')}:${includeMetadata}:livetv=${liveTvAllowed ? 1 : 0}${accessSuffix ? `:${accessSuffix}` : ''}`;

        // Type-safe cache - TTLs from centralized CACHE_NAMESPACES config
        const searchCache = cacheManager.for(CACHE_NAMESPACES.search);

        // Try to get cached results first
        try {
            const cachedData = await searchCache.get<AggregatedSearchResults>(cacheKey);
            if (cachedData) {
                logger.debug('Search cache hit', { query });
                return cachedData;
            }
        } catch (cacheError) {
            logger.warn('Search cache read error', {
                query,
                error: String(cacheError),
            });
        }

        const resultsPerSource = Math.floor(maxResults / Math.max(1, sources.length));

        // Prepare search promises
        const searchPromises: Promise<{
            source: AggregationSource;
            results: MediaItem[];
        }>[] = [];

        // Search Live TV channels via provider (works for both Jellyfin and standalone).
        // Only run when LiveTV is not disabled AND the caller is permitted to
        // see Live TV. Without the permission gate, search would enumerate
        // channel IDs / names / logos for users who lack hasLiveTvPermission
        // (the dedicated /api/livetv/programs/search route already checks it).
        if (sources.includes('livetv') && config.LIVETV_SOURCE !== 'disabled' && liveTvAllowed) {
            searchPromises.push(
                Promise.race([
                    getLiveTvProvider()
                        .then((p) => p.searchChannels(query, 10))
                        .then((channels) => ({
                            source: 'livetv' as const,
                            results: channels.map((ch): MediaItem => ({
                                id: ch.id,
                                title: ch.name,
                                mediaType: 'tvchannel',
                                imageUrl: ch.images.primary?.href,
                                externalIds: { internal: ch.id },
                            })),
                        })),
                    new Promise<{
                        source: AggregationSource;
                        results: MediaItem[];
                    }>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout)),
                ]).catch(
                    (): {
                        source: AggregationSource;
                        results: MediaItem[];
                    } => ({ source: 'livetv', results: [] }),
                ),
            );
        }

        if (sources.includes('audiobookshelf')) {
            searchPromises.push(
                Promise.race([
                    audiobookshelfClient.search(query, resultsPerSource).then((results) => ({
                        source: 'audiobookshelf' as const,
                        results: transformAudiobookToMediaItem(results),
                    })),
                    new Promise<{
                        source: AggregationSource;
                        results: MediaItem[];
                    }>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout)),
                ]).catch(
                    (): {
                        source: AggregationSource;
                        results: MediaItem[];
                    } => ({ source: 'audiobookshelf', results: [] }),
                ),
            );
        }

        if (sources.includes('jellyseerr')) {
            searchPromises.push(
                Promise.race([
                    jellyseerrClient.search(query, resultsPerSource).then((results) => ({
                        source: 'jellyseerr' as const,
                        results: transformJellyseerrToMediaItem(
                            results.filter((item) => item.status !== 5),
                        ),
                    })),
                    new Promise<{
                        source: AggregationSource;
                        results: MediaItem[];
                    }>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout)),
                ]).catch(
                    (): {
                        source: AggregationSource;
                        results: MediaItem[];
                    } => ({ source: 'jellyseerr', results: [] }),
                ),
            );
        }

        // Execute all searches in parallel
        const searchResults = await Promise.allSettled(searchPromises);

        // Process results
        const aggregatedResults: AggregatedSearchResults = {
            items: [],
            totalResults: 0,
            sources: {
                livetv: { count: 0, success: false },
                jellyfin: { count: 0, success: false },
                audiobookshelf: { count: 0, success: false },
                jellyseerr: { count: 0, success: false },
                sonarr: { count: 0, success: false },
            },
        };

        // Collect successful results
        searchResults.forEach((result) => {
            if (result.status === 'fulfilled') {
                const { source, results } = result.value;
                aggregatedResults.items.push(...results);
                aggregatedResults.sources[source] = {
                    count: results.length,
                    success: true,
                };
            }
        });

        // Sort and limit results
        aggregatedResults.items = MediaAggregationService.sortAndDeduplicateResults(
            aggregatedResults.items,
            query,
            maxResults,
        );
        aggregatedResults.totalResults = aggregatedResults.items.length;

        // Cache the results
        try {
            if (aggregatedResults.items.length > 0) {
                await searchCache.set(cacheKey, aggregatedResults);
                logger.debug('Cached search results', { query });
            }
        } catch (cacheError) {
            logger.warn('Search cache write error', {
                query,
                error: String(cacheError),
            });
        }

        return aggregatedResults;
    }

    /**
     * Get active sessions from the unified play_sessions DB table via SessionReadModel.
     *
     * Both Lumastra and external (Jellyfin / ABS / LiveTV / music) sessions now
     * live in the same table, so a single DB query is sufficient and stale-cache
     * disagreements between sources are impossible by construction.
     *
     * The response `cacheTimestamp` is set to "now" because positions are read
     * fresh from the database on every request.
     */
    static async getActiveSessions(
        _userPermissions: string[],
        _options: AggregationOptions = {},
    ): Promise<SessionAggregationResult> {
        const readModel = getSessionReadModel();
        const views = await readModel.getAllActive({ includeStale: false });

        // Enrich with media metadata (title, codec info, series context) via
        // the same joined query used by the admin sessions endpoint.
        const sql = await aiDbService.getSql();
        const dbRows = sql
            ? await getAllActiveSessionsWithMedia(sql).catch((err: unknown) => {
                  logger.warn('Failed to fetch enriched session rows', {
                      error: err instanceof Error ? err.message : String(err),
                  });
                  return [];
              })
            : [];

        const enrichedMap = new Map(dbRows.map((r) => [r.id, r]));

        // Next-track and crossfade extras for music sessions (Valkey, fed by
        // the music session heartbeat).
        const musicLiveInfo = sql
            ? await resolveMusicSessionLiveInfo(
                  sql,
                  dbRows.filter((r) => r.media_type === 'track').map((r) => r.id),
              )
            : new Map<string, MusicSessionLiveInfo>();

        const sessions: StreamSession[] = views.map((view) => {
            const enriched = enrichedMap.get(view.sessionId);

            const positionMs = view.positionMs;
            const runtimeMs = view.runtimeMs;
            const positionSecs = positionMs / 1000;
            const runtimeSecs = runtimeMs != null ? runtimeMs / 1000 : undefined;
            const streamProgress =
                runtimeMs != null && runtimeMs > 0
                    ? Math.min((positionMs / runtimeMs) * 100, 100)
                    : undefined;

            const clientname = enriched?.client_name ?? view.device?.client ?? 'Lumastra';
            const rawDeviceName = enriched?.user_agent ?? view.device?.name ?? null;
            const browsername = rawDeviceName ? parseUserAgent(rawDeviceName) : clientname;
            const formFactor = detectFormFactor(rawDeviceName, clientname);

            const mediaId = view.mediaId;
            const title = enriched?.media_title ?? mediaId;
            const isTrackSession = view.mediaType === 'track';
            // Files with no video track: the file's overall bitrate IS the audio
            // bitrate. For anything with video it is dominated by the video
            // stream, so it must never stand in for one.
            const isAudioOnlySession =
                isAudio(view.mediaType) ||
                view.mediaType === 'music' ||
                isAudiobook(view.mediaType);
            // For TV episodes: series_id is the TV series.
            // For music tracks: series_id from the view is null; use album_id instead
            // (album_id doubles as seriesId for image routing in the session card).
            const seriesId = isTrackSession
                ? (enriched?.album_id ?? view.seriesId ?? undefined)
                : (enriched?.series_id ?? view.seriesId ?? undefined);
            const seriesName = isTrackSession
                ? (enriched?.album_name ?? undefined)
                : (enriched?.series_title ?? undefined);

            const sourceSessionId = view.sourceSessionId ?? undefined;
            const deviceIdVal = view.device?.deviceId ?? enriched?.device_id ?? '';
            // NULL (never announced) and [] (announced nothing) both collapse
            // to undefined — consumers act on them identically, and a `[]` on
            // the wire would invite a reader to think otherwise.
            const clientFeatures = enriched?.client_features?.length
                ? enriched.client_features
                : undefined;

            // NOTE for 'audiobookshelf': this is a book we STREAM (Lumastra
            // proxies the bytes and holds an ABS session open on the listener's
            // behalf), so it stays stoppable — `isReadOnly` is deliberately not
            // set here. Only the merged upstream rows added by
            // mergeDirectAudiobookshelfSessions() are read-only. Without this
            // arm the row fell through to 'jellyfin' and the widget both
            // mislabelled it and hid its Stop button.
            // 'local' needs its own arm for the same reason 'audiobookshelf'
            // did: the chain ends in an unconditional 'jellyfin', so any source
            // without an arm is not merely unlabelled — it is actively
            // MISlabelled as a Jellyfin session, and the widget then draws a
            // Jellyfin badge on a phone playing its own download.
            const sessionSource: StreamSession['sessionSource'] =
                view.source === 'lumastra' || view.source === 'music'
                    ? 'lumastra'
                    : view.source === 'subsonic'
                      ? 'subsonic'
                      : view.source === 'audiobookshelf'
                        ? 'audiobookshelf'
                        : view.source === 'local'
                          ? 'local'
                          : 'jellyfin';

            const externalIds: StreamSession['externalIds'] = {
                internal: mediaId,
                ...(enriched?.tmdb_id ? { tmdb: enriched.tmdb_id } : {}),
                ...(enriched?.imdb_id ? { imdb: enriched.imdb_id } : {}),
            };

            const parseRating = (raw: string | null | undefined): number | undefined => {
                if (raw == null || raw === '') return undefined;
                const n = Number(raw);
                return Number.isFinite(n) ? n : undefined;
            };

            // `play_sessions.resolution` is stored as a "WIDTHxHEIGHT" string
            // (e.g. "1920x1080") — see getSessionSourceInfo in play-sessions.service.
            // Split it into the numeric width/height the session card's resolution
            // badge (getFriendlyResolution) and video line expect. Non-conforming
            // values (null, "1080p", empty) yield undefined and simply hide the badge.
            const parseResolution = (
                raw: string | null | undefined,
            ): { width?: number; height?: number } => {
                if (!raw) return {};
                const match = /^(\d+)x(\d+)$/.exec(raw.trim());
                if (!match) return {};
                const width = Number(match[1]);
                const height = Number(match[2]);
                return {
                    width: Number.isFinite(width) ? width : undefined,
                    height: Number.isFinite(height) ? height : undefined,
                };
            };
            const { width: videoWidth, height: videoHeight } = parseResolution(
                enriched?.resolution,
            );

            const session: StreamSession = {
                __id: view.sessionId,
                id: mediaId,
                mediaItemId: mediaId,
                title,
                mediaType: view.mediaType as StreamSession['mediaType'],
                username: view.username,
                userId: view.userId,
                clientname,
                isCarPlay: sessionCarPlayContext(enriched?.external_payload),
                clientVersion: enriched?.client_version ?? view.device?.version,
                userAgent: rawDeviceName ?? undefined,
                browsername,
                formFactor,
                playSessionId: sourceSessionId,
                deviceId: deviceIdVal,
                ...(clientFeatures ? { clientFeatures } : {}),
                playCurrentTime: positionSecs,
                playItemDuration: runtimeSecs,
                streamProgress,
                playIsPlaying: view.isPlaying,
                sessionSource,
                externalIds,
                imageId: seriesId ?? mediaId,
                seriesId,
                seriesName,
                overview: enriched?.overview ?? undefined,
                year: enriched?.year ?? undefined,
                duration:
                    enriched?.runtime_seconds != null ? enriched.runtime_seconds : runtimeSecs,
                rating: parseRating(enriched?.community_rating),
                criticRating: parseRating(enriched?.critic_rating),
                officialRating: enriched?.official_rating ?? undefined,
                artistId: enriched?.artist_id ?? undefined,
                seasonNumber: enriched?.season_number ?? undefined,
                episodeNumber: enriched?.episode_number ?? undefined,
                playMethod: enriched?.play_method ?? undefined,
                playCodec: enriched?.video_codec ?? undefined,
                // Also expose the source video codec under playOriginalCodec so the
                // card's video line (getVideoTranscodeDisplay) has a codec even on
                // the source→target branch, matching how it reads Jellyfin sessions.
                playOriginalCodec: enriched?.video_codec ?? undefined,
                // `audio_codec` is what the session itself recorded; `file_audio_codec`
                // is the probed stream, used for sessions that never wrote one
                // (Subsonic, rows predating format capture on music sessions).
                playOriginalAudioCodec:
                    enriched?.audio_codec ?? enriched?.file_audio_codec ?? undefined,
                playOriginalContainer: enriched?.container ?? enriched?.file_container ?? undefined,
                playBitrate:
                    enriched?.bitrate_kbps != null ? enriched.bitrate_kbps * 1000 : undefined,
                // Source video bitrate (kbps → bps) so the video line renders
                // "CODEC (X Mbps)" whether or not the stream is transcoding.
                playOriginalBitrate:
                    enriched?.bitrate_kbps != null ? enriched.bitrate_kbps * 1000 : undefined,
                // Audio bitrate in bps. Lossless codecs report no per-stream
                // bitrate, so for audio-only media fall back to the file's
                // overall bitrate — the same number in practice, and the only
                // way FLAC/ALAC gets a figure at all. Video keeps the probed
                // stream value or nothing: ~12k library episodes have an audio
                // stream with no bitrate of its own, and quoting their ~3.5 Mbps
                // file total as "audio" would be plain wrong.
                playOriginalAudioBitrate:
                    enriched?.file_audio_bitrate ??
                    (isAudioOnlySession
                        ? (enriched?.file_total_bitrate ??
                          (enriched?.bitrate_kbps != null
                              ? enriched.bitrate_kbps * 1000
                              : undefined))
                        : undefined),
                playAudioSampleRate: enriched?.file_audio_sample_rate ?? undefined,
                playAudioChannels: enriched?.file_audio_channels ?? undefined,
                // Parsed from the "WxH" resolution string — drives the resolution
                // badge (720p/1080p/4K) on the card.
                playVideoWidth: videoWidth,
                playVideoHeight: videoHeight,
                // Selected audio / subtitle track — the values the heartbeat writes
                // for the track the viewer actually chose. Mirrors what
                // /admin/users/sessions surfaces as the selected audio/subtitle
                // language. play_sessions carries only the single active language
                // (no per-track list), so the card shows the selected one directly.
                playAudioLanguage: enriched?.audio_language ?? undefined,
                playSubtitleLanguage: enriched?.subtitle_language ?? undefined,
                playSubtitleMethod:
                    (enriched?.subtitle_method as StreamSession['playSubtitleMethod']) ?? undefined,
                isBuffering: view.isBuffering,
                artistName: enriched?.artist_name ?? undefined,
                albumName: enriched?.album_name ?? undefined,
                albumId: enriched?.album_id ?? undefined,
                nextTrack: musicLiveInfo.get(view.sessionId)?.nextTrack,
                crossfade: musicLiveInfo.get(view.sessionId)?.crossfade,
            };
            return session;
        });

        const sortedSessions = MediaAggregationService.sortSessions(sessions);

        const jellyfinCount = views.filter((v) => ['jellyfin', 'livetv'].includes(v.source)).length;

        return {
            sessions: sortedSessions,
            totalSessions: sortedSessions.length,
            sources: {
                jellyfin: { count: jellyfinCount, success: true },
            },
            cacheTimestamp: Date.now(),
        };
    }

    /**
     * Sort and deduplicate search results
     */
    private static sortAndDeduplicateResults(
        items: MediaItem[],
        query: string,
        maxResults: number,
    ): MediaItem[] {
        const normalizedQuery = DataNormalizationService.normalizeTitle(query);

        // Score items based on relevance
        const scoredItems = items.map((item) => {
            const normalizedTitle = DataNormalizationService.normalizeTitle(item.title || '');
            let score = 0;

            // Exact title match
            if (normalizedTitle === normalizedQuery) {
                score += 100;
            }
            // Title starts with query
            else if (normalizedTitle.startsWith(normalizedQuery)) {
                score += 80;
            }
            // Title contains query
            else if (normalizedTitle.includes(normalizedQuery)) {
                score += 60;
            }

            // Boost score for newer content
            if (item.year && item.year > 2015) {
                score += (item.year - 2015) * 2;
            }

            // Boost score for higher rated content
            if (item.rating) {
                score += item.rating * 5;
            }

            return { item, score };
        });

        // Sort by score and remove duplicates
        const seen = new Set<string>();
        return scoredItems
            .sort((a, b) => b.score - a.score)
            .filter(({ item }) => {
                const key = `${item.title}-${item.year}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .slice(0, maxResults)
            .map(({ item }) => item);
    }

    /**
     * Sort sessions by username and media name
     */
    private static sortSessions(sessions: StreamSession[]): StreamSession[] {
        return sessions.sort((a, b) => {
            const usernameCompare = a.username.localeCompare(b.username);
            if (usernameCompare !== 0) return usernameCompare;
            return a.__id.localeCompare(b.__id);
        });
    }

    /**
     * Get aggregation statistics
     */
    static getAggregationStats(result: AggregatedSearchResults | SessionAggregationResult): {
        totalItems: number;
        successfulSources: number;
        failedSources: number;
        sourceBreakdown: { [key: string]: number };
    } {
        const sources = result.sources;
        let successfulSources = 0;
        let failedSources = 0;
        const sourceBreakdown: { [key: string]: number } = {};

        Object.entries(sources).forEach(([source, info]) => {
            if (info.success) {
                successfulSources++;
            } else {
                failedSources++;
            }
            sourceBreakdown[source] = info.count;
        });

        return {
            totalItems: 'totalResults' in result ? result.totalResults : result.totalSessions,
            successfulSources,
            failedSources,
            sourceBreakdown,
        };
    }
}

// Export singleton instance for convenience
export const mediaAggregationService = MediaAggregationService;
