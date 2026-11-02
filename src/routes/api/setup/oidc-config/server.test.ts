// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for POST /api/setup/oidc-config — the first-run OIDC config write.
 * Verifies the first-run 404 guard, validation (issuer https + required,
 * client id required, scopes must include openid), the saveConfig payload, the
 * empty-secret omission, and the discovery-cache reset. All collaborators mocked.
 * Also the unauthenticated-surface guards (per-IP rate limit, body cap) and the
 * admin re-check under FIRST_ADMIN_LOCK_KEY; the real-Postgres lock wait is in
 * setup-lock.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    mockGetSql,
    mockAdminExists,
    mockSaveConfig,
    mockResetCache,
    mockRateLimit,
    mockTx,
    mockProbe,
} = vi.hoisted(() => ({
    mockGetSql: vi.fn(),
    mockAdminExists: vi.fn(),
    mockSaveConfig: vi.fn(),
    mockResetCache: vi.fn(),
    mockRateLimit: vi.fn(),
    mockTx: vi.fn(async () => []),
    mockProbe: vi.fn(),
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...a: unknown[]) => mockGetSql(...a) },
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: (...a: unknown[]) => mockAdminExists(...a),
    FIRST_ADMIN_LOCK_KEY: 'lumastra:setup:first-admin',
}));
vi.mock('$lib/server/database/with-tx.js', () => ({
    withTx: (_sql: unknown, fn: (tx: unknown) => unknown) => fn(mockTx),
}));
vi.mock('$lib/server/utils/client-ip.js', () => ({
    getClientIpStrict: () => '203.0.113.7',
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));
vi.mock('$lib/server/config/config.service.js', () => ({
    saveConfig: (...a: unknown[]) => mockSaveConfig(...a),
}));
vi.mock('$lib/server/services/oidc.service.js', () => ({
    resetOidcConfigCache: (...a: unknown[]) => mockResetCache(...a),
    probeOidcDiscovery: (...args: unknown[]) => mockProbe(...args),
}));

const callPost = async (body: unknown, raw?: string) => {
    const { POST } = await import('./+server.js');
    const request = new Request('http://localhost/api/setup/oidc-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw ?? JSON.stringify(body),
    });
    return (POST as (event: unknown) => Promise<Response>)({ request });
};

const VALID = {
    issuer: 'https://idp.example.com',
    clientId: 'client-abc',
    clientSecret: 'sekret',
    providerName: 'Authentik',
};

describe('POST /api/setup/oidc-config', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockAdminExists.mockResolvedValue(false);
        mockSaveConfig.mockResolvedValue(undefined);
        mockRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
        mockProbe.mockResolvedValue({ ok: true });
    });

    it('429s (no write) once the per-IP setup cap is spent', async () => {
        mockRateLimit.mockResolvedValue({ allowed: false, resetAt: 1 });
        const res = await callPost(VALID);
        expect(res.status).toBe(429);
        expect(mockRateLimit).toHaveBeenCalledWith('setup-oidc:ip:203.0.113.7', 20, 900);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('413s an oversized body instead of buffering it', async () => {
        const res = await callPost(null, JSON.stringify({ ...VALID, pad: 'x'.repeat(20_000) }));
        expect(res.status).toBe(413);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('404s (no write) when an admin appeared before the first-admin lock was taken', async () => {
        mockAdminExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const res = await callPost(VALID);
        expect(res.status).toBe(404);
        // The re-check runs on the transaction that holds the lock.
        expect(mockAdminExists).toHaveBeenLastCalledWith(mockTx, expect.any(Array));
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('404s once an admin exists', async () => {
        mockAdminExists.mockResolvedValue(true);
        const res = await callPost(VALID);
        expect(res.status).toBe(404);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('503s when the database is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);
        const res = await callPost(VALID);
        expect(res.status).toBe(503);
    });

    it('rejects a missing issuer', async () => {
        const res = await callPost({ ...VALID, issuer: '' });
        expect(res.status).toBe(422);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('rejects a non-https issuer', async () => {
        const res = await callPost({ ...VALID, issuer: 'http://idp.example.com' });
        expect(res.status).toBe(422);
    });

    it('rejects a missing client id', async () => {
        const res = await callPost({ ...VALID, clientId: '' });
        expect(res.status).toBe(422);
    });

    it('rejects scopes without openid', async () => {
        const res = await callPost({ ...VALID, scopes: 'profile email' });
        expect(res.status).toBe(422);
    });

    it('saves the config (secret included) and resets the discovery cache', async () => {
        const res = await callPost(VALID);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(mockSaveConfig).toHaveBeenCalledWith(
            expect.objectContaining({
                AUTH_OIDC_ENABLED: true,
                AUTH_OIDC_ISSUER: 'https://idp.example.com',
                AUTH_OIDC_CLIENT_ID: 'client-abc',
                AUTH_OIDC_CLIENT_SECRET: 'sekret',
                AUTH_OIDC_PROVIDER_NAME: 'Authentik',
                AUTH_OIDC_SCOPES: 'openid profile email',
                AUTH_OIDC_GROUPS_CLAIM: 'groups',
            }),
        );
        expect(mockResetCache).toHaveBeenCalled();
        expect(mockProbe).toHaveBeenCalledWith({
            issuer: VALID.issuer,
            clientId: VALID.clientId,
            clientSecret: VALID.clientSecret,
            scopes: 'openid profile email',
            groupsClaim: 'groups',
        });
        expect(mockProbe.mock.invocationCallOrder[0]).toBeLessThan(
            mockSaveConfig.mock.invocationCallOrder[0],
        );
    });

    it.each([
        'Issuer unreachable. Check DNS and connectivity from the app container.',
        'Discovery invalid. Check the issuer URL.',
        'TLS verification failed. Configure NODE_EXTRA_CA_CERTS.',
    ])('refuses activation and preserves all saved settings: %s', async (error) => {
        mockProbe.mockResolvedValue({ ok: false, error });
        const response = await callPost(VALID);
        expect(response.status).toBe(422);
        expect(await response.text()).toContain(error);
        expect(mockSaveConfig).not.toHaveBeenCalled();
        expect(mockResetCache).not.toHaveBeenCalled();
        expect(mockTx).not.toHaveBeenCalled();
    });

    it.each(['https://', 'https://user:password@idp.example.com', 'not-a-url'])(
        'rejects malformed or credential-bearing issuer without saving or echoing it: %s',
        async (issuer) => {
            const response = await callPost({ ...VALID, issuer });
            expect(response.status).toBe(422);
            expect(await response.text()).not.toContain('password');
            expect(mockSaveConfig).not.toHaveBeenCalled();
            expect(mockProbe).not.toHaveBeenCalled();
        },
    );

    it('can retry after failure and safely repeat a successful setup', async () => {
        mockProbe.mockResolvedValueOnce({ ok: false, error: 'Issuer unreachable' });
        expect((await callPost(VALID)).status).toBe(422);
        expect(mockSaveConfig).not.toHaveBeenCalled();
        expect((await callPost(VALID)).status).toBe(200);
        expect((await callPost(VALID)).status).toBe(200);
        expect(mockSaveConfig).toHaveBeenCalledTimes(2);
    });

    it('omits the secret key when the field is blank (public client / keep-existing)', async () => {
        await callPost({ ...VALID, clientSecret: '' });
        const updates = mockSaveConfig.mock.calls[0][0] as Record<string, unknown>;
        expect('AUTH_OIDC_CLIENT_SECRET' in updates).toBe(false);
        expect(updates.AUTH_OIDC_ENABLED).toBe(true);
    });
});
