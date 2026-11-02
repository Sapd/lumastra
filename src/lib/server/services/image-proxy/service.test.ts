// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveSelectedImageCandidate } from '../image-descriptor/selected.js';
vi.mock('../image-descriptor/selected.js', () => ({
    resolveSelectedImageCandidate: vi.fn().mockResolvedValue(null),
}));

vi.mock('$lib/server/database/queries/image-candidates.queries.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/image-candidates.queries.js')
    >()),
    getSuppressedImageProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/database/queries/media-artwork.queries.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/media-artwork.queries.js')
    >()),
    getLegacyLocalArtwork: vi.fn().mockResolvedValue(null),
}));

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ImageProxyService } from './service';
import {
    getImageMetadata,
    type ImageMetadataRow,
} from '$lib/server/database/queries/catalog-operations.queries';
vi.mock('$lib/server/database/queries/catalog-operations.queries', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/catalog-operations.queries')
    >()),
    getImageMetadata: vi.fn(),
}));

describe('ImageProxyService TMDB fallback', () => {
    function makeService() {
        const service = new ImageProxyService({} as never);
        const getImage = vi.fn(async () => ({
            buffer: Buffer.from('image'),
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=86400',
        }));

        (
            service as unknown as {
                tmdbProvider: { getImage: typeof getImage };
            }
        ).tmdbProvider = { getImage };

        return { service, getImage };
    }

    function makeRow(overrides: Partial<ImageMetadataRow> = {}): ImageMetadataRow {
        return {
            poster_path: '/poster.jpg',
            backdrop_path: null,
            logo_path: null,
            still_path: null,
            media_type: 'tv',
            metadata_media_type: 'tv',
            metadata_source_id: '458047d4-ac5f-421e-b2f8-978cb162438c',
            primary_ext_id: 'tt1234567',
            primary_provider: 'imdb',
            tmdb_id: '990001',
            jellyfin_id: null,
            custom_poster_url: null,
            custom_thumb_url: null,
            audiobookshelf_id: null,
            audiobookshelf_revision: null,
            ...overrides,
        };
    }

    it('uses tmdb_id even when TMDB is not the primary external provider', async () => {
        const { service, getImage } = makeService();

        const result = await (
            service as unknown as {
                tryTmdb: (
                    row: ImageMetadataRow,
                    type: 'poster',
                    options: { size: 'thumb' },
                    catalogId?: string,
                ) => Promise<unknown>;
            }
        ).tryTmdb(makeRow(), 'poster', { size: 'thumb' });

        expect(result).not.toBeNull();
        expect(getImage).toHaveBeenCalledWith({
            providerId: '990001',
            type: 'poster',
            mediaType: 'tv',
            options: { size: 'thumb', path: '/poster.jpg' },
        });
    });

    it('returns null when no TMDB id is available', async () => {
        const { service, getImage } = makeService();

        const result = await (
            service as unknown as {
                tryTmdb: (
                    row: ImageMetadataRow,
                    type: 'poster',
                    options: { size: 'thumb' },
                    catalogId?: string,
                ) => Promise<unknown>;
            }
        ).tryTmdb(makeRow({ tmdb_id: null }), 'poster', { size: 'thumb' });

        expect(result).toBeNull();
        expect(getImage).not.toHaveBeenCalled();
    });

    it('resolves season posters with the Lumastra season UUID instead of inherited series paths', async () => {
        const { service, getImage } = makeService();
        const seasonId = '7d3311ef-3831-4c3d-9824-1a8d9161bb59';

        await (
            service as unknown as {
                tryTmdb: (
                    row: ImageMetadataRow,
                    type: 'poster',
                    options: { size: 'thumb' },
                    catalogId?: string,
                ) => Promise<unknown>;
            }
        ).tryTmdb(
            makeRow({
                media_type: 'season',
                metadata_media_type: 'tv',
                metadata_source_id: '458047d4-ac5f-421e-b2f8-978cb162438c',
                poster_path: '/series-poster.jpg',
            }),
            'poster',
            { size: 'thumb' },
            seasonId,
        );

        expect(getImage).toHaveBeenCalledWith({
            providerId: '990001',
            type: 'poster',
            mediaType: 'season',
            options: { size: 'thumb', catalogId: seasonId },
        });
    });

    it('uses the metadata source type for inherited episode logos', async () => {
        const { service, getImage } = makeService();
        const episodeId = '2a49f020-65f2-4abc-92a4-b5b68d15934a';

        await (
            service as unknown as {
                tryTmdb: (
                    row: ImageMetadataRow,
                    type: 'logo',
                    options: { size: 'thumb' },
                    catalogId?: string,
                ) => Promise<unknown>;
            }
        ).tryTmdb(
            makeRow({
                media_type: 'episode',
                metadata_media_type: 'tv',
                metadata_source_id: '458047d4-ac5f-421e-b2f8-978cb162438c',
                poster_path: null,
                logo_path: null,
            }),
            'logo',
            { size: 'thumb' },
            episodeId,
        );

        expect(getImage).toHaveBeenCalledWith({
            providerId: '990001',
            type: 'logo',
            mediaType: 'tv',
            options: { size: 'thumb', catalogId: episodeId },
        });
    });

    it('keeps episode thumb requests in episode context', async () => {
        const { service, getImage } = makeService();
        const episodeId = '2a49f020-65f2-4abc-92a4-b5b68d15934a';

        await (
            service as unknown as {
                tryTmdb: (
                    row: ImageMetadataRow,
                    type: 'thumb',
                    options: { size: 'thumb' },
                    catalogId?: string,
                ) => Promise<unknown>;
            }
        ).tryTmdb(
            makeRow({
                media_type: 'episode',
                metadata_media_type: 'episode',
                metadata_source_id: episodeId,
                poster_path: null,
                tmdb_id: '123456',
            }),
            'thumb',
            { size: 'thumb' },
            episodeId,
        );

        expect(getImage).toHaveBeenCalledWith({
            providerId: '123456',
            type: 'thumb',
            mediaType: 'episode',
            options: { size: 'thumb', catalogId: episodeId },
        });
    });
});

// --- Radio metadata image proxy tests ---
// resolveSafePublicUrl is a mock so unit tests don't make real DNS lookups;
// the real pinnedFetch runs. The H7 block below swaps in the real resolver
// with node:dns mocked, so the whole guard is exercised there.
vi.mock('$lib/server/utils/ssrf-guard', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/ssrf-guard')>()),
    resolveSafePublicUrl: vi.fn(),
}));

const dnsLookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({
    default: { lookup: (...args: unknown[]) => dnsLookupMock(...args) },
}));

// The guarded fetch sites (radio metadata images, custom URLs) go through
// pinnedFetch, i.e. undici's own `fetch` with a pinned Agent or, through the
// LiveTV upstream proxy, the ProxyAgent. `fetch` is the test's transport; the
// Agent is real but records its options so a test can ask where it would dial.
type PinLookup = (
    host: string,
    opts: unknown,
    cb: (err: null, addrs: Array<{ address: string; family: number }>) => void,
) => void;
const undiciFetchRef = vi.hoisted(() => ({ value: vi.fn() }));
const agentOpts = vi.hoisted(() => [] as Array<{ connect: { lookup: PinLookup } }>);
vi.mock('undici', async (importOriginal) => {
    const real = await importOriginal<typeof import('undici')>();
    class RecordingAgent extends real.Agent {
        constructor(opts: ConstructorParameters<typeof real.Agent>[0]) {
            super(opts);
            agentOpts.push(opts as { connect: { lookup: PinLookup } });
        }
    }
    return { ...real, Agent: RecordingAgent, fetch: undiciFetchRef.value };
});

