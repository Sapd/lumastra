// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PlaybackInfo's attachment listing never waits on a slow (cold, network
 * mount) ffprobe for longer than its budget; the probe finishes in the
 * background and the next PlaybackInfo gets the fonts from the cache.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ probeMs: 5_000, probes: 0 }));

vi.mock('node:child_process', () => ({
    execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void,
    ) => {
        h.probes++;
        const stdout = JSON.stringify({
            streams: [{ index: 3, codec_name: 'ttf', tags: { filename: 'Font.ttf' } }],
        });
        setTimeout(() => cb(null, { stdout, stderr: '' }), h.probeMs);
    },
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs/promises')>()),
    stat: vi.fn(async () => ({ size: 1000, mtimeMs: 1 })),
}));
vi.mock('$lib/server/utils/media-path-resolver', () => ({
    resolveMediaPath: vi.fn(async (p: string) => ({ isAccessible: true, containerPath: p })),
}));
vi.mock('$lib/server/utils/library-input-guard.js', () => ({
    ffprobeLibraryInputArgs: vi.fn(async () => []),
}));
vi.mock('$lib/server/services/transcoding/input-guard.js', () => ({
    assertTranscodeInputIsMedia: vi.fn(async () => undefined),
}));

const { mediaAttachmentsForSource, clearVideoAttachmentCaches, PLAYBACKINFO_ATTACHMENT_BUDGET_MS } =
    await import('./video-attachments');

const opts = {
    itemId: 'item-1',
    fileId: 'file-1',
    filePath: '/media/anime/ep01.mkv',
    container: 'mkv',
    subtitleCodecs: ['ass'],
    apiKey: 'k',
};
const sql = {} as Parameters<typeof mediaAttachmentsForSource>[0];

beforeEach(() => {
    vi.useFakeTimers();
    clearVideoAttachmentCaches();
    h.probes = 0;
});
afterEach(() => {
    vi.useRealTimers();
});

describe('mediaAttachmentsForSource budget', () => {
    it('answers [] once the budget passes and serves the warmed cache next time', async () => {
        h.probeMs = 5_000;
        let settled: unknown = 'pending';
        const first = mediaAttachmentsForSource(sql, opts).then((v) => (settled = v));

        await vi.advanceTimersByTimeAsync(PLAYBACKINFO_ATTACHMENT_BUDGET_MS - 1);
        expect(settled).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        await first;
        expect(settled).toEqual([]);

        // The probe keeps running and fills the cache.
        await vi.advanceTimersByTimeAsync(5_000);
        const second = await mediaAttachmentsForSource(sql, opts);
        expect(second).toEqual([
            expect.objectContaining({
                Index: 3,
                FileName: 'Font.ttf',
                DeliveryUrl: '/Videos/item-1/file-1/Attachments/3?api_key=k',
            }),
        ]);
        expect(h.probes).toBe(1);
    });

    it('returns the listing directly when the probe is fast', async () => {
        h.probeMs = 100;
        const p = mediaAttachmentsForSource(sql, opts);
        await vi.advanceTimersByTimeAsync(100);
        expect(await p).toHaveLength(1);
    });
});
