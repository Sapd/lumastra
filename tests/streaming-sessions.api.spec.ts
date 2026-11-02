// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { grantTest as test, expect, playbackCapabilities } from './helpers/playback-start';
import { TEST_EP1_ID, TEST_MEDIA_ITEM_ID } from './global-setup';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const readPatResponse = (body: unknown): { token: string; id: number } | null => {
    // POST /api/me/pats answers a BARE `{ id, token, message }` at 201 — the
    // `{ success, data: { … } }` envelope is gone, and `id` is a number.
    // Reading `body.data` therefore always returned null, createTestPAT() always
    // returned null, and every test guarded by `if (!patData) test.skip()` in this
    // file quietly skipped instead of running.
    if (!isRecord(body)) return null;
    const token = body.token;
    const rawId = body.id;
    const id =
        typeof rawId === 'number'
            ? rawId
            : typeof rawId === 'string' && Number.isFinite(Number(rawId))
              ? Number(rawId)
              : null;
    if (typeof token === 'string' && id !== null) {
        return { token, id };
    }
    return null;
};

test.describe('Playback starts and delivery grants', () => {
    test('requires account authentication to start', async ({ request }) => {
        const response = await request.post('/api/v1/play-sessions', {
            headers: { 'X-Forwarded-User': '', 'X-Forwarded-Groups': '' },
            data: {
                mediaId: TEST_MEDIA_ITEM_ID,
                deviceId: 'anonymous',
                capabilities: playbackCapabilities,
            },
        });
        expect(response.status()).toBe(401);
    });
    test('starts with a PAT and returns one session identity', async ({ startPlayback }) => {
        const start = await startPlayback();
        expect(start.reporting.playbackSessionId).toBe(start.playbackSessionId);
        expect(start.reporting.href).toContain(start.playbackSessionId);
        expect(start.grant.id).not.toBe(start.grant.token);
    });
    test('returns ready delivery hrefs', async ({ startPlayback }) => {
        const start = await startPlayback();
        expect('url' in start.delivery).toBe(true);
        if (!('url' in start.delivery)) throw new Error('Expected video URL');
        const href = new URL(start.delivery.url, 'https://playback.invalid');
        expect(href.searchParams.get('grant')).toBe(start.grant.token);
        expect(href.searchParams.get('PlaySessionId')).toBe(start.playbackSessionId);
    });
    test('describes an active grant by public id without returning its secret', async ({
        request,
        startPlayback,
        accountHeaders,
    }) => {
        const start = await startPlayback();
        const response = await request.get(`/api/v1/playback/grants/${start.grant.id}`, {
            headers: accountHeaders,
        });
        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body.mediaId).toBe(start.mediaId);
        expect(body.playbackSessionId).toBe(start.playbackSessionId);
        expect(body.token).toBeUndefined();
    });
    test('the secret is not a grant resource id', async ({
        request,
        startPlayback,
        accountHeaders,
    }) => {
        const start = await startPlayback();
        const response = await request.get(`/api/v1/playback/grants/${start.grant.token}`, {
            headers: accountHeaders,
        });
        expect(response.status()).toBe(422);
    });
    test('unknown grant ids are not found', async ({ request, accountHeaders }) => {
        expect(
            (
                await request.get(`/api/v1/playback/grants/${randomUUID()}`, {
                    headers: accountHeaders,
                })
            ).status(),
        ).toBe(404);
    });
    test('deleting a grant ends delivery', async ({ request, startPlayback, accountHeaders }) => {
        const start = await startPlayback();
        expect(
            (
                await request.delete(`/api/v1/playback/grants/${start.grant.id}`, {
                    headers: accountHeaders,
                })
            ).status(),
        ).toBe(204);
        expect(
            (
                await request.get(`/api/v1/playback/grants/${start.grant.id}`, {
                    headers: accountHeaders,
                })
            ).status(),
        ).toBe(404);
    });
    test('deleting a grant again is not a second successful revocation', async ({
        request,
        startPlayback,
        accountHeaders,
    }) => {
        const start = await startPlayback();
        await request.delete(`/api/v1/playback/grants/${start.grant.id}`, {
            headers: accountHeaders,
        });
        expect(
            (
                await request.delete(`/api/v1/playback/grants/${start.grant.id}`, {
                    headers: accountHeaders,
                })
            ).status(),
        ).toBe(404);
    });
    test('grant-only delivery needs no account credential', async ({ request, startPlayback }) => {
        const start = await startPlayback();
        if (!('url' in start.delivery)) throw new Error('Expected video URL');
        const response = await request.get(start.delivery.url, {
            headers: { 'X-Forwarded-User': '', 'X-Forwarded-Groups': '' },
        });
        expect(response.status()).toBe(200);
    });
    test('delivery grants cannot authenticate JSON APIs', async ({ request, startPlayback }) => {
        const start = await startPlayback();
        const response = await request.post(
            `/api/v1/media/${start.mediaId}/playability?grant=${start.grant.token}`,
            { data: {}, headers: { 'X-Forwarded-User': '', 'X-Forwarded-Groups': '' } },
        );
        expect(response.status(), await response.text()).toBe(403);
        expect(response.headers()['x-playback-grant-reason']).toBe('wrong_scope');
    });
    test('a grant is rejected for another media item', async ({ request, startPlayback }) => {
        const start = await startPlayback();
        const response = await request.get(
            `/api/v1/playback/${TEST_EP1_ID}/file?grant=${start.grant.token}`,
            { headers: { 'X-Forwarded-User': '', 'X-Forwarded-Groups': '' } },
        );
        expect(response.status(), await response.text()).toBe(403);
        expect(response.headers()['x-playback-grant-reason']).toBe('wrong_scope');
    });
    test('renewal requires an account credential', async ({ request, startPlayback }) => {
        const start = await startPlayback();
        expect(
            (
                await request.post(start.grant.renewHref, {
                    headers: { 'X-Forwarded-User': '', 'X-Forwarded-Groups': '' },
                    data: {},
                })
            ).status(),
        ).toBe(401);
    });
    test('renewal extends expiry and preserves the secret and binding', async ({
        request,
        startPlayback,
        accountHeaders,
    }) => {
        const start = await startPlayback();
        const response = await request.post(start.grant.renewHref, {
            headers: accountHeaders,
            data: { token: start.grant.token },
        });
        expect(response.status()).toBe(200);
        const renewed = await response.json();
        expect(renewed.id).toBe(start.grant.id);
        expect(renewed.token).toBe(start.grant.token);
        expect(renewed.mediaId).toBe(start.mediaId);
        expect(renewed.playbackSessionId).toBe(start.playbackSessionId);
        expect(Date.parse(renewed.expiresAt)).toBeGreaterThanOrEqual(
            Date.parse(start.grant.expiresAt),
        );
    });
    test('renewing an unknown grant fails', async ({ request, accountHeaders }) => {
        expect(
            (
                await request.post(`/api/v1/playback/grants/${randomUUID()}/renew`, {
                    headers: accountHeaders,
                    data: { token: 'nonexistent-grant-secret' },
                })
            ).status(),
        ).toBe(404);
    });
    test('a revoked grant cannot be renewed', async ({
        request,
        startPlayback,
        accountHeaders,
    }) => {
        const start = await startPlayback();
        await request.delete(`/api/v1/playback/grants/${start.grant.id}`, {
            headers: accountHeaders,
        });
        expect(
            (
                await request.post(start.grant.renewHref, {
                    headers: accountHeaders,
                    data: { token: start.grant.token },
                })
            ).status(),
        ).toBe(404);
    });
    test('playability descriptions contain no playable URLs or credentials', async ({
        request,
        accountHeaders,
    }) => {
        const response = await request.post(`/api/v1/media/${TEST_MEDIA_ITEM_ID}/playability`, {
            headers: accountHeaders,
            data: {},
        });
        expect(response.status()).toBe(200);
        const info = await response.json();
        for (const version of info.versions) expect(version).not.toHaveProperty('url');
        expect(JSON.stringify(info)).not.toMatch(/grant=|stream_token=|api_key=/);
    });
    test('the grants collection is not a lookup', async ({ request, accountHeaders }) => {
        expect(
            (await request.get('/api/v1/playback/grants', { headers: accountHeaders })).status(),
        ).toBe(404);
    });
    test('deleting the grants collection is not a session end', async ({
        request,
        accountHeaders,
    }) => {
        expect(
            (await request.delete('/api/v1/playback/grants', { headers: accountHeaders })).status(),
        ).toBe(404);
    });
    test('ending the playback session revokes its grant', async ({
        request,
        startPlayback,
        accountHeaders,
    }) => {
        const start = await startPlayback();
        expect(
            (
                await request.put(start.reporting.href, {
                    headers: accountHeaders,
                    data: {
                        status: 'COMPLETED',
                        positionMs: 1000,
                        eventSeq: 1,
                        sessionElapsedMs: 1000,
                        endReason: 'user',
                    },
                })
            ).status(),
        ).toBe(204);
        expect(
            (
                await request.get(`/api/v1/playback/grants/${start.grant.id}`, {
                    headers: accountHeaders,
                })
            ).status(),
        ).toBe(404);
    });
});

