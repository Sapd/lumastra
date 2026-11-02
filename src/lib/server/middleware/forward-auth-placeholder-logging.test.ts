// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Diagnostic-parity tests for forward-auth's header-rejection paths.
 *
 * The untrusted-PEER rejection already logs peer + path + posture + a
 * posture-dependent remediation hint. The PLACEHOLDER rejections (a reverse
 * proxy that forwarded a literal, unexpanded `{…}` header template) logged only
 * `{ path }` — so an operator whose proxy is misconfigured got a log line that
 * couldn't say which host sent it or what trust posture was in force. And
 * readTrustedForwardAuthIdentity returned null completely silently for BOTH its
 * reject cases, which is the worst possible shape: the caller sees "no identity"
 * and nothing anywhere explains why.
 *
 * These tests pin the log PAYLOADS (not merely "a warn happened"), because the
 * payload is the whole deliverable — it is what a self-hoster pastes into an
 * issue.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks ─────────────────────────────────────────────────────────────

// One shared logger instance so assertions can read what the middleware logged.
const mockLog = vi.hoisted(() => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => mockLog },
}));

const mockConfig = vi.hoisted(() => ({
    FEATURE_JELLYFIN_COMPAT: false,
    FEATURE_PUBLIC_SHOWCASE: false,
    AUTH_NATIVE_LOGIN_ENABLED: false,
    AUTH_OIDC_ENABLED: false,
    AUTH_OIDC_ISSUER: '',
    AUTH_OIDC_CLIENT_ID: '',
    FORWARD_AUTH_ENABLED: true,
    USERHEADER: 'x-authentik-username',
    GROUPHEADER: 'x-authentik-groups',
    NAMEHEADER: 'x-authentik-name',
    get AUTH_OIDC_LOGIN_AVAILABLE(): boolean {
        return (
            this.AUTH_OIDC_ENABLED &&
            this.AUTH_OIDC_ISSUER.length > 0 &&
            this.AUTH_OIDC_CLIENT_ID.length > 0
        );
    },
}));
vi.mock('$lib/server/config.js', () => ({ config: mockConfig, features: { deviceAuth: false } }));

vi.mock('$app/environment', () => ({ dev: false }));

// Trust posture is driven from process.env inside the real module; mock it so
// each test can pin an exact posture without touching global env.
const mockTrust = vi.hoisted(() => ({
    trusted: true,
    posture: 'allowlist' as 'allowlist' | 'trust-any' | 'fail-closed',
}));
// Partial mock: only the trust decision is stubbed. The address predicates
// (isPrivateClientIp / hasForwardedClientIpHeader, which gate how much detail a
// rejection reveals) stay REAL so this file can't drift from them.
vi.mock('$lib/server/utils/client-ip.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/client-ip.js')>()),
    getClientIp: (event: RequestEvent) => event.getClientAddress(),
    getClientIpStrict: (event: RequestEvent) => event.getClientAddress(),
    isForwardAuthPeerTrusted: () => mockTrust.trusted,
    forwardAuthTrustPosture: () => mockTrust.posture,
}));

vi.mock('$lib/server/auth.js', () => ({
    isUserAdmin: (groups: string[] = []) => groups.includes('admin'),
    buildUserPermissions: () => ({ isAdmin: false }),
}));

vi.mock('$lib/server/auth/native-session.js', () => ({
    SESSION_COOKIE_NAME: 'lumastra_session',
    readSessionCookie: () => null,
    clearSessionCookie: vi.fn(),
}));

vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({ validate: vi.fn(async () => null) }),
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: vi.fn(async () => true),
    getUserByUsername: vi.fn(async () => null),
    // Matches upsertUser()'s real UpsertUserResult shape (security review
    // 2026-09-16, fix round 1 review) -- neither flag true, since this test
    // never asserts on admin-credential narrowing/restoring.
    upsertUser: vi.fn(async () => ({
        id: '00000000-0000-0000-0000-000000000000',
        isAdmin: false,
        demoted: false,
        promoted: false,
    })),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({}) as unknown) },
}));

vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserId: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));

vi.mock('$lib/server/oauth/streaming-session.service.js', () => ({
    STREAM_TOKEN_PREFIX: 'stream_',
    getStreamingSessionService: () => ({ validate: vi.fn(), getStatus: vi.fn() }),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import {
    resolveAuth,
    readTrustedForwardAuthIdentity,
    readRejectedForwardAuthPeer,
} from './forward-auth.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const PLACEHOLDER = '{http.reverse_proxy.header.x-authentik-username}';

function makeEvent(
    path: string,
    headers: Record<string, string>,
    peer = '203.0.113.9',
): RequestEvent {
    const url = new URL('http://localhost' + path);
    return {
        url,
        request: new Request(url, { headers: new Headers({ accept: 'text/html', ...headers }) }),
        params: {},
        route: { id: url.pathname },
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => peer,
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

/** The payload logged with `message`, or undefined. */
function payloadFor(message: string): Record<string, unknown> | undefined {
    const call = mockLog.warn.mock.calls.find((args) => args[0] === message);
    return call?.[1] as Record<string, unknown> | undefined;
}

const noopMigration = async (): Promise<void> => undefined;

beforeEach(() => {
    vi.clearAllMocks();
    mockTrust.trusted = true;
    mockTrust.posture = 'allowlist';
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('placeholder-rejection logging parity', () => {
    it('username placeholder logs peer + path + posture + hint, like the untrusted-peer path', async () => {
        await resolveAuth(
            makeEvent('/library', { 'x-authentik-username': PLACEHOLDER }, '10.1.2.3'),
            noopMigration,
            true,
        );

        const payload = payloadFor(
            'Forward-auth: discarded unexpanded reverse-proxy username placeholder',
        );
        expect(payload).toBeDefined();
        expect(payload).toMatchObject({
            peer: '10.1.2.3',
            path: '/library',
            posture: 'allowlist',
        });
        expect(String(payload?.hint)).toMatch(/template|placeholder|expand/i);
        // The literal value is a proxy config string, not identity — including it
        // is what makes the line actionable.
        expect(String(payload?.header)).toContain('x-authentik-username');
    });

    it('display-name placeholder logs the same diagnostic shape', async () => {
        await resolveAuth(
            makeEvent(
                '/library',
                {
                    'x-authentik-username': 'denis',
                    'x-authentik-name': '{http.reverse_proxy.header.x-authentik-name}',
                },
                '10.9.9.9',
            ),
            noopMigration,
            true,
        );

        const payload = payloadFor(
            'Forward-auth: discarded unexpanded reverse-proxy display-name placeholder',
        );
        expect(payload).toBeDefined();
        expect(payload).toMatchObject({
            peer: '10.9.9.9',
            path: '/library',
            posture: 'allowlist',
        });
    });

    it('the hint tracks the posture, exactly as the untrusted-peer path does', async () => {
        mockTrust.posture = 'fail-closed';
        await resolveAuth(
            makeEvent('/library', { 'x-authentik-username': PLACEHOLDER }, '10.1.2.3'),
            noopMigration,
            true,
        );
        const payload = payloadFor(
            'Forward-auth: discarded unexpanded reverse-proxy username placeholder',
        );
        expect(payload).toMatchObject({ posture: 'fail-closed' });
    });
});

describe('the peer-trust gate runs BEFORE any placeholder inspection', () => {
    // Regression: the placeholder check nulled the identity headers first, so the
    // `if (rawUserHeader || rawGroupHeader)` peer gate below it never ran. An
    // attacker reaching the origin directly could (a) suppress the header-forgery
    // warning entirely and (b) push 120 bytes of chosen bytes into the log on
    // every request. readTrustedForwardAuthIdentity always had the right order.
    it('reports forgery — not a proxy misconfiguration — when the peer is untrusted', async () => {
        mockTrust.trusted = false;
        mockTrust.posture = 'allowlist';

        await resolveAuth(
            makeEvent('/library', { 'x-authentik-username': PLACEHOLDER }, '198.51.100.66'),
            noopMigration,
            true,
        );

        const forgery = payloadFor(
            'Forward-auth headers from an untrusted TCP peer were ignored (possible header forgery)',
        );
        expect(forgery).toMatchObject({ peer: '198.51.100.66', path: '/library' });
        expect(
            payloadFor('Forward-auth: discarded unexpanded reverse-proxy username placeholder'),
        ).toBeUndefined();
    });

    it('never writes an untrusted peer’s header bytes into the log', async () => {
        mockTrust.trusted = false;
        const attackerValue = '{OOB-MARKER-9f3a2b}';

        await resolveAuth(
            makeEvent(
                '/library',
                {
                    'x-authentik-username': attackerValue,
                    'x-authentik-name': attackerValue,
                    'x-authentik-groups': attackerValue,
                },
                '198.51.100.66',
            ),
            noopMigration,
            true,
        );

        const logged = JSON.stringify(mockLog.warn.mock.calls);
        expect(logged).not.toContain('OOB-MARKER-9f3a2b');
    });

    it('drops a name-only placeholder from an untrusted peer without logging its value', async () => {
        mockTrust.trusted = false;

        await resolveAuth(
            makeEvent('/library', { 'x-authentik-name': '{OOB-MARKER-9f3a2b}' }, '198.51.100.66'),
            noopMigration,
            true,
        );

        expect(JSON.stringify(mockLog.warn.mock.calls)).not.toContain('OOB-MARKER-9f3a2b');
    });

    it('the setup card diagnoses untrusted-peer, not placeholder, for that request', async () => {
        mockTrust.trusted = false;

        await resolveAuth(
            makeEvent('/library', { 'x-authentik-username': PLACEHOLDER }, '198.51.100.66'),
            noopMigration,
            true,
        );

        const payload = payloadFor('HTML request without authentication headers');
        expect(payload).toMatchObject({ rejectedUntrustedPeer: true, rejectedPlaceholder: false });
    });

    it('still diagnoses a real placeholder when the peer IS trusted', async () => {
        mockTrust.trusted = true;

        await resolveAuth(
            makeEvent('/library', { 'x-authentik-username': PLACEHOLDER }, '10.1.2.3'),
            noopMigration,
            true,
        );

        expect(payloadFor('HTML request without authentication headers')).toMatchObject({
            rejectedUntrustedPeer: false,
            rejectedPlaceholder: true,
        });
    });
});

describe('API missing-auth log level', () => {
    const MSG = 'API request without authentication headers';
    const debugPayload = (): Record<string, unknown> | undefined =>
        mockLog.debug.mock.calls.find((a) => a[0] === MSG)?.[1] as
            Record<string, unknown> | undefined;

    it('logs an ordinary missing-session API request at debug, not warn', async () => {
        const res = await resolveAuth(
            makeEvent('/api/me/manual-runs', {}, '203.0.113.9'),
            noopMigration,
            true,
        );

        expect((res as Response | undefined)?.status ?? 401).toBe(401);
        expect(payloadFor(MSG)).toBeUndefined();
        expect(debugPayload()).toMatchObject({
            path: '/api/me/manual-runs',
            rejectedUntrustedPeer: false,
            rejectedPlaceholder: false,
        });
    });

    it('keeps WARN when headers were rejected from an untrusted peer', async () => {
        mockTrust.trusted = false;

        await resolveAuth(
            makeEvent('/api/me/manual-runs', { 'x-authentik-username': 'denis' }, '198.51.100.66'),
            noopMigration,
            true,
        );

        expect(payloadFor(MSG)).toMatchObject({
            path: '/api/me/manual-runs',
            rejectedUntrustedPeer: true,
        });
        expect(debugPayload()).toBeUndefined();
    });

    it('keeps WARN when the proxy forwarded an unexpanded placeholder', async () => {
        await resolveAuth(
            makeEvent('/api/me/manual-runs', { 'x-authentik-username': PLACEHOLDER }, '10.1.2.3'),
            noopMigration,
            true,
        );

        expect(payloadFor(MSG)).toMatchObject({ rejectedPlaceholder: true });
        expect(debugPayload()).toBeUndefined();
    });
});

describe('readTrustedForwardAuthIdentity no longer fails silently', () => {
    it('logs peer + posture when the peer is not trusted', () => {
        mockTrust.trusted = false;
        mockTrust.posture = 'fail-closed';

        const identity = readTrustedForwardAuthIdentity(
            makeEvent('/api/v1/media', { 'x-authentik-username': 'denis' }, '198.51.100.7'),
        );

        expect(identity).toBeNull();
        const payload = payloadFor('Forward-auth: identity headers ignored — untrusted TCP peer');
        expect(payload).toBeDefined();
        expect(payload).toMatchObject({
            peer: '198.51.100.7',
            path: '/api/v1/media',
            posture: 'fail-closed',
        });
        expect(String(payload?.hint).length).toBeGreaterThan(0);
    });

    it('logs peer + posture when the username header is an unexpanded placeholder', () => {
        const identity = readTrustedForwardAuthIdentity(
            makeEvent('/api/v1/media', { 'x-authentik-username': PLACEHOLDER }, '10.4.4.4'),
        );

        expect(identity).toBeNull();
        const payload = payloadFor(
            'Forward-auth: identity headers ignored — unexpanded reverse-proxy placeholder',
        );
        expect(payload).toBeDefined();
        expect(payload).toMatchObject({
            peer: '10.4.4.4',
            path: '/api/v1/media',
            posture: 'allowlist',
        });
    });

    it('stays quiet when no identity headers were sent at all', () => {
        const identity = readTrustedForwardAuthIdentity(makeEvent('/api/v1/media', {}));
        expect(identity).toBeNull();
        expect(mockLog.warn).not.toHaveBeenCalled();
    });

    it('returns the identity (and logs nothing) on the happy path', () => {
        const identity = readTrustedForwardAuthIdentity(
            makeEvent('/api/v1/media', {
                'x-authentik-username': 'Denis',
                'x-authentik-groups': 'admin',
            }),
        );
        expect(identity).toEqual({ username: 'denis', groups: ['admin'], isAdmin: true });
        expect(mockLog.warn).not.toHaveBeenCalled();
    });
});

describe('readRejectedForwardAuthPeer (setup wizard: "headers received but rejected")', () => {
    it('returns the untrusted peer that sent identity headers', () => {
        mockTrust.trusted = false;
        expect(
            readRejectedForwardAuthPeer(
                makeEvent('/setup', { 'x-authentik-username': 'denis' }, '172.21.0.1'),
            ),
        ).toBe('172.21.0.1');
    });

    it('counts a groups-only header as an identity header too', () => {
        mockTrust.trusted = false;
        expect(
            readRejectedForwardAuthPeer(
                makeEvent('/setup', { 'x-authentik-groups': 'admin' }, '10.0.0.9'),
            ),
        ).toBe('10.0.0.9');
    });

    it('unwraps an IPv4-mapped IPv6 peer to the address an operator would list', () => {
        mockTrust.trusted = false;
        expect(
            readRejectedForwardAuthPeer(
                makeEvent('/setup', { 'x-authentik-username': 'denis' }, '::ffff:172.21.0.1'),
            ),
        ).toBe('172.21.0.1');
    });

    it('is null when the peer IS trusted (the headers were accepted)', () => {
        mockTrust.trusted = true;
        expect(
            readRejectedForwardAuthPeer(
                makeEvent('/setup', { 'x-authentik-username': 'denis' }, '172.21.0.1'),
            ),
        ).toBeNull();
    });

    it('is null when no identity header arrived at all', () => {
        mockTrust.trusted = false;
        expect(readRejectedForwardAuthPeer(makeEvent('/setup', {}, '172.21.0.1'))).toBeNull();
    });
});
