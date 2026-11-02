// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/items/index.ts — GET/POST /playlists/{id}/items
 *
 * Auth:
 *   GET  — any user with playlist access (role or public visibility)
 *   POST — editor or owner
 *
 * Mounted at:
 *   src/routes/api/playlists/[id]/items/+server.ts (internal surface)
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate, type PageBlock } from '$lib/server/api/problem.js';
import { getUserRole, canEdit, getPlaylistContext } from '$lib/server/utils/playlist-utils.js';
import { playlistItemManager } from '$lib/server/services/playlist-item-manager.service.js';
import {
    getPlaylistItems,
    getPlaylistType,
    type PlaylistItemsCursor,
} from '$lib/server/database/queries/playlists.queries.js';
import { getPlaylistKindPolicy } from '$lib/server/services/playlist-kind-policy.js';
import {
    encodeKeysetCursor,
    decodeKeysetCursor,
} from '$lib/server/database/queries/builders/keyset-cursor.builder.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';
import { transformPlaylistItemRow } from '$lib/server/utils/playlist-transforms.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { cacheInvalidation } from '$lib/server/cache';
import { checkRateLimit, rateLimitHeaders } from '$lib/server/middleware/valkey-rate-limit.js';
import { getDb } from '$lib/server/database/connection.js';
import { getEffectiveUser } from '$lib/server/dev-user.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { config } from '$lib/server/config.js';
import { getPlaybackPreferences } from '$lib/server/database/queries/user-preferences.queries.js';
import {
    resolveMetadataLanguage,
    type MetadataLanguagePrefs,
} from '$lib/server/utils/metadata-language-resolve.js';
import { applyTranslationOverlay } from '$lib/server/utils/translation-overlay.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    addPlaylistItemSchema,
    addPlaylistItemsResponseSchema,
    playlistEntrySchema,
} from '$lib/schemas/playlists.js';
import { PageBlockSchema } from '$lib/schemas/api-for-you-responses.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const ItemsIdParams = z.object({
    id: z.coerce.number().int().positive().max(2147483647),
});

// ---------------------------------------------------------------------------
// Per-feed keyset cursor codec. Wraps the shared builder with a feed tag so a
// cursor minted for another feed (e.g. /members or /playlists) cannot be
// decoded-and-run here. The items sort key is `(position ASC, id ASC)` — both
// integers, NOT NULL, so there is no NULL group and a single tag suffices.
//   'pi:' — playlist items (position value + id tiebreak, both integer text)
// ---------------------------------------------------------------------------

const ITEMS_CURSOR_TAG = 'pi:';
const ITEMS_INT_RE = /^-?\d+$/;

const logger = Logger.for('PlaylistItemsDef');

/**
 * Overlay playlist item titles in the viewer's metadata language.
 *
 * Called AFTER the pagination slice in both branches, on the fresh objects
 * `transformPlaylistItemRow` builds per request — there is no cached payload
 * here, so in-place mutation is safe. The config gate keeps zero-language
 * installs at zero queries, including no preference lookup.
 *
 * `titleLang` gate is REQUIRED, not redundant (mirrors seed-title-overlay.ts):
 * only `setTitle` is supplied below, so a viewer with `textLang` set but no
 * `titleLang` would otherwise still trigger a translation lookup over up to
 * 1000 uuids whose result no setter consumes. `textLang: null` is passed to
 * `applyTranslationOverlay` for the same reason — it fetches one map per
 * distinct non-null language, and the second map would go unused here.
 */
