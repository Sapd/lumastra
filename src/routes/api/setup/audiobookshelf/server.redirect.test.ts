// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/setup/audiobookshelf through the REAL fetchWithTimeout, with only
 * the global `fetch` stubbed. The sibling server.test.ts mocks fetchWithTimeout
 * away, so it cannot see the redirect guard; this file pins that the probe goes
 * through it: a 3xx to another host is not followed, the typed key is not sent
 * there, and nothing about the target is echoed or stored.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({ saved: [] as Record<string, unknown>[] }));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/config.js', () => ({ config: { AUDIOURL: '', AUDIOAPIKEY: '' } }));
vi.mock('$lib/server/config/index.js', () => ({
    getAll: () => ({}),
    isEnvOverridden: () => false,
    saveConfig: vi.fn(async (updates: Record<string, unknown>) => {
        state.saved.push(updates);
    }),
}));
vi.mock('$lib/server/utils/audit-log', () => ({
    auditLog: vi.fn(),
    auditActorFromLocals: () => ({ kind: 'user', username: 'admin' }),
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => null },
}));

import { POST } from './+server';

const API_KEY = 'abs-key-redirect-test';
const fetchStub = vi.fn();

beforeEach(() => {
    state.saved = [];
    fetchStub.mockReset();
    vi.stubGlobal('fetch', fetchStub);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

function call(url: string): Promise<Response> {
    const request = new Request('http://localhost/api/setup/audiobookshelf', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, apiKey: API_KEY }),
    });
    return POST({ request, locals: { user: { username: 'admin' } } } as never) as Promise<Response>;
}

describe('POST /api/setup/audiobookshelf redirect guard', () => {
    it('does not follow a redirect to another host and stores nothing', async () => {
        fetchStub.mockResolvedValue(
            new Response(null, {
                status: 302,
                headers: { location: 'http://169.254.169.254/latest/meta-data/' },
            }),
        );

        const res = await call('http://abs.lan:13378');
        const body = await res.json();

        expect(body).toEqual({ connected: false, reason: 'network', error: expect.any(String) });
        expect(JSON.stringify(body)).not.toContain('169.254');
        expect(fetchStub).toHaveBeenCalledTimes(1);
        expect(String(fetchStub.mock.calls[0][0])).toBe('http://abs.lan:13378/api/libraries');
        expect(state.saved).toEqual([]);
    });

    it('follows a same-host upgrade to https and connects', async () => {
        fetchStub
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 301,
                    headers: { location: 'https://abs.lan/api/libraries' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ libraries: [] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            );

        const res = await call('http://abs.lan');
        expect(await res.json()).toMatchObject({
            connected: true,
            libraryCount: 0,
            userMatchStatus: 'unavailable',
        });
        expect(fetchStub).toHaveBeenCalledTimes(2);
    });
});
