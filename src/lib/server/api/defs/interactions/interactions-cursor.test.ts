// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests — opt-in keyset cursor (E2) on the comments collection handler.
 *
 * Verifies:
 *   - the default (offset) response carries a J1 bootstrap `page.nextCursor` minted
 *     from the EXACT microsecond `created_at_cursor` (not `Date#toISOString`);
 *   - the offset path stays byte-identical when there is nothing more to page
 *     (no `cursor` field) and on the legacy before/since paths;
 *   - a `?cursor=` param selects the keyset branch (never before/since) and
 *     preserves the same chronological display order as the offset path (parity);
 *   - a malformed cursor is rejected with 422 before any DB call.
 *
 * All DB I/O is mocked — no real database required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import {
    encodeKeysetCursor,
    decodeKeysetCursor,
} from '$lib/server/database/queries/builders/keyset-cursor.builder.js';

// ── Module mocks (hoisted before the def import) ──────────────────────────────

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

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => mockSql }));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: vi.fn().mockResolvedValue('user-uuid-123'),
}));

const mockListComments = vi.fn();
vi.mock('$lib/server/database/queries/interactions.queries.js', () => ({
    listComments: (...args: unknown[]) => mockListComments(...args),
    insertComment: vi.fn(),
    getCommentOwner: vi.fn(),
    softDeleteComment: vi.fn(),
    listReactions: vi.fn(),
    upsertReaction: vi.fn(),
    deleteReaction: vi.fn(),
}));

const mockSql = {};

// ── Import the factory AFTER mocks ────────────────────────────────────────────

const { makeCommentsDef } = await import('$lib/server/api/defs/interactions/handlers.js');

// No resolveAccess → no resource-level gate, so GET runs straight through.
const def = makeCommentsDef('media');
const ctx: ApiContext = { surface: 'v1' };
const TARGET = '550e8400-e29b-41d4-a716-446655440000';

// A CommentRow as listComments returns it — `created_at_cursor` is the exact
// Postgres ::text rendering with microsecond precision.
function row(id: string, tsText: string) {
    const d = new Date(tsText.replace(' ', 'T').replace('+00', 'Z'));
    return {
        id,
        target_type: 'media',
        target_id: TARGET,
        user_id: 'u1',
        username: 'alice',
        body: `b${id}`,
        created_at: d,
        created_at_cursor: tsText,
        updated_at: d,
    };
}

function makeEvent(query = ''): Partial<RequestEvent> {
    const url = `http://localhost/api/v1/media/${TARGET}/comments${query}`;
    return {
        request: new Request(url, { method: 'GET' }),
        url: new URL(url),
        params: { id: TARGET },
        locals: {
            principal: { username: 'alice', isAdmin: false },
            user: { username: 'alice', isAdmin: false },
        } as unknown as RequestEvent['locals'],
    };
}

// Two comments, DESC (newest first) as listComments returns them.
const NEWER = row('200', '2026-07-23 01:00:00.500000+00');
const OLDER = row('100', '2026-07-23 00:00:00.250000+00');
const SENTINEL = row('50', '2026-07-22 00:00:00.000000+00');

