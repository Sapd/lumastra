// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getMediaItemForWatch } from '$lib/server/database/queries/catalog-operations.queries.js';
import { getDefaultFileDurationMs } from '$lib/server/database/queries/media-files.queries.js';
import { getActiveLibraryTypes } from '$lib/server/database/queries/library-types.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import {
    findEpisodeByNumber,
    findNextSequentialEpisode,
    getFileSiblingEpisodes,
    type FileSiblingEpisodeRow,
    type NextSequentialEpisodeRow,
} from '$lib/server/database/queries/episode-search.queries.js';
import { buildCombinedEpisodeTitle } from '$lib/server/utils/episode-title.js';
import { config } from '$lib/server/config.js';
import { getPlaybackPreferences } from '$lib/server/database/queries/user-preferences.queries.js';
import { resolveMetadataLanguage } from '$lib/server/utils/metadata-language-resolve.js';
import {
    applyTranslationOverlay,
    type TranslationOverlayLanguages,
} from '$lib/server/utils/translation-overlay.js';
import {
    isSeries,
    isEpisode,
    isTvChannel,
    isSeason,
    isMovie,
    isAlbum,
    isArtist,
    isTrack,
    isNonEntertainment,
    isExtra,
} from '$lib/server/utils/media-types.js';
import type { EpisodeSegment, NextEpisodeInfo, PlaybackInfo } from '$lib/schemas/playback-types.js';
import { watchManager } from '$lib/server/services/watch-manager.service.js';
import { resolveEffectiveResume } from '$lib/server/services/effective-playback.js';
import {
    fileRuntimeMsForResume,
    resumePositionForStart,
} from '$lib/server/utils/watch-constants.js';
import {
    effectiveSeriesMarker,
    type SeriesMarker,
} from '$lib/server/services/effective-series-marker.service.js';
import { getDb } from '$lib/server/database/index.js';
import { Logger } from '$lib/server/utils/logger.js';
import { buildEpisodeSlug, buildWatchSlug } from '$lib/utils/url-slugs.js';
import { resolveViewingContext } from './viewing-context.js';
import { appPath } from '$lib/shared/api-urls.js';
import { resolveStation } from '$lib/server/services/livetv/station.service.js';
import { canStreamLiveTvChannel } from '$lib/server/services/livetv/channel-access.js';
import { listPluginWidgetsFor } from '$lib/server/plugins/runtime/widget-metadata.js';

const logger = Logger.for('Watch');

