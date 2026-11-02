// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for edge-probes.ts.
 *
 * Covers:
 *  1. evaluateForwardAuthReflection — the pure verdict function (pass / fail cases).
 *  2. runEdgeProbes with null baseUrl → all probes skipped.
 *  3. The fwd-auth-stripped probe end-to-end against a mocked fetch (pass and fail verdicts).
 *  4. edge.hsts probe against a mocked fetch (pass and missing).
 *  5. token.bad-bearer probe against a mocked fetch (pass and warn).
 *  6. Unreachable edge → skipped (not fail) for edge.hsts.
 *
 * Do NOT execute this file directly — it is picked up by the project's vitest config.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateForwardAuthReflection, runEdgeProbes } from './edge-probes';

// ── 1. Pure verdict function ──────────────────────────────────────────────────

describe('evaluateForwardAuthReflection', () => {
    it('returns pass when received is empty (edge stripped all headers)', () => {
        const result = evaluateForwardAuthReflection([]);
        expect(result.status).toBe('pass');
        expect(result.detail).toMatch(/stripped/i);
    });

    it('returns fail when received contains a forward-auth header name', () => {
        const result = evaluateForwardAuthReflection(['x-authentik-username']);
        expect(result.status).toBe('fail');
        expect(result.detail).toMatch(/forwarded/i);
        expect(result.detail).toContain('"x-authentik-username"');
    });

    it('returns fail and lists all received header names', () => {
        const result = evaluateForwardAuthReflection([
            'x-authentik-username',
            'x-authentik-groups',
        ]);
        expect(result.status).toBe('fail');
        expect(result.detail).toContain('"x-authentik-username"');
        expect(result.detail).toContain('"x-authentik-groups"');
    });

    it('detail includes count of received headers on fail', () => {
        const result = evaluateForwardAuthReflection(['x-authentik-username', 'x-forwarded-user']);
        expect(result.status).toBe('fail');
        expect(result.detail).toMatch(/2/);
    });
});

// ── 2. null baseUrl → all probes skipped ────────────────────────────────────

describe('runEdgeProbes — null baseUrl', () => {
    it('returns all-skipped findings when baseUrl is null', async () => {
        const mintToken = vi.fn().mockResolvedValue({
            token: 'svc_fake',
            revoke: vi.fn().mockResolvedValue(undefined),
        });

        const findings = await runEdgeProbes({ baseUrl: null, mintToken });

        expect(findings.length).toBeGreaterThan(0);
        for (const f of findings) {
            expect(f.status).toBe('skipped');
            expect(f.type).toBe('edge-probe');
        }
        // mintToken must never have been called when baseUrl is null.
        expect(mintToken).not.toHaveBeenCalled();
    });

    it('skipped finding for edge.fwd-auth-stripped mentions base URL', async () => {
        const mintToken = vi.fn();
        const findings = await runEdgeProbes({ baseUrl: null, mintToken });
        const f = findings.find((x) => x.id === 'edge.fwd-auth-stripped');
        expect(f).toBeDefined();
        expect(f!.status).toBe('skipped');
        expect(f!.detail).toMatch(/base url/i);
    });
});

// ── 3. Forward-auth stripped probe with mocked fetch ─────────────────────────

