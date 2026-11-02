// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watchlist/index.ts — GET/POST/DELETE /watchlist
 *
 * Collapses (§rename-map):
 *   ai/save-movie   POST   → watchlist POST  (add item)
 *   ai/save-movie   DELETE → watchlist DELETE (remove item)
 *   ai/saved-movies/{user_id} GET → watchlist GET (list caller's items)
 *
 * The {user_id} path parameter is removed: all three operations are scoped to
 * the authenticated caller's own watchlist.  Admin-on-behalf-of is out of
 * scope for this resource (use the admin DB if needed).
 *
 * POST /watchlist
 *   Body: { externalIds, mediaType: 'movie'|'series'|'tv'|'audiobook', title }
 *   Returns: { message, saved, externalIds }
 *
 * DELETE /watchlist
 *   Body: { externalIds, mediaType: 'movie'|'series'|'tv'|'audiobook' }
 *   Returns: { message, removed, externalIds }
 *
 * GET /watchlist
 *   Returns: { items, page }  (standard paginated envelope)
 *   Items are MediaPreview with saved state and separate episodeProgress counts.
 *
 * Auth: user (all methods) — no admin escalation needed.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { buildPlaybackProgress } from '$lib/schemas/playback-progress.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import {
    getUserWatchlistMedia,
    type WatchlistMediaCursor,
} from '$lib/server/database/queries/watchlist-media.queries.js';
import {
    encodeKeysetCursor,
    decodeKeysetCursor,
} from '$lib/server/database/queries/builders/keyset-cursor.builder.js';
import { getMediaRailMetadataBatch } from '$lib/server/database/queries/media-rail-metadata.queries.js';
import { pickDisplayRating } from '$lib/server/utils/rating-utils.js';
import {
    batchGetWatchedState,
    batchGetUserWatchStates,
} from '$lib/server/database/queries/watch-state.queries.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import { resolveImageSets } from '$lib/server/services/image-descriptor/resolver.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { WatchlistListResponseSchema } from '$lib/schemas/api-watchlist-responses.js';
import type { ExternalIds } from '$lib/types/api-common.js';

// The GET response contract lives in $lib/schemas (single source of truth) so
// the SPA's API client validates against the exact schema mount() enforces here.
export {
    WatchlistItemSchema,
    WatchlistMediaRefSchema,
} from '$lib/schemas/api-watchlist-responses.js';

// ---------------------------------------------------------------------------
// Row-coercion helpers
//
// The driver hands back numerics as strings and timestamps as `string | Date`.
// The response contract declares numbers and ISO strings, and mount() runs
// `.parse()` on the body — a single mistyped field fails the whole response,
// so coerce explicitly rather than relying on truthiness.
// ---------------------------------------------------------------------------

