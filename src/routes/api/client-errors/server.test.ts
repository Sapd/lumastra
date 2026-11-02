// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for POST /api/client-errors — the server end of the rendered errorId.
 *
 * Two properties carry the weight here and neither is visible from the caller,
 * which is why they need tests rather than a manual poke:
 *
 *   1. The endpoint ALWAYS answers 204. It is called by `sendBeacon`, which
 *      cannot read a response; a 4xx would only teach a browser to retry and
 *      would turn the route into an oracle. So "rejected" and "recorded" must be
 *      indistinguishable on the wire and distinguishable only in the log.
 *   2. No query string ever reaches the log. Search terms on this app are user
 *      content, and the log is the one place they must not accumulate.
 *
 * Run: npx vitest run src/routes/api/client-errors/server.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const rateLimit = vi.hoisted(() => ({ allowed: true }));
const logged: Array<{ msg: string; ctx: Record<string, unknown> }> = vi.hoisted(() => []);

vi.mock('$lib/server/middleware/error-handler', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({
        allowed: rateLimit.allowed,
        remaining: 0,
        resetAt: 0,
    })),
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({
            error: (msg: string, ctx: Record<string, unknown>) => logged.push({ msg, ctx }),
            warn: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

vi.mock('$lib/server/services/client-diagnostics/ingest.service.js', () => ({
    recordJsErrorFromLegacy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: vi.fn(() => ({})) }));

import { POST } from './+server.js';

type PostEvent = Parameters<typeof POST>[0];

function makeEvent(body: string): PostEvent {
    return {
        request: new Request('http://localhost/api/client-errors', { method: 'POST', body }),
        locals: { user: { userId: 'u-1', username: 'alice' } },
    } as unknown as PostEvent;
}

/** The one shape a real client sends. */
function validBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        errorId: 'abc-123',
        routeId: '/watch/[itemId]',
        status: 500,
        name: 'TypeError',
        message: 'x is not a function',
        stack: 'TypeError: x is not a function\n    at foo',
        url: '/watch/42',
        ...overrides,
    });
}

beforeEach(() => {
    logged.length = 0;
    rateLimit.allowed = true;
    vi.clearAllMocks();
});

