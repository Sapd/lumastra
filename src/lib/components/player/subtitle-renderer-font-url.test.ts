// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ASS fallback font must come from akarisub's own bundled asset, not from a
 * bare path in `static/`.
 *
 * Why this is worth a test: the URL decides whether the 146 KB font is cached.
 * Only `/_app/immutable/` gets `cache-control: public,max-age=31536000,immutable`
 * from adapter-node's static handler, is treated as cache-first by the service
 * worker, and can be replayed by `immutable-asset-fallback` after a redeploy. A
 * hardcoded `/default.woff2` gets none of that and is refetched every subtitle
 * session — and it silently keeps a redundant copy of the font in the build.
 *
 * Nothing about that is visible in a typecheck or a build failure, so assert it
 * at the seam that actually carries it: the options object handed to the
 * AkariSub constructor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SubtitleStreamInfo } from '$lib/types/playback';

const BUNDLED_FONT_URL = 'http://localhost/_app/immutable/assets/default.TESTHASH.woff2';

/** Captures the options every construction of the fake AkariSub receives. */
const constructorOptions: Array<Record<string, unknown>> = [];

vi.mock('$app/environment', () => ({ browser: true }));

vi.mock('akarisub', () => {
    class FakeAkariSub extends EventTarget {
        constructor(options: Record<string, unknown>) {
            super();
            constructorOptions.push(options);
            // The real renderer emits `ready` asynchronously; the manager waits
            // on it in a detached task, so emit it to keep that task from
            // sitting on its 5s safety timeout.
            queueMicrotask(() => this.dispatchEvent(new Event('ready')));
        }
        resize(): void {}
        setCurrentTime(): void {}
        destroy(): void {}
    }
    return {
        default: FakeAkariSub,
        getDefaultFontUrl: () => BUNDLED_FONT_URL,
    };
});

const stream: SubtitleStreamInfo = {
    index: 2,
    hrefs: { raw: '/ready/ass?fileId=selected&grant=opaque' },
    codec: 'ass',
    displayTitle: 'English (ASS)',
} as SubtitleStreamInfo;

/**
 * Build a manager wired to a video element that already reports metadata, so
 * `initAssRenderer` runs straight through to constructing the renderer.
 */
async function initAss(config?: { defaultFontUrl?: string }): Promise<void> {
    const { SubtitleRendererManager } = await import('./subtitle-renderer');

    const parent = document.createElement('div');
    const video = document.createElement('video');
    parent.appendChild(video);
    document.body.appendChild(parent);
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(video, 'videoWidth', { value: 1920, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 1080, configurable: true });

    const manager = new SubtitleRendererManager(config ?? {}, () => {});
    manager.setVideoElement(video);
    manager.setContext({
        itemId: 'item-1',
        mediaSourceId: 'source-1',
        subtitleStreams: [stream],
    });

    // `initAssRenderer` is private, but it is the seam: it is where the font URL
    // is resolved and handed to AkariSub. Reaching it through `initRenderer`
    // would add nothing but codec-dispatch coverage.
    await (
        manager as unknown as {
            initAssRenderer(index: number, s: SubtitleStreamInfo): Promise<boolean>;
        }
    ).initAssRenderer(2, stream);
}

describe('SubtitleRendererManager ASS fallback font URL', () => {
    beforeEach(() => {
        constructorOptions.length = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(new TextEncoder().encode('[Script Info]\n'))),
        );
        // Patch the object-URL statics in place. Replacing the whole `URL`
        // global would also replace the constructor, which akarisub's URL
        // resolution and the manager both need.
        URL.createObjectURL = () => 'blob:mock';
        URL.revokeObjectURL = () => {};
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('registers akarisub’s bundled, content-hashed copy as "liberation sans"', async () => {
        await initAss();

        expect(constructorOptions).toHaveLength(1);
        const fonts = constructorOptions[0].availableFonts as Record<string, string>;
        expect(fonts['liberation sans']).toBe(BUNDLED_FONT_URL);
    });

    it('never falls back to the bare /default.woff2 path from static/', async () => {
        await initAss();

        const fonts = constructorOptions[0].availableFonts as Record<string, string>;
        // The regression this guards: a default of '/default.woff2' is served
        // with no max-age and duplicates a file akarisub already ships.
        expect(fonts['liberation sans']).not.toMatch(/^\/default\.woff2$/);
        expect(fonts['liberation sans']).toContain('/_app/immutable/');
    });

    it('still honours an explicit defaultFontUrl override', async () => {
        await initAss({ defaultFontUrl: '/custom/font.woff2' });

        const fonts = constructorOptions[0].availableFonts as Record<string, string>;
        expect(fonts['liberation sans']).toBe('/custom/font.woff2');
    });
});
