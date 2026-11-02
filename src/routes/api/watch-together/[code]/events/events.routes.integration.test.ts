// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * D2 Watch-Together Events Channel — Integration Tests
 *
 * Tests POST /api/watch-together/{code}/events and
 *       GET  /api/watch-together/{code}/events
 * by importing the route handler directly and invoking it with mock
 * RequestEvent objects.  Valkey is replaced by an in-memory store.
 *
 * Covers:
 *  - POST seek/sync/position/stall/stall-ready/ready/join/leave/heartbeat → 202/200
 *  - POST host-only events from non-host → 403
 *  - POST unauthenticated → 401
 *  - POST invalid session code → 404
 *  - POST invalid body → 400 (problem+json)
 *  - GET SSE pre-flight: unauthenticated → 401, non-participant → 403, valid → 200 SSE
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { connectValkey, deleteKeysByPattern } from '$lib/server/cache/valkey.js';

vi.hoisted(() => {
    const testUrl =
        process.env.TEST_DATABASE_URL ||
        process.env.DATABASE_URL?.replace(/\/[^/]*$/, '/lumastra_tests') ||
        'postgres://localhost:5432/lumastra_tests';
    process.env.TEST_DATABASE_URL = testUrl;
    process.env.DATABASE_URL = testUrl;
});

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        })),
    },
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => getTestDb(),
    getTaskDb: () => getTestDb(),
}));