/** Route the guarded fetch sites to `mock`. */
function setTransport(mock: (...args: never[]) => unknown): void {
    undiciFetchRef.value.mockReset();
    undiciFetchRef.value.mockImplementation(mock as (...args: unknown[]) => unknown);
}

/**
 * The address the Nth pinned connection would dial. The pinned lookup answers
 * on a later tick (like dns.lookup), so wait for its callback.
 */
function pinnedAddress(n: number): Promise<string> {
    return new Promise((resolve) => {
        agentOpts[n].connect.lookup('ignored', { all: true }, (_e, addrs) => {
            resolve(addrs[0].address);
        });
    });
}

const upstreamDispatcherRef: { value: unknown } = { value: undefined };
const { mockCanCallJellyfin } = vi.hoisted(() => ({ mockCanCallJellyfin: vi.fn(() => false) }));
vi.mock('$lib/server/jellyfin/runtime-gate.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/jellyfin/runtime-gate.js')>()),
    canCallJellyfin: () => mockCanCallJellyfin(),
}));

vi.mock('../livetv/upstream-proxy.js', () => ({
    getLiveTvUpstreamDispatcher: () => upstreamDispatcherRef.value,
}));

/**
 * Re-establish the default (benign) resolver mock. Needed after
 * `vi.restoreAllMocks()`, which resets `vi.fn()` mocks to a no-op: the
 * resolver's `{ url, resolvedIp }` is consumed by pinnedFetch, so a no-op
 * default would throw on `undefined.url`.
 */
async function installDefaultSsrfMocks(): Promise<void> {
    const { resolveSafePublicUrl } = await import('$lib/server/utils/ssrf-guard');
    vi.mocked(resolveSafePublicUrl).mockReset();
    vi.mocked(resolveSafePublicUrl).mockImplementation(async (url: URL) => ({
        url,
        resolvedIp: '93.184.216.34',
    }));
    agentOpts.length = 0;
}

describe('ImageProxyService.getRadioMetadataImage', () => {
    const stationId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    beforeEach(async () => {
        const { clearRadioCache } = await import('$lib/server/services/radio-metadata');
        await clearRadioCache(stationId);
        vi.restoreAllMocks();
        await installDefaultSsrfMocks();
    });

    it('returns null when no cache record exists', async () => {
        const svc = new ImageProxyService({} as never);
        const res = await svc.getRadioMetadataImage(stationId, 'dj');
        expect(res).toBeNull();
    });

    it('returns null when the record has no image for the role', async () => {
        const svc = new ImageProxyService({} as never);
        const res = await svc.getRadioMetadataImage(stationId, 'show');
        expect(res).toBeNull();
    });

    it('fetches and returns buffer + content-type when URL present', async () => {
        const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache');
        const c = cacheManager.for(CACHE_NAMESPACES.radioNowPlaying);
        await c.set(`station:v2:${stationId}`, {
            stationId,
            fetchedAt: new Date().toISOString(),
            source: 'url',
            track: {},
            show: {},
            dj: {
                imageUrl: `/api/music/radio/${stationId}/image/dj`,
            },
            upNext: {},
            _imageUrls: { dj: 'https://cdn.example.com/dj.png' },
        });
        setTransport(
            vi.fn().mockResolvedValue(
                new Response(new Uint8Array([137, 80, 78, 71]).buffer, {
                    headers: { 'Content-Type': 'image/png' },
                }),
            ),
        );
        const svc = new ImageProxyService({} as never);
        const res = await svc.getRadioMetadataImage(stationId, 'dj');
        expect(res?.contentType).toBe('image/png');
        expect(res?.buffer.byteLength).toBe(4);
    });

    it('rejects non-image content-type', async () => {
        const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache');
        const c = cacheManager.for(CACHE_NAMESPACES.radioNowPlaying);
        await c.set(`station:v2:${stationId}`, {
            stationId,
            fetchedAt: new Date().toISOString(),
            source: 'url',
            track: {},
            show: {},
            dj: {
                imageUrl: `/api/music/radio/${stationId}/image/dj`,
            },
            upNext: {},
            _imageUrls: { dj: 'https://cdn.example.com/not-an-image' },
        });
        setTransport(
            vi.fn().mockResolvedValue(
                new Response('<!doctype html>', {
                    headers: { 'Content-Type': 'text/html' },
                }),
            ),
        );
        const svc = new ImageProxyService({} as never);
        const res = await svc.getRadioMetadataImage(stationId, 'dj');
        expect(res).toBeNull();
    });
});

// --- fetchCustomUrl regression tests ---

