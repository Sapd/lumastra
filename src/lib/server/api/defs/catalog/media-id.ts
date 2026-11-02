// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ResolveImageOptions } from '$lib/server/services/image-descriptor/index.js';
import { InheritQuerySchema } from '$lib/schemas/api-image-descriptor.js';
import { ImageSetSchema } from '$lib/schemas/api-image-descriptor.js';
import {
    buildPlaybackProgress,
    PlaybackProgressSchema,
} from '$lib/schemas/api-playback-progress.js';

/**
 * defs/catalog/media-id.ts — polymorphic `media/{id}` spine.
 *
 * Contract:
 *   GET /media/{id}                        → polymorphic detail (Movie | Series | …)
 *   GET /media/{id}?include=user,playback  → adds per-user watch-state + user rating
 *   Rich metadata, ImageSet and PlaybackProgress are returned by default.
 *
 * ID forms accepted:
 *   - Internal UUID: 550e8400-e29b-41d4-a716-446655440000
 *   - Composite key: tmdb:550:movie  (URL-encode if needed, prefer ?externalId=)
 *   - ?externalId=tmdb:550:movie
 *
 * Auth: user (any authenticated caller — session, PAT, device JWT, service token).
 *
 * MediaType discriminator: the response `type` is authoritative; the path
 * segment is just a namespace.  Resolve canonically; never 404 on a type/path
 * mismatch, never trust the path as the type.
 */

import { resolveImageSet } from '$lib/server/services/image-descriptor/index.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { z } from 'zod';
import type { Sql } from 'postgres';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import type { EpisodeCountFields } from '$lib/server/services/series-episode-counts.service.js';
import { getDb } from '$lib/server/database/connection.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    getMediaDetailsById,
    getExternalIdsByMediaId,
    buildExternalIdsObject,
    getMediaNavContext,
} from '$lib/server/database/queries/media-lookup.queries.js';
import { getMediaDetailByUuid } from '$lib/server/database/queries/media-details.queries.js';
import { findPlaybackDurationMs } from '$lib/server/database/queries/media-items.queries.js';
import { getAudiobookNodeDetail } from '$lib/server/database/queries/audiobooks.queries.js';
import { getMediaItemLibraryNames } from '$lib/server/database/queries/library-groups.queries.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';

import { getMediaStreamSummary } from '$lib/server/database/queries/media-stream-summary.queries.js';
import { mediaIdResolver } from '$lib/server/services/media-id-resolver.js';
import { isSeries } from '$lib/server/utils/media-types.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import type { PublicMediaType } from '$lib/server/utils/media-types.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    toDbMediaRow,
    transformToMediaDetail,
    toNodeDetailsExtra,
} from '$lib/server/utils/api-transforms.js';
import { config } from '$lib/server/config.js';
import { getPlaybackPreferences } from '$lib/server/database/queries/user-preferences.queries.js';
import { resolveMetadataLanguage } from '$lib/server/utils/metadata-language-resolve.js';
import { applyTranslationOverlay } from '$lib/server/utils/translation-overlay.js';
import { triggerMetadataTranslationLazyFill } from '$lib/server/utils/metadata-translation-lazy-fill.js';
import type { UserId } from '$lib/shared/user-id.js';
import { MediaNodeSchema } from '$lib/schemas/media-detail';
import type { PersonCreditsSchema } from '$lib/schemas/api-person-responses.js';
import { personImageSet } from '$lib/server/services/image-descriptor/resources.js';
import { parsePersonHandle } from '$lib/shared/person-handle.js';
import { apiUrl, type ApiSurface } from '$lib/shared/api-urls.js';
import { watchlistExistsFragment } from '$lib/server/database/queries/builders/watchlist-exists.builder.js';

export const MediaDetailResponseSchema = z.union(
    MediaNodeSchema.options.map((schema) =>
        schema.extend({
            catalogId: z.uuid(),
            images: ImageSetSchema,
            progress: PlaybackProgressSchema,
        }),
    ),
);

