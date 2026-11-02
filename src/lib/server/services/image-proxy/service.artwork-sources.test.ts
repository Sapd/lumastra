// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Two ways the image proxy used to answer "I have no artwork" when it actually
 * had artwork it was refusing to serve. Both surfaced identically — the
 * placeholder image, returned with HTTP 200 — so neither was visible from
 * outside the process.
 *
 *  1. `fetchCustomUrl` checked `LIVETV_ALLOW_PRIVATE_URLS` up front and then
 *     re-checked WITHOUT it inside the redirect-following loop, so a LAN
 *     channel logo passed the guard the operator had opted into and was
 *     rejected by the one they hadn't seen.
 *  2. `tryLocalArtwork` gated on library roots alone, but the image-sync task
 *     writes downloaded artwork to `<BASE_PATH>/.metadata/<id>/`, which is
 *     deliberately outside every library root.
 *
 * These assert at the seam that broke: whether the fetch is attempted at all,
 * and whether a real file in the metadata store is served. The SSRF guard runs
 * for real here — mocking it would test the mock's opinion of `allowPrivate`.
 */

import { runImageProviderBudget } from './work-budget';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ImageProxyService } from './service';
import { config } from '$lib/server/config';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { resetContainmentRootsCache } from '$lib/server/utils/contained-fs.js';
import { isResolvedPathWithinMediaStore } from '$lib/server/utils/media-path-resolver.js';
import * as safeFs from '$lib/server/utils/safe-fs.js';

const openHook = vi.hoisted(() => ({
    before: null as (() => Promise<void>) | null,
    after: null as (() => Promise<void>) | null,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
            const hook = openHook.before;
            openHook.before = null;
            if (hook) await hook();
            const handle = await actual.open(...args);
            const after = openHook.after;
            openHook.after = null;
            if (after) await after();
            return handle;
        },
    };
});

