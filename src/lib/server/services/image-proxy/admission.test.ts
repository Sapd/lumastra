// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import originalSharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from './image-sharp';
import { ImageCache } from './cache';
import { ImageProxyService } from './service';
import { runImageEncode } from './encode';
import { requireImageProviderBudget, runImageProviderBudget, type ImageWork } from './work-budget';

const directories: string[] = [];
const writes: Promise<void>[] = [];
afterEach(async () => {
    await Promise.all(writes.splice(0));
    await Promise.all(
        directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
});

async function makeCache(): Promise<ImageCache> {
    const directory = await mkdtemp(path.join(tmpdir(), 'image-admission-'));
    directories.push(directory);
    const cache = new ImageCache({ directory, ttl: 60_000 });
    const write = cache.write.bind(cache);
    cache.write = (key, buffer): Promise<void> => {
        const pending = write(key, buffer);
        writes.push(pending);
        return pending;
    };
    return cache;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

it('charges the encode miss once, leaves disk hits free, and never charges the provider for local art', async () => {
    const cache = await makeCache();
    const source = await originalSharp({
        create: {
            width: 20,
            height: 20,
            channels: 3,
            background: '#0099ff',
        },
    })
        .png()
        .toBuffer();
    const provider = vi.fn(async () => null);
    const encode = vi.fn<() => Promise<Response | null>>(async () => null);
    const render = async (): Promise<Response> => {
        const result = await cache.getCachedOrFetch(
            'local-cover',
            async () => sharp(source).resize(10, 10).webp().toBuffer(),
            { encode: true },
        );
        // Wait for the disk write, which normally runs in the background.
        await cache.write('local-cover', result.buffer);
        return new Response(null, { headers: { 'X-Cache': result.wasHit ? 'HIT' : 'MISS' } });
    };
    expect((await runImageProviderBudget(provider, render, encode)).headers.get('X-Cache')).toBe(
        'MISS',
    );
    expect(encode).toHaveBeenCalledTimes(1);
    expect(provider).not.toHaveBeenCalled();
    encode.mockClear().mockResolvedValue(new Response(null, { status: 429 }));
    expect((await runImageProviderBudget(provider, render, encode)).headers.get('X-Cache')).toBe(
        'HIT',
    );
    expect(encode).not.toHaveBeenCalled();
});

it('denies an avatar/direct Sharp encode before running libvips and preserves the caller 429', async () => {
    const response = await runImageProviderBudget(
        async () => null,
        async () => {
            try {
                await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } })
                    .resize(5, 5)
                    .webp()
                    .toBuffer();
            } catch {
                // Mirrors avatar/legacy fallbacks that would otherwise swallow an encode refusal.
            }
            return new Response('fallback');
        },
        async () => new Response(null, { status: 429 }),
    );
    expect(response.status).toBe(429);
});

describe.each([
    ['provider', { provider: true, encode: true }],
    ['encode', { encode: true }],
] as const)('%s admission before single-flight', (kind, work: ImageWork) => {
    it('does not let the denied leader poison another user waiting on the same image', async () => {
        const cache = await makeCache();
        const admission = deferred<Response | null>();
        const leaderEntered = deferred<void>();
        const fetchEntered = deferred<void>();
        const fetchRelease = deferred<void>();
        const factory = vi.fn(async () => {
            // Real provider calls retain their deep guards. Pre-admission makes them no-ops.
            if (work.provider) await requireImageProviderBudget();
            fetchEntered.resolve();
            await fetchRelease.promise;
            return Buffer.from('follower cover');
        });
        const render = async (): Promise<Response> => {
            const result = await cache.getCachedOrFetch('same-cover', factory, work);
            return new Response(result.buffer.toString());
        };
        const denyLeader = async (): Promise<Response | null> => {
            leaderEntered.resolve();
            return admission.promise;
        };
        const leader = runImageProviderBudget(
            kind === 'provider' ? denyLeader : async () => null,
            render,
            kind === 'encode' ? denyLeader : async () => null,
        );
        await leaderEntered.promise;
        const follower = runImageProviderBudget(
            async () => null,
            render,
            async () => null,
        );
        await fetchEntered.promise;
        admission.resolve(new Response(null, { status: 429 }));
        expect((await leader).status).toBe(429);
        fetchRelease.resolve();
        const response = await follower;
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('follower cover');
        expect(factory).toHaveBeenCalledTimes(1);
    });
});