describe('comments keyset cursor (E2)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('default response emits a J1 bootstrap cursor from the exact µs created_at_cursor', async () => {
        mockListComments.mockResolvedValue([NEWER, OLDER, SENTINEL]); // length === limit (2)

        const res = (await def.handlers.GET!(
            makeEvent('?limit=2') as RequestEvent,
            ctx,
        )) as Response;
        const body = await res.json();

        // Offset path unchanged: DESC rows reversed to chronological display.
        expect(body.items.map((c: { id: string }) => c.id)).toEqual(['100', '200']);
        expect(body.page.limit).toBe(2);
        expect(body.page.hasMore).toBe(true);

        // Bootstrap cursor is minted from the OLDEST row (id 100) and preserves
        // the microsecond timestamp exactly (never a Date round-trip).
        expect(typeof body.page.nextCursor).toBe('string');
        expect((body.page.nextCursor as string).startsWith('ic:')).toBe(true);
        const core = decodeKeysetCursor((body.page.nextCursor as string).slice(3));
        expect(core).toEqual({ ts: '2026-07-23 00:00:00.250000+00', id: '100' });
    });

    it('no cursor field when the page is not full (offset byte-identical)', async () => {
        mockListComments.mockResolvedValue([NEWER]); // length 1 < limit 2

        const res = (await def.handlers.GET!(
            makeEvent('?limit=2') as RequestEvent,
            ctx,
        )) as Response;
        const body = await res.json();

        expect(body.page).toEqual({ limit: 2, hasMore: false });
    });

    it('?cursor= selects the keyset branch (not before/since) with matching order', async () => {
        mockListComments.mockResolvedValue([NEWER, OLDER, SENTINEL]);
        const cursorStr =
            'ic:' + encodeKeysetCursor({ ts: '2026-07-23 02:00:00.000000+00', id: '999' });

        const res = (await def.handlers.GET!(
            makeEvent(`?limit=2&cursor=${encodeURIComponent(cursorStr)}`) as RequestEvent,
            ctx,
        )) as Response;
        expect(res.status).toBe(200);

        const arg = mockListComments.mock.calls[0][1] as Record<string, unknown>;
        expect(arg.cursor).toEqual({ createdAt: '2026-07-23 02:00:00.000000+00', id: '999' });
        expect(arg.before).toBeUndefined();
        expect(arg.since).toBeUndefined();

        const body = await res.json();
        // Cursor mode reverses to chronological, identical to the offset path.
        expect(body.items.map((c: { id: string }) => c.id)).toEqual(['100', '200']);
    });

    it('since polling has no older-history cursor', async () => {
        mockListComments.mockResolvedValue([NEWER, OLDER, SENTINEL]);

        const res = (await def.handlers.GET!(
            makeEvent('?limit=2&since=999') as RequestEvent,
            ctx,
        )) as Response;
        const body = await res.json();

        expect(body.page.nextCursor).toBeUndefined();
        expect(body.page).toEqual({ limit: 2, hasMore: true });
    });

    it('malformed cursor → 422 before any DB call', async () => {
        const res = (await def.handlers.GET!(
            makeEvent('?cursor=not-a-valid-cursor') as RequestEvent,
            ctx,
        )) as Response;

        expect(res.status).toBe(422);
        expect(mockListComments).not.toHaveBeenCalled();
    });
    it('rejects cursor plus since without querying comments', async () => {
        const res = await def.handlers.GET!(
            makeEvent('?cursor=anything&since=100') as RequestEvent,
            ctx,
        );
        expect(res.status).toBe(422);
        expect(mockListComments).not.toHaveBeenCalled();
    });

    it('rejects retired before continuation', async () => {
        const res = await def.handlers.GET!(makeEvent('?before=100') as RequestEvent, ctx);
        expect(res.status).toBe(422);
        expect(mockListComments).not.toHaveBeenCalled();
    });

    it('continues older pages using nextCursor without duplicate comments', async () => {
        const oldest = row('50', '2026-07-22 00:00:00.000000+00');
        mockListComments.mockImplementation(async (_sql, options) =>
            options.cursor ? [oldest] : [NEWER, OLDER, oldest],
        );
        const first = await (
            await def.handlers.GET!(makeEvent('?limit=2') as RequestEvent, ctx)
        ).json();
        const second = await (
            await def.handlers.GET!(
                makeEvent(
                    `?limit=2&cursor=${encodeURIComponent(first.page.nextCursor)}`,
                ) as RequestEvent,
                ctx,
            )
        ).json();
        const ids = [...first.items, ...second.items].map((c: { id: string }) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(second.page).toEqual({ limit: 2, hasMore: false });
        expect(mockListComments.mock.calls[1][1].cursor).toEqual({
            createdAt: OLDER.created_at_cursor,
            id: OLDER.id,
        });
    });
    it('does not claim another page when exactly limit comments remain', async () => {
        mockListComments.mockResolvedValue([NEWER, OLDER]);
        const response = await def.handlers.GET!(makeEvent('?limit=2') as RequestEvent, ctx);
        expect((await response.json()).page).toEqual({ limit: 2, hasMore: false });
    });
});