describe('ImageProxyService.fetchCustomUrl', () => {
    /** Stub the file-system custom-url cache so tests run the fetcher inline
     *  and never touch disk. The wrapper mirrors getCachedOrFetch's contract. */
    function stubCacheToCallFetcher(svc: ImageProxyService): void {
        const stub = {
            getCachedOrFetch: vi.fn(
                async (
                    _key: string,
                    fetcher: () => Promise<Buffer>,
                ): Promise<{ buffer: Buffer; wasHit: boolean }> => ({
                    buffer: await fetcher(),
                    wasHit: false,
                }),
            ),
            delete: vi.fn(async () => {}),
        };
        (
            svc as unknown as {
                customUrlCache: typeof stub;
            }
        ).customUrlCache = stub;
    }

    /** Inject a buffer directly so we can test the content-type-sniffing
     *  behavior on cache hits without going through the fetcher path. */
    function stubCacheToReturn(svc: ImageProxyService, buffer: Buffer): void {
        const stub = {
            getCachedOrFetch: vi.fn(async () => ({ buffer, wasHit: true })),
            delete: vi.fn(async () => {}),
        };
        (
            svc as unknown as {
                customUrlCache: typeof stub;
            }
        ).customUrlCache = stub;
    }

    beforeEach(async () => {
        // Reset to default benign behavior so each test can override per-call.
        await installDefaultSsrfMocks();
        // Ensure the upstream dispatcher does not leak between tests.
        upstreamDispatcherRef.value = undefined;
    });

    it.each([false, true])(
        'D-M1: private URLs require the channel-row flag (%s)',
        async (channel) => {
            const { config } = await import('$lib/server/config');
            const { resolveSafePublicUrl } = await import('$lib/server/utils/ssrf-guard');
            const flag = vi.spyOn(config, 'LIVETV_ALLOW_PRIVATE_URLS', 'get').mockReturnValue(true);
            try {
                const svc = new ImageProxyService({} as never);
                stubCacheToReturn(svc, Buffer.from('not-an-image'));
                await svc.fetchCustomUrl('http://192.168.1.2/logo', undefined, undefined, channel);
                expect(resolveSafePublicUrl).toHaveBeenCalledWith(expect.any(URL), {
                    allowPrivate: channel,
                });
            } finally {
                flag.mockRestore();
            }
        },
    );
    it.each([
        'internal JSON secret',
        '<html>private admin response</html>',
        '<?xml version="1.0"?><secret>value</secret>',
        'BMfake',
        '\x00\x00\x01\x00fake',
    ])('D-M1: unknown cached bytes are not labeled as images: %s', async (body) => {
        const svc = new ImageProxyService({} as never);
        stubCacheToReturn(svc, Buffer.from(body));
        expect(await svc.fetchCustomUrl('https://cdn.example.com/logo')).toBeNull();
    });
    it('D-M1: rejects a fetched image signature when sharp cannot parse the body', async () => {
        setTransport(
            vi.fn(
                async () =>
                    new Response(Buffer.from([0xff, 0xd8, 0xff, 0, 0]), {
                        headers: { 'content-type': 'image/jpeg' },
                    }),
            ),
        );
        const svc = new ImageProxyService({} as never);
        stubCacheToCallFetcher(svc);
        expect(await svc.fetchCustomUrl('https://cdn.example.com/fake.jpg')).toBeNull();
    });
    it('D-M1: keeps a real LAN channel logo working without an upstream dispatcher', async () => {
        const { config } = await import('$lib/server/config');
        const sharp = (await import('./image-sharp')).default;
        const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
            .png()
            .toBuffer();
        const flag = vi.spyOn(config, 'LIVETV_ALLOW_PRIVATE_URLS', 'get').mockReturnValue(true);
        try {
            const { resolveSafePublicUrl } = await import('$lib/server/utils/ssrf-guard');
            setTransport(
                vi.fn(async () => new Response(png, { headers: { 'content-type': 'text/plain' } })),
            );
            const svc = new ImageProxyService({} as never);
            stubCacheToCallFetcher(svc);
            expect(
                (await svc.fetchCustomUrl('http://192.168.1.2/logo', undefined, undefined, true))
                    ?.contentType,
            ).toBe('image/png');
            expect(resolveSafePublicUrl).toHaveBeenLastCalledWith(expect.any(URL), {
                allowPrivate: true,
            });
        } finally {
            flag.mockRestore();
        }
    });

    it.each(['jpeg', 'png', 'gif', 'webp', 'avif', 'tiff', 'svg'] as const)(
        'D-M1: accepts a decoded %s logo',
        async (format) => {
            const sharp = (await import('./image-sharp')).default;
            const body =
                format === 'svg'
                    ? Buffer.from(
                          '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>',
                      )
                    : await sharp({
                          create: { width: 2, height: 2, channels: 3, background: 'red' },
                      })
                          .toFormat(format)
                          .toBuffer();
            setTransport(vi.fn(async () => new Response(body)));
            const svc = new ImageProxyService({} as never);
            stubCacheToCallFetcher(svc);
            expect(
                (await svc.fetchCustomUrl(`https://cdn.example.com/logo-${format}`))?.contentType,
            ).toBe(format === 'svg' ? 'image/svg+xml' : `image/${format}`);
        },
    );
    it('D-M1: channel and ordinary artwork use distinct persistent cache keys', async () => {
        const svc = new ImageProxyService({} as never);
        stubCacheToReturn(svc, Buffer.from('image'));
        const cache = (
            svc as unknown as { customUrlCache: { getCachedOrFetch: ReturnType<typeof vi.fn> } }
        ).customUrlCache;
        await svc.fetchCustomUrl('https://cdn.example.com/logo', undefined, undefined, true);
        await svc.fetchCustomUrl('https://cdn.example.com/logo', undefined, undefined, false);
        expect(cache.getCachedOrFetch.mock.calls[0][0]).not.toBe(
            cache.getCachedOrFetch.mock.calls[1][0],
        );
    });

    it.each([
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
        '<?xml version="1.0"?>\n<!--' + 'logo comment '.repeat(45) + '-->\n<!DOCTYPE svg>',
        '<!--' + 'logo comment '.repeat(45) + '-->',
    ])('SVG follow-up: accepts doctype/comments before a real SVG root', async (prolog) => {
        const body = Buffer.from(
            prolog +
                '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>',
        );
        setTransport(vi.fn(async () => new Response(body)));
        const svc = new ImageProxyService({} as never);
        stubCacheToCallFetcher(svc);
        expect((await svc.fetchCustomUrl('https://cdn.example.com/prolog.svg'))?.contentType).toBe(
            'image/svg+xml',
        );
    });

    it('refuses redirects targeting private addresses (SSRF protection)', async () => {
        const { resolveSafePublicUrl } = await import('$lib/server/utils/ssrf-guard');
        // Public seed URL passes both the up-front check and the hop-0 pinning
        // resolution; the redirect target trips the guard on hop 1.
        vi.mocked(resolveSafePublicUrl)
            .mockResolvedValueOnce({
                url: new URL('https://cdn.example.com/logo.png'),
                resolvedIp: '93.184.216.34',
            })
            .mockResolvedValueOnce({
                url: new URL('https://cdn.example.com/logo.png'),
                resolvedIp: '93.184.216.34',
            })
            .mockRejectedValueOnce(new Error('private address'));

        const fetchMock = vi.fn().mockResolvedValueOnce(
            new Response(null, {
                status: 302,
                headers: { Location: 'http://127.0.0.1:5432/x.png' },
            }),
        );
        setTransport(fetchMock);

        const svc = new ImageProxyService({} as never);
        stubCacheToCallFetcher(svc);

        const result = await svc.fetchCustomUrl('https://cdn.example.com/logo.png', 'thumb');

        expect(result).toBeNull();
        // The seed URL (up-front check), the seed again (hop-0 pinning), and
        // the redirect target (hop-1 pinning) should all have been resolved.
        expect(vi.mocked(resolveSafePublicUrl)).toHaveBeenCalledTimes(3);
        // Only the first hop is fetched; the redirect target is rejected
        // before any second-hop fetch.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][1]).toMatchObject({
            redirect: 'manual',
        });
    });

    it('rejects up-front when the seed URL itself is a private address', async () => {
        const { resolveSafePublicUrl } = await import('$lib/server/utils/ssrf-guard');
        vi.mocked(resolveSafePublicUrl).mockRejectedValueOnce(new Error('private address'));

        const fetchMock = vi.fn();
        setTransport(fetchMock);

        const svc = new ImageProxyService({} as never);
        stubCacheToCallFetcher(svc);

        const result = await svc.fetchCustomUrl('http://localhost:5432/x.png', 'thumb');

        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('backs off a failing logo URL instead of going upstream on every request', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 502 }));
        setTransport(fetchMock);
        let now = 5_000_000;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            const svc = new ImageProxyService({} as never);
            stubCacheToCallFetcher(svc);
            const url = 'https://iptv.example.com/images/logo/ch1.png';

            expect(await svc.fetchCustomUrl(url, 'thumb')).toBeNull();
            expect(await svc.fetchCustomUrl(url, 'thumb')).toBeNull();
            expect(await svc.fetchCustomUrl(url, 'small')).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // Another URL is not held back by the first one's failure.
            expect(
                await svc.fetchCustomUrl('https://iptv.example.com/ch2.png', 'thumb'),
            ).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(2);

            now += 61 * 60 * 1000;
            expect(await svc.fetchCustomUrl(url, 'thumb')).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(3);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it.each([403, 404, 429])(
        'negative-caches HTTP %i across variants for one hour',
        async (status) => {
            const { resolveSafePublicUrl } = await import('$lib/server/utils/ssrf-guard');
            const fetchMock = vi.fn(async () => new Response(null, { status }));
            setTransport(fetchMock);
            let now = 5_000_000;
            const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
            try {
                const svc = new ImageProxyService({} as never);
                stubCacheToCallFetcher(svc);
                const url = 'https://iptv.example.com/failing-logo.png';
                expect(await svc.fetchCustomUrl(url, 'thumb')).toBeNull();
                const resolutions = vi.mocked(resolveSafePublicUrl).mock.calls.length;
                now += 59 * 60 * 1000;
                expect(await svc.fetchCustomUrl(url, 'small', 'avif')).toBeNull();
                expect(fetchMock).toHaveBeenCalledTimes(1);
                expect(resolveSafePublicUrl).toHaveBeenCalledTimes(resolutions);
                now += 2 * 60 * 1000;
                expect(await svc.fetchCustomUrl(url, 'thumb')).toBeNull();
                expect(fetchMock).toHaveBeenCalledTimes(2);
            } finally {
                nowSpy.mockRestore();
            }
        },
    );

    it('negative-caches seed DNS failures and logs an upstream failure, then recovers', async () => {
        const { resolveSafePublicUrl } = await import('$lib/server/utils/ssrf-guard');
        const { LoggerInstance } = await import('$lib/server/utils/logger');
        const warn = vi.spyOn(LoggerInstance.prototype, 'warn').mockImplementation(() => {});
        const resolver = vi.mocked(resolveSafePublicUrl);
        resolver.mockRejectedValue(
            Object.assign(new Error('getaddrinfo ENOTFOUND logo.example'), {
                code: 'ENOTFOUND',
            }),
        );
        // A real image: fetchCustomUrl validates the body with sharp before caching.
        const sharp = (await import('./image-sharp')).default;
        const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
            .png()
            .toBuffer();
        const fetchMock = vi.fn(
            async () =>
                new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } }),
        );
        setTransport(fetchMock);
        const nowSpy = vi.spyOn(Date, 'now');
        nowSpy.mockReturnValue(5_000_000);
        try {
            const svc = new ImageProxyService({} as never);
            stubCacheToCallFetcher(svc);
            const url = 'https://logo.example/ch1.png';
            expect(await svc.fetchCustomUrl(url)).toBeNull();
            expect(await svc.fetchCustomUrl(url, 'thumb')).toBeNull();
            expect(resolver).toHaveBeenCalledTimes(1);
            expect(fetchMock).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledExactlyOnceWith('Failed to fetch custom URL image', {
                url,
                error: 'getaddrinfo ENOTFOUND logo.example',
            });
            nowSpy.mockReturnValue(5_000_000 + 61 * 60 * 1000);
            resolver.mockImplementation(async (url: URL) => ({ url, resolvedIp: '93.184.216.34' }));
            expect(await svc.fetchCustomUrl(url)).not.toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
            nowSpy.mockRestore();
            warn.mockRestore();
        }
    });

    /** A real ImageCache in a temp dir; each key starts out with one expired entry. */
    async function useExpiredDiskCache(svc: ImageProxyService): Promise<string> {
        const { ImageCache } = await import('./cache');
        const { promises: fs } = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-url-stale-'));
        const internals = svc as unknown as { customUrlCache: InstanceType<typeof ImageCache> };
        const original = internals.customUrlCache as unknown as {
            config: ConstructorParameters<typeof ImageCache>[0];
        };
        const cache = new ImageCache({ ...original.config, directory: dir, ttl: 60_000 });
        const expired = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
        const realGet = cache.getCachedOrFetch.bind(cache);
        const seeded = new Set<string>();
        cache.getCachedOrFetch = async (key, fn) => {
            if (!seeded.has(key)) {
                seeded.add(key);
                const file = path.join(dir, key);
                await fs.writeFile(file, expired);
                const old = new Date(Date.now() - 120_000);
                await fs.utimes(file, old, old);
            }
            return realGet(key, fn);
        };
        internals.customUrlCache = cache;
        return dir;
    }

    it('serves the expired copy on a 403 and still backs off the URL', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 403 }));
        setTransport(fetchMock);
        const svc = new ImageProxyService({} as never);
        const dir = await useExpiredDiskCache(svc);
        try {
            const url = 'https://cdn-images.dzcdn.net/images/artist/abc/1000x1000.jpg';
            const first = await svc.fetchCustomUrl(url, 'thumb');
            expect(first?.cacheStatus).toBe('STALE');
            expect(first?.cacheControl).toBe('public, max-age=600');
            const second = await svc.fetchCustomUrl(url, 'thumb');
            expect(second?.cacheStatus).toBe('STALE');
            // The second request was answered from the backoff, not upstream.
            expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
            const { promises: fs } = await import('node:fs');
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it('does not stand an expired copy in for a logo the upstream reports gone', async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
        setTransport(fetchMock);
        const svc = new ImageProxyService({} as never);
        const dir = await useExpiredDiskCache(svc);
        try {
            const url = 'https://iptv.example.com/removed.png';
            expect(await svc.fetchCustomUrl(url, 'thumb')).toBeNull();
            expect(await svc.fetchCustomUrl(url, 'thumb')).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
            // The expired copy is deleted, so no other pod or restart can serve it.
            const { promises: fs } = await import('node:fs');
            expect(await fs.readdir(dir)).toEqual([]);
        } finally {
            const { promises: fs } = await import('node:fs');
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it('does not serve the expired copy when a redirect hop resolves to a private address', async () => {
        const { resolveSafePublicUrl } = await import('$lib/server/utils/ssrf-guard');
        const blocked = Object.assign(new Error('URL resolves to a private IP address'), {
            name: 'PrivateAddressError',
        });
        vi.mocked(resolveSafePublicUrl)
            .mockResolvedValueOnce({
                url: new URL('https://cdn.example.com/logo.png'),
                resolvedIp: '93.184.216.34',
            })
            .mockResolvedValueOnce({
                url: new URL('https://cdn.example.com/logo.png'),
                resolvedIp: '93.184.216.34',
            })
            .mockRejectedValueOnce(blocked);
        setTransport(
            vi.fn(
                async () =>
                    new Response(null, {
                        status: 302,
                        headers: { Location: 'http://10.0.0.5/x.png' },
                    }),
            ),
        );
        const svc = new ImageProxyService({} as never);
        const dir = await useExpiredDiskCache(svc);
        try {
            expect(
                await svc.fetchCustomUrl('https://cdn.example.com/logo.png', 'thumb'),
            ).toBeNull();
            const { promises: fs } = await import('node:fs');
            expect(await fs.readdir(dir)).toEqual([]);
        } finally {
            const { promises: fs } = await import('node:fs');
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it('keeps serving the expired copy through a transient DNS failure', async () => {
        const { resolveSafePublicUrl } = await import('$lib/server/utils/ssrf-guard');
        vi.mocked(resolveSafePublicUrl)
            .mockResolvedValueOnce({
                url: new URL('https://cdn.example.com/logo.png'),
                resolvedIp: '93.184.216.34',
            })
            .mockRejectedValueOnce(new Error('getaddrinfo EAI_AGAIN cdn.example.com'));
        const fetchMock = vi.fn();
        setTransport(fetchMock);
        const svc = new ImageProxyService({} as never);
        const dir = await useExpiredDiskCache(svc);
        try {
            const result = await svc.fetchCustomUrl('https://cdn.example.com/logo.png', 'thumb');
            expect(result?.cacheStatus).toBe('STALE');
            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            const { promises: fs } = await import('node:fs');
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it('stops downloading a logo body once the byte cap is passed', async () => {
        let pulled = 0;
        const chunk = new Uint8Array(256 * 1024).fill(0x61);
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += chunk.byteLength;
                if (pulled > 400 * 1024 * 1024) controller.close();
                else controller.enqueue(chunk);
            },
        });
        setTransport(
            vi.fn(async () => new Response(stream, { headers: { 'content-type': 'image/png' } })),
        );

        const svc = new ImageProxyService({} as never);
        stubCacheToCallFetcher(svc);

        expect(await svc.fetchCustomUrl('https://iptv.example.com/huge.png', 'thumb')).toBeNull();
        expect(pulled).toBeLessThan(32 * 1024 * 1024);
    });

    it('does not drain a redirect hop body', async () => {
        let pulled = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 1;
                controller.enqueue(new Uint8Array(256 * 1024));
                if (pulled > 2000) controller.close();
            },
        });
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(stream, {
                    status: 302,
                    headers: { Location: 'https://iptv.example.com/next.png' },
                }),
            )
            .mockResolvedValueOnce(new Response(null, { status: 404 }));
        setTransport(fetchMock);

        const svc = new ImageProxyService({} as never);
        stubCacheToCallFetcher(svc);

        expect(await svc.fetchCustomUrl('https://iptv.example.com/redir.png', 'thumb')).toBeNull();
        expect(pulled).toBeLessThan(100);
    });

    it('rejects non-http(s) protocols (file://, gopher://, etc.)', async () => {
        const fetchMock = vi.fn();
        setTransport(fetchMock);

        const svc = new ImageProxyService({} as never);
        stubCacheToCallFetcher(svc);

        const result = await svc.fetchCustomUrl('file:///etc/passwd', 'thumb');

        expect(result).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns image/jpeg when the cached buffer is JPEG, even for resized presets', async () => {
        // P2 regression: when resizeForPreset's WebP encode failed and fell
        // back to JPEG, the response previously hard-coded image/webp,
        // mislabeling JPEG bytes as WebP and breaking the image in browsers.
        // Now we always sniff magic bytes — verify with a JPEG buffer.
        const jpegHeader = Buffer.from([
            0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
        ]);

        const svc = new ImageProxyService({} as never);
        stubCacheToReturn(svc, jpegHeader);

        const result = await svc.fetchCustomUrl('https://cdn.example.com/logo.png', 'thumb');

        expect(result).not.toBeNull();
        expect(result?.contentType).toBe('image/jpeg');
    });

    it('returns image/webp when the cached buffer is WebP', async () => {
        // RIFF....WEBP signature
        const webpHeader = Buffer.from([
            0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
        ]);

        const svc = new ImageProxyService({} as never);
        stubCacheToReturn(svc, webpHeader);

        const result = await svc.fetchCustomUrl('https://cdn.example.com/logo.png', 'thumb');

        expect(result?.contentType).toBe('image/webp');
    });

    it('returns image/png on pass-through (size=undefined) when bytes are PNG, regardless of URL extension', async () => {
        // Original bug: size=undefined caused contentType to be derived from
        // URL extension (.jpg → image/jpeg), even when bytes were PNG.
        const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

        const svc = new ImageProxyService({} as never);
        stubCacheToReturn(svc, pngHeader);

        const result = await svc.fetchCustomUrl(
            'https://cdn.example.com/logo.jpg', // .jpg URL but PNG bytes
        );

        expect(result?.contentType).toBe('image/png');
    });

    it('returns image/avif when the cached buffer is AVIF (ISOBMFF ftyp box), not image/jpeg', async () => {
        // Root cause (2026-09-25 image-footprint audit): sniffImageContentType()
        // had no branch for the ISOBMFF `ftyp` box AVIF uses, so a genuinely
        // AVIF-encoded buffer fell through every signature check to the
        // default `return 'image/jpeg'`. The bytes served were correct AVIF
        // (confirmed on prod via `file`/magic-byte inspection — 200 OK,
        // x-cache: HIT, real avif payload) but mislabeled with
        // `Content-Type: image/jpeg`, which is what made AVIF negotiation
        // look broken from the outside. Minimal real AVIF ftyp box:
        // 4-byte box size + 'ftyp' + major brand 'avif'.
        const avifHeader = Buffer.from([
            0x00,
            0x00,
            0x00,
            0x1c, // box size
            0x66,
            0x74,
            0x79,
            0x70, // 'ftyp'
            0x61,
            0x76,
            0x69,
            0x66, // major brand 'avif'
        ]);

        const svc = new ImageProxyService({} as never);
        stubCacheToReturn(svc, avifHeader);

        const result = await svc.fetchCustomUrl('https://cdn.example.com/logo.png', 'thumb');

        expect(result?.contentType).toBe('image/avif');
    });

    /**
     * Build a synthetic ISOBMFF `ftyp` box: 4-byte size + 'ftyp' + 4-byte major
     * brand + 4-byte minor version + one 4-byte compatible-brand entry per
     * string in `compatibleBrands`. Mirrors real HEIF/AVIF files, where a
     * generic wrapper brand (`mif1`/`msf1`) carries the actual codec only in
     * the compatible-brands list.
     */
    function buildFtypBox(majorBrand: string, compatibleBrands: string[]): Buffer {
        const size = 16 + compatibleBrands.length * 4;
        const buf = Buffer.alloc(size);
        buf.writeUInt32BE(size, 0);
        buf.write('ftyp', 4, 'ascii');
        buf.write(majorBrand, 8, 'ascii');
        buf.write('\0\0\0\0', 12, 'ascii'); // minor version, unused by the sniffer
        compatibleBrands.forEach((brand, i) => buf.write(brand, 16 + i * 4, 'ascii'));
        return buf;
    }

    it('returns image/avif for a generic mif1 wrapper whose compatible brands include avif', async () => {
        // Fix round 1 (2026-09-25 review): a `mif1`/`msf1` major brand alone
        // doesn't commit to a codec — HEIC uses the identical wrapper. Real
        // AVIF still images commonly advertise 'avif' only in the compatible-
        // brands list while the major brand stays 'mif1'.
        const mif1Avif = buildFtypBox('mif1', ['mif1', 'heic', 'avif']);

        const svc = new ImageProxyService({} as never);
        stubCacheToReturn(svc, mif1Avif);

        const result = await svc.fetchCustomUrl('https://cdn.example.com/logo.png', 'thumb');

        expect(result?.contentType).toBe('image/avif');
    });

    it('does NOT label a mif1 wrapper as avif when its compatible brands are HEIC-only', async () => {
        // Same wrapper as the case above, but the compatible-brands list never
        // mentions avif/avis — this is a real HEIC file, not AVIF, and must
        // fall through to the sniffer's default (image/jpeg), not be
        // mislabeled as image/avif.
        const mif1Heic = buildFtypBox('mif1', ['mif1', 'heic', 'heix']);

        const svc = new ImageProxyService({} as never);
        stubCacheToReturn(svc, mif1Heic);

        const result = await svc.fetchCustomUrl('https://cdn.example.com/logo.png', 'thumb');

        expect(result?.contentType).not.toBe('image/avif');
    });

    it('attaches the upstream dispatcher only when useUpstreamProxy is true', async () => {
        const sentinel = { mark: 'livetv-proxy-agent' };
        const okJpeg = (): Response =>
            new Response(Buffer.from([0xff, 0xd8, 0xff]), {
                status: 200,
                headers: { 'content-type': 'image/jpeg' },
            });
        const fetchMock = vi.fn(async (_url: URL, _init: { dispatcher?: unknown }) => okJpeg());
        setTransport(fetchMock);

        const svc = new ImageProxyService({} as never);
        stubCacheToCallFetcher(svc);

        // Proxied: the proxy is the dispatcher and gets the real hostname (it
        // dials the target itself, so the URL is not rewritten to the IP).
        upstreamDispatcherRef.value = sentinel;
        await svc.fetchCustomUrl('http://cdn.example.com/logo.png', 'thumb', undefined, true);
        const [proxiedUrl, proxiedInit] = fetchMock.mock.calls[0];
        expect(proxiedInit.dispatcher).toBe(sentinel);
        expect(String(proxiedUrl)).toBe('http://cdn.example.com/logo.png');
        expect(agentOpts).toHaveLength(0);

        // Direct: useUpstreamProxy=false never consults the proxy; the request
        // goes through a pinned Agent instead.
        await svc.fetchCustomUrl('https://cdn.example.com/logo2.png', 'thumb', undefined, false);
        const directInit = fetchMock.mock.calls[1][1];
        expect(directInit.dispatcher).not.toBe(sentinel);
        expect(directInit.dispatcher).toBeDefined();
        expect(await pinnedAddress(0)).toBe('93.184.216.34');
    });
});

