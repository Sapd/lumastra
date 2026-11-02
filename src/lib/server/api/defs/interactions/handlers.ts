// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * handlers.ts — shared handler factories for the comment/reaction sub-resources.
 *
 * Each resource type (media, playlists, people) mounts comments and reactions at:
 *   GET/POST  /{resource}/{id}/comments
 *   DELETE    /{resource}/{id}/comments/{commentId}
 *   GET/PUT/DELETE  /{resource}/{id}/reactions
 *
 * The HTTP semantics are identical across resource types; only the `targetType`
 * discriminator differs.
 *
 * ## Resource-level access gate
 *
 * Every factory accepts an optional `resolveAccess` callback. When provided the
 * callback is invoked BEFORE the operation is performed and may return a Response
 * (to deny) or `null` (to allow). This enforces resource-level authorisation so
 * that a caller cannot read or write comments/reactions on a target they are not
 * permitted to access (e.g. a private playlist they are not a member of).
 *
 * The callback signature is:
 *   resolveAccess(sql, targetId, event, op) → Promise<Response | null>
 *
 * Where `op` is `'read'` or `'write'` (the comment-by-id DELETE handler uses
 * `'read'` because it performs its own author/admin check after the resource gate).
 *
 * Consumers that do not supply `resolveAccess` have NO resource-level gate (only
 * the generic `{kind:'user'}` auth check) — this is intentional for person pages,
 * which are publicly readable and whose write path is already gated by auth.
 *
 * Usage in a def file:
 *   export const def = makeCommentsDef('media', myAccessGate);
 *   export const def = makeCommentByIdDef('playlist', myAccessGate);
 *   export const def = makeReactionsDef('person');
 */

import { publicAuthorSchema } from '$lib/schemas/public-author.js';
import { authorOrPlaceholder, loadPublicAuthors } from '$lib/server/utils/public-author.js';
import type { PublicAuthor } from '$lib/schemas/public-author.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { getDb } from '$lib/server/database/connection.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import {
    listComments,
    insertComment,
    getCommentOwner,
    softDeleteComment,
    listReactions,
    upsertReaction,
    deleteReaction,
    type InteractionTargetType,
    type CommentsCursor,
} from '$lib/server/database/queries/interactions.queries.js';
import {
    encodeKeysetCursor,
    decodeKeysetCursor,
} from '$lib/server/database/queries/builders/keyset-cursor.builder.js';
import { parsePersonHandle } from '$lib/shared/person-handle.js';
import type { RequestEvent } from '@sveltejs/kit';
import type { RouteMetadata } from '$lib/server/openapi';
import { Logger } from '$lib/server/utils/logger.js';
import type postgres from 'postgres';
import { apiUrl } from '$lib/shared/api-urls.js';

// ---------------------------------------------------------------------------
// Request schemas (shared across all interaction def factories)
// ---------------------------------------------------------------------------

/**
 * GET /{resource}/{id}/comments query schema.
 * All fields optional — handlers apply their own defaults / clamping on top.
 */
const CommentsQuerySchema = z.object({
    // Coercion only; parsePagination() clamps in the handler.
    limit: z.coerce.number().int().optional(),
    since: z.string().optional(),
    // Opt-in keyset cursor (E2). Present → keyset paging over
    // (created_at DESC, id DESC); incompatible with since.
    cursor: z.string().optional(),
});

/**
 * POST /{resource}/{id}/comments body schema.
 *
 * `body` must be a non-empty string. Length ceiling matches MAX_BODY_LENGTH (10 000).
 * Strip, not strict — extra fields are silently dropped.
 */
const CommentBodySchema = z.object({
    body: z.string().min(1).max(10_000),
});

/**
 * PUT /{resource}/{id}/reactions body schema.
 *
 * `emoji` is validated as a non-empty string; the handler also applies the
 * regex emoji-pattern check, so this schema stays intentionally lenient.
 */
const ReactionBodySchema = z.object({
    emoji: z.string().min(1),
});

/**
 * DELETE /{resource}/{id}/reactions query schema. A caller can hold several
 * emoji on one target, so the emoji names which reaction to remove.
 */
const ReactionQuerySchema = z.object({
    emoji: z.string().min(1),
});

// ── Access gate type ──────────────────────────────────────────────────────────

