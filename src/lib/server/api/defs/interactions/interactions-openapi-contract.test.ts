// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression tests — OpenAPI contract fidelity for the shared comment/reaction
 * handlers in `handlers.ts`.
 *
 * These tests call the real handlers (with all DB I/O mocked, following the
 * pattern in `interactions-authz.test.ts`) and validate the resulting response
 * shape against the Zod schemas declared in the colocated `_openapi.ts` files
 * for all three resource families (media, people, playlists). This catches
 * drift between what the handler actually sends and what the OpenAPI spec
 * (generated from these files) documents — the kind of drift that breaks
 * strict client decoders (e.g. tvOS Swift).
 *
 * Verified invariants:
 *   1. Reactions GET responds `{items:[{emoji,count,reactedByMe}]}` — matches
 *      the documented `ReactionsResponseSchema` for media/people/playlists.
 *   2. Reactions POST accepts an `{emoji}` body, DELETE takes `?emoji=`, both respond 204 with no
 *      body — matches the documented request/response contract.
 *   3. Comments GET `page` block omits `offset` (paginate() never sets it) —
 *      the documented `CommentsResponseSchema.page` must accept that.
 *   4. POST /people/{id}/comments response includes `userId`, `username`,
 *      `updatedAt` — the documented `PostResponseSchema` must declare them.
 *
 * All external I/O is mocked — no real DB required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ResponseDef } from '$lib/server/openapi';
import type { ApiContext } from '$lib/server/api/define.js';
import { z } from 'zod';

// ── Module mocks (must be hoisted before any imports that need them) ──────────

vi.mock('$lib/server/utils/public-author.js', () => ({
    authorOrPlaceholder: (authors: Map<string, unknown>, userId: string) =>
        authors.get(userId) ?? {
            userId,
            displayName: null,
            images: { primary: { href: `/avatar/${userId}`, revision: '0', source: 'self' } },
        },
    loadPublicAuthors: async (ids: string[]) =>
        new Map(
            ids.map((userId) => [
                userId,
                {
                    userId,
                    displayName: null,
                    images: {
                        primary: { href: `/avatar/${userId}`, revision: '0', source: 'self' },
                    },
                },
            ]),
        ),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockSql,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: vi.fn().mockResolvedValue('550e8400-e29b-41d4-a716-446655440000'),
}));

// getUserRole — controls the playlist membership gate. Always allow.
vi.mock('$lib/server/utils/playlist-utils.js', () => ({
    getUserRole: vi.fn().mockResolvedValue({ role: 'editor', visibility: 'private' }),
}));

// checkMediaAccess — controls the media library/age gate. Always allow.
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
}));

const mockListComments = vi.fn().mockResolvedValue([]);
const mockInsertComment = vi.fn().mockResolvedValue({
    id: 'comment-1',
    user_id: '550e8400-e29b-41d4-a716-446655440000',
    username: 'alice',
    body: 'hello',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
});
const mockListReactions = vi
    .fn()
    .mockResolvedValue([{ emoji: '👍', count: 2, reacted_by_me: true }]);
const mockUpsertReaction = vi.fn().mockResolvedValue(undefined);
const mockDeleteReaction = vi.fn().mockResolvedValue(undefined);

vi.mock('$lib/server/database/queries/interactions.queries.js', () => ({
    listComments: (...args: unknown[]) => mockListComments(...args),
    insertComment: (...args: unknown[]) => mockInsertComment(...args),
    getCommentOwner: vi.fn(),
    softDeleteComment: vi.fn(),
    listReactions: (...args: unknown[]) => mockListReactions(...args),
    upsertReaction: (...args: unknown[]) => mockUpsertReaction(...args),
    deleteReaction: (...args: unknown[]) => mockDeleteReaction(...args),
}));

const mockSql = {};

// ── Import defs + OpenAPI route metadata AFTER mocks ──────────────────────────

const { def: mediaCommentsDef } = await import('$lib/server/api/defs/media/[id]/comments/index.js');
const { def: mediaReactionsDef } =
    await import('$lib/server/api/defs/media/[id]/reactions/index.js');
const { def: peopleCommentsDef } =
    await import('$lib/server/api/defs/people/[id]/comments/index.js');
