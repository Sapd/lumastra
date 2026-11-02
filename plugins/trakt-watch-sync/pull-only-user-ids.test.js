// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import plugin from './index.js';

// Task 4: pullWatchState must honor `options.onlyUserIds` — restricting the
// per-user loop to the given set — and report progress per user via
// `options.onProgress`. Two users are linked (u1, u2); onlyUserIds: ['u1']
// must mean u2's token is NEVER used and onProgress never fires for u2.
// Minimal ctx.http test double: forwards to the (stubbed) global `fetch` so
// the existing header/URL assertions on the fetch mock keep working
// unchanged — see index.test.ts's httpMock doc comment for the full
// rationale (C22 fix round 1: traktApiForUser now routes through ctx.http).
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
    };
}

describe('trakt pullWatchState onlyUserIds', () => {
    /** @type {string[]} */
    let seenAuthHeaders;
    let prevClientId;
    let prevClientSecret;

    beforeEach(() => {
        prevClientId = process.env.TRAKT_CLIENT_ID;
        prevClientSecret = process.env.TRAKT_CLIENT_SECRET;
        process.env.TRAKT_CLIENT_ID = 'test-client-id';
        process.env.TRAKT_CLIENT_SECRET = 'test-client-secret';

        seenAuthHeaders = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, opts) => {
                seenAuthHeaders.push(opts?.headers?.Authorization);
                return {
                    ok: true,
                    status: 200,
                    headers: { get: () => '1' },
                    json: async () => [],
                };
            }),
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        if (prevClientId === undefined) delete process.env.TRAKT_CLIENT_ID;
        else process.env.TRAKT_CLIENT_ID = prevClientId;
        if (prevClientSecret === undefined) delete process.env.TRAKT_CLIENT_SECRET;
        else process.env.TRAKT_CLIENT_SECRET = prevClientSecret;
    });

    it('restricts the pull loop to onlyUserIds and reports progress only for them', async () => {
        const ctx = makeCtx({
            u1: { accessToken: 'u1-access-token', refreshToken: 'u1-refresh' },
            u2: { accessToken: 'u2-access-token', refreshToken: 'u2-refresh' },
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
