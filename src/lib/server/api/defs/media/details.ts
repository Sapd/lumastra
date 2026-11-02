// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/details.ts — GET /api/media-details
 *
 * Fetch detailed movie/TV info by UUID or composite key.
 *
 * Contract: bare object — canonical MediaDetail (discriminated union on `type`,
 * `ids` open external-ID map, `images` self-describing href map).
 * DB down → 503 dependency_unavailable.
 *
 * Query:
 *   ?key=<UUID | provider:id:mediaType>
 *   e.g. ?key=550e8400-... or ?key=tmdb:550:movie
 *
 * Auth: public (access gated per-item by checkMediaAccess).
 */

import { resolveImageSet } from '$lib/server/services/image-descriptor/index.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { parseMediaId, validateParsedMediaId } from '$lib/server/utils/media-key-parser.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { MediaDetailSchema } from '$lib/schemas/media-detail.js';
import {
    transformToMediaDetail,
    toDbMediaRow,
    type DbMediaRow,
} from '$lib/server/utils/api-transforms.js';
import { buildExternalIdsFromRow } from '$lib/server/utils/external-id-builder.js';
import { getAllExternalIds } from '$lib/server/database/queries/external-ids.queries.js';
import {
    getMediaDetailByUuid,
    getMediaDetailByCompositeKey,
    getCachedListItemByCompositeKey,
} from '$lib/server/database/queries/media-details.queries.js';
import { getMediaStreamSummary } from '$lib/server/database/queries/media-stream-summary.queries.js';
import { config } from '$lib/server/config.js';
import { getPlaybackPreferences } from '$lib/server/database/queries/user-preferences.queries.js';
import { resolveMetadataLanguage } from '$lib/server/utils/metadata-language-resolve.js';
import { applyTranslationOverlay } from '$lib/server/utils/translation-overlay.js';
import type { UserId } from '$lib/shared/user-id.js';
import type { AudiobookDetail, MovieDetail, TvDetail } from '$lib/schemas/media-detail.js';

const logger = Logger.for('MediaDetailsDef');

// ---------------------------------------------------------------------------
// Helpers (lifted directly from the legacy +server.ts)
// ---------------------------------------------------------------------------

function buildExternalIdsFromRowWithProvider(
    row: {
        media_id: string;
        tmdb_id: number | string | null;
        imdb_id: string | null;
        tvdb_id?: number | string | null;
    },
    provider: string,
    queriedExternalId: string,
): Record<string, string> {
    const externalIds = buildExternalIdsFromRow(row) as Record<string, string | undefined>;
    if (!externalIds[provider]) {
        externalIds[provider] = queriedExternalId;
    }
    return externalIds as Record<string, string>;
}

