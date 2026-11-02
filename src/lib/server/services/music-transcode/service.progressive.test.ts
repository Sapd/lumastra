// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MusicTranscodeCache } from './cache.js';
import type { TranscodeStreamRequest } from './types.js';

vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: () => null,
    subscribeToChannel: vi.fn(async () => null),
}));
vi.mock('./source-guard.js', () => ({ assertTranscodeSourceIsMedia: vi.fn(async () => {}) }));
import { MusicTranscodeService } from './service.js';
import { PROGRESSIVE_READER_GRACE_MS, type ProgressiveReaders } from './progressive.js';

interface Shared {
    controller: AbortController;
    readers: ProgressiveReaders;
    completion: Promise<void>;
}
interface Internals {
    progressive: Map<string, Shared>;
    cancellers: Map<string, AbortController>;
    acquireBothSlots: () => Promise<() => Promise<void>>;
    buildEncodeArgs: () => Promise<string[]>;
    runFfmpegToCompletion: (args: {
        controller: AbortController;
        onEncodingStopped?: (ok: boolean) => void;
    }) => Promise<void>;
}
const services: MusicTranscodeService[] = [];
const directories: string[] = [];
afterEach(() => {
    for (const service of services.splice(0)) service.cancel('player:reader-grace');
    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function setup(): {
    service: MusicTranscodeService;
    internal: Internals;
    cache: MusicTranscodeCache;
    req: TranscodeStreamRequest;
    encode: MockInstance<Internals['runFfmpegToCompletion']>;
    acquire: MockInstance<Internals['acquireBothSlots']>;
} {
    const cache: MusicTranscodeCache = {
        getCachedFinalPath: vi.fn(async () => null),
        peekInFlight: vi.fn(() => false),
        waitForKey: vi.fn(async () => {}),
        reapToCap: vi.fn(async () => {}),
        beginWrite: vi.fn(async () => ({
            isPrimary: true,
            partialPath: '/unused.partial',
            finalPath: '/unused.mp3',
            promote: async () => {},
            abort: async () => {},
            waitForPrimary: async () => {},
        })),
    };
    const service = new MusicTranscodeService({ sql: {} as never, cache });
    services.push(service);
    const internal = service as unknown as Internals;
    const acquire = vi.spyOn(internal, 'acquireBothSlots').mockResolvedValue(async () => {});
    vi.spyOn(internal, 'buildEncodeArgs').mockResolvedValue([]);
    const encode = vi.spyOn(internal, 'runFfmpegToCompletion').mockImplementation(
        ({ controller }) =>
            new Promise<void>((_, reject) => {
                if (controller.signal.aborted) reject(new Error('encoder aborted'));
                else
                    controller.signal.addEventListener(
                        'abort',
                        () => reject(new Error('encoder aborted')),
                        { once: true },
                    );
            }),
    );
    const req: TranscodeStreamRequest = {
        trackUuid: 'track',
        sourcePath: '/unused.flac',
        sourceMtimeMs: 1,
        durationSeconds: 600,
        codec: 'mp3',
        bitrateKbps: 128,
        timeOffset: 0,
        rangeHeader: 'bytes=0-',
        session: {
            sessionId: 'player:reader-grace',
            userId: 'user' as TranscodeStreamRequest['session']['userId'],
            deviceId: 'test',
            source: 'api',
        },
    };
    return { service, internal, cache, req, encode, acquire };
}

function onlyState(internal: Internals): Shared {
    expect(internal.progressive.size).toBe(1);
    return [...internal.progressive.values()][0];
}

describe('progressive admission and reconnects', () => {
    it('abandons a slow encode after a two-byte probe ends normally', async () => {
        const { service, internal, cache, req, encode } = setup();
        const directory = mkdtempSync(join(tmpdir(), 'music-probe-grace-'));
        directories.push(directory);
        const partialPath = join(directory, 'probe.partial');
        writeFileSync(partialPath, 'ab');
        vi.mocked(cache.beginWrite).mockResolvedValue({
            isPrimary: true,
            partialPath,
            finalPath: join(directory, 'probe.mp3'),
            promote: async () => {},
            abort: async () => {},
            waitForPrimary: async () => {},
        });
        const probe = await service.streamFor({ ...req, rangeHeader: 'bytes=0-1' });
        const state = onlyState(internal);
        await vi.waitFor(() => expect(encode).toHaveBeenCalledOnce());
        vi.useFakeTimers();
        expect(await new Response(probe.body).text()).toBe('ab');
        await vi.waitFor(() => expect(internal.cancellers.size).toBe(1));
        await vi.advanceTimersByTimeAsync(PROGRESSIVE_READER_GRACE_MS);
        expect(state.controller.signal.aborted).toBe(true);
        expect(internal.progressive.size).toBe(0);
        await state.completion.catch(() => {});
    });

    it('pins a follower during cache I/O, then starts grace when that follower leaves', async () => {
        const { service, internal, cache, req, encode, acquire } = setup();
        const first = await service.streamFor(req);
        const state = onlyState(internal);
        await vi.waitFor(() => expect(encode).toHaveBeenCalledOnce());
        let unblock!: (value: string | null) => void;
        vi.mocked(cache.getCachedFinalPath).mockImplementationOnce(
            () =>
                new Promise<string | null>((resolve) => {
                    unblock = resolve;
                }),
        );
        const joining = service.streamFor(req);
        await vi.waitFor(() => expect(unblock).toBeTypeOf('function'));
        vi.useFakeTimers();
        await first.body.cancel();
        await vi.advanceTimersByTimeAsync(PROGRESSIVE_READER_GRACE_MS * 2);
        expect(state.controller.signal.aborted).toBe(false);
        unblock(null);
        const follower = await joining;
        expect(follower.cacheState).toBe('dedup');
        expect(acquire).toHaveBeenCalledOnce();
        await follower.body.cancel();
        await vi.advanceTimersByTimeAsync(PROGRESSIVE_READER_GRACE_MS);
        expect(state.controller.signal.aborted).toBe(true);
        expect(internal.progressive.size).toBe(0);
        await state.completion.catch(() => {});
    });

    it('retains a zero-reader encode through an AVPlayer cancel/reopen gap', async () => {
        const { service, internal, req, encode } = setup();
        const first = await service.streamFor(req);
        const state = onlyState(internal);
        await vi.waitFor(() => expect(encode).toHaveBeenCalledOnce());
        vi.useFakeTimers();
        await first.body.cancel();
        await vi.advanceTimersByTimeAsync(PROGRESSIVE_READER_GRACE_MS - 1);
        const reopened = await service.streamFor({ ...req, rangeHeader: 'bytes=1000-' });
        await vi.advanceTimersByTimeAsync(PROGRESSIVE_READER_GRACE_MS * 2);
        expect(state.controller.signal.aborted).toBe(false);
        expect(encode).toHaveBeenCalledOnce();
        await reopened.body.cancel();
    });

    it('removes a failed encoder while its asynchronous cleanup is still pending', async () => {
        const { service, internal, req, encode } = setup();
        let stopped!: (ok: boolean) => void;
        let cleanup!: () => void;
        encode.mockImplementation(({ onEncodingStopped }) => {
            stopped = onEncodingStopped!;
            return new Promise<void>((_, reject) => {
                cleanup = () => reject(new Error('encoder failed'));
            });
        });
        const response = await service.streamFor(req);
        const state = onlyState(internal);
        await vi.waitFor(() => expect(stopped).toBeTypeOf('function'));
        stopped(false);
        expect(state.controller.signal.aborted).toBe(true);
        expect(internal.progressive.size).toBe(0);
        cleanup();
        await state.completion.catch(() => {});
        // The body already errored with the encoder failure; cancel() reports it.
        await response.body.cancel().catch(() => {});
    });

    it('returns 503 before headers if the admitted encode aborts during cache I/O', async () => {
        const { service, internal, cache, req } = setup();
        const first = await service.streamFor(req);
        const state = onlyState(internal);
        let unblock!: (value: string | null) => void;
        vi.mocked(cache.getCachedFinalPath).mockImplementationOnce(
            () =>
                new Promise<string | null>((resolve) => {
                    unblock = resolve;
                }),
        );
        const joining = service.streamFor(req);
        const assertion = expect(joining).rejects.toMatchObject({ status: 503 });
        await vi.waitFor(() => expect(unblock).toBeTypeOf('function'));
        state.controller.abort();
        // Removal is synchronous, without waiting for writer/finalize/slot I/O.
        expect(internal.progressive.size).toBe(0);
        unblock(null);
        await assertion;
        await first.body.cancel().catch(() => {});
        await state.completion.catch(() => {});
        const fresh = await service.streamFor(req);
        expect(onlyState(internal)).not.toBe(state);
        expect(fresh.cacheState).toBe('live');
        await fresh.body.cancel();
    });
});
