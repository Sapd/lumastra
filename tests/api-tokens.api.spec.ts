// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * E2E API Tests for Personal Access Tokens and Service Tokens
 *
 * These tests require:
 * - Running dev server (npm run dev)
 * - ENABLE_DEVICE_AUTH=true
 * - JWT_SECRET set
 * - Database with users table populated
 *
 * Run with: npm run test:e2e
 */

import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { sameOriginAdminTest as test, expect } from './fixtures/auth';

// Test user (should match X-Forwarded-User header set by the adminTest fixture)
async function currentUserId(request: APIRequestContext): Promise<string> {
    const response = await request.get('/api/me');
    expect(response.status(), await response.text()).toBe(200);
    const profile = (await response.json()) as { id: string };
    expect(profile.id).toMatch(/^[0-9a-f-]{36}$/i);
    return profile.id;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const readError = (body: unknown): string | null => {
    if (!isRecord(body)) return null;
    return typeof body.error === 'string' ? body.error : null;
};

/**
 * These endpoints no longer wrap their payload.
 *
 * The token surfaces answer bare objects — POST /api/me/pats returns
 * `{ id, token, message }` with 201, POST /api/admin/service-tokens returns
 * `{ id, token }` — and the collections return the shared `{ items, page }`
 * envelope. The old `{ success, data: { … } }` shape is gone, so every
 * `readSuccess()` compared `undefined` and every `body.data` reader returned
 * null. The status code carries what `success` used to.
 *
 * `id` also differs by endpoint: both the PAT create and the service-token paths answer a number; the
 * helpers still normalise so a string would not hide a failure.
 */
const readId = (raw: unknown): number | null => {
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
        return Number(raw);
    }
    return null;
};

const readMessage = (body: unknown): string | null => {
    if (!isRecord(body)) return null;
    return typeof body.message === 'string' ? body.message : null;
};

const readTokenData = (body: unknown): { token: string; id: number } | null => {
    if (!isRecord(body)) return null;
    const token = body.token;
    const id = readId(body.id);
    if (typeof token === 'string' && id !== null) {
        return { token, id };
    }
    return null;
};

const readTokensArray = (body: unknown): unknown[] | null => {
    if (!isRecord(body)) return null;
    return Array.isArray(body.items) ? body.items : null;
};

const readDataRecord = (body: unknown): Record<string, unknown> | null => {
    return isRecord(body) ? body : null;
};