/**
 * Resource-level access gate callback.
 *
 * Called before each handler performs any work. Return `null` to allow the
 * request to proceed; return a `Response` to short-circuit with that denial
 * (typically a 404 to avoid leaking the existence of private resources).
 *
 * @param sql      - Active postgres connection (from getDb()).
 * @param targetId - The `{id}` path param identifying the target resource.
 * @param event    - The full SvelteKit RequestEvent (gives access to locals,
 *                   params, URL, etc.).
 * @param op       - `'read'` for GET; `'write'` for POST/DELETE mutations.
 */
export type AccessGateFn = (
    sql: postgres.Sql,
    targetId: string,
    event: RequestEvent,
    op: 'read' | 'write',
) => Promise<Response | null>;

// ── Constants ─────────────────────────────────────────────────────────────────

/** Rough emoji pattern — at least one Unicode Emoji scalar value. */
const EMOJI_PATTERN = /^\p{Emoji}/u;
const MAX_BODY_LENGTH = 10_000;
const DEFAULT_COMMENT_LIMIT = 50;
const MAX_COMMENT_LIMIT = 200;

/**
 * Write rate limits, per user, across every target type.
 *
 * There was no limit at all before this: a script holding one session could
 * post 10,000-character comments on every media item in the library as fast as
 * the DB would accept them, and there is no moderation queue, no reporting and
 * no bulk-delete to clean up after it. The shoutbox plugin — a much smaller
 * feature — has had an atomic per-window limit all along; this brings the
 * first-party endpoints up to the same floor.
 *
 * Comments are limited harder than reactions because they cost more to undo: a
 * reaction is one row keyed by (user, target, emoji) and toggling is the normal
 * interaction pattern, whereas every comment is a distinct row a human has to
 * read to remove.
 *
 * Deliberately NOT keyed by target. The limit exists to bound how much a single
 * account can produce overall; per-target keys would let one user post the same
 * flood across a thousand items and stay inside every bucket.
 */
const COMMENT_WRITE_LIMIT = 10;
const REACTION_WRITE_LIMIT = 60;
const WRITE_LIMIT_WINDOW_S = 60;

/**
 * Shared guard for the comment/reaction write paths.
 *
 * Returns a 429 problem response when the caller is over budget, or null to
 * proceed — matching the `AccessGateFn` convention already used in this module,
 * so call sites stay one line.
 */
async function checkWriteRateLimit(
    kind: 'comment' | 'reaction',
    userId: string,
    limit: number,
): Promise<Response | null> {
    const rl = await checkRateLimit(`interactions:${kind}:${userId}`, limit, WRITE_LIMIT_WINDOW_S);
    if (rl.allowed) return null;
    return ApiProblem.rateLimited(Math.max(1, Math.ceil(rl.resetAt - Date.now() / 1000)));
}

// ── Shared helpers ────────────────────────────────────────────────────────────

const logger = Logger.for('InteractionHandlers');

// ── Opt-in keyset cursor (E2) ─────────────────────────────────────────────────
// Per-feed 'ic:' tag (F9c) so a cursor minted for another feed cannot
// decode-and-run here. `created_at` (timestamptz) is carried as exact ::text
// (micro precision) via the shared codec; `id` is the bigint tiebreak. Ordering:
// (created_at DESC, id DESC).
const COMMENTS_CURSOR_TAG = 'ic:';
const COMMENT_ID_RE = /^\d+$/;
// Postgres timestamptz ::text, e.g. "2026-07-23 01:02:03.123456+00".
const COMMENT_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?(:\d{2})?$/;

function encodeCommentsCursor(cursor: CommentsCursor): string {
    return COMMENTS_CURSOR_TAG + encodeKeysetCursor({ ts: cursor.createdAt, id: cursor.id });
}

function decodeCommentsCursor(raw: string): CommentsCursor | null {
    if (!raw.startsWith(COMMENTS_CURSOR_TAG)) return null; // untagged / other feed
    const core = decodeKeysetCursor(raw.slice(COMMENTS_CURSOR_TAG.length));
    if (!core) return null;
    // Validate both halves before they reach Postgres (a bogus value would 500
    // as 22P02 instead of a clean 422).
    if (!COMMENT_ID_RE.test(core.id)) return null;
    if (!COMMENT_TS_RE.test(core.ts)) return null;
    return { createdAt: core.ts, id: core.id };
}

function resolveUsername(event: RequestEvent): string | null {
    return event.locals.principal?.username ?? event.locals.user?.username ?? null;
}

