// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { grantTest as test, expect } from './helpers/playback-start';
import { TEST_EP1_ID, TEST_MEDIA_ITEM_ID } from './global-setup';

test.describe('Playback grant isolation and validation', () => {
    test('every start has a unique session and grant', async ({ startPlayback }) => {
        const starts = await Promise.all(Array.from({ length: 4 }, () => startPlayback()));
        expect(new Set(starts.map((s) => s.playbackSessionId)).size).toBe(4);
        expect(new Set(starts.map((s) => s.grant.id)).size).toBe(4);
        expect(new Set(starts.map((s) => s.grant.token)).size).toBe(4);
    });
    test('same-item grants on different devices stay independent', async ({
        request,
        startPlayback,
        accountHeaders,
    }) => {
        const first = await startPlayback();
        const second = await startPlayback();
        await request.delete(`/api/v1/playback/grants/${first.grant.id}`, {
            headers: accountHeaders,
        });
        expect(
            (
                await request.get(`/api/v1/playback/grants/${second.grant.id}`, {
                    headers: accountHeaders,
                })
            ).status(),
        ).toBe(200);
    });
    test('different-item grants stay valid side by side', async ({
        request,
        startPlayback,
        accountHeaders,
    }) => {
        const starts = await Promise.all([startPlayback(), startPlayback(TEST_EP1_ID)]);
        for (const start of starts)
            expect(
                (
                    await request.get(`/api/v1/playback/grants/${start.grant.id}`, {
                        headers: accountHeaders,
                    })
                ).status(),
            ).toBe(200);
    });
    test('video expiry starts at the 24-hour ceiling', async ({ startPlayback }) => {
        const before = Date.now();
        const start = await startPlayback();
        expect(Date.parse(start.grant.expiresAt) - before).toBeGreaterThan(23 * 60 * 60 * 1000);
        expect(Date.parse(start.grant.expiresAt) - Date.now()).toBeLessThanOrEqual(
            24 * 60 * 60 * 1000,
        );
        expect(Date.parse(start.grant.renewAfter)).toBeLessThan(Date.parse(start.grant.expiresAt));
    });
    test('renewal cannot increase the kind ceiling', async ({
        request,
        startPlayback,
        accountHeaders,
    }) => {
        const start = await startPlayback();
        const response = await request.post(start.grant.renewHref, {
            headers: accountHeaders,
            data: { token: start.grant.token, ttl: 999999999999 },
        });
        expect(response.status()).toBe(200);
        expect(Date.parse((await response.json()).expiresAt) - Date.now()).toBeLessThanOrEqual(
            24 * 60 * 60 * 1000,
        );
    });
    test('renewal never changes item binding from body input', async ({
        request,
        startPlayback,
        accountHeaders,
    }) => {
        const start = await startPlayback();
        const response = await request.post(start.grant.renewHref, {
            headers: accountHeaders,
            data: {
                token: start.grant.token,
                mediaId: TEST_EP1_ID,
                playbackSessionId: randomUUID(),
                kind: 'music',
                clientIp: '*',
            },
        });
        expect(response.status()).toBe(200);
        expect(await response.json()).toMatchObject({
            mediaId: start.mediaId,
            playbackSessionId: start.playbackSessionId,
            kind: 'video',
        });
    });
    const hostileIds = [
        "'; DROP TABLE play_sessions; --",
        '<script>alert(1)</script>',
        'stream_',
        'abc\x00def',
        '\u001f\ufeff',
        'a'.repeat(10000),
    ];
    for (const [index, id] of hostileIds.entries()) {
        test(`rejects hostile grant id ${index} cleanly`, async ({ request, accountHeaders }) => {
            const response = await request.get(
                `/api/v1/playback/grants/${encodeURIComponent(id)}`,
                { headers: accountHeaders },
            );
            expect(response.status()).toBe(422);
            expect(await response.json()).not.toHaveProperty('token');
        });
    }
    test('an empty grant id is not a lookup', async ({ request, accountHeaders }) => {
        expect(
            (await request.get('/api/v1/playback/grants/', { headers: accountHeaders })).status(),
        ).toBe(404);
    });
    test('concurrent renewals preserve the same resource and secret', async ({
        request,
        startPlayback,
        accountHeaders,
    }) => {
        const start = await startPlayback();
        const responses = await Promise.all(
            Array.from({ length: 3 }, () =>
                request.post(start.grant.renewHref, {
                    headers: accountHeaders,
                    data: { token: start.grant.token },
                }),
            ),
        );
        responses.forEach((r) => expect(r.status()).toBe(200));
        const grants = await Promise.all(responses.map((r) => r.json()));
        grants.forEach((g) => expect(g.token).toBe(start.grant.token));
        grants.forEach((g) => expect(g.id).toBe(start.grant.id));
    });
    test('revocation rejects the original and renewed secrets', async ({
        request,
        startPlayback,
        accountHeaders,
    }) => {
        const start = await startPlayback();
        const renewed = await request.post(start.grant.renewHref, {
            headers: accountHeaders,
            data: { token: start.grant.token },
        });
        expect(renewed.status()).toBe(200);
        const next = await renewed.json();
        await request.delete(`/api/v1/playback/grants/${start.grant.id}`, {
            headers: accountHeaders,
        });
        for (const token of [start.grant.token, next.token]) {
            expect(
                (
                    await request.get(`/api/v1/playback/${start.mediaId}/file?grant=${token}`, {
                        headers: { 'X-Forwarded-User': '', 'X-Forwarded-Groups': '' },
                    })
                ).status(),
            ).toBe(401);
        }
    });
    for (const query of ['stream_token', 'api_key']) {
        test(`retired ${query} queries cannot authenticate delivery`, async ({
            request,
            startPlayback,
        }) => {
            const start = await startPlayback();
            expect(
                (
                    await request.get(
                        `/api/v1/playback/${start.mediaId}/file?${query}=${start.grant.token}`,
                        { headers: { 'X-Forwarded-User': '', 'X-Forwarded-Groups': '' } },
                    )
                ).status(),
            ).toBe(401);
        });
    }
    test('a grant cannot be used as a Bearer account token', async ({ request, startPlayback }) => {
        const start = await startPlayback();
        expect(
            (
                await request.get(`/api/v1/playback/grants/${start.grant.id}`, {
                    headers: {
                        Authorization: `Bearer ${start.grant.token}`,
                        'X-Forwarded-User': '',
                        'X-Forwarded-Groups': '',
                    },
                })
            ).status(),
        ).toBe(401);
    });
    test('start validation rejects the retired snake_case request', async ({
        request,
        accountHeaders,
    }) => {
        expect(
            (
                await request.post('/api/v1/play-sessions', {
                    headers: accountHeaders,
                    data: { media_id: TEST_MEDIA_ITEM_ID, device_id: 'old-client' },
                })
            ).status(),
        ).toBe(422);
    });
});
