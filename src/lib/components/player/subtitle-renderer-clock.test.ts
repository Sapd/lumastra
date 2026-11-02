// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubtitleStreamInfo } from '$lib/types/playback';
import { SubtitleRendererManager, type SubtitleRendererConfig } from './subtitle-renderer';

const callbacks = vi.hoisted(() => ({
    auto: true,
    loaded: undefined as (() => void) | undefined,
    error: undefined as ((error: Error) => void) | undefined,
}));

const assLifecycle = vi.hoisted(() => ({ renderer: undefined as EventTarget | undefined }));
vi.mock('akarisub', () => {
    class AssRenderer extends EventTarget {
        constructor() {
            super();
            assLifecycle.renderer = this;
        }
        resize(): void {}
        destroy(): void {}
    }
    return { default: AssRenderer, getDefaultFontUrl: () => '/bundled/font.woff2' };
});

const constructorOptions = vi.hoisted(
    () => [] as Array<{ format: 'pgs' | 'vobsub'; frameAwareSync?: boolean }>,
);

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('libbitsub', () => {
    class FakePgsRenderer {
        constructor(options: {
            frameAwareSync?: boolean;
            onLoaded: () => void;
            onError: (error: Error) => void;
        }) {
            callbacks.loaded = options.onLoaded;
            callbacks.error = options.onError;
            if (callbacks.auto) queueMicrotask(options.onLoaded);
            constructorOptions.push({ format: 'pgs', frameAwareSync: options.frameAwareSync });
        }
        dispose(): void {}
    }
    class FakeVobSubRenderer {
        constructor(options: {
            frameAwareSync?: boolean;
            onLoaded: () => void;
            onError: (error: Error) => void;
        }) {
            callbacks.loaded = options.onLoaded;
            callbacks.error = options.onError;
            if (callbacks.auto) queueMicrotask(options.onLoaded);
            constructorOptions.push({ format: 'vobsub', frameAwareSync: options.frameAwareSync });
        }
        dispose(): void {}
    }
    return {
        PgsRenderer: FakePgsRenderer,
        VobSubRenderer: FakeVobSubRenderer,
        isWasmInitialized: () => true,
        initWasm: vi.fn(),
    };
});

const managers: SubtitleRendererManager[] = [];
const formats = [
    { format: 'pgs', codec: 'hdmv_pgs_subtitle' },
    { format: 'vobsub', codec: 'dvd_subtitle' },
] as const;

function subtitleResponse(): Response {
    return new Response(new Uint8Array([0x50, 0x47]));
}

function managerFor(codec: string, config: SubtitleRendererConfig = {}): SubtitleRendererManager {
    const parent = document.createElement('div');
    const video = document.createElement('video');
    parent.appendChild(video);
    document.body.appendChild(parent);
    Object.defineProperties(video, {
        readyState: { value: 4 },
        videoWidth: { value: 1920 },
        videoHeight: { value: 1080 },
    });

    const manager = new SubtitleRendererManager(config, () => {});
    managers.push(manager);
    manager.setVideoElement(video);
    manager.setContext({
        itemId: 'item-1',
        mediaSourceId: 'source-1',
        subtitleStreams: [
            {
                index: 4,
                codec,
                displayTitle: 'German',
                hrefs: { raw: '/ready/subtitle?fileId=selected&grant=opaque' },
            } as SubtitleStreamInfo,
        ],
    });
    return manager;
}

beforeEach(() => {
    constructorOptions.length = 0;
    assLifecycle.renderer = undefined;
    callbacks.auto = true;
    callbacks.loaded = undefined;
    callbacks.error = undefined;
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => subtitleResponse()),
    );
});