/** Extract the `{id}` path param from the event (non-empty check only). */
function resolveTargetId(event: RequestEvent, targetType: string): string | null {
    const raw = event.params.id ?? '';
    if (targetType === 'person') {
        const parsed = parsePersonHandle(raw);
        return parsed.ok ? parsed.handle : null;
    }
    return raw.length > 0 ? raw : null;
}

/** Extract the `{commentId}` path param from the event. */
function resolveCommentId(event: RequestEvent): string | null {
    const raw = event.params.commentId ?? '';
    return raw.length > 0 ? raw : null;
}

function serializeComment(
    r: {
        id: string;
        user_id: string;
        username: string;
        body: string;
        created_at: Date | string;
        updated_at: Date | string;
    },
    author: PublicAuthor,
) {
    return {
        id: r.id,
        author,
        body: r.body,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    };
}

// ── Comments collection def factory ──────────────────────────────────────────

/**
 * Build an EndpointDef for GET /POST /{resource}/{id}/comments.
 *
 * GET  — list comments (paginated, cursor via `?cursor`/`?since`).
 * POST — post a new comment; responds 201 + created comment object.
 *
 * @param targetType   - The interaction target discriminator ('media' | 'playlist' | 'person').
 * @param resolveAccess - Optional resource-level access gate. When provided it is
 *   called before any DB work — return null to allow, or a Response to deny.
 *   See the `AccessGateFn` type for full semantics.
 */