function parsePositiveInt(value: string | null): number | undefined {
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function buildWatchRedirectUrl(
    itemId: string,
    options?: {
        slug?: string | null;
        resolved?: string;
        info?: string;
        /** Additional landing params; null/undefined values are omitted. */
        extra?: Record<string, string | null | undefined>;
    },
): string {
    const search = new URLSearchParams();

    if (options?.slug) search.set('slug', options.slug);
    if (options?.resolved) search.set('resolved', options.resolved);
    if (options?.info) search.set('info', options.info);
    for (const [key, value] of Object.entries(options?.extra ?? {})) {
        if (value !== null && value !== undefined) search.set(key, value);
    }

    const query = search.toString();
    return query ? `/watch/${itemId}?${query}` : `/watch/${itemId}`;
}

function buildEpisodeRedirectInfo(
    mediaItem: {
        media_type: string;
        season_number: number | null;
        episode_number: number | null;
    },
    seasonNumber: number,
    episodeNumber: number,
): string {
    const requested = `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;

    if (
        isEpisode(mediaItem.media_type) &&
        mediaItem.season_number != null &&
        mediaItem.episode_number != null &&
        (mediaItem.season_number !== seasonNumber || mediaItem.episode_number !== episodeNumber)
    ) {
        return `Redirected to ${requested} because the URL specified a different episode than the UUID target.`;
    }

    return `Opened ${requested} because the URL specified that episode.`;
}

function buildCanonicalWatchUrlForItem(
    itemId: string,
    mediaItem: {
        title: string;
        media_type: string;
        series_title: string | null;
        season_number: number | null;
        episode_number: number | null;
    },
    options?: {
        resolved?: string;
        info?: string;
    },
): string {
    return buildWatchRedirectUrl(itemId, {
        slug: buildWatchSlug({
            mediaType: mediaItem.media_type,
            title: mediaItem.title,
            seriesTitle: mediaItem.series_title,
            seasonNumber: mediaItem.season_number,
            episodeNumber: mediaItem.episode_number,
        }),
        resolved: options?.resolved,
        info: options?.info,
    });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseNonNegativeInt(value: string | null): number | null {
    if (!value || !/^\d+$/.test(value)) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function episodeCode(seasonNumber: number, episodeNumber: number): string {
    return `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
}

/**
 * Where `/watch/<seriesId>` sends the caller, given the series watch marker.
 *
 * Without `from` (or when `from` is unrelated to this series, `relation ===
 * 'none'`) it lands on the marker episode; a finished series is sent to its
 * first episode by the caller before this runs. With `from` it is the
 * forward-only re-check of an open player: never backward, a forward move
 * inside the playing file is a seek, and only a forward move to another file
 * navigates. A finished series keeps the player on `from` and shows the
 * finished card there, unless the marker is behind it (the viewer is already
 * past the finale, e.g. rewatching). `dev`/`mk` only feed the landing toast copy. No `t` is ever set:
 * the landing load resumes the marker position via `resolveEffectiveResume`,
 * and `?t=` stays reserved for explicit episode links.
 */
function seriesMarkerRedirectUrl(
    seriesTitle: string,
    marker: SeriesMarker,
    from: { episodeId: string; positionMs: number | null } | null,
): string | null {
    const ep = marker.episode;
    if (!ep) return null;
    const mk = episodeCode(ep.seasonNumber, ep.episodeNumber);
    const toastParams = { dev: marker.deviceName, mk };

    if (from && marker.relation !== 'none') {
        if (marker.state === 'finished' && marker.relation !== 'behind') {
            return buildWatchRedirectUrl(from.episodeId, {
                resolved: 'finished',
                extra: { dev: marker.deviceName },
            });
        }
        if (marker.relation !== 'forward') {
            return buildWatchRedirectUrl(from.episodeId, { resolved: 'stay' });
        }
        if (ep.id === from.episodeId || marker.sameFileAsFrom) {
            return buildWatchRedirectUrl(from.episodeId, {
                resolved: 'seek',
                extra: { seekMs: String(marker.positionMs), ...toastParams },
            });
        }
        return buildWatchRedirectUrl(ep.id, {
            slug: buildEpisodeSlug(seriesTitle, ep.seasonNumber, ep.episodeNumber),
            resolved: 'series',
            extra: {
                from: from.episodeId,
                fromPos: from.positionMs === null ? null : String(from.positionMs),
                ...toastParams,
            },
        });
    }

    // A finished series reaches this point only when its first-episode lookup
    // failed: it lands on the last watched episode, whose finished card is the
    // landing's one notice, so it carries no `info` toast on top.
    const finished = marker.state === 'finished';
    return buildWatchRedirectUrl(ep.id, {
        slug: buildEpisodeSlug(seriesTitle, ep.seasonNumber, ep.episodeNumber),
        resolved: finished ? 'finished' : 'series',
        info: finished ? undefined : `Playing ${mk} - ${ep.title}`,
        extra: toastParams,
    });
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
    const { itemId } = params;

    logger.debug('Loading playback', { itemId });

    if (!itemId) {
        throw error(400, 'Missing item ID');
    }

    const lumastraUsername = locals.user?.username;
    const lumastraUserId = locals.user?.userId;
    if (!lumastraUsername || !lumastraUserId) throw redirect(302, appPath('/'));

    const sql = getDb();
    if (!sql) throw error(503, 'Database unavailable');

    // Resolve any ID format (UUID, Jellyfin, TMDB composite tmdb:id:type, etc.)
    // to the internal UUID, which playback always needs.
    let internalId = itemId;
    const isAlreadyUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        itemId,
    );
    if (!isAlreadyUuid) {
        try {
            const { mediaIdResolver } = await import('$lib/server/services/media-id-resolver.js');
            const resolved = await mediaIdResolver.resolveAnyMediaId(itemId);
            if (resolved.internalId) internalId = resolved.internalId;
        } catch {
            // Fall through with original itemId; the UUID-shape guard below 404s it.
        }
    }

    // internalId may still be the raw, non-UUID itemId when resolution above
    // failed to find a match. getMediaItemForWatch's query expects a UUID
    // column value and Postgres throws (rather than returning no rows) on a
    // malformed one, so guard here instead of letting that surface as a 500.
    if (!UUID_RE.test(internalId)) throw error(404, 'Item not found');

    let station: Awaited<ReturnType<typeof resolveStation>> = null;
    let catalogId = internalId;

    // Fetch + access-check concurrently: both key only on internalId, so the
    // access probe does not need to wait for the row. The only cost is one
    // wasted access query when the item does not exist (a 404 path, where
    // latency does not matter); the win is one fewer serial round-trip on
    // every successful load.
    //
    // Both 404s stay deliberately identical — a "not accessible" response must
    // not be distinguishable from "does not exist", or the route leaks the
    // existence of items outside the user's libraries.
    // Fail CLOSED when there is no user. /watch is behind forward auth (it is not
    // in hooks.server.ts' bypass-auth prefix list), so locals.user is always set
    // here in practice — but the previous `Promise.resolve(true)` meant that if it
    // ever were absent, any item was reachable by UUID with no gate at all.
    if (!locals.user) throw error(404, 'Item not found');

    // checkMediaAccess, NOT isMediaAccessible: the latter is the library-group
    // axis only and returns true whenever no library restrictions are configured,
    // which let an age-restricted user stream an 18-rated item.
    let [mediaItem, accessible] = await Promise.all([
        getMediaItemForWatch(sql, catalogId),
        checkMediaAccess(sql, catalogId, locals.user),
    ]);

    if (locals.user.hasLiveTvPermission && (!mediaItem || isTvChannel(mediaItem.media_type))) {
        station = await resolveStation(internalId);
        if (station && station.shownFeedId !== catalogId) {
            catalogId = station.shownFeedId;
            [mediaItem, accessible] = await Promise.all([
                getMediaItemForWatch(sql, catalogId),
                checkMediaAccess(sql, catalogId, locals.user),
            ]);
        }
    }
    if (!mediaItem) throw error(404, 'Item not found');
    if (!accessible) throw error(404, 'Item not found');

    const requestedSeason = parsePositiveInt(url.searchParams.get('season'));
    const requestedEpisode = parsePositiveInt(url.searchParams.get('episode'));
    const hasEpisodeOverride = requestedSeason !== undefined && requestedEpisode !== undefined;

    if (hasEpisodeOverride) {
        const seriesId =
            isSeries(mediaItem.media_type) || isEpisode(mediaItem.media_type)
                ? (mediaItem.series_id ?? internalId)
                : isSeason(mediaItem.media_type)
                  ? mediaItem.series_id
                  : null;

        if (seriesId) {
            const currentMatchesRequested =
                isEpisode(mediaItem.media_type) &&
                mediaItem.season_number === requestedSeason &&
                mediaItem.episode_number === requestedEpisode;

            if (!currentMatchesRequested) {
                const requestedTarget = await findEpisodeByNumber(
                    sql,
                    seriesId,
                    requestedSeason,
                    requestedEpisode,
                );

                if (requestedTarget?.id) {
                    const slug = buildEpisodeSlug(
                        mediaItem.series_title ?? mediaItem.title,
                        requestedSeason,
                        requestedEpisode,
                    );

                    throw redirect(
                        302,
                        buildWatchRedirectUrl(requestedTarget.id, {
                            slug,
                            resolved: 'episode-query',
                            info: buildEpisodeRedirectInfo(
                                mediaItem,
                                requestedSeason,
                                requestedEpisode,
                            ),
                        }),
                    );
                }

                if (isEpisode(mediaItem.media_type)) {
                    const requested = `S${String(requestedSeason).padStart(2, '0')}E${String(requestedEpisode).padStart(2, '0')}`;
                    throw redirect(
                        302,
                        buildCanonicalWatchUrlForItem(internalId, mediaItem, {
                            resolved: 'episode-query',
                            info: `${requested} does not exist for this series, so the URL was reset to the episode UUID target.`,
                        }),
                    );
                }
            }
        }
    }

    // Series → redirect to the series watch marker (continue mode). `from`,
    // `fromPos` and `sid` come from an open player re-checking the marker:
    // `sid` is that player's own play session, which its paused keepalive keeps
    // fresh, so it must be excluded or the live step finds the player itself.
    if (isSeries(mediaItem.media_type)) {
        const fromParam = url.searchParams.get('from');
        const from =
            fromParam && UUID_RE.test(fromParam)
                ? {
                      episodeId: fromParam,
                      positionMs: parseNonNegativeInt(url.searchParams.get('fromPos')),
                  }
                : null;

        let marker: SeriesMarker;
        try {
            marker = await effectiveSeriesMarker({
                userId: lumastraUserId,
                seriesId: internalId,
                fromEpisodeId: from?.episodeId ?? null,
                fromPositionMs: from?.positionMs ?? null,
                excludeSessionId: url.searchParams.get('sid') || null,
                sql,
            });
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            // A re-check never blocks playback: keep the open player where it is.
            if (from) {
                logger.warn('Series marker re-check failed; staying on from', {
                    seriesId: internalId,
                    error: errorMessage,
                });
                throw redirect(302, buildWatchRedirectUrl(from.episodeId, { resolved: 'stay' }));
            }
            // A plain series link still plays something: the first episode.
            logger.warn('Series marker lookup failed; falling back to the first episode', {
                seriesId: internalId,
                error: errorMessage,
            });
            const firstEp = await watchManager.getFirstEpisode(internalId).catch(() => null);
            if (firstEp?.media_id) {
                throw redirect(
                    302,
                    buildWatchRedirectUrl(firstEp.media_id, {
                        slug: buildEpisodeSlug(
                            mediaItem.title,
                            firstEp.season_number,
                            firstEp.episode_number,
                        ),
                        resolved: 'series',
                        info: `Starting from ${episodeCode(firstEp.season_number, firstEp.episode_number)} - ${firstEp.title}`,
                    }),
                );
            }
            throw error(404, 'No episodes found for this series');
        }

        // A series Play on a finished series rewatches it from the first
        // main-line episode; the finished card belongs to an open player's
        // re-check (`from`) only. When that lookup fails, the marker landing
        // below still plays something.
        if (marker.state === 'finished' && (!from || marker.relation === 'none')) {
            const firstEp = await watchManager.getFirstEpisode(internalId).catch(() => null);
            if (firstEp?.media_id) {
                throw redirect(
                    302,
                    buildWatchRedirectUrl(firstEp.media_id, {
                        slug: buildEpisodeSlug(
                            mediaItem.title,
                            firstEp.season_number,
                            firstEp.episode_number,
                        ),
                        resolved: 'series',
                        info: `Rewatching from ${episodeCode(firstEp.season_number, firstEp.episode_number)} - ${firstEp.title}`,
                    }),
                );
            }
        }

        const target = seriesMarkerRedirectUrl(mediaItem.title, marker, from);
        if (target) throw redirect(302, target);
        throw error(404, 'No episodes found for this series');
    }

    // LiveTV channel → build live playback info with stream URL
    if (isTvChannel(mediaItem.media_type)) {
        if (!station) throw error(404, 'Item not found or not playable');
        const hasLiveTvPermission = locals.user?.hasLiveTvPermission ?? false;
        if (!hasLiveTvPermission) {
            throw error(404, 'Item not found or not playable');
        }
        // The stream endpoints refuse a channel the lineup does not offer this
        // viewer (a hidden feed with the feed picker off, a hidden category);
        // say so here instead of a player that never starts.
        if (!(await canStreamLiveTvChannel(locals, catalogId))) {
            throw error(404, 'Item not found or not playable');
        }

        const liveTvPlaybackInfo: PlaybackInfo = {
            itemId: internalId,
            internalId: catalogId,
            title: mediaItem.title,
            mediaType: 'tvchannel',
            runTimeTicks: 0,
            isLive: true,
            userData: {
                playbackPositionTicks: 0,
                playedPercentage: 0,
                played: false,
            },
            // LiveTV has no resume semantic — anchor null, never watched.
            resumeAnchor: null,
            isWatched: false,
            mediaSources: [
                {
                    id: `livetv-${internalId}`,
                    name: mediaItem.title,
                    container: 'hls',
                    size: 0,
                    bitrate: 0,
                    isLive: true,
                    // Allocated by the browser playback-session start.
                    transcodingUrl: undefined,
                    supportsDirectPlay: false,
                    supportsDirectStream: true,
                    supportsTranscoding: false,
                    videoStreams: [],
                    audioStreams: [],
                    subtitleStreams: [],
                },
            ],
            playSessionId: randomUUID(),
        };

        return {
            playbackInfo: liveTvPlaybackInfo,
            mediaDbId: catalogId,
            pageTitle: mediaItem.title,
            itemId: internalId,
            username: lumastraUsername,
            userId: lumastraUserId,
        };
    }

    // Season → resolve directly to next unwatched episode in this season
    if (isSeason(mediaItem.media_type)) {
        const nextEp = await watchManager
            .getNextUpForSeason(internalId, lumastraUserId)
            .catch(() => null);
        if (nextEp?.media_id) {
            const s = String(nextEp.season_number).padStart(2, '0');
            const e = String(nextEp.episode_number).padStart(2, '0');
            throw redirect(
                302,
                buildWatchRedirectUrl(nextEp.media_id, {
                    slug: buildEpisodeSlug(
                        mediaItem.series_title ?? mediaItem.title,
                        nextEp.season_number,
                        nextEp.episode_number,
                    ),
                    resolved: 'season',
                    info: `Playing S${s}E${e} - ${nextEp.title}`,
                }),
            );
        }
        // No unwatched → first episode of this season
        const firstEp = await watchManager.getFirstEpisodeForSeason(internalId).catch(() => null);
        if (firstEp?.media_id) {
            const s = String(firstEp.season_number).padStart(2, '0');
            const e = String(firstEp.episode_number).padStart(2, '0');
            throw redirect(
                302,
                buildWatchRedirectUrl(firstEp.media_id, {
                    slug: buildEpisodeSlug(
                        mediaItem.series_title ?? mediaItem.title,
                        firstEp.season_number,
                        firstEp.episode_number,
                    ),
                    resolved: 'season',
                    info: `Starting from S${s}E${e} - ${firstEp.title}`,
                }),
            );
        }
        throw error(404, 'No episodes found for this season');
    }

    // Music types → redirect to music pages (music player lives in main layout, not /watch/)
    if (isAlbum(mediaItem.media_type)) {
        throw redirect(302, appPath(`/music/albums/${internalId}?autoplay=true`));
    }
    if (isArtist(mediaItem.media_type)) {
        throw redirect(302, appPath(`/music/artists/${internalId}?autoplay=true`));
    }
    if (isTrack(mediaItem.media_type) && mediaItem.parent_id) {
        // Redirect track to its parent album with autoplay
        throw redirect(302, appPath(`/music/albums/${mediaItem.parent_id}?autoplay=true`));
    }

    // Non-playable types (audiobook, book, etc.) are not watchable.
    // Non-entertainment leaf items (home_video, personal, training, educational)
    // ARE playable — they fall through to the same movie-style player path below.
    // Extras (trailers/featurettes) are playable file-backed items too — the
    // modal's "open trailer in full player" lands here with the extra's own id.
    if (
        !isEpisode(mediaItem.media_type) &&
        !isMovie(mediaItem.media_type) &&
        !isExtra(mediaItem.media_type) &&
        !isNonEntertainment(mediaItem.media_type)
    ) {
        throw error(404, 'Item not found or not playable');
    }

    // No local file → nothing to stream. This is the common case for a
    // DISCOVERY/catalog item (e.g. a recommendation that isn't in the library):
    // building a player with empty mediaSources would just fail the HLS request
    // with a cryptic "connection problem". Fail early with a clear reason so the
    // watch error page can explain it instead. (Lumastra streams local files
    // only; a Jellyfin link without a local file is not streamable here.)
    if (!mediaItem.has_files) {
        logger.info('Watch requested for an item with no playable file', {
            internalId,
            mediaType: mediaItem.media_type,
        });
        throw error(
            404,
            "This title isn't in your library yet, so there's nothing to play. It's a discovery result — add it to your library to watch it.",
        );
    }

    const lumastraMediaType = isEpisode(mediaItem.media_type)
        ? ('episode' as const)
        : isSeries(mediaItem.media_type)
          ? ('tv' as const)
          : ('movie' as const);

    // These five reads have no data dependency on each other — they key only on
    // (userId, internalId, series_id), all known above — so they run as one
    // round-trip instead of five serial ones. The first consumer of any of them
    // is applyTranslationOverlay() below, which needs the first four anyway.
    //
    // Keep them in one Promise.all: reintroducing a serial await here puts a
    // full DB round-trip back on the path that gates time-to-first-frame.
    // Each branch keeps its own .catch so one failure degrades that feature
    // alone rather than failing the whole page (Promise.all rejects on first
    // rejection, so the catches are load-bearing, not decorative).
    const [effectiveResume, nextRow, siblings, playbackPrefs, fileDurationMs] = await Promise.all([
        // Resume position: prefer fresh live session, fall back to durable state, then 0.
        // is_watched ships on EffectiveResume (sourced from the same memoized watch-state
        // row) so the player can defensively clear its localStorage resume cache for
        // already-watched media — see localstorage-resume-backup-design.md.
        resolveEffectiveResume(lumastraUserId, internalId),

        // For episodes, look up the sequentially-next episode in the same series.
        // Ordering-aware: respects the active series ordering when one is set.
        lumastraMediaType === 'episode' &&
        mediaItem.series_id &&
        mediaItem.season_number != null &&
        mediaItem.episode_number != null
            ? (locals.user
                  ? buildSearchAccessContext(sql, locals.user).then(searchAccessBoundary)
                  : Promise.resolve(undefined)
              )
                  // The boundary goes into the SQL so a hidden next episode is
                  // skipped, as the autoplay endpoint does; the check below stays.
                  .then((access) =>
                      findNextSequentialEpisode(sql, mediaItem.series_id as string, internalId, {
                          afterCurrentFile: true,
                          playableOnly: true,
                          specialsStayInSeason: true,
                          access,
                      }),
                  )
                  .then(async (next): Promise<NextSequentialEpisodeRow | null> =>
                      next && (await checkMediaAccess(sql, next.id, locals.user)) ? next : null,
                  )
                  .catch((err): NextSequentialEpisodeRow | null => {
                      logger.warn('Failed to resolve next sequential episode', {
                          internalId,
                          seriesId: mediaItem.series_id,
                          error: err instanceof Error ? err.message : String(err),
                      });
                      return null;
                  })
            : Promise.resolve<NextSequentialEpisodeRow | null>(null),

        // For combined multi-episode files, collect all sibling episodes sharing the
        // same default file so we can show the range (S01E05-E06) and both titles.
        lumastraMediaType === 'episode'
            ? getFileSiblingEpisodes(sql, internalId).catch((): FileSiblingEpisodeRow[] => [])
            : Promise.resolve<FileSiblingEpisodeRow[]>([]),

        // Per-user metadata-title overlay input. Only read when the install
        // actually has additional languages configured.
        config.METADATA_ADDITIONAL_LANGUAGES.length > 0
            ? getPlaybackPreferences.one(sql, { userId: lumastraUserId })
            : Promise.resolve(null),

        // The default file's probed duration: what "this resume is at the end"
        // is judged against (resumePositionForStart). Unknown → keep the resume.
        getDefaultFileDurationMs(sql, internalId).catch((err): number | null => {
            logger.warn('Failed to read default file duration', {
                internalId,
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }),
    ]);

    // Per-user metadata-title overlay. Everything the player header, the browser
    // tab title and the next-episode card display is built from these rows below,
    // so translate them here — one overlay call over every row at once, rather
    // than a lookup per display string.
    const translationLangs: TranslationOverlayLanguages = playbackPrefs
        ? resolveMetadataLanguage(playbackPrefs)
        : { titleLang: null, textLang: null };

    interface TranslationTarget {
        id: string;
        applyTitle?: (value: string) => void;
        applyOverview?: (value: string) => void;
    }

    const translationTargets: TranslationTarget[] = [
        {
            id: internalId,
            applyTitle: (value) => {
                mediaItem.title = value;
            },
        },
    ];
    if (mediaItem.series_id) {
        translationTargets.push({
            id: mediaItem.series_id,
            applyTitle: (value) => {
                mediaItem.series_title = value;
            },
        });
    }
    for (const sibling of siblings) {
        translationTargets.push({
            id: sibling.id,
            applyTitle: (value) => {
                sibling.title = value;
            },
        });
    }
    if (nextRow) {
        const row = nextRow;
        translationTargets.push({
            id: row.id,
            applyTitle: (value) => {
                row.title = value;
            },
            applyOverview: (value) => {
                row.overview = value;
            },
        });
    }

    await applyTranslationOverlay(sql, translationTargets, translationLangs, {
        id: (target) => target.id,
        setTitle: (target, value) => target.applyTitle?.(value),
        setOverview: (target, value) => target.applyOverview?.(value),
    });

    const nextEpisode: NextEpisodeInfo | undefined = nextRow
        ? {
              itemId: nextRow.id,
              internalId: nextRow.id,
              title: nextRow.title,
              episodeNumber: nextRow.episode_number,
              seasonNumber: nextRow.season_number,
              isNewSeason: nextRow.is_new_season,
              seriesName: mediaItem.series_title ?? undefined,
              hasPrimaryImage: nextRow.has_primary_image,
              overview: nextRow.overview ?? undefined,
          }
        : undefined;

    // A combined file stays ONE video: it holds both episodes back to back, plays
    // straight through, and the timeline spans the whole file so you can scrub from
    // one episode into the next. The window is therefore an ENTRY POINT, not a
    // fence — opening episode 25 starts at its first frame instead of replaying
    // episode 24 from the top. Presentation stays combined ("S02E24-E25 - A / B")
    // for either entry point, because that is honestly what the file is.
    const selfSibling = siblings.find((sibling) => sibling.id === internalId);
    const episodeSegment: EpisodeSegment | undefined =
        selfSibling?.start_offset_ms != null && selfSibling.end_offset_ms != null
            ? {
                  startMs: Number(selfSibling.start_offset_ms),
                  endMs: Number(selfSibling.end_offset_ms),
              }
            : undefined;

    let combinedEpisodeTitle: string | undefined;
    let episodeStartNumber: number | undefined;
    let episodeEndNumber: number | undefined;
    let episodeRangeCode: string | undefined;

    if (siblings.length > 1) {
        const seasonNum = mediaItem.season_number ?? 1;
        const combined = buildCombinedEpisodeTitle(siblings, seasonNum);
        // Use `||` so an all-null-title combined file falls back to the single
        // episode title rather than producing an empty / trailing-dash header.
        combinedEpisodeTitle = combined.title || undefined;
        // Ship BOTH bounds: the client renders the same range and must not
        // re-derive the start from the episode that was opened ("S02E21-E21").
        if (combined.episodeEnd !== combined.episodeStart) {
            episodeStartNumber = combined.episodeStart;
            episodeEndNumber = combined.episodeEnd;
        }
        episodeRangeCode = combined.rangeCode;
    }

    const playbackInfo: PlaybackInfo = {
        itemId: internalId,
        internalId,
        title: combinedEpisodeTitle ?? mediaItem.title,
        // Emit the canonical public discriminator ('series', never the internal
        // 'tv' storage token) that PlaybackInfo.mediaType contracts for.
        mediaType: lumastraMediaType === 'tv' ? 'series' : lumastraMediaType,
        originalLanguage: mediaItem.original_language ?? undefined,
        runTimeTicks: (mediaItem.runtime_seconds ?? 0) * 10_000_000,
        userData: {
            // A finished item (resume past the completion threshold) starts from
            // the beginning — see resumePositionForStart. The player still clamps
            // against the probed duration once it has it (clampStartToPlayable).
            playbackPositionTicks:
                resumePositionForStart({
                    positionMs: effectiveResume.positionMs,
                    runtimeMs: fileRuntimeMsForResume({ fileDurationMs, siblings }),
                    mediaType: mediaItem.media_type,
                }) * 10_000,
            playedPercentage: 0,
            played: false,
        },
        resumeAnchor: effectiveResume.anchorMs,
        isWatched: effectiveResume.isWatched,
        mediaSources: [],
        playSessionId: randomUUID(),
        seriesId: mediaItem.series_id ?? undefined,
        seriesName: mediaItem.series_title ?? undefined,
        seasonNumber: mediaItem.season_number ?? undefined,
        episodeNumber: mediaItem.episode_number ?? undefined,
        episodeStartNumber,
        episodeEndNumber,
        episodeSegment,
        nextEpisode,
    };

    let lumastraPageTitle = mediaItem.title;
    if (isEpisode(mediaItem.media_type) && mediaItem.series_title) {
        // Take the range straight from buildCombinedEpisodeTitle, which spans the
        // file's full episode range. Re-deriving it here from the CURRENT episode
        // paired with the file's LAST episode rendered "S02E25-E25" whenever you
        // landed on the last episode of a combined file.
        const s = String(mediaItem.season_number ?? 1).padStart(2, '0');
        const e = String(mediaItem.episode_number ?? 1).padStart(2, '0');
        const code = episodeRangeCode ?? `S${s}E${e}`;
        lumastraPageTitle = `${mediaItem.series_title} - ${code} - ${combinedEpisodeTitle ?? mediaItem.title}`;
    }

    // =========================================================================
    // ViewingContext resolution — arrival context selects the AGPL shell.
    //
    // Priority order:
    //   1. Explicit ?ctx=educational  → educational shell
    //   2. Explicit ?ctx=personal     → personal shell
    //   3. Library-type fallback from media_type
    //   4. Default                    → vod shell
    // =========================================================================
    const viewingContext = await resolveViewingContext(sql, {
        url,
        internalId,
        mediaType: mediaItem.media_type,
        seriesId: mediaItem.series_id ?? null,
        user: locals.user,
    });
    // Only optional viewers need this fresh configuration read. Root layout
    // data can stay cached across SPA navigation after a library is enabled.
    const viewingShellAvailable =
        viewingContext.kind === 'vod'
            ? false
            : (await getActiveLibraryTypes(sql)).some((type) =>
                  viewingContext.kind === 'educational'
                      ? type === 'educational'
                      : type === 'personal' || type === 'home_video',
              );

    return {
        // Player-placement plugin widgets. Projected here rather than fetched
        // client-side so the player never waits on a request to know whether
        // there is anything to mount — with none (the usual case) the overlay
        // and its 2Hz bridge are never created at all.
        playerWidgets: listPluginWidgetsFor('player'),
        playbackInfo,
        mediaDbId: internalId,
        pageTitle: lumastraPageTitle,
        itemId: internalId,
        username: lumastraUsername,
        userId: lumastraUserId,
        viewingContext,
        viewingShellAvailable,
        canonicalSlug:
            url.searchParams.get('slug') ??
            buildWatchSlug({
                mediaType: mediaItem.media_type,
                title: mediaItem.title,
                seriesTitle: mediaItem.series_title,
                seasonNumber: mediaItem.season_number,
                episodeNumber: mediaItem.episode_number,
            }),
    };
};
