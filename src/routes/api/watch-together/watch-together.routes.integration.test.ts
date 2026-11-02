// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together Routes Integration Tests
 *
 * Tests SvelteKit route handlers directly by importing them and invoking with
 * mock RequestEvent objects. Valkey is replaced by an in-memory store.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
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
            new Response(
                JSON.stringify({
                    success: true,
                    data: [],
                    message: 'Widget disabled by administrator',
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
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

describe.runIf(RUN)('Watch Together route integration tests', () => {
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
        await sql`DELETE FROM media_items WHERE title LIKE 'WT Route%'`;
        await sql`DELETE FROM users WHERE username LIKE 'wt-route-%'`;
        // The C8 reserved-username DELETE test inserts a literal 'system' row.
        await sql`DELETE FROM users WHERE username = 'system'`;
        vi.clearAllMocks();
    });

    async function insertUser(username: string) {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO users (id, username, display_name, is_admin, max_age_rating)
            VALUES (${id}::uuid, ${username}, ${'Display ' + username}, false, null)
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
            VALUES (${id}::uuid, ${'movie'}, ${'WT Route Movie'}, ${'Overview'}, ${'active'}, true, NOW())
        `;
        return id;
    }

    function mockEvent(opts: {
        url?: URL;
        method?: string;
        body?: Record<string, unknown>;
        params?: Record<string, string>;
        user?: Record<string, unknown>;
    }): RequestEvent {
        const url = opts.url ?? new URL('http://localhost');
        const request = new Request(url.toString(), {
            method: opts.method ?? 'GET',
            body: opts.body ? JSON.stringify(opts.body) : undefined,
            headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
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

    // -----------------------------------------------------------------------
    // 1. POST /api/watch-together
    // -----------------------------------------------------------------------

    describe('POST /api/watch-together', () => {
        it('returns 401 when no user', async () => {
            const { POST } = await import('./parties/+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: 'abc',
                        mediaType: 'movie',
                        title: 'Test',
                        clientId: 'c1',
                    },
                }) as Parameters<typeof POST>[0],
            );
            expect(res.status).toBe(401);
        });

        it('creates session successfully with valid input', async () => {
            const user = await insertUser('wt-route-host');
            const mediaId = await insertMedia();

            const { POST } = await import('./parties/+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user,
                }) as Parameters<typeof POST>[0],
            );

            expect(res.status).toBe(201);
            const body = await parseJson<Record<string, unknown>>(res);
            expect(typeof (body.party as Record<string, unknown>)?.code).toBe('string');
            expect(body.party).toMatchObject({
                host: { userId: user.id, displayName: 'Display ' + user.username },
                visibility: 'unlisted',
                participants: [
                    expect.objectContaining({
                        userId: user.id,
                        displayName: 'Display ' + user.username,
                    }),
                ],
            });
            const { getAllSessions } = await import('$lib/server/services/watch-together.service');
            expect(await getAllSessions()).toEqual([]);
        });
    });

    // -----------------------------------------------------------------------
    // 2. GET /api/watch-together
    // -----------------------------------------------------------------------

    describe('GET /api/watch-together', () => {
        it('returns null when no active session', async () => {
            const user = await insertUser('wt-route-get-none');

            const { GET } = await import('./+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    user,
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(200);
            const body = await parseJson<Record<string, unknown>>(res);
            expect(body.party).toBeNull();
        });

        it('returns session when user has active session', async () => {
            const user = await insertUser('wt-route-get-active');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            const { GET } = await import('./+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            if (!GET) throw new Error('GET handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const res = await GET(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    user,
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(200);
            const body = await parseJson<Record<string, unknown>>(res);
            expect((body.party as Record<string, unknown>)?.code).toBe(code);
        });
    });

    // -----------------------------------------------------------------------
    // 3. POST /api/watch-together/[code]/sync
    // -----------------------------------------------------------------------

    describe('POST /api/watch-together/[code]/sync', () => {
        it('returns 401 when unauthorized', async () => {
            const { POST } = await import('./[code]/sync/+server.js');
            if (!POST) throw new Error('POST handler is not defined');
            const res = await POST(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together/ABC/sync'),
                    method: 'POST',
                    body: {
                        currentTime: 0,
                        isPlaying: true,
                        playbackRate: 1,
                        clientId: 'c1',
                    },
                    params: { code: 'ABC' },
                }) as Parameters<typeof POST>[0],
            );
            expect(res.status).toBe(401);
        });

        it('guest can sync play/pause state', async () => {
            const host = await insertUser('wt-route-sync-host');
            const guest = await insertUser('wt-route-sync-guest');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
            const { POST: joinPost } = await import('./[code]/join/+server.js');
            if (!joinPost) throw new Error('joinPost handler is not defined');
            await joinPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/join`),
                    method: 'POST',
                    body: { clientId: 'guest-client-1' },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof joinPost>[0],
            );
            vi.useRealTimers();

            const { POST: syncPost } = await import('./[code]/sync/+server.js');
            if (!syncPost) throw new Error('syncPost handler is not defined');
            const res = await syncPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/sync`),
                    method: 'POST',
                    body: {
                        currentTime: 0,
                        isPlaying: true,
                        playbackRate: 1,
                        clientId: 'guest-client-1',
                    },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof syncPost>[0],
            );

            expect(res.status).toBe(204);
        });

        it('returns 403 for non-participant', async () => {
            const host = await insertUser('wt-route-sync-host2');
            const intruder = await insertUser('wt-route-sync-intruder');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: syncPost } = await import('./[code]/sync/+server.js');
            if (!syncPost) throw new Error('syncPost handler is not defined');
            const res = await syncPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/sync`),
                    method: 'POST',
                    body: {
                        currentTime: 0,
                        isPlaying: true,
                        playbackRate: 1,
                        clientId: 'intruder-client',
                    },
                    params: { code },
                    user: intruder,
                }) as Parameters<typeof syncPost>[0],
            );

            expect(res.status).toBe(403);
        });
    });

    // -----------------------------------------------------------------------
    // 4. POST /api/watch-together/[code]/seek
    // -----------------------------------------------------------------------

    describe('POST /api/watch-together/[code]/seek', () => {
        it('participant can seek', async () => {
            const host = await insertUser('wt-route-seek-host');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
            const { POST: seekPost } = await import('./[code]/seek/+server.js');
            if (!seekPost) throw new Error('seekPost handler is not defined');
            const res = await seekPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/seek`),
                    method: 'POST',
                    body: { currentTime: 30, clientId: 'host-client-1', isPlaying: true },
                    params: { code },
                    user: host,
                }) as Parameters<typeof seekPost>[0],
            );
            vi.useRealTimers();

            expect(res.status).toBe(204);
        });

        it('rejects seek without the current play state', async () => {
            const host = await insertUser('wt-route-seek-missing-state');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: seekPost } = await import('./[code]/seek/+server.js');
            if (!seekPost) throw new Error('seekPost handler is not defined');
            const res = await seekPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/seek`),
                    method: 'POST',
                    body: { currentTime: 30, clientId: 'host-client-1' },
                    params: { code },
                    user: host,
                }) as Parameters<typeof seekPost>[0],
            );

            expect(res.status).toBe(422);
        });

        it('returns 403 for non-participant', async () => {
            const host = await insertUser('wt-route-seek-host2');
            const intruder = await insertUser('wt-route-seek-intruder');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: seekPost } = await import('./[code]/seek/+server.js');
            if (!seekPost) throw new Error('seekPost handler is not defined');
            const res = await seekPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/seek`),
                    method: 'POST',
                    body: { currentTime: 30, clientId: 'intruder-client', isPlaying: true },
                    params: { code },
                    user: intruder,
                }) as Parameters<typeof seekPost>[0],
            );

            expect(res.status).toBe(403);
        });
    });

    // -----------------------------------------------------------------------
    // 5. POST /api/watch-together/[code]/stall
    // -----------------------------------------------------------------------

    describe('POST /api/watch-together/[code]/stall', () => {
        it('participant can report stall', async () => {
            const host = await insertUser('wt-route-stall-host');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: stallPost } = await import('./[code]/stall/+server.js');
            if (!stallPost) throw new Error('stallPost handler is not defined');
            const res = await stallPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/stall`),
                    method: 'POST',
                    body: { clientId: 'host-client-1', stallId: 'stall-1' },
                    params: { code },
                    user: host,
                }) as Parameters<typeof stallPost>[0],
            );

            expect(res.status).toBe(204);
        });

        it('rejects a stall without a generation id', async () => {
            const host = await insertUser('wt-route-stall-missing-id');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: stallPost } = await import('./[code]/stall/+server.js');
            if (!stallPost) throw new Error('stallPost handler is not defined');
            const res = await stallPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/stall`),
                    method: 'POST',
                    body: { clientId: 'host-client-1' },
                    params: { code },
                    user: host,
                }) as Parameters<typeof stallPost>[0],
            );

            expect(res.status).toBe(422);
        });

        it('returns 404 for invalid session', async () => {
            const user = await insertUser('wt-route-stall-user');

            const { POST: stallPost } = await import('./[code]/stall/+server.js');
            if (!stallPost) throw new Error('stallPost handler is not defined');
            const res = await stallPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together/INVALID/stall'),
                    method: 'POST',
                    body: { clientId: 'c1', stallId: 'stall-1' },
                    params: { code: 'INVALID' },
                    user,
                }) as Parameters<typeof stallPost>[0],
            );

            expect(res.status).toBe(404);
        });

        it('returns 403 for non-participant', async () => {
            const host = await insertUser('wt-route-stall-host2');
            const intruder = await insertUser('wt-route-stall-intruder');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: stallPost } = await import('./[code]/stall/+server.js');
            if (!stallPost) throw new Error('stallPost handler is not defined');
            const res = await stallPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/stall`),
                    method: 'POST',
                    body: { clientId: 'intruder-client', stallId: 'stall-1' },
                    params: { code },
                    user: intruder,
                }) as Parameters<typeof stallPost>[0],
            );

            expect(res.status).toBe(403);
        });
    });

    // -----------------------------------------------------------------------
    // 6. POST /api/watch-together/[code]/stall-ready
    // -----------------------------------------------------------------------

    describe('POST /api/watch-together/[code]/stall-ready', () => {
        it('participant can report stall-ready', async () => {
            const host = await insertUser('wt-route-sr-host');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: srPost } = await import('./[code]/stall-ready/+server.js');
            if (!srPost) throw new Error('srPost handler is not defined');
            const res = await srPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/stall-ready`),
                    method: 'POST',
                    body: { clientId: 'host-client-1', stallId: 'stall-1' },
                    params: { code },
                    user: host,
                }) as Parameters<typeof srPost>[0],
            );

            expect(res.status).toBe(204);
        });

        it('returns 403 for non-participant', async () => {
            const host = await insertUser('wt-route-sr-host2');
            const intruder = await insertUser('wt-route-sr-intruder');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: srPost } = await import('./[code]/stall-ready/+server.js');
            if (!srPost) throw new Error('srPost handler is not defined');
            const res = await srPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/stall-ready`),
                    method: 'POST',
                    body: { clientId: 'intruder-client', stallId: 'stall-1' },
                    params: { code },
                    user: intruder,
                }) as Parameters<typeof srPost>[0],
            );

            expect(res.status).toBe(403);
        });
    });

    // -----------------------------------------------------------------------
    // 7. POST /api/watch-together/[code]/ready
    // -----------------------------------------------------------------------

    describe('POST /api/watch-together/[code]/ready', () => {
        it('participant can signal ready', async () => {
            const host = await insertUser('wt-route-ready-host');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: readyPost } = await import('./[code]/ready/+server.js');
            if (!readyPost) throw new Error('readyPost handler is not defined');
            const res = await readyPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/ready`),
                    method: 'POST',
                    body: { clientId: 'host-client-1', checkId: 'check-1' },
                    params: { code },
                    user: host,
                }) as Parameters<typeof readyPost>[0],
            );

            expect(res.status).toBe(204);
        });

        it('rejects ready without a buffer-check generation id', async () => {
            const host = await insertUser('wt-route-ready-missing-id');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: readyPost } = await import('./[code]/ready/+server.js');
            if (!readyPost) throw new Error('readyPost handler is not defined');
            const res = await readyPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/ready`),
                    method: 'POST',
                    body: { clientId: 'host-client-1' },
                    params: { code },
                    user: host,
                }) as Parameters<typeof readyPost>[0],
            );

            expect(res.status).toBe(422);
        });

        it('host passes currentTime', async () => {
            const host = await insertUser('wt-route-ready-host2');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: readyPost } = await import('./[code]/ready/+server.js');
            if (!readyPost) throw new Error('readyPost handler is not defined');
            const res = await readyPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/ready`),
                    method: 'POST',
                    body: { clientId: 'host-client-1', checkId: 'check-1', currentTime: 42 },
                    params: { code },
                    user: host,
                }) as Parameters<typeof readyPost>[0],
            );

            expect(res.status).toBe(204);
        });
    });

    // -----------------------------------------------------------------------
    // 8. POST /api/watch-together/[code]/transfer-host
    // -----------------------------------------------------------------------

    describe('POST /api/watch-together/[code]/transfer-host', () => {
        it('host can transfer to another participant', async () => {
            const host = await insertUser('wt-route-th-host');
            const guest = await insertUser('wt-route-th-guest');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
            const { POST: joinPost } = await import('./[code]/join/+server.js');
            if (!joinPost) throw new Error('joinPost handler is not defined');
            await joinPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/join`),
                    method: 'POST',
                    body: { clientId: 'guest-client-1' },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof joinPost>[0],
            );
            vi.useRealTimers();

            const { POST: transferPost } = await import('./[code]/transfer-host/+server.js');
            if (!transferPost) throw new Error('transferPost handler is not defined');
            const res = await transferPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/transfer-host`),
                    method: 'POST',
                    body: { newHostUserId: guest.id },
                    params: { code },
                    user: host,
                }) as Parameters<typeof transferPost>[0],
            );

            expect(res.status).toBe(204);
        });

        it('non-host cannot transfer', async () => {
            const host = await insertUser('wt-route-th-host2');
            const guest = await insertUser('wt-route-th-guest2');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
            const { POST: joinPost } = await import('./[code]/join/+server.js');
            if (!joinPost) throw new Error('joinPost handler is not defined');
            await joinPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/join`),
                    method: 'POST',
                    body: { clientId: 'guest-client-1' },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof joinPost>[0],
            );
            vi.useRealTimers();

            const { POST: transferPost } = await import('./[code]/transfer-host/+server.js');
            if (!transferPost) throw new Error('transferPost handler is not defined');
            const res = await transferPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/transfer-host`),
                    method: 'POST',
                    body: { newHostUserId: host.id },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof transferPost>[0],
            );

            expect(res.status).toBe(403);
        });

        it('cannot transfer to self', async () => {
            const host = await insertUser('wt-route-th-host3');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: transferPost } = await import('./[code]/transfer-host/+server.js');
            if (!transferPost) throw new Error('transferPost handler is not defined');
            const res = await transferPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/transfer-host`),
                    method: 'POST',
                    body: { newHostUserId: host.id },
                    params: { code },
                    user: host,
                }) as Parameters<typeof transferPost>[0],
            );

            expect(res.status).toBe(403);
        });

        it('cannot transfer to non-participant', async () => {
            const host = await insertUser('wt-route-th-host4');
            const outsider = await insertUser('wt-route-th-outsider');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: transferPost } = await import('./[code]/transfer-host/+server.js');
            if (!transferPost) throw new Error('transferPost handler is not defined');
            const res = await transferPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/transfer-host`),
                    method: 'POST',
                    body: { newHostUserId: outsider.id },
                    params: { code },
                    user: host,
                }) as Parameters<typeof transferPost>[0],
            );

            expect(res.status).toBe(403);
        });
    });

    // -----------------------------------------------------------------------
    // 9. POST /api/watch-together/[code]/navigate
    // -----------------------------------------------------------------------

    describe('POST /api/watch-together/[code]/navigate', () => {
        it('participant can navigate to new media', async () => {
            const host = await insertUser('wt-route-nav-host');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: navPost } = await import('./[code]/navigate/+server.js');
            if (!navPost) throw new Error('navPost handler is not defined');
            const res = await navPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/navigate`),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie 2',
                        clientId: 'host-client-1',
                    },
                    params: { code },
                    user: host,
                }) as Parameters<typeof navPost>[0],
            );

            expect(res.status).toBe(204);
        });

        it('returns 403 for non-participant', async () => {
            const host = await insertUser('wt-route-nav-host2');
            const intruder = await insertUser('wt-route-nav-intruder');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: navPost } = await import('./[code]/navigate/+server.js');
            if (!navPost) throw new Error('navPost handler is not defined');
            const res = await navPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/navigate`),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'intruder-client',
                    },
                    params: { code },
                    user: intruder,
                }) as Parameters<typeof navPost>[0],
            );

            expect(res.status).toBe(403);
        });

        // security review 2026-09-12, C11: the REST route used to broadcast a
        // navigate from ANY participant, not just the host — the two "host for
        // both roles" cases above never exercised that gap.
        it('returns 403 for a joined non-host participant (host-only gate)', async () => {
            const host = await insertUser('wt-route-nav-host3');
            const guest = await insertUser('wt-route-nav-guest3');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
            const { POST: joinPost } = await import('./[code]/join/+server.js');
            if (!joinPost) throw new Error('joinPost handler is not defined');
            await joinPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/join`),
                    method: 'POST',
                    body: { clientId: 'guest-client-3' },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof joinPost>[0],
            );
            vi.useRealTimers();

            const { POST: navPost } = await import('./[code]/navigate/+server.js');
            if (!navPost) throw new Error('navPost handler is not defined');
            const res = await navPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/navigate`),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie 2',
                        clientId: 'guest-client-3',
                    },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof navPost>[0],
            );

            expect(res.status).toBe(403);
        });
    });

    // -----------------------------------------------------------------------
    // 10. POST /api/watch-together/[code]/join
    // -----------------------------------------------------------------------

    describe('POST /api/watch-together/[code]/join', () => {
        it('can join existing session', async () => {
            const host = await insertUser('wt-route-join-host');
            const guest = await insertUser('wt-route-join-guest');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
            const { POST: joinPost } = await import('./[code]/join/+server.js');
            if (!joinPost) throw new Error('joinPost handler is not defined');
            const res = await joinPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/join`),
                    method: 'POST',
                    body: { clientId: 'guest-client-1' },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof joinPost>[0],
            );
            vi.useRealTimers();

            expect(res.status).toBe(200);
            const body = await parseJson<Record<string, unknown>>(res);
            const participants = (body.party as Record<string, unknown>)?.participants as
                Array<Record<string, unknown>> | undefined;
            expect(participants?.length).toBeGreaterThan(1);
        });

        it('returns 404 for invalid code', async () => {
            const guest = await insertUser('wt-route-join-guest2');

            const { POST: joinPost } = await import('./[code]/join/+server.js');
            if (!joinPost) throw new Error('joinPost handler is not defined');
            const res = await joinPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together/INVALID/join'),
                    method: 'POST',
                    body: { clientId: 'guest-client-1' },
                    params: { code: 'INVALID' },
                    user: guest,
                }) as Parameters<typeof joinPost>[0],
            );

            expect(res.status).toBe(404);
        });
    });

    // -----------------------------------------------------------------------
    // 11. POST /api/watch-together/[code]/leave
    // -----------------------------------------------------------------------

    describe('POST /api/watch-together/[code]/leave', () => {
        it('participant can leave', async () => {
            const host = await insertUser('wt-route-leave-host');
            const guest = await insertUser('wt-route-leave-guest');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
            const { POST: joinPost } = await import('./[code]/join/+server.js');
            if (!joinPost) throw new Error('joinPost handler is not defined');
            await joinPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/join`),
                    method: 'POST',
                    body: { clientId: 'guest-client-1' },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof joinPost>[0],
            );
            vi.useRealTimers();

            const { POST: leavePost } = await import('./[code]/leave/+server.js');
            if (!leavePost) throw new Error('leavePost handler is not defined');
            const res = await leavePost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/leave`),
                    method: 'POST',
                    body: { clientId: 'guest-client-1' },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof leavePost>[0],
            );

            expect(res.status).toBe(204);
        });

        it('returns success even if already left', async () => {
            const host = await insertUser('wt-route-leave-host2');
            const guest = await insertUser('wt-route-leave-guest2');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
            const { POST: joinPost } = await import('./[code]/join/+server.js');
            if (!joinPost) throw new Error('joinPost handler is not defined');
            await joinPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/join`),
                    method: 'POST',
                    body: { clientId: 'guest-client-1' },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof joinPost>[0],
            );
            vi.useRealTimers();

            const { POST: leavePost } = await import('./[code]/leave/+server.js');
            if (!leavePost) throw new Error('leavePost handler is not defined');
            const first = await leavePost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/leave`),
                    method: 'POST',
                    body: { clientId: 'guest-client-1' },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof leavePost>[0],
            );
            expect(first.status).toBe(204);

            const second = await leavePost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/leave`),
                    method: 'POST',
                    body: { clientId: 'guest-client-1' },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof leavePost>[0],
            );
            expect(second.status).toBe(204);
        });
    });

    // -----------------------------------------------------------------------
    // 12. POST /api/watch-together/[code]/version
    // -----------------------------------------------------------------------

    describe('POST /api/watch-together/[code]/version', () => {
        it('returns 403 for non-participant', async () => {
            const host = await insertUser('wt-route-ver-host');
            const intruder = await insertUser('wt-route-ver-intruder');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: versionPost } = await import('./[code]/version/+server.js');
            if (!versionPost) throw new Error('versionPost handler is not defined');
            const res = await versionPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/version`),
                    method: 'POST',
                    body: { fileId: 'file-123', clientId: 'intruder-client' },
                    params: { code },
                    user: intruder,
                }) as Parameters<typeof versionPost>[0],
            );

            expect(res.status).toBe(403);
        });
    });

    // -----------------------------------------------------------------------
    // 13. POST /api/watch-together/[code]/visibility
    // -----------------------------------------------------------------------

    describe('POST /api/watch-together/[code]/visibility', () => {
        it('host can toggle visibility', async () => {
            const host = await insertUser('wt-route-vis-host');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { POST: visPost } = await import('./[code]/visibility/+server.js');
            if (!visPost) throw new Error('visPost handler is not defined');
            const res = await visPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/visibility`),
                    method: 'POST',
                    body: { visibility: 'unlisted' },
                    params: { code },
                    user: host,
                }) as Parameters<typeof visPost>[0],
            );

            expect(res.status).toBe(204);
        });

        it('non-host cannot toggle', async () => {
            const host = await insertUser('wt-route-vis-host2');
            const guest = await insertUser('wt-route-vis-guest');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
            const { POST: joinPost } = await import('./[code]/join/+server.js');
            if (!joinPost) throw new Error('joinPost handler is not defined');
            await joinPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/join`),
                    method: 'POST',
                    body: { clientId: 'guest-client-1' },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof joinPost>[0],
            );
            vi.useRealTimers();

            const { POST: visPost } = await import('./[code]/visibility/+server.js');
            if (!visPost) throw new Error('visPost handler is not defined');
            const res = await visPost(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}/visibility`),
                    method: 'POST',
                    body: { visibility: 'unlisted' },
                    params: { code },
                    user: guest,
                }) as Parameters<typeof visPost>[0],
            );

            expect(res.status).toBe(403);
        });
    });

    // -----------------------------------------------------------------------
    // 14. DELETE /api/watch-together/[code] — C8: reserved "system" username
    // -----------------------------------------------------------------------
    //
    // Regression test for the endSession host-only fix (security review
    // 2026-09-13, C8): endSession() used to treat userId === 'system' as an
    // in-band escape from its host-only check, so a REAL account named
    // `system` could end ANY party. This drives the actual mounted route
    // handler (the "mount seam") — the def just forwards `user.username`
    // straight into endSession() with no host check of its own, so the fix
    // has to live in endSession() itself for this to pass.
    //
    // NOTE: the v1 surface (`/api/v1/watch-together/[code]`) deliberately
    // does not mount DELETE at all (see that route's +server.ts) — DELETE is
    // internal-surface only, so this is the one mount there is to test.

    describe('DELETE /api/watch-together/[code] — reserved "system" username (C8)', () => {
        it('403s a "system"-named account trying to end a session it does not host, and leaves it intact', async () => {
            const host = await insertUser('wt-route-c8-host');
            const systemNamedUser = await insertUser('system');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { DELETE: deleteHandler } = await import('./[code]/+server.js');
            if (!deleteHandler) throw new Error('DELETE handler is not defined');
            const res = await deleteHandler(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}`),
                    method: 'DELETE',
                    params: { code },
                    user: systemNamedUser,
                }) as Parameters<typeof deleteHandler>[0],
            );

            expect(res.status).toBe(403);

            // Session must still exist — it was NOT torn down.
            const { GET: getHandler } = await import('./[code]/+server.js');
            if (!getHandler) throw new Error('GET handler is not defined');
            const getRes = await getHandler(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}`),
                    method: 'GET',
                    params: { code },
                    user: host,
                }) as Parameters<typeof getHandler>[0],
            );
            expect(getRes.status).toBe(200);
        });

        it('sanity: the real host can still end their own session', async () => {
            const host = await insertUser('wt-route-c8-host2');
            const mediaId = await insertMedia();

            const { POST: createPost } = await import('./parties/+server.js');
            if (!createPost) throw new Error('createPost handler is not defined');
            const createRes = await createPost(
                mockEvent({
                    url: new URL('http://localhost/api/watch-together'),
                    method: 'POST',
                    body: {
                        itemId: mediaId,
                        mediaType: 'movie',
                        title: 'WT Route Movie',
                        clientId: 'host-client-1',
                    },
                    user: host,
                }) as Parameters<typeof createPost>[0],
            );
            const createBody = await parseJson<Record<string, unknown>>(createRes);
            const code = (createBody.party as Record<string, unknown>).code as string;

            const { DELETE: deleteHandler } = await import('./[code]/+server.js');
            if (!deleteHandler) throw new Error('DELETE handler is not defined');
            const res = await deleteHandler(
                mockEvent({
                    url: new URL(`http://localhost/api/watch-together/${code}`),
                    method: 'DELETE',
                    params: { code },
                    user: host,
                }) as Parameters<typeof deleteHandler>[0],
            );

            expect(res.status).toBe(204);
        });
    });
});
