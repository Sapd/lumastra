// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubtitleRenderBudgetError } from './subtitle-render-protocol.js';
import { Logger } from '../utils/logger.js';
import * as renderWorker from './subtitle-render-worker.js';
import type postgres from 'postgres';

const resolveSubtitle = vi.fn();
const getBinary = vi.fn();
const setBinary = vi.fn();
const getStreamsForFile = vi.fn();
const resolvePlaybackSelection = vi.fn();

vi.mock('./subtitle-resolver.service.js', () => ({
    resolveSubtitle: (...args: unknown[]) => resolveSubtitle(...args),
}));

vi.mock('../database/queries/media-streams.queries.js', () => ({
    getStreamsForFile: (...args: unknown[]) => getStreamsForFile(...args),
}));

vi.mock('../database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: (...args: unknown[]) => resolvePlaybackSelection(...args),
}));

vi.mock('./cache/subtitle-file-cache.service.js', () => ({
    SubtitleFileCacheService: {
        getBinary: (...args: unknown[]) => getBinary(...args),
        setBinary: (...args: unknown[]) => setBinary(...args),
    },
}));

const { getRenderedSubtitle, resetRenderedSubtitleCaches } =
    await import('./subtitle-render.service.js');

// --- minimal PGS builders (mirrors pgs-parser.test.ts) ----------------------

function segment(type: number, ptsMs: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(13);
    header.write('PG', 0, 'ascii');
    header.writeUInt32BE(Math.round((ptsMs / 1000) * 90_000), 2);
    header.writeUInt32BE(0, 6);
    header[10] = type;
    header.writeUInt16BE(payload.length, 11);
    return Buffer.concat([header, payload]);
}

function pcsOn(x: number, y: number): Buffer {
    const p = Buffer.alloc(19);
    p.writeUInt16BE(1920, 0);
    p.writeUInt16BE(1080, 2);
    p[10] = 1;
    p.writeUInt16BE(0, 11);
    p.writeUInt16BE(x, 15);
    p.writeUInt16BE(y, 17);
    return p;
}

function pcsOff(): Buffer {
    const p = Buffer.alloc(11);
    p.writeUInt16BE(1920, 0);
    p.writeUInt16BE(1080, 2);
    p[10] = 0;
    return p;
}

/** Opaque white at index 1. */
function pds(): Buffer {
    return Buffer.from([0, 0, 1, 235, 128, 128, 255]);
}

/** Fully transparent at index 1 — draws nothing. */
function pdsTransparent(): Buffer {
    return Buffer.from([0, 0, 1, 16, 128, 128, 0]);
}

function ods(width: number, height: number): Buffer {
    const rle = Buffer.from([0x00, 0x80 | width, 1, 0x00, 0x00]);
    const head = Buffer.alloc(11);
    head.writeUInt16BE(0, 0);
    head[3] = 0x80 | 0x40;
    head.writeUIntBE(rle.length + 4, 4, 3);
    head.writeUInt16BE(width, 7);
    head.writeUInt16BE(height, 9);
    return Buffer.concat([head, rle]);
}

function track(palette: Buffer = pds()): Buffer {
    return Buffer.concat([
        segment(0x16, 1000, pcsOn(100, 900)),
        segment(0x14, 1000, palette),
        segment(0x15, 1000, ods(4, 2)),
        segment(0x80, 1000, Buffer.alloc(0)),
        segment(0x16, 3000, pcsOff()),
        segment(0x80, 3000, Buffer.alloc(0)),
        segment(0x16, 5000, pcsOn(200, 800)),
        segment(0x14, 5000, palette),
        segment(0x15, 5000, ods(6, 2)),
        segment(0x80, 5000, Buffer.alloc(0)),
        segment(0x16, 7000, pcsOff()),
        segment(0x80, 7000, Buffer.alloc(0)),
    ]);
}

const sql = {} as postgres.Sql;