afterEach(() => {
    for (const manager of managers) {
        manager.disposeAll();
        manager.setVideoElement(null);
    }
    managers.length = 0;
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe.each(formats)('SubtitleRendererManager $format clock selection', ({ format, codec }) => {
    it('aborts an in-flight subtitle fetch when disposed', async () => {
        const manager = managerFor(codec);
        let signal: AbortSignal | null | undefined;
        vi.mocked(fetch).mockImplementationOnce((_url, init) => {
            signal = init?.signal;
            return new Promise<Response>((_resolve, reject) => {
                signal?.addEventListener('abort', () =>
                    reject(new DOMException('Disposed', 'AbortError')),
                );
            });
        });
        const initializing = manager.initRenderer(4);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
        manager.disposeAll();
        expect(signal?.aborted).toBe(true);
        expect(await initializing).toBe(false);
        expect(constructorOptions).toEqual([]);
    });

    it('uses currentTime synchronization for native HLS', async () => {
        const manager = managerFor(codec, { useFrameAwareSync: () => false });

        expect(await manager.initRenderer(4)).toBe(true);
        expect(constructorOptions).toEqual([{ format, frameAwareSync: false }]);
        expect(fetch).toHaveBeenCalledWith(
            '/ready/subtitle?fileId=selected&grant=opaque',
            expect.any(Object),
        );
    });

    it('preserves frame-aware synchronization by default', async () => {
        const manager = managerFor(codec);

        expect(await manager.initRenderer(4)).toBe(true);
        expect(constructorOptions).toEqual([{ format, frameAwareSync: true }]);
    });

    it('reads the current engine again when the renderer is reinitialized', async () => {
        let nativeHls = true;
        const manager = managerFor(codec, { useFrameAwareSync: () => !nativeHls });

        expect(await manager.initRenderer(4)).toBe(true);
        nativeHls = false;
        expect(await manager.initRenderer(4)).toBe(true);
        nativeHls = true;
        expect(await manager.initRenderer(4)).toBe(true);

        expect(constructorOptions).toEqual([
            { format, frameAwareSync: false },
            { format, frameAwareSync: true },
            { format, frameAwareSync: false },
        ]);
    });

    it('selects the clock after the asynchronous subtitle fetch finishes', async () => {
        let nativeHls = false;
        const manager = managerFor(codec, { useFrameAwareSync: () => !nativeHls });
        let resolveFetch: (response: Response) => void = () => {};
        const response = new Promise<Response>((resolve) => {
            resolveFetch = resolve;
        });
        vi.mocked(fetch).mockReturnValueOnce(response);

        const initializing = manager.initRenderer(4);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
        expect(constructorOptions).toEqual([]);
        nativeHls = true;
        resolveFetch(subtitleResponse());

        expect(await initializing).toBe(true);
        expect(constructorOptions).toEqual([{ format, frameAwareSync: false }]);
    });
});

describe.each(formats)('$format actual bitmap readiness', ({ codec }) => {
    it('waits for loaded, handles asynchronous error, and settles cancellation without late revival', async () => {
        callbacks.auto = false;
        const manager = managerFor(codec);
        let settled = false;
        const first = manager.initRenderer(4).then((value) => {
            settled = true;
            return value;
        });
        await vi.waitFor(() => expect(callbacks.loaded).toBeTypeOf('function'));
        expect(settled).toBe(false);
        callbacks.error!(new Error('Decoder failed'));
        expect(await first).toBe(false);
        callbacks.loaded = undefined;
        const next = manager.initRenderer(4);
        await vi.waitFor(() => expect(callbacks.loaded).toBeTypeOf('function'));
        const lateLoaded = callbacks.loaded!;
        manager.disposeAll();
        expect(await next).toBe(false);
        lateLoaded();
        expect(manager.hasActiveSpecialRenderer()).toBe(false);
        const ready = manager.initRenderer(4);
        await vi.waitFor(() => expect(constructorOptions).toHaveLength(3));
        callbacks.loaded!();
        expect(await ready).toBe(true);
    });
});

it.each(formats)(
    '$format reports post-loaded failure once and ignores errors from superseded renderers',
    async ({ codec }) => {
        const onRendererError = vi.fn();
        const manager = managerFor(codec, { onRendererError });
        expect(await manager.initRenderer(4)).toBe(true);
        const oldError = callbacks.error!;
        oldError(new Error('Render failure after load'));
        expect(onRendererError).toHaveBeenCalledExactlyOnceWith(4);
        expect(manager.hasActiveSpecialRenderer()).toBe(false);
        expect(await manager.initRenderer(4)).toBe(true);
        oldError(new Error('Stale renderer error'));
        expect(onRendererError).toHaveBeenCalledTimes(1);
        expect(manager.hasActiveSpecialRenderer()).toBe(true);
    },
);

describe('ASS actual readiness and error lifecycle', () => {
    function assManager(onRendererError = vi.fn()): SubtitleRendererManager {
        vi.stubGlobal('requestAnimationFrame', (callback: (timestamp: number) => void) => {
            queueMicrotask(() => callback(0));
            return 1;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        URL.createObjectURL = () => 'blob:ass-test';
        URL.revokeObjectURL = () => {};
        return managerFor('ass', { onRendererError });
    }
    it('waits for ready, reports a current runtime error, and removes listeners on disposal', async () => {
        const onRendererError = vi.fn();
        const manager = assManager(onRendererError);
        let settled = false;
        const pending = manager.initRenderer(4).then((value) => {
            settled = true;
            return value;
        });
        await vi.waitFor(() => expect(assLifecycle.renderer).toBeDefined());
        const renderer = assLifecycle.renderer!;
        const remove = vi.spyOn(renderer, 'removeEventListener');
        expect(settled).toBe(false);
        renderer.dispatchEvent(new Event('ready'));
        expect(await pending).toBe(true);
        renderer.dispatchEvent(new Event('error'));
        expect(onRendererError).toHaveBeenCalledExactlyOnceWith(4);
        expect(manager.hasActiveSpecialRenderer()).toBe(false);
        expect(remove.mock.calls.map(([name]) => name)).toEqual(
            expect.arrayContaining(['ready', 'error']),
        );
        renderer.dispatchEvent(new Event('error'));
        expect(onRendererError).toHaveBeenCalledTimes(1);
    });
    it.each(['error', 'cancel'])(
        'settles failed initialization on %s and ignores later ready/error events',
        async (event) => {
            const onRendererError = vi.fn();
            const manager = assManager(onRendererError);
            const pending = manager.initRenderer(4);
            await vi.waitFor(() => expect(assLifecycle.renderer).toBeDefined());
            const renderer = assLifecycle.renderer!;
            const remove = vi.spyOn(renderer, 'removeEventListener');
            if (event === 'cancel') manager.disposeAll();
            else renderer.dispatchEvent(new Event('error'));
            expect(await pending).toBe(false);
            renderer.dispatchEvent(new Event('ready'));
            renderer.dispatchEvent(new Event('error'));
            expect(manager.hasActiveSpecialRenderer()).toBe(false);
            expect(onRendererError).not.toHaveBeenCalled();
            expect(remove.mock.calls.map(([name]) => name)).toEqual(
                expect.arrayContaining(['ready', 'error']),
            );
        },
    );
});

it.each(formats)(
    '$format releases settled disposed renderer ownership while preserving pending late-canvas defense',
    async ({ codec }) => {
        const manager = managerFor(codec);
        const owned = (manager as unknown as { knownLibbitsubRenderers: Set<WeakRef<object>> })
            .knownLibbitsubRenderers;
        for (let i = 0; i < 12; i++) {
            expect(await manager.initRenderer(4)).toBe(true);
            manager.disposeAll();
            expect(owned.size).toBe(0);
        }
        callbacks.auto = false;
        callbacks.loaded = undefined;
        const pending = manager.initRenderer(4);
        await vi.waitFor(() => expect(callbacks.loaded).toBeTypeOf('function'));
        manager.disposeAll();
        expect(await pending).toBe(false);
        expect(owned.size).toBe(1);
        const reference = Array.from(owned)[0];
        expect(reference).toBeInstanceOf(WeakRef);
        const disposed = reference.deref()!;
        const canvas = document.createElement('canvas');
        Object.assign(disposed, { canvas });
        document.querySelector('video')!.parentElement!.appendChild(canvas);
        await vi.waitFor(() => expect(canvas.isConnected).toBe(false));
        callbacks.loaded!();
        expect(owned.size).toBe(0);
    },
);
