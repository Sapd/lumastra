// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playlists/[id]/members/index.ts — GET/POST /playlists/{id}/members
 *
 * Auth model:
 *   GET  — playlist owner only (only owner manages membership roster)
 *   POST — playlist owner only (invite)
 *
 * Mounted at:
 *   src/routes/api/playlists/[id]/members/+server.ts
 *   src/routes/api/v1/playlists/[id]/members/+server.ts
 */

import { authorOrPlaceholder, loadPublicAuthors } from '$lib/server/utils/public-author.js';
import type { PlaylistMember } from '$lib/schemas/playlists.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate, type PageBlock } from '$lib/server/api/problem.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { getUserRole, canManageMembers } from '$lib/server/utils/playlist-utils.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getPlaylistMembers,
    inviteMember,
    type PlaylistMembersCursor,
    type PlaylistMemberRow,
} from '$lib/server/database/queries/playlists.queries.js';
import {
    encodeKeysetCursor,
    decodeKeysetCursor,
} from '$lib/server/database/queries/builders/keyset-cursor.builder.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { toUserId } from '$lib/shared/user-id.js';
import { addMemberByIdSchema } from '$lib/schemas/playlists.js';
import { Logger } from '$lib/server/utils/logger.js';
import { membersListResponseSchema, memberAddedResponseSchema } from '$lib/schemas/playlists';
import { apiUrl } from '$lib/shared/api-urls.js';

const MembersGetQuerySchema = z.object({
    limit: z.coerce.number().int().optional().meta({ description: 'Page size' }),
    offset: z.coerce
        .number()
        .int()
        .optional()
        .meta({ description: 'Page offset (ignored when cursor is present)' }),
    cursor: z.string().optional().meta({
        description:
            'Opaque keyset cursor over (status, invited_at, user_id). Returned as page.nextCursor on a previous response; when present, offset is ignored and page.total is omitted.',
    }),
});

const logger = Logger.for('PlaylistMembersDef');

// ---------------------------------------------------------------------------
// Per-feed keyset cursor codec. Wraps the shared builder with feed tags so a
// cursor minted for another feed cannot be decoded-and-run here. The members
// sort key is the compound `(status ASC, invited_at DESC NULLS FIRST,
// user_id DESC)`; the tag carries BOTH the status group and the Gate D2b
// null-ness of invited_at, while the shared (ts:id) slots carry the invited_at
// value (micro-precision text) and the user_id tiebreak.
//   'ma:'/'mp:' — accepted/pending, invited_at present (value group)
//   'mA:'/'mP:' — accepted/pending, invited_at IS NULL (NULLS-FIRST group)
// In the NULL case the ts slot is unused; a '-' placeholder keeps the shape.
// ---------------------------------------------------------------------------

const MEMBERS_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeMembersCursor(cursor: PlaylistMembersCursor): string {
    const tag =
        cursor.status === 'accepted'
            ? cursor.invitedAt === null
                ? 'mA:'
                : 'ma:'
            : cursor.invitedAt === null
              ? 'mP:'
              : 'mp:';
    return tag + encodeKeysetCursor({ ts: cursor.invitedAt ?? '-', id: cursor.userId });
}

function decodeMembersCursor(raw: string): PlaylistMembersCursor | null {
    let status: 'accepted' | 'pending';
    let isNull: boolean;
    if (raw.startsWith('ma:')) {
        status = 'accepted';
        isNull = false;
    } else if (raw.startsWith('mA:')) {
        status = 'accepted';
        isNull = true;
    } else if (raw.startsWith('mp:')) {
        status = 'pending';
        isNull = false;
    } else if (raw.startsWith('mP:')) {
        status = 'pending';
        isNull = true;
    } else {
        return null; // untagged or a different feed's cursor
    }
    const core = decodeKeysetCursor(raw.slice(3));
    if (!core) return null;
    // Validate both halves before they reach Postgres — a decodable-but-bogus
    // cursor would otherwise 500 (22007 / 22P02) instead of a clean 422.
    if (!MEMBERS_UUID_RE.test(core.id)) return null;
    if (isNull) return { status, invitedAt: null, userId: core.id };
    if (Number.isNaN(Date.parse(core.ts))) return null;
    return { status, invitedAt: core.ts, userId: core.id };
}