describe('runEdgeProbes — edge.fwd-auth-stripped probe (mocked fetch)', () => {
    const BASE = 'https://example.com';

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /**
     * Helper: mock global.fetch to return a json response for any url.
     */
    function mockFetch(
        statusCode: number,
        body: unknown,
        headers: Record<string, string> = {},
    ): void {
        const responseHeaders = new Headers({
            'content-type': 'application/json',
            ...headers,
        });
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                status: statusCode,
                ok: statusCode >= 200 && statusCode < 300,
                json: vi.fn().mockResolvedValue(body),
                headers: responseHeaders,
            }),
        );
    }

    it('emits pass when reflection endpoint returns received:[]', async () => {
        // The reflection probe uses one fetch; all other probes also use fetch
        // but we only need the fwd-auth probe to validate here.
        // Mock fetch to return received:[] for the diag endpoint and reasonable
        // defaults for others.
        mockFetch(200, { received: [] }, { 'strict-transport-security': 'max-age=3600' });

        const revoke = vi.fn().mockResolvedValue(undefined);
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc_ephem_test', revoke });

        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'edge.fwd-auth-stripped');

        expect(f).toBeDefined();
        expect(f!.status).toBe('pass');
        expect(f!.detail).toMatch(/stripped/i);
        // Revoke must always be called.
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('emits fail when reflection endpoint returns a forward-auth header name', async () => {
        mockFetch(
            200,
            { received: ['x-authentik-username'] },
            { 'strict-transport-security': 'max-age=3600' },
        );

        const revoke = vi.fn().mockResolvedValue(undefined);
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc_ephem_test', revoke });

        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'edge.fwd-auth-stripped');

        expect(f).toBeDefined();
        expect(f!.status).toBe('fail');
        expect(f!.detail).toContain('"x-authentik-username"');
        // Revoke must always be called even on fail.
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('emits skipped (NOT pass) on a malformed 200 body missing received[]', async () => {
        // Regression guard: a 200 whose body lacks a `received` array must NOT be
        // coerced to received:[] => false PASS. The headline probe must degrade to
        // skipped, never silently report the edge as stripping headers.
        mockFetch(200, { unexpected: 'shape' });
        const revoke = vi.fn().mockResolvedValue(undefined);
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc_ephem_test', revoke });

        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'edge.fwd-auth-stripped');

        expect(f).toBeDefined();
        expect(f!.status).toBe('skipped');
        expect(f!.status).not.toBe('pass');
        expect(f!.detail).toMatch(/malformed|expected/i);
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('emits skipped on a 200 with a non-JSON body (json() rejects)', async () => {
        const responseHeaders = new Headers({ 'content-type': 'text/html' });
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                status: 200,
                ok: true,
                json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token <')),
                headers: responseHeaders,
            }),
        );
        const revoke = vi.fn().mockResolvedValue(undefined);
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc_ephem_test', revoke });

        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'edge.fwd-auth-stripped');

        expect(f).toBeDefined();
        expect(f!.status).toBe('skipped');
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('emits skipped when mintToken throws', async () => {
        // No need to mock fetch — we fail before the request.
        mockFetch(200, { received: [] });
        const mintToken = vi.fn().mockRejectedValue(new Error('Valkey unavailable'));

        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'edge.fwd-auth-stripped');

        expect(f).toBeDefined();
        expect(f!.status).toBe('skipped');
        expect(f!.detail).toMatch(/Valkey unavailable/i);
    });

    it('emits skipped when reflection endpoint returns 401 (token expired)', async () => {
        mockFetch(401, { error: 'Unauthorized' });
        const revoke = vi.fn().mockResolvedValue(undefined);
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc_expired', revoke });

        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'edge.fwd-auth-stripped');

        expect(f).toBeDefined();
        expect(f!.status).toBe('skipped');
        // Revoke must still be called.
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('revoke() is called even when the fetch throws a network error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

        const revoke = vi.fn().mockResolvedValue(undefined);
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc_ephem_test', revoke });

        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'edge.fwd-auth-stripped');

        expect(f).toBeDefined();
        // Network error → skipped (not fail)
        expect(f!.status).toBe('skipped');
        expect(revoke).toHaveBeenCalledTimes(1);
    });
});

// ── 4. edge.hsts probe with mocked fetch ────────────────────────────────────

describe('runEdgeProbes — edge.hsts probe (mocked fetch)', () => {
    const BASE = 'https://example.com';

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('emits pass when Strict-Transport-Security header is present', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                status: 200,
                ok: true,
                json: vi.fn().mockResolvedValue({ ready: true }),
                headers: new Headers({
                    'strict-transport-security': 'max-age=31536000; includeSubDomains',
                }),
            }),
        );

        const revoke = vi.fn().mockResolvedValue(undefined);
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc_test', revoke });

        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'edge.hsts');

        expect(f).toBeDefined();
        expect(f!.status).toBe('pass');
    });

    it('emits warn when Strict-Transport-Security is absent', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                status: 200,
                ok: true,
                json: vi.fn().mockResolvedValue({ ready: true }),
                headers: new Headers({
                    'content-type': 'application/json',
                }),
            }),
        );

        const revoke = vi.fn().mockResolvedValue(undefined);
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc_test', revoke });

        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'edge.hsts');

        expect(f).toBeDefined();
        // HSTS-missing is INFO, not WARN — HSTS is a deliberate operational choice
        // (lock-in via max-age/includeSubDomains/preload; often handled at the CDN).
        expect(f!.status).toBe('info');
        expect(f!.remediation).toBeDefined();
    });

    it('emits skipped when edge is unreachable (timeout)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(() => {
                const err = new Error('fetch failed');
                err.name = 'AbortError';
                return Promise.reject(err);
            }),
        );

        const revoke = vi.fn().mockResolvedValue(undefined);
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc_test', revoke });

        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'edge.hsts');

        expect(f).toBeDefined();
        // Timeout → skipped, never fail
        expect(f!.status).toBe('skipped');
        expect(f!.detail).toMatch(/timed out|timeout|abort/i);
    });
});

