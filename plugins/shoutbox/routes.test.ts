// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import shoutbox from './index.js';

/**
 * Drives `softDeleteOwn`'s return value for the DELETE tests below. The route
 * imports `./lib/queries.js` dynamically inside the handler, so this mock has
 * to exist at module scope for that import to resolve to it.
 *
 * Defaults to true (the delete succeeded) so the happy-path test needs no
 * setup; the ownership-miss test flips it and restores it.
 */
let ownDeleteResult = true;
/**
 * Drives POST /messages's insert result for the realtime-payload test below.
 * `undefined` means "use the real insertUserMessageRateLimited" (unused by
 * the existing tests in this file, which never exercise a successful POST).
 */
let insertedMessageRow: Record<string, unknown> | undefined;
vi.mock('./lib/queries.js', async (importActual) => ({
    // Spread the real module rather than enumerating it: the other routes in
    // this file import from here too, and a hand-listed mock silently breaks
    // whichever export it forgets.
    ...(await importActual<Record<string, unknown>>()),
    softDelete: vi.fn(async () => undefined),
    softDeleteOwn: vi.fn(async () => ownDeleteResult),
    insertUserMessageRateLimited: vi.fn(async (..._args: unknown[]) => insertedMessageRow ?? null),
}));
vi.mock('./lib/schema.js', () => ({ ensureSchema: vi.fn(async () => undefined) }));

function route(method: string, path: string) {
    const r = shoutbox.routes.find((x) => x.method === method && x.path === path);
    if (!r) throw new Error(`route ${method} ${path} not found`);
    return r;
}

function mockCtx(over: Record<string, unknown> = {}) {
    return {
        sql: vi.fn(async () => []),
        logger: {
            info() {},
            warn() {},
            error() {},
            debug() {},
            child() {
                return this;
            },
        },
        // userId is the identity the plugin keys on; username is display only.
        user: { userId: 'user-alice-id', username: 'alice', groups: [], isAdmin: false },
        settings: async () => ({
            readGroups: [],
            postGroups: [],
            adminGroups: [],
            maxLength: 280,
            historySize: 50,
            rateLimitPerMinute: 6,
        }),
        realtime: { publish: vi.fn(async () => undefined) },
        media: { resolveForViewer: async () => [], search: async () => [] },
        ...over,
    } as never;
}

