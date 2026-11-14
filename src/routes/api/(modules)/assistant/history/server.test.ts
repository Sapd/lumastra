// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for GET /api/assistant/history.
 *
 * NOTE: This file is named server.test.ts (NOT +server.test.ts) — the `+`
 * prefix is reserved by SvelteKit for route files and breaks the vite build
 * if used on test files (even though svelte-check/eslint/vitest pass).
 *
 * All dependencies (db, query module, logger) are mocked so this runs
 * without a real Postgres connection. Covers:
 *   - 401 when unauthenticated
 *   - 503 when the DB is unavailable
 *   - limit clamping (below min, above max, default, and non-numeric)
 *   - 400 on an invalid `after` timestamp
 *   - `after` is parsed to a Date and threaded through to the query function
 *   - success shape: { messages: [...] }
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { UserContext } from '$lib/server/types';

// ---------------------------------------------------------------------------
// Module mocks — declared before importing the route module
// ---------------------------------------------------------------------------

const mockGetDb = vi.fn();
const mockGetRecentAssistantConversation = vi.fn();

vi.mock('$lib/server/database', () => ({
    getDb: () => mockGetDb(),
}));

vi.mock('$lib/server/database/queries/assistant.queries.js', () => ({
    getRecentAssistantConversation: (...args: unknown[]) =>
        mockGetRecentAssistantConversation(...args),
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
}));

vi.mock('$lib/server/middleware/error-handler', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));

vi.mock('$lib/server/utils/typed-response.js', () => ({
    typedJson: (_schema: unknown, data: unknown) =>
        new Response(JSON.stringify(data), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }),
}));

vi.mock('$lib/server/utils/api-responses', () => ({
    ApiResponses: {
        unauthorized: (msg: string) =>
            new Response(JSON.stringify({ error: msg }), { status: 401 }),
        serviceUnavailable: (svc: string) =>
            new Response(JSON.stringify({ error: `${svc} unavailable` }), { status: 503 }),
        badRequest: (msg: string, details?: string) =>
            new Response(JSON.stringify({ error: msg, details }), { status: 400 }),
        error: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 500 }),
    },
}));

// ---------------------------------------------------------------------------
// Import module AFTER mocks
// ---------------------------------------------------------------------------