// --- Cache-key collapse: effective (snapped) size/quality, not raw inputs ---
//
// The handler snaps `?width`/`?quality` onto the bounded preset/tier set BEFORE
// calling the service, so two near-preset widths arrive here as the SAME `size`
// (e.g. both 470px and 490px → 'card') and MUST share one cache entry. A custom
// width arrives as a distinct `customWidth` → its own 'w<N>' key. These tests
// assert the service's cache-key derivation only ever sees the effective values.
describe('ImageProxyService cache-key collapse (fetchCustomUrl)', () => {
    /** Record the cache keys getCachedOrFetch is invoked with. */
    function captureKeys(svc: ImageProxyService): string[] {
        const keys: string[] = [];
        const stub = {
            getCachedOrFetch: vi.fn(
                async (
                    key: string,
                    fetcher: () => Promise<Buffer>,
                ): Promise<{ buffer: Buffer; wasHit: boolean }> => {
                    keys.push(key);
                    return { buffer: await fetcher(), wasHit: false };
                },
            ),
            delete: vi.fn(async () => {}),
        };
        (svc as unknown as { customUrlCache: typeof stub }).customUrlCache = stub;
        return keys;
    }

    beforeEach(async () => {
        await installDefaultSsrfMocks();
        setTransport(
            vi.fn().mockResolvedValue(
                new Response(Buffer.from([0xff, 0xd8, 0xff]), {
                    status: 200,
                    headers: { 'content-type': 'image/jpeg' },
                }),
            ),
        );
    });

    it('two snapped-equal requests (same preset, same quality) reuse one cache key', async () => {
        const svc = new ImageProxyService({} as never);
        const keys = captureKeys(svc);

        // Both 470px and 490px are snapped to 'card' by the handler before this
        // point, so the service receives size='card' for both → identical key.
        await svc.fetchCustomUrl(
            'https://cdn.example.com/a.png',
            'card',
            'webp',
            false,
            undefined,
            85,
        );
        await svc.fetchCustomUrl(
            'https://cdn.example.com/a.png',
            'card',
            'webp',
            false,
            undefined,
            85,
        );

        expect(keys).toHaveLength(2);
        expect(keys[0]).toBe(keys[1]);
    });

    it('a custom width gets a distinct cache key from the preset variant', async () => {
        const svc = new ImageProxyService({} as never);
        const keys = captureKeys(svc);

        // Preset 'card' vs a far custom width 1280 (size sentinel + customWidth).
        await svc.fetchCustomUrl(
            'https://cdn.example.com/a.png',
            'card',
            'webp',
            false,
            undefined,
            85,
        );
        await svc.fetchCustomUrl(
            'https://cdn.example.com/a.png',
            'custom',
            'webp',
            false,
            1280,
            85,
        );

        expect(keys[0]).not.toBe(keys[1]);
    });

    it('different effective quality tiers produce different cache keys', async () => {
        const svc = new ImageProxyService({} as never);
        const keys = captureKeys(svc);

        await svc.fetchCustomUrl(
            'https://cdn.example.com/a.png',
            'card',
            'webp',
            false,
            undefined,
            85,
        );
        await svc.fetchCustomUrl(
            'https://cdn.example.com/a.png',
            'card',
            'webp',
            false,
            undefined,
            70,
        );

        expect(keys[0]).not.toBe(keys[1]);
    });
});