describe('shoutbox routes', () => {
    it('POST /messages rejects empty body with 400', async () => {
        const res = await route('POST', '/messages').handler(
            mockCtx(),
            new Request('http://x/messages', {
                method: 'POST',
                body: JSON.stringify({ body: '   ' }),
            }),
        );
        expect(res.status).toBe(400);
    });

    it('POST /messages 403 when user cannot post', async () => {
        const ctx = mockCtx({
            user: { userId: 'user-bob-id', username: 'bob', groups: ['x'], isAdmin: false },
            settings: async () => ({
                readGroups: ['members'],
                postGroups: ['posters'],
                adminGroups: [],
                maxLength: 280,
                historySize: 50,
                rateLimitPerMinute: 6,
            }),
        });
        const res = await route('POST', '/messages').handler(
            ctx,
            new Request('http://x/messages', {
                method: 'POST',
                body: JSON.stringify({ body: 'hi' }),
            }),
        );
        expect(res.status).toBe(403);
    });

    it('GET /messages 403 when user cannot read', async () => {
        const ctx = mockCtx({
            user: { userId: 'user-bob-id', username: 'bob', groups: ['x'], isAdmin: false },
            settings: async () => ({
                readGroups: ['members'],
                postGroups: [],
                adminGroups: [],
                historySize: 50,
            }),
        });
        const res = await route('GET', '/messages').handler(ctx, new Request('http://x/messages'));
        expect(res.status).toBe(403);
    });

    // ── Realtime payload — security fix C27 (2026-09-16) ───────────────────
    //
    // The host's realtime SSE bridge (/api/plugins/[featureId]/realtime)
    // forwards every published frame verbatim to every connected client,
    // regardless of that plugin's own readGroups — the bridge has no access
    // hook, and the SDK documents the channel as broadcast. A room with a
    // restricted readGroups previously still broadcast the author's
    // username, first group, and a media hint to everyone, including
    // readers `GET /messages` would 403. The message body itself never
    // leaked (the widget re-fetches each body by id through the gated
    // route) — only these identifying fields did. Fix: publish a bare
    // `{ id }`; the widget already re-fetches the full message by id and
    // only falls back to a synthesized preview if that fetch 403s (which is
    // the correct behavior for an unauthorized reader).
    it('POST /messages publishes only a bare {id} on the realtime channel, not username/group/hasMedia', async () => {
        insertedMessageRow = {
            id: 'm1',
            user_id: 'user-alice-id',
            username: 'alice',
            user_group: null,
            author_kind: 'user',
            reply_to: null,
            body: 'hi',
            created_at: new Date(),
        };
        try {
            const ctx = mockCtx();
            const res = await route('POST', '/messages').handler(
                ctx,
                new Request('http://x/messages', {
                    method: 'POST',
                    body: JSON.stringify({ body: 'hi' }),
                }),
            );
            expect(res.status).toBe(200);
            expect(
                (ctx as unknown as { realtime: { publish: ReturnType<typeof vi.fn> } }).realtime
                    .publish,
            ).toHaveBeenCalledWith('message', { id: 'm1' });
        } finally {
            insertedMessageRow = undefined;
        }
    });

    // ── DELETE /messages/:id — moderator vs author ────────────────────────
    //
    // Before this, DELETE was moderator-only and `adminGroups` defaults to
    // empty, so on a stock install nobody but a server admin could remove
    // anything and an author had no way to unsay a mis-post.

    /**
     * The route imports `./lib/queries.js` lazily inside the handler, so the
     * mock has to be registered at module scope for the dynamic import to see
     * it. `softDeleteOwn` is driven per-test via `ownDeleteResult`.
     */
    it('DELETE /messages/:id lets an author delete their own message', async () => {
        const ctx = mockCtx();
        const res = await route('DELETE', '/messages/:id').handler(
            ctx,
            new Request('http://x/messages/m1', { method: 'DELETE' }),
            { id: 'm1' },
        );
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ ok: true });
        // Deleting must reach the other clients, not just the database.
        expect(
            (ctx as unknown as { realtime: { publish: ReturnType<typeof vi.fn> } }).realtime
                .publish,
        ).toHaveBeenCalledWith('delete', { id: 'm1' });
    });

    it("DELETE /messages/:id 403s on someone else's message without saying it exists", async () => {
        ownDeleteResult = false;
        try {
            const res = await route('DELETE', '/messages/:id').handler(
                mockCtx(),
                new Request('http://x/messages/m2', { method: 'DELETE' }),
                { id: 'm2' },
            );
            // 403, never 404 — distinguishing "not yours" from "no such
            // message" would let anyone probe for message ids.
            expect(res.status).toBe(403);
        } finally {
            ownDeleteResult = true;
        }
    });

    it('DELETE /messages/:id 403s a user who cannot even read the room', async () => {
        const ctx = mockCtx({
            user: { userId: 'user-bob-id', username: 'bob', groups: ['x'], isAdmin: false },
            settings: async () => ({
                readGroups: ['members'],
                postGroups: [],
                adminGroups: [],
                historySize: 50,
            }),
        });
        const res = await route('DELETE', '/messages/:id').handler(
            ctx,
            new Request('http://x/messages/m3', { method: 'DELETE' }),
            { id: 'm3' },
        );
        expect(res.status).toBe(403);
    });

    it('POST /messages refuses when the host supplies no userId', async () => {
        // PluginUser.userId is newer than this plugin. Against an older host
        // that does not populate it, accepting the post would write a NULL
        // user_id row — unattributable, and permanently undeletable by its own
        // author. Refusing loudly beats storing something nobody can own.
        const ctx = mockCtx({
            user: { username: 'legacy', groups: [], isAdmin: false },
        });
        const res = await route('POST', '/messages').handler(
            ctx,
            new Request('http://x/messages', {
                method: 'POST',
                body: JSON.stringify({ body: 'hello' }),
            }),
        );
        expect(res.status).toBe(500);
    });

    it('DELETE /messages/:id requires an id', async () => {
        const res = await route('DELETE', '/messages/:id').handler(
            mockCtx(),
            new Request('http://x/messages/', { method: 'DELETE' }),
            {},
        );
        expect(res.status).toBe(400);
    });
});
