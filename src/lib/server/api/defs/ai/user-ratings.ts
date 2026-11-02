// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/ai/user-ratings.ts — GET /api/ai/user-ratings/[user_id]
 *
 * Returns user ratings with full movie metadata for display.
 * Supports filtering by minimum rating and offset pagination.
 *
 * Returns a paginated envelope { items, page } where each item is a
 * typed UserRatingItem (no z.any()/z.unknown()/passthrough).
 *
 * Errors via ApiProblem: 401 unauthorized, 403 forbidden, 404 not_found,
 *   503 dependency_unavailable.
 *
 * Auth: selfOrAdmin (param: user_id).
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate, type PageBlock } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getUserRatingsFullMetadata } from '$lib/server/database/queries/index.js';
import type { UserRatingsCursor } from '$lib/server/database/queries/user-ratings.queries.js';
import {
    encodeKeysetCursor,
    decodeKeysetCursor,
} from '$lib/server/database/queries/builders/keyset-cursor.builder.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { parsePagination } from '$lib/server/utils/pagination.js';

const logger = Logger.for('UserRatingsDef');

// ---------------------------------------------------------------------------
// Per-feed cursor codec. Wraps the shared keyset-cursor builder with a
// user-ratings feed tag so a cursor minted for another feed cannot decode-and-run
// here. The keyset is over `(created_at DESC, media_id DESC)`; created_at is NOT
// NULL, so there is no NULL group (single tag, no Gate D2b marker).
// ---------------------------------------------------------------------------

const RATINGS_CURSOR_TAG = 'ur:';
const RATINGS_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeRatingsCursor(cursor: UserRatingsCursor): string {
    return RATINGS_CURSOR_TAG + encodeKeysetCursor({ ts: cursor.createdAt, id: cursor.id });
}

function decodeRatingsCursor(raw: string): UserRatingsCursor | null {
    if (!raw.startsWith(RATINGS_CURSOR_TAG)) return null; // untagged / other feed
    const core = decodeKeysetCursor(raw.slice(RATINGS_CURSOR_TAG.length));
    if (!core) return null;
    // Validate both halves before they reach Postgres — a decodable-but-bogus
    // cursor would otherwise 500 (22007 / 22P02) instead of a clean 422.
    if (!RATINGS_UUID_RE.test(core.id)) return null;
    if (Number.isNaN(Date.parse(core.ts))) return null;
    return { createdAt: core.ts, id: core.id };
}