// --- H7: DNS-rebinding SSRF (TOCTOU) protection ---
//
// `assertNotPrivateUrl` alone validated the HOSTNAME, but the subsequent
// `fetch(hostname)` re-resolved DNS independently — a hostile/rebinding DNS
// server could answer the guard's lookup with a public IP and then flip to a
// private one for the fetch's own resolution. `resolveSafePublicUrl` +
// `pinnedFetch` close that window by pinning the connection to the exact IP
// the guard validated, in the transport: the URL keeps its hostname, so Host
// and TLS SNI stay right for name-based virtual hosts. These tests run the
// real resolver with only node:dns and the undici transport mocked.
describe('ImageProxyService — DNS-rebinding SSRF pinning (H7)', () => {
    /** Stub the file-system custom-url cache so tests run the fetcher inline
     *  and never touch disk. */
    function stubCacheToCallFetcher(svc: ImageProxyService): void {
        const stub = {
            getCachedOrFetch: vi.fn(
                async (
                    _key: string,
                    fetcher: () => Promise<Buffer>,
                ): Promise<{ buffer: Buffer; wasHit: boolean }> => ({
                    buffer: await fetcher(),
                    wasHit: false,
                }),
            ),
            delete: vi.fn(async () => {}),
        };
        (svc as unknown as { customUrlCache: typeof stub }).customUrlCache = stub;
    }

    beforeEach(async () => {
        await installDefaultSsrfMocks();
        upstreamDispatcherRef.value = undefined;
        const guard = await import('$lib/server/utils/ssrf-guard');
        const real = await vi.importActual<typeof import('$lib/server/utils/ssrf-guard')>(
            '$lib/server/utils/ssrf-guard',
        );
        guard._resetSsrfDnsCacheForTests();
        real._resetSsrfDnsCacheForTests();
        vi.mocked(guard.resolveSafePublicUrl).mockImplementation(real.resolveSafePublicUrl);
        dnsLookupMock.mockReset();
    });

    it('fetchCustomUrl: pins the connection to the resolved IP, not the raw hostname', async () => {
        const { resolveSafePublicUrl } = await import('$lib/server/utils/ssrf-guard');
        dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                await (
                    await import('./image-sharp')
                )
                    .default({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
                    .jpeg()
                    .toBuffer(),
                {
                    status: 200,
                    headers: { 'content-type': 'image/jpeg' },
                },
            ),
        );
        setTransport(fetchMock);

        const svc = new ImageProxyService({} as never);
        stubCacheToCallFetcher(svc);

        const result = await svc.fetchCustomUrl('http://evil-cdn.example.com/logo.png', 'thumb');

        expect(result).not.toBeNull();
        expect(vi.mocked(resolveSafePublicUrl)).toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
        // The connection dials the vetted IP; a rebinding DNS server is never
        // asked again.
        expect(await pinnedAddress(0)).toBe('93.184.216.34');
        // The URL keeps the hostname, so a name-based vhost sees its own name
        // (a caller-set Host header would be dropped by fetch()).
        expect(String(calledUrl)).toBe('http://evil-cdn.example.com/logo.png');
        expect(new Headers(calledInit.headers).has('host')).toBe(false);
    });

    it('fetchCustomUrl: never connects when any DNS answer is private', async () => {
        dnsLookupMock.mockResolvedValue([
            { address: '8.8.8.8', family: 4 },
            { address: '169.254.169.254', family: 4 },
        ]);
        const fetchMock = vi.fn();
        setTransport(fetchMock);

        const svc = new ImageProxyService({} as never);
        stubCacheToCallFetcher(svc);

        expect(await svc.fetchCustomUrl('http://split.example.com/x.png', 'thumb')).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fetchCustomUrl: refuses the fetch when the pinning resolution reports a private IP (rebinding attempt)', async () => {
        const { resolveSafePublicUrl } = await import('$lib/server/utils/ssrf-guard');

        // First (up-front) resolution looks public; the hop-0 resolution used
        // to pin the actual connection — performed immediately before the
        // fetch — reports that the hostname now resolves to a private
        // address, simulating a DNS answer that flipped between checks.
        vi.mocked(resolveSafePublicUrl)
            .mockResolvedValueOnce({
                url: new URL('http://rebinding.example.com/x.png'),
                resolvedIp: '93.184.216.34',
            })
            .mockRejectedValueOnce(new Error('URL resolves to a private IP address'));

        const fetchMock = vi.fn();
        setTransport(fetchMock);

        const svc = new ImageProxyService({} as never);
        stubCacheToCallFetcher(svc);

        const result = await svc.fetchCustomUrl('http://rebinding.example.com/x.png', 'thumb');

        expect(result).toBeNull();
        // The connection is never attempted once the pinning resolution
        // refuses the (now-private) address.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('getRadioMetadataImage: pins the connection to the resolved IP, not the raw hostname', async () => {
        dnsLookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);

        const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache');
        const stationId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
        const c = cacheManager.for(CACHE_NAMESPACES.radioNowPlaying);
        await c.set(`station:v2:${stationId}`, {
            stationId,
            fetchedAt: new Date().toISOString(),
            source: 'url',
            track: {},
            show: {},
            dj: { imageUrl: `/api/music/radio/${stationId}/image/dj` },
            upNext: {},
            _imageUrls: { dj: 'http://rebinding-radio.example.com/dj.png' },
        });

        const fetchMock = vi.fn().mockResolvedValue(
            new Response(new Uint8Array([137, 80, 78, 71]).buffer, {
                headers: { 'Content-Type': 'image/png' },
            }),
        );
        setTransport(fetchMock);

        const svc = new ImageProxyService({} as never);
        const res = await svc.getRadioMetadataImage(stationId, 'dj');

        expect(res).not.toBeNull();
        expect(await pinnedAddress(0)).toBe('8.8.8.8');
        const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
        expect(String(calledUrl)).toBe('http://rebinding-radio.example.com/dj.png');
        expect(new Headers(calledInit.headers).has('host')).toBe(false);
    });
});

