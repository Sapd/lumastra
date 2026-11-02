// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Authorization & IDOR Security Tests
 *
 * Tests for Insecure Direct Object Reference (IDOR) vulnerabilities
 * and authorization bypass in user-specific endpoints.
 *
 * IDOR vulnerabilities allow attackers to access other users' data
 * by manipulating object references (user IDs, item IDs, etc.)
 */

import { sameOriginAdminTest as test, expect } from './fixtures/auth';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { TEST_MEDIA_ITEM_ID } from './global-setup';

// Test users
const ADMIN_USER = process.env.TEST_USER || 'TestUser';
const NON_ADMIN_USER = 'TestUserNonAdmin';
const NON_ADMIN_GROUPS = 'Users';

// Helper to create PAT for a specific user
type ApiResponse<T> = {
    success?: boolean;
    message?: string;
    error?: string;
    data?: T;
};

const parseJson = async <T>(response: APIResponse): Promise<T> => (await response.json()) as T;

async function createPatForUser(
    request: APIRequestContext,
    username: string,
    groups: string,
): Promise<{ id: number; token: string }> {
    const response = await request.post('/api/me/pats', {
        headers: {
            'X-Forwarded-User': username,
            'X-Forwarded-Groups': groups,
        },
        data: {
            name: `Security Test PAT ${Date.now()}`,
            scopes: ['read', 'write'],
            expiresInDays: 1,
        },
    });

    // POST /api/me/pats answers a bare `{ id, token, message }` (201), with
    // `id` a number. This helper still read the retired
    // `{ success, data }` envelope, so it returned null even on success and
    // the Bearer IDOR test below skipped for as long as PATs were on.
    expect(response.status(), await response.text()).toBe(201);
    if (response.ok()) {
        const body = await parseJson<{ id?: string | number; token?: string }>(response);
        const id = Number(body.id);
        if (Number.isInteger(id) && id > 0 && typeof body.token === 'string') {
            return { id, token: body.token };
        }
    }
    throw new Error('PAT response malformed');
}

// Helper to delete PAT
async function deletePat(request: APIRequestContext, id: number, username: string, groups: string) {
    const response = await request.delete(`/api/me/pats/${id}`, {
        headers: {
            'X-Forwarded-User': username,
            'X-Forwarded-Groups': groups,
        },
    });
    expect(response.status(), await response.text()).toBe(204);
}