describe('getRenderedSubtitle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // The service keeps unpacked bundles hot in-process; without this each
        // case would be answered from the previous case's render.
        resetRenderedSubtitleCaches();
        getBinary.mockResolvedValue(null);
        setBinary.mockResolvedValue(undefined);
        getStreamsForFile.mockResolvedValue([]);
        resolvePlaybackSelection.mockResolvedValue({ files: [] });
    });

    it('allows retry after transient worker overload instead of caching an empty track', async () => {
        resolveSubtitle.mockResolvedValue({ content: track() });
        const worker = vi.spyOn(renderWorker, 'runSubtitleWorker');
        worker.mockRejectedValueOnce(new Error('Subtitle render queue is full'));
        try {
            expect(await getRenderedSubtitle(sql, 'retry-worker', 5, 'file')).toBeNull();
            expect(await getRenderedSubtitle(sql, 'retry-worker', 5, 'file')).not.toBeNull();
            expect(worker).toHaveBeenCalledTimes(2);
        } finally {
            worker.mockRestore();
        }
    });

    it('warns with track identity and work counts on budget failure and allows retry', async () => {
        const counts = {
            references: 10,
            uniqueBitmaps: 9,
            renderedPixels: 90,
            requestedPixels: 10,
            maxPixels: 95,
            maxReferences: 80_000,
            limit: 'pixels' as const,
        };
        const warn = vi.spyOn(Logger.for('SubtitleRender'), 'warn');
        const worker = vi.spyOn(renderWorker, 'runSubtitleWorker');
        resolveSubtitle.mockResolvedValue({ content: track() });
        worker.mockRejectedValueOnce(new SubtitleRenderBudgetError(counts));
        try {
            expect(await getRenderedSubtitle(sql, 'budget-media', 5, 'file')).toBeNull();
            expect(warn).toHaveBeenCalledWith('Bitmap subtitle render budget exceeded', {
                mediaItemId: 'budget-media',
                streamIndex: 5,
                ...counts,
            });
            expect(await getRenderedSubtitle(sql, 'budget-media', 5, 'file')).not.toBeNull();
            expect(worker).toHaveBeenCalledTimes(2);
        } finally {
            worker.mockRestore();
            warn.mockRestore();
        }
    });

    it('renders cues with absolute timing and canvas', async () => {
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        const result = await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');

        expect(result).not.toBeNull();
        expect(result!.manifest.canvas).toEqual({ w: 1920, h: 1080 });
        expect(result!.manifest.cues).toHaveLength(2);
        expect(result!.manifest.cues[0]).toMatchObject({ startMs: 1000, endMs: 3000 });
        expect(result!.manifest.cues[1]).toMatchObject({ startMs: 5000, endMs: 7000 });
    });

    it('emits rect geometry and an image id per rect', async () => {
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        const result = await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');
        const [rect] = result!.manifest.cues[0].rects;

        expect(rect).toMatchObject({ x: 100, y: 900, w: 4, h: 2 });
        expect(rect.image).toMatch(/^[a-z0-9]+$/);
    });

    it('serves a real PNG for every image the manifest references', async () => {
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        const result = await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');

        for (const cue of result!.manifest.cues) {
            for (const rect of cue.rects) {
                const png = result!.getImage(rect.image);
                expect(png).not.toBeNull();
                // PNG signature
                expect(png!.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            }
        }
    });

    it('returns null for an unknown image id', async () => {
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        const result = await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');
        expect(result!.getImage('nope')).toBeNull();
    });

    // The cached blob must reconstruct byte-identically, or a cache hit would
    // serve a different manifest than the render that produced it.
    it('round-trips through the cache blob', async () => {
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        const fresh = await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');
        expect(setBinary).toHaveBeenCalledTimes(1);

        const blob = setBinary.mock.calls[0][3] as Buffer;

        // Simulate a restart: the in-process bundle is gone, only the blob remains.
        resetRenderedSubtitleCaches();
        getBinary.mockResolvedValue(blob);
        resolveSubtitle.mockRejectedValue(new Error('must not re-extract on a cache hit'));

        const cached = await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');

        expect(cached!.manifest).toEqual(fresh!.manifest);
        const id = fresh!.manifest.cues[0].rects[0].image;
        expect(cached!.getImage(id)).toEqual(fresh!.getImage(id));
    });

    it('caches under the render extension so cleanup treats it as binary', async () => {
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');

        expect(setBinary).toHaveBeenCalledWith(
            'item-1_file-1',
            5,
            'render',
            expect.any(Buffer),
            null,
        );
    });

    // Without the path the cache can only see its central directory, and a
    // render stored alongside the media would be re-done on every cold process.
    it("hands the cache the media file's path, so an alongside render is found", async () => {
        const probedAt = new Date('2026-01-01T00:00:00Z');
        resolvePlaybackSelection.mockResolvedValue({
            files: [{ id: 'file-1', file_path: '/data/movies/Film/Film.mkv', probed_at: probedAt }],
        });
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');

        expect(getBinary).toHaveBeenCalledWith(
            'item-1_file-1',
            5,
            'render',
            probedAt,
            '/data/movies/Film/Film.mkv',
        );
        expect(setBinary).toHaveBeenCalledWith(
            'item-1_file-1',
            5,
            'render',
            expect.any(Buffer),
            '/data/movies/Film/Film.mkv',
        );
    });

    // A multi-version item has different streams under the same index per file,
    // so an item-only cache key would serve the 1080p render for a 4K request.
    it('keys the disk cache on the file, not just the item', async () => {
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');
        resetRenderedSubtitleCaches();
        await getRenderedSubtitle(sql, 'item-1', 5, 'file-2');

        const ids = setBinary.mock.calls.map((c) => c[0]);
        expect(ids).toEqual(['item-1_file-1', 'item-1_file-2']);
    });

    it('falls back to rendering when the cached blob is corrupt', async () => {
        getBinary.mockResolvedValue(Buffer.from('not a bundle'));
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        const result = await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');

        expect(result).not.toBeNull();
        expect(resolveSubtitle).toHaveBeenCalled();
    });

    it('returns null when the track has no bitmap subtitle', async () => {
        resolveSubtitle.mockResolvedValue(null);
        expect(await getRenderedSubtitle(sql, 'item-1', 5, 'file-1')).toBeNull();
    });

    it('returns null when the resolver yields text rather than bytes', async () => {
        resolveSubtitle.mockResolvedValue({ content: 'WEBVTT', contentType: 'text/vtt' });
        expect(await getRenderedSubtitle(sql, 'item-1', 5, 'file-1')).toBeNull();
    });

    // Rects that would draw nothing are dropped rather than shipped as blank PNGs.
    it('drops fully transparent cues', async () => {
        resolveSubtitle.mockResolvedValue({
            content: track(pdsTransparent()),
            contentType: 'application/octet-stream',
        });

        expect(await getRenderedSubtitle(sql, 'item-1', 5, 'file-1')).toBeNull();
    });

    // Concurrent first-hits must share one extraction; the cold path is minutes
    // of FFmpeg and running it twice would double that cost.
    it('shares one render between concurrent callers', async () => {
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        const [a, b] = await Promise.all([
            getRenderedSubtitle(sql, 'item-1', 5, 'file-1'),
            getRenderedSubtitle(sql, 'item-1', 5, 'file-1'),
        ]);

        expect(resolveSubtitle).toHaveBeenCalledTimes(1);
        expect(a!.manifest).toEqual(b!.manifest);
    });

    // Regression: the cache read is async, so if the in-flight key were claimed
    // after awaiting it, two concurrent cold callers would both miss and both
    // start a multi-minute extraction. Delay the cache read to force that window.
    it('shares one render even when the cache read is slow', async () => {
        getBinary.mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve(null), 20)),
        );
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        await Promise.all([
            getRenderedSubtitle(sql, 'item-1', 5, 'file-1'),
            getRenderedSubtitle(sql, 'item-1', 5, 'file-1'),
            getRenderedSubtitle(sql, 'item-1', 5, 'file-1'),
        ]);

        expect(resolveSubtitle).toHaveBeenCalledTimes(1);
    });

    // A cache write failure is not a request failure — the caller already holds
    // a good render.
    it('still returns the render when caching it fails', async () => {
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });
        setBinary.mockRejectedValue(new Error('disk full'));

        const result = await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');
        expect(result!.manifest.cues).toHaveLength(2);
    });

    // Dispatch is on the container bytes, so a VobSub track (Matroska-wrapped)
    // must not be fed to the PGS decoder and vice versa.
    it('rejects a buffer that is neither PGS nor Matroska', async () => {
        resolveSubtitle.mockResolvedValue({
            content: Buffer.from('definitely not a subtitle container'),
            contentType: 'application/octet-stream',
        });

        expect(await getRenderedSubtitle(sql, 'item-1', 5, 'file-1')).toBeNull();
    });

    // The format must be named from the codec. Omitting it leaves the default
    // 'vtt', which on an UNPROBED file sends a bitmap track down the text
    // extraction path; always naming 'pgssub' forces a .sup container even for
    // VobSub, which FFmpeg's sup muxer cannot write.
    it('asks for the sup container for a PGS track', async () => {
        getStreamsForFile.mockResolvedValue([
            { stream_type: 'subtitle', stream_index: 5, codec: 'hdmv_pgs_subtitle' },
        ]);
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');

        expect(resolveSubtitle.mock.calls[0][3]).toMatchObject({
            fileId: 'file-1',
            format: 'pgssub',
        });
    });

    it('asks for the sub container for a VobSub track', async () => {
        getStreamsForFile.mockResolvedValue([
            { stream_type: 'subtitle', stream_index: 5, codec: 'dvd_subtitle' },
        ]);
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');

        expect(resolveSubtitle.mock.calls[0][3]).toMatchObject({ format: 'sub' });
    });

    // An unprobed file has no stream row; PGS is both the commoner format and
    // the one that previously worked on that fallback path.
    it('defaults to the sup container when the codec is unknown', async () => {
        getStreamsForFile.mockResolvedValue([]);
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');

        expect(resolveSubtitle.mock.calls[0][3]).toMatchObject({ format: 'pgssub' });
    });

    // A missing source is what an extraction TIMEOUT looks like from here (the
    // resolver swallows it into null). Remembering it made a 120s cold read on a
    // long remux answer "no renderable subtitle" for ten minutes on prod.
    it('does not remember a missing source: the next request extracts again', async () => {
        resolveSubtitle.mockResolvedValueOnce(null);
        expect(await getRenderedSubtitle(sql, 'item-1', 5, 'file-1')).toBeNull();

        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });
        expect(await getRenderedSubtitle(sql, 'item-1', 5, 'file-1')).not.toBeNull();
    });

    it('does not remember a failed extraction either', async () => {
        resolveSubtitle.mockRejectedValueOnce(new Error('extraction exploded'));
        expect(await getRenderedSubtitle(sql, 'item-1', 5, 'file-1')).toBeNull();

        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });
        expect(await getRenderedSubtitle(sql, 'item-1', 5, 'file-1')).not.toBeNull();
    });

    // Once the bytes are in hand a null IS a property of the track, and must be
    // remembered, or a retry loop re-runs a synchronous parse every time.
    it('remembers a track whose bytes cannot be rendered', async () => {
        resolveSubtitle.mockResolvedValue({
            content: Buffer.from('not a bitmap subtitle'),
            contentType: 'application/octet-stream',
        });

        expect(await getRenderedSubtitle(sql, 'item-1', 5, 'file-1')).toBeNull();

        resolveSubtitle.mockClear();
        expect(await getRenderedSubtitle(sql, 'item-1', 5, 'file-1')).toBeNull();
        expect(resolveSubtitle).not.toHaveBeenCalled();
    });

    // The image route serves ids as `immutable`, which is only honest if an id
    // always denotes the same bytes. Sequential ids would restart at 0000 on
    // every render and break that.
    it('gives an image the same id across independent renders', async () => {
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        const first = await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');
        resetRenderedSubtitleCaches();
        const second = await getRenderedSubtitle(sql, 'item-2', 5, 'file-2');

        expect(first!.manifest.cues[0].rects[0].image).toBe(
            second!.manifest.cues[0].rects[0].image,
        );
    });

    it('derives image ids from content, not position', async () => {
        resolveSubtitle.mockResolvedValue({
            content: track(),
            contentType: 'application/octet-stream',
        });

        const result = await getRenderedSubtitle(sql, 'item-1', 5, 'file-1');
        const ids = result!.manifest.cues.flatMap((c) => c.rects.map((r) => r.image));

        // Hex digest prefixes, and the route's id pattern must accept them.
        for (const id of ids) expect(id).toMatch(/^[a-f0-9]{16}$/);
        // The two cues carry differently-sized bitmaps, so ids must differ.
        expect(new Set(ids).size).toBe(2);
    });
});