export function makeCommentsDef(
    targetType: InteractionTargetType,
    resolveAccess?: AccessGateFn,
    docs?: RouteMetadata,
) {
    const commentSchema = z.object({
        id: z.string(),
        author: publicAuthorSchema,
        body: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
    });
    const commentDocs = docs
        ? {
              ...docs,
              ...(docs.GET
                  ? {
                        GET: {
                            ...docs.GET,
                            description: `${docs.GET.description ?? ''} Use cursor to page older history or since to poll newer comments. Combining cursor and since returns 422; before is not supported.`,
                            responses: {
                                ...docs.GET.responses,
                                422: 'Invalid cursor, retired before, or cursor combined with since',
                                200: {
                                    schema: z.object({
                                        items: z.array(commentSchema),
                                        page: z.object({
                                            limit: z.number().int(),
                                            hasMore: z.boolean(),
                                            nextCursor: z.string().optional(),
                                        }),
                                    }),
                                    description: 'Comments',
                                },
                            },
                        },
                    }
                  : {}),
              ...(docs.POST
                  ? {
                        POST: {
                            ...docs.POST,
                            responses: {
                                ...docs.POST.responses,
                                201: { schema: commentSchema, description: 'Comment created' },
                            },
                        },
                    }
                  : {}),
          }
        : undefined;
    return defineEndpoint({
        // Feature-gated: these endpoints previously had no flag, so an operator
        // could not turn comments off at all. Off by default — see
        // config.ts's FEATURE_COMMENTS. Feature-off yields 404, not 403.
        auth: { kind: 'feature', flag: 'comments', then: { kind: 'user' } },
        docs: commentDocs,
        request: {
            // Applied to the whole def — mount() skips body validation on GET.
            // query applies to GET; body applies to POST.
            body: CommentBodySchema,
            query: CommentsQuerySchema,
            queryMethods: ['GET'],
        },
        handlers: {
            /**
             * GET /{resource}/{id}/comments
             *
             * Query params:
             *   ?limit=50        — page size (max 200)
             *   ?cursor={token}  — return older comments
             *   ?since={id}      — return comments newer than this id (ASC poll)
             *
             * Response: { items: Comment[], page: { limit, hasMore } }
             */
            GET: async (event, ctx) => {
                const targetId = resolveTargetId(event, targetType);
                if (!targetId) return ApiProblem.validationFailed('Missing resource id');

                const sql = getDb();
                if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

                // ── Resource-level access gate ──
                if (resolveAccess) {
                    const denial = await resolveAccess(sql, targetId, event, 'read');
                    if (denial) return denial;
                }

                const { limit } = parsePagination(event.url, {
                    defaultLimit: DEFAULT_COMMENT_LIMIT,
                    maxLimit: MAX_COMMENT_LIMIT,
                });
                if (event.url.searchParams.has('before'))
                    return ApiProblem.validationFailed('before is retired; use cursor');
                const since = event.url.searchParams.get('since') ?? undefined;
                const cursorParam = event.url.searchParams.get('cursor') ?? undefined;

                if (cursorParam !== undefined && since !== undefined) {
                    return ApiProblem.validationFailed('cursor and since cannot be combined');
                }

                // Opt-in keyset cursor (E2). Present → keyset mode over
                // (created_at DESC, id DESC); incompatible with since. 422 on a
                // malformed cursor rather than letting it reach ::timestamptz.
                let cursor: CommentsCursor | undefined;
                if (cursorParam) {
                    const decoded = decodeCommentsCursor(cursorParam);
                    if (!decoded) return ApiProblem.validationFailed('Invalid cursor');
                    cursor = decoded;
                }

                const rawRows = await listComments(sql, {
                    targetType,
                    targetId,
                    limit: limit + 1,
                    ...(cursor ? { cursor } : { since }),
                });

                const rows = rawRows.slice(0, limit);

                // `since` path → ASC (chronological); default/cursor →
                // DESC, reverse for display.
                const authors = await loadPublicAuthors(
                    rows.map((row) => row.user_id),
                    ctx.surface,
                );
                const items = (!cursor && since ? rows : rows.toReversed()).map((row) =>
                    serializeComment(row, authorOrPlaceholder(authors, row.user_id, ctx.surface)),
                );

                const hasMore = rawRows.length > limit;

                // nextCursor: minted from the OLDEST row in the DESC page (last
                // element) so the next request continues strictly older. Emitted
                // in cursor mode, and (Gate J1 bootstrap) on the default
                // first response too, except while polling newer comments with since.
                let nextCursor: string | undefined;
                if (hasMore && rows.length > 0 && !since) {
                    const oldest = rows[rows.length - 1];
                    if (oldest.created_at_cursor) {
                        nextCursor = encodeCommentsCursor({
                            createdAt: oldest.created_at_cursor,
                            id: oldest.id,
                        });
                    }
                }

                return json(
                    paginate(items, {
                        limit,
                        hasMore,
                        ...(nextCursor ? { nextCursor } : {}),
                    }),
                );
            },

            /**
             * POST /{resource}/{id}/comments
             *
             * Body: { body: string }
             * Response: 201 + created comment object + Location header.
             */
            POST: async (event, ctx) => {
                const username = resolveUsername(event);
                if (!username) return ApiProblem.unauthorized();

                const targetId = resolveTargetId(event, targetType);
                if (!targetId) return ApiProblem.validationFailed('Missing resource id');

                const sql = getDb();
                if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

                // ── Resource-level access gate ──
                if (resolveAccess) {
                    const denial = await resolveAccess(sql, targetId, event, 'write');
                    if (denial) return denial;
                }

                const userId = await getUserIdByUsername(sql, username);
                if (!userId) return ApiProblem.unauthorized();

                // After identity resolution so the budget is keyed to a real
                // user, and before the body is read so a flood costs the server
                // as little as possible.
                const limited = await checkWriteRateLimit(
                    'comment',
                    String(userId),
                    COMMENT_WRITE_LIMIT,
                );
                if (limited) return limited;

                let body: unknown;
                try {
                    body = await event.request.json();
                } catch {
                    return ApiProblem.validationFailed('Request body must be valid JSON');
                }

                if (typeof body !== 'object' || body === null || !('body' in body)) {
                    return ApiProblem.validationFailed('Body must be { body: string }');
                }

                const text = String((body as Record<string, unknown>).body ?? '').trim();
                if (text.length === 0) {
                    return ApiProblem.validationFailed([
                        { field: 'body', message: 'Comment body must not be empty' },
                    ]);
                }
                if (text.length > MAX_BODY_LENGTH) {
                    return ApiProblem.validationFailed([
                        {
                            field: 'body',
                            message: `Comment body must not exceed ${MAX_BODY_LENGTH} characters`,
                        },
                    ]);
                }

                const created = await insertComment(sql, {
                    targetType,
                    targetId,
                    userId: String(userId),
                    body: text,
                });

                logger.info('Comment posted', {
                    targetType,
                    targetId,
                    commentId: created.id,
                });

                // Build the Location path: map targetType → URL segment.
                const resourceSegment = targetType === 'person' ? 'people' : `${targetType}s`;
                const headers = new Headers({
                    Location: apiUrl(
                        ctx.surface,
                        `/${resourceSegment}/${targetId}/comments/${created.id}`,
                    ),
                });

                return json(
                    serializeComment(
                        created,
                        authorOrPlaceholder(
                            await loadPublicAuthors([created.user_id], ctx.surface),
                            created.user_id,
                            ctx.surface,
                        ),
                    ),
                    { status: 201, headers },
                );
            },
        },
    });
}

