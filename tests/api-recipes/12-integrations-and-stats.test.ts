// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Owner: package 15. A package that changes this area updates this recipe in the same commit.
import { test, expect } from 'vitest';
import { client, clientFor, expectOk } from './client';
import { login, request } from './harness';

const ADMIN_USER = process.env.RECIPES_ADMIN_FORWARD_USER ?? 'safetynet-admin';
const ADMIN_GROUPS = process.env.RECIPES_ADMIN_FORWARD_GROUPS ?? 'Kreditoren';
const STATS_REASONS = ['insufficient_data', 'access_unavailable', 'failed'];

test('12 integration token: one integrations:read service token reads the integration endpoints and nothing else', async () => {
    // Test-harness login for the operator; a real operator uses the admin UI or their own admin token.
    const admin = await login(ADMIN_USER, ADMIN_GROUPS, true);
    const adminClient = clientFor(admin.token);
    let tokenId: number | undefined;
    try {
        // 1. The operator mints the dashboard credential: one grant, nothing else.
        const minted = expectOk(
            'POST',
            '/service-tokens',
            await adminClient.POST('/api/v1/service-tokens', {
                body: {
                    name: 'api-safety-net-integrations',
                    scopes: ['integrations:read'],
                    expiresInDays: 1,
                },
            }),
        );
        tokenId = minted.id;
        const listed = expectOk(
            'GET',
            '/service-tokens/{id}',
            await adminClient.GET('/api/v1/service-tokens/{id}', {
                params: { path: { id: String(minted.id) } },
            }),
        );
        expect(listed.scopes).toEqual(['integrations:read']);
        expect(listed.owner).not.toBeNull();

        // 2. The dashboard reads its endpoints with that token.
        const homepage = await request('/api/v1/integrations/homepage', minted.token);
        expect(homepage.status).toBe(200);
        const history = await request(
            `/api/v1/integrations/watch-history?user=${encodeURIComponent(ADMIN_USER)}&limit=1`,
            minted.token,
        );
        expect(history.status).toBe(200);

        // 3. Anywhere else the token is refused, even on endpoints any signed-in user may read.
        for (const path of ['/api/v1/me/stats', '/api/v1/me', '/api/v1/service-tokens']) {
            const refused = await request(path, minted.token);
            expect(refused.status, path).toBe(403);
        }

        // 4. An admin credential that is not an integration token cannot read watch history.
        const adminHistory = await request(
            `/api/v1/integrations/watch-history?user=${encodeURIComponent(ADMIN_USER)}&limit=1`,
            admin.token,
        );
        expect(adminHistory.status).toBe(403);
    } finally {
        if (tokenId !== undefined) {
            const revoked = await request(`/api/v1/service-tokens/${tokenId}`, admin.token, {
                method: 'DELETE',
            });
            expect(revoked.status).toBe(204);
        }
        await admin.close();
    }
});

test('12 personal stats: named metrics, typed unavailable reasons, one call', async () => {
    const result = await client.GET('/api/v1/me/stats', {
        params: { query: { include: 'overview,watchTime,topTitles', period: 'all', limit: 5 } },
    });
    if (result.response.status === 404) {
        console.warn('[skip] FEATURE_PERSONAL_STATS is off on this server');
        return;
    }
    const stats = expectOk('GET', '/me/stats', result);
    const allowed = ['overview', 'watchTime', 'topTitles'];
    for (const key of Object.keys(stats.metrics)) expect(allowed).toContain(key);
    for (const entry of stats.unavailable) {
        expect(allowed).toContain(entry.metric);
        expect(STATS_REASONS).toContain(entry.reason);
    }
    // Every requested metric is either present or explained.
    for (const metric of allowed) {
        const present = metric in stats.metrics;
        const explained = stats.unavailable.some((u) => u.metric === metric);
        expect(present || explained, metric).toBe(true);
    }
    if (stats.metrics.overview) {
        expect(Number.isInteger(stats.metrics.overview.totalWatchTimeMs)).toBe(true);
    }
    if (stats.metrics.topTitles)
        expect(stats.metrics.topTitles.items.length).toBeLessThanOrEqual(5);

    // Metric names are the camelCase response keys; the old kebab-case names are refused.
    const old = await client.GET('/api/v1/me/stats', {
        params: { query: { include: 'watch-time' } },
    });
    expect(old.response.status).toBe(422);
});
