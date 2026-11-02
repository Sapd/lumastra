// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Correlation-id coverage for the OIDC callback's failure branches.
 *
 * The route deliberately shows the browser a generic message and keeps the real
 * cause in the log. These tests pin the bridge between the two: the SAME opaque
 * token must appear in the server log payload AND in the redirect the browser
 * follows, for every failure branch — otherwise a user's "sign-in failed" bug
 * report is untraceable and the whole point of the ref is lost.
 *
 * Named `server.test.ts`, not `+server.test.ts`: `+`-prefixed names are reserved
 * by SvelteKit and `vite build` rejects them (vitest/eslint do not).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks ─────────────────────────────────────────────────────────────

// One shared logger instance so assertions can read what the route logged.
const mockLog = vi.hoisted(() => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => mockLog },
}));

const oidcMocks = vi.hoisted(() => {
    class OidcFirstUserNotAdminError extends Error {}
    class OidcAccountDisabledError extends Error {}
    class OidcNotConfiguredError extends Error {}
    return {
        OidcFirstUserNotAdminError,
        OidcAccountDisabledError,
        OidcNotConfiguredError,
        handleCallback: vi.fn(),
        resolveOrProvisionOidcUser: vi.fn(),
    };
});
vi.mock('$lib/server/services/oidc.service.js', () => oidcMocks);

const dbMocks = vi.hoisted(() => ({ getSql: vi.fn(async (): Promise<unknown> => ({})) }));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: dbMocks.getSql },
}));

const queryMocks = vi.hoisted(() => ({ adminExists: vi.fn(async () => true) }));
vi.mock('$lib/server/database/queries/index.js', () => queryMocks);

vi.mock('$lib/server/database/queries/user-ratings.queries.js', () => ({
    ensureUserProfileExists: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({
        create: vi.fn(async () => ({ token: 'tok', expiresAt: new Date(Date.now() + 3600_000) })),
    }),
}));

vi.mock('$lib/server/auth/native-session.js', () => ({
    setSessionCookie: vi.fn(),
    sessionMaxAgeSeconds: () => 3600,
}));

vi.mock('$lib/server/middleware/forward-auth.js', () => ({
    invalidateAdminExistsCache: vi.fn(),
}));

const avatarMocks = vi.hoisted(() => ({ syncIdpAvatar: vi.fn(async () => 'stored') }));
vi.mock('$lib/server/services/idp-avatar-sync.service.js', () => avatarMocks);

vi.mock('$lib/server/utils/client-ip.js', () => ({ getClientIp: () => '127.0.0.1' }));

