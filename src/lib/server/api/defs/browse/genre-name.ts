// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/browse/genre-name.ts — GET /api/browse/genre/{name}
 *
 * Lists library items (movies/series) in a single genre, ordered by
 * popularity, with a media-type filter and offset pagination.
 *
 * Contract:
 *   GET /browse/genre/{name}?type=movie|series|all&limit=&offset=
 *     → GenreBrowseResponse (items, genre, totalCount, hasMore, nextOffset, …)
 *
 * Auth: user.  Surface: public. Always library-local (`has_files = true`) —
 * ignores SHOW_UNAVAILABLE_MEDIA, like the rest of /browse.
 * 503 dependency_unavailable when DB is down.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { genreBrowseQuerySchema } from '$lib/schemas/browse.js';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui.js';
import {
    type GenreCursor,
    type GenreMediaRow,
    type GenrePage,
    getMediaByGenre,
    getMediaByGenreCount,
} from '$lib/server/database/queries/browse.queries.js';
import {
    decodeKeysetCursor,
    encodeKeysetCursor,
} from '$lib/server/database/queries/builders/keyset-cursor.builder.js';
import { CACHE_NAMESPACES, cacheManager } from '$lib/server/cache/index.js';
import { toMovieOrSeries } from '$lib/shared/media-type-domain';
import {
    browseScopedCacheKey,
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { entityImageUrl } from '$lib/shared/api-urls.js';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { GenreBrowseResponseSchema } from '$lib/schemas/api-browse-responses';
import { trimItemOverview } from '$lib/server/utils/truncate-overview.js';

const logger = Logger.for('Browse:Genre');

const genreCache = cacheManager.for(CACHE_NAMESPACES.browseGenres);

const ParamsSchema = z.object({
    name: z.string().min(1).describe('Genre name (URL-encoded), e.g. "Science Fiction"'),
});

interface GenrePageCacheData {
    rows: GenreMediaRow[];
    totalCount: number;
}

// ---------------------------------------------------------------------------
// Per-feed cursor codec (F9c). Wraps the shared keyset-cursor builder with a
// genre feed tag so a cursor minted for another feed (e.g. /user/series) cannot
// decode-and-run here, and with a NULL marker so Gate D2b carries the
// NULL-popularity group. popularity is exact numeric TEXT (F4 — never a float).
//   'gv:' — genre value group (non-null popularity)
//   'gn:' — genre NULL group   (popularity IS NULL, ordered by id)
// ---------------------------------------------------------------------------

const GENRE_CURSOR_TAG_VALUE = 'gv:';
const GENRE_CURSOR_TAG_NULL = 'gn:';
const GENRE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENRE_NUMERIC_RE = /^-?\d+(\.\d+)?$/;

function encodeGenreCursor(cursor: GenreCursor): string {
    if (cursor.popularity === null) {
        return GENRE_CURSOR_TAG_NULL + encodeKeysetCursor({ ts: '-', id: cursor.id });
    }
    return GENRE_CURSOR_TAG_VALUE + encodeKeysetCursor({ ts: cursor.popularity, id: cursor.id });
}

function decodeGenreCursor(raw: string): GenreCursor | null {
    const isNull = raw.startsWith(GENRE_CURSOR_TAG_NULL);
    const isValue = raw.startsWith(GENRE_CURSOR_TAG_VALUE);
    if (!isNull && !isValue) return null; // untagged or a different feed's cursor
    const core = decodeKeysetCursor(raw.slice(3));
    if (!core) return null;
    // Validate both halves before they reach Postgres (a bogus value would 500
    // as 22P02/22003 instead of a clean 422).
    if (!GENRE_UUID_RE.test(core.id)) return null;
    if (isNull) return { popularity: null, id: core.id };
    if (!GENRE_NUMERIC_RE.test(core.ts)) return null;
    return { popularity: core.ts, id: core.id };
}

export const def = defineEndpoint({
    // Internal /api/browse route retained for the web until the client migration.
    // v1 consumers use GET /media; the v1 A–Z and genre mounts were removed.
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Browse'],
            summary: 'Browse library items in a genre',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns a page of library items (`has_files = true`) in the given genre, ' +
                'ordered by popularity. Supports a `type` filter (movie | series | all) and ' +
                'offset-based pagination. The genre name is the URL-encoded path segment.',
            params: ParamsSchema,
            query: genreBrowseQuerySchema,
            responses: {
                200: {
                    schema: GenreBrowseResponseSchema,
                    description: 'Paginated genre media page',
                },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        params: ParamsSchema,
        query: genreBrowseQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const { name: genreName } = ctx.input!.params;
            const { type: mediaType, offset, limit, cursor: cursorParam } = ctx.input!.query;
            // Translate canonical public value to the internal DB discriminator.
            const dbMediaType: 'movie' | 'tv' | 'all' = mediaType === 'series' ? 'tv' : mediaType;

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            // Decode the opt-in cursor up front (F9c genre tag guard); 422 on
            // malformed rather than letting a bogus value reach Postgres.
            let genrePage: GenrePage;
            if (cursorParam) {
                const decoded = decodeGenreCursor(cursorParam);
                if (!decoded) return ApiProblem.validationFailed('Invalid cursor');
                genrePage = { mode: 'cursor', cursor: decoded };
            } else {
                genrePage = { mode: 'offset', offset };
            }

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);
            const access = searchAccessBoundary(accessCtx);

            try {
                let rows: GenreMediaRow[];
                let totalCount: number | undefined;

                if (genrePage.mode === 'cursor') {
                    // Gate E2: bypass the cache entirely in cursor mode (cursor
                    // strings are ~unique → ~0 hit rate) and skip the totalCount
                    // query (Gate I1 — dropped in cursor mode). F8: getMediaByGenre
                    // now RETHROWS in cursor mode, so a transient DB error lands in
                    // the catch below as a real 500, not a silently truncated page.
                    rows = await getMediaByGenre(sql, genreName, {
                        mediaType: dbMediaType,
                        limit,
                        page: genrePage,
                        access,
                    });
                } else {
                    // Per-page cache (offset+limit folded in) scoped to the caller's
                    // library/age access. Key prefix bumped v1genre: → v2genre: (F6)
                    // because Gate H2 changed the offset ORDER BY (title → id), so
                    // every v1 entry is stale.
                    const cacheKey = browseScopedCacheKey(
                        `v3genre:${genreName.toLowerCase()}:${dbMediaType}:${offset}:${limit}`,
                        accessCtx,
                    );
                    let data = await genreCache.get<GenrePageCacheData>(cacheKey);
                    if (!data) {
                        const [r, c] = await Promise.all([
                            getMediaByGenre(sql, genreName, {
                                mediaType: dbMediaType,
                                limit,
                                offset,
                                access,
                            }),
                            getMediaByGenreCount(sql, genreName, {
                                mediaType: dbMediaType,
                                access,
                            }),
                        ]);
                        data = { rows: r, totalCount: c };
                        await genreCache.set(cacheKey, data);
                    }
                    rows = data.rows;
                    totalCount = data.totalCount;
                }

                const hasMore =
                    genrePage.mode === 'cursor'
                        ? rows.length > limit
                        : offset + limit < (totalCount ?? 0);
                const pageRows = genrePage.mode === 'cursor' ? rows.slice(0, limit) : rows;

                const items: UniversalMediaItem[] = pageRows.map((row) => ({
                    id: row.id,
                    externalIds: { internal: row.id },
                    // Canonical: 'series' replaces 'tv'. getMediaByGenre filters
                    // `mi.media_type = ${mediaType}` or, for the 'all' filter,
                    // `mi.media_type IN ('movie', 'tv')` — this row can never be
                    // anything else.
                    // eslint-disable-next-line callback-safety/no-inline-media-type-default -- the genre query is movie/TV-only.
                    mediaType: toMovieOrSeries(row.media_type) ?? 'movie',
                    title: row.title,
                    image: entityImageUrl(row.id, 'poster', ctx.surface, { size: 'thumb' }),
                    backdrop: entityImageUrl(row.id, 'backdrop', ctx.surface, { size: 'thumb' }),
                    year: row.year ?? undefined,
                    overview: row.overview || undefined,
                    // getMediaByGenre already filters has_files = true.
                    isAvailable: true,
                    canRequest: false,
                }));

                // Per-user metadata-language overlay (multilingual-media-metadata
                // spec §5): resolved once per request, applied to the freshly
                // mapped items above (never a cache-resident reference), so
                // overlaying in place is safe.
                const userId = event.locals.user?.userId;
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
                        await applyTranslationOverlay(sql, items, langs, {
                            id: (it) => it.id || null,
                            setTitle: (it, v) => {
                                it.title = v;
                            },
                            setOverview: (it, v) => {
                                it.overview = v;
                            },
                        });
                    }
                }

                // nextCursor: emitted whenever more items exist — in cursor mode,
                // and (Gate J1 bootstrap) on offset responses too (genre is always
                // cursor-eligible: one popularity ordering). popularity_cursor is
                // exact numeric text; null → the NULL-popularity (gn:) group.
                let nextCursor: string | undefined;
                if (hasMore && pageRows.length > 0) {
                    const last = pageRows[pageRows.length - 1];
                    nextCursor = encodeGenreCursor({
                        popularity: last.popularity_cursor ?? null,
                        id: last.id,
                    });
                }

                // Overview truncation applies ONLY on the internal surface — this
                // def is also mounted at /api/v1/browse/genre/{name} (see
                // routes/api/v1/browse/genre/[name]), which must stay
                // byte-identical for native clients. See truncate-overview.ts.
                const responseItems =
                    ctx.surface === 'internal' ? items.map(trimItemOverview) : items;

                if (genrePage.mode === 'cursor') {
                    // Gate I1: cursor mode omits totalCount/nextOffset/currentOffset.
                    return json({
                        items: responseItems,
                        genre: genreName,
                        page: { limit, hasMore, ...(nextCursor ? { nextCursor } : {}) },
                        // eslint-disable-next-line callback-safety/no-discriminator-leak-in-response
                        mediaType,
                    });
                }

                return json({
                    items: responseItems,
                    genre: genreName,
                    page: {
                        limit,
                        offset,
                        total: totalCount,
                        hasMore,
                        ...(nextCursor ? { nextCursor } : {}),
                    },
                    // Echoes the applied `?type=` filter under the field name
                    // GenreBrowseResponseSchema declares (`mediaType`) — a deliberate
                    // passthrough, not an item-level discriminator leak.
                    // eslint-disable-next-line callback-safety/no-discriminator-leak-in-response
                    mediaType,
                });
            } catch (error) {
                logger.error('Failed to fetch genre media', error as Error, { genreName });
                return ApiProblem.internalError('Failed to fetch genre media');
            }
        },
    },
});