// ── Comment-by-ID def factory ─────────────────────────────────────────────────

/**
 * Build an EndpointDef for DELETE /{resource}/{id}/comments/{commentId}.
 *
 * Only the comment author or a server admin may delete.
 * Response: 204 No Content.
 *
 * @param targetType   - The interaction target discriminator.
 * @param resolveAccess - Optional resource-level access gate. When provided it is
 *   called with op='read' before the comment ownership check — return null to
 *   allow, or a Response to deny. A 404 here means the caller has no access to
 *   the parent resource (not just the comment), matching legacy route behaviour.
 */
export function makeCommentByIdDef(
    targetType: InteractionTargetType,
    resolveAccess?: AccessGateFn,
    docs?: RouteMetadata,
) {
    return defineEndpoint({
        // Feature-gated: these endpoints previously had no flag, so an operator
        // could not turn comments off at all. Off by default — see
        // config.ts's FEATURE_COMMENTS. Feature-off yields 404, not 403.
        auth: { kind: 'feature', flag: 'comments', then: { kind: 'user' } },
        docs,
        // No body contract needed — DELETE carries no request body.
        // Params ({id}/{commentId}) are validated ad-hoc inside the handler.
        handlers: {
            /**
             * DELETE /{resource}/{id}/comments/{commentId}
             */
            DELETE: async (event) => {
                const username = resolveUsername(event);
                if (!username) return ApiProblem.unauthorized();

                const targetId = resolveTargetId(event, targetType);
                if (!targetId) return ApiProblem.validationFailed('Missing resource id');

                const commentId = resolveCommentId(event);
                if (!commentId) return ApiProblem.validationFailed('Missing commentId');

                const sql = getDb();
                if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

                // ── Resource-level access gate ──
                // Use op='read' — the per-comment author/admin check below is the
                // write-level gate; the resource gate only checks parent visibility.
                if (resolveAccess) {
                    const denial = await resolveAccess(sql, targetId, event, 'read');
                    if (denial) return denial;
                }

                const userId = await getUserIdByUsername(sql, username);
                if (!userId) return ApiProblem.unauthorized();

                const comment = await getCommentOwner(sql, {
                    commentId,
                    targetType,
                    targetId,
                });
                if (!comment) return ApiProblem.notFound('Comment not found');

                const isAuthor = comment.user_id === String(userId);
                const isAdmin = event.locals.principal?.isAdmin === true;

                if (!isAuthor && !isAdmin) {
                    return ApiProblem.forbidden(
                        'Only the comment author or an admin can delete this comment',
                    );
                }

                await softDeleteComment(sql, { commentId, targetType, targetId });

                logger.info('Comment deleted', {
                    targetType,
                    targetId,
                    commentId,
                    deletedBy: username,
                    wasAuthor: isAuthor,
                });

                return new Response(null, { status: 204 });
            },
        },
    });
}

// ── Reactions def factory ─────────────────────────────────────────────────────

/**
 * Build an EndpointDef for GET/POST/DELETE /{resource}/{id}/reactions.
 *
 * Reactions are per-target (resource-level), not per comment.
 *
 * GET    — list aggregated reaction counts + caller's own reactions.
 * POST   — upsert a reaction (emoji); idempotent.
 * DELETE — remove the caller's reaction (emoji); idempotent.
 *
 * @param targetType   - The interaction target discriminator.
 * @param resolveAccess - Optional resource-level access gate. See `AccessGateFn`.
 */