describe('POST /api/client-errors', () => {
    it('records a well-formed report under its errorId', async () => {
        const resp = await POST(makeEvent(validBody()));

        expect(resp.status).toBe(204);
        expect(logged).toHaveLength(1);
        expect(logged[0].ctx.errorId).toBe('abc-123');
        expect(logged[0].ctx.routeId).toBe('/watch/[itemId]');
        expect(logged[0].ctx.userId).toBe('u-1');
        expect(logged[0].ctx.message).toBe('x is not a function');
    });

    it('answers 204 and records nothing for a rate-limited caller', async () => {
        rateLimit.allowed = false;
        const resp = await POST(makeEvent(validBody()));

        // Load-bearing on both halves: a 429 would be visible to nobody and
        // would invite a retry, and a recorded entry would defeat the limit.
        expect(resp.status).toBe(204);
        expect(logged).toHaveLength(0);
    });

    it('answers 204 and records nothing for a body that is not JSON', async () => {
        const resp = await POST(makeEvent('not json at all'));
        expect(resp.status).toBe(204);
        expect(logged).toHaveLength(0);
    });

    it('answers 204 and records nothing when errorId is missing', async () => {
        // A report with no id cannot be correlated with anything, which is the
        // entire point of the endpoint.
        const resp = await POST(makeEvent(JSON.stringify({ message: 'orphan' })));
        expect(resp.status).toBe(204);
        expect(logged).toHaveLength(0);
    });

    it('answers 204 and records nothing for an oversized body', async () => {
        const resp = await POST(makeEvent(validBody({ stack: 'x'.repeat(20_000) })));
        expect(resp.status).toBe(204);
        expect(logged).toHaveLength(0);
    });

    it('strips a query string the client failed to strip', async () => {
        const resp = await POST(makeEvent(validBody({ url: '/search?q=something+private' })));

        expect(resp.status).toBe(204);
        expect(logged[0].ctx.path).toBe('/search');
        expect(JSON.stringify(logged[0].ctx)).not.toContain('something+private');
    });

    it('strips the query from an absolute URL too', async () => {
        const resp = await POST(
            makeEvent(validBody({ url: 'https://media.example.com/search?q=private' })),
        );

        expect(logged[0].ctx.path).toBe('/search');
        expect(JSON.stringify(logged[0].ctx)).not.toContain('private');
        expect(resp.status).toBe(204);
    });

    it('truncates an overlong message instead of dropping the report', async () => {
        // A 600-char message is still a usable report; losing it entirely is not.
        await POST(makeEvent(validBody({ message: 'm'.repeat(600) })));

        const message = logged[0].ctx.message as string;
        expect(message.length).toBeLessThan(600);
        expect(message).toContain('[truncated]');
    });

    it('nulls fields it cannot use rather than logging junk', async () => {
        await POST(
            makeEvent(JSON.stringify({ errorId: 'abc-123', status: 'not-a-number', routeId: 42 })),
        );

        expect(logged).toHaveLength(1);
        expect(logged[0].ctx.status).toBeNull();
        expect(logged[0].ctx.routeId).toBeNull();
        expect(logged[0].ctx.message).toBeNull();
    });

    it('falls back to a stable user marker when locals carry no user', async () => {
        const event = {
            request: new Request('http://localhost/api/client-errors', {
                method: 'POST',
                body: validBody(),
            }),
            locals: {},
        } as unknown as PostEvent;

        const resp = await POST(event);
        expect(resp.status).toBe(204);
        expect(logged[0].ctx.userId).toBe('unknown');
    });

    it('also records the report as a js_error diagnostic (keeps the server log line)', async () => {
        const { recordJsErrorFromLegacy } =
            await import('$lib/server/services/client-diagnostics/ingest.service.js');

        const resp = await POST(
            makeEvent(
                validBody({
                    errorId: 'e1',
                    name: 'TypeError',
                    message: 'm',
                    stack: 's',
                    url: '/browse?q=secret',
                }),
            ),
        );

        expect(resp.status).toBe(204);
        expect(logged).toHaveLength(1);
        expect(recordJsErrorFromLegacy).toHaveBeenCalledWith(expect.anything(), 'u-1', {
            errorId: 'e1',
            name: 'TypeError',
            message: 'm',
            stack: 's',
            path: '/browse',
            appVersion: undefined,
        });
    });

    it('passes the reporting tab build through as the diagnostic appVersion', async () => {
        const { recordJsErrorFromLegacy } =
            await import('$lib/server/services/client-diagnostics/ingest.service.js');

        await POST(makeEvent(validBody({ errorId: 'e2', version: '0.1.0-1790801234567' })));

        expect(recordJsErrorFromLegacy).toHaveBeenLastCalledWith(
            expect.anything(),
            'u-1',
            expect.objectContaining({ errorId: 'e2', appVersion: '0.1.0-1790801234567' }),
        );
    });

    it('does not record a diagnostic when there is no real user id', async () => {
        const { recordJsErrorFromLegacy } =
            await import('$lib/server/services/client-diagnostics/ingest.service.js');
        const event = {
            request: new Request('http://localhost/api/client-errors', {
                method: 'POST',
                body: validBody(),
            }),
            locals: {},
        } as unknown as PostEvent;

        const resp = await POST(event);

        expect(resp.status).toBe(204);
        expect(recordJsErrorFromLegacy).not.toHaveBeenCalled();
    });

    it('still answers 204 and keeps the log line when recording the diagnostic fails', async () => {
        const { recordJsErrorFromLegacy } =
            await import('$lib/server/services/client-diagnostics/ingest.service.js');
        vi.mocked(recordJsErrorFromLegacy).mockRejectedValueOnce(new Error('db down'));

        const resp = await POST(makeEvent(validBody()));

        expect(resp.status).toBe(204);
        expect(logged).toHaveLength(1);
    });
});
