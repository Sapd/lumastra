// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    config: {} as Record<string, string | boolean>,
    fetch: vi.fn(),
    tmdb: { getMovieGenres: vi.fn() },
}));

const localeState = vi.hoisted(() => ({ current: 'en' }));
vi.mock('$lib/paraglide/runtime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/paraglide/runtime')>()),
    getLocale: () => localeState.current,
}));

vi.mock('$lib/server/config.js', () => ({ config: h.config }));
vi.mock('$lib/server/config/domains/ai.js', () => ({ getAiConfig: () => ({}) }));
vi.mock('$lib/server/utils/fetch-timeout.js', () => ({ fetchWithTimeout: h.fetch }));
vi.mock('$lib/server/providers/implementations/tmdb', () => ({ tmdbApi: h.tmdb }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/providers/implementations/musicbrainz/acoustid.js', () => ({
    resolveAcoustIdApiKey: vi.fn(async () => null),
}));
vi.mock('$lib/server/providers/implementations/anidb/config-loader.js', () => ({
    resolveAnidbClient: vi.fn(async () => ({})),
}));

import { hasHealthCheck, runProviderHealthCheck } from './provider-health';
import { SECRET_CONFIGURED_SENTINEL } from '$lib/shared/secret-sentinel';

function ok(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
    for (const k of Object.keys(h.config)) delete h.config[k];
    h.fetch.mockReset();
});

