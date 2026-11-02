// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import plugin from './index.js';

// Task 4: pullWatchState must honor `options.onlyUserIds` — restricting the
// per-user loop to the given set — and report progress per user via
// `options.onProgress`. Two users are linked (u1, u2); onlyUserIds: ['u1']
// must mean u2's token is NEVER used and onProgress never fires for u2.
// Minimal ctx.http test double: forwards to the (stubbed) global `fetch` so
// the existing header assertions on the fetch mock keep working unchanged —
// pullWatchState only issues GETs, all of which now route through
// ctx.http.get (C22 fix round 1's ctx.http migration).
const httpMock = {
    get: (url, opts) => fetch(url, { ...opts, method: 'GET' }),
    post: (url, body, opts) =>
        fetch(url, {
            ...opts,
            method: 'POST',
            body: body == null ? null : typeof body === 'string' ? body : JSON.stringify(body),
            headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
        }),
};

function makeCtx(tokensByUser) {
    return {
        sql: async () => [],
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        secrets: {},
        userCredentials: {
            listUsersWithKey: async () => Object.keys(tokensByUser),
            get: async (userId, key) => {
                const tokens = tokensByUser[userId];
                if (key === 'access_token') return tokens.accessToken;
                if (key === 'refresh_token') return tokens.refreshToken ?? null;
                if (key === 'provider_username') return tokens.providerUsername ?? null;
                return null;
            },
        },
        http: httpMock,
        // initFromCtx() requires ctx.catalog (always present on a real
        // PluginContext — see resolve-ids-persists-live-search.test.js).
        catalog: { upsertExternalId: async () => {} },
    };
}

describe('mal pullWatchState onlyUserIds', () => {
    /** @type {string[]} */
    let seenAuthHeaders;

    beforeEach(() => {
        seenAuthHeaders = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, opts) => {
                seenAuthHeaders.push(opts?.headers?.Authorization);
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: async () => ({ data: [], paging: {} }),
                };
            }),
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('restricts the pull loop to onlyUserIds and reports progress only for them', async () => {
        const ctx = makeCtx({
            u1: {
                accessToken: 'u1-access-token',
                refreshToken: 'u1-refresh',
                providerUsername: 'u1-mal',
            },
            u2: {
                accessToken: 'u2-access-token',
                refreshToken: 'u2-refresh',
                providerUsername: 'u2-mal',
            },
        });

        const progress = [];
        const result = await plugin.pullWatchState(ctx, {
            onlyUserIds: ['u1'],
            onProgress: (p) => progress.push(p),
        });

        expect(result.errors).toEqual([]);
        expect(progress).toEqual([{ processed: 1, total: 1, currentUser: 'u1' }]);
        expect(seenAuthHeaders.some((h) => h?.includes('u1-access-token'))).toBe(true);
        expect(seenAuthHeaders.some((h) => h?.includes('u2-access-token'))).toBe(false);
    });
});