vi.mock('$lib/server/utils/safe-redirect.js', () => ({
    sanitizeRedirect: (v: string | null, fallback: string) => v || fallback,
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { GET } from './+server.js';
import { sanitizeAuthFailureRef } from '$lib/shared/auth-failure-ref.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(query = ''): RequestEvent {
    const url = new URL('http://localhost/auth/oidc/callback' + query);
    return {
        url,
        request: new Request(url, { headers: new Headers({ 'user-agent': 'vitest' }) }),
        params: {},
        route: { id: null },
        locals: {},
        cookies: { get: () => 'state-value', delete: vi.fn(), set: vi.fn() },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

/** The `ref` query parameter carried by a redirect Location, or null. */
function refFromLocation(res: Response): string | null {
    const location = res.headers.get('location');
    if (!location) return null;
    return sanitizeAuthFailureRef(new URL(location, 'http://localhost').searchParams.get('ref'));
}

/** Every logged payload's `ref` field across warn+error calls. */
function loggedRefs(): string[] {
    const calls = [...mockLog.warn.mock.calls, ...mockLog.error.mock.calls];
    return calls
        .flatMap((args) =>
            args.filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null),
        )
        .map((payload) => payload.ref)
        .filter((v): v is string => typeof v === 'string');
}

beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getSql.mockResolvedValue({});
    queryMocks.adminExists.mockResolvedValue(true);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OIDC callback failure correlation id', () => {
    it('does not log localized discovery messages or raw causes while retaining the reference', async () => {
        oidcMocks.handleCallback.mockRejectedValueOnce(
            new oidcMocks.OidcNotConfiguredError('Lokalisierte Fehlermeldung', {
                cause: new Error('raw-client-secret'),
            }),
        );
        const response = await GET(makeEvent('?code=abc&state=xyz') as never);
        const ref = refFromLocation(response);
        expect(ref).toMatch(/^[0-9a-f]{8}$/);
        expect(mockLog.warn).toHaveBeenCalledWith('OIDC callback validation failed', { ref });
        expect(JSON.stringify(mockLog.warn.mock.calls)).not.toMatch(
            /Lokalisierte|raw-client-secret/,
        );
    });
    it('branch 1 — IdP returned ?error: same ref in the log and in the redirect', async () => {
        const res = await GET(makeEvent('?error=access_denied') as never);

        const ref = refFromLocation(res);
        expect(ref).toMatch(/^[0-9a-f]{8}$/);

        const location = res.headers.get('location') ?? '';
        expect(location).toContain('/login?error=');
        expect(decodeURIComponent(location)).toContain('Sign-in was cancelled or failed.');

        expect(mockLog.warn).toHaveBeenCalledWith(
            'OIDC provider returned an error',
            expect.objectContaining({ error: 'access_denied', ref }),
        );
        expect(loggedRefs()).toContain(ref);
    });

    it('branch 2 — callback validation threw: same ref in the log and in the redirect', async () => {
        oidcMocks.handleCallback.mockRejectedValueOnce(new Error('state mismatch'));

        const res = await GET(makeEvent('?code=abc&state=xyz') as never);

        const ref = refFromLocation(res);
        expect(ref).toMatch(/^[0-9a-f]{8}$/);
        expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain(
            'Sign-in failed. Please try again.',
        );
        expect(mockLog.warn).toHaveBeenCalledWith(
            'OIDC callback validation failed',
            expect.objectContaining({ ref }),
        );
        // The generic browser message must still leak nothing.
        expect(res.headers.get('location')).not.toContain('state mismatch');
    });

    it('branch 3 — database unavailable: same ref in the log and in the redirect', async () => {
        oidcMocks.handleCallback.mockResolvedValueOnce({
            claims: { issuer: 'i', subject: 's' },
            returnTo: '/',
        });
        dbMocks.getSql.mockResolvedValueOnce(null);

        const res = await GET(makeEvent('?code=abc&state=xyz') as never);

        const ref = refFromLocation(res);
        expect(ref).toMatch(/^[0-9a-f]{8}$/);
        expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain(
            'Sign-in is temporarily unavailable.',
        );
        expect(mockLog.error).toHaveBeenCalledWith(
            'Database unavailable during OIDC callback',
            expect.objectContaining({ ref }),
        );
    });

    it('branch 4 — disabled account: logs a ref (previously silent) and echoes it', async () => {
        oidcMocks.handleCallback.mockResolvedValueOnce({
            claims: { issuer: 'i', subject: 's' },
            returnTo: '/',
        });
        oidcMocks.resolveOrProvisionOidcUser.mockRejectedValueOnce(
            new oidcMocks.OidcAccountDisabledError('disabled'),
        );

        const res = await GET(makeEvent('?code=abc&state=xyz') as never);

        const ref = refFromLocation(res);
        expect(ref).toMatch(/^[0-9a-f]{8}$/);
        expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain(
            'This account is disabled.',
        );
        expect(loggedRefs()).toContain(ref);
    });

    it('branch 5 — first user not admin: bounces to /setup carrying the ref', async () => {
        oidcMocks.handleCallback.mockResolvedValueOnce({
            claims: { issuer: 'i', subject: 's' },
            returnTo: '/',
        });
        queryMocks.adminExists.mockResolvedValueOnce(false);
        oidcMocks.resolveOrProvisionOidcUser.mockRejectedValueOnce(
            new oidcMocks.OidcFirstUserNotAdminError('not admin'),
        );

        const res = await GET(makeEvent('?code=abc&state=xyz') as never);

        const location = res.headers.get('location') ?? '';
        expect(location).toContain('/setup?error=');
        const ref = refFromLocation(res);
        expect(ref).toMatch(/^[0-9a-f]{8}$/);
        expect(loggedRefs()).toContain(ref);
    });

    it('hands the SAME ref to oidc.service so its own log lines correlate', async () => {
        oidcMocks.handleCallback.mockResolvedValueOnce({
            claims: { issuer: 'i', subject: 's' },
            returnTo: '/',
        });
        oidcMocks.resolveOrProvisionOidcUser.mockRejectedValueOnce(
            new oidcMocks.OidcAccountDisabledError('disabled'),
        );

        const res = await GET(makeEvent('?code=abc&state=xyz') as never);
        const ref = refFromLocation(res);
        expect(ref).toMatch(/^[0-9a-f]{8}$/);

        // The value the browser was shown, not merely "some ref", must be the one
        // the service received — otherwise the user's reference and the service's
        // log lines are two unrelated ids.
        expect(oidcMocks.handleCallback.mock.calls[0]?.[0]).toMatchObject({ ref });
        expect(oidcMocks.resolveOrProvisionOidcUser.mock.calls[0]?.[2]).toMatchObject({ ref });
    });

    it('a successful sign-in carries no ref', async () => {
        oidcMocks.handleCallback.mockResolvedValueOnce({
            claims: { issuer: 'i', subject: 's' },
            returnTo: '/library',
        });
        oidcMocks.resolveOrProvisionOidcUser.mockResolvedValueOnce({
            userId: '00000000-0000-0000-0000-0000000000aa',
            username: 'denis',
            isAdmin: true,
            linkType: 'existing-identity',
        });

        const res = await GET(makeEvent('?code=abc&state=xyz') as never);

        expect(res.headers.get('location')).toBe('/library');
        expect(loggedRefs()).toHaveLength(0);
    });

    it('a successful sign-in hands the picture claim to the avatar sync', async () => {
        oidcMocks.handleCallback.mockResolvedValueOnce({
            claims: { issuer: 'https://idp', subject: 's', picture: 'https://idp/a.png' },
            returnTo: '/',
        });
        oidcMocks.resolveOrProvisionOidcUser.mockResolvedValueOnce({
            userId: '00000000-0000-0000-0000-0000000000aa',
            username: 'denis',
            isAdmin: false,
            linkType: 'existing-identity',
        });

        await GET(makeEvent('?code=abc&state=xyz') as never);

        expect(avatarMocks.syncIdpAvatar).toHaveBeenCalledWith(expect.anything(), {
            userId: '00000000-0000-0000-0000-0000000000aa',
            username: 'denis',
            picture: 'https://idp/a.png',
            issuer: 'https://idp',
        });
    });

    it('every failure branch mints a DISTINCT ref', async () => {
        const seen = new Set<string>();

        const first = await GET(makeEvent('?error=access_denied') as never);
        seen.add(refFromLocation(first) ?? '');

        oidcMocks.handleCallback.mockRejectedValueOnce(new Error('boom'));
        const second = await GET(makeEvent('?code=abc') as never);
        seen.add(refFromLocation(second) ?? '');

        expect(seen.size).toBe(2);
        expect(seen.has('')).toBe(false);
    });
});