describe('runProviderHealthCheck', () => {
    it('tests the typed (unsaved) URL and key instead of the saved ones', async () => {
        h.config.SONARRURL = 'http://old:8989';
        h.config.SONARRAPIKEY = 'old-key';
        h.fetch.mockResolvedValue(ok({ version: '4.0' }));

        const r = await runProviderHealthCheck('sonarr', {
            SONARRURL: 'http://new:8989',
            SONARRAPIKEY: 'new-key',
        });

        expect(r.healthy).toBe(true);
        expect(h.fetch).toHaveBeenCalledWith(
            'http://new:8989/api/v3/system/status',
            { headers: { 'X-Api-Key': 'new-key' } },
            expect.any(Number),
        );
    });

    it('falls back to the stored key when the form holds the stored-secret sentinel', async () => {
        h.config.SONARRURL = 'http://sonarr:8989';
        h.config.SONARRAPIKEY = 'stored-key';
        h.fetch.mockResolvedValue(ok({}));

        await runProviderHealthCheck('sonarr', {
            SONARRURL: 'http://sonarr:8989/',
            SONARRAPIKEY: SECRET_CONFIGURED_SENTINEL,
        });

        expect(h.fetch.mock.calls[0][1]).toEqual({ headers: { 'X-Api-Key': 'stored-key' } });
    });

    it('never sends the stored key to a server the form changed', async () => {
        h.config.SONARRURL = 'http://sonarr:8989';
        h.config.SONARRAPIKEY = 'stored-key';
        h.config.AUDIOURL = 'http://abs:13378';
        h.config.AUDIOAPIKEY = 'abs-key';

        for (const [provider, overrides] of [
            [
                'sonarr',
                { SONARRURL: 'http://attacker:8989', SONARRAPIKEY: SECRET_CONFIGURED_SENTINEL },
            ],
            ['sonarr', { SONARRURL: 'http://sonarr:9999' }],
            ['audiobookshelf', { AUDIOURL: 'https://attacker.example' }],
        ] as const) {
            const r = await runProviderHealthCheck(provider, overrides);
            expect(r.healthy).toBe(false);
            expect(r.error).toMatch(/API key/);
        }
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it("ignores override keys the provider's check does not own", async () => {
        h.config.RADARRURL = 'http://radarr:7878';
        h.config.RADARRAPIKEY = 'k';
        h.fetch.mockResolvedValue(ok({}));

        await runProviderHealthCheck('radarr', { SONARRURL: 'http://evil' });

        expect(h.fetch.mock.calls[0][0]).toBe('http://radarr:7878/api/v3/system/status');
    });

    it('rejects a non-http URL override without making a request', async () => {
        const r = await runProviderHealthCheck('sonarr', {
            SONARRURL: 'file:///etc/passwd',
            SONARRAPIKEY: 'k',
        });
        expect(r.healthy).toBe(false);
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it('reports a MusicBrainz 503 as rate limiting, not an outage', async () => {
        h.fetch.mockResolvedValue(new Response('', { status: 503 }));
        const r = await runProviderHealthCheck('musicbrainz-metadata-provider');
        expect(r.rateLimited).toBe(true);
        expect(r.error).toMatch(/rate-limiting/);
    });

    it('tests Jellyfin on an explicit admin check while Jellyfin sync is still off', async () => {
        h.config.JELLYFINURL = 'http://jellyfin:8096';
        h.config.JELLYFINAPIKEY = 'jf-key';
        h.config.FEATURE_JELLYFIN_SYNC = false;
        h.fetch.mockResolvedValue(ok({ ServerName: 'jf', Version: '10.10' }));

        const r = await runProviderHealthCheck('jellyfin');

        expect(r.healthy).toBe(true);
        expect(h.fetch).toHaveBeenCalledTimes(1);
    });

    it('uses modern auth with the unsaved Jellyfin key and explains a 401', async () => {
        h.config.JELLYFINURL = 'http://old:8096';
        h.config.JELLYFINAPIKEY = 'saved-key';
        h.fetch.mockResolvedValue(new Response(null, { status: 401 }));
        const result = await runProviderHealthCheck('jellyfin', {
            JELLYFINURL: 'http://new:8096',
            JELLYFINAPIKEY: 'entered-key',
        });
        expect(h.fetch).toHaveBeenCalledWith(
            'http://new:8096/System/Info',
            expect.objectContaining({
                headers: {
                    Authorization: expect.stringMatching(
                        /^MediaBrowser Client="Lumastra", .*Token="entered-key"$/,
                    ),
                },
            }),
            expect.any(Number),
        );
        expect(result.healthy).toBe(false);
        expect(result.error).toMatch(
            /401.*API key.*Jellyfin Dashboard > API Keys.*reverse proxy.*Authorization/,
        );
        expect(result.error).not.toContain('entered-key');
    });

    it('tests Jellyfin with sync on', async () => {
        h.config.JELLYFINURL = 'http://jellyfin:8096';
        h.config.JELLYFINAPIKEY = 'jf-key';
        h.config.FEATURE_JELLYFIN_SYNC = true;
        h.fetch.mockResolvedValue(ok({ ServerName: 'jf', Version: '10.10' }));

        const r = await runProviderHealthCheck('jellyfin');

        expect(r.healthy).toBe(true);
        expect(h.fetch).toHaveBeenCalledTimes(1);
    });

    it('still reports Not configured without URL + key', async () => {
        h.config.JELLYFINURL = '';
        h.config.JELLYFINAPIKEY = '';
        h.config.FEATURE_JELLYFIN_SYNC = false;

        const r = await runProviderHealthCheck('jellyfin');

        expect(r.error).toBe('Not configured');
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it.each(['http://proxy/jellyfin/', 'http://proxy//jellyfin//'])(
        'keeps a normalized Jellyfin base path for unsaved URL %s',
        async (base) => {
            h.fetch.mockResolvedValue(ok({ ServerName: 'jf' }));
            await runProviderHealthCheck('jellyfin', {
                JELLYFINURL: base,
                JELLYFINAPIKEY: 'key',
            });
            expect(h.fetch.mock.calls[0][0]).toBe('http://proxy/jellyfin/System/Info');
        },
    );

    it('explains ABS authentication failures from a proxy without exposing the key', async () => {
        h.fetch.mockResolvedValue(new Response(null, { status: 401 }));
        const result = await runProviderHealthCheck('audiobookshelf', {
            AUDIOURL: 'http://proxy/audiobookshelf/',
            AUDIOAPIKEY: 'entered-secret',
        });
        expect(h.fetch.mock.calls[0][0]).toBe('http://proxy/audiobookshelf/api/authorize');
        expect(result.healthy).toBe(false);
        expect(result.error).toMatch(/API key.*reverse proxy.*Authorization/);
        expect(result.error).not.toContain('entered-secret');
    });

    it('says a provider without a check is not checkable', async () => {
        expect(hasHealthCheck('database-cleanup')).toBe(false);
        expect(hasHealthCheck('tmdb-metadata-provider')).toBe(true);
        expect((await runProviderHealthCheck('database-cleanup')).checkable).toBe(false);
    });
});

describe('provider health cancellation', () => {
    it('threads the optional caller signal to the provider fetch', async () => {
        h.config.SONARRURL = 'http://sonarr:8989';
        h.config.SONARRAPIKEY = 'stored-key';
        const controller = new AbortController();
        h.fetch.mockResolvedValue(ok({}));
        await runProviderHealthCheck('sonarr', undefined, controller.signal);
        expect(h.fetch).toHaveBeenCalledWith(
            'http://sonarr:8989/api/v3/system/status',
            expect.objectContaining({ signal: controller.signal }),
            expect.any(Number),
        );
    });

    it('makes the provider request abortable by the caller', async () => {
        h.config.SONARRURL = 'http://sonarr:8989';
        h.config.SONARRAPIKEY = 'stored-key';
        const controller = new AbortController();
        h.fetch.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener(
                        'abort',
                        () => reject(new Error('caller aborted')),
                        { once: true },
                    );
                }),
        );
        const probe = runProviderHealthCheck('sonarr', undefined, controller.signal);
        controller.abort();
        const result = await probe;
        expect(result.healthy).toBe(false);
        expect(result.error).toBe('Connection test cancelled.');
    });
});

describe.each([
    ['sonarr', 'SONARR', '/api/v3/system/status'],
    ['radarr', 'RADARR', '/api/v3/system/status'],
    ['jellyseerr', 'SEERR', '/api/v1/status'],
])('%s actionable connection errors', (provider, prefix, endpoint) => {
    beforeEach(() => {
        h.config[`${prefix}URL`] = 'https://example.com/base///';
        h.config[`${prefix}APIKEY`] = 'private-api-key';
    });
    it('preserves the base path and strips trailing slashes', async () => {
        h.fetch.mockResolvedValue(ok({ version: '1' }));
        expect((await runProviderHealthCheck(provider)).healthy).toBe(true);
        expect(h.fetch.mock.calls[0][0]).toBe(`https://example.com/base${endpoint}`);
    });
    it.each([
        [401, /API key rejected/],
        [403, /API key rejected/],
        [404, /[Ww]rong address or base path/],
        [503, /[Ss]erver.*503/],
    ])('explains HTTP %s without returning upstream text', async (status, cause) => {
        h.fetch.mockResolvedValue(new Response('private-api-key', { status }));
        const result = await runProviderHealthCheck(provider);
        expect(result.error).toMatch(cause);
        expect(JSON.stringify(result)).not.toContain('private-api-key');
    });
    it.each([
        ['ENOTFOUND', /host name not found/],
        ['ECONNREFUSED', /refused/],
        ['CERT_HAS_EXPIRED', /TLS/],
        ['ETIMEDOUT', /timed out/],
        ['EOTHER', /[Cc]onnection failed/],
    ])('explains %s without leaking the raw exception', async (code, cause) => {
        h.fetch.mockRejectedValue(
            new Error('https://user:private-api-key@example.com/?token=secret', {
                cause: Object.assign(new Error('private-api-key'), { code }),
            }),
        );
        const result = await runProviderHealthCheck(provider);
        expect(result.error).toMatch(cause);
        expect(JSON.stringify(result)).not.toMatch(/private-api-key|user:|token=secret/);
    });
});

function fetchFailed(code: string, causeMessage = ''): TypeError {
    return new TypeError('fetch failed', {
        cause: Object.assign(new Error(causeMessage || code), { code }),
    });
}

describe('connection test errors on the Settings page (F1, F2, F4)', () => {
    beforeEach(() => {
        localeState.current = 'en';
    });

    it('F1: a Jellyfin URL with a password never reaches the Settings test result', async () => {
        h.fetch.mockRejectedValue(
            new TypeError(
                'Request cannot be constructed from a URL that includes credentials: http://day1102user:p4ss-w0rd@jf.lan:8096/System/Info',
            ),
        );
        const r = await runProviderHealthCheck('jellyfin', {
            JELLYFINURL: 'http://day1102user:p4ss-w0rd@jf.lan:8096',
            JELLYFINAPIKEY: 'typed-key',
        });
        expect(r.healthy).toBe(false);
        expect(r.error).toBe(
            'Remove the user name and password from the address; Jellyfin connects with the API key only.',
        );
        expect(JSON.stringify(r)).not.toMatch(/p4ss|day1102user/);
    });

    it.each([
        ['sonarr', 'SONARRURL', 'SONARRAPIKEY'],
        ['radarr', 'RADARRURL', 'RADARRAPIKEY'],
        ['jellyseerr', 'SEERRURL', 'SEERRAPIKEY'],
        ['kavita', 'KAVITAURL', 'KAVITAAPIKEY'],
        ['audiobookshelf', 'AUDIOURL', 'AUDIOAPIKEY'],
    ])(
        'F1: %s never echoes a URL with userinfo or a key in its query',
        async (provider, urlKey, keyKey) => {
            const leaked = 'http://u:p4ss-w0rd@host:8000/base?api_key=QSECRET';
            h.fetch.mockRejectedValue(new TypeError(`Failed to parse URL from ${leaked}`));
            const r = await runProviderHealthCheck(provider, {
                [urlKey]: leaked,
                [keyKey]: 'typed-key',
            });
            expect(r.healthy).toBe(false);
            expect(JSON.stringify(r)).not.toMatch(/p4ss|QSECRET|api_key/);
        },
    );

    it('F1: a TMDB error that quotes the request URL does not show the key', async () => {
        h.config.TMDB_API_KEY = 'tmdb-k';
        h.tmdb.getMovieGenres.mockRejectedValue(
            new Error(
                'fetch failed for https://api.themoviedb.org/3/genre/movie/list?api_key=TMDBSECRET123',
            ),
        );
        const r = await runProviderHealthCheck('tmdb');
        expect(r.healthy).toBe(false);
        expect(JSON.stringify(r)).not.toContain('TMDBSECRET123');
    });

    it.each([
        ['ENOTFOUND', 'http://jf:8096', 'host name not found'],
        ['ECONNREFUSED', 'http://jf:8096', 'connection refused'],
        ['UND_ERR_CONNECT_TIMEOUT', 'http://jf:8096', 'timed out'],
        ['ECONNRESET', 'http://jf:8096', 'connection was reset'],
        ['ERR_SSL_WRONG_VERSION_NUMBER', 'https://jf:8096', 'HTTPS protocol mismatch'],
        ['DEPTH_ZERO_SELF_SIGNED_CERT', 'https://jf:8096', 'TLS certificate error'],
    ])(
        'F2: a Settings Jellyfin test explains %s in words, not "fetch failed" (%s)',
        async (code, url, cause) => {
            h.fetch.mockRejectedValue(fetchFailed(code));
            const r = await runProviderHealthCheck('jellyfin', {
                JELLYFINURL: url,
                JELLYFINAPIKEY: 'k',
            });
            expect(r.healthy).toBe(false);
            expect(r.error).toContain(cause);
            expect(r.error).not.toMatch(/fetch failed/i);
        },
    );

    it('F2: EPROTO with "wrong version number" is the HTTPS mismatch, with the try-http hint', async () => {
        h.fetch.mockRejectedValue(
            new TypeError('fetch failed', {
                cause: Object.assign(new Error('wrong version number'), { code: 'EPROTO' }),
            }),
        );
        const r = await runProviderHealthCheck('jellyfin', {
            JELLYFINURL: 'https://jf:8096',
            JELLYFINAPIKEY: 'k',
        });
        expect(r.error).toContain('HTTPS protocol mismatch');
        expect(r.error).toContain('try http://');
    });

    it('F2: the German Settings message is the same German wizard text', async () => {
        localeState.current = 'de';
        h.fetch.mockRejectedValue(fetchFailed('ENOTFOUND'));
        const r = await runProviderHealthCheck('jellyfin', {
            JELLYFINURL: 'http://jf:8096',
            JELLYFINAPIKEY: 'k',
        });
        expect(r.error).toBe(
            'Jellyfin ist unter http://jf:8096 nicht erreichbar (Hostname nicht gefunden). Prüfe die Adresse und ob Jellyfin läuft.',
        );
    });

    it('F4: the "different server" hint is German on a German page', async () => {
        localeState.current = 'de';
        const r = await runProviderHealthCheck('sonarr', { SONARRURL: 'http://other:8989' });
        expect(r.error).toBe('Gib den API-Schlüssel ein, um einen anderen Server zu testen.');
    });

    it('F4: the URL-format hint is German on a German page', async () => {
        localeState.current = 'de';
        const r = await runProviderHealthCheck('sonarr', {
            SONARRURL: 'file:///etc/passwd',
            SONARRAPIKEY: 'k',
        });
        expect(r.error).toBe('Gib eine URL mit http:// oder https:// ein.');
    });
});
