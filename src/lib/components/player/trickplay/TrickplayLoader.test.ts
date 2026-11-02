// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('$app/environment', () => ({ browser: true }));
import { TrickplayLoader } from './TrickplayLoader';

const fetchSpy = vi.fn();
const manifest = {
    fileId: '12345678-1234-4234-8234-123456789abc',
    width: 320,
    height: 180,
    tileColumns: 10,
    tileRows: 10,
    intervalMs: 10_000,
    thumbnailCount: 101,
    sheets: [
        { index: 0, startMs: 0, endMs: 1_000_000, href: '/sheet/zero?grant=opaque&rev=one' },
        { index: 1, startMs: 1_000_000, endMs: 1_010_000, href: '/sheet/one?grant=opaque&rev=two' },
    ],
};
const manifestHref = '/ready/manifest?fileId=selected&grant=opaque';
function makeLoader() {
    const callbacks = {
        onManifestLoad: vi.fn(),
        onImageLoad: vi.fn(),
        onImageFail: vi.fn(),
        onLoadingStateChange: vi.fn(),
    };
    return { loader: new TrickplayLoader(callbacks), callbacks };
}
beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal(
        'URL',
        class extends URL {
            static createObjectURL = vi.fn(() => 'blob:sheet');
            static revokeObjectURL = vi.fn();
        },
    );
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
function respondWithManifest() {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => manifest });
    fetchSpy.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['sheet']) });
}

describe('TrickplayLoader JSON manifest', () => {
    it('fetches the supplied manifest href, parses JSON, and fetches the first sheet href', async () => {
        const { loader } = makeLoader();
        loader.updateSession('item', manifest.fileId, manifestHref);
        respondWithManifest();
        await loader.prefetchFirstTile();
        expect(fetchSpy.mock.calls.map((call) => call[0])).toEqual([
            manifestHref,
            manifest.sheets[0].href,
        ]);
        expect(loader.getCachedUrl(0)).toBe('blob:sheet');
        expect(loader.getSpriteIndexForTime(1000)).toBe(1);
        loader.destroy();
    });

    it('uses subsequent sheet hrefs without fetching the manifest again', async () => {
        const { loader, callbacks } = makeLoader();
        loader.updateSession('item', manifest.fileId, manifestHref);
        respondWithManifest();
        await loader.prefetchFirstTile();
        fetchSpy.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['second']) });
        loader.requestSheet(1);
        await vi.waitFor(() => expect(callbacks.onImageLoad).toHaveBeenCalledWith(1, 'blob:sheet'));
        expect(fetchSpy.mock.calls.map((call) => call[0])).toEqual([
            manifestHref,
            manifest.sheets[0].href,
            manifest.sheets[1].href,
        ]);
        loader.destroy();
    });

    it('preserves cached sheets and rotates later sheet hrefs on grant renewal', async () => {
        const { loader, callbacks } = makeLoader();
        loader.updateSession('item', manifest.fileId, manifestHref);
        respondWithManifest();
        await loader.prefetchFirstTile();
        loader.updateSession('item', manifest.fileId, manifestHref.replace('opaque', 'renewed'));
        expect(loader.getCachedUrl(0)).toBe('blob:sheet');
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        fetchSpy.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['second']) });
        loader.requestSheet(1);
        await vi.waitFor(() => expect(callbacks.onImageLoad).toHaveBeenCalledWith(1, 'blob:sheet'));
        expect(fetchSpy.mock.calls.map((call) => call[0])).toEqual([
            manifestHref,
            manifest.sheets[0].href,
            manifest.sheets[1].href.replace('opaque', 'renewed'),
        ]);
        expect(callbacks.onManifestLoad).toHaveBeenCalledTimes(1);
        loader.destroy();
    });

    it('does not fetch without a manifest href', async () => {
        const { loader } = makeLoader();
        loader.updateSession('item', null, null);
        await loader.prefetchFirstTile();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does not fetch without an item', async () => {
        const { loader } = makeLoader();
        loader.updateSession(null, null, manifestHref);
        await loader.prefetchFirstTile();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('resets cached sheets when the selected file or manifest changes', async () => {
        const { loader } = makeLoader();
        loader.updateSession('item', manifest.fileId, manifestHref);
        respondWithManifest();
        await loader.prefetchFirstTile();
        loader.updateSession('item', 'other-file', '/other/manifest');
        expect(loader.isSheetCached(0)).toBe(false);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:sheet');
        respondWithManifest();
        await loader.prefetchFirstTile();
        expect(fetchSpy.mock.calls[2][0]).toBe('/other/manifest');
        loader.destroy();
    });

    it('rejects a malformed manifest before requesting sheet images', async () => {
        const { loader } = makeLoader();
        loader.updateSession('item', manifest.fileId, manifestHref);
        fetchSpy.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ ...manifest, intervalMs: 0 }),
        });
        await loader.prefetchFirstTile();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(loader.isSheetCached(0)).toBe(false);
    });

    it('discards a manifest response from a previous session', async () => {
        const { loader } = makeLoader();
        loader.updateSession('item', manifest.fileId, manifestHref);
        let resolve!: (value: unknown) => void;
        fetchSpy.mockReturnValueOnce(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const pending = loader.prefetchFirstTile();
        loader.updateSession('other-item', null, '/other/manifest');
        resolve({ ok: true, json: async () => manifest });
        await pending;
        expect(loader.isSheetCached(0)).toBe(false);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});

it.each(['http', 'network', 'invalid'])(
    'negative-caches a %s manifest failure for 30 seconds',
    async (failure) => {
        vi.useFakeTimers();
        try {
            const { loader } = makeLoader();
            loader.updateSession('item', manifest.fileId, manifestHref);
            if (failure === 'network') fetchSpy.mockRejectedValueOnce(new Error('offline'));
            else
                fetchSpy.mockResolvedValueOnce({
                    ok: failure === 'invalid',
                    json: async () => ({ invalid: true }),
                });
            await loader.prefetchFirstTile();
            await loader.prefetchFirstTile();
            await vi.advanceTimersByTimeAsync(29_999);
            await loader.prefetchFirstTile();
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            respondWithManifest();
            await loader.prefetchFirstTile();
            expect(fetchSpy).toHaveBeenCalledTimes(3);
            expect(loader.getCachedUrl(0)).toBe('blob:sheet');
            loader.destroy();
        } finally {
            vi.useRealTimers();
        }
    },
);

it('does not carry a failed manifest cooldown to a new file', async () => {
    const { loader } = makeLoader();
    loader.updateSession('item', manifest.fileId, manifestHref);
    fetchSpy.mockResolvedValueOnce({ ok: false });
    await loader.prefetchFirstTile();
    loader.updateSession('item', 'next-file', '/next-manifest');
    respondWithManifest();
    await loader.prefetchFirstTile();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    loader.destroy();
});