const MediaIdQuerySchema = z
    .object({
        include: z.string().optional().meta({
            description:
                'durationMs, ImageSet and PlaybackProgress on the node; rich metadata (genres, ratings, trailer, certification, counts, languages) once, under details. The details include value is removed; heavy extras use include=extras. Existing user/playback expansions remain supported. Cast and crew are always returned as credits with canonical person handles and profile ImageSets. Unknown person identities have id:null and omit images.',
        }),
        externalId: z.string().optional().meta({
            description: 'Composite external ID form: provider:id:type (e.g. tmdb:550:movie)',
        }),
    })
    .merge(InheritQuerySchema);

// ---------------------------------------------------------------------------
// Request query contract
// ---------------------------------------------------------------------------

/**
 * Query params accepted by GET /media/{id}.
 *
 * Lenient: unknown params are stripped (not rejected). All values arrive as
 * strings from URLSearchParams; booleans/numbers use z.coerce.*.
 */
const MediaIdQuery = z
    .object({
        /**
         * CSV of optional expansions to include in the response.
         * Heavy extras use include=extras. Rich details, images and progress are always present.
         * Unknown values are ignored by the handler.
         */
        include: z
            .string()
            .refine(
                (value) =>
                    !value
                        .split(',')
                        .map((part) => part.trim())
                        .includes('details'),
                'Details are returned by default; remove include=details',
            )
            .optional(),
        /**
         * Composite external ID form: `provider:id:type` (e.g. `tmdb:550:movie`).
         * Accepted as an alternative to encoding the composite key in the URL path.
         */
        externalId: z.string().optional(),
    })
    .merge(InheritQuerySchema);

const logger = Logger.for('CatalogMediaIdDef');

// ---------------------------------------------------------------------------
// Image hrefs (self-describing)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// buildMediaDetail — extracted detail builder (reused by media-id-context.ts)
// ---------------------------------------------------------------------------

/**
 * Public types that have a `MediaNodeSchema` arm, derived from the schema so
 * the set cannot drift. Any other public type (music artist/album/track, ...)
 * would produce a body that fails the declared contract.
 */
export const MEDIA_NODE_TYPES: ReadonlySet<string> = new Set(
    MediaNodeSchema.options.map((option) => option.shape.type.value),
);

/**
 * Build the full media/{id} response body from an already-resolved internal
 * UUID without re-running access checks or ID resolution.
 *
 * @param sql          - Active postgres.Sql connection.
 * @param internalId   - Resolved internal UUID (caller already verified access).
 * @param surface      - API surface this response is being served on (ctx.surface).
 * @param include      - Value of the ?include= query param (may be empty string).
 * @param userId       - Authenticated user's ID, or undefined for anonymous.
 * @returns            The plain object that becomes the JSON response body, or
 *                     null when the row is not found or the type is unmapped.
 */