// computeYear/toDbMediaRow moved to $lib/server/utils/api-transforms.js — shared
// with the ?include=details expansion on GET /media/{id} and GET /series/{id}
// so the rich-detail mapping can't drift between the two paths.

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'public' },
    visibility: 'internal',
    request: {
        query: z.object({
            key: z.string().min(1).describe('UUID or composite key (provider:id:mediaType)'),
        }),
    },
    handlers: {
        GET: async (event, ctx) => {
            const { url, locals } = event;

            const key = url.searchParams.get('key') ?? '';
            const parsed = parseMediaId(key);

            if (!validateParsedMediaId(parsed)) {
                return ApiProblem.validationFailed([
                    {
                        field: 'key',
                        message:
                            'key parameter required (format: UUID or provider:id:mediaType, e.g. tmdb:550:movie)',
                        value: key,
                    },
                ]);
            }

            const sqlOrNull = await aiDbService.getSql();
            if (!sqlOrNull) {
                return ApiProblem.dependencyUnavailable('AI Database unavailable');
            }
            // Re-bind to a non-nullable const: closures below (overlayDetail)
            // capture this and TS does not retain the null-check narrowing of
            // `sqlOrNull` across a nested function declaration.
            const sql = sqlOrNull;

            // Per-user metadata-language overlay (multilingual-media-metadata spec
            // §5): resolved ONCE per request. `auth: 'public'` means `locals.user`
            // may be absent — unauthenticated/system requests skip the overlay
            // entirely rather than falling back to a UI-locale guess.
            const overlayUserId = locals.user?.userId;
            let langs = { titleLang: null as string | null, textLang: null as string | null };
            if (overlayUserId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                langs = resolveMetadataLanguage(
                    await getPlaybackPreferences.one(sql, { userId: overlayUserId as UserId }),
                );
            }
            async function overlayDetail<T extends MovieDetail | TvDetail | AudiobookDetail>(
                detail: T,
            ): Promise<T> {
                if (detail.type === 'series' && locals.user) {
                    const { enrichSeriesEpisodeCounts } =
                        await import('$lib/server/services/series-episode-counts.service.js');
                    const { buildSearchAccessContext, searchAccessBoundary } =
                        await import('$lib/server/utils/search-access-context.js');
                    await enrichSeriesEpisodeCounts(
                        sql,
                        [detail],
                        locals.user.userId,
                        searchAccessBoundary(await buildSearchAccessContext(sql, locals.user)),
                    );
                }
                if (!langs.titleLang && !langs.textLang) return detail;
                await applyTranslationOverlay(sql, [detail], langs, {
                    id: (it) => it.id,
                    setTitle: (it, v) => {
                        it.title = v;
                    },
                    setOverview: (it, v) => {
                        it.overview = v;
                    },
                    setTagline: (it, v) => {
                        it.tagline = v;
                    },
                });
                return detail;
            }

            // === UUID PATH ===
            if (parsed.type === 'uuid') {
                const uuid = parsed.uuid!;
                const media = await getMediaDetailByUuid(sql, uuid);
                if (!media) return ApiProblem.notFound('Media not found');

                logger.info('Media details fetched via UUID', { uuid, title: media.title });

                const [hasAccess, extIds] = await Promise.all([
                    checkMediaAccess(sql, media.media_id, locals.user),
                    getAllExternalIds.one(sql, { mediaId: media.media_id }),
                ]);
                if (!hasAccess) {
                    return ApiProblem.notFound('Media not found');
                }

                const externalIds = buildExternalIdsFromRow({
                    media_id: media.media_id,
                    tmdb_id: extIds?.tmdb_id ?? null,
                    imdb_id: extIds?.imdb_id ?? null,
                    tvdb_id: extIds?.tvdb_id ?? null,
                });

                const genreNames = (media.genres || []).filter(Boolean);
                const streamSummary = await getMediaStreamSummary(
                    sql,
                    media.media_id,
                    media.media_type,
                );
                const detail = transformToMediaDetail(
                    toDbMediaRow(media, genreNames),
                    externalIds,
                    streamSummary,
                    ctx.surface,
                    await resolveImageSet(sql, ctx.surface, media.media_id, media.media_type),
                );
                // `null` = the row's media_type has no arm in
                // MediaDetailSchema's closed union (movie | series | audiobook):
                // an episode, season, track, album, artist, channel or
                // non-entertainment row. `key` accepts any UUID, so those DO
                // reach here. They used to be serialized as `type: 'movie'`,
                // which is the audiobook bug with a different subject — a client
                // reading `type: 'movie'` renders "Watch Movie" for one episode.
                // 404 is the honest answer: this endpoint has no representation
                // for the row, and `/media/{id}` is the surface that does.
                if (!detail) {
                    return ApiProblem.notFound('No detail representation for this media type');
                }
                return json(MediaDetailSchema.parse(await overlayDetail(detail)));
            }

            // === COMPOSITE KEY PATH ===
            const {
                provider,
                externalId,
                mediaType: parsedMediaType,
            } = parsed as {
                provider: string;
                externalId: string;
                mediaType: string;
            };
            const mediaType = parsedMediaType === 'tv' ? 'tv' : ('movie' as const);

            const media = await getMediaDetailByCompositeKey(sql, {
                provider,
                externalId,
                mediaType,
            });

            if (!media) {
                const cached = await getCachedListItemByCompositeKey(sql, {
                    provider,
                    externalId,
                    mediaType,
                });

                if (cached) {
                    if (locals.user?.isAgeRestricted) {
                        const exists = await sql<{ exists: boolean }[]>`
                            SELECT EXISTS(
                                SELECT 1 FROM media_items WHERE id = ${cached.media_id}
                            ) AS exists
                        `;
                        if (!exists[0]?.exists) return ApiProblem.notFound('Media not found');
                    }
                    if (!(await checkMediaAccess(sql, cached.media_id, locals.user))) {
                        return ApiProblem.notFound('Media not found');
                    }

                    logger.info('Media details fetched from cached_list_items', {
                        provider,
                        externalId,
                        title: cached.title,
                    });

                    const cachedExtIds = await getAllExternalIds.one(sql, {
                        mediaId: cached.media_id,
                    });
                    const cachedExternalIds = buildExternalIdsFromRowWithProvider(
                        {
                            media_id: cached.media_id,
                            tmdb_id: cachedExtIds?.tmdb_id ?? null,
                            imdb_id: cachedExtIds?.imdb_id ?? null,
                            tvdb_id: cachedExtIds?.tvdb_id ?? null,
                        },
                        provider,
                        cached.queried_external_id,
                    );

                    const cachedDbRow: DbMediaRow = {
                        media_id: cached.media_id,
                        media_type: cached.media_type,
                        title: cached.title,
                        overview: cached.overview ?? undefined,
                        year: cached.release_year ?? undefined,
                        mdblist_score: cached.score ?? undefined,
                        is_available: false,
                        can_request: true,
                    };

                    const detail = transformToMediaDetail(
                        cachedDbRow,
                        cachedExternalIds,
                        undefined,
                        ctx.surface,
                        await resolveImageSet(sql, ctx.surface, cached.media_id, cached.media_type),
                    );
                    // Same closed-union limit as the UUID path above. A cached
                    // provider-lookup row carries whatever media_type the
                    // provider reported, so this is not unreachable.
                    if (!detail) {
                        return ApiProblem.notFound('No detail representation for this media type');
                    }
                    return json(MediaDetailSchema.parse(await overlayDetail(detail)));
                }

                return ApiProblem.notFound('Media not found');
            }

            const [hasAccess, extIds] = await Promise.all([
                checkMediaAccess(sql, media.media_id, locals.user),
                getAllExternalIds.one(sql, { mediaId: media.media_id }),
            ]);
            if (!hasAccess) {
                return ApiProblem.notFound('Media not found');
            }

            logger.info('Media details fetched', {
                provider,
                externalId,
                title: media.title,
            });

            const externalIds = buildExternalIdsFromRow({
                media_id: media.media_id,
                tmdb_id: extIds?.tmdb_id ?? null,
                imdb_id: extIds?.imdb_id ?? null,
                tvdb_id: extIds?.tvdb_id ?? null,
            }) as Record<string, string | undefined>;
            if (!externalIds[provider]) {
                externalIds[provider] = externalId;
            }

            const genreNames = (media.genres || []).filter(Boolean);
            const streamSummary = await getMediaStreamSummary(
                sql,
                media.media_id,
                media.media_type,
            );
            const detail = transformToMediaDetail(
                toDbMediaRow(media, genreNames),
                externalIds as Record<string, string>,
                streamSummary,
                ctx.surface,
                await resolveImageSet(sql, ctx.surface, media.media_id, media.media_type),
            );
            // Composite-key path — the caller supplies the media type in the key
            // (`tmdb:550:movie`), but the resolved ROW's media_type is what gets
            // serialized, and the two can disagree. Same closed-union limit.
            if (!detail) {
                return ApiProblem.notFound('No detail representation for this media type');
            }
            return json(MediaDetailSchema.parse(await overlayDetail(detail)));
        },
    },
});