/**
 * Audiobook covers resolve OUTSIDE the local/tmdb/jellyfin provider chain.
 *
 * This is the path that makes a book's card render at all: the card emits a
 * srcset at /api/media/{uuid}/images/poster whenever it has an internal UUID,
 * and an ABS book has no provider metadata, no media_files row and no Jellyfin
 * identity — so every provider in the chain misses and the grid would fall back
 * to placeholders while the cover sat one call away.
 */
describe('ImageProxyService audiobook covers', () => {
    function makeAudiobookService(row: ImageMetadataRow | null) {
        vi.mocked(getImageMetadata).mockResolvedValue(row);
        const service = new ImageProxyService({} as never);
        const getCover = vi.fn(
            async (_req: {
                itemId: string;
                revision: number | null;
                contentRevision?: string;
            }) => ({
                buffer: Buffer.from('cover'),
                contentType: 'image/webp',
                cacheControl: 'public, max-age=86400',
                cacheStatus: 'MISS' as const,
            }),
        );
        const tryProvider = vi.fn(async () => null);

        Object.assign(service as unknown as Record<string, unknown>, {
            audiobookshelfProvider: { getCover },
            cachedGetImageMetadata: vi.fn(async () => row),
            tryProvider,
        });

        vi.mocked(resolveSelectedImageCandidate).mockImplementation(async (_sql, _id, type) =>
            row?.media_type === 'audiobook' && (type === 'poster' || type === 'primary')
                ? {
                      id: '11111111-1111-4111-8111-111111111111',
                      media_item_id: '458047d4-ac5f-421e-b2f8-978cb162438c',
                      artwork_type: 'poster',
                      provider: 'audiobookshelf',
                      provider_ref: 'li_abc123',
                      contentRevision: 'canonical-cover-version',
                      absCoverUpdatedAt: row.audiobookshelf_revision,
                      language: '',
                      width: null,
                      height: null,
                      chosen_by: 'auto',
                      fetched_at: '2026-10-24',
                      locked: false,
                      selected: true,
                      sort_order: 0,
                      file_path: null,
                      remote_url: null,
                  }
                : null,
        );
        return { service, getCover, tryProvider };
    }

    function audiobookRow(overrides: Partial<ImageMetadataRow> = {}): ImageMetadataRow {
        return {
            poster_path: null,
            backdrop_path: null,
            logo_path: null,
            still_path: null,
            media_type: 'audiobook',
            metadata_media_type: 'audiobook',
            metadata_source_id: '458047d4-ac5f-421e-b2f8-978cb162438c',
            primary_ext_id: 'li_abc123',
            primary_provider: 'audiobookshelf',
            tmdb_id: null,
            jellyfin_id: null,
            custom_poster_url: null,
            custom_thumb_url: null,
            audiobookshelf_id: 'li_abc123',
            audiobookshelf_revision: '1700000000000',
            ...overrides,
        };
    }

    const call = (service: ImageProxyService, type: string) =>
        (
            service as unknown as {
                _getImageByCatalogIdImpl: (
                    uuid: string,
                    type: string,
                    options: Record<string, unknown>,
                ) => Promise<unknown>;
            }
        )._getImageByCatalogIdImpl('458047d4-ac5f-421e-b2f8-978cb162438c', type, {
            size: 'card',
        });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('uses elected ABS content identity rather than the requested v/tag as its persistent namespace', async () => {
        const { service, getCover } = makeAudiobookService(audiobookRow());
        await service.getImageByCatalogId('458047d4-ac5f-421e-b2f8-978cb162438c', 'poster', {
            revision: 'untrusted-url-tag',
        });
        expect(getCover).toHaveBeenCalledWith(
            expect.objectContaining({ contentRevision: 'canonical-cover-version' }),
        );
        expect(getCover.mock.calls[0][0].contentRevision).not.toBe('untrusted-url-tag');
    });

    it('fetches the cover by ABS item id, keyed on the stored revision', async () => {
        const { service, getCover, tryProvider } = makeAudiobookService(audiobookRow());

        const result = await call(service, 'poster');

        expect(result).not.toBeNull();
        expect(getCover).toHaveBeenCalledWith({
            itemId: 'li_abc123',
            revision: 1700000000000,
            contentRevision: 'canonical-cover-version',
            options: { size: 'card' },
        });
        // The generic chain must not also run — it can only miss here, and each
        // miss is a provider round trip per card.
        expect(tryProvider).not.toHaveBeenCalled();
    });

    it('uses the current ABS revision even when the metadata cache still holds the previous version', async () => {
        const { service, getCover } = makeAudiobookService(audiobookRow());
        vi.mocked(getImageMetadata).mockResolvedValue(
            audiobookRow({ audiobookshelf_revision: '1700000000001' }),
        );
        await call(service, 'poster');
        expect(getCover).toHaveBeenCalledWith(expect.objectContaining({ revision: 1700000000001 }));
    });

    it('degrades to a TTL-only cache key when the revision is unreadable', async () => {
        const { service, getCover } = makeAudiobookService(
            audiobookRow({ audiobookshelf_revision: 'not-a-number' }),
        );

        await call(service, 'poster');

        expect(getCover).toHaveBeenCalledWith(expect.objectContaining({ revision: null }));
    });

    it('serves no backdrop for a book rather than stretching its cover', async () => {
        const { service, getCover } = makeAudiobookService(audiobookRow());

        await expect(call(service, 'backdrop')).resolves.toBeNull();
        expect(getCover).not.toHaveBeenCalled();
    });

    it('tries the legacy chain when the catalog item has no selected candidate', async () => {
        const { service, getCover, tryProvider } = makeAudiobookService(
            audiobookRow({ media_type: 'movie', audiobookshelf_id: null }),
        );

        await call(service, 'poster');

        expect(getCover).not.toHaveBeenCalled();
        expect(tryProvider).toHaveBeenCalled();
    });
});