export const def = defineEndpoint({
    auth: { kind: 'selfOrAdmin', param: 'user_id' },
    visibility: 'internal',

    request: {
        params: z.object({
            user_id: z.string().min(1, 'User ID is required'),
        }),
        query: z.object({
            rating_min: z.coerce.number().int().min(1).max(10).default(1),
            /** Opt-in keyset cursor; when present, offset is ignored. */
            cursor: z.string().optional(),
        }),
    },

    handlers: {
        GET: async (event, ctx) => {
            const { locals, request } = event;

            let userId: string = ctx.input!.params.user_id;

            // Handle generic "user" alias — use dev override in dev, authenticated user in prod.
            if (userId === 'user' || !userId) {
                const { getEffectiveUser } = await import('$lib/server/dev-user.js');
                const authenticatedUser = locals.user?.username;
                userId = getEffectiveUser(request, authenticatedUser);
            }

            const ratingMin = ctx.input!.query.rating_min;
            const { limit, offset } = parsePagination(new URL(request.url), {
                maxLimit: 1000,
                defaultLimit: 20,
            });

            // Opt-in keyset cursor. Decoded up front so a malformed value is a
            // clean 422 rather than a bogus value reaching Postgres. When present,
            // offset is ignored (the keyset drives paging).
            const cursorParam = ctx.input!.query.cursor;
            let cursor: UserRatingsCursor | null = null;
            if (cursorParam) {
                cursor = decodeRatingsCursor(cursorParam);
                if (!cursor) {
                    return ApiProblem.validationFailed('Invalid cursor');
                }
            }

            try {
                const sql = await aiDbService.getSql();
                if (!sql) {
                    return ApiProblem.dependencyUnavailable('Database not available');
                }

                // Apply current access boundary so the AI ratings list never
                // re-surfaces titles for items the user has lost access to.
                const accessCtx = await buildSearchAccessContext(sql, locals.user);

                // The [user_id] path segment is a USERNAME — resolve to users.id UUID.
                const { getUserIdByUsername } =
                    await import('$lib/server/database/queries/users.queries.js');
                const uid = await getUserIdByUsername(sql, userId);
                if (!uid) {
                    return ApiProblem.notFound('User not found');
                }

                // Fetch one extra row to determine whether more pages exist
                // without a separate COUNT query. Cursor mode passes the keyset and
                // omits offset; offset mode is unchanged.
                const results = await getUserRatingsFullMetadata.all(sql, {
                    userId: uid,
                    ratingMin,
                    limit: limit + 1,
                    ...(cursor ? { cursor } : { offset }),
                    // The CALLING user's boundary, not the rated user's — this is
                    // the selfOrAdmin "view another user's ratings" endpoint, and
                    // the viewer must never see titles they lack access to just
                    // because the rated user had access.
                    access: searchAccessBoundary(accessCtx),
                });

                const hasMore = results.length > limit;
                const pageResults = hasMore ? results.slice(0, limit) : results;

                // Per-user metadata-language overlay (multilingual-media-metadata
                // spec §5): `pageResults` is a live per-request join to
                // `media_items` (`getUserRatingsFullMetadata`), never cached — no
                // clone needed. Resolved ONCE per request using the CALLING user's
                // preference (mirrors ai/saved-movies.ts: the overlay reflects the
                // current viewer's display language, not the rated-user's, for the
                // selfOrAdmin viewing-someone-else's-ratings case).
                const callerUserId = locals.user?.userId;
                if (callerUserId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                    const { resolveMetadataLanguage } =
                        await import('$lib/server/utils/metadata-language-resolve.js');
                    const { getPlaybackPreferences } =
                        await import('$lib/server/database/queries/user-preferences.queries.js');
                    const langs = resolveMetadataLanguage(
                        await getPlaybackPreferences.one(sql, { userId: callerUserId }),
                    );
                    if (langs.titleLang || langs.textLang) {
                        const { applyTranslationOverlay } =
                            await import('$lib/server/utils/translation-overlay.js');
                        await applyTranslationOverlay(sql, pageResults, langs, {
                            id: (row) => row.media_id ?? null,
                            setTitle: (row, v) => {
                                row.title = v;
                            },
                            setOverview: (row, v) => {
                                row.overview = v;
                            },
                        });
                    }
                }

                // Transform snake_case DB rows to camelCase API response.
                const items = pageResults.map((row) => ({
                    primaryExtId: row.primary_ext_id ?? undefined,
                    // Canonical public discriminator; passthrough for the rest
                    // (ratings span the full storage vocabulary).
                    mediaType: row.media_type === 'tv' ? 'series' : row.media_type,
                    rating: row.rating,
                    createdAt: row.created_at,
                    title: row.title,
                    overview: row.overview ?? null,
                    imdbRating: row.imdb_rating ?? null,
                    rtRating: row.rt_rating ?? null,
                    isAvailable: row.is_available,
                    canRequest: row.can_request,
                    // Validated narrow — legacy rows are null, anything unexpected → undefined.
                    ratingStyle:
                        row.rating_style === 'quick' || row.rating_style === 'stars'
                            ? row.rating_style
                            : undefined,
                }));

                // nextCursor: minted from the last page row's own columns. In
                // cursor mode it continues the keyset walk; on offset responses it
                // is a Gate J1 bootstrap so a client can switch into keyset paging
                // (this feed is always cursor-eligible — one created_at ordering).
                let nextCursor: string | undefined;
                if (hasMore && pageResults.length > 0) {
                    const last = pageResults[pageResults.length - 1];
                    if (last.created_at_cursor) {
                        nextCursor = encodeRatingsCursor({
                            createdAt: last.created_at_cursor,
                            id: last.media_id,
                        });
                    }
                }

                // Gate C: cursor mode drops `offset` (keyset paging has no offset);
                // offset mode keeps it and additionally emits the J1 bootstrap cursor.
                const pageBlock: PageBlock = cursor
                    ? { limit, hasMore }
                    : { limit, offset, hasMore };
                if (nextCursor) {
                    pageBlock.nextCursor = nextCursor;
                }

                return json(paginate(items, pageBlock));
            } catch (error) {
                logger.error('Failed to get user ratings', error as Error, {
                    userId,
                    ratingMin,
                    limit,
                    offset,
                });
                throw error; // Let mount()'s withMountErrorHandler convert to 500.
            }
        },
    },
});