export function makeReactionsDef(
    targetType: InteractionTargetType,
    resolveAccess?: AccessGateFn,
    docs?: RouteMetadata,
) {
    return defineEndpoint({
        // Feature-gated: these endpoints previously had no flag, so an operator
        // could not turn comments off at all. Off by default — see
        // config.ts's FEATURE_COMMENTS. Feature-off yields 404, not 403.
        auth: { kind: 'feature', flag: 'comments', then: { kind: 'user' } },
        docs,
        request: {
            // PUT carries { emoji } as its body; DELETE names it as ?emoji=.
            body: ReactionBodySchema,
            bodyMethods: ['PUT'],
            query: ReactionQuerySchema,
            queryMethods: ['DELETE'],
        },
        handlers: {
            /**
             * GET /{resource}/{id}/reactions
             *
             * Response: { items: Array<{ emoji, count, reactedByMe }> }
             */
            GET: async (event) => {
                const targetId = resolveTargetId(event, targetType);
                if (!targetId) return ApiProblem.validationFailed('Missing resource id');

                const sql = getDb();
                if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

                // ── Resource-level access gate ──
                if (resolveAccess) {
                    const denial = await resolveAccess(sql, targetId, event, 'read');
                    if (denial) return denial;
                }

                // Resolve the caller's userId for the reactedByMe flag — best-effort.
                const username = resolveUsername(event);
                let requestingUserId: string | null = null;
                if (username) {
                    const uid = await getUserIdByUsername(sql, username);
                    requestingUserId = uid ? String(uid) : null;
                }

                const rows = await listReactions(sql, {
                    targetType,
                    targetId,
                    requestingUserId,
                });

                return json({
                    items: rows.map((r) => ({
                        emoji: r.emoji,
                        count: Number(r.count),
                        reactedByMe: r.reacted_by_me,
                    })),
                });
            },

            /**
             * PUT /{resource}/{id}/reactions
             *
             * Body: { emoji: string }
             * Response: 204 No Content (idempotent upsert).
             */
            PUT: async (event) => {
                const username = resolveUsername(event);
                if (!username) return ApiProblem.unauthorized();

                const targetId = resolveTargetId(event, targetType);
                if (!targetId) return ApiProblem.validationFailed('Missing resource id');

                const sql = getDb();
                if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

                // ── Resource-level access gate ──
                if (resolveAccess) {
                    const denial = await resolveAccess(sql, targetId, event, 'write');
                    if (denial) return denial;
                }

                const userId = await getUserIdByUsername(sql, username);
                if (!userId) return ApiProblem.unauthorized();

                // Both add and remove share one budget: react/un-react is a
                // toggle, so limiting only the add half would leave half the
                // loop unbounded. The budget is much larger than the comment
                // one — toggling is normal use, and a reaction is one row keyed
                // by (user, target, emoji) that is cheap to undo.
                const limited = await checkWriteRateLimit(
                    'reaction',
                    String(userId),
                    REACTION_WRITE_LIMIT,
                );
                if (limited) return limited;

                let body: unknown;
                try {
                    body = await event.request.json();
                } catch {
                    return ApiProblem.validationFailed('Request body must be valid JSON');
                }

                if (typeof body !== 'object' || body === null || !('emoji' in body)) {
                    return ApiProblem.validationFailed('Body must be { emoji: string }');
                }

                const emoji = String((body as Record<string, unknown>).emoji ?? '').trim();
                if (emoji.length === 0 || !EMOJI_PATTERN.test(emoji)) {
                    return ApiProblem.validationFailed([
                        { field: 'emoji', message: 'emoji must be a single emoji character' },
                    ]);
                }

                await upsertReaction(sql, {
                    targetType,
                    targetId,
                    userId: String(userId),
                    emoji,
                });

                return new Response(null, { status: 204 });
            },

            /**
             * DELETE /{resource}/{id}/reactions?emoji=
             *
             * Response: 204 No Content (idempotent).
             */
            DELETE: async (event, ctx) => {
                const username = resolveUsername(event);
                if (!username) return ApiProblem.unauthorized();

                const targetId = resolveTargetId(event, targetType);
                if (!targetId) return ApiProblem.validationFailed('Missing resource id');

                const sql = getDb();
                if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

                // ── Resource-level access gate ──
                if (resolveAccess) {
                    const denial = await resolveAccess(sql, targetId, event, 'write');
                    if (denial) return denial;
                }

                const userId = await getUserIdByUsername(sql, username);
                if (!userId) return ApiProblem.unauthorized();

                // Both add and remove share one budget: react/un-react is a
                // toggle, so limiting only the add half would leave half the
                // loop unbounded. The budget is much larger than the comment
                // one — toggling is normal use, and a reaction is one row keyed
                // by (user, target, emoji) that is cheap to undo.
                const limited = await checkWriteRateLimit(
                    'reaction',
                    String(userId),
                    REACTION_WRITE_LIMIT,
                );
                if (limited) return limited;

                const emoji = (ctx.input?.query?.emoji ?? '').trim();
                if (emoji.length === 0) {
                    return ApiProblem.validationFailed([
                        { field: 'emoji', message: 'emoji must not be empty' },
                    ]);
                }

                await deleteReaction(sql, {
                    targetType,
                    targetId,
                    userId: String(userId),
                    emoji,
                });

                return new Response(null, { status: 204 });
            },
        },
    });
}

// Re-export for convenience
export type { InteractionTargetType };
