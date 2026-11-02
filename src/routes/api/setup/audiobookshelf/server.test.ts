// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for POST /api/setup/audiobookshelf — connect AudiobookShelf from
 * the first-run wizard.
 *
 * The HTTP boundary is `fetchWithTimeout`; the real probe
 * (`probeAudiobookshelf`) and the real ABS client run on top of it, so these
 * tests see exactly what the server would send and what it does with each kind
 * of answer. The config store is the other boundary: the real
 * `settings-write.ts` runs against a mocked `$lib/server/config/index.js`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    fetch: vi.fn(),
    values: {} as Record<string, unknown>,
    envKeys: new Set<string>(),
    saved: [] as Record<string, unknown>[],
    audits: [] as unknown[][],
    libraryRows: [] as Array<{ provider: string }>,
    users: vi.fn(),
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/utils/fetch-timeout.js', () => ({
    fetchWithTimeout: (...a: unknown[]) => state.fetch(...a),
}));
// The ABS module builds a singleton over the live config at import; the probe
// never reads it, so a bare object is enough and keeps the config system out.
vi.mock('$lib/server/config.js', () => ({
    config: {
        get AUDIOURL() {
            return state.values.AUDIOURL ?? '';
        },
        get AUDIOAPIKEY() {
            return state.values.AUDIOAPIKEY ?? '';
        },
        AUDIOBOOK_AUTO_CREATE_USERS: false,
    },
}));
vi.mock('$lib/server/config/index.js', () => ({
    getAll: () => ({ ...state.values }),
    isEnvOverridden: (key: string) => state.envKeys.has(key),
    saveConfig: vi.fn(async (updates: Record<string, unknown>) => {
        state.saved.push(updates);
    }),
}));
vi.mock('$lib/server/utils/audit-log', () => ({
    auditLog: (...args: unknown[]) => state.audits.push(args),
    auditActorFromLocals: () => ({ kind: 'user', username: 'admin' }),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => state.users },
}));
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getAllLibraryPaths: async () => state.libraryRows,
}));

import { POST } from './+server';

const API_KEY = 'abs-key-0123456789';

