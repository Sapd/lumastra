// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test for security review 2026-09-13, C17 — the Subsonic dispatcher
 * interpolates the unauthenticated, attacker-controlled `method` path
 * segment straight into `logger.warn`/`logger.error` message strings.
 * SvelteKit decodes `%0D%0A` in route params, so an authenticated Subsonic
 * user can forge stdout log lines (CRLF injection) via a bogus method name.
 *
 * This exercises the real dispatcher (`GET` export of `+server.ts`) with a
 * VALID u/t/s auth (mocked at the parseSubsonicAuth seam, not re-testing
 * credential validation) and an injected method name, asserting the
 * response is Subsonic error code 70 (unknown method) and that whatever the
 * logger actually wrote to the console contains no literal CR/LF.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Type-only — erased at compile time, so this does NOT trigger the module's
// side effects ahead of the mocks below (the runtime GET is imported later,
// dynamically, inside the test, after vi.mock calls are hoisted).
import type { GET as SubsonicGetHandler, POST as SubsonicPostHandler } from './+server.js';
import { DEFAULT_MAX_BODY_BYTES } from '$lib/server/utils/bounded-body-reader.js';
import { parseSubsonicAuth } from '$lib/server/subsonic-compat/middleware.js';

const handlePing = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/subsonic-compat/handlers/stubs.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/subsonic-compat/handlers/stubs.js')>()),
    handlePing,
}));

const ORIGINAL_FEATURE_FLAG = process.env.FEATURE_SUBSONIC_COMPAT;

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({}) as unknown) },
}));

vi.mock('$lib/server/database/queries/user-ratings.queries.js', () => ({
    ensureUserProfileExists: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/subsonic-compat/middleware.js', () => ({
    getSubsonicFormat: (url: URL) => (url.searchParams.get('f') === 'json' ? 'json' : 'xml'),
    parseSubsonicAuth: vi.fn(async () => ({
        userId: '00000000-0000-0000-0000-000000000001',
        username: 'subsonicuser',
        isAdmin: false,
        displayName: null,
        clientName: 'test-client',
        format: 'xml',
        userGroups: [],
        maxAgeRating: null,
        isAgeRestricted: false,
    })),
    recordSubsonicAuthFailure: vi.fn(async () => new Response('auth failed', { status: 200 })),
}));

beforeEach(() => {
    process.env.FEATURE_SUBSONIC_COMPAT = 'true';
    vi.clearAllMocks();
    handlePing.mockReset().mockResolvedValue(new Response('<subsonic-response status="ok"/>'));
});

afterEach(() => {
    if (ORIGINAL_FEATURE_FLAG === undefined) {
        delete process.env.FEATURE_SUBSONIC_COMPAT;
    } else {
        process.env.FEATURE_SUBSONIC_COMPAT = ORIGINAL_FEATURE_FLAG;
    }
    vi.restoreAllMocks();
});

function makeEvent(rawMethodSegment: string): Parameters<typeof SubsonicGetHandler>[0] {
    // The route param is what SvelteKit hands the handler AFTER decoding —
    // %0D%0A in the URL arrives here as literal CR/LF characters.
    const url = new URL(
        `http://localhost/subsonic/rest/${encodeURIComponent(rawMethodSegment)}?u=subsonicuser&t=abc&s=def&f=xml`,
    );
    return {
        url,
        request: new Request(url),
        params: { path: rawMethodSegment },
        locals: {},
        getClientAddress: () => '203.0.113.5',
    } as unknown as Parameters<typeof SubsonicGetHandler>[0];
}

describe('C17 — Subsonic dispatcher does not let an injected method name forge a log line', () => {
    it('an unknown method containing CR/LF returns error code 70 and the console warn line has no literal CR/LF', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const { GET } = await import('./+server.js');
        const injected = 'x\r\ninjected';
        const response = await GET(makeEvent(`${injected}.view`));

        const body = await response.text();
        expect(body).toContain('code="70"');

        // Isolate the SubsonicCompat dispatcher's own warn line from any
        // unrelated startup noise (Cache/TmdbApi/etc. also warn during import).
        const dispatcherCalls = warnSpy.mock.calls
            .map((call) => call.join(' '))
            .filter((line) => line.includes('[SubsonicCompat]'));
        expect(dispatcherCalls.length).toBeGreaterThan(0);

        for (const line of dispatcherCalls) {
            // A literal CR or LF would split what should be ONE console line
            // into multiple lines (or inject a bogus stdout record) — the
            // fixed code must never emit either raw byte here, whether the
            // method ends up in the message or JSON-escaped inside `data`.
            expect(line).not.toContain('\r');
            expect(line).not.toContain('\n');
        }
        // The raw injected payload must never appear as literal CRLF bytes.
        const joined = dispatcherCalls.join('\n');
        expect(joined.includes('x\r\ninjected')).toBe(false);

        warnSpy.mockRestore();
    });
});