const E2E_CORS_ORIGIN = 'https://e2e-cors-client.example';

test.describe('CORS Support', () => {
    // The preflight is answered centrally in hooks.server.ts, ahead of the
    // /api/v1 auth backstop — a browser sends OPTIONS with no credential, and
    // that backstop returns 401 before `resolve()`, so a per-route
    // `export const OPTIONS` on a v1 route can never run. The retired
    // `/stream-session` route had one; it was unreachable by the time this
    // surface required a Bearer.
    test('preflight for a stream-token lookup is granted to an allowlisted origin', async ({
        request,
    }) => {
        const response = await request.fetch(
            '/api/v1/playback/grants/00000000-0000-4000-8000-000000000001',
            {
                method: 'OPTIONS',
                headers: {
                    Origin: E2E_CORS_ORIGIN,
                    'Access-Control-Request-Method': 'GET',
                    'Access-Control-Request-Headers': 'authorization',
                },
            },
        );

        expect(response.status()).toBe(204);
        const headers = response.headers();
        expect(headers['access-control-allow-origin']).toBe(E2E_CORS_ORIGIN);
        expect(headers['access-control-allow-methods']).toContain('GET');
        expect(headers['access-control-allow-methods']).toContain('DELETE');
        // Authorization is the credential now and is NOT CORS-safelisted, so the
        // call is refused unless the preflight names it.
        expect(headers['access-control-allow-headers']).toContain('Authorization');
        // Byte-ranged playback preflights too.
        expect(headers['access-control-allow-headers']).toContain('Range');
        expect(headers['access-control-allow-credentials']).toBe('true');
        // The answer varies by Origin, so it must not be reused from a shared cache.
        expect(headers['vary'] ?? '').toContain('Origin');
    });

    test('preflight for the collection route is granted (POST creates a token)', async ({
        request,
    }) => {
        const response = await request.fetch('/api/v1/play-sessions', {
            method: 'OPTIONS',
            headers: {
                Origin: E2E_CORS_ORIGIN,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'authorization,content-type',
            },
        });

        expect(response.status()).toBe(204);
        expect(response.headers()['access-control-allow-methods']).toContain('POST');
    });

    test('an origin that is not allowlisted gets no grant', async ({ request }) => {
        const response = await request.fetch(
            '/api/v1/playback/grants/00000000-0000-4000-8000-000000000001',
            {
                method: 'OPTIONS',
                headers: {
                    Origin: 'https://not-allowlisted.example',
                    'Access-Control-Request-Method': 'GET',
                },
            },
        );

        // No allow-origin header ⇒ the browser blocks the real request. (The
        // status itself is the auth backstop's 401; what matters is the absence
        // of a grant.)
        expect(response.headers()['access-control-allow-origin']).toBeUndefined();
    });

    test('the real response repeats the grant, not just the preflight', async ({ request }) => {
        // A preflight that authorises a call whose response then omits
        // Access-Control-Allow-Origin is useless — the browser still refuses to
        // hand the body to the caller. /api/v1 is a bypass-auth path whose
        // responses return early in hooks.server.ts, so this is easy to lose.
        const patResponse = await request.post('/api/me/pats', {
            data: { name: 'CORS Test', scopes: ['read'], expiresInDays: 1 },
        });
        expect(patResponse.status(), await patResponse.text()).toBe(201);
        const patData = readPatResponse(await patResponse.json());
        if (!patData) {
            throw new Error('PAT response malformed');
        }

        try {
            const response = await request.get(
                '/api/v1/playback/grants/00000000-0000-4000-8000-000000000002',
                {
                    headers: {
                        Origin: E2E_CORS_ORIGIN,
                        Authorization: `Bearer ${patData.token}`,
                    },
                },
            );

            const headers = response.headers();
            expect(headers['access-control-allow-origin']).toBe(E2E_CORS_ORIGIN);
            expect(headers['access-control-expose-headers'] ?? '').toContain('Content-Range');
        } finally {
            const revoked = await request.delete(`/api/me/pats/${patData.id}`);
            expect(revoked.status(), await revoked.text()).toBe(204);
        }
    });

    test('a rejection carries the grant too, so the browser can read the error', async ({
        request,
    }) => {
        // Without this the /api/v1 auth backstop's 401 is invisible to a browser
        // client: the fetch rejects as an opaque CORS failure, so "your token
        // expired" arrives at the app as "network error".
        const response = await request.get(
            '/api/v1/playback/grants/00000000-0000-4000-8000-000000000001',
            {
                headers: {
                    Origin: E2E_CORS_ORIGIN,
                    'X-Forwarded-User': '',
                    'X-Forwarded-Groups': '',
                },
            },
        );

        expect(response.status()).toBe(401);
        expect(response.headers()['access-control-allow-origin']).toBe(E2E_CORS_ORIGIN);
    });
});