const { def: peopleReactionsDef } =
    await import('$lib/server/api/defs/people/[id]/reactions/index.js');
const { def: playlistCommentsDef } =
    await import('$lib/server/api/defs/playlists/[id]/comments/index.js');
const { def: playlistReactionsDef } =
    await import('$lib/server/api/defs/playlists/[id]/reactions/index.js');

// Route OpenAPI metadata migrated onto each def as `def.docs` (factory routes:
// the make*Def factories now accept a `docs` argument set by their def files).
const mediaReactionsRoute = mediaReactionsDef.docs!;
const peopleReactionsRoute = peopleReactionsDef.docs!;
const playlistReactionsRoute = playlistReactionsDef.docs!;
const mediaCommentsRoute = mediaCommentsDef.docs!;
const peopleCommentsRoute = peopleCommentsDef.docs!;
const playlistCommentsRoute = playlistCommentsDef.docs!;

// ── Helpers ───────────────────────────────────────────────────────────────────

const MEDIA_UUID = '550e8400-e29b-41d4-a716-446655440000';
const PERSON_ID = '77';
const PLAYLIST_ID = '42';

function makeEvent(
    method: string,
    url: string,
    params: Record<string, string>,
    body?: unknown,
    username = 'alice',
): Partial<RequestEvent> {
    return {
        request: new Request(url, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        }),
        url: new URL(url),
        params,
        locals: {
            principal: { username, isAdmin: false },
            user: { username, isAdmin: false },
        } as unknown as RequestEvent['locals'],
    };
}

/** Narrow a `ResponseDef` to its `{schema}` variant, failing loudly otherwise. */
function schemaOf(def: ResponseDef): z.ZodType {
    if (typeof def === 'string' || !('schema' in def)) {
        throw new Error('Expected a { schema } response definition');
    }
    return def.schema;
}

const ctx: ApiContext = {
    surface: 'v1',
};

// ── 1 & 2: Reactions shape (GET items[], PUT/DELETE {emoji} + 204) ───────────

describe.each([
    {
        label: 'media',
        def: mediaReactionsDef,
        route: mediaReactionsRoute,
        params: { id: MEDIA_UUID },
        base: `/api/v1/media/${MEDIA_UUID}/reactions`,
    },
    {
        label: 'people',
        def: peopleReactionsDef,
        route: peopleReactionsRoute,
        params: { id: PERSON_ID },
        base: `/api/v1/people/${PERSON_ID}/reactions`,
    },
    {
        label: 'playlists',
        def: playlistReactionsDef,
        route: playlistReactionsRoute,
        params: { id: PLAYLIST_ID },
        base: `/api/v1/playlists/${PLAYLIST_ID}/reactions`,
    },
])('reactions OpenAPI contract — $label', ({ def, route, params, base }) => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockListReactions.mockResolvedValue([{ emoji: '👍', count: 2, reacted_by_me: true }]);
        mockUpsertReaction.mockResolvedValue(undefined);
        mockDeleteReaction.mockResolvedValue(undefined);
    });

    it('GET response matches the documented ReactionsResponseSchema (items[])', async () => {
        const event = makeEvent('GET', `http://localhost${base}`, params);
        const res = (await def.handlers.GET!(event as RequestEvent, ctx)) as Response;
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body).toEqual({ items: [{ emoji: '👍', count: 2, reactedByMe: true }] });

        const schema = schemaOf(route.GET!.responses[200]);
        const result = schema.safeParse(body);
        expect(result.success).toBe(true);
    });

    it('PUT accepts a documented {emoji} body and responds 204 with no body', async () => {
        const requestBody = { emoji: '👍' };

        // The documented request body schema must accept the real payload
        // (previously it declared `{ type }`, which the handler never reads).
        const bodySchema = route.PUT!.body;
        expect(bodySchema).toBeDefined();
        expect(bodySchema!.safeParse(requestBody).success).toBe(true);

        const event = makeEvent('PUT', `http://localhost${base}`, params, requestBody);
        const res = (await def.handlers.PUT!(event as RequestEvent, ctx)) as Response;

        expect(res.status).toBe(204);
        expect(await res.text()).toBe('');

        // 204 must be documented, and must NOT carry a response body schema.
        expect(route.PUT!.responses[204]).toBeDefined();
        expect(typeof route.PUT!.responses[204]).toBe('string');
    });

    it('DELETE takes the emoji as a documented query parameter and responds 204', async () => {
        const query = { emoji: '👍' };

        expect(route.DELETE!.body).toBeUndefined();
        const querySchema = route.DELETE!.query;
        expect(querySchema).toBeDefined();
        expect(querySchema!.safeParse(query).success).toBe(true);
        expect(querySchema!.safeParse({}).success).toBe(false);

        const event = makeEvent(
            'DELETE',
            `http://localhost${base}?emoji=${encodeURIComponent(query.emoji)}`,
            params,
        );
        const res = (await def.handlers.DELETE!(
            event as RequestEvent,
            {
                ...ctx,
                input: { query },
            } as unknown as ApiContext,
        )) as Response;

        expect(res.status).toBe(204);
        expect(await res.text()).toBe('');

        expect(route.DELETE!.responses[204]).toBeDefined();
        expect(typeof route.DELETE!.responses[204]).toBe('string');
    });
});