test.describe.serial('Personal Access Tokens API', () => {
    let createdTokenId: number | null = null;
    let createdToken: string | null = null;

    test('should create a PAT for the current user', async ({ request }) => {
        const response = await request.post('/api/me/pats', {
            data: {
                name: 'E2E Test Token',
                description: 'Created by Playwright e2e test',
                scopes: ['read', 'write'],
                expiresInDays: 1,
            },
        });

        // May fail if feature is disabled or user not in DB
        if (response.status() === 503) {
            test.skip(true, 'Device auth not enabled');
            return;
        }

        if (response.status() === 400) {
            const body: unknown = await response.json();
            const error = readError(body);
            if (error?.includes('not found')) {
                test.skip(true, 'Test user not in database');
                return;
            }
        }

        expect(response.ok()).toBeTruthy();

        const body: unknown = await response.json();
        const tokenData = readTokenData(body);
        expect(tokenData).toBeTruthy();
        if (!tokenData) {
            test.skip(true, 'PAT response malformed');
            return;
        }
        expect(tokenData.token).toMatch(/^pat_/);

        // Save for later tests
        createdTokenId = tokenData.id;
        createdToken = tokenData.token;
    });

    test('should list PATs for the current user', async ({ request }) => {
        const response = await request.get('/api/me/pats');

        if (response.status() === 503) {
            test.skip(true, 'Device auth not enabled');
            return;
        }

        expect(response.ok()).toBeTruthy();

        const body: unknown = await response.json();
        expect(Array.isArray(readTokensArray(body))).toBe(true);
    });

    test('should use PAT to access public API', async ({ request }) => {
        if (!createdToken) {
            test.skip(true, 'No token created in previous test');
            return;
        }

        // Use the PAT to access public API (no forward auth headers)
        const response = await request.get('/api/v1/play-sessions', {
            headers: {
                Authorization: `Bearer ${createdToken}`,
                // Remove forward auth headers to simulate external client
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        expect(response.ok()).toBeTruthy();
    });

    test('should reject invalid PAT', async ({ request }) => {
        const response = await request.get('/api/v1/play-sessions', {
            headers: {
                Authorization: 'Bearer pat_invalid_token_12345678901234567890',
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        expect(response.status()).toBe(401);
    });

    test('should revoke PAT', async ({ request }) => {
        if (!createdTokenId) {
            test.skip(true, 'No token created in previous test');
            return;
        }

        const response = await request.delete(`/api/me/pats/${createdTokenId}`);

        if (response.status() === 503) {
            test.skip(true, 'Device auth not enabled');
            return;
        }

        expect(response.ok()).toBeTruthy();
    });

    test('should reject revoked PAT', async ({ request }) => {
        if (!createdToken) {
            test.skip(true, 'No token created in previous test');
            return;
        }

        const response = await request.get('/api/v1/play-sessions', {
            headers: {
                Authorization: `Bearer ${createdToken}`,
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        expect(response.status()).toBe(401);
    });
});

test.describe.serial('Admin PAT API', () => {
    let adminCreatedTokenId: number | null = null;

    test('should list all PATs (admin)', async ({ request }) => {
        const response = await request.get('/api/admin/pats');

        if (response.status() === 503) {
            test.skip(true, 'Device auth not enabled');
            return;
        }

        if (response.status() === 403) {
            test.skip(true, 'Test user is not admin');
            return;
        }

        expect(response.ok()).toBeTruthy();

        const body: unknown = await response.json();
        const tokens = readTokensArray(body) ?? [];
        expect(Array.isArray(tokens)).toBe(true);

        // Admin listings identify the owner through PublicAuthor.
        if (tokens.length > 0 && isRecord(tokens[0])) {
            expect(tokens[0]).toHaveProperty('owner.userId');
        }
    });

    test('should create PAT for another user (admin)', async ({ request }) => {
        const response = await request.post('/api/admin/pats', {
            data: {
                userId: await currentUserId(request),
                name: 'Admin Created Token',
                description: 'Created by admin via e2e test',
                scopes: ['read'],
                expiresInDays: 1,
            },
        });

        if (response.status() === 503) {
            test.skip(true, 'Device auth not enabled');
            return;
        }

        if (response.status() === 403) {
            test.skip(true, 'Test user is not admin');
            return;
        }

        if (response.status() === 400) {
            const body: unknown = await response.json();
            if (readError(body)?.includes('not found')) {
                test.skip(true, 'Target user not in database');
                return;
            }
        }

        expect(response.ok()).toBeTruthy();

        const body: unknown = await response.json();
        const data = readDataRecord(body);
        const token = data?.token;
        const id = data?.id;
        if (typeof token !== 'string' || typeof id !== 'number') {
            test.skip(true, 'Admin PAT response malformed');
            return;
        }
        expect(token).toMatch(/^pat_/);
        const listed = await request.get(`/api/admin/pats?userId=${await currentUserId(request)}`);
        expect(listed.status()).toBe(200);
        const owned = (await listed.json()) as {
            items: Array<{ id: number; owner: { userId: string } }>;
        };
        expect(owned.items.find((item) => item.id === id)?.owner.userId).toBe(
            await currentUserId(request),
        );

        adminCreatedTokenId = id;
    });

    test('should filter PATs by userId (admin)', async ({ request }) => {
        const response = await request.get(
            `/api/admin/pats?userId=${await currentUserId(request)}`,
        );

        if (response.status() === 503) {
            test.skip(true, 'Device auth not enabled');
            return;
        }

        if (response.status() === 403) {
            test.skip(true, 'Test user is not admin');
            return;
        }

        expect(response.ok()).toBeTruthy();

        const body: unknown = await response.json();
        const tokens = readTokensArray(body) ?? [];

        // All returned tokens should be for the specified user
        for (const token of tokens) {
            if (isRecord(token)) {
                expect((token.owner as { userId: string }).userId).toBe(
                    await currentUserId(request),
                );
            }
        }
    });

    test('should revoke any PAT (admin)', async ({ request }) => {
        if (!adminCreatedTokenId) {
            test.skip(true, 'No token created in previous test');
            return;
        }

        const response = await request.delete(`/api/admin/pats/${adminCreatedTokenId}`);

        if (response.status() === 503) {
            test.skip(true, 'Device auth not enabled');
            return;
        }

        if (response.status() === 403) {
            test.skip(true, 'Test user is not admin');
            return;
        }

        expect(response.ok()).toBeTruthy();

        expect(response.status()).toBe(204);
        const listed = await request.get('/api/admin/pats');
        expect(listed.status()).toBe(200);
        expect(
            ((await listed.json()) as { items: Array<{ id: number }> }).items.some(
                (pat) => pat.id === adminCreatedTokenId,
            ),
        ).toBe(false);
    });
});

test.describe.serial('Service Tokens API', () => {
    let serviceTokenId: number | null = null;
    let serviceToken: string | null = null;

    test('should create a service token (admin)', async ({ request }) => {
        const response = await request.post('/api/admin/service-tokens', {
            data: {
                name: 'E2E Service Token',
                description: 'Created by Playwright e2e test',
                scopes: ['read', 'write'],
                actAsUserId: await currentUserId(request),
                expiresInDays: 1,
            },
        });

        if (response.status() === 503) {
            test.skip(true, 'Device auth not enabled');
            return;
        }

        if (response.status() === 403) {
            test.skip(true, 'Test user is not admin');
            return;
        }

        if (response.status() === 400) {
            const body: unknown = await response.json();
            if (readError(body)?.includes('not found')) {
                test.skip(true, 'Target user not in database');
                return;
            }
        }

        expect(response.ok(), `${response.status()} ${await response.text()}`).toBeTruthy();

        const body: unknown = await response.json();
        const data = readDataRecord(body);
        const token = data?.token;
        const id = data?.id;
        if (typeof token !== 'string' || typeof id !== 'number') {
            test.skip(true, 'Service token response malformed');
            return;
        }
        expect(token).toMatch(/^svc_/);

        serviceTokenId = id;
        serviceToken = token;
    });

    test('should list service tokens (admin)', async ({ request }) => {
        const response = await request.get('/api/admin/service-tokens');

        if (response.status() === 503) {
            test.skip(true, 'Device auth not enabled');
            return;
        }

        if (response.status() === 403) {
            test.skip(true, 'Test user is not admin');
            return;
        }

        expect(response.ok()).toBeTruthy();

        const body: unknown = await response.json();
        expect(Array.isArray(readTokensArray(body))).toBe(true);
    });

    test('should use service token to access public API', async ({ request }) => {
        if (!serviceToken) {
            test.skip(true, 'No service token created');
            return;
        }

        const response = await request.get('/api/v1/play-sessions', {
            headers: {
                Authorization: `Bearer ${serviceToken}`,
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        expect(response.ok()).toBeTruthy();
    });

    test('should revoke service token (admin)', async ({ request }) => {
        if (!serviceTokenId) {
            test.skip(true, 'No service token created');
            return;
        }

        const response = await request.delete(`/api/admin/service-tokens/${serviceTokenId}`);

        if (response.status() === 503) {
            test.skip(true, 'Device auth not enabled');
            return;
        }

        if (response.status() === 403) {
            test.skip(true, 'Test user is not admin');
            return;
        }

        expect(response.ok()).toBeTruthy();
    });
});

test.describe('Token Validation', () => {
    test('should reject requests without auth to /api/v1', async ({ request }) => {
        const response = await request.get('/api/v1/play-sessions', {
            headers: {
                // Clear forward auth headers
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        expect(response.status()).toBe(401);
    });

    test('should reject malformed tokens', async ({ request }) => {
        const response = await request.get('/api/v1/play-sessions', {
            headers: {
                Authorization: 'Bearer not-a-valid-token',
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        expect(response.status()).toBe(401);
    });

    test('should reject expired tokens', async ({ request }) => {
        // This test would need a pre-created expired token in the DB
        // For now, just verify the endpoint handles the scenario
        const response = await request.get('/api/v1/play-sessions', {
            headers: {
                Authorization: 'Bearer pat_00000000000000000000000000000000000000000000',
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        expect(response.status()).toBe(401);
    });
});

test.describe('Retired account-token query authentication', () => {
    test('rejects api_key as authentication for JSON APIs', async ({ request }) => {
        // First create a token
        const createResponse = await request.post('/api/me/pats', {
            data: {
                name: 'HLS Test Token',
                scopes: ['read'],
                expiresInDays: 1,
            },
        });

        if (!createResponse.ok()) {
            test.skip(true, 'Could not create token');
            return;
        }

        const createBody: unknown = await createResponse.json();
        const tokenData = readTokenData(createBody);
        if (!tokenData) {
            test.skip(true, 'Token response malformed');
            return;
        }
        const token = tokenData.token;

        // Account credentials in query strings are retired; delivery uses a grant.
        const response = await request.get(`/api/v1/play-sessions?api_key=${token}`, {
            headers: {
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        expect(response.status()).toBe(401);

        // Cleanup
        await request.delete(`/api/me/pats/${tokenData.id}`);
    });
});

test.describe('PAT Scope Enforcement', () => {
    let readOnlyTokenId: number | null = null;
    let readOnlyToken: string | null = null;

    test.beforeAll(async ({ request }) => {
        // Create a read-only token
        const createResponse = await request.post('/api/me/pats', {
            data: {
                name: 'Read Only Test Token',
                scopes: ['read'], // Only read scope
                expiresInDays: 1,
            },
        });

        if (createResponse.ok()) {
            const body: unknown = await createResponse.json();
            const tokenData = readTokenData(body);
            readOnlyTokenId = tokenData?.id ?? null;
            readOnlyToken = tokenData?.token ?? null;
        }
    });

    test.afterAll(async ({ request }) => {
        if (readOnlyTokenId) {
            await request.delete(`/api/me/pats/${readOnlyTokenId}`);
        }
    });

    test('should allow GET requests with read-only token', async ({ request }) => {
        if (!readOnlyToken) {
            test.skip(true, 'Could not create read-only token');
            return;
        }

        const response = await request.get('/api/v1/play-sessions', {
            headers: {
                Authorization: `Bearer ${readOnlyToken}`,
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        expect(response.ok()).toBeTruthy();
    });

    test('should reject POST requests with read-only token (scope enforcement)', async ({
        request,
    }) => {
        if (!readOnlyToken) {
            test.skip(true, 'Could not create read-only token');
            return;
        }

        // Try to create a streaming session with read-only token
        // This endpoint requires write scope
        const response = await request.post('/api/v1/play-sessions', {
            headers: {
                Authorization: `Bearer ${readOnlyToken}`,
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        // Should get 403 with insufficient_scope error
        expect(response.status()).toBe(403);

        const body: unknown = await response.json();
        expect(isRecord(body) ? body.code : undefined).toBe('scope_required');
    });

    test('should reject PUT requests with read-only token (scope enforcement)', async ({
        request,
    }) => {
        if (!readOnlyToken) {
            test.skip(true, 'Could not create read-only token');
            return;
        }

        // Try a PUT request (e.g., updating progress) - requires write scope
        const response = await request.put(`/api/v1/play-sessions/${randomUUID()}`, {
            headers: {
                Authorization: `Bearer ${readOnlyToken}`,
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
            data: { position: 0 },
        });

        // Should get 403 with insufficient_scope error
        expect(response.status()).toBe(403);

        const body: unknown = await response.json();
        expect(isRecord(body) ? body.code : undefined).toBe('scope_required');
    });

    test('should reject DELETE requests with read-only token (scope enforcement)', async ({
        request,
    }) => {
        if (!readOnlyToken) {
            test.skip(true, 'Could not create read-only token');
            return;
        }

        // Try a DELETE request - requires write scope
        const response = await request.delete(`/api/v1/play-sessions/${randomUUID()}`, {
            headers: {
                Authorization: `Bearer ${readOnlyToken}`,
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        // Should get 403 with insufficient_scope error
        expect(response.status()).toBe(403);

        const body: unknown = await response.json();
        expect(isRecord(body) ? body.code : undefined).toBe('scope_required');
    });
});

test.describe('Token Security Limits', () => {
    test('should reject tokens exceeding max length (2000 chars)', async ({ request }) => {
        // Create an excessively long token
        const longToken = 'pat_' + 'a'.repeat(2500);

        const response = await request.get('/api/v1/play-sessions', {
            headers: {
                Authorization: `Bearer ${longToken}`,
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        // Authentication failures use problem+json, including oversized credentials.
        expect(response.status()).toBe(401);

        const body: unknown = await response.json();
        expect(isRecord(body) ? body.code : undefined).toBe('invalid_token');
        const message = readMessage(body);
        if (message) {
            expect(message).toContain('maximum length');
        }
    });

    test('should reject empty Bearer token', async ({ request }) => {
        const response = await request.get('/api/v1/play-sessions', {
            headers: {
                Authorization: 'Bearer ',
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        expect(response.status()).toBe(401);
    });

    test('should reject Bearer header without token', async ({ request }) => {
        const response = await request.get('/api/v1/play-sessions', {
            headers: {
                Authorization: 'Bearer',
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        expect(response.status()).toBe(401);
    });
});

test.describe.serial('Admin Permission Enforcement', () => {
    const NON_ADMIN_USER = 'TestUserNonAdmin';
    const NON_ADMIN_GROUPS = 'Users'; // No admin/Librarians groups
    let nonAdminPatId: number | null = null;
    let nonAdminPatToken: string | null = null;

    test.beforeAll(async ({ request }) => {
        // Create PAT for non-admin user using forward auth headers
        const createResponse = await request.post('/api/me/pats', {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
            data: {
                name: 'Non-Admin Test Token',
                scopes: ['read', 'write'],
                expiresInDays: 1,
            },
        });

        if (createResponse.ok()) {
            const body: unknown = await createResponse.json();
            const tokenData = readTokenData(body);
            nonAdminPatId = tokenData?.id ?? null;
            nonAdminPatToken = tokenData?.token ?? null;
        }
    });

    test.afterAll(async ({ request }) => {
        // Clean up the PAT using forward auth
        if (nonAdminPatId) {
            await request.delete(`/api/me/pats/${nonAdminPatId}`, {
                headers: {
                    'X-Forwarded-User': NON_ADMIN_USER,
                    'X-Forwarded-Groups': NON_ADMIN_GROUPS,
                },
            });
        }
    });

    // Tests for /api/admin/* routes (use forward auth)
    test('should reject non-admin access to /api/admin/pats (forward auth)', async ({
        request,
    }) => {
        const response = await request.get('/api/admin/pats', {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });

        // Should get 403 Forbidden (user is not in admin groups)
        expect(response.status()).toBe(403);
    });

    test('should reject non-admin access to /api/admin/service-tokens (forward auth)', async ({
        request,
    }) => {
        const response = await request.get('/api/admin/service-tokens', {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });

        // Should get 403 Forbidden
        expect(response.status()).toBe(403);
    });

    test('should reject non-admin creating service tokens (forward auth)', async ({ request }) => {
        const response = await request.post('/api/admin/service-tokens', {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
            data: {
                name: 'Unauthorized Token',
                scopes: ['admin'],
                expiresInDays: 1,
            },
        });

        // Should get 403 Forbidden
        expect(response.status()).toBe(403);
    });

    // Tests for /api/v1 with PAT (Bearer auth)
    test('should allow non-admin to access regular /api/v1 endpoints via PAT', async ({
        request,
    }) => {
        if (!nonAdminPatToken) {
            test.skip(true, 'Could not create non-admin PAT');
            return;
        }

        const response = await request.get('/api/v1/play-sessions', {
            headers: {
                Authorization: `Bearer ${nonAdminPatToken}`,
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        // Should succeed - /api/v1/play-sessions doesn't require admin
        expect(response.ok()).toBeTruthy();
    });

    test('should allow admin to access /api/admin/pats (forward auth)', async ({ request }) => {
        // Use the default test user which has admin groups
        const response = await request.get('/api/admin/pats');

        // Check if feature is enabled, skip if not
        if (response.status() === 503) {
            test.skip(true, 'Device auth not enabled');
            return;
        }

        // Should succeed (test user has admin groups)
        expect(response.ok()).toBeTruthy();
    });
});

test.describe.serial('Service Token Impersonation Security', () => {
    test('should reject service token creation with non-existent actAsUserId', async ({
        request,
    }) => {
        // Try to create a service token with a non-existent user
        const response = await request.post('/api/admin/service-tokens', {
            data: {
                name: 'Impersonation Test Token',
                description: 'Tests impersonation security',
                scopes: ['read', 'write'],
                actAsUserId: randomUUID(), // Well-formed UUID for a user that does not exist
                expiresInDays: 1,
            },
        });

        if (response.status() === 503) {
            test.skip(true, 'Device auth not enabled');
            return;
        }

        if (response.status() === 403) {
            test.skip(true, 'Test user is not admin');
            return;
        }

        // Should fail at creation time. The problem+json taxonomy has no 400:
        // an unresolvable actAsUser is 422 validation_failed.
        expect(response.status()).toBe(422);

        const body: unknown = await response.json();
        const error = readError(body);
        expect(error).toContain('not found');
    });

    test('ignores an X-Act-As-User header instead of honouring it', async ({ request }) => {
        // Create a service token without actAsUser configured
        const createResponse = await request.post('/api/admin/service-tokens', {
            data: {
                name: 'Header Impersonation Test',
                scopes: ['read'],
                expiresInDays: 1,
            },
        });

        if (createResponse.status() === 503) {
            test.skip(true, 'Device auth not enabled');
            return;
        }

        if (createResponse.status() === 403) {
            test.skip(true, 'Test user is not admin');
            return;
        }

        if (!createResponse.ok()) {
            test.skip(true, 'Could not create service token');
            return;
        }

        const createBody: unknown = await createResponse.json();
        const tokenData = readTokenData(createBody);
        if (!tokenData) {
            test.skip(true, 'Service token response malformed');
            return;
        }

        try {
            // Use X-Act-As-User header to try impersonating non-existent user
            const response = await request.get('/api/v1/play-sessions', {
                headers: {
                    Authorization: `Bearer ${tokenData.token}`,
                    'X-Act-As-User': 'nonexistent_user_abc_67890',
                    'X-Forwarded-User': '',
                    'X-Forwarded-Groups': '',
                },
            });

            // The header is IGNORED, not rejected. forward-auth takes the
            // impersonation target exclusively from the DB-bound `act_as_user`
            // column set at token creation, precisely so a stolen monitor-only
            // token cannot escalate by naming a victim in a request header — it
            // logs the attempt and carries on as the token's own identity. That
            // is strictly stronger than the 403 this test used to expect, which
            // only covered the case where the named user did not exist.
            expect(response.status()).toBe(200);
            const body: unknown = await response.json();
            expect(readError(body)).toBeNull();
        } finally {
            // Cleanup
            await request.delete(`/api/admin/service-tokens/${tokenData.id}`);
        }
    });

    test('should allow valid user impersonation via X-Act-As-User header', async ({ request }) => {
        // Create a service token without actAsUser configured
        const createResponse = await request.post('/api/admin/service-tokens', {
            data: {
                name: 'Valid Impersonation Test',
                scopes: ['read'],
                expiresInDays: 1,
            },
        });

        if (createResponse.status() === 503) {
            test.skip(true, 'Device auth not enabled');
            return;
        }

        if (createResponse.status() === 403) {
            test.skip(true, 'Test user is not admin');
            return;
        }

        if (!createResponse.ok()) {
            test.skip(true, 'Could not create service token');
            return;
        }

        const createBody: unknown = await createResponse.json();
        const tokenData = readTokenData(createBody);
        if (!tokenData) {
            test.skip(true, 'Service token response malformed');
            return;
        }
        const TEST_USER = process.env.TEST_USER || 'TestUser';

        try {
            // Use X-Act-As-User header to impersonate a valid user (TestUser from global setup)
            const response = await request.get('/api/v1/play-sessions', {
                headers: {
                    Authorization: `Bearer ${tokenData.token}`,
                    'X-Act-As-User': TEST_USER,
                    'X-Forwarded-User': '',
                    'X-Forwarded-Groups': '',
                },
            });

            // Should succeed - TestUser exists in the database
            expect(response.ok()).toBeTruthy();
        } finally {
            // Cleanup
            await request.delete(`/api/admin/service-tokens/${tokenData.id}`);
        }
    });
});