export async function buildMediaDetail(
    sql: Sql,
    internalId: string,
    surface: ApiSurface,
    include: string,
    userId: string | undefined,
    /**
     * Library/age boundary for reads that widen BEYOND this one row, resolved
     * LAZILY.
     *
     * Used for the audiobook series rail and library context. Omitting it
     * drops both rather than disclosing siblings or names without filtering.
     */
    getAccess?: () => Promise<MediaAccessBoundary>,
    imageOptions?: ResolveImageOptions,
): Promise<Record<string, unknown> | null> {
    const includeTokens = include.split(',').map((token) => token.trim());
    const includeUser = includeTokens.includes('user') || includeTokens.includes('playback');
    // Rich metadata is part of the default details screen response (§9.2).
    const includeDetails = true;

    // Fetch core row, external IDs, and (when ?include=user) per-user data in
    // parallel — all three are independent once access is already confirmed.
    const [row, dbExternalIds, userRows] = await Promise.all([
        getMediaDetailsById(sql, internalId),
        getExternalIdsByMediaId(sql, internalId),
        includeUser && userId
            ? sql<Array<{ user_rating: number | null; in_watchlist: boolean }>>`
					SELECT
						ur.rating as user_rating,
						${watchlistExistsFragment(sql, sql`${internalId}::uuid`, sql`${userId}::uuid`)} as in_watchlist
					FROM (SELECT 1) as dummy
					LEFT JOIN user_ratings ur ON ur.user_id = ${userId}::uuid
						AND ur.media_id = ${internalId}::uuid
					LIMIT 1
				`.catch((err: unknown) => {
                  logger.warn('Failed to load per-user data for media/{id}', {
                      mediaId: internalId,
                      error: String(err),
                  });
                  return [] as Array<{ user_rating: number | null; in_watchlist: boolean }>;
              })
            : Promise.resolve([] as Array<{ user_rating: number | null; in_watchlist: boolean }>),
    ]);

    if (!row) return null;

    const publicType = toPublicMediaType(row.media_type);
    if (!publicType) {
        logger.warn('Unmapped media_type in catalog response', {
            mediaId: internalId,
            dbType: row.media_type,
        });
        return null;
    }
    if (!MEDIA_NODE_TYPES.has(publicType)) {
        // Expected for music rows: they are served by the music endpoints.
        logger.debug('media_type has no MediaNode variant; not served by media/{id}', {
            mediaId: internalId,
            dbType: row.media_type,
        });
        return null;
    }

    // Per-user metadata-language overlay (multilingual-media-metadata spec §5):
    // resolved ONCE per request here so both the title/overview swap below AND
    // the lazy-fill trigger reuse the exact same `langs`. Feature-off installs
    // pay ZERO extra queries per detail view: the admin-language check is a
    // free synchronous config read, so it gates the getPlaybackPreferences
    // query up front.
    let langs = { titleLang: null as string | null, textLang: null as string | null };
    if (userId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
        const prefs = await getPlaybackPreferences.one(sql, { userId: userId as UserId });
        langs = resolveMetadataLanguage(prefs);
    }

    // Lazy-fill (multilingual-metadata spec §4.3) — see
    // metadata-translation-lazy-fill.ts for the shared movie/series enqueue
    // logic (also used by defs/catalog/movie-details.ts).
    triggerMetadataTranslationLazyFill(sql, internalId, publicType, userId, langs, {
        sourceRoute: 'media-detail',
    });

    const ids = buildExternalIdsObject(dbExternalIds);

    let userRating: number | null = null;
    let isInWatchlist = false;
    if (userRows[0]) {
        // postgres returns NUMERIC columns as strings by default. Keep the
        // public MediaNodeUser contract numeric: strict clients (including
        // Swift Codable) decode the whole node and reject a string rating.
        const rawRating = userRows[0].user_rating;
        const numericRating = rawRating == null ? null : Number(rawRating);
        userRating =
            numericRating !== null && Number.isFinite(numericRating) ? numericRating : null;
        isInWatchlist = userRows[0].in_watchlist === true;
    }

    // Audiobook rows carry none of their identity in provider_metadata (there is
    // no such row for an ABS book), so the generic detail read above reports a
    // null overview for a book whose description sits in `media_items.overview`
    // and knows nothing about authors/narrators/chapters. One extra query, for
    // audiobook rows only.
    const audiobook =
        publicType === 'audiobook'
            ? await getAudiobookNodeDetail(sql, internalId, userId ?? null)
            : null;

    // The rest of the series, in reading order, with the viewer's state for each.
    // Fetched only when this book actually belongs to one, so a standalone book
    // costs nothing extra.
    const access = getAccess ? await getAccess() : undefined;
    // `premiere_date` was read off `row` before the detail query actually
    // selected it, so this resolved to `undefined` for EVERY node and `year` was
    // silently absent from every movie/series/episode response — including
    // titles whose `media_items.year` was populated. Keep premiere_date as the
    // precise source when present, then fall back to the year column.
    const premiere = row.premiere_date ?? undefined;
    const premiereYear = premiere ? new Date(premiere).getFullYear() : Number.NaN;
    const year = Number.isFinite(premiereYear)
        ? premiereYear
        : (row.year ?? audiobook?.year ?? undefined);

    // is_available / can_request are selected by getMediaDetailsById but were
    // never surfaced here, so the ?modal={uuid} opener (openMediaModalFromUrl →
    // /api/media/{id}) saw them absent and defaulted every item to
    // isAvailable=false / canRequest=true — showing "Request" on available items.
    // Mirror transformToMediaDetail (api-transforms.ts).
    const isAvailable = (row as { is_available?: boolean | null }).is_available ?? false;
    const base = {
        id: internalId,
        catalogId: internalId,
        type: publicType,
        ids,
        title: row.title ?? '',
        year,
        overview: row.overview ?? audiobook?.overview ?? undefined,
        tagline: row.tagline?.trim() || undefined,
        durationMs:
            publicType === 'movie' || publicType === 'episode'
                ? ((await findPlaybackDurationMs(sql, internalId)) ??
                  (row.runtime_minutes && row.runtime_minutes > 0
                      ? Math.round(row.runtime_minutes * 60000)
                      : null))
                : null,
        images: await resolveImageSet(sql, surface, internalId, publicType, imageOptions),
        isAvailable,
        canRequest: (row as { can_request?: boolean | null }).can_request ?? !isAvailable,
    };

    const countFields: EpisodeCountFields = {};
    if ((publicType === 'series' || publicType === 'season') && access) {
        const { enrichSeriesEpisodeCounts } =
            await import('$lib/server/services/series-episode-counts.service.js');
        const target = { id: internalId, type: publicType };
        await enrichSeriesEpisodeCounts(sql, [target], userId ?? null, access);
        Object.assign(countFields, target);
        delete (countFields as Record<string, unknown>).id;
        delete (countFields as Record<string, unknown>).type;
    }
    Object.assign(base, countFields);

    // Overlay the resolved title/overview onto `base` (multilingual-media-
    // metadata spec §5). Applies to every node kind (movie/series/episode/
    // season) — episode/season translation rows are stored per-item too
    // (spec §4.3), independent of the movie/series-only lazy-fill trigger
    // above.
    if (langs.titleLang || langs.textLang) {
        await applyTranslationOverlay(sql, [base], langs, {
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
    }

    // Episode/season media never exposed their owning series' internal UUID
    // here, so a ?modal={episodeUuid} deep link (openMediaModalFromUrl) had no
    // authoritative series id to resolve seasons/episodes from and fell back to
    // a fuzzy name search using the EPISODE title — resolving the wrong (or no)
    // series. Resolve the series UUID via the same two-hop parent_id chain used
    // by episodes/{id} and seasons/{id} (getMediaNavContext).
    let episodeLinks: Record<string, unknown> = {};
    if (publicType === 'episode' || publicType === 'season') {
        const navCtx = await getMediaNavContext(sql, internalId);
        if (navCtx?.series_id) {
            episodeLinks = {
                seriesId: navCtx.series_id,
                seasonNumber: navCtx.season_number ?? row.season_number ?? undefined,
                episodeNumber: navCtx.episode_number ?? row.episode_number ?? undefined,
            };
        }
    }

    const seriesLinks =
        isSeries(row.media_type) || row.media_type === 'tv'
            ? {
                  seasons: {
                      href: apiUrl(surface, `/series/${internalId}/seasons`),
                  },
              }
            : {};

    const userFields = includeUser
        ? {
              user: {
                  rating: userRating,
                  inWatchlist: isInWatchlist,
              },
          }
        : {};

    // Rich detail fields and credits are returned by default for movies/series
    // (the rich data model doesn't cover episode/season at
    // that granularity). Reuses the SAME query + transform GET /api/media-details
    // uses so the two paths can't drift apart.
    let creditsFields: Record<string, unknown> = {};
    if (publicType === 'movie' || publicType === 'series') {
        const [creditsRow] = await sql<
            {
                metadata: Record<string, unknown> | null;
                tmdb_metadata: Record<string, unknown> | null;
            }[]
        >`
            SELECT pm.metadata, tmdb.metadata AS tmdb_metadata FROM media_items mi
            LEFT JOIN v_media_metadata pm ON pm.media_id = mi.id
            LEFT JOIN provider_metadata tmdb ON tmdb.media_id = mi.id AND tmdb.provider = 'tmdb'
            WHERE mi.id = ${internalId}::uuid
        `;
        creditsFields = {
            credits: mapMediaCredits(
                creditsRow?.metadata ?? {},
                surface,
                creditsRow?.tmdb_metadata ?? {},
            ),
        };
    }
    let detailsFields: Record<string, unknown> = {};
    if (includeDetails && (publicType === 'movie' || publicType === 'series')) {
        const richRow = await getMediaDetailByUuid(sql, internalId);
        if (richRow) {
            const genreNames = (richRow.genres || []).filter(Boolean);
            const streamSummary = await getMediaStreamSummary(sql, internalId, richRow.media_type);
            const fullDetail = transformToMediaDetail(
                toDbMediaRow(richRow, genreNames),
                ids,
                streamSummary,
                surface,
                base.images,
            );
            // `null` = no MediaDetailSchema arm for the row. Unreachable in
            // practice — the `publicType === 'movie' || publicType === 'series'`
            // gate above is exactly the set `toDetailMediaType()` answers
            // non-null for, minus audiobook. Handled rather than asserted so the
            // two conditions can drift apart without minting a wrong `details`
            // block: `details` is simply omitted, which the schema allows.
            if (fullDetail) {
                const extra: Record<string, unknown> = {
                    ...toNodeDetailsExtra(fullDetail),
                    ...countFields,
                };
                // One duration: the node's durationMs (ms), not a second runtime in minutes.
                delete extra.runtime;
                delete extra.actors;
                delete extra.directors;
                delete extra.creators;
                if (!includeTokens.includes('extras')) delete extra.extras;
                detailsFields = { details: extra };
            }
        }
    }

    // Audiobook fields ride the BASE node, not the `details` expansion: the
    // composite `media/{id}/context` mount the web modal uses calls this builder
    // with an EMPTY include, so anything under `details` never reaches it. See
    // MediaNodeAudiobookSchema for the contract.
    const audiobookFields: Record<string, unknown> = audiobook
        ? {
              authors: audiobook.authors,
              narrators: audiobook.narrators,
              series: audiobook.series,
              ids: audiobook.ids,
              durationMs: audiobook.durationMs,
              chapters: audiobook.chapters,
              // Same ImageSet as the generic path (and as the list items): the cover.
              images: base.images,
              ...(audiobook.progress ? { progress: audiobook.progress } : {}),
              ...(audiobook.publisher ? { publisher: audiobook.publisher } : {}),
              ...(audiobook.abridged !== null ? { abridged: audiobook.abridged } : {}),
          }
        : publicType === 'audiobook'
          ? {
                authors: [],
                narrators: [],
                series: null,
                durationMs: null,
                chapters: [],
                ids: {},
            }
          : {};

    // Library names can reveal groups beyond the admitted item. Reuse the
    // caller's access boundary and omit context when it is unavailable.
    const libraryNames =
        access && access.library.kind !== 'denyAll' && access.age.kind !== 'denyAll'
            ? await getMediaItemLibraryNames(
                  sql,
                  internalId,
                  access.library.kind === 'denyGroups' ? access.library.ids : null,
              )
            : [];

    const [watch] = await sql<
        Array<{
            resume_position_ms: number | null;
            runtime_ms: number | null;
            is_watched: boolean;
            last_event_at: Date | null;
        }>
    >`
        SELECT resume_position_ms, runtime_ms, is_watched, last_event_at
        FROM user_media_state WHERE media_id = ${internalId}::uuid AND user_id = ${userId ?? null}::uuid`;
    const progress = buildPlaybackProgress({
        positionMs: watch?.resume_position_ms == null ? null : Number(watch.resume_position_ms),
        // The same value as the node's durationMs, never a second source.
        durationMs: base.durationMs,
        finished: watch?.is_watched ?? false,
        updatedAt: watch?.last_event_at,
    });
    return {
        ...base,
        progress,
        ...(libraryNames.length ? { libraryNames } : {}),
        ...seriesLinks,
        ...episodeLinks,
        ...userFields,
        ...detailsFields,
        ...creditsFields,
        ...audiobookFields,
    };
}

const MAX_CREDITS = 100;

/** Map provider cast/crew to people. Flat-name fallbacks have a truly unknown identity. */
export function mapMediaCredits(
    metadata: Record<string, unknown>,
    surface: ApiSurface,
    tmdbMetadata: Record<string, unknown> = {},
): z.infer<typeof PersonCreditsSchema> {
    const records = (value: unknown): Record<string, unknown>[] =>
        Array.isArray(value)
            ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
            : [];
    const names = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    const person = (
        row: Record<string, unknown>,
    ): z.infer<typeof PersonCreditsSchema>['cast'][number]['person'] => {
        let handle: string | null = null;
        for (const rawId of [row.person_id, row.tmdbId, row.tmdb_id, row.id]) {
            const parsed = parsePersonHandle(
                typeof rawId === 'number' || typeof rawId === 'string' ? String(rawId) : '',
            );
            if (parsed.ok) {
                handle = parsed.handle;
                break;
            }
        }
        return {
            id: handle,
            name: String(row.name ?? ''),
            ...(handle
                ? {
                      images: personImageSet(
                          surface,
                          handle,
                          typeof row.profile_path === 'string'
                              ? row.profile_path
                              : typeof row.profilePath === 'string'
                                ? row.profilePath
                                : null,
                      ),
                  }
                : {}),
        };
    };
    const providerCredits =
        tmdbMetadata.credits && typeof tmdbMetadata.credits === 'object'
            ? (tmdbMetadata.credits as Record<string, unknown>)
            : {};
    const rawCredits = {
        ...tmdbMetadata,
        ...providerCredits,
        ...(metadata.credits && typeof metadata.credits === 'object'
            ? (metadata.credits as Record<string, unknown>)
            : {}),
    };
    // Normalized metadata may omit ids/order while the preserved provider blob has them.
    const mergeRows = (
        normalized: unknown,
        raw: unknown,
        crew: boolean,
    ): Record<string, unknown>[] => {
        const originals = records(raw);
        const result = records(normalized).map((row) => ({
            ...originals.find(
                (other) => other.name === row.name && (!crew || other.job === row.job),
            ),
            ...row,
        }));
        for (const row of originals) {
            if (
                !result.some((other) => other.name === row.name && (!crew || other.job === row.job))
            )
                result.push(row);
        }
        return result;
    };
    const castRows = mergeRows(metadata.cast, rawCredits.cast, false);
    const cast = (castRows.length ? castRows : names(metadata.actors).map((name) => ({ name })))
        .filter((row) => typeof row.name === 'string')
        .slice(0, MAX_CREDITS)
        .map((row: Record<string, unknown>, index) => ({
            person: person(row),
            character: typeof row.character === 'string' ? row.character : undefined,
            order: typeof row.order === 'number' && Number.isInteger(row.order) ? row.order : index,
        }));
    const crew = mergeRows(metadata.crew, rawCredits.crew, true)
        .filter((row) => typeof row.name === 'string' && row.name.trim() !== '')
        .slice(0, MAX_CREDITS)
        .map((row) => ({
            person: person(row),
            job: typeof row.job === 'string' ? row.job : 'Crew',
            department: typeof row.department === 'string' ? row.department : undefined,
        }));
    for (const [key, job] of [
        ['directors', 'Director'],
        ['creators', 'Creator'],
        ['writers', 'Writer'],
    ] as const) {
        for (const row of [
            ...(key === 'creators'
                ? [...records(metadata.created_by), ...records(tmdbMetadata.created_by)]
                : []),
            ...records(metadata[key]),
            ...names(metadata[key]).map((name) => ({ name })),
        ]) {
            const candidate = person(row);
            const ref = candidate.id
                ? candidate
                : (crew.find((c) => c.person.name === candidate.name && c.person.id)?.person ??
                  cast.find((c) => c.person.name === candidate.name && c.person.id)?.person ??
                  candidate);
            if (
                !crew.some(
                    (c) => c.person.name === ref.name && c.job.toLowerCase() === job.toLowerCase(),
                )
            ) {
                crew.push({ person: ref, job, department: undefined });
            }
        }
    }
    return { cast, crew: crew.slice(0, MAX_CREDITS) };
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Media'],
            summary: 'Get a movie, series, season or episode',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Overview, genres, durationMs, ratings, trailer, certification, ImageSet and PlaybackProgress are returned by default. include=details is removed. Heavy extras remain opt-in. Movies and series include credits.cast and credits.crew by default. Each entry embeds a person with a canonical tmdb:N handle, name and profile ImageSet. Unknown identities use id:null and omit images. Director, Creator and Writer are crew jobs; the old actors/directors/creators fields are removed.',
            query: MediaIdQuerySchema,
            responses: {
                200: {
                    schema: MediaDetailResponseSchema,
                    description:
                        'Media traversal node (discriminated union of movie, series, episode, season, and audiobook)',
                },
                401: 'Authentication required',
                404: 'Media item not found, or its type is not served by this endpoint (music items are served by the music endpoints)',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Media'],
            summary: 'Delete a title from the library (admin)',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                204: 'Success',
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },

    request: {
        query: MediaIdQuery,
    },

    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is not available');
            }

            // ----------------------------------------------------------------
            // ID resolution via withIdResolution middleware.
            // The middleware populates locals.resolvedIds; we need to invoke it
            // inline because defineEndpoint handlers receive a plain RequestEvent.
            // ----------------------------------------------------------------
            const resolvedIds = event.locals.resolvedIds;
            let resolvedInternalId: string | null;
            if (resolvedIds?.internalId) {
                resolvedInternalId = resolvedIds.internalId;
            } else {
                // No pre-resolution: resolve inline via the same resolver
                // withIdResolution uses (accepts UUID, dashless UUID, or a
                // composite provider:id:type key from the path or ?externalId=).
                const rawId = event.params.id || ctx.input?.query?.externalId || '';
                if (!rawId) {
                    return ApiProblem.notFound('Media item not found');
                }
                try {
                    const resolved = await mediaIdResolver.resolveAnyMediaId(rawId);
                    resolvedInternalId = resolved.internalId;
                } catch (err) {
                    const message = err instanceof Error ? err.message : 'Unknown error';
                    if (message.includes('Invalid media ID format')) {
                        return ApiProblem.validationFailed([{ field: 'id', message }]);
                    } else if (message.includes('not found')) {
                        return ApiProblem.notFound('Media item not found');
                    } else if (message.includes('Database connection not available')) {
                        return ApiProblem.dependencyUnavailable(
                            'Database connection not available',
                        );
                    } else {
                        return ApiProblem.internalError('ID resolution failed');
                    }
                }
            }

            if (!resolvedInternalId) {
                return ApiProblem.notFound('Media item not found');
            }

            // ----------------------------------------------------------------
            // Library + age access gate
            // ----------------------------------------------------------------
            if (!(await checkMediaAccess(sql, resolvedInternalId, event.locals.user))) {
                return ApiProblem.notFound('Media item not found');
            }

            // ----------------------------------------------------------------
            // Build response — parallel reads via buildMediaDetail
            // ----------------------------------------------------------------
            const include = event.url.searchParams.get('include') ?? '';
            const userId = event.locals.user?.userId;
            // Passed as a thunk, not a value: it costs a query and only the
            // audiobook series rail consumes it. The boundary needs the full
            // `locals.user`, which only the request handler has.
            const user = event.locals.user;
            const body = await buildMediaDetail(
                sql,
                resolvedInternalId,
                ctx.surface,
                include,
                userId,
                user
                    ? async () => searchAccessBoundary(await buildSearchAccessContext(sql, user))
                    : undefined,
                ctx.input?.query?.inherit === 'none' ? { inherit: 'none' } : undefined,
            );

            if (!body) {
                return ApiProblem.notFound(
                    'Media item not found, or its type is not served by this endpoint (music items are served by the music endpoints)',
                );
            }

            return json(body);
        },
    },
});

// ---------------------------------------------------------------------------
// Collection type exports (list rows ≠ detail)
// ---------------------------------------------------------------------------

/**
 * MediaSummary — the shape returned in list/search/feed/rec responses.
 *
 * Distinct from the full Media detail but carries the same `type` discriminator
 * and `ids{}` map so a list row is a complete handle (no re-fetch needed).
 */
export interface MediaSummary {
    id: string;
    type: PublicMediaType;
    ids: Record<string, string>;
    title: string;
    year?: number;
    images: ImageSet;
}

/**
 * Build a MediaSummary from a raw DB row and external IDs.
 * Used by collection endpoints (search, trending, recommendations, etc.)
 * to produce consistent list-row handles.
 */
export function buildMediaSummary(
    row: { id: string; media_type: string; title: string; premiere_date?: string | null },
    externalIds: Record<string, string>,
    images: ImageSet,
): MediaSummary | null {
    const type = toPublicMediaType(row.media_type);
    if (!type) return null;

    const year = row.premiere_date ? new Date(row.premiere_date).getFullYear() : undefined;
    return {
        id: row.id,
        type,
        ids: externalIds,
        title: row.title,
        year,
        images,
    };
}

// Re-export paginate for route files using this def
export { paginate };
