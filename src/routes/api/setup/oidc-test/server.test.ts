// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for GET /api/setup/oidc-test — the first-run OIDC discovery probe.
 * Verifies the first-run guard (404 once an admin exists), the DB-down and
 * not-configured branches, and that a configured instance returns the probe
 * payload. All collaborators are mocked; no DB/IdP is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetSql, mockAdminExists, mockProbe, mockIsConfigured } = vi.hoisted(() => ({
    mockGetSql: vi.fn(),
    mockAdminExists: vi.fn(),
    mockProbe: vi.fn(),
    mockIsConfigured: vi.fn(),
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...a: unknown[]) => mockGetSql(...a) },
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: (...a: unknown[]) => mockAdminExists(...a),
}));

vi.mock('$lib/server/utils/client-ip.js', () => ({
    getClientIpStrict: () => '203.0.113.7',
}));
const { mockRateLimit } = vi.hoisted(() => ({ mockRateLimit: vi.fn() }));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));

vi.mock('$lib/server/services/oidc.service.js', () => ({
    probeOidcDiscovery: (...a: unknown[]) => mockProbe(...a),
    isOidcConfigured: (...a: unknown[]) => mockIsConfigured(...a),
}));

const callGet = async () => {
    const { GET } = await import('./+server.js');
    return (GET as (event: unknown) => Promise<Response>)({});
};

describe('GET /api/setup/oidc-test', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({}); // truthy sql handle by default
        mockAdminExists.mockResolvedValue(false);
        mockIsConfigured.mockReturnValue(true);
        mockRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
    });

    it('429s (no outbound probe) once the per-IP cap is spent', async () => {
        mockRateLimit.mockResolvedValue({ allowed: false, resetAt: 1 });
        const res = await callGet();
        expect(res.status).toBe(429);
        expect(mockProbe).not.toHaveBeenCalled();
    });

    it('404s once an admin exists (inert post-onboarding)', async () => {
        mockAdminExists.mockResolvedValue(true);

        const res = await callGet();

        expect(res.status).toBe(404);
        expect(mockProbe).not.toHaveBeenCalled();
    });

    it('503s when the database is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);

        const res = await callGet();

        expect(res.status).toBe(503);
        expect(mockAdminExists).not.toHaveBeenCalled();
        expect(mockProbe).not.toHaveBeenCalled();
    });

    it('returns ok:false without probing when OIDC is not configured', async () => {
        mockIsConfigured.mockReturnValue(false);

        const res = await callGet();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/not configured/i);
        expect(mockProbe).not.toHaveBeenCalled();
    });

    it('returns the probe payload for a configured, first-run instance', async () => {
        mockProbe.mockResolvedValue({
            ok: true,
            insecure: false,
            requestedScopes: ['openid', 'profile', 'email'],
            issuer: 'https://idp.example.com',
            groupsClaim: 'groups',
            groupsClaimAdvertised: true,
            emailAdvertised: true,
        });

        const res = await callGet();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.issuer).toBe('https://idp.example.com');
        expect(body.groupsClaimAdvertised).toBe(true);
        expect(mockProbe).toHaveBeenCalledTimes(1);
    });
});