const { GET } = await import('./+server.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_SQL = { fakeSqlTag: true };

type HistoryTracing = RequestEvent<
    Record<string, string>,
    '/api/(modules)/assistant/history'
>['tracing'];

// A fully-typed no-op OpenTelemetry span. SvelteKit's RequestEvent.tracing now
// types `root`/`current` as `Span` (not `undefined`), so a proper no-op span is
// the honest stand-in in tests that never enable tracing.
const noopSpan: HistoryTracing['root'] = {
    spanContext() {
        return { traceId: '', spanId: '', traceFlags: 0 };
    },
    setAttribute() {
        return this;
    },
    setAttributes() {
        return this;
    },
    addEvent() {
        return this;
    },
    addLink() {
        return this;
    },
    addLinks() {
        return this;
    },
    setStatus() {
        return this;
    },
    updateName() {
        return this;
    },
    end() {},
    isRecording() {
        return false;
    },
    recordException() {},
};

function makeEvent(
    params: Record<string, string> = {},
    opts: { authed?: boolean } = {},
): RequestEvent<Record<string, string>, '/api/(modules)/assistant/history'> {
    const url = new URL('http://localhost/api/assistant/history');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const authed = opts.authed ?? true;

    return {
        url,
        params: {},
        route: { id: '/api/(modules)/assistant/history' },
        request: new Request(url.toString()),
        locals: authed
            ? {
                  user: { username: 'alice', userId: 'usr-uuid-1' } as UserContext,
              }
            : { user: undefined },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        isRemoteRequest: false,
        setHeaders: vi.fn(),
        tracing: { enabled: false, root: noopSpan, current: noopSpan },
    } as RequestEvent<Record<string, string>, '/api/(modules)/assistant/history'>;
}

beforeEach(() => {
    mockGetDb.mockReset();
    mockGetRecentAssistantConversation.mockReset();
    mockGetDb.mockReturnValue(FAKE_SQL);
    mockGetRecentAssistantConversation.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/assistant/history — auth + service checks', () => {
    it('returns 401 when the request is unauthenticated', async () => {
        const res = await GET(makeEvent({}, { authed: false }));
        expect(res.status).toBe(401);
        expect(mockGetRecentAssistantConversation).not.toHaveBeenCalled();
    });

    it('returns 503 when the AI database is unavailable', async () => {
        mockGetDb.mockReturnValue(null);
        const res = await GET(makeEvent());
        expect(res.status).toBe(503);
        expect(mockGetRecentAssistantConversation).not.toHaveBeenCalled();
    });
});

describe('GET /api/assistant/history — limit clamping', () => {
    it('defaults to 50 when limit is omitted', async () => {
        await GET(makeEvent());
        expect(mockGetRecentAssistantConversation).toHaveBeenCalledWith(
            FAKE_SQL,
            'usr-uuid-1',
            expect.objectContaining({ limit: 50 }),
        );
    });

    it('clamps a limit above the max (100) down to 100', async () => {
        await GET(makeEvent({ limit: '9999' }));
        expect(mockGetRecentAssistantConversation).toHaveBeenCalledWith(
            FAKE_SQL,
            'usr-uuid-1',
            expect.objectContaining({ limit: 100 }),
        );
    });

    it('clamps a limit below the min (1) up to 1', async () => {
        await GET(makeEvent({ limit: '-5' }));
        expect(mockGetRecentAssistantConversation).toHaveBeenCalledWith(
            FAKE_SQL,
            'usr-uuid-1',
            expect.objectContaining({ limit: 1 }),
        );
    });

    it('falls back to the default when limit is non-numeric', async () => {
        await GET(makeEvent({ limit: 'not-a-number' }));
        expect(mockGetRecentAssistantConversation).toHaveBeenCalledWith(
            FAKE_SQL,
            'usr-uuid-1',
            expect.objectContaining({ limit: 50 }),
        );
    });

    it('accepts a valid in-range limit unchanged', async () => {
        await GET(makeEvent({ limit: '10' }));
        expect(mockGetRecentAssistantConversation).toHaveBeenCalledWith(
            FAKE_SQL,
            'usr-uuid-1',
            expect.objectContaining({ limit: 10 }),
        );
    });
});

describe('GET /api/assistant/history — `after` parameter', () => {
    it('omits `after` when not provided', async () => {
        await GET(makeEvent());
        expect(mockGetRecentAssistantConversation).toHaveBeenCalledWith(
            FAKE_SQL,
            'usr-uuid-1',
            expect.objectContaining({ after: undefined }),
        );
    });

    it('parses a valid ISO timestamp into a Date', async () => {
        await GET(makeEvent({ after: '2026-07-01T00:00:00.000Z' }));
        const call = mockGetRecentAssistantConversation.mock.calls[0];
        const opts = call[2] as { after?: Date };
        expect(opts.after).toBeInstanceOf(Date);
        expect(opts.after?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    });

    it('returns 400 on an invalid `after` timestamp', async () => {
        const res = await GET(makeEvent({ after: 'not-a-date' }));
        expect(res.status).toBe(400);
        expect(mockGetRecentAssistantConversation).not.toHaveBeenCalled();
    });
});

describe('GET /api/assistant/history — success shape', () => {
    it('returns { messages } from the query function', async () => {
        mockGetRecentAssistantConversation.mockResolvedValue([
            { role: 'user', content: 'hi', createdAt: '2026-07-01T00:00:00.000Z' },
            { role: 'assistant', content: 'hello', createdAt: '2026-07-01T00:00:01.000Z' },
        ]);

        const res = await GET(makeEvent());
        expect(res.status).toBe(200);
        const body = await res.clone().json();
        expect(body.messages).toHaveLength(2);
        expect(body.messages[0]).toEqual({
            role: 'user',
            content: 'hi',
            createdAt: '2026-07-01T00:00:00.000Z',
        });
    });
});