// One definition, many composition references: decoding budget alone is insufficient.
describe('PGS reference reuse', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetRenderedSubtitleCaches();
        getBinary.mockResolvedValue(null);
        setBinary.mockResolvedValue(undefined);
        getStreamsForFile.mockResolvedValue([]);
        resolvePlaybackSelection.mockResolvedValue({ files: [] });
    });
    it('renders repeated references using one memoised bitmap', async () => {
        const width = 1024;
        const height = 1024;
        const row = Buffer.from([0, 0xc4, 0, 1, 0, 0]);
        const rle = Buffer.concat(Array.from({ length: height }, () => row));
        const head = Buffer.alloc(11);
        head[3] = 0xc0;
        head.writeUIntBE(rle.length + 4, 4, 3);
        head.writeUInt16BE(width, 7);
        head.writeUInt16BE(height, 9);
        const parts = [segment(0x14, 0, pds()), segment(0x15, 0, Buffer.concat([head, rle]))];
        for (let i = 0; i < 1000; i++) {
            parts.push(segment(0x16, i * 100, pcsOn(0, 0)));
            parts.push(segment(0x80, i * 100, Buffer.alloc(0)));
        }
        parts.push(segment(0x16, 100_000, pcsOff()));
        resolveSubtitle.mockResolvedValue({ content: Buffer.concat(parts) });
        expect((await getRenderedSubtitle(sql, 'reused', 5, 'file'))?.manifest.cues).toHaveLength(
            1000,
        );
        expect((await getRenderedSubtitle(sql, 'reused', 5, 'file'))?.manifest.cues).toHaveLength(
            1000,
        );
        expect(resolveSubtitle).toHaveBeenCalledTimes(1);
        expect(setBinary).toHaveBeenCalledTimes(1);
    });
});
