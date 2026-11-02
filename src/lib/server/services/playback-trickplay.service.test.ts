// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
    local: vi.fn(),
    widths: vi.fn(),
    selection: vi.fn(),
    revision: vi.fn(),
    row: vi.fn(),
    config: { TRICKPLAY_SERVE_LOCAL: true },
}));
vi.mock('$lib/server/config.js', () => ({ config: h.config }));
vi.mock('./trickplay-storage.service.js', () => ({
    getTrickplayManifest: h.local,
    getTrickplayRevision: h.revision,
    getAvailableTrickplayWidths: h.widths,
}));
vi.mock('$lib/server/database/queries/trickplay-params.queries.js', () => ({
    getTrickplayParamsByWidth: h.row,
}));
vi.mock('$lib/server/database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: h.selection,
}));
import {
    buildTrickplayManifest,
    repairLocalTrickplayParams,
} from './playback-trickplay.service.js';

beforeEach(() => {
    vi.resetAllMocks();
    h.config.TRICKPLAY_SERVE_LOCAL = true;
    h.local.mockResolvedValue(null);
    h.row.mockResolvedValue(null);
    h.revision.mockResolvedValue('revision');
});
const local = {
    width: 320,
    height: 180,
    tileWidth: 2,
    tileHeight: 2,
    interval: 1000,
    thumbnailCount: 5,
    sheets: [{ index: 0 }, { index: 1 }],
};
const imported = {
    width: 320,
    height: 180,
    tile_width: 2,
    tile_height: 2,
    interval_ms: 1000,
    thumbnail_count: 5,
    source: 'jellyfin-disk',
    updated_at: new Date('2026-10-17T00:00:00Z'),
};
describe('manifest serving predicate', () => {
    it.each(['internal', 'v1'] as const)(
        'serves local sheets with revisioned %s hrefs',
        async (surface) => {
            h.local.mockResolvedValue(local);
            const result = await buildTrickplayManifest(
                {} as never,
                'item',
                'file',
                320,
                null,
                surface,
            );
            expect(result?.source).toBe('local');
            const href = result!.manifest.sheets[0].href;
            expect(href).toBe(
                `${surface === 'v1' ? '/api/v1' : '/api'}/playback/item/trickplay/320?fileId=file&index=0&rev=revision`,
            );
            expect(h.revision).toHaveBeenCalledTimes(1);
        },
    );
    it('excludes params for unsupported providers, and local rows when local serving is disabled', async () => {
        h.row.mockResolvedValue({ ...imported, source: 'local' });
        expect(await buildTrickplayManifest({} as never, 'item', 'file', 320, null)).toBeNull();
        h.config.TRICKPLAY_SERVE_LOCAL = false;
        h.local.mockResolvedValue(local);
        expect(await buildTrickplayManifest({} as never, 'item', 'file', 320, null)).toBeNull();
        expect(h.local).toHaveBeenCalledTimes(1);
    });
    it('serves imported sheets even when local serving is disabled', async () => {
        h.config.TRICKPLAY_SERVE_LOCAL = false;
        h.row.mockResolvedValue(imported);
        const result = await buildTrickplayManifest(
            {} as never,
            'item',
            'file',
            320,
            null,
            'internal',
        );
        expect(result?.source).toBe('jellyfin-disk');
        expect(result?.manifest.sheets).toHaveLength(2);
        expect(
            new URL(result!.manifest.sheets[0].href, 'https://example.test').searchParams.get(
                'rev',
            ),
        ).toBe(imported.updated_at.toISOString());
        expect(h.local).not.toHaveBeenCalled();
    });
    it('does not issue unrevisioned hrefs when the local manifest disappears during lookup', async () => {
        h.local.mockResolvedValue(local);
        h.revision.mockResolvedValue(null);
        expect(await buildTrickplayManifest({} as never, 'item', 'file', 320, null)).toBeNull();
    });
    it('rejects empty manifests, mismatched widths, and imported rows without thumbnails', async () => {
        for (const manifest of [
            { ...local, sheets: [] },
            { ...local, width: 640 },
        ]) {
            h.local.mockResolvedValue(manifest);
            expect(await buildTrickplayManifest({} as never, 'item', 'file', 320, null)).toBeNull();
        }
        h.row.mockResolvedValue({ ...imported, thumbnail_count: 0 });
        expect(await buildTrickplayManifest({} as never, 'item', 'file', 320, null)).toBeNull();
    });
});

it('negatively caches a missing artifact per file, including the file-selection DB lookup', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    h.selection.mockResolvedValue({
        fileId: 'negative-ttl-file',
        files: [{ id: 'negative-ttl-file', file_path: '/movie.mp4' }],
    });
    h.widths.mockResolvedValue([]);
    try {
        expect(await repairLocalTrickplayParams({} as never, 'item', 'negative-ttl-file')).toEqual(
            [],
        );
        expect(await repairLocalTrickplayParams({} as never, 'item', 'negative-ttl-file')).toEqual(
            [],
        );
        expect(h.selection).toHaveBeenCalledTimes(1);
        expect(h.widths).toHaveBeenCalledTimes(1);
        now.mockReturnValue(61000);
        await repairLocalTrickplayParams({} as never, 'item', 'negative-ttl-file');
        expect(h.widths).toHaveBeenCalledTimes(2);
    } finally {
        now.mockRestore();
    }
});