// The guard pins its connection with a per-request undici Agent and calls
// undici's own `fetch`, not the global one. Keep the real undici for everything
// else, record the pinned lookup, and route the fetch to each test's stubbed
// global so no request ever leaves the process.
type PinLookup = (
    host: string,
    opts: unknown,
    cb: (err: null, addrs: Array<{ address: string; family: number }>) => void,
) => void;
const agentOpts = vi.hoisted(() => [] as Array<{ connect: { lookup: PinLookup } }>);
vi.mock('undici', async (importOriginal) => ({
    ...(await importOriginal<typeof import('undici')>()),
    Agent: class {
        constructor(opts: { connect: { lookup: PinLookup } }) {
            agentOpts.push(opts);
        }
        close(): Promise<void> {
            return Promise.resolve();
        }
        destroy(): Promise<void> {
            return Promise.resolve();
        }
    },
    fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));

/** Smallest thing sharp will still treat as a decodable image. */
async function tinyJpeg(): Promise<Buffer> {
    return sharp({
        create: { width: 8, height: 8, channels: 3, background: '#336699' },
    })
        .jpeg()
        .toBuffer();
}

describe('fetchCustomUrl — LIVETV_ALLOW_PRIVATE_URLS reaches the redirect loop', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    function makeService() {
        const service = new ImageProxyService({} as never);
        // Pass-through cache: the disk cache would make the second test a HIT
        // and never call the factory the guard lives in.
        (
            service as unknown as {
                customUrlCache: {
                    getCachedOrFetch: (k: string, f: () => Promise<Buffer>) => Promise<unknown>;
                };
            }
        ).customUrlCache = {
            getCachedOrFetch: async (_key: string, factory: () => Promise<Buffer>) => ({
                buffer: await factory(),
                wasHit: false,
            }),
        };
        return service;
    }

    beforeEach(async () => {
        // Uint8Array, not Buffer: Buffer is not in the DOM `BodyInit` union.
        const body = new Uint8Array(await tinyJpeg());
        fetchSpy = vi.fn(
            async () =>
                new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
        );
        vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('rejects an uncached provider fetch before upstream work without poisoning backoff', async () => {
        vi.spyOn(config, 'LIVETV_ALLOW_PRIVATE_URLS', 'get').mockReturnValue(true);
        const service = makeService();
        const response = await runImageProviderBudget(
            async () => new Response(null, { status: 429 }),
            async () => {
                await service.fetchCustomUrl(
                    'http://192.168.7.20/logos/budget.png',
                    undefined,
                    undefined,
                    true,
                );
                return new Response('placeholder');
            },
        );
        expect(response.status).toBe(429);
        expect(fetchSpy).not.toHaveBeenCalled();
        const allowed = await runImageProviderBudget(
            async () => null,
            async () => {
                const result = await service.fetchCustomUrl(
                    'http://192.168.7.20/logos/budget.png',
                    undefined,
                    undefined,
                    true,
                );
                return new Response(null, { status: result ? 200 : 404 });
            },
        );
        expect(allowed.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('serves a provider cache hit without charging an exhausted budget', async () => {
        vi.spyOn(config, 'LIVETV_ALLOW_PRIVATE_URLS', 'get').mockReturnValue(true);
        const service = makeService();
        const buffer = await tinyJpeg();
        (
            service as unknown as {
                customUrlCache: {
                    getCachedOrFetch: () => Promise<{ buffer: Buffer; wasHit: boolean }>;
                };
            }
        ).customUrlCache = { getCachedOrFetch: async () => ({ buffer, wasHit: true }) };
        const charge = vi.fn(async () => new Response(null, { status: 429 }));
        const response = await runImageProviderBudget(charge, async () => {
            const result = await service.fetchCustomUrl(
                'http://192.168.7.20/logos/cached.png',
                undefined,
                undefined,
                true,
            );
            expect(result?.cacheStatus).toBe('HIT');
            return new Response(null, { status: result ? 200 : 404 });
        });
        expect(response.status).toBe(200);
        expect(charge).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches a private-address logo when the operator has opted in', async () => {
        vi.spyOn(config, 'LIVETV_ALLOW_PRIVATE_URLS', 'get').mockReturnValue(true);

        const result = await makeService().fetchCustomUrl(
            'http://192.168.7.20/logos/apx.png',
            undefined,
            undefined,
            true,
        );

        // The assertion that matters is that the request was ATTEMPTED: the bug
        // rejected it after the up-front guard had already allowed it.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(result).not.toBeNull();
        // ...and pinned to the LAN address the guard vetted.
        // The pinned lookup answers on a later tick, so wait for its callback.
        const dialed = await new Promise<string>((resolve) => {
            agentOpts.at(-1)!.connect.lookup('ignored', { all: true }, (_e, addrs) => {
                resolve(addrs[0].address);
            });
        });
        expect(dialed).toBe('192.168.7.20');
    });

    it('still refuses a private-address logo by default', async () => {
        vi.spyOn(config, 'LIVETV_ALLOW_PRIVATE_URLS', 'get').mockReturnValue(false);

        const result = await makeService().fetchCustomUrl(
            'http://192.168.7.20/logos/apx.png',
            undefined,
            undefined,
            true,
        );

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(result).toBeNull();
    });

    it('opting in does not disable the guard for a non-image scheme', async () => {
        vi.spyOn(config, 'LIVETV_ALLOW_PRIVATE_URLS', 'get').mockReturnValue(true);

        const result = await makeService().fetchCustomUrl('file:///etc/passwd');

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(result).toBeNull();
    });
});

describe('tryLocalArtwork — artwork in the central metadata store is servable', () => {
    let base: string;

    beforeEach(async () => {
        base = await mkdtemp(path.join(tmpdir(), 'lumastra-artwork-'));
    });

    afterEach(async () => {
        openHook.before = null;
        openHook.after = null;
        vi.restoreAllMocks();
        await rm(base, { recursive: true, force: true });
    });

    async function serveFrom(filePath: string, libraryRoots: string[] = []) {
        await cacheManager.for(CACHE_NAMESPACES.libraryRoots).delete('all');
        resetContainmentRootsCache();
        vi.spyOn(config, 'BASE_PATH', 'get').mockReturnValue(base);
        // Only reached for paths OUTSIDE the metadata store, where containment
        // falls through to the library-root query. Minimal postgres.js shape:
        // callable as a tagged template, plus the `.array` helper that query
        // builds its provider filter with.
        const fakeSql = Object.assign(
            () => Promise.resolve(libraryRoots.map((root) => ({ path: root }))),
            {
                array: () => ({}),
                unsafe: () => Promise.resolve(libraryRoots.map((root) => ({ path: root }))),
            },
        );
        const service = new ImageProxyService(fakeSql as never);
        (
            service as unknown as {
                cachedGetLocalArtwork: (u: string, t: string) => Promise<{ file_path: string }>;
            }
        ).cachedGetLocalArtwork = async () => ({ file_path: filePath });

        (
            service as unknown as {
                localArtworkOutputCache: {
                    getCachedOrFetch: (
                        key: string,
                        factory: () => Promise<Buffer>,
                    ) => Promise<unknown>;
                };
            }
        ).localArtworkOutputCache = {
            getCachedOrFetch: async (_key: string, factory: () => Promise<Buffer>) => ({
                buffer: await factory(),
                wasHit: false,
            }),
        };

        return (
            service as unknown as {
                tryLocalArtwork: (
                    uuid: string,
                    type: string,
                    options: { size: string },
                ) => Promise<unknown>;
            }
        ).tryLocalArtwork('0f2c9d5e-2c1c-4f5b-9a3a-6c1d2e3f4a5b', 'poster', { size: 'thumb' });
    }

    it('serves a local file without charging the provider budget, including a cold transform', async () => {
        const file = path.join(base, '.metadata', 'budget', 'poster.jpg');
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, await tinyJpeg());
        const charge = vi.fn(async () => new Response(null, { status: 429 }));
        const encode = vi.fn(async () => null);
        const response = await runImageProviderBudget(
            charge,
            async () => {
                expect(await serveFrom(file)).not.toBeNull();
                return new Response('local image');
            },
            encode,
        );
        expect(response.status).toBe(200);
        expect(charge).not.toHaveBeenCalled();
        expect(encode).toHaveBeenCalledTimes(1);
    });

    it('serves a poster the image-sync task wrote under <BASE_PATH>/.metadata', async () => {
        const uuid = '0f2c9d5e-2c1c-4f5b-9a3a-6c1d2e3f4a5b';
        const dir = path.join(base, '.metadata', uuid);
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, 'poster.jpg');
        await writeFile(file, await tinyJpeg());

        expect(await serveFrom(file)).not.toBeNull();
    });

    it.each(['.metadata', 'image-sync', 'metadata/music'])(
        'serves ordinary managed artwork under %s',
        async (store) => {
            const file = path.join(base, store, 'cover.jpg');
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, await tinyJpeg());
            expect(await serveFrom(file)).not.toBeNull();
        },
    );

    it('serves ordinary artwork under a configured library root', async () => {
        const root = path.join(base, 'library');
        await mkdir(root);
        const file = path.join(root, 'poster.jpg');
        await writeFile(file, await tinyJpeg());
        expect(await serveFrom(file, [root])).not.toBeNull();
    });

    it('serves artwork when the configured library root itself is a symlink', async () => {
        const realRoot = path.join(base, 'real-library');
        await mkdir(realRoot);
        await writeFile(path.join(realRoot, 'poster.jpg'), await tinyJpeg());
        const root = path.join(base, 'library-alias');
        await symlink(realRoot, root);
        expect(await serveFrom(path.join(root, 'poster.jpg'), [root])).not.toBeNull();
    });

    it('refuses a child directory escape even when the configured root is a symlink', async () => {
        const realRoot = path.join(base, 'real-library');
        const outside = path.join(base, 'outside');
        await mkdir(realRoot);
        await mkdir(outside);
        await writeFile(path.join(outside, 'poster.jpg'), await tinyJpeg());
        await symlink(outside, path.join(realRoot, 'escape'));
        const root = path.join(base, 'library-alias');
        await symlink(realRoot, root);
        expect(await serveFrom(path.join(root, 'escape', 'poster.jpg'), [root])).toBeNull();
    });

    it('serves a final symlink whose target stays inside the managed artwork store', async () => {
        const dir = path.join(base, 'image-sync');
        await mkdir(dir);
        const target = path.join(dir, 'original.jpg');
        await writeFile(target, await tinyJpeg());
        const file = path.join(dir, 'poster.jpg');
        await symlink(target, file);
        expect(await serveFrom(file)).not.toBeNull();
    });

    it('refuses a final symlink to an image outside every artwork store', async () => {
        const target = path.join(base, 'outside.jpg');
        await writeFile(target, await tinyJpeg());
        const file = path.join(base, '.metadata', 'poster.jpg');
        await mkdir(path.dirname(file));
        await symlink(target, file);
        expect(await serveFrom(file)).toBeNull();
    });

    it('refuses a directory symlink to an image outside every artwork store', async () => {
        const outside = path.join(base, 'outside');
        await mkdir(outside);
        await writeFile(path.join(outside, 'poster.jpg'), await tinyJpeg());
        await mkdir(path.join(base, '.metadata'));
        await symlink(outside, path.join(base, '.metadata', 'linked'));
        expect(await serveFrom(path.join(base, '.metadata', 'linked', 'poster.jpg'))).toBeNull();
    });

    it('refuses a final component swapped to a symlink just before descriptor open', async () => {
        const file = path.join(base, '.metadata', 'poster.jpg');
        await mkdir(path.dirname(file));
        await writeFile(file, await tinyJpeg());
        const outside = path.join(base, 'outside.jpg');
        await writeFile(outside, await tinyJpeg());
        openHook.before = async () => {
            await unlink(file);
            await symlink(outside, file);
        };
        expect(await serveFrom(file)).toBeNull();
        expect(openHook.before).toBeNull();
    });

    it.each([false, true])(
        'refuses a parent swapped immediately before open (swap back: %s)',
        async (swapBack) => {
            const parent = path.join(base, '.metadata', 'item');
            const saved = path.join(base, '.metadata', 'saved-item');
            const outside = path.join(base, 'outside');
            await mkdir(parent, { recursive: true });
            await mkdir(outside);
            await writeFile(path.join(parent, 'poster.jpg'), await tinyJpeg());
            await writeFile(path.join(outside, 'poster.jpg'), await tinyJpeg());
            openHook.before = async () => {
                await rename(parent, saved);
                await symlink(outside, parent);
            };
            if (swapBack) {
                openHook.after = async () => {
                    await unlink(parent);
                    await rename(saved, parent);
                };
            }
            expect(await serveFrom(path.join(parent, 'poster.jpg'))).toBeNull();
            expect(openHook.before).toBeNull();
            expect(openHook.after).toBeNull();
        },
    );

    it('caches managed root realpaths and avoids realpath of unrelated library roots', async () => {
        const dir = path.join(base, '.metadata');
        const unrelated = path.join(base, 'nfs-library');
        await mkdir(dir);
        const file = path.join(dir, 'poster.jpg');
        await writeFile(file, await tinyJpeg());
        const realpathSpy = vi.spyOn(safeFs, 'safeRealpath');
        expect(await serveFrom(file, [unrelated])).not.toBeNull();
        expect(await serveFrom(file, [unrelated])).not.toBeNull();
        expect(realpathSpy.mock.calls.filter(([p]) => p === dir)).toHaveLength(1);
        expect(realpathSpy).not.toHaveBeenCalledWith(unrelated);
    });

    it.each(['ttl', 'invalidation'])('refreshes canonical roots after %s', async (refresh) => {
        vi.spyOn(config, 'BASE_PATH', 'get').mockReturnValue(base);
        const first = path.join(base, 'first');
        const second = path.join(base, 'second');
        await mkdir(first);
        await mkdir(second);
        const alias = path.join(base, 'trusted-root');
        await symlink(first, alias);
        const fakeSql = Object.assign(() => Promise.resolve([]), {
            array: () => ({}),
            unsafe: () => Promise.resolve([]),
        });
        const cache = cacheManager.for(CACHE_NAMESPACES.libraryRoots);
        await cache.clear();
        expect(
            await isResolvedPathWithinMediaStore(fakeSql as never, path.join(first, 'poster.jpg'), [
                alias,
            ]),
        ).toBe(true);
        await unlink(alias);
        await symlink(second, alias);
        expect(
            await isResolvedPathWithinMediaStore(
                fakeSql as never,
                path.join(second, 'poster.jpg'),
                [alias],
            ),
        ).toBe(false);
        if (refresh === 'ttl') {
            const now = Date.now();
            vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
        } else {
            await cache.clear();
        }
        expect(
            await isResolvedPathWithinMediaStore(
                fakeSql as never,
                path.join(second, 'poster.jpg'),
                [alias],
            ),
        ).toBe(true);
    });

    it('still blocks a path in neither the metadata store nor a library root', async () => {
        const dir = path.join(base, 'elsewhere');
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, 'poster.jpg');
        await writeFile(file, await tinyJpeg());

        expect(await serveFrom(file)).toBeNull();
    });
});

describe('tryLocalArtwork — an episode frame is reachable on the role clients ask for', () => {
    /**
     * The API advertises `images.still.*` for an episode, and the iOS client
     * requests exactly that — it will NOT fall back to the episode poster,
     * because that resolves up the parent chain to the series poster and gives
     * every episode of a series the same picture.
     *
     * Locally the extracted frame is stored as `thumb` (what the frame extractor
     * and the scanner's `<file>-thumb.jpg` sidecars write). `still` was missing
     * from this layer's allowlist, so the frame served on `thumb` and the
     * placeholder served on `still` — a real 10-episode series looked entirely
     * unillustrated to the app while curl on `thumb` said everything was fine.
     */
    let base: string;
    let served: string[];

    beforeEach(async () => {
        base = await mkdtemp(path.join(tmpdir(), 'lumastra-still-'));
        served = [];
    });

    afterEach(async () => {
        openHook.before = null;
        openHook.after = null;
        vi.restoreAllMocks();
        await rm(base, { recursive: true, force: true });
    });

    async function service(uuid: string) {
        vi.spyOn(config, 'BASE_PATH', 'get').mockReturnValue(base);
        const dir = path.join(base, '.metadata', uuid);
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, 'thumb.jpg');
        await writeFile(file, await tinyJpeg());

        const svc = new ImageProxyService({
            array: () => ({}),
            unsafe: () => Promise.resolve([]),
        } as never);
        (
            svc as unknown as {
                cachedGetLocalArtwork: (
                    u: string,
                    t: string,
                ) => Promise<{ file_path: string } | null>;
            }
        ).cachedGetLocalArtwork = async (_u: string, t: string) => {
            served.push(t);
            // Only a `thumb` row exists — exactly what the extractor leaves behind.
            return t === 'thumb' ? { file_path: file } : null;
        };
        return svc;
    }

    async function fetchRole(uuid: string, role: string, mediaType: string) {
        const svc = await service(uuid);
        return (
            svc as unknown as {
                tryLocalArtwork: (
                    u: string,
                    t: string,
                    o: { size: string },
                    row?: { media_type: string },
                ) => Promise<unknown>;
            }
        ).tryLocalArtwork(uuid, role, { size: 'thumb' }, { media_type: mediaType });
    }

    const EP = '5c1f3f5a-9a1e-4c2b-8f77-2b7a1d9e4c30';

    it('serves the extracted frame for a `still` request on an episode', async () => {
        expect(await fetchRole(EP, 'still', 'episode')).not.toBeNull();
        // The lookup must have gone to the `thumb` row; asking the store for
        // 'still' finds nothing, which is how this broke.
        expect(served).toContain('thumb');
    });

    it('still serves the same frame on `thumb`', async () => {
        expect(await fetchRole(EP, 'thumb', 'episode')).not.toBeNull();
    });

    it('leaves an unrelated role alone', async () => {
        expect(await fetchRole(EP, 'logo', 'episode')).toBeNull();
    });
});
