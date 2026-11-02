// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/index.ts — GET/POST /playlists
 *
 * Mounted at:
 *   src/routes/api/playlists/+server.ts          (internal surface)
 *   src/routes/api/v1/playlists/+server.ts        (v1 token surface)
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate, type PageBlock } from '$lib/server/api/problem.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { canCreatePublicPlaylist } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getOwnedPlaylists,
    getSharedPlaylists,
    getPublicPlaylists,
    createPlaylist,
    type PublicPlaylistsPage,
    type PublicPlaylistsCursor,
} from '$lib/server/database/queries/playlists.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
    unauthenticatedSearchAccessContext,
} from '$lib/server/utils/search-access-context.js';
import { playlistWithImages, playlistsWithImages } from '$lib/server/utils/playlist-transforms.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import { ensureWatchlistPlaylist } from '$lib/server/database/queries/watchlist-playlist.queries.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    encodeKeysetCursor,
    decodeKeysetCursor,
} from '$lib/server/database/queries/builders/keyset-cursor.builder.js';
import { createPlaylistSchema } from '$lib/schemas/playlists.js';
import { Logger } from '$lib/server/utils/logger.js';
import { playlistsListResponseSchema, playlistResponseSchema } from '$lib/schemas/playlists';
import { apiUrl } from '$lib/shared/api-urls.js';

const PlaylistsGetQuerySchema = z.object({
    type: z
        .enum(['general', 'music', 'video'])
        .optional()
        .meta({ description: 'Filter by playlist content type' }),
    scope: z.enum(['owned', 'public']).optional().meta({
        description:
            "Which playlists to return. 'owned' (default) returns the caller's own playlists plus those shared with them. 'public' returns public playlists the caller neither owns nor is a member of — the discover feed.",
    }),
    limit: z.coerce.number().int().optional().meta({ description: 'Page size' }),
    offset: z.coerce.number().int().optional().meta({ description: 'Page offset' }),
    cursor: z
        .string()
        .optional()
        .meta({
            description:
                'Opaque keyset cursor for scope=public, returned as page.nextCursor on a previous ' +
                'response. When present, offset is ignored. Ignored (never errors) for scope=owned.',
        }),
});

const logger = Logger.for('PlaylistsDef');

// ---------------------------------------------------------------------------
// Keyset cursor — mirrors the (timestamp, id) shape used by the task
// orchestrator's run-history cursor (src/lib/server/tasks/orchestrator.ts).
//
// Uses the shared keyset-cursor builder (the same codec backing
// `getPublicPlaylists` and the orchestrator's run history); the def keeps its
// own per-half validation, which is caller-side and NOT part of the shared
// codec's contract. The builder emits `base64url`; the previous local encoder
// emitted plain `base64`, and cursors already in flight from the old encoder
// still decode correctly (both alphabets round-trip byte-identically through
// `Buffer.from(x, 'base64url')`).
// ---------------------------------------------------------------------------

function encodeCursor(parts: PublicPlaylistsCursor): string {
    return encodeKeysetCursor({ ts: parts.updatedAt, id: parts.id });
}