/** Numeric column → number, or null. Preserves a legitimate 0 (unlike `|| null`). */
function numOrNull(value: unknown): number | null {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Numeric column → number, or undefined (for keys omitted when absent). */
function numOrUndefined(value: unknown): number | undefined {
    return numOrNull(value) ?? undefined;
}

/** `string | Date` timestamp → ISO-8601 string. */
function toIsoString(value: string | Date): string {
    return value instanceof Date ? value.toISOString() : String(value);
}

// ---------------------------------------------------------------------------
// Per-feed cursor codec. Wraps the shared keyset-cursor builder with a watchlist
// feed tag so a cursor minted for another feed (e.g. /browse/genre, /user/series)
// cannot decode-and-run here. The keyset is over the DISTINCT ON output order
// `(external_id, media_type)` — the shared codec's (ts:id) slots carry
// (external_id : media_type). Both are `text NOT NULL`, so there is no NULL group
// (no Gate D2b marker needed) and a single tag suffices.
// ---------------------------------------------------------------------------

const WATCHLIST_CURSOR_TAG = 'wl:';
/** media_type stored lowercase ('movie'/'tv'); reject anything else pre-Postgres. */
const WATCHLIST_MEDIA_TYPE_RE = /^[a-z]+$/;

function encodeWatchlistCursor(cursor: WatchlistMediaCursor): string {
    return (
        WATCHLIST_CURSOR_TAG + encodeKeysetCursor({ ts: cursor.externalId, id: cursor.mediaType })
    );
}

function decodeWatchlistCursor(raw: string): WatchlistMediaCursor | null {
    if (!raw.startsWith(WATCHLIST_CURSOR_TAG)) return null; // untagged / other feed
    const core = decodeKeysetCursor(raw.slice(WATCHLIST_CURSOR_TAG.length));
    if (!core) return null;
    // Validate both halves before they reach Postgres — a decodable-but-bogus
    // cursor would otherwise be a silently-empty page rather than a clean 422.
    if (core.ts.length === 0) return null;
    if (!WATCHLIST_MEDIA_TYPE_RE.test(core.id)) return null;
    return { externalId: core.ts, mediaType: core.id };
}

const AddBodySchema = z.object({
    externalIds: z
        .record(z.string(), z.string())
        .meta({ description: 'External ID map (e.g. {"tmdb":"603"})' }),
    mediaType: z.enum(['movie', 'series', 'audiobook']).meta({ description: 'Media type' }),
    title: z.string().meta({ description: 'Media title' }),
});

const RemoveBodySchema = z.object({
    externalIds: z
        .record(z.string(), z.string())
        .meta({ description: 'External ID map to identify the item' }),
    mediaType: z.enum(['movie', 'series', 'audiobook']).meta({ description: 'Media type' }),
});

const MutationResponseSchema = z.object({
    message: z.string(),
    saved: z.boolean().optional(),
    removed: z.boolean().optional(),
    externalIds: z.record(z.string(), z.string()),
});

// (Request body schemas have been moved into the `request:` slot of defineEndpoint below.
//  They are validated by mount() before the handler runs.)

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Watchlist'],
            summary: 'List watchlist items',
            stability: 'stable',
            auth: 'bearer',
            description:
                "Returns all items on the authenticated caller's watchlist, enriched with catalogue metadata. " +
                'Access filtering (library groups, age rating) is applied. ' +
                'Items are MediaPreview with PlaybackProgress; series carry separate `episodeProgress` ' +
                '({ watched, total }). ' +
                'Pagination is opt-in: pass `?limit=`/`?offset=` for offset paging, or hand back ' +
                '`page.nextCursor` from a previous response as `?cursor=` for stable keyset paging ' +
                '(offset is ignored when a cursor is supplied). Omit all three to receive the full list.',
            query: z.object({
                limit: z.coerce
                    .number()
                    .int()
                    .optional()
                    .meta({ description: 'Max items per page (opt-in paging)' }),
                offset: z.coerce
                    .number()
                    .int()
                    .optional()
                    .meta({ description: 'Row offset (ignored when cursor is supplied)' }),
                cursor: z
                    .string()
                    .optional()
                    .meta({ description: 'Opt-in keyset cursor; echo back page.nextCursor' }),
            }),
            responses: {
                200: {
                    schema: WatchlistListResponseSchema,
                    description: 'Watchlist items',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Watchlist'],
            summary: 'Add item to watchlist',
            stability: 'stable',
            auth: 'bearer',
            description:
                "Adds a media item to the authenticated caller's watchlist by resolving external IDs to an internal catalogue entry. " +
                'Returns 400 if no matching catalogue entry is found.',
            body: AddBodySchema,
            responses: {
                200: {
                    schema: MutationResponseSchema,
                    description: 'Item added or already present',
                },
                400: 'Validation error or no matching catalogue entry',
                401: 'Authentication required',
                404: 'Media not found or not accessible',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Watchlist'],
            summary: 'Remove item from watchlist',
            stability: 'stable',
            auth: 'bearer',
            description:
                "Removes a media item from the authenticated caller's watchlist. " +
                'Removing an item the caller can no longer view is allowed (access gate is skipped for removals).',
            body: RemoveBodySchema,
            responses: {
                200: {
                    schema: MutationResponseSchema,
                    description: 'Item removed or was not on watchlist',
                },
                400: 'Validation error or no matching catalogue entry',
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },

    /**
     * Request contract.
     *
     * POST body: AddBodySchema — externalIds + mediaType + title.
     * DELETE body: RemoveBodySchema — externalIds + mediaType.
     *
     * mount() validates BEFORE the handler runs and populates ctx.input.body.
     * The handlers below read ctx.input.body directly and skip the manual parse.
     *
     * Both schemas are lenient (unknown fields stripped, no .strict()).
     * The per-method dispatch is handled by mount(): for GET (no body), the body
     * slot is skipped (methodCanHaveBody('GET') = false), so the GET handler is
     * unaffected even though both POST and DELETE schemas are declared on
     * AddBodySchema. We declare the body as AddBodySchema (the superset) so that
     * POST is strictly validated; DELETE uses RemoveBodySchema separately.
     *
     * NOTE: Because we cannot express per-method body schemas in one `request:`
     * slot (the current foundation takes a single schema set), we keep the body
     * schema as AddBodySchema (the superset). DELETE sends only externalIds +
     * mediaType — both of which are present in AddBodySchema as required fields
     * (title is `.optional()` in the superset below). The DELETE handler ignores
     * the parsed `title`. We never over-reject because AddBodySchema strips
     * unknown fields and title is optional in the shared schema.
     */
    request: {
        /**
         * Shared body schema for POST and DELETE.
         *
         * POST requires `title`; DELETE ignores it. We use the union (title
         * optional) so mount() never rejects a valid DELETE body that lacks a
         * title. Each handler then enforces method-specific requirements in code.
         */
        body: z
            .object({
                externalIds: z
                    .record(z.string(), z.string())
                    .refine((ids) => Object.values(ids).some((v) => v.length > 0), {
                        message: 'At least one external ID is required',
                    }),
                mediaType: z.enum(['movie', 'series', 'tv', 'audiobook']).optional(),
                /** Snake_case variant accepted for backwards compat */
                media_type: z.enum(['movie', 'series', 'tv', 'audiobook']).optional(),
                /** Required by POST, ignored by DELETE */
                title: z.string().min(1).optional(),
            })
            .refine((d) => (d.mediaType ?? d.media_type) !== undefined, {
                message: 'mediaType is required',
            })
            .transform((d) => ({
                externalIds: d.externalIds as ExternalIds,
                title: d.title,
                mediaType: (d.mediaType ?? d.media_type) as 'movie' | 'series' | 'tv' | 'audiobook',
            })),
    },

    handlers: {
        /**
         * GET /watchlist
         *
         * Returns all items on the authenticated caller's watchlist, enriched
         * with catalogue metadata (ratings, availability, genres, cast …).
         *
         * Access filtering (library groups + age rating) is applied so the list
         * never leaks items from restricted libraries.
         */
        GET: async (event, ctx) => {
            const { locals } = event;

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not initialised');
            }

            const userId = locals.user!.userId;

            // Opt-in pagination. Callers that don't pass ?limit=/?offset=/?cursor=
            // keep the historical full-list contract (the widget has no pager;
            // external API clients like the tvOS/Swift app rely on receiving
            // everything) — so we never silently truncate a large watchlist. When
            // paging IS requested we over-fetch by one row to derive hasMore without
            // a second COUNT query.
            //
            // A `?cursor=` opts into keyset paging over the DISTINCT ON output order
            // `(external_id, media_type)`; it is decoded up front and takes
            // precedence over `?offset=`. A malformed cursor is a 422 rather than a
            // silently-empty page.
            const cursorParam = event.url.searchParams.get('cursor') ?? undefined;
            let cursor: WatchlistMediaCursor | null = null;
            if (cursorParam) {
                cursor = decodeWatchlistCursor(cursorParam);
                if (!cursor) {
                    return ApiProblem.validationFailed('Invalid cursor');
                }
            }
            const wantsPaging =
                cursor !== null ||
                event.url.searchParams.has('limit') ||
                event.url.searchParams.has('offset');
            const pagination = wantsPaging
                ? parsePagination(event.url, { defaultLimit: 500, maxLimit: 500 })
                : null;

            const accessCtx = await buildSearchAccessContext(sql, locals.user!);
            const access = {
                deniedGroupIds: accessCtx.deniedGroupIds,
                ageRating: accessCtx.ageRating,
                availableOnly: !accessCtx.showUnavailableMedia,
            };
            const fetched = await getUserWatchlistMedia(
                sql,
                userId,
                access,
                cursor && pagination
                    ? { limit: pagination.limit + 1, cursor }
                    : pagination
                      ? { limit: pagination.limit + 1, offset: pagination.offset }
                      : undefined,
            );
            const hasMore = pagination ? fetched.length > pagination.limit : false;
            const rows = pagination && hasMore ? fetched.slice(0, pagination.limit) : fetched;

            const primaryProvider = getPrimaryExternalIdProvider();

            // Per-user metadata-language overlay (multilingual-media-metadata spec
            // §5): `rows` is a live per-request join to `media_items` (not a
            // stored snapshot), so title/overview are eligible. Resolved ONCE per
            // request, applied on the fresh `rows` array from `getUserWatchlistMedia`
            // (no cache layer in this handler — no clone needed) BEFORE the
            // response-shaping `.map()` below, so the mapped `title`/`overview`
            // fields pick up the overlaid values.
            if (userId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                const { resolveMetadataLanguage } =
                    await import('$lib/server/utils/metadata-language-resolve.js');
                const { getPlaybackPreferences } =
                    await import('$lib/server/database/queries/user-preferences.queries.js');
                const langs = resolveMetadataLanguage(
                    await getPlaybackPreferences.one(sql, { userId }),
                );
                if (langs.titleLang || langs.textLang) {
                    const { applyTranslationOverlay } =
                        await import('$lib/server/utils/translation-overlay.js');
                    await applyTranslationOverlay(sql, rows, langs, {
                        id: (row) => (row.media_id ? String(row.media_id) : null),
                        setTitle: (row, v) => {
                            row.title = v;
                        },
                        setOverview: (row, v) => {
                            row.overview = v;
                        },
                    });
                }
            }

            // Display metadata comes from the SAME batched hydration every other
            // rail uses, NOT from the watchlist query's own columns. That query
            // extracts genres as integer TMDB ids ((elem->>'id')::integer) and
            // aliases `popularity` as `tmdb_rating` — both wrong for the
            // canonical contract (`genres` = names, `rating` = 0-10). One extra
            // round trip buys correct, override-aware, precedence-consistent
            // metadata. Access filtering already happened in the query above, so
            // these UUIDs are caller-authorised (see the helper's ACCESS CONTROL note).
            const mediaIds = rows.map((row) => String(row.media_id));
            // Independent batch reads — run concurrently rather than stacking
            // two serial round trips onto the response.
            const [railMeta, watchedState, imageSets, playbackStates] = await Promise.all([
                getMediaRailMetadataBatch(sql, mediaIds),
                // Series carry no user_media_state row of their own, so this
                // rolls their episodes up; see batchGetWatchedState.
                batchGetWatchedState(sql, userId, mediaIds),
                resolveImageSets(
                    sql,
                    ctx.surface,
                    rows.map((row) => ({ id: String(row.media_id), mediaType: row.media_type })),
                ),
                batchGetUserWatchStates.all(sql, { userId, mediaIds }),
            ]);

            const playbackById = new Map(playbackStates.map((state) => [state.media_id, state]));
            const items = rows.map((row) => {
                const internalId = String(row.media_id);
                const isActuallyAvailable = row.is_available || false;
                const canRequest = !isActuallyAvailable && (row.can_request || false);
                const meta = railMeta.get(internalId);
                const watch = watchedState.get(internalId);
                const playback = playbackById.get(internalId);

                // `row.title`/`row.overview` carry the per-user translation
                // overlay applied above, so they win over the un-overlaid
                // hydration values.
                const overview = row.overview || meta?.overview || undefined;
                // `?? meta.tmdbRating` used to be an UNGATED fallback: TMDB's
                // vote_average is meaningless at a handful of votes, and a
                // single 10/10 vote renders as a bogus "★ 10.0". Route it
                // through the same vote-count gate every other surface uses.
                const rating = pickDisplayRating({
                    imdbRating: meta?.imdbRating,
                    tmdbRating: meta?.tmdbRating,
                    voteCount: meta?.voteCount,
                });
                const criticRating = meta?.rtRating ?? numOrUndefined(row.rt_rating);

                return {
                    id: internalId,
                    catalogId: internalId,
                    // `upsertWatchlistItem` (watchlist.queries.ts) now filters its
                    // INSERT's source set to media_items.media_type IN
                    // getPlaylistKindPolicy('watchlist').allowedMediaTypes
                    // (movie/tv/audiobook) and rejects anything else. That closed
                    // the gap where the Jellyfin-compat `/j/.../FavoriteItems`
                    // route wrote arbitrary media UUIDs straight into this table —
                    // but it is enforcement going FORWARD, not a schema constraint:
                    // a row written through that route before this fix may still
                    // carry an episode/season/album/track media_type. The
                    // `?? 'movie'` below is that legacy-contamination fallback, not
                    // proof the invariant always held — keep it until a backfill
                    // confirms no such rows remain.
                    // eslint-disable-next-line callback-safety/no-inline-media-type-default -- legacy-contamination fallback, see comment above.
                    type: toPublicMediaType(row.media_type) ?? 'movie',
                    title: row.title || `Unknown ${row.media_type}`,
                    year: row.year ?? undefined,
                    ids: {
                        // `primary_ext_id` is a LEFT JOIN result — null for
                        // media types with no external_ids row under the
                        // configured primary provider (audiobooks are keyed
                        // by 'audiobookshelf', never the movie/series primary
                        // provider). Omit rather than emit the literal string
                        // "null" as a fake provider id.
                        ...(row.primary_ext_id
                            ? { [primaryProvider]: String(row.primary_ext_id) }
                            : {}),
                        ...(row.imdb_id ? { imdb: String(row.imdb_id) } : {}),
                    },
                    images: imageSets.get(internalId) ?? {},

                    ...(overview !== undefined ? { overview } : {}),
                    ...(rating !== undefined ? { rating } : {}),
                    ...(criticRating !== undefined ? { criticRating } : {}),
                    ...(meta?.runtimeMinutes != null
                        ? { durationMs: Math.round(meta.runtimeMinutes * 60_000) }
                        : {}),
                    ...(meta?.genres?.length ? { genres: meta.genres } : {}),
                    ...(meta?.certification ? { certification: meta.certification } : {}),
                    ...(meta?.resolutionTier ? { resolutionTier: meta.resolutionTier } : {}),
                    ...(meta?.hdrTier ? { hdrTier: meta.hdrTier } : {}),
                    ...(meta?.hasAtmos ? { hasAtmos: true } : {}),
                    ...(meta?.hasCc ? { hasCc: true } : {}),
                    ...(meta?.hasSdh ? { hasSdh: true } : {}),
                    ...(meta?.hasAd ? { hasAd: true } : {}),

                    ratings: {
                        letterboxd: numOrNull(row.letterboxd_rating),
                        letterboxdVotes: numOrNull(row.letterboxd_votes),
                        rtAudience: numOrNull(row.rt_audience_score),
                        mdblist: numOrNull(row.mdblist_score),
                        trakt: numOrNull(row.trakt_score),
                        mal: numOrNull(row.mal_score),
                    },
                    availability: { isAvailable: isActuallyAvailable, canRequest },

                    isSaved: true as const,
                    // Always present so a client never has to distinguish
                    // "unwatched" from "the server didn't say".
                    watched: watch?.watched ?? false,
                    ...(toPublicMediaType(row.media_type) === 'series' &&
                    watch?.totalEpisodes != null &&
                    watch.watchedEpisodes != null
                        ? {
                              episodeProgress: {
                                  watched: watch.watchedEpisodes,
                                  total: watch.totalEpisodes,
                              },
                          }
                        : {}),
                    ...(['movie', 'episode', 'audiobook'].includes(row.media_type)
                        ? {
                              progress: buildPlaybackProgress({
                                  positionMs:
                                      playback?.resume_position_ms == null
                                          ? null
                                          : Number(playback.resume_position_ms),
                                  durationMs:
                                      playback?.runtime_ms == null
                                          ? meta?.runtimeMinutes == null
                                              ? null
                                              : Math.round(meta.runtimeMinutes * 60_000)
                                          : Number(playback.runtime_ms),
                                  finished: playback?.is_watched ?? watch?.watched ?? false,
                                  updatedAt: playback?.last_event_at ?? null,
                              }),
                          }
                        : {}),
                    // `saved_at` is `string | Date` off the driver; the contract
                    // declares a string, so normalise rather than leaking a Date
                    // (which fails .parse() and drops the whole response body).
                    ...(row.saved_at ? { savedAt: toIsoString(row.saved_at) } : {}),
                };
            });

            // nextCursor: emitted whenever more items exist and paging was requested.
            // In cursor mode it continues the keyset walk; on offset responses it is
            // a Gate J1 bootstrap so a client can switch into keyset paging (watchlist
            // is always cursor-eligible — one stable (external_id, media_type) order).
            // Built from the last page row's own columns, no extra projection.
            //
            // `primary_ext_id` is null for a row whose media type has no
            // external_ids entry under the primary provider (audiobooks) — the
            // query's DISTINCT ON/ORDER BY/cursor-comparison key falls back to
            // the media UUID in that case (COALESCE(primary_ext.external_id,
            // mi.id::text)), so the cursor must use the SAME fallback or it
            // would encode a key the SQL comparison can never match.
            let nextCursor: string | undefined;
            if (pagination && hasMore && rows.length > 0) {
                const last = rows[rows.length - 1];
                nextCursor = encodeWatchlistCursor({
                    externalId: last.primary_ext_id ?? last.media_id,
                    mediaType: last.media_type,
                });
            }

            // Standard paginated envelope. For non-paging callers we report the
            // full-list shape (limit = item count, offset 0, hasMore false), exactly
            // as before; paging callers get their real window metadata. Cursor mode
            // drops `offset` entirely (Gate C — keyset paging has no offset).
            if (cursor) {
                return json(
                    paginate(items, {
                        limit: pagination!.limit,
                        hasMore,
                        ...(nextCursor ? { nextCursor } : {}),
                    }),
                );
            }
            return json(
                paginate(items, {
                    limit: pagination ? pagination.limit : items.length,
                    offset: pagination ? pagination.offset : 0,
                    hasMore,
                    ...(nextCursor ? { nextCursor } : {}),
                }),
            );
        },

        /**
         * POST /watchlist
         *
         * Adds a media item to the authenticated caller's watchlist.
         *
         * Body is pre-validated by mount() via the `request.body` schema above;
         * ctx.input.body carries the already-parsed, typed values.
         *
         * Resolves the supplied external IDs to an internal media UUID via the
         * catalogue; returns 400 when no matching catalogue entry is found.
         * Returns 404 when the caller is not permitted to view the resolved item
         * (library-group or age-rating restriction).
         */
        POST: async (event, ctx) => {
            const { locals } = event;

            // Body already validated by mount(). Normalise 'series' → 'tv' for the
            // internal watchlistManager API which uses the legacy enum; 'audiobook'
            // passes through unchanged.
            const parsed = ctx.input!.body;
            const externalIds = parsed.externalIds;
            const mediaType: 'movie' | 'tv' | 'audiobook' =
                parsed.mediaType === 'series' ? 'tv' : parsed.mediaType;
            const title = parsed.title;

            if (!title) {
                return ApiProblem.validationFailed([
                    { field: 'body.title', message: 'Title is required for POST' },
                ]);
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not initialised');
            }

            const userId = locals.user!.userId;

            const { watchlistManager } =
                await import('$lib/server/services/watchlist-manager.service.js');
            const { MediaAccessDeniedError } =
                await import('$lib/server/utils/resolve-and-gate.js');

            let result;
            try {
                result = await watchlistManager.addItem({
                    sql,
                    userId,
                    externalIds,
                    mediaType,
                    title,
                    user: locals.user!,
                });
            } catch (err) {
                if (err instanceof MediaAccessDeniedError) {
                    return ApiProblem.notFound('Media not found or not accessible');
                }
                throw err;
            }

            if (!result.mediaId) {
                // `mediaTypeRejected` distinguishes "the id resolves to a real
                // media row, but its type isn't allowed on the watchlist"
                // (e.g. `externalIds.internal` pointing at an episode) from
                // "the external IDs didn't resolve to anything at all" — same
                // status and response shape either way, only the message
                // names the actual cause. See watchlist-manager.service.ts.
                return ApiProblem.validationFailed(
                    result.mediaTypeRejected
                        ? 'This media type is not allowed on the watchlist'
                        : 'No matching catalogue entry for the supplied IDs',
                );
            }

            return json({
                message: result.saved ? 'Added to watchlist' : 'Already on watchlist',
                saved: result.saved ?? false,
                externalIds: { ...externalIds, internal: result.mediaId },
            });
        },

        /**
         * DELETE /watchlist
         *
         * Removes a media item from the authenticated caller's watchlist.
         *
         * Body is pre-validated by mount() via the `request.body` schema above.
         *
         * Returns 400 when no matching catalogue entry is found.
         * Removing an item the caller can no longer view is intentionally
         * allowed (access-gate is skipped for removals).
         */
        DELETE: async (event, ctx) => {
            const { locals } = event;

            // Body already validated by mount(). Normalise 'series' → 'tv';
            // 'audiobook' passes through unchanged.
            const parsed = ctx.input!.body;
            const externalIds = parsed.externalIds;
            const mediaType: 'movie' | 'tv' | 'audiobook' =
                parsed.mediaType === 'series' ? 'tv' : parsed.mediaType;

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not initialised');
            }

            const userId = locals.user!.userId;

            const { watchlistManager } =
                await import('$lib/server/services/watchlist-manager.service.js');

            const result = await watchlistManager.removeItem({
                sql,
                userId,
                externalIds,
                mediaType,
            });

            if (!result.mediaId) {
                return ApiProblem.validationFailed(
                    'No matching catalogue entry for the supplied IDs',
                );
            }

            return json({
                message: result.removed ? 'Removed from watchlist' : 'Item was not on watchlist',
                removed: result.removed ?? false,
                externalIds: { ...externalIds, internal: result.mediaId },
            });
        },
    },
});
