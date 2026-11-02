// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together Authorization Tests
 *
 * Verifies that watch-together endpoints enforce participant membership:
 * - GET /api/watch-together/[code] returns 403 for non-participants
 * - POST /api/watch-together/[code]/ready returns 403 for non-participants
 * - Non-existent session codes return 404
 */

import { adminTest as test, expect } from './fixtures/auth';
import type { APIRequestContext } from '@playwright/test';

const HOST_USER = process.env.TEST_USER || 'TestUser';
const OTHER_USER = 'TestUserNonAdmin';

const hostHeaders = {
    'X-Forwarded-User': HOST_USER,
    'X-Forwarded-Groups': 'Users|Librarians|admin',
};

const otherHeaders = {
    'X-Forwarded-User': OTHER_USER,
    'X-Forwarded-Groups': 'Users',
};

const unauthHeaders = {
    'X-Forwarded-User': '',
    'X-Forwarded-Groups': '',
};

const CLIENT_ID = 'test-client-001';
const OTHER_CLIENT_ID = 'test-client-002';

/**
 * Create a watch-together session as the host user.
 * Returns the session code.
 */
async function createSession(request: APIRequestContext): Promise<string> {
    const response = await request.post('/api/watch-together/parties', {
        headers: hostHeaders,
        data: {
            itemId: 'test-item-uuid-001',
            mediaType: 'movie',
            title: 'Test Movie',
            clientId: CLIENT_ID,
        },
    });
    expect(response.ok(), `Create session failed: ${response.status()}`).toBe(true);
    const body = await response.json();
    return body.party.code;
}

/**
 * Clean up a session after test (best-effort).
 */
async function deleteSession(request: APIRequestContext, code: string): Promise<void> {
    await request
        .delete(`/api/watch-together/${code}`, {
            headers: hostHeaders,
        })
        .catch(() => {});
}

test.describe('Watch Together - GET session authorization', () => {
    let sessionCode: string;

    test.beforeAll(async ({ request }) => {
        sessionCode = await createSession(request);
    });

    test.afterAll(async ({ request }) => {
        await deleteSession(request, sessionCode);
    });

    test('host (participant) can GET session', async ({ request }) => {
        const response = await request.get(`/api/watch-together/${sessionCode}`, {
            headers: hostHeaders,
        });
        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body.party).toBeDefined();
        expect(body.party.code).toBe(sessionCode);
    });

    test('non-participant gets 403', async ({ request }) => {
        const response = await request.get(`/api/watch-together/${sessionCode}`, {
            headers: otherHeaders,
        });
        expect(response.status()).toBe(403);
    });

    test('non-existent session code returns 404', async ({ request }) => {
        const response = await request.get('/api/watch-together/FAKE-CODE', {
            headers: hostHeaders,
        });
        expect(response.status()).toBe(404);
    });

    test('a request with no credential is rejected on the v1 surface', async ({ request }) => {
        const response = await request.get(`/api/v1/watch-together/${sessionCode}`, {
            headers: unauthHeaders,
        });
        expect(response.status()).toBe(401);
    });
});

test.describe('Watch Together - Ready endpoint authorization', () => {
    let sessionCode: string;

    test.beforeAll(async ({ request }) => {
        sessionCode = await createSession(request);
    });

    test.afterAll(async ({ request }) => {
        await deleteSession(request, sessionCode);
    });

    test('non-participant gets 403 on ready', async ({ request }) => {
        const response = await request.post(`/api/watch-together/${sessionCode}/ready`, {
            headers: otherHeaders,
            data: {
                clientId: OTHER_CLIENT_ID,
                checkId: 'e2e-check-1',
                currentTime: 0,
            },
        });
        expect(response.status()).toBe(403);
    });

    test('blank forward-auth headers are unauthenticated (401)', async ({ request }) => {
        // This used to expect 403: under `vite dev` blank headers resolved to
        // DEFAULT_USER, an admin non-participant. A production build answers
        // 401, and so does the e2e server now (LUMASTRA_DEV_NO_DEFAULT_USER in
        // playwright.config.ts). The non-participant 403 is covered above.
        const response = await request.post(`/api/watch-together/${sessionCode}/ready`, {
            headers: unauthHeaders,
            data: {
                clientId: OTHER_CLIENT_ID,
                checkId: 'e2e-check-1',
                currentTime: 0,
            },
        });
        expect(response.status()).toBe(401);
    });
});

test.describe('Watch Together - Joined participant access', () => {
    let sessionCode: string;

    test.beforeAll(async ({ request }) => {
        sessionCode = await createSession(request);
        // Join as the other user
        const joinResponse = await request.post(`/api/watch-together/${sessionCode}/join`, {
            headers: otherHeaders,
            data: { clientId: OTHER_CLIENT_ID },
        });
        expect(joinResponse.ok(), `Join failed: ${joinResponse.status()}`).toBe(true);
    });

    test.afterAll(async ({ request }) => {
        await deleteSession(request, sessionCode);
    });

    test('joined participant can GET session', async ({ request }) => {
        const response = await request.get(`/api/watch-together/${sessionCode}`, {
            headers: otherHeaders,
        });
        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body.party.code).toBe(sessionCode);
        expect(body.party.participants.length).toBe(2);
        expect(body.party.visibility).toBe('unlisted');
        for (const participant of body.party.participants) {
            expect(participant.userId).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
            );
            expect(participant).toHaveProperty('displayName');
            expect(
                participant.displayName === null || typeof participant.displayName === 'string',
            ).toBe(true);
            expect(participant.username).toBeUndefined();
        }
    });

    test('joined participant can signal ready', async ({ request }) => {
        const response = await request.post(`/api/watch-together/${sessionCode}/ready`, {
            headers: otherHeaders,
            data: {
                clientId: OTHER_CLIENT_ID,
                checkId: 'e2e-check-1',
                currentTime: 1000,
            },
        });
        // 204 No Content — the route's own header documents it.
        expect(response.status()).toBe(204);
    });
});