// ── 3: Comments pagination — `page.offset` must be optional ───────────────────

describe.each([
    {
        label: 'media',
        def: mediaCommentsDef,
        route: mediaCommentsRoute,
        params: { id: MEDIA_UUID },
        base: `/api/v1/media/${MEDIA_UUID}/comments`,
    },
    {
        label: 'people',
        def: peopleCommentsDef,
        route: peopleCommentsRoute,
        params: { id: PERSON_ID },
        base: `/api/v1/people/${PERSON_ID}/comments`,
    },
    {
        label: 'playlists',
        def: playlistCommentsDef,
        route: playlistCommentsRoute,
        params: { id: PLAYLIST_ID },
        base: `/api/v1/playlists/${PLAYLIST_ID}/comments`,
    },
])('comments OpenAPI contract — $label', ({ def, route, params, base }) => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockListComments.mockResolvedValue([]);
    });

    it('GET response page block has no `offset` and still matches the documented schema', async () => {
        const event = makeEvent('GET', `http://localhost${base}`, params);
        const res = (await def.handlers.GET!(event as RequestEvent, ctx)) as Response;
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.page).toEqual({ limit: 50, hasMore: false });
        expect(body.page.offset).toBeUndefined();

        const schema = schemaOf(route.GET!.responses[200]);
        const result = schema.safeParse(body);
        expect(result.success).toBe(true);
    });
});

// ── 4: POST /people/{id}/comments response fields ──────────────────────────────

describe('POST /people/{id}/comments — OpenAPI response fields', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockInsertComment.mockResolvedValue({
            id: 'comment-1',
            user_id: '550e8400-e29b-41d4-a716-446655440000',
            username: 'alice',
            body: 'hello',
            created_at: new Date('2026-01-01T00:00:00.000Z'),
            updated_at: new Date('2026-01-01T00:00:00.000Z'),
        });
    });

    it('handler response includes userId, username, and updatedAt', async () => {
        const event = makeEvent(
            'POST',
            `http://localhost/api/v1/people/${PERSON_ID}/comments`,
            { id: PERSON_ID },
            { body: 'hello' },
        );
        const res = (await peopleCommentsDef.handlers.POST!(
            event as RequestEvent,
            ctx,
        )) as Response;
        expect(res.status).toBe(201);

        const body = await res.json();
        expect(body).toEqual({
            id: 'comment-1',
            author: {
                userId: '550e8400-e29b-41d4-a716-446655440000',
                displayName: null,
                images: {
                    primary: {
                        href: '/avatar/550e8400-e29b-41d4-a716-446655440000',
                        revision: '0',
                        source: 'self',
                    },
                },
            },
            body: 'hello',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        });

        // The documented schema must declare every field the handler actually
        // sends — `.strict()` rejects any field present in the real response
        // but absent from the schema (previously: userId, username, updatedAt).
        const schema = schemaOf(peopleCommentsRoute.POST!.responses[201]) as z.ZodObject;
        const strictResult = schema.strict().safeParse(body);
        expect(strictResult.success).toBe(true);
    });
});