/** Map a member row to the wire shape (shared by offset and cursor paths). */
async function mapMembers(
    rows: PlaylistMemberRow[],
    surface: ApiSurface,
): Promise<PlaylistMember[]> {
    const authors = await loadPublicAuthors(
        rows.map((row) => row.user_id),
        surface,
    );
    return rows.map((row) => ({
        author: authorOrPlaceholder(authors, row.user_id, surface),
        role: row.role,
        status: row.status,
        invitedAt: row.invited_at instanceof Date ? row.invited_at.toISOString() : row.invited_at,
    }));
}

/** Mint the next-page cursor from the last row of a page (Gate J1 / cursor mode). */
function nextMembersCursor(row: PlaylistMemberRow): string {
    return encodeMembersCursor({
        status: row.status,
        invitedAt: row.invited_at_cursor ?? null,
        userId: row.user_id,
    });
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/**
 * GET /playlists/{id}/members query schema.
 *
 * `limit`/`offset` are parsed by parsePagination() in the handler; we declare
 * them here so the contract layer coerces/strips them before the handler runs.
 */
const MembersGetQuery = z.object({
    // Coercion only; parsePagination() clamps in the handler.
    limit: z.coerce.number().int().optional(),
    offset: z.coerce.number().int().optional(),
    // Opt-in keyset cursor; when present, offset is ignored.
    cursor: z.string().optional(),
});

/**
 * POST /playlists/{id}/members body schema.
 *
 * Mirrors addMemberByIdSchema — lenient, no .strict().
 * `userId` is a UUID; `role` is editor|readonly.
 */
const MembersPostBody = z.object({
    userId: z.string().guid(),
    role: z.enum(['editor', 'readonly']),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Playlists'],
            summary: 'List playlist members',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns the members of the playlist and their roles. Supports ?limit/?offset paging; opt into stable keyset paging with ?cursor (from a previous response’s page.nextCursor), which ignores offset and omits page.total.',
            query: MembersGetQuerySchema,
            responses: {
                200: { schema: membersListResponseSchema, description: 'Playlist members' },
                401: 'Authentication required',
                403: 'Playlist is private and you are not the owner',
                404: 'Playlist not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Playlists'],
            summary: 'Invite a member to the playlist',
            stability: 'stable',
            auth: 'bearer',
            description: 'Invites a user (by user ID) to the playlist. Owner-only.',
            body: addMemberByIdSchema,
            responses: {
                201: { schema: memberAddedResponseSchema, description: 'Member invited' },
                400: 'Validation error or user already invited',
                401: 'Authentication required',
                403: 'Not the playlist owner',
                404: 'Playlist or user not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'feature', flag: 'playlists', then: { kind: 'user' } },
    request: {
        // query applies to GET; body applies to POST (mount() skips body on GET).
        query: MembersGetQuery,
        queryMethods: ['GET'],
        body: MembersPostBody,
    },
    handlers: {
        /**
         * GET /playlists/{id}/members
         * List all members of a playlist (owner only).
         *
         * Response: { items: PlaylistMember[], page: PageBlock }
         * Members are keyed by users.id UUID (Q8 — username is display-only).
         */
        GET: async (event, ctx) => {
            const username =
                event.locals.principal?.username ?? event.locals.user?.username ?? null;
            if (!username) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rawId = event.params.id;
            const playlistId = rawId ? Number.parseInt(rawId, 10) : Number.NaN;
            if (Number.isNaN(playlistId) || playlistId <= 0) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a positive integer' },
                ]);
            }

            const { role, isSystem } = await getUserRole(sql, playlistId, username);
            if (!canManageMembers(role)) {
                return ApiProblem.forbidden('Only the owner can view members');
            }
            if (isSystem) {
                return ApiProblem.conflict('This playlist does not support that operation');
            }

            const { limit, offset } = parsePagination(event.url, {
                defaultLimit: 100,
                maxLimit: 500,
            });

            const cursorParam = event.url.searchParams.get('cursor') ?? undefined;
            if (cursorParam) {
                // Cursor mode (Gate C): ignore offset, drop total, keep
                // items/hasMore/limit. n+1 lookahead drives hasMore.
                const decoded = decodeMembersCursor(cursorParam);
                if (!decoded) return ApiProblem.validationFailed('Invalid cursor');

                const rows = await getPlaylistMembers(sql, playlistId, {
                    mode: 'cursor',
                    cursor: decoded,
                    limit,
                });
                const hasMore = rows.length > limit;
                const pageRows = rows.slice(0, limit);
                const items = await mapMembers(pageRows, ctx.surface);
                const pageBlock: PageBlock = { limit, hasMore };
                if (hasMore && pageRows.length > 0) {
                    pageBlock.nextCursor = nextMembersCursor(pageRows[pageRows.length - 1]);
                }
                return json(paginate(items, pageBlock));
            }

            // Offset mode — byte-identical to the historical response, plus a
            // Gate J1 bootstrap `page.nextCursor` when there is a next page.
            const allMembers = await getPlaylistMembers(sql, playlistId);

            const page = allMembers.slice(offset, offset + limit);
            const items = await mapMembers(page, ctx.surface);
            const hasMore = offset + limit < allMembers.length;
            const pageBlock: PageBlock = { limit, offset, hasMore };
            if (hasMore && page.length > 0) {
                pageBlock.nextCursor = nextMembersCursor(page[page.length - 1]);
            }
            return json(paginate(items, pageBlock));
        },

        /**
         * POST /playlists/{id}/members
         * Invite a user to a playlist (owner only).
         *
         * v1 body: { userId: UUID, role: 'editor'|'readonly' }
         * Response: 201 + bare member object.
         *
         * Q8: invitee is identified by their stable users.id UUID, not username.
         */
        POST: async (event, ctx) => {
            const username =
                event.locals.principal?.username ?? event.locals.user?.username ?? null;
            if (!username) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rawId = event.params.id;
            const playlistId = rawId ? Number.parseInt(rawId, 10) : Number.NaN;
            if (Number.isNaN(playlistId) || playlistId <= 0) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a positive integer' },
                ]);
            }

            const {
                role: callerRole,
                userId: ownerUserId,
                isSystem,
            } = await getUserRole(sql, playlistId, username);
            if (!canManageMembers(callerRole)) {
                return ApiProblem.forbidden('Only the owner can invite members');
            }
            if (isSystem) {
                return ApiProblem.conflict('This playlist does not support that operation');
            }

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsed = addMemberByIdSchema.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }

            const { userId: inviteeId, role: inviteRole } = parsed.data;

            // Guard: cannot invite yourself
            if (ownerUserId && String(ownerUserId) === inviteeId) {
                return ApiProblem.validationFailed([
                    { field: 'userId', message: 'Cannot invite yourself' },
                ]);
            }

            // Verify the invitee exists before inserting to avoid FK constraint errors
            const inviteeUser = await getUserById(sql, inviteeId);
            if (!inviteeUser) {
                return ApiProblem.notFound('User not found');
            }

            const inviteeUserId = toUserId(inviteeId);
            const member = await inviteMember(sql, playlistId, inviteeUserId, inviteRole);

            logger.info('Invite sent to user', {
                playlistId,
                invitedUserId: inviteeId,
                role: inviteRole,
                invitedBy: username,
            });

            const headers = new Headers({
                Location: apiUrl(ctx.surface, `/playlists/${playlistId}/members/${inviteeId}`),
            });
            return json((await mapMembers([member], ctx.surface))[0], { status: 201, headers });
        },
    },
});