// ── 5. token.bad-bearer probe with mocked fetch ──────────────────────────────

describe('runEdgeProbes — token.bad-bearer probe (mocked fetch)', () => {
    const BASE = 'https://example.com';

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('emits pass when /api/v1 returns 401 for a garbage bearer token', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                status: 401,
                ok: false,
                json: vi.fn().mockResolvedValue({ error: 'Unauthorized' }),
                headers: new Headers(),
            }),
        );

        const revoke = vi.fn().mockResolvedValue(undefined);
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc_test', revoke });

        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'token.bad-bearer');

        expect(f).toBeDefined();
        expect(f!.status).toBe('pass');
    });

    it('emits warn when /api/v1 returns 200 for a garbage bearer token', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                status: 200,
                ok: true,
                json: vi.fn().mockResolvedValue({ data: 'oops' }),
                headers: new Headers(),
            }),
        );

        const revoke = vi.fn().mockResolvedValue(undefined);
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc_test', revoke });

        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'token.bad-bearer');

        expect(f).toBeDefined();
        expect(f!.status).toBe('warn');
        expect(f!.detail).toMatch(/200/);
    });
});

// ── 5b. edge.security-headers HTML-gating ────────────────────────────────────

describe('runEdgeProbes — edge.security-headers probe (mocked fetch)', () => {
    const BASE = 'https://example.com';
    afterEach(() => vi.restoreAllMocks());

    function mockRoot(
        contentType: string,
        extraHeaders: Record<string, string> = {},
        status = 200,
    ): void {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                status,
                ok: status >= 200 && status < 300,
                json: vi.fn().mockResolvedValue({}),
                headers: new Headers({ 'content-type': contentType, ...extraHeaders }),
            }),
        );
    }

    it('skips (not warn) on a text/html REDIRECT (e.g. Authentik 302 with an HTML body)', async () => {
        // The real prod case: forward-auth IdP returns 302 + content-type text/html.
        // Gating on content-type alone would false-warn; require HTTP 200.
        mockRoot('text/html', {}, 302);
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc', revoke: vi.fn() });
        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'edge.security-headers');
        expect(f!.status).toBe('skipped');
        expect(f!.status).not.toBe('warn');
    });

    it('skips (not warn) when "/" returns a non-HTML response (e.g. JSON)', async () => {
        // These headers are HTML-only by design; a JSON response must not warn.
        mockRoot('application/json');
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc', revoke: vi.fn() });
        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'edge.security-headers');
        expect(f!.status).toBe('skipped');
        expect(f!.status).not.toBe('warn');
    });

    it('passes when an HTML page carries all three headers', async () => {
        mockRoot('text/html; charset=utf-8', {
            'x-frame-options': 'SAMEORIGIN',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'strict-origin-when-cross-origin',
        });
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc', revoke: vi.fn() });
        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'edge.security-headers');
        expect(f!.status).toBe('pass');
    });

    it('warns when an HTML page is missing a header (edge likely stripping)', async () => {
        mockRoot('text/html', { 'x-content-type-options': 'nosniff' }); // X-Frame-Options + Referrer-Policy absent
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc', revoke: vi.fn() });
        const findings = await runEdgeProbes({ baseUrl: BASE, mintToken });
        const f = findings.find((x) => x.id === 'edge.security-headers');
        expect(f!.status).toBe('warn');
        expect(f!.detail).toMatch(/X-Frame-Options/);
    });
});

// ── 6. runEdgeProbes never throws ────────────────────────────────────────────

describe('runEdgeProbes — resilience', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('never throws even when fetch itself throws synchronously', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(() => {
                throw new Error('Synchronous fetch failure');
            }),
        );

        const revoke = vi.fn().mockResolvedValue(undefined);
        const mintToken = vi.fn().mockResolvedValue({ token: 'svc_test', revoke });

        await expect(
            runEdgeProbes({ baseUrl: 'https://example.com', mintToken }),
        ).resolves.toBeDefined();
    });
});