async function overlayItemTitles(
    sql: postgres.Sql,
    items: Array<{ mediaId: string; title?: string }>,
    event: RequestEvent,
): Promise<void> {
    if (config.METADATA_ADDITIONAL_LANGUAGES.length === 0 || items.length === 0) return;
    const userId = event.locals.user?.userId;
    if (!userId) return;

    let prefs: MetadataLanguagePrefs | null = null;
    try {
        prefs = await getPlaybackPreferences.one(sql, { userId });
    } catch (err) {
        logger.warn(
            'Preferences read failed for playlist item metadata-language overlay; falling back to primary language',
            {
                userId,
                error: err instanceof Error ? err.message : String(err),
            },
        );
    }
    const langs = resolveMetadataLanguage(prefs);
    if (!langs.titleLang) return;

    await applyTranslationOverlay(
        sql,
        items,
        { titleLang: langs.titleLang, textLang: null },
        {
            // Music items have no rows in media_translations and simply miss.
            id: (item) => item.mediaId,
            setTitle: (item, value) => {
                item.title = value;
            },
        },
    );
}

function encodeItemsCursor(position: number, id: number): string {
    return ITEMS_CURSOR_TAG + encodeKeysetCursor({ ts: String(position), id: String(id) });
}

function decodeItemsCursor(raw: string): PlaylistItemsCursor | null {
    if (!raw.startsWith(ITEMS_CURSOR_TAG)) return null; // untagged or a different feed's cursor
    const core = decodeKeysetCursor(raw.slice(ITEMS_CURSOR_TAG.length));
    if (!core) return null;
    // Validate both halves are integers before they reach Postgres — a
    // decodable-but-bogus cursor would otherwise 500 (22P02) instead of a clean 422.
    if (!ITEMS_INT_RE.test(core.ts) || !ITEMS_INT_RE.test(core.id)) return null;
    return { position: core.ts, id: core.id };
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    // OpenAPI docs for the /api/v1/playlists/{id}/items surface. Migrated verbatim
    // from the retired src/routes/api/v1/playlists/[id]/items/_openapi.ts.
    docs: {
        GET: {
            tags: ['Playlists'],
            summary: 'List playlist items',
            description:
                'Returns all items in a playlist ordered by position. Accessible to the owner, accepted members, and viewers of public playlists. Supports ?itemType=music|video and ?limit/?offset pagination. Opt into stable keyset paging with ?cursor (from a previous response’s page.nextCursor); when present, offset is ignored and page.total is omitted. ' +
                'Each item carries the viewer’s playback state — `positionSeconds`, `durationSeconds`, `lastPlayedAt`, `playbackWatched` — matching the shape of /continue-watching so clients can draw the same progress bar and resume from position. Note `positionSeconds` (playback) is distinct from `position` (playlist slot), and `playbackWatched` (real playback) from `watched` (playlist-scoped manual tick).',
            stability: 'stable',
            auth: 'bearer',
            query: z.object({
                itemType: z
                    .enum(['music', 'video'])
                    .optional()
                    .meta({ description: 'Filter items by type' }),
                limit: z.coerce
                    .number()
                    .int()
                    .min(1)
                    .max(1000)
                    .optional()
                    .meta({ description: 'Max items per page (default 200)' }),
                offset: z.coerce
                    .number()
                    .int()
                    .min(0)
                    .optional()
                    .meta({ description: 'Pagination offset (ignored when cursor is present)' }),
                cursor: z.string().optional().meta({
                    description:
                        'Opaque keyset cursor over (position, id). Returned as page.nextCursor on a previous response; when present, offset is ignored.',
                }),
            }),
            responses: {
                200: {
                    schema: z
                        .object({
                            items: z.array(playlistEntrySchema),
                            page: PageBlockSchema,
                        })
                        .meta({
                            id: 'PlaylistItemsCollection',
                            description: 'Paginated playlist items collection',
                        }),
                    description: 'Paginated list of playlist items',
                },
                401: 'Authentication required',
                404: 'Playlist not found or access denied',
            },
        },
        POST: {
            tags: ['Playlists'],
            stability: 'stable',
            summary: 'Add item to playlist',
            description:
                'Adds catalog items, expanding series, seasons and albums; duplicates and rejections are reported per input.',
            body: addPlaylistItemSchema,
            responses: {
                200: {
                    schema: addPlaylistItemsResponseSchema,
                    description: 'Item added or series expanded',
                },
                404: 'Playlist not found',
            },
        },
    },

    request: {
        params: ItemsIdParams,
        body: addPlaylistItemSchema,
    },
    handlers: {
        /**
         * GET /playlists/{id}/items
         * List items in a playlist (paginated).
         *
         * Response: { items, page }
         */
        GET: async (event, ctx) => {
            const username = getEffectiveUser(event.request, event.locals.user?.username ?? null);

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rawId = event.params.id;
            const playlistId = rawId ? Number.parseInt(rawId, 10) : Number.NaN;
            if (Number.isNaN(playlistId) || playlistId <= 0) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a positive integer' },
                ]);
            }

            const { role, visibility } = await getUserRole(sql, playlistId, username || '');
            if (!role && visibility !== 'public') {
                return ApiProblem.notFound('Playlist not found or access denied');
            }

            const playlistType = await getPlaylistType(sql, playlistId);
            const policy = getPlaylistKindPolicy(playlistType);

            const itemTypeParam = event.url.searchParams.get('itemType') ?? undefined;
            const itemType =
                itemTypeParam === 'music' || itemTypeParam === 'video' ? itemTypeParam : undefined;

            const deniedGroups = await getDeniedLibraryGroups(
                sql,
                toLibraryAccessUser(event.locals.user),
            );
            const access = restrictedAccess({
                deniedGroupIds: deniedGroups ?? [],
                maxAgeRating: event.locals.user?.maxAgeRating ?? null,
                allowUnrated: config.UNRATED_CONTENT_VISIBLE,
            });

            const { limit, offset } = parsePagination(event.url, {
                defaultLimit: 200,
                maxLimit: 1000,
            });

            const userId = event.locals.user?.userId ?? null;
            const cursorParam = event.url.searchParams.get('cursor') ?? undefined;

            if (cursorParam) {
                // N5 (2026-09-22 edge-case pass): the bootstrap `page.nextCursor`
                // is already suppressed below for a non-`position`-sorted
                // playlist (the watchlist), but nothing stopped a caller from
                // hand-crafting one anyway — cursor mode always pages by
                // `(position, id)` regardless of `sort` (see the comment on
                // `itemsOrderBy` in getPlaylistItems), so a watchlist request
                // with `?cursor=` silently paged by position instead of
                // `added_at DESC`, serving the same endpoint under two
                // different orderings depending on which param the caller
                // used.
                if (policy.sort !== 'position') {
                    return ApiProblem.validationFailed(
                        'Cursor paging is not supported for this playlist',
                    );
                }

                // Cursor mode (Gate C): ignore offset, drop total, keep
                // items/hasMore/limit. n+1 lookahead drives hasMore without a
                // second query.
                const decoded = decodeItemsCursor(cursorParam);
                if (!decoded) return ApiProblem.validationFailed('Invalid cursor');

                // No `sort` argument here: cursor mode always orders by
                // `(position ASC, id ASC)` regardless of the playlist's kind
                // policy — see the comment on `itemsOrderBy` in
                // getPlaylistItems. Passing `policy.sort` would read as though
                // cursor mode honours it, which it structurally cannot (the
                // keyset predicate is built over exactly those two columns).
                const rows = await getPlaylistItems(sql, playlistId, userId, itemType, access, {
                    mode: 'cursor',
                    availableOnly: true,
                    cursor: decoded,
                    limit,
                });
                const hasMore = rows.length > limit;
                const pageRows = rows.slice(0, limit);
                const items = pageRows.map((row) => transformPlaylistItemRow(row, ctx.surface));
                await overlayItemTitles(sql, items, event);
                const pageBlock: PageBlock = { limit, hasMore };
                if (hasMore && pageRows.length > 0) {
                    const last = pageRows[pageRows.length - 1];
                    pageBlock.nextCursor = encodeItemsCursor(last.position, last.id);
                }
                return json(paginate(items, pageBlock));
            }

            // Offset mode — byte-identical to the historical response, plus a
            // Gate J1 bootstrap `page.nextCursor` when there is a next page so a
            // client can switch into keyset paging. offset still produced this page.
            const allItems = await getPlaylistItems(
                sql,
                playlistId,
                userId,
                itemType,
                access,
                { mode: 'offset', availableOnly: true },
                policy.sort,
            );

            const page = allItems.slice(offset, offset + limit);
            const items = page.map((row) => transformPlaylistItemRow(row, ctx.surface));
            await overlayItemTitles(sql, items, event);
            const hasMore = offset + limit < allItems.length;
            const pageBlock: PageBlock = {
                limit,
                offset,
                hasMore,
                total: allItems.length,
            };
            // Bootstrap cursor only for `position`-sorted playlists. Cursor mode
            // always pages by `(position ASC, id ASC)` — see the comment on
            // `itemsOrderBy` in getPlaylistItems — so minting a cursor off the
            // last row of an `added_at DESC` offset page (e.g. the watchlist)
            // would hand the client a (position, id) pair that does not bound
            // the same ordering it was just shown, silently skipping or
            // duplicating rows across the offset->cursor handoff. Non-position
            // playlists therefore stay offset-paged only; `cursor` is optional
            // in the response schema, so omitting it here is not a contract
            // break.
            if (hasMore && page.length > 0 && policy.sort === 'position') {
                const last = page[page.length - 1];
                pageBlock.nextCursor = encodeItemsCursor(last.position, last.id);
            }
            return json(paginate(items, pageBlock));
        },

        /**
         * POST /playlists/{id}/items
         * Add an item to a playlist (editor/owner only).
         *
         * For TV series, automatically expands to individual episodes.
         * Response: 201 + item or expansion summary.
         */
        POST: async (event, ctx) => {
            const result = await getPlaylistContext(event);
            if ('error' in result) return result.error;
            const { playlistId, sql, role } = result.context;
            if (!canEdit(role)) return ApiProblem.forbidden('You cannot add to this playlist');
            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }
            const parsed = addPlaylistItemSchema.safeParse(body);
            if (!parsed.success) return ApiProblem.validationFailed(parsed.error.message);
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();
            // EndpointDef's budget applies to every method. Keep this shared write
            // budget here so paginated GETs do not consume it. Consumed only after
            // the request is known to be well-formed, keyed by a stable identity
            // (never `playlist-bulk:undefined`).
            // Same key namespace as bulk-delete (`playlist-bulk:${username}`).
            const budgetKey = event.locals.principal?.username ?? user.username;
            if (!budgetKey) return ApiProblem.unauthorized();
            const budget = await checkRateLimit(`playlist-bulk:${budgetKey}`, 20, 60);
            if (!budget.allowed)
                return ApiProblem.rateLimited(
                    Math.max(0, Math.ceil(budget.resetAt - Date.now() / 1000)),
                    { headers: rateLimitHeaders(budget) },
                );
            const deniedGroups = await getDeniedLibraryGroups(sql, toLibraryAccessUser(user));
            const access = restrictedAccess({
                deniedGroupIds: deniedGroups ?? [],
                maxAgeRating: user.maxAgeRating ?? null,
                allowUnrated: config.UNRATED_CONTENT_VISIBLE,
            });
            const playlistType = await getPlaylistType(sql, playlistId);
            const response = await playlistItemManager.addMediaItems({
                sql,
                playlistId,
                mediaIds: parsed.data.mediaIds,
                user,
                surface: ctx.surface,
                playlistType,
                access,
            });
            if (playlistType === 'watchlist') {
                for (const result of response.results.filter(
                    (result) => result.status === 'added',
                )) {
                    for (const entry of result.entries) {
                        try {
                            await cacheInvalidation.onWatchlistChange(user.userId, entry.mediaId);
                        } catch (error) {
                            logger.warn('Watchlist cache invalidation failed', {
                                playlistId,
                                error: String(error),
                            });
                        }
                    }
                }
            }
            return json(response);
        },
    },
});