it('keeps a shared queued encode alive when its leader disconnects, so the follower gets the image', async () => {
    const cache = await makeCache();
    const release = deferred<void>();
    const blockersStarted = deferred<void>();
    let active = 0;
    const blockers = Array.from({ length: 4 }, () =>
        runImageProviderBudget(
            async () => null,
            async () => {
                await runImageEncode(async () => {
                    if (++active === 4) blockersStarted.resolve();
                    await release.promise;
                });
                return new Response();
            },
            async () => null,
        ),
    );
    await blockersStarted.promise;
    const factoryEntered = deferred<void>();
    const followerAdmitted = deferred<void>();
    const encode = vi.fn(async () => Buffer.from('shared cover'));
    const factory = vi.fn(async () => {
        factoryEntered.resolve();
        return runImageEncode(encode);
    });
    const render = async (): Promise<Response> => {
        const image = await cache.getCachedOrFetch('shared-queued-cover', factory, {
            encode: true,
        });
        return new Response(image.buffer.toString());
    };
    const controller = new AbortController();
    const leader = runImageProviderBudget(
        async () => null,
        render,
        async () => null,
        false,
        controller.signal,
    );
    // Attach a rejection handler before aborting, including on the pre-fix path.
    const leaderResult = Promise.allSettled([leader]);
    let followerResult: Promise<PromiseSettledResult<Response>[]> | undefined;
    try {
        await factoryEntered.promise;
        const follower = runImageProviderBudget(
            async () => null,
            render,
            async () => {
                followerAdmitted.resolve();
                return null;
            },
        );
        followerResult = Promise.allSettled([follower]);
        await followerAdmitted.promise;
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(factory).toHaveBeenCalledTimes(1);
        expect(encode).not.toHaveBeenCalled();
        controller.abort();
        release.resolve();
        const [result] = await followerResult;
        expect(result.status).toBe('fulfilled');
        if (result.status === 'fulfilled') {
            expect(result.value.status).toBe(200);
            expect(await result.value.text()).toBe('shared cover');
        }
        expect(encode).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledTimes(1);
    } finally {
        release.resolve();
        await Promise.all([...blockers, leaderResult, followerResult]);
    }
});

it('caps background encodes at two and releases permits after an encoder error', async () => {
    const release = deferred<void>();
    let active = 0;
    let peak = 0;
    const jobs = Array.from({ length: 12 }, (_, i) =>
        runImageEncode(async () => {
            active++;
            peak = Math.max(peak, active);
            try {
                await release.promise;
                if (i === 0) throw new Error('broken encoder');
            } finally {
                active--;
            }
        }),
    );
    // Drain admission/queue microtasks without advancing wall-clock time.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(active).toBe(2);
    release.resolve();
    const results = await Promise.allSettled(jobs);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(peak).toBe(2);
    expect(active).toBe(0);
    await expect(runImageEncode(async () => 'next')).resolves.toBe('next');
});

it('keeps admission outside the service-level single-flight as well as the disk cache', async () => {
    const service = new ImageProxyService({} as never);
    const admission = deferred<Response | null>();
    const leaderEntered = deferred<void>();
    const getImage = vi.fn(async () => {
        await requireImageProviderBudget();
        return {
            buffer: Buffer.from('own image'),
            contentType: 'image/webp',
            cacheControl: 'public',
        };
    });
    (service as unknown as { tmdbProvider: { getImage: typeof getImage } }).tmdbProvider = {
        getImage,
    };
    const render = async (): Promise<Response> => {
        const result = await service.getTmdbImage('550', 'movie', 'poster');
        return new Response(result?.buffer.toString() ?? 'placeholder');
    };
    const leader = runImageProviderBudget(async () => {
        leaderEntered.resolve();
        return admission.promise;
    }, render);
    await leaderEntered.promise;
    const follower = await runImageProviderBudget(async () => null, render);
    expect(await follower.text()).toBe('own image');
    admission.resolve(new Response(null, { status: 429 }));
    expect((await leader).status).toBe(429);
    expect(getImage).toHaveBeenCalledTimes(2);
});