function decodeCursor(cursor: string): PublicPlaylistsCursor | null {
    const decoded = decodeKeysetCursor(cursor);
    if (!decoded) return null;
    const { ts: updatedAt, id } = decoded;
    // decodeKeysetCursor never throws on malformed input, and base64 decoding is
    // lenient, so both halves must be validated here — otherwise a
    // decodable-but-bogus cursor reaches Postgres as `'foo'::timestamptz` / an
    // integer column comparison and 500s (22007 / 22P02) instead of a
    // validation error.
    if (Number.isNaN(Date.parse(updatedAt))) return null;
    if (!/^\d+$/.test(id)) return null;
    return { updatedAt, id };
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/**
 * GET /playlists query schema.
 *
 * `type` filters by playlist content type.
 * `limit`/`offset` are parsed by parsePagination() in the handler; we declare
 * them here so the contract layer strips/coerces them.
 */
const PlaylistsGetQuery = z.object({
    type: z.enum(['general', 'music', 'video']).optional(),
    scope: z.enum(['owned', 'public']).optional(),
    // Coercion only; parsePagination() clamps in the handler.
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
    // Not load-bearing for the handler: it reads `cursor` straight off
    // `event.url.searchParams` (like limit/offset via parsePagination()), so
    // the contract layer's parsed `ctx.input.query` is never consulted here.
    // Declared anyway for OpenAPI generation and so a future switch to
    // `ctx.input.query` doesn't silently drop the param.
    cursor: z.string().optional(),
});

/**
 * POST /playlists body schema.
 *
 * Mirrors createPlaylistSchema from $lib/schemas/playlists — kept lenient
 * (strip unknown, no .strict()) so the handler's own re-parse always agrees.
 */
const PlaylistsPostBody = z.object({
    name: z.string().min(1).max(255),
    description: z.string().optional(),
    visibility: z.enum(['private', 'public']).optional(),
    playlistType: z.enum(['general', 'music', 'video']).optional(),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Playlists'],
            summary: 'List playlists',
            stability: 'stable',
            auth: 'bearer',
            description:
                "Returns the user's own playlists and public playlists shared with them. " +
                'Pass ?scope=public for the discover feed: public playlists the caller ' +
                'neither owns nor is a member of.',
            query: PlaylistsGetQuerySchema,
            responses: {
                200: { schema: playlistsListResponseSchema, description: 'Playlists' },
                401: 'Authentication required',
                422: 'cursor could not be decoded (scope=public only)',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Playlists'],
            summary: 'Create a playlist',
            stability: 'stable',
            auth: 'bearer',
            description: 'Creates a new playlist for the authenticated user.',
            body: createPlaylistSchema,
            responses: {
                201: { schema: playlistResponseSchema, description: 'Playlist created' },
                400: 'Validation error',
                401: 'Authentication required',
                403: 'Permission denied (e.g. public playlist creation restricted)',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        GET: { kind: 'feature', flag: 'playlists', then: { kind: 'user' } },
        POST: { kind: 'feature', flag: 'playlists', then: { kind: 'user' } },
    },
    request: {
        // query applies to GET; body applies to POST (mount() skips body on GET).
        query: PlaylistsGetQuery,
        queryMethods: ['GET'],
        body: PlaylistsPostBody,
    },
    handlers: {
        /**
         * GET /playlists
         * List all playlists the authenticated user owns or has access to.
         *
         * Response: { items: Playlist[], page: PageBlock }
         * Two categories (owned/shared) are flattened into a single items array for
         * the v1 surface (one items key). The category is available
         * via the `role` field on each playlist item.
         *
         * Query params:
         *   ?type=general|music|video   — filter by playlist content type
         *   ?limit=20&offset=0          — pagination
         */
        GET: async (event, ctx) => {
            const username =
                event.locals.principal?.username ?? event.locals.user?.username ?? null;
            if (!username) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const userId = await getUserIdByUsername(sql, username);
            if (!userId) return ApiProblem.unauthorized();

            const typeParam = event.url.searchParams.get('type') ?? undefined;
            const scope = event.url.searchParams.get('scope') ?? 'owned';
            const { limit, offset } = parsePagination(event.url, {
                defaultLimit: 50,
                maxLimit: 200,
            });

            const playlistType = typeParam as 'general' | 'music' | 'video' | undefined;

            // Viewer access context — filters cover collage art by the caller's
            // library-group and age-rating permissions. Playlist rows themselves
            // are never hidden by it.
            const user = event.locals.user;
            // Fail closed: this branch is unreachable today (auth: { kind: 'user' }
            // guarantees `user` is set), but a fail-open default here would silently
            // disable cover-art access filtering if the auth path ever changed.
            const accessCtx = user
                ? await buildSearchAccessContext(sql, user)
                : unauthenticatedSearchAccessContext();
            // Single conversion point, shared with the /playlists SSR route —
            // both used to hand-build the same `{ deniedGroupIds, ageRating }`
            // literal, which is exactly how two copies of an access rule drift.
            const access = searchAccessBoundary(accessCtx);

            // Idempotent; creates the row on first access so a native or
            // /api/v1 client sees the pinned Watchlist even if it has never
            // hit the web SSR route (routes/playlists/+page.server.ts),
            // which already does this. Scope=public is a discovery feed of
            // OTHER users' playlists, not the caller's own list — no reason
            // to pay for this write there.
            if (scope !== 'public') {
                await ensureWatchlistPlaylist(sql, toUserId(userId));
            }

            if (scope === 'public') {
                // cursor is only meaningful for scope=public. No cursor param →
                // offset mode, byte-identical to the pre-existing behavior the
                // tvOS client already ships against.
                const cursorParam = event.url.searchParams.get('cursor') ?? undefined;
                let pagination: PublicPlaylistsPage;
                if (cursorParam) {
                    const decoded = decodeCursor(cursorParam);
                    if (!decoded) {
                        return ApiProblem.validationFailed('Invalid cursor');
                    }
                    pagination = { mode: 'cursor', cursor: decoded };
                } else {
                    pagination = { mode: 'offset', offset };
                }

                // Query pages in SQL and returns limit + 1 so we can detect
                // hasMore without a COUNT(*) over every public playlist.
                const rows = await getPublicPlaylists(
                    sql,
                    userId,
                    playlistType,
                    limit,
                    pagination,
                    access,
                );
                const hasMore = rows.length > limit;
                const page = rows.slice(0, limit);
                const items = await playlistsWithImages(
                    sql,
                    page.map((row) => ({ row, role: 'readonly' })),
                    ctx.surface,
                );

                // Gate J1 (cursor bootstrap): scope=public is always
                // cursor-eligible, so emit page.nextCursor on BOTH cursor- and
                // offset-mode responses whenever there is a next page. On an
                // offset response the cursor is a *bootstrap value* — a client can
                // hand it back to switch into keyset paging — NOT a second live
                // paging mechanism; `offset` remains the mechanism that produced
                // THIS page. See the PageBlock doc comment in problem.ts for the
                // documented mutual-exclusivity exception this relies on.
                const pageBlock: PageBlock =
                    pagination.mode === 'cursor' ? { limit, hasMore } : { limit, offset, hasMore };
                if (hasMore && page.length > 0) {
                    const last = page[page.length - 1];
                    // updated_at_cursor is `updated_at::text` straight from Postgres —
                    // never the parsed `Date` on `updated_at`, whose
                    // toISOString() truncates to milliseconds and can silently
                    // skip a row touched within the same millisecond as the
                    // boundary (Postgres timestamps carry microseconds).
                    if (last.updated_at_cursor !== undefined) {
                        pageBlock.nextCursor = encodeCursor({
                            updatedAt: last.updated_at_cursor,
                            id: String(last.id),
                        });
                    }
                }

                return json(paginate(items, pageBlock));
            }

            const [ownedRows, sharedRows] = await Promise.all([
                getOwnedPlaylists(sql, userId, playlistType, access),
                getSharedPlaylists(sql, userId, playlistType, access),
            ]);

            // Owned rows precede shared rows — the pre-existing concatenation
            // contract. Flat-rendering clients would silently reorder otherwise.
            const entries = [
                ...ownedRows.map((row) => ({ row, role: 'owner' as const })),
                ...sharedRows.map((row) => ({ row, role: row.role || ('readonly' as const) })),
            ];
            const page = await playlistsWithImages(
                sql,
                entries.slice(offset, offset + limit),
                ctx.surface,
            );
            return json(
                paginate(page, { limit, offset, hasMore: offset + limit < entries.length }),
            );
        },

        /**
         * POST /playlists
         * Create a new playlist.
         *
         * If the user lacks permission to create public playlists and requests public
         * visibility, returns 403 instead of silently downgrading to private.
         *
         * Response: 201 + bare playlist object + Location header.
         */
        POST: async (event, ctx) => {
            const username =
                event.locals.principal?.username ?? event.locals.user?.username ?? null;
            if (!username) return ApiProblem.unauthorized();

            const userGroups =
                event.locals.principal?.userGroups ?? event.locals.user?.userGroups ?? [];

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const userId = await getUserIdByUsername(sql, username);
            if (!userId) return ApiProblem.unauthorized();

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsed = createPlaylistSchema.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }

            const { name, description, visibility, playlistType } = parsed.data;

            // No silent downgrade — 403 if user lacks public playlist permission
            if (visibility === 'public' && !canCreatePublicPlaylist(userGroups)) {
                return ApiProblem.forbidden(
                    'You do not have permission to create public playlists',
                );
            }

            const playlist = await createPlaylist(
                sql,
                userId,
                name,
                description ?? null,
                visibility,
                playlistType ?? 'general',
            );

            logger.info('Playlist created', {
                playlistId: playlist.id,
                owner: username,
                name: playlist.name,
            });

            const created = await playlistWithImages(sql, playlist, 'owner', ctx.surface);

            const headers = new Headers({
                Location: apiUrl(ctx.surface, `/playlists/${playlist.id}`),
            });
            return json(created, { status: 201, headers });
        },
    },
});