test.describe('IDOR: User Saved Movies/Watchlist', () => {
    let nonAdminPat: { id: number; token: string } | null = null;

    test.beforeAll(async ({ request }) => {
        nonAdminPat = await createPatForUser(request, NON_ADMIN_USER, NON_ADMIN_GROUPS);
    });

    test.afterAll(async ({ request }) => {
        if (nonAdminPat) {
            await deletePat(request, nonAdminPat.id, NON_ADMIN_USER, NON_ADMIN_GROUPS);
        }
    });

    // The former `/api/ai/saved-movies/[user_id]` endpoint was retired in favour
    // of `/api/watchlist`, which takes NO user_id path parameter — it is always
    // scoped to the authenticated caller. That removes the IDOR surface by
    // construction rather than by a selfOrAdmin gate, so the test below asserts
    // the absence of the parameterised path instead of a 403 on it.
    // (Parameterised selfOrAdmin IDOR coverage lives in the "IDOR: User Ratings"
    // describe block, which exercises the same gate on user-ratings/[user_id].)
    test('retired saved-movies path is gone; watchlist exposes no user_id parameter', async ({
        request,
    }) => {
        const retired = await request.get(`/api/ai/saved-movies/${ADMIN_USER}`, {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });
        expect(retired.status()).toBe(404);

        // A user_id-shaped suffix must not resolve to some other user's list.
        const parameterised = await request.get(`/api/watchlist/${ADMIN_USER}`, {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });
        expect(parameterised.ok()).toBeFalsy();
    });

    test('should NOT allow non-admin user to access admin user profile via Bearer token (/api/v1)', async ({
        request,
    }) => {
        if (!nonAdminPat) {
            test.skip(true, 'Could not create non-admin PAT');
            return;
        }

        // Non-admin user tries to access another user's profile via public API;
        // GET /api/v1/users/{id} requires users:admin scope.
        const response = await request.get(`/api/v1/users/${ADMIN_USER}`, {
            headers: {
                Authorization: `Bearer ${nonAdminPat.token}`,
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        // Should return 403 Forbidden — scope gate enforced by mount()/enforce()
        expect(response.status()).toBe(403);
    });

    test('should allow user to access their own watchlist', async ({ request }) => {
        const response = await request.get('/api/watchlist', {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });

        expect(response.ok()).toBeTruthy();
    });

    test('watchlist items expose the internal catalogue UUID', async ({ request }) => {
        // Regression guard for the reason this endpoint was reshaped: a client
        // must be able to resolve/play a watchlist entry, which requires the
        // internal UUID — not just TMDB/IMDB ids.
        const response = await request.get('/api/watchlist', {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });
        expect(response.ok()).toBeTruthy();

        const body = await response.json();
        expect(Array.isArray(body.items)).toBe(true);
        for (const item of body.items ?? []) {
            expect(item.media?.id).toBeTruthy();
            expect(item.media.ids.internal).toBe(item.media.id);
            expect(['movie', 'series']).toContain(item.media.type);
        }
    });
});

test.describe('IDOR: User Ratings', () => {
    test("should NOT allow user to access another user's ratings via user-ratings endpoint", async ({
        request,
    }) => {
        // Non-admin user tries to access admin user's ratings
        const response = await request.get(`/api/ai/user-ratings/${ADMIN_USER}`, {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });

        // Should return 403 Forbidden - IDOR protection via requireSelfOrAdmin middleware
        expect(response.status()).toBe(403);
    });

    test('should allow user to access their own ratings', async ({ request }) => {
        const response = await request.get(`/api/ai/user-ratings/${NON_ADMIN_USER}`, {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });

        // Should succeed
        expect(response.ok()).toBeTruthy();
    });

    test("should only return authenticated user's single rating (no IDOR possible)", async ({
        request,
    }) => {
        // Single rating endpoint uses locals.user.username internally
        const response = await request.get(`/api/media/${TEST_MEDIA_ITEM_ID}/rating`, {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });

        expect(response.ok()).toBeTruthy();
    });
});

test.describe('IDOR: User Clear Data', () => {
    test("should NOT allow non-admin to clear another user's data", async ({ request }) => {
        // Non-admin tries to clear admin's data
        const response = await request.delete(`/api/ai/clear-user/${ADMIN_USER}`, {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });

        // Should be forbidden (uses requireSelfOrAdmin middleware)
        expect(response.status()).toBe(403);
    });

    test('should allow user to clear their own data', async ({ request }) => {
        // User clearing their own data should be allowed
        // Note: This actually deletes data, so we just verify the endpoint exists and validates properly
        const response = await request.delete(`/api/ai/clear-user/${NON_ADMIN_USER}`, {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });

        // Should succeed (or fail gracefully if no data exists)
        expect([200, 204, 404]).toContain(response.status());
    });
});

test.describe('Authorization: Admin Endpoint Protection', () => {
    test('should reject non-admin access to generate suggestions for any user', async ({
        request,
    }) => {
        // Non-admin tries to generate suggestions for another user
        const response = await request.post(`/api/ai/generate-suggestions/${ADMIN_USER}`, {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });

        // Should require admin (uses requireAdmin middleware)
        expect(response.status()).toBe(403);
    });

    test('should reject non-admin access to generate profile for any user', async ({ request }) => {
        const response = await request.post(`/api/ai/generate-profile/${ADMIN_USER}`, {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });

        // Should require admin or self
        expect(response.status()).toBe(403);
    });
});

test.describe('Cross-User Streaming Session Access', () => {
    test('should handle non-existent stream token deletion idempotently', async ({ request }) => {
        // Try to delete a session with a non-existent token
        // DELETE is idempotent - returns success even if session doesn't exist
        const fakeStreamToken = '00000000-0000-4000-8000-000000000099';

        // The endpoint moved: the token is a path segment on
        // /api/v1/playback/grants/{id}, and a token that resolves to
        // nothing is 404 problem+json rather than a 200 "already ended" body.
        // The security property is unchanged and is what this test is for: one
        // user's guess at another's token reveals nothing and mutates nothing.
        const response = await request.delete(`/api/v1/playback/grants/${fakeStreamToken}`);

        expect([401, 404]).toContain(response.status());
    });
});

test.describe('Input Validation Security', () => {
    test('should handle SQL injection attempts in user ID parameter', async ({ request }) => {
        // SQL injection attempt in user_id parameter
        const sqlInjectionPayloads = [
            "'; DROP TABLE user_saved_movies; --",
            "' OR '1'='1",
            '1; SELECT * FROM users --',
            "admin'--",
        ];

        for (const payload of sqlInjectionPayloads) {
            const response = await request.get(
                `/api/ai/user-ratings/${encodeURIComponent(payload)}`,
                {
                    headers: {
                        'X-Forwarded-User': NON_ADMIN_USER,
                        'X-Forwarded-Groups': NON_ADMIN_GROUPS,
                    },
                },
            );

            // Should not return 500 (which might indicate SQL error)
            // Parameterized queries should prevent SQL injection
            expect(response.status()).not.toBe(500);

            // Should either return 400 (bad request), 403 (forbidden), or empty results
            expect([200, 400, 403, 404]).toContain(response.status());
        }
    });

    test('should handle path traversal attempts', async ({ request }) => {
        const pathTraversalPayloads = [
            '../../../etc/passwd',
            '..%2F..%2F..%2Fetc%2Fpasswd',
            '....//',
        ];

        for (const payload of pathTraversalPayloads) {
            const response = await request.get(
                `/api/ai/user-ratings/${encodeURIComponent(payload)}`,
                {
                    headers: {
                        'X-Forwarded-User': NON_ADMIN_USER,
                        'X-Forwarded-Groups': NON_ADMIN_GROUPS,
                    },
                },
            );

            // Should not expose system files
            expect(response.status()).not.toBe(500);
        }
    });
});

test.describe('Input Validation: mediaType Parameter', () => {
    test('should reject invalid mediaType values', async ({ request }) => {
        const response = await request.get('/api/media/tmdb:550:invalid/rating', {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
            },
        });

        // The problem+json taxonomy has no 400: a rejected id is 422.
        expect(response.status()).toBe(422);
        const body = await parseJson<ApiResponse<unknown>>(response);
        expect(body.error ?? '').toBeTruthy();
    });

    test('should accept valid mediaType "movie"', async ({ request }) => {
        const response = await request.get(
            `/api/media/${TEST_MEDIA_ITEM_ID}/rating?externalId=tmdb:550:movie`,
            {
                headers: {
                    'X-Forwarded-User': NON_ADMIN_USER,
                    'X-Forwarded-Groups': NON_ADMIN_GROUPS,
                },
            },
        );

        // Should succeed (200) even if no rating exists
        expect(response.ok()).toBeTruthy();
    });

    test('should accept valid mediaType "tv"', async ({ request }) => {
        const response = await request.get(
            `/api/media/${TEST_MEDIA_ITEM_ID}/rating?externalId=tmdb:1399:tv`,
            {
                headers: {
                    'X-Forwarded-User': NON_ADMIN_USER,
                    'X-Forwarded-Groups': NON_ADMIN_GROUPS,
                },
            },
        );

        // Should succeed (200) even if no rating exists
        expect(response.ok()).toBeTruthy();
    });
});

test.describe('Error Information Leakage', () => {
    test('should not leak stack traces in API error responses', async ({ request }) => {
        // Test API endpoint error responses (JSON format)
        // Use Accept: application/json to ensure we get JSON, not HTML
        const response = await request.get('/api/media/invalid-id/rating', {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
                Accept: 'application/json',
            },
        });

        // 422 validation_failed — the taxonomy has no 400.
        expect(response.status()).toBe(422);

        const body = await response.text();

        // Should not contain stack trace indicators in error response
        expect(body).not.toContain('at Object.');
        expect(body).not.toContain('at Function.');
        expect(body).not.toContain('Error:');
        // Note: .ts and .js might appear in normal response text, so we check for line numbers
        expect(body).not.toMatch(/\.(ts|js):\d+:\d+/);
    });

    test('should return proper JSON error for bad requests', async ({ request }) => {
        // API endpoints should return structured JSON errors
        const response = await request.get('/api/media/invalid-id/rating', {
            headers: {
                'X-Forwarded-User': NON_ADMIN_USER,
                'X-Forwarded-Groups': NON_ADMIN_GROUPS,
                Accept: 'application/json',
            },
        });

        expect(response.status()).toBe(422);

        const body = await parseJson<ApiResponse<unknown>>(response);

        // Structured problem+json: `code` is the discriminator, `error` the
        // human sentence. There is no `success` flag any more.
        expect(body.error).toBeDefined();
    });
});