function call(body: unknown): Promise<Response> {
    const request = new Request('http://localhost/api/setup/audiobookshelf', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return POST({ request, locals: { user: { username: 'admin' } } } as never) as Promise<Response>;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

const LIBRARIES = {
    libraries: [
        { id: 'lib-books', name: 'Audiobooks', mediaType: 'book' },
        { id: 'lib-pods', name: 'Podcasts', mediaType: 'podcast' },
    ],
};

beforeEach(() => {
    state.fetch.mockReset();
    state.values = {};
    state.envKeys = new Set();
    state.saved = [];
    state.audits = [];
    state.libraryRows = [];
    state.users
        .mockReset()
        .mockImplementation(async (strings: TemplateStringsArray) =>
            strings.join(' ').includes('SELECT puc.user_id')
                ? []
                : [{ userId: 'admin', username: 'admin', linked: false, pullDisabled: false }],
        );
});

describe('POST /api/setup/audiobookshelf', () => {
    it('reports the admin and all active users using the listening-sync matching rule', async () => {
        const users = [
            { username: 'admin', linked: false, pullDisabled: false },
            { username: ' cafe\u0301 ', linked: false, pullDisabled: false },
            { username: 'missing', linked: false, pullDisabled: false },
            { username: 'ambiguous', linked: false, pullDisabled: false },
        ];
        state.users.mockImplementation(async (strings: TemplateStringsArray) =>
            strings.join(' ').includes('SELECT puc.user_id') ? [] : users,
        );
        state.fetch.mockResolvedValueOnce(jsonResponse(LIBRARIES)).mockResolvedValueOnce(
            jsonResponse({
                users: [
                    { id: 'a1', username: 'ADMIN' },
                    { id: 'a2', username: 'CAFÉ' },
                    { id: 'a3', username: 'Ambiguous' },
                    { id: 'a4', username: 'AMBIGUOUS' },
                ],
            }),
        );
        const res = await call({ url: 'http://abs.lan/proxy?tenant=one', apiKey: API_KEY });
        expect(await res.json()).toMatchObject({
            connected: true,
            userMatchStatus: 'ok',
            adminUsername: 'admin',
            adminMatched: true,
            matchedName: 'ADMIN',
            matchedUsernames: [' cafe\u0301 ', 'admin'],
            unmatchedUsernames: ['ambiguous', 'missing'],
        });
        expect(state.fetch.mock.calls[1][0]).toBe('http://abs.lan/proxy/api/users?tenant=one');
    });

    it('lists upstream-only users in the setup response', async () => {
        state.fetch
            .mockResolvedValueOnce(jsonResponse(LIBRARIES))
            .mockResolvedValueOnce(
                jsonResponse({ users: [{ id: 'abs-only', username: 'absorphan' }] }),
            );
        const res = await call({ url: 'http://abs.lan', apiKey: API_KEY });
        expect((await res.json()).unmatchedUsernames).toEqual(['absorphan', 'admin']);
    });

    it('reports an unmatched admin without refusing a working connection', async () => {
        state.fetch
            .mockResolvedValueOnce(jsonResponse(LIBRARIES))
            .mockResolvedValueOnce(jsonResponse({ users: [] }));
        const res = await call({ url: 'http://abs.lan', apiKey: API_KEY });
        expect(await res.json()).toMatchObject({
            connected: true,
            adminMatched: false,
            unmatchedUsernames: ['admin'],
        });
        expect(state.saved).toHaveLength(1);
    });

    it('distinguishes unavailable user enumeration from no match without echoing credentials', async () => {
        state.fetch
            .mockResolvedValueOnce(jsonResponse(LIBRARIES))
            .mockRejectedValueOnce(new Error(`http://user:password@abs.lan ${API_KEY}`));
        const res = await call({ url: 'http://abs.lan', apiKey: API_KEY });
        const body = await res.json();
        expect(body).toMatchObject({
            connected: true,
            userMatchStatus: 'unavailable',
            adminMatched: null,
        });
        expect(JSON.stringify(body)).not.toMatch(/password|abs-key-/);
        expect(state.saved).toHaveLength(1);
    });

    it('probes the entered server, then saves URL, key and the feature flag', async () => {
        state.fetch.mockResolvedValue(jsonResponse(LIBRARIES));

        const res = await call({ url: ' http://abs.lan:13378/ ', apiKey: ` ${API_KEY} ` });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ connected: true, libraryCount: 1 });

        expect(state.fetch).toHaveBeenCalledTimes(2);
        const [url, init] = state.fetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://abs.lan:13378/api/libraries');
        expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);

        expect(state.saved).toEqual([
            { AUDIOURL: 'http://abs.lan:13378', AUDIOAPIKEY: API_KEY, FEATURE_AUDIOBOOKS: true },
        ]);
        // Audited by key NAME; the key itself is never in the audit entry.
        expect(state.audits).toHaveLength(1);
        expect(JSON.stringify(state.audits)).not.toContain(API_KEY);
        expect(state.audits[0][3]).toEqual({
            changedKeys: ['AUDIOURL', 'AUDIOAPIKEY', 'FEATURE_AUDIOBOOKS'],
        });
    });

    it('keeps a reverse-proxy sub-path', async () => {
        state.fetch.mockResolvedValue(jsonResponse(LIBRARIES));
        await call({ url: 'https://home.example/abs//', apiKey: API_KEY });
        expect(state.fetch.mock.calls[0][0]).toBe('https://home.example/abs/api/libraries');
        expect(state.saved[0].AUDIOURL).toBe('https://home.example/abs');
    });

    it('keeps base query parameters when probing and saving a proxy subpath', async () => {
        state.fetch.mockResolvedValue(jsonResponse(LIBRARIES));
        const res = await call({
            url: 'https://home.example/abs//?tenant=one&tag=a&tag=b',
            apiKey: API_KEY,
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ connected: true, libraryCount: 1 });
        expect(state.fetch.mock.calls[0][0]).toBe(
            'https://home.example/abs/api/libraries?tenant=one&tag=a&tag=b',
        );
        expect(state.saved[0].AUDIOURL).toBe('https://home.example/abs?tenant=one&tag=a&tag=b');
    });

    it('does not rewrite values that are already stored', async () => {
        state.values = {
            AUDIOURL: 'http://abs.lan',
            AUDIOAPIKEY: API_KEY,
            FEATURE_AUDIOBOOKS: true,
        };
        state.fetch.mockResolvedValue(jsonResponse(LIBRARIES));
        const res = await call({ url: 'http://abs.lan', apiKey: API_KEY });
        expect((await res.json()).connected).toBe(true);
        expect(state.saved).toEqual([]);
        expect(state.audits).toEqual([]);
    });

    it.each([
        ['a rejected key', jsonResponse({}, 401), { reason: 'auth' }],
        ['a forbidden key', jsonResponse({}, 403), { reason: 'auth' }],
        ['a server error', jsonResponse({}, 502), { reason: 'http', httpStatus: 502 }],
        [
            'a page that is not ABS',
            new Response('<!DOCTYPE html><title>router admin secret</title>', { status: 200 }),
            { reason: 'not_audiobookshelf' },
        ],
        [
            'JSON without libraries',
            jsonResponse({ hello: 'world' }),
            { reason: 'not_audiobookshelf' },
        ],
        [
            'only libraries without ids',
            jsonResponse({ libraries: [{ name: 'x', mediaType: 'book' }] }),
            { reason: 'not_audiobookshelf' },
        ],
    ])('stores nothing and returns a fixed code for %s', async (_label, response, expected) => {
        state.fetch.mockResolvedValue(response);
        const res = await call({ url: 'http://abs.lan', apiKey: API_KEY });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ connected: false, ...expected });
        // Nothing from the upstream body is echoed.
        expect(JSON.stringify(body)).not.toContain('secret');
        expect(state.saved).toEqual([]);
    });

    it('reports an unreachable server as network, without the error text', async () => {
        state.fetch.mockRejectedValue(
            Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
        );
        const res = await call({ url: 'http://10.0.0.9:13378', apiKey: API_KEY });
        expect(await res.json()).toMatchObject({ connected: false, reason: 'network' });
        expect(state.saved).toEqual([]);
    });

    it.each([
        ['TimeoutError', /timed out/i],
        ['AbortError', /timed out/i],
        ['FetchRedirectError', /redirect.*refused|refused.*redirect/i],
    ])(
        'preserves %s from the ABS client through the probe and saved listing',
        async (name, expected) => {
            state.fetch.mockRejectedValue(
                Object.assign(new Error('key-secret user:password'), { name }),
            );
            const response = await call({ url: 'http://abs.lan', apiKey: API_KEY });
            expect((await response.json()).error).toMatch(expected);
            expect(state.saved).toEqual([]);
            state.values = { AUDIOURL: 'http://abs.lan', AUDIOAPIKEY: API_KEY };
            const { getRemoteLibrarySource } =
                await import('$lib/server/services/remote-library-sources.js');
            const listing = await getRemoteLibrarySource('audiobookshelf')!.listLibraries();
            expect(listing.status).toBe('unreachable');
            if (listing.status === 'unreachable') {
                expect(listing.message).toMatch(expected);
                expect(listing.message).not.toMatch(/key-secret|user:password/);
            }
        },
    );

    it.each([
        ['https://abs.lan', 'DEPTH_ZERO_SELF_SIGNED_CERT', /NODE_EXTRA_CA_CERTS/],
        ['http://localhost:13378', 'ECONNREFUSED', /container itself/i],
        ['http://127.0.0.1:13378', 'ECONNREFUSED', /container itself/i],
        ['http://abs.lan', 'ENOTFOUND', /host name not found/i],
    ])('gives a safe remedy for %s (%s)', async (url, code, expected) => {
        state.fetch.mockRejectedValue(
            new TypeError('key-secret user:password', {
                cause: Object.assign(new Error('key-secret'), { code }),
            }),
        );
        const res = await call({ url, apiKey: API_KEY });
        const body = await res.json();
        expect(body.error).toMatch(expected);
        expect(body.error).not.toMatch(/key-secret|user:password/);
        expect(state.saved).toEqual([]);
    });

    it.each([
        ['https://abs.lan', 'DEPTH_ZERO_SELF_SIGNED_CERT', /NODE_EXTRA_CA_CERTS/],
        ['http://localhost:13378', 'ECONNREFUSED', /container itself/i],
    ])(
        'gives the same safe remedy when listing a saved connection at %s',
        async (url, code, expected) => {
            state.values = { AUDIOURL: url, AUDIOAPIKEY: API_KEY };
            state.fetch.mockRejectedValue(
                new TypeError('key-secret user:password', { cause: { code } }),
            );
            const { getRemoteLibrarySource } =
                await import('$lib/server/services/remote-library-sources.js');
            const listing = await getRemoteLibrarySource('audiobookshelf')!.listLibraries();
            expect(listing.status).toBe('unreachable');
            if (listing.status === 'unreachable') {
                expect(listing.message).toMatch(expected);
                expect(listing.message).not.toMatch(/key-secret|user:password/);
            }
        },
    );

    it('refuses to store over a value an environment variable owns', async () => {
        state.envKeys.add('AUDIOURL');
        state.values = { AUDIOURL: 'http://env-abs' };
        state.fetch.mockResolvedValue(jsonResponse(LIBRARIES));
        const res = await call({ url: 'http://abs.lan', apiKey: API_KEY });
        expect(await res.json()).toEqual({
            connected: false,
            reason: 'env_locked',
            keys: ['AUDIOURL'],
        });
        expect(state.saved).toEqual([]);
        // Refused before the probe: the typed key went nowhere.
        expect(state.fetch).not.toHaveBeenCalled();
    });

    it('names an env-owned feature flag that is off', async () => {
        state.envKeys.add('FEATURE_AUDIOBOOKS');
        state.values = { FEATURE_AUDIOBOOKS: false };
        const res = await call({ url: 'http://abs.lan', apiKey: API_KEY });
        expect(await res.json()).toEqual({
            connected: false,
            reason: 'env_locked',
            keys: ['FEATURE_AUDIOBOOKS'],
        });
        expect(state.fetch).not.toHaveBeenCalled();
    });

    it('does not move existing Audiobookshelf libraries to another server', async () => {
        state.values = { AUDIOURL: 'http://old-abs', AUDIOAPIKEY: 'old', FEATURE_AUDIOBOOKS: true };
        state.libraryRows = [{ provider: 'tmdb' }, { provider: 'audiobookshelf' }];
        const res = await call({ url: 'http://new-abs', apiKey: API_KEY });
        expect(await res.json()).toEqual({ connected: false, reason: 'libraries_exist' });
        expect(state.fetch).not.toHaveBeenCalled();
        expect(state.saved).toEqual([]);
    });

    it('accepts a new key for the same server while its libraries exist', async () => {
        state.values = { AUDIOURL: 'http://abs.lan', AUDIOAPIKEY: 'old', FEATURE_AUDIOBOOKS: true };
        state.libraryRows = [{ provider: 'audiobookshelf' }];
        state.fetch.mockResolvedValue(jsonResponse(LIBRARIES));
        const res = await call({ url: 'http://abs.lan/', apiKey: API_KEY });
        expect((await res.json()).connected).toBe(true);
        expect(state.saved).toEqual([{ AUDIOAPIKEY: API_KEY }]);
    });

    it('drops a malformed library row instead of rejecting a real server', async () => {
        state.fetch.mockResolvedValue(
            jsonResponse({ libraries: [...LIBRARIES.libraries, { id: 7, name: null }] }),
        );
        const res = await call({ url: 'http://abs.lan', apiKey: API_KEY });
        expect(await res.json()).toMatchObject({ connected: true, libraryCount: 1 });
    });

    it('accepts a server that has no libraries yet', async () => {
        state.fetch.mockResolvedValue(jsonResponse({ libraries: [] }));
        const res = await call({ url: 'http://abs.lan', apiKey: API_KEY });
        expect(await res.json()).toMatchObject({ connected: true, libraryCount: 0 });
    });

    it.each([
        ['missing url', { apiKey: API_KEY }],
        ['ftp url', { url: 'ftp://abs.lan', apiKey: API_KEY }],
        ['file url', { url: 'file:///etc/passwd', apiKey: API_KEY }],
        ['credentials in url', { url: 'http://user:pw@abs.lan', apiKey: API_KEY }],
        ['fragment in url', { url: 'http://abs.lan/#x', apiKey: API_KEY }],
        ['not a url', { url: 'abs.lan', apiKey: API_KEY }],
        ['missing key', { url: 'http://abs.lan' }],
        ['key with a newline', { url: 'http://abs.lan', apiKey: 'abc\ndef' }],
        ['key too long', { url: 'http://abs.lan', apiKey: 'k'.repeat(4097) }],
        ['non-object body', ['http://abs.lan']],
    ])('rejects %s without contacting anything', async (_label, body) => {
        const res = await call(body);
        expect(res.status).toBe(422);
        expect(JSON.stringify(await res.json())).not.toContain(API_KEY);
        expect(state.fetch).not.toHaveBeenCalled();
        expect(state.saved).toEqual([]);
    });
});