describe('ImageProxyService unknown 32-hex ids (Jellyfin-shaped)', () => {
    const JF_SHAPED = 'abcdef0123456789abcdef0123456789';

    function makeService() {
        const sqlCalls: unknown[] = [];
        const sql = vi.fn(async (...args: unknown[]) => {
            sqlCalls.push(args);
            return [];
        });
        const service = new ImageProxyService(sql as never);
        const getJellyfinImage = vi.fn(async () => null);
        Object.assign(service as unknown as Record<string, unknown>, {
            cachedGetImageMetadata: vi.fn(async () => null),
            tryProvider: vi.fn(async () => null),
            getJellyfinImage,
        });
        return { service, sql, getJellyfinImage };
    }

    const call = (service: ImageProxyService, options: Record<string, unknown> = {}) =>
        (
            service as unknown as {
                _getImageByCatalogIdImpl: (
                    uuid: string,
                    type: string,
                    options: Record<string, unknown>,
                ) => Promise<unknown>;
            }
        )._getImageByCatalogIdImpl(JF_SHAPED, 'poster', options);

    beforeEach(() => {
        mockCanCallJellyfin.mockReset();
    });

    it('without Jellyfin: only the external_ids mapping (DB), never a Jellyfin request', async () => {
        mockCanCallJellyfin.mockReturnValue(false);
        const { service, sql, getJellyfinImage } = makeService();

        await expect(call(service)).resolves.toBeNull();

        expect(sql).toHaveBeenCalledTimes(1);
        expect(getJellyfinImage).not.toHaveBeenCalled();
    });

    it('with Jellyfin usable: an unmapped id is not fetched from Jellyfin by default', async () => {
        mockCanCallJellyfin.mockReturnValue(true);
        const { service, sql, getJellyfinImage } = makeService();

        await expect(call(service)).resolves.toBeNull();

        expect(sql).toHaveBeenCalled();
        expect(getJellyfinImage).not.toHaveBeenCalled();
    });

    it('a concurrent default call never joins an opted-in fetch (dedupe key)', async () => {
        mockCanCallJellyfin.mockReturnValue(true);
        const { service, getJellyfinImage } = makeService();
        let release: (v: unknown) => void = () => {};
        getJellyfinImage.mockImplementation(
            () =>
                new Promise<null>((r) => {
                    release = r as (v: unknown) => void;
                }),
        );
        const admin = service.getImageByCatalogId(JF_SHAPED, 'poster', {
            allowUnmappedJellyfinFetch: true,
        });
        const plain = service.getImageByCatalogId(JF_SHAPED, 'poster', {});
        await expect(plain).resolves.toBeNull();
        release({ buffer: Buffer.from('jf') });
        await expect(admin).resolves.toMatchObject({ buffer: Buffer.from('jf') });
        expect(getJellyfinImage).toHaveBeenCalledTimes(1);
    });

    it('a jellyfin: composite key reaches Jellyfin only with the admin opt-in', async () => {
        const { service, getJellyfinImage } = makeService();
        await expect(
            service.getImageByCompositeKey(`jellyfin:${JF_SHAPED}:movie`, 'poster', {}),
        ).resolves.toBeNull();
        expect(getJellyfinImage).not.toHaveBeenCalled();
        await service.getImageByCompositeKey(`jellyfin:${JF_SHAPED}:movie`, 'poster', {
            allowUnmappedJellyfinFetch: true,
        });
        expect(getJellyfinImage).toHaveBeenCalledTimes(1);
    });

    it('with Jellyfin usable and the admin opt-in: falls back to Jellyfin', async () => {
        mockCanCallJellyfin.mockReturnValue(true);
        const { service, sql, getJellyfinImage } = makeService();
        const options = { allowUnmappedJellyfinFetch: true };

        await call(service, options);

        expect(sql).toHaveBeenCalled();
        expect(getJellyfinImage).toHaveBeenCalledWith(JF_SHAPED, 'poster', options);
    });
});