vi.mock('$lib/server/utils/widget-guard.js', () => ({
    isWidgetDisabled: vi.fn(() => false),
    isWidgetEnabled: vi.fn(() => true),
    createDisabledWidgetResponse: vi.fn(
        () =>
            new Response(JSON.stringify({ success: true, data: [], message: 'Widget disabled' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
    ),
    createDisabledRawResponse: vi.fn(
        (data: unknown) =>
            new Response(JSON.stringify(data), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
    ),
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

describe.runIf(RUN)('Watch Together Events endpoint integration tests (D2)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        await connectValkey();
        sql = getTestDb();
        try {
            await sql`SELECT 1 FROM media_items LIMIT 0`;
        } catch {
            throw new Error('media_items table missing — run db:test:migrate first');
        }
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await deleteKeysByPattern('watch:v2:*');
        await sql`DELETE FROM media_files WHERE file_path LIKE '/wt-events-binding/%'`;
        await sql`DELETE FROM media_items WHERE title LIKE 'WT Events%'`;
        await sql`DELETE FROM users WHERE username LIKE 'wt-events-%'`;
        vi.clearAllMocks();
    });

    // -------------------------------------------------------------------------
    // Test helpers
    // -------------------------------------------------------------------------

    async function insertUser(username: string) {
        const id = crypto.randomUUID();
        await sql`
			INSERT INTO users (id, username, is_admin, max_age_rating)
			VALUES (${id}::uuid, ${username}, false, null)
		`;
        return {
            id,
            userId: id,
            username,
            isAdmin: false,
            isAgeRestricted: false,
            maxAgeRating: null,
            userGroups: [] as string[],
        };
    }

    async function insertMedia() {
        const id = crypto.randomUUID();
        await sql`
			INSERT INTO media_items (id, media_type, title, overview, status, has_files, created_at)
			VALUES (${id}::uuid, ${'movie'}, ${'WT Events Movie'}, ${'Overview'}, ${'active'}, true, NOW())
		`;
        return id;
    }

    function mockEvent(opts: {
        url?: URL;
        method?: string;
        body?: Record<string, unknown>;
        params?: Record<string, string>;
        user?: Record<string, unknown> | null;
        headers?: Record<string, string>;
    }): RequestEvent {
        const url = opts.url ?? new URL('http://localhost');
        const allHeaders: Record<string, string> = {
            ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
            ...(opts.headers ?? {}),
        };
        const request = new Request(url.toString(), {
            method: opts.method ?? 'GET',
            body: opts.body ? JSON.stringify(opts.body) : undefined,
            headers: allHeaders,
        });
        return {
            request,
            url,
            params: opts.params ?? {},
            locals: { user: opts.user ?? null },
            route: { id: null },
            cookies: {} as never,
            fetch,
            getClientAddress: () => '127.0.0.1',
            platform: undefined,
            isDataRequest: false,
            isSubRequest: false,
            setHeaders: () => undefined,
            depends: () => undefined,
            untrack: (fn: () => unknown) => fn(),
        } as unknown as RequestEvent;
    }

    async function parseJson<T>(res: Response): Promise<T> {
        return res.json() as Promise<T>;
    }

    /** Create a session as the given host user, returning the session code. */
    async function createSession(
        host: Record<string, unknown>,
        mediaId: string,
        hostClientId = 'host-client-1',
    ): Promise<string> {
        const { POST: createPost } = await import('../../parties/+server.js');
        if (!createPost) throw new Error('createPost handler is not defined');
        const createRes = await createPost(
            mockEvent({
                url: new URL('http://localhost/api/watch-together'),
                method: 'POST',
                body: {
                    itemId: mediaId,
                    mediaType: 'movie',
                    title: 'WT Events Movie',
                    clientId: hostClientId,
                },
                user: host,
            }) as Parameters<typeof createPost>[0],
        );
        if (!createRes.ok) {
            throw new Error(
                `Session creation failed (${createRes.status}): ${await createRes.text()}`,
            );
        }
        const body = await parseJson<Record<string, unknown>>(createRes);
        return (body.party as Record<string, unknown>).code as string;
    }

    /** Join a session as the given guest user. */
    async function joinSession(
        guest: Record<string, unknown>,
        code: string,
        guestClientId = 'guest-client-1',
    ): Promise<void> {
        vi.useFakeTimers({
            toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        const { POST: joinPost } = await import('../join/+server.js');
        if (!joinPost) throw new Error('joinPost handler is not defined');
        await joinPost(
            mockEvent({
                url: new URL(`http://localhost/api/watch-together/${code}/join`),
                method: 'POST',
                body: { clientId: guestClientId },
                params: { code },
                user: guest,
            }) as Parameters<typeof joinPost>[0],
        );
        vi.useRealTimers();
    }

    // -------------------------------------------------------------------------
    // 1. POST /api/watch-together/{code}/events — auth checks
    // -------------------------------------------------------------------------

    describe('POST /{code}/events — auth', () => {
        it('returns 401 when no user', async () => {
            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together/ABC/events'),
                    method: 'POST',
                    body: {
                        clientId: 'c1',
                        type: 'seek',
                        payload: { currentTime: 0, isPlaying: false },
                    },
                    params: { code: 'ABC' },
                    user: null,
                }) as Parameters<typeof POST>[0],
            );
            expect(res.status).toBe(401);
        });

        it('returns 422/400 on invalid body (missing type)', async () => {
            const user = await insertUser('wt-events-auth-user');
            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together/ABC/events'),
                    method: 'POST',
                    body: { clientId: 'c1' }, // missing type + payload
                    params: { code: 'ABC' },
                    user,
                }) as Parameters<typeof POST>[0],
            );
            // validation_failed → 400 or 422
            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).toBeLessThan(500);
        });
    });

    // -------------------------------------------------------------------------
    // 2. POST /{code}/events — seek (participant broadcast)
    // -------------------------------------------------------------------------

    describe('POST /{code}/events — seek', () => {
        it('host can dispatch seek event → 202 {accepted:true}', async () => {
            const host = await insertUser('wt-events-seek-host');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'host-client-1',
                        type: 'seek',
                        payload: { currentTime: 42.5, isPlaying: false },
                    },
                    params: { code },
                    user: host,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(202);
            const body = await parseJson<Record<string, unknown>>(res);
            expect(body.accepted).toBe(true);
        });

        it('rejects seek without the current play state', async () => {
            const host = await insertUser('wt-events-seek-missing-state');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'host-client-1',
                        type: 'seek',
                        payload: { currentTime: 42.5 },
                    },
                    params: { code },
                    user: host,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(422);
        });

        it('returns 403/404 for non-participant seek', async () => {
            const host = await insertUser('wt-events-seek-host2');
            const intruder = await insertUser('wt-events-seek-intruder');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'intruder-client',
                        type: 'seek',
                        payload: { currentTime: 42.5, isPlaying: true },
                    },
                    params: { code },
                    user: intruder,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBeGreaterThanOrEqual(403);
            expect(res.status).toBeLessThan(500);
        });

        it('returns 404 for non-existent session', async () => {
            const user = await insertUser('wt-events-seek-user');

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together/NOTEXIST/events'),
                    method: 'POST',
                    body: {
                        clientId: 'c1',
                        type: 'seek',
                        payload: { currentTime: 10, isPlaying: true },
                    },
                    params: { code: 'NOTEXIST' },
                    user,
                }) as Parameters<typeof POST>[0],
            );

            // seek → broadcastSeek returns !ok → forbidden; non-existent session
            expect(res.status).toBeGreaterThanOrEqual(403);
            expect(res.status).toBeLessThan(500);
        });
    });

    // -------------------------------------------------------------------------
    // 3. POST /{code}/events — sync
    // -------------------------------------------------------------------------

    describe('POST /{code}/events — sync', () => {
        it('guest can dispatch sync event after joining → 202', async () => {
            const host = await insertUser('wt-events-sync-host');
            const guest = await insertUser('wt-events-sync-guest');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);
            await joinSession(guest, code);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'guest-client-1',
                        type: 'sync',
                        payload: { currentTime: 60, isPlaying: true, playbackRate: 1 },
                    },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(202);
            const body = await parseJson<Record<string, unknown>>(res);
            expect(body.accepted).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // 4. POST /{code}/events — position
    // -------------------------------------------------------------------------

    describe('POST /{code}/events — position', () => {
        it('participant position report → 200 {resyncing}', async () => {
            const host = await insertUser('wt-events-pos-host');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'host-client-1',
                        type: 'position',
                        payload: { position: 30.5 },
                    },
                    params: { code },
                    user: host,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(200);
            const body = await parseJson<Record<string, unknown>>(res);
            expect(typeof body.resyncing).toBe('boolean');
        });
    });

    // -------------------------------------------------------------------------
    // 5. POST /{code}/events — join
    // -------------------------------------------------------------------------

    describe('POST /{code}/events — join', () => {
        it('join event → 200 {session}', async () => {
            const host = await insertUser('wt-events-join-host');
            const guest = await insertUser('wt-events-join-guest');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            vi.useFakeTimers({
                toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
            });
            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: { clientId: 'guest-client-1', type: 'join', payload: {} },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof POST>[0],
            );
            vi.useRealTimers();

            expect(res.status).toBe(200);
            const body = await parseJson<Record<string, unknown>>(res);
            expect(body.party).toBeDefined();
            const session = body.party as Record<string, unknown>;
            expect(session.code).toBe(code);
        });

        it('join with invalid code → 404', async () => {
            const guest = await insertUser('wt-events-join-guest2');

            vi.useFakeTimers({
                toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
            });
            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together/INVALID/events'),
                    method: 'POST',
                    body: { clientId: 'guest-client-1', type: 'join', payload: {} },
                    params: { code: 'INVALID' },
                    user: guest,
                }) as Parameters<typeof POST>[0],
            );
            vi.useRealTimers();

            expect(res.status).toBe(404);
        });
    });

    // -------------------------------------------------------------------------
    // 6. POST /{code}/events — leave
    // -------------------------------------------------------------------------

    describe('POST /{code}/events — leave', () => {
        it('leave event → 202 (idempotent)', async () => {
            const host = await insertUser('wt-events-leave-host');
            const guest = await insertUser('wt-events-leave-guest');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);
            await joinSession(guest, code);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: { clientId: 'guest-client-1', type: 'leave', payload: {} },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(202);
            const body = await parseJson<Record<string, unknown>>(res);
            expect(body.accepted).toBe(true);
        });

        it('leave twice does not error', async () => {
            const host = await insertUser('wt-events-leave-host2');
            const guest = await insertUser('wt-events-leave-guest2');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);
            await joinSession(guest, code);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const makeLeave = () =>
                POST(
                    mockEvent({
                        url: new URL(`http://localhost/api/watch-together/${code}/events`),
                        method: 'POST',
                        body: { clientId: 'guest-client-1', type: 'leave', payload: {} },
                        params: { code },
                        user: guest,
                    }) as Parameters<typeof POST>[0],
                );

            const first = await makeLeave();
            expect(first.status).toBe(202);
            const second = await makeLeave();
            expect(second.status).toBe(202);
        });
    });

    // -------------------------------------------------------------------------
    // 7. POST /{code}/events — ready
    // -------------------------------------------------------------------------

    describe('POST /{code}/events — ready', () => {
        it('participant ready signal → 202', async () => {
            const host = await insertUser('wt-events-ready-host');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'host-client-1',
                        type: 'ready',
                        payload: { checkId: 'check-1' },
                    },
                    params: { code },
                    user: host,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(202);
        });

        it('non-participant ready → forbidden', async () => {
            const host = await insertUser('wt-events-ready-host2');
            const outsider = await insertUser('wt-events-ready-outsider');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'outsider-client',
                        type: 'ready',
                        payload: { checkId: 'check-1' },
                    },
                    params: { code },
                    user: outsider,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBeGreaterThanOrEqual(403);
            expect(res.status).toBeLessThan(500);
        });
    });

    // -------------------------------------------------------------------------
    // 8. POST /{code}/events — stall / stall-ready
    // -------------------------------------------------------------------------

    describe('POST /{code}/events — stall / stall-ready', () => {
        it.each(['events', 'stall'])(
            'preserves the stall timeline fence through the %s request contract',
            async (surface) => {
                const host = await insertUser(`wt-events-stall-fence-${surface}`);
                const mediaId = await insertMedia();
                const code = await createSession(host, mediaId);
                const service = await import('$lib/server/services/watch-together.service.js');
                const cache = await import('$lib/server/cache/valkey.js');
                const party = (await service.getSession(code))!;
                const { POST } =
                    surface === 'events'
                        ? await import('./+server.js')
                        : await import('../stall/+server.js');
                if (!POST) throw new Error('POST handler missing');
                const send = (timeline: string) =>
                    POST(
                        mockEvent({
                            url: new URL(`http://localhost/api/watch-together/${code}/${surface}`),
                            method: 'POST',
                            body:
                                surface === 'events'
                                    ? {
                                          clientId: 'host-client-1',
                                          type: 'stall',
                                          payload: {
                                              stallId: 'request-stall',
                                              expectedTimelineId: timeline,
                                          },
                                      }
                                    : {
                                          clientId: 'host-client-1',
                                          stallId: 'request-stall',
                                          expectedTimelineId: timeline,
                                      },
                            params: { code },
                            user: host,
                        }) as Parameters<typeof POST>[0],
                    );
                expect((await send('old-timeline')).status).toBe(surface === 'events' ? 202 : 204);
                expect(await cache.hGetAll(`watch:v2:stalled:${code}`)).toEqual({});
                const frames = (await cache.lRange(`watch:v2:replay:${code}`, 0, -1)).map(
                    (raw) => JSON.parse(raw).event,
                );
                expect(frames.filter((frame) => frame.type === 'stall')).toEqual([]);
                expect((await send(party.timelineId!)).status).toBe(
                    surface === 'events' ? 202 : 204,
                );
                const entry = await cache.hGetAll(`watch:v2:stalled:${code}`);
                expect(JSON.parse(entry['host-client-1']!)).toMatchObject({
                    timelineId: party.timelineId,
                });
            },
        );

        it('participant stall → 202', async () => {
            const host = await insertUser('wt-events-stall-host');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'host-client-1',
                        type: 'stall',
                        payload: { stallId: 'stall-1' },
                    },
                    params: { code },
                    user: host,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(202);
        });

        it('participant stall-ready → 202', async () => {
            const host = await insertUser('wt-events-stallready-host');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'host-client-1',
                        type: 'stall-ready',
                        payload: { stallId: 'stall-1' },
                    },
                    params: { code },
                    user: host,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(202);
        });

        it('stall for invalid session → 404', async () => {
            const user = await insertUser('wt-events-stall-nouser');

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together/BADCODE/events'),
                    method: 'POST',
                    body: { clientId: 'c1', type: 'stall', payload: { stallId: 'stall-1' } },
                    params: { code: 'BADCODE' },
                    user,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(404);
        });

        it('non-participant stall → 403', async () => {
            const host = await insertUser('wt-events-stall-host2');
            const intruder = await insertUser('wt-events-stall-intruder');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'intruder-c',
                        type: 'stall',
                        payload: { stallId: 'stall-1' },
                    },
                    params: { code },
                    user: intruder,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(403);
        });
    });

    // -------------------------------------------------------------------------
    // 9. POST /{code}/events — heartbeat
    // -------------------------------------------------------------------------

    describe('POST /{code}/events — heartbeat', () => {
        it.each([
            { type: 'seek', surface: 'events' },
            { type: 'sync', surface: 'events' },
            { type: 'heartbeat', surface: 'events' },
            { type: 'seek', surface: 'rest' },
            { type: 'sync', surface: 'rest' },
            { type: 'heartbeat', surface: 'rest' },
        ] as const)(
            'rejects a late timeline control through $surface/$type after navigating away and back',
            async ({ type, surface }) => {
                const host = await insertUser(`wt-events-stale-timeline-${surface}-${type}`);
                const oldItem = await insertMedia();
                const nextItem = await insertMedia();
                const code = await createSession(host, oldItem);
                const service = await import('$lib/server/services/watch-together.service.js');
                const initial = await service.getSession(code);
                const { GET } = await import('../+server.js');
                const snapshot = await GET!(
                    mockEvent({
                        url: new URL(`http://localhost/api/watch-together/${code}`),
                        method: 'GET',
                        params: { code },
                        user: host,
                    }) as Parameters<NonNullable<typeof GET>>[0],
                );
                expect(snapshot.status).toBe(200);
                expect((await snapshot.json()).party.timelineId).toBe(initial?.timelineId);
                expect(initial?.timelineId).toEqual(expect.any(String));
                const expectedTimelineId =
                    (initial as unknown as { timelineId?: string })?.timelineId ?? 'old-timeline';
                const chosenTimeline = crypto.randomUUID();
                const navigationRoute =
                    surface === 'events'
                        ? await import('./+server.js')
                        : await import('../navigate/+server.js');
                const navigatePost = navigationRoute.POST!;
                const navigationResponse = await navigatePost(
                    mockEvent({
                        url: new URL(
                            `http://localhost/api/watch-together/${code}/${surface === 'events' ? 'events' : 'navigate'}`,
                        ),
                        method: 'POST',
                        params: { code },
                        user: host,
                        body:
                            surface === 'events'
                                ? {
                                      clientId: 'host-client-1',
                                      type: 'navigate',
                                      payload: {
                                          itemId: nextItem,
                                          title: 'Next',
                                          mediaType: 'movie',
                                          timelineId: chosenTimeline,
                                      },
                                  }
                                : {
                                      clientId: 'host-client-1',
                                      itemId: nextItem,
                                      title: 'Next',
                                      mediaType: 'movie',
                                      timelineId: chosenTimeline,
                                  },
                    }) as Parameters<typeof navigatePost>[0],
                );
                expect(navigationResponse.status).toBe(surface === 'events' ? 202 : 204);
                expect((await service.getSession(code))?.timelineId).toBe(chosenTimeline);
                const staleNavigationBody = {
                    itemId: oldItem,
                    title: 'Stale',
                    mediaType: 'movie',
                    timelineId: crypto.randomUUID(),
                    expectedTimelineId,
                };
                const staleNavigation = await navigatePost(
                    mockEvent({
                        url: new URL(
                            `http://localhost/api/watch-together/${code}/${surface === 'events' ? 'events' : 'navigate'}`,
                        ),
                        method: 'POST',
                        params: { code },
                        user: host,
                        body:
                            surface === 'events'
                                ? {
                                      clientId: 'host-client-1',
                                      type: 'navigate',
                                      payload: staleNavigationBody,
                                  }
                                : { clientId: 'host-client-1', ...staleNavigationBody },
                    }) as Parameters<typeof navigatePost>[0],
                );
                expect(staleNavigation.status).toBe(403);
                expect((await service.getSession(code))?.timelineId).toBe(chosenTimeline);

                await service.broadcastNavigate(
                    code,
                    host.id,
                    oldItem,
                    'Old again',
                    'movie',
                    'host-client-1',
                );
                const route =
                    surface === 'events'
                        ? await import('./+server.js')
                        : type === 'seek'
                          ? await import('../seek/+server.js')
                          : type === 'sync'
                            ? await import('../sync/+server.js')
                            : await import('../heartbeat/+server.js');
                const POST = route.POST!;
                const res = await POST!(
                    mockEvent({
                        url: new URL(`http://localhost/api/watch-together/${code}/events`),
                        method: 'POST',
                        params: { code },
                        user: host,
                        body:
                            surface === 'events'
                                ? {
                                      clientId: 'host-client-1',
                                      type,
                                      payload: {
                                          currentTime: 125,
                                          isPlaying: true,
                                          playbackRate: 1,
                                          itemId: oldItem,
                                          expectedTimelineId,
                                      },
                                  }
                                : {
                                      clientId: 'host-client-1',
                                      currentTime: 125,
                                      isPlaying: true,
                                      playbackRate: 1,
                                      itemId: oldItem,
                                      expectedTimelineId,
                                  },
                    }) as Parameters<NonNullable<typeof POST>>[0],
                );
                expect(res.status).toBe(surface === 'events' ? 202 : 204);
                const after = await service.getSession(code);
                expect(after?.itemId).toBe(oldItem);
                expect(after?.currentTime).toBe(0);
                expect(after?.isPlaying).toBe(false);
            },
        );

        it.each(['events', 'heartbeat'] as const)(
            'preserves the new title against a late heartbeat through %s',
            async (surface) => {
                const host = await insertUser(`wt-events-late-hb-${surface}`);
                const oldItem = await insertMedia();
                const newItem = await insertMedia();
                const code = await createSession(host, oldItem);
                const service = await import('$lib/server/services/watch-together.service.js');
                expect(
                    await service.broadcastNavigate(
                        code,
                        host.id,
                        newItem,
                        'New',
                        'movie',
                        'host-client-1',
                    ),
                ).toBe(true);
                const route =
                    surface === 'events'
                        ? await import('./+server.js')
                        : await import('../heartbeat/+server.js');
                const POST = route.POST!;
                const response = await POST(
                    mockEvent({
                        url: new URL(`http://localhost/api/watch-together/${code}/${surface}`),
                        method: 'POST',
                        params: { code },
                        user: host,
                        body:
                            surface === 'events'
                                ? {
                                      clientId: 'host-client-1',
                                      type: 'heartbeat',
                                      payload: {
                                          currentTime: 125,
                                          isPlaying: true,
                                          itemId: oldItem,
                                      },
                                  }
                                : {
                                      clientId: 'host-client-1',
                                      currentTime: 125,
                                      isPlaying: true,
                                      itemId: oldItem,
                                  },
                    }) as Parameters<typeof POST>[0],
                );
                expect(response.status).toBe(surface === 'events' ? 202 : 204);
                const session = await service.getSession(code);
                expect(session?.itemId).toBe(newItem);
                expect(session?.currentTime).toBe(0);
                expect(session?.isPlaying).toBe(false);
                const { lRange } = await import('$lib/server/cache/valkey.js');
                const events = (await lRange(`watch:v2:replay:${code}`, 0, -1)).map(
                    (raw) => (JSON.parse(raw) as { event: { type: string } }).event.type,
                );
                expect(events).not.toContain('host_position');
            },
        );

        it('participant heartbeat → 202', async () => {
            const host = await insertUser('wt-events-hb-host');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'host-client-1',
                        type: 'heartbeat',
                        payload: { currentTime: 10, isPlaying: true },
                    },
                    params: { code },
                    user: host,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(202);
        });

        it('rejects heartbeat without the current play state', async () => {
            const host = await insertUser('wt-events-hb-missing-state');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'host-client-1',
                        type: 'heartbeat',
                        payload: { currentTime: 10 },
                    },
                    params: { code },
                    user: host,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(422);
        });
    });

    // -------------------------------------------------------------------------
    // 10. POST /{code}/events — host-only gates
    // -------------------------------------------------------------------------

    describe('POST /{code}/events — host-only gates', () => {
        it('non-host transfer-host → 403', async () => {
            const host = await insertUser('wt-events-th-host');
            const guest = await insertUser('wt-events-th-guest');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);
            await joinSession(guest, code);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'guest-client-1',
                        type: 'transfer-host',
                        payload: { newHostUserId: host.id },
                    },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(403);
        });

        it('host can transfer to a participant → 202', async () => {
            const host = await insertUser('wt-events-th-host2');
            const guest = await insertUser('wt-events-th-guest2');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);
            await joinSession(guest, code);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'host-client-1',
                        type: 'transfer-host',
                        payload: { newHostUserId: guest.id },
                    },
                    params: { code },
                    user: host,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(202);
        });

        it('non-host disband → 403', async () => {
            const host = await insertUser('wt-events-dis-host');
            const guest = await insertUser('wt-events-dis-guest');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);
            await joinSession(guest, code);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: { clientId: 'guest-client-1', type: 'disband', payload: {} },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(403);
        });

        it('host disband → 202', async () => {
            const host = await insertUser('wt-events-dis-host2');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: { clientId: 'host-client-1', type: 'disband', payload: {} },
                    params: { code },
                    user: host,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(202);
        });

        it('non-host visibility → 403', async () => {
            const host = await insertUser('wt-events-vis-host');
            const guest = await insertUser('wt-events-vis-guest');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);
            await joinSession(guest, code);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'guest-client-1',
                        type: 'visibility',
                        payload: { visibility: 'unlisted' },
                    },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(403);
        });

        it('host visibility → 202', async () => {
            const host = await insertUser('wt-events-vis-host2');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'host-client-1',
                        type: 'visibility',
                        payload: { visibility: 'unlisted' },
                    },
                    params: { code },
                    user: host,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(202);
        });
    });

    // -------------------------------------------------------------------------
    // 11. GET /{code}/events — SSE pre-flight checks
    // -------------------------------------------------------------------------

    describe('GET /{code}/events — SSE pre-flight', () => {
        it('unauthenticated GET → 401', async () => {
            const { GET } = await import('./+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together/ABC/events?clientId=c1'),
                    method: 'GET',
                    params: { code: 'ABC' },
                    user: null,
                }) as Parameters<typeof GET>[0],
            );
            expect(res.status).toBe(401);
        });

        it('non-existent session GET → 404', async () => {
            const user = await insertUser('wt-events-get-nouser');

            const { GET } = await import('./+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                mockEvent({
                    url: new URL(
                        'http://localhost/api/watch-together/NOSESSION/events?clientId=c1',
                    ),
                    method: 'GET',
                    params: { code: 'NOSESSION' },
                    user,
                }) as Parameters<typeof GET>[0],
            );
            expect(res.status).toBe(404);
        });

        it('non-participant GET → 403', async () => {
            const host = await insertUser('wt-events-get-host');
            const outsider = await insertUser('wt-events-get-outsider');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { GET } = await import('./+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                mockEvent({
                    url: new URL(
                        `http://localhost/api/watch-together/${code}/events?clientId=outsider-c`,
                    ),
                    method: 'GET',
                    params: { code },
                    user: outsider,
                }) as Parameters<typeof GET>[0],
            );
            expect(res.status).toBe(403);
        });

        it('participant GET → 200 text/event-stream', async () => {
            const host = await insertUser('wt-events-get-host2');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { GET } = await import('./+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                mockEvent({
                    url: new URL(
                        `http://localhost/api/watch-together/${code}/events?clientId=host-client-1`,
                    ),
                    method: 'GET',
                    params: { code },
                    user: host,
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(200);
            expect(res.headers.get('Content-Type')).toContain('text/event-stream');

            // Consume the stream to avoid resource leaks
            if (res.body) {
                await res.body.cancel();
            }
        });

        it('participant GET with Last-Event-ID header → 200 SSE', async () => {
            const host = await insertUser('wt-events-get-host3');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            // Send a seek event to populate the replay ring
            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'host-client-1',
                        type: 'seek',
                        payload: { currentTime: 10, isPlaying: true },
                    },
                    params: { code },
                    user: host,
                }) as Parameters<typeof POST>[0],
            );

            const { GET } = await import('./+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                mockEvent({
                    url: new URL(
                        `http://localhost/api/watch-together/${code}/events?clientId=host-client-1`,
                    ),
                    method: 'GET',
                    params: { code },
                    user: host,
                    headers: { 'Last-Event-ID': '0' }, // replay from beginning
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(200);
            expect(res.headers.get('Content-Type')).toContain('text/event-stream');

            if (res.body) {
                await res.body.cancel();
            }
        });
    });

    // -------------------------------------------------------------------------
    // 12. POST /{code}/events — reaction / effect (participant broadcasts)
    // -------------------------------------------------------------------------

    describe('POST /{code}/events — reaction & effect', () => {
        it('participant reaction → 202', async () => {
            const host = await insertUser('wt-events-react-host');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: { clientId: 'host-client-1', type: 'reaction', payload: { emoji: '👏' } },
                    params: { code },
                    user: host,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(202);
        });

        it('participant effect → 202', async () => {
            const host = await insertUser('wt-events-effect-host');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);

            const { POST } = await import('./+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    body: {
                        clientId: 'host-client-1',
                        type: 'effect',
                        payload: { effect: 'confetti' },
                    },
                    params: { code },
                    user: host,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(202);
        });
    });

    describe('authenticated client identity binding', () => {
        async function party() {
            const host = await insertUser('wt-events-binding-host');
            const guest = await insertUser('wt-events-binding-guest');
            const mediaId = await insertMedia();
            const code = await createSession(host, mediaId);
            await joinSession(guest, code);
            return { host, guest, code, mediaId };
        }

        async function send(
            code: string,
            user: Record<string, unknown>,
            clientId: string,
            type: string,
            payload: Record<string, unknown>,
        ) {
            const { POST } = await import('./+server.js');
            return POST!(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/events`),
                    method: 'POST',
                    params: { code },
                    user,
                    body: { clientId, type, payload },
                }) as Parameters<NonNullable<typeof POST>>[0],
            );
        }

        it.each(['events', 'sync'] as const)(
            'keeps sync request identity in sender confirmations through %s',
            async (surface) => {
                const { host, code, mediaId } = await party();
                const syncId = 'c4c90564-14a9-4f04-9d99-2f251ce41b4a';
                const payload = {
                    syncId,
                    itemId: mediaId,
                    currentTime: 17,
                    isPlaying: false,
                    playbackRate: 1,
                };
                if (surface === 'events') {
                    expect((await send(code, host, 'host-client-1', 'sync', payload)).status).toBe(
                        202,
                    );
                } else {
                    const { POST } = await import('../sync/+server.js');
                    const response = await POST!(
                        mockEvent({
                            url: new URL(`http://localhost/api/watch-together/${code}/sync`),
                            method: 'POST',
                            params: { code },
                            user: host,
                            body: { ...payload, clientId: 'host-client-1' },
                        }) as Parameters<NonNullable<typeof POST>>[0],
                    );
                    expect(response.status).toBe(204);
                }
                const { lRange } = await import('$lib/server/cache/valkey.js');
                const frames = (await lRange(`watch:v2:replay:${code}`, 0, -1)).map(
                    (raw) =>
                        JSON.parse(raw) as {
                            excludeClientId?: string;
                            event: { type: string; clientId?: string; syncId?: string };
                        },
                );
                const confirmation = frames.find(
                    (frame) => frame.event.type === 'sync' && frame.event.syncId === syncId,
                );
                expect(confirmation?.event.clientId).toBe('host-client-1');
                expect(confirmation).not.toHaveProperty('excludeClientId');
            },
        );

        it('F1 denies spoofed host IDs before seek, sync, navigation or host broadcasts', async () => {
            const { guest, code, mediaId } = await party();
            const events: [string, Record<string, unknown>][] = [
                ['seek', { currentTime: 999, isPlaying: true }],
                ['sync', { currentTime: 999, isPlaying: true }],
                ['navigate', { itemId: mediaId, mediaType: 'movie', title: 'Forged' }],
                ['version', { fileId: 'forged-file' }],
                ['visibility', { visibility: 'unlisted' }],
                ['transfer-host', { newHostUserId: guest.id }],
                ['disband', {}],
                ['activity', { activity: 'searching' }],
            ];
            const { getSession } = await import('$lib/server/services/watch-together.service.js');
            const before = await getSession(code);
            for (const [type, payload] of events) {
                expect((await send(code, guest, 'host-client-1', type, payload)).status).toBe(403);
            }
            expect(await getSession(code)).toEqual(before);
        });

        it('denies spoofed and unregistered IDs for all participant events', async () => {
            const { guest, code } = await party();
            const events: [string, Record<string, unknown>][] = [
                ['position', { position: 123 }],
                ['leave', {}],
                ['reaction', { emoji: '👏' }],
                ['effect', { effect: 'confetti' }],
                ['ready', { checkId: 'forged-check', currentTime: 123 }],
                ['stall', { stallId: 'forged-stall' }],
                ['stall-ready', { stallId: 'forged-stall' }],
                ['heartbeat', { currentTime: 123, isPlaying: true }],
            ];
            for (const clientId of ['host-client-1', 'unregistered']) {
                for (const [type, payload] of events) {
                    const { getSession } =
                        await import('$lib/server/services/watch-together.service.js');
                    const before = await getSession(code);
                    expect((await send(code, guest, clientId, type, payload)).status).toBe(
                        clientId === 'unregistered' && type === 'leave' ? 202 : 403,
                    );
                    expect(await getSession(code)).toEqual(before);
                }
            }
        });

        it('rejects collision joins without restoring pointers and permits the owner rejoin', async () => {
            const { host, guest, code } = await party();
            const { leaveSession, getUserActiveSession, getSession } =
                await import('$lib/server/services/watch-together.service.js');
            await leaveSession(code, guest.id, 'guest-client-1');
            const before = await getSession(code);
            expect((await send(code, guest, 'host-client-1', 'join', {})).status).toBe(404);
            expect(await getUserActiveSession(guest.id)).toBeNull();
            expect(await getSession(code)).toEqual(before);
            expect((await send(code, host, 'host-client-1', 'join', {})).status).toBe(200);
            expect(await getUserActiveSession(host.id)).toBe(code);
        });

        it('G2 cannot remove another participant through standalone or event leave', async () => {
            const { guest, code } = await party();
            const { getSession } = await import('$lib/server/services/watch-together.service.js');
            const before = await getSession(code);
            const { POST } = await import('../leave/+server.js');
            const response = await POST!(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/leave`),
                    method: 'POST',
                    params: { code },
                    user: guest,
                    body: { clientId: 'host-client-1' },
                }) as Parameters<NonNullable<typeof POST>>[0],
            );
            expect(response.status).toBe(204);
            expect(await getSession(code)).toEqual(before);
            expect((await send(code, guest, 'host-client-1', 'leave', {})).status).toBe(403);
            expect((await send(code, guest, 'guest-client-1', 'leave', {})).status).toBe(202);
            expect((await getSession(code))?.participants.map((p) => p.clientId)).toEqual([
                'host-client-1',
            ]);
        });

        it('G5 denies spoofed SSE IDs before writing presence and accepts an honest guest', async () => {
            const { guest, code } = await party();
            const { GET } = await import('./+server.js');
            const { hGet } = await import('$lib/server/cache/valkey.js');
            for (const clientId of ['host-client-1', 'unregistered']) {
                const before = await hGet(`watch:v2:conn:${code}`, clientId);
                const response = await GET!(
                    mockEvent({
                        url: new URL(
                            `http://localhost/api/watch-together/${code}/events?clientId=${clientId}`,
                        ),
                        params: { code },
                        user: guest,
                    }) as Parameters<NonNullable<typeof GET>>[0],
                );
                expect(response.status).toBe(403);
                expect(await hGet(`watch:v2:conn:${code}`, clientId)).toBe(before);
            }
            const honest = await GET!(
                mockEvent({
                    url: new URL(
                        `http://localhost/api/watch-together/${code}/events?clientId=guest-client-1`,
                    ),
                    params: { code },
                    user: guest,
                }) as Parameters<NonNullable<typeof GET>>[0],
            );
            expect(honest.status).toBe(200);
            await honest.body?.cancel();
        });

        it('F6 only the enrolled host device has version authority, including same-user devices', async () => {
            const { host, guest, code, mediaId } = await party();
            const fileId = crypto.randomUUID();
            await sql`INSERT INTO media_files (id, file_path) VALUES (${fileId}::uuid, ${`/wt-events-binding/${fileId}.mkv`})`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${fileId}::uuid, ${mediaId}::uuid)`;
            await joinSession(host, code, 'host-second-device');
            const { POST } = await import('../version/+server.js');
            for (const [user, clientId] of [
                [guest, 'guest-client-1'],
                [host, 'host-second-device'],
            ] as const) {
                expect((await send(code, user, clientId, 'version', { fileId })).status).toBe(403);
                const response = await POST!(
                    mockEvent({
                        url: new URL(`http://localhost/api/watch-together/${code}/version`),
                        method: 'POST',
                        params: { code },
                        user,
                        body: { clientId, fileId },
                    }) as Parameters<NonNullable<typeof POST>>[0],
                );
                expect(response.status).toBe(403);
            }
            const honest = await POST!(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/version`),
                    method: 'POST',
                    params: { code },
                    user: host,
                    body: { clientId: 'host-client-1', fileId },
                }) as Parameters<NonNullable<typeof POST>>[0],
            );
            expect(honest.status).toBe(204);
            const { getSession } = await import('$lib/server/services/watch-together.service.js');
            expect((await getSession(code))?.fileId).toBe(fileId);
            expect(
                (await send(code, guest, 'guest-client-1', 'position', { position: 0 })).status,
            ).toBe(200);
            expect(
                (
                    await send(code, guest, 'guest-client-1', 'sync', {
                        currentTime: 0,
                        isPlaying: false,
                    })
                ).status,
            ).toBe(202);
            expect((await send(code, guest, 'guest-client-1', 'leave', {})).status).toBe(202);
        });

        it('mixed-case authenticated owners keep ready, stall and multi-device leave behavior', async () => {
            const { guest, code } = await party();
            await joinSession(guest, code, 'guest-second-device');
            const mixedGuest = { ...guest, username: guest.username.toUpperCase() };
            const service = await import('$lib/server/services/watch-together.service.js');
            expect(
                (
                    await send(code, mixedGuest, 'guest-client-1', 'ready', {
                        checkId: 'absent-check',
                    })
                ).status,
            ).toBe(202);
            const { POST } = await import('../ready/+server.js');
            expect(
                (
                    await POST!(
                        mockEvent({
                            url: new URL(`http://localhost/api/watch-together/${code}/ready`),
                            method: 'POST',
                            params: { code },
                            user: mixedGuest,
                            body: { clientId: 'guest-client-1', checkId: 'absent-check' },
                        }) as Parameters<NonNullable<typeof POST>>[0],
                    )
                ).status,
            ).toBe(204);
            expect(
                (
                    await send(code, mixedGuest, 'guest-client-1', 'stall', {
                        stallId: 'mixed-stall',
                    })
                ).status,
            ).toBe(202);
            expect(
                (
                    await send(code, mixedGuest, 'guest-client-1', 'stall-ready', {
                        stallId: 'mixed-stall',
                    })
                ).status,
            ).toBe(202);
            expect(await service.leaveSession(code, mixedGuest.id, 'guest-client-1')).toBe(true);
            expect(await service.getUserActiveSession(guest.id)).toBe(code);
            expect(
                (await service.getSession(code))?.participants.some(
                    (p) => p.clientId === 'guest-second-device',
                ),
            ).toBe(true);
            expect(await service.leaveSession(code, mixedGuest.id, 'guest-second-device')).toBe(
                true,
            );
            expect(await service.getUserActiveSession(guest.id)).toBeNull();
        });

        it('moves host authority to the surviving host device when the host device leaves', async () => {
            const { host, code, mediaId } = await party();
            await joinSession(host, code, 'host-second-device');
            const service = await import('$lib/server/services/watch-together.service.js');
            const fileId = crypto.randomUUID();
            await sql`INSERT INTO media_files (id, file_path) VALUES (${fileId}::uuid, ${`/wt-events-binding/${fileId}.mkv`})`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${fileId}::uuid, ${mediaId}::uuid)`;
            expect(await service.leaveSession(code, host.id, 'host-client-1')).toBe(true);
            expect((await service.getSession(code))?.hostClientId).toBe('host-second-device');
            expect(await service.getUserActiveSession(host.id)).toBe(code);
            expect(
                await service.broadcastVersionChange(code, host.id, fileId, 'host-second-device'),
            ).toBe(true);
            vi.useFakeTimers({
                toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
            });
            try {
                expect(
                    await service.broadcastSeek(code, host.id, 23, 'host-second-device', false),
                ).toBe(true);
            } finally {
                vi.useRealTimers();
            }
            const { lRange, cacheGet } = await import('$lib/server/cache/valkey.js');
            expect(await cacheGet(`watch:v2:host-seen:${code}`)).not.toBeNull();
            const replay = await lRange(`watch:v2:replay:${code}`, 0, -1);
            expect(
                replay.some(
                    (event) =>
                        event.includes('host_changed') && event.includes('host-second-device'),
                ),
            ).toBe(true);
        });

        it('G6 denies standalone spoofed position reports and service mutations', async () => {
            const { host, guest, code, mediaId } = await party();
            const service = await import('$lib/server/services/watch-together.service.js');
            const before = await service.getSession(code);
            const { POST } = await import('../position/+server.js');
            const response = await POST!(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/position`),
                    method: 'POST',
                    params: { code },
                    user: guest,
                    body: { clientId: 'host-client-1', position: 123 },
                }) as Parameters<NonNullable<typeof POST>>[0],
            );
            expect(response.status).toBe(403);
            expect(await service.broadcastSeek(code, guest.id, 123, 'host-client-1')).toBe(false);
            expect(
                await service.updatePlaybackState(
                    code,
                    guest.id,
                    { currentTime: 123, isPlaying: true, playbackRate: 1, timestamp: Date.now() },
                    'host-client-1',
                ),
            ).toBe(false);
            expect(
                await service.broadcastNavigate(
                    code,
                    guest.id,
                    mediaId,
                    'Forged',
                    'movie',
                    'host-client-1',
                ),
            ).toBe(false);
            expect(await service.leaveSession(code, guest.id, 'host-client-1')).toBe(false);
            expect(await service.reportPosition(code, 'host-client-1', guest.id, 123)).toEqual({
                success: false,
            });
            expect(await service.getSession(code)).toEqual(before);
            expect(service.isHostClient(before!, 'host-client-1', host.id.toUpperCase())).toBe(
                true,
            );
            expect(await service.updateSessionPosition(code, guest.id, 123, 'unregistered')).toBe(
                false,
            );
        });
    });
});