/**
 * C15 (2026-09-17 review 4) — the dispatcher's own POST body read (used to
 * find `u`/`p`/`t`/`s`/`apiKey` for legacy auth) was a bare
 * `event.request.text()` with no size bound, run BEFORE any credential is
 * checked. This exercises the real dispatcher's `POST` export with a
 * genuinely oversized `application/x-www-form-urlencoded` body and asserts
 * two things at the seam: the response is the codebase's standard oversize
 * response, and `parseSubsonicAuth` — the credential-checking step — was
 * never invoked, proving the rejection happens pre-auth rather than merely
 * returning some 4xx after authenticating.
 */
function makeSubsonicPostEvent(bodyByteLength: number): Parameters<typeof SubsonicPostHandler>[0] {
    const url = new URL('http://localhost/subsonic/rest/ping.view');
    // A legacy-auth form body carries u/p/t/s alongside whatever else the
    // method needs — pad it well past the cap with a single oversized field.
    const body = `u=subsonicuser&p=whatever&pad=${'a'.repeat(bodyByteLength)}`;
    const request = new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
    });
    return {
        url,
        request,
        params: { path: 'ping.view' },
        locals: {},
        getClientAddress: () => '203.0.113.6',
    } as unknown as Parameters<typeof SubsonicPostHandler>[0];
}

describe('C15 — Subsonic dispatcher bounds its own POST body read before authentication', () => {
    it('rejects a POST body over the cap with the standard oversize response and never calls parseSubsonicAuth', async () => {
        const { POST } = await import('./+server.js');
        const event = makeSubsonicPostEvent(DEFAULT_MAX_BODY_BYTES + 10_000);

        const response = await POST(event);

        expect(response.status).toBe(413);
        const body = await response.json();
        expect(body).toMatchObject({ error: expect.stringMatching(/payload too large/i) });

        // The seam: credential validation must never run for a rejected body.
        expect(parseSubsonicAuth).not.toHaveBeenCalled();
    });
});

// I3: inherited Object.prototype properties are not registered API methods.
describe('Subsonic dispatcher method lookup', () => {
    it.each(['toString', 'valueOf', 'constructor', '__proto__', 'hasOwnProperty'])(
        'returns the unknown-method error for %s',
        async (method) => {
            const { GET } = await import('./+server.js');
            const response = await GET(makeEvent(`${method}.view`));

            expect(response).toBeInstanceOf(Response);
            expect(response.status).toBe(200);
            expect(await response.text()).toContain('code="70"');
        },
    );

    it('rejects an inherited method through form-encoded POST', async () => {
        const { POST } = await import('./+server.js');
        const event = makeEvent('constructor.view');
        event.request = new Request(event.url, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'u=subsonicuser&t=abc&s=def',
        });
        const response = await POST(event);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('code="70"');
        expect(parseSubsonicAuth).toHaveBeenCalledOnce();
    });

    it('returns the structured JSON error for an inherited method', async () => {
        const { GET } = await import('./+server.js');
        const event = makeEvent('toString.view');
        event.url.searchParams.set('f', 'json');
        const auth = await vi.mocked(parseSubsonicAuth).getMockImplementation()!(event);
        vi.mocked(parseSubsonicAuth).mockResolvedValueOnce({ ...auth!, format: 'json' });
        const response = await GET(event);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            'subsonic-response': { status: 'failed', error: { code: 70 } },
        });
    });

    it('still dispatches a registered method', async () => {
        const { GET } = await import('./+server.js');
        const response = await GET(makeEvent('ping.view'));

        expect(response.status).toBe(200);
        expect(await response.text()).toContain('status="ok"');
    });
});

describe('authentication dependency outage', () => {
    it('returns HTTP 503 with a retryable Subsonic server error, not bad credentials', async () => {
        const { AuthDependencyUnavailableError } =
            await import('$lib/server/auth/dependency-unavailable.js');
        vi.mocked(parseSubsonicAuth).mockRejectedValueOnce(new AuthDependencyUnavailableError());
        const { GET } = await import('./+server.js');
        const response = await GET(makeEvent('ping.view'));
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('5');
        expect(await response.text()).toContain('code="0"');
    });
});

it('does not mark a dependency error after authentication as an auth outage', async () => {
    const { aiDbService } = await import('$lib/server/services/database.service.js');
    // First post-auth database acquisition: authentication itself has already succeeded.
    vi.mocked(aiDbService.getSql).mockRejectedValueOnce(
        Object.assign(new Error('handler database unavailable'), { code: 'ECONNRESET' }),
    );
    const { GET } = await import('./+server.js');
    const response = await GET(makeEvent('ping.view'));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(response.headers.has('X-Lumastra-Auth-Unavailable')).toBe(false);
});

it('leaves handler dependency failures unmarked even when the handler throws an auth dependency error', async () => {
    const { AuthDependencyUnavailableError } =
        await import('$lib/server/auth/dependency-unavailable.js');
    handlePing.mockRejectedValueOnce(new AuthDependencyUnavailableError());
    try {
        const { GET } = await import('./+server.js');
        const response = await GET(makeEvent('ping.view'));
        expect(response.status).toBe(503);
        expect(response.headers.has('X-Lumastra-Auth-Unavailable')).toBe(false);
    } finally {
        handlePing.mockReset();
    }
});
