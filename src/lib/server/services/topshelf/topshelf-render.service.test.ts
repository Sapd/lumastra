// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the Top Shelf render service (§9.1):
 *  - selectTopShelfSource decision tree (trailer / snippet / unavailable;
 *    cinemagraph never selects the trailer)
 *  - buildTopShelfFfmpegArgs (cinemagraph -an + no -c:a; preview -c:a aac;
 *    both -movflags +faststart)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/config.js', () => ({
    config: {
        TOPSHELF_TRAILER_MAX_SECONDS: 90,
        TOPSHELF_PREVIEW_DURATION_SECONDS: 30,
        TOPSHELF_CINEMAGRAPH_DURATION_SECONDS: 15,
        TOPSHELF_RENDER_MAX_WIDTH: 1280,
        TOPSHELF_RENDER_MAX_HEIGHT: 720,
        // Deliberately DIFFERENT from TOPSHELF_RENDER_MAX_WIDTH (mirrors the
        // real 640px hover-preview default) so a regression that reintroduces
        // a read of PREVIEW_MAX_WIDTH anywhere in the Top Shelf render path
        // shows up as a wrong (640-derived) number instead of silently
        // matching by coincidence.
        PREVIEW_MAX_WIDTH: 640,
        PREVIEW_ENCODING_PRESET: 'veryfast',
        PREVIEW_MAX_VIDEO_BITRATE_MBPS: 2,
        TOPSHELF_MAX_CONCURRENT_RENDERS: 1,
        TOPSHELF_MAX_PENDING_RENDERS: 24,
        TOPSHELF_OVERLAY_SAFE_PADDING: 0.055,
    },
}));

const mockFindLocalTrailerForItem = vi.fn();
const mockGetFilesForMediaItem = vi.fn();
const mockResolvePreviewStartPosition = vi.fn();
const mockResolveFileVersion = vi.fn();

// Render-pipeline harness: stub ffmpeg, the artifact store, the overlay
// materializers (sharp/image-proxy), and node:fs so runRender stays hermetic.
const mockSpawnFFmpegSafely = vi.fn().mockResolvedValue(undefined);
const mockRecordVariant = vi.fn().mockResolvedValue(undefined);
const mockMaterializeLogoPng = vi.fn().mockResolvedValue(true);
const mockRenderTextPng = vi.fn().mockResolvedValue(undefined);
const mockEnsureScrimAsset = vi.fn().mockResolvedValue('/cache/scrim-gradient.png');
const mockFsMkdir = vi.fn().mockResolvedValue(undefined);
const mockFsRm = vi.fn().mockResolvedValue(undefined);
const mockFsRename = vi.fn().mockResolvedValue(undefined);
const mockFsStat = vi.fn().mockResolvedValue({ size: 4242 });

vi.mock('$lib/server/utils/ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: (...args: unknown[]) => mockSpawnFFmpegSafely(...args),
}));
vi.mock('./topshelf-artifact.store.js', () => ({
    getTopShelfArtifactStore: () => ({
        itemDir: (id: string) => `/cache/${id}`,
        artifactPath: (id: string, variant: string, key: string) =>
            `/cache/${id}/${variant}-${key}.mp4`,
        recordVariant: (...args: unknown[]) => mockRecordVariant(...args),
    }),
}));
vi.mock('node:fs', () => ({
    promises: {
        mkdir: (...args: unknown[]) => mockFsMkdir(...args),
        rm: (...args: unknown[]) => mockFsRm(...args),
        rename: (...args: unknown[]) => mockFsRename(...args),
        stat: (...args: unknown[]) => mockFsStat(...args),
    },
}));

vi.mock('$lib/server/database/queries/media-extras.queries.js', () => ({
    findLocalTrailerForItem: (...args: unknown[]) => mockFindLocalTrailerForItem(...args),
}));
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFilesForMediaItem: (...args: unknown[]) => mockGetFilesForMediaItem(...args),
}));
vi.mock('$lib/server/utils/preview-start-position.js', () => ({
    resolvePreviewStartPosition: (...args: unknown[]) => mockResolvePreviewStartPosition(...args),
}));
vi.mock('$lib/server/services/preview-session.service.js', () => ({
    resolveFileVersion: (...args: unknown[]) => mockResolveFileVersion(...args),
}));
// topshelf-overlay-render.js also exports impure PNG materializers that pull
// in the image-proxy service (and, transitively, the task registry) — mock
// the module so this unit test stays hermetic and doesn't need to satisfy
// that unrelated import graph's config surface.
vi.mock('./topshelf-overlay-render.js', () => ({
    overlayGeometry: (pos: string) => ({
        xExpr: `x-${pos}`,
        yExpr: `y-${pos}`,
        scrimYExpr: `scrimY-${pos}`,
        scrimFlip: pos === 'tl' || pos === 'tr',
    }),
    materializeLogoPng: (...args: unknown[]) => mockMaterializeLogoPng(...args),
    renderTextPng: (...args: unknown[]) => mockRenderTextPng(...args),
    ensureScrimAsset: (...args: unknown[]) => mockEnsureScrimAsset(...args),
}));

import {
    selectTopShelfSource,
    buildTopShelfFfmpegArgs,
    resolveAndEnqueueTopShelfVariant,
    enqueueTopShelfRender,
    __resetTopShelfRenderStateForTests,
} from './topshelf-render.service';
import { computeOverlayBox } from './topshelf-overlay';

const fakeSql = {} as never;

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveFileVersion.mockResolvedValue('fv-1');
    mockResolvePreviewStartPosition.mockResolvedValue(120);
});

describe('selectTopShelfSource — preview variant', () => {
    it('selects the local trailer when one exists, start=0, capped duration, previewSource=trailer', async () => {
        mockFindLocalTrailerForItem.mockResolvedValue('trailer-item-id');
        mockGetFilesForMediaItem.mockResolvedValue([
            {
                id: 'file-trailer',
                file_path: '/trailer.mkv',
                duration_seconds: 60,
                is_default: true,
            },
        ]);

        const result = await selectTopShelfSource(fakeSql, 'parent-id', 'preview');

        expect(result.status).toBe('ready');
        expect(result.previewSource).toBe('trailer');
        expect(result.sourceItemId).toBe('trailer-item-id');
        expect(result.startSeconds).toBe(0);
        expect(result.durationSeconds).toBe(60);
        expect(mockGetFilesForMediaItem).toHaveBeenCalledWith(fakeSql, 'trailer-item-id');
    });

    it('caps trailer duration at TOPSHELF_TRAILER_MAX_SECONDS', async () => {
        mockFindLocalTrailerForItem.mockResolvedValue('trailer-item-id');
        mockGetFilesForMediaItem.mockResolvedValue([
            {
                id: 'file-trailer',
                file_path: '/trailer.mkv',
                duration_seconds: 500,
                is_default: true,
            },
        ]);

        const result = await selectTopShelfSource(fakeSql, 'parent-id', 'preview');
        expect(result.durationSeconds).toBe(90);
    });

    it('falls back to a runtime-proportional snippet when there is no trailer but a playable file exists', async () => {
        mockFindLocalTrailerForItem.mockResolvedValue(null);
        mockGetFilesForMediaItem.mockResolvedValue([
            { id: 'file-main', file_path: '/movie.mkv', duration_seconds: 6000, is_default: true },
        ]);

        const result = await selectTopShelfSource(fakeSql, 'parent-id', 'preview');

        expect(result.status).toBe('ready');
        expect(result.previewSource).toBe('snippet');
        expect(result.sourceItemId).toBe('parent-id');
        expect(result.startSeconds).toBe(120);
        expect(result.durationSeconds).toBe(30);
        expect(mockResolvePreviewStartPosition).toHaveBeenCalledWith(
            fakeSql,
            'parent-id',
            undefined,
        );
    });

    it('is unavailable when there is no trailer and no playable file (series with no local trailer)', async () => {
        mockFindLocalTrailerForItem.mockResolvedValue(null);
        mockGetFilesForMediaItem.mockResolvedValue([]);

        const result = await selectTopShelfSource(fakeSql, 'series-id', 'preview');
        expect(result.status).toBe('unavailable');
    });
});

describe('selectTopShelfSource — cinemagraph variant', () => {
    it('never selects the trailer, even when one exists', async () => {
        mockGetFilesForMediaItem.mockResolvedValue([
            { id: 'file-main', file_path: '/movie.mkv', duration_seconds: 6000, is_default: true },
        ]);

        const result = await selectTopShelfSource(fakeSql, 'parent-id', 'cinemagraph');

        expect(mockFindLocalTrailerForItem).not.toHaveBeenCalled();
        expect(result.status).toBe('ready');
        expect(result.sourceItemId).toBe('parent-id');
        expect(result.durationSeconds).toBe(15);
        expect(result.previewSource).toBeUndefined();
    });

    it('is unavailable when the item has no direct playable file', async () => {
        mockGetFilesForMediaItem.mockResolvedValue([]);
        const result = await selectTopShelfSource(fakeSql, 'series-id', 'cinemagraph');
        expect(result.status).toBe('unavailable');
        expect(mockFindLocalTrailerForItem).not.toHaveBeenCalled();
    });
});

describe('buildTopShelfFfmpegArgs', () => {
    const base = {
        sourcePath: '/movie.mkv',
        startSeconds: 100,
        durationSeconds: 30,
        outputPath: '/out/preview-abc.mp4.tmp.123',
    };

    it('cinemagraph args contain -an and no -c:a', () => {
        const args = buildTopShelfFfmpegArgs({ ...base, variant: 'cinemagraph' });
        expect(args).toContain('-an');
        expect(args).not.toContain('-c:a');
        expect(args).toContain('-g');
        expect(args).toContain('-sc_threshold');
    });

    it('preview args contain -c:a aac', () => {
        const args = buildTopShelfFfmpegArgs({ ...base, variant: 'preview' });
        const idx = args.indexOf('-c:a');
        expect(idx).toBeGreaterThan(-1);
        expect(args[idx + 1]).toBe('aac');
        expect(args).not.toContain('-an');
    });

    it('both variants contain -movflags +faststart', () => {
        for (const variant of ['preview', 'cinemagraph'] as const) {
            const args = buildTopShelfFfmpegArgs({ ...base, variant });
            const idx = args.indexOf('-movflags');
            expect(idx).toBeGreaterThan(-1);
            expect(args[idx + 1]).toBe('+faststart');
        }
    });

    it('includes -ss/-i/-t and maps 0:v:0', () => {
        const args = buildTopShelfFfmpegArgs({ ...base, variant: 'preview' });
        expect(args).toEqual(
            expect.arrayContaining(['-ss', '100', '-i', '/movie.mkv', '-t', '30', '-map', '0:v:0']),
        );
    });

    it('ends with -f mp4 {outputPath}', () => {
        const args = buildTopShelfFfmpegArgs({ ...base, variant: 'preview' });
        expect(args.slice(-3)).toEqual(['-f', 'mp4', base.outputPath]);
    });
});

describe('buildTopShelfFfmpegArgs — overlay', () => {
    const base = {
        variant: 'preview' as const,
        sourcePath: '/src.mkv',
        startSeconds: 5,
        durationSeconds: 30,
        outputPath: '/out.tmp.mp4',
    };

    it('plain path is unchanged (uses -vf and -map 0:v:0)', () => {
        const args = buildTopShelfFfmpegArgs(base);
        expect(args).toContain('-vf');
        expect(args).toContain('0:v:0');
        expect(args).not.toContain('-filter_complex');
    });

    it('overlay path inserts image inputs before -t, maps [vout], no -vf', () => {
        const args = buildTopShelfFfmpegArgs({
            ...base,
            overlay: {
                style: { pos: 'tl', scrim: true, scale: 0.4 },
                contentPngPath: '/content.png',
                scrimPngPath: '/scrim.png',
                padding: 0.04,
            },
        });
        expect(args).toContain('-filter_complex');
        expect(args).toContain('[vout]');
        expect(args).not.toContain('-vf');
        // extra inputs appear before the -t duration flag
        const tIdx = args.indexOf('-t');
        const scrimIdx = args.indexOf('/scrim.png');
        const contentIdx = args.indexOf('/content.png');
        expect(scrimIdx).toBeGreaterThan(-1);
        expect(contentIdx).toBeGreaterThan(-1);
        expect(scrimIdx).toBeLessThan(tIdx);
        expect(contentIdx).toBeLessThan(tIdx);
        // video is mapped from the graph, not the raw stream
        expect(args).toContain('-map');
        expect(args).toContain('[vout]');
        expect(args).not.toContain('0:v:0');
    });

    it('sizes the graph in ABSOLUTE pixels — no rw/rh reference variables', () => {
        const args = buildTopShelfFfmpegArgs({
            ...base,
            overlay: {
                style: { pos: 'tl', scrim: true, scale: 0.4 },
                contentPngPath: '/content.png',
                scrimPngPath: '/scrim.png',
                padding: 0.04,
            },
        });
        const graph = args[args.indexOf('-filter_complex') + 1];

        // TOPSHELF_RENDER_MAX_WIDTH is 1280 in this file's config mock
        // (PREVIEW_MAX_WIDTH is deliberately a different value, 640 — see the
        // mock comment above):
        //   base   → cover-cropped to exactly 1280x720
        //   scrim  → 1280 x round(720*0.4) = 1280x288
        expect(graph).toContain(
            '[0:v]scale=trunc(iw*sar/2)*2:ih,setsar=1,' +
                'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1[base]',
        );
        expect(graph).toContain('[1:v]scale=1280:288');
        // Regression guard for the hover-preview/Top-Shelf render-size
        // inheritance bug: the graph must never fall back to the 640-derived
        // PREVIEW_MAX_WIDTH numbers.
        expect(graph).not.toContain('scale=640:');
        // The ref-scale form that mis-sized the scrim/content is gone.
        expect(graph).not.toMatch(/\brw\b/);
        expect(graph).not.toMatch(/\brh\b/);
        // [base] is produced once and consumed once.
        expect(graph.match(/\[base\]/g)).toHaveLength(2);
    });

    it('does NOT rescale the content: the box-sized PNG is overlaid verbatim', () => {
        const args = buildTopShelfFfmpegArgs({
            ...base,
            overlay: {
                style: { pos: 'tl', scrim: true, scale: 0.4 },
                contentPngPath: '/content.png',
                scrimPngPath: '/scrim.png',
                padding: 0.04,
            },
        });
        const graph = args[args.indexOf('-filter_complex') + 1];

        // The content input goes straight into the overlay — the old
        // `[2:v]scale=512:-1[ovl]` sized the burn by WIDTH ONLY, letting the
        // content PNG's aspect decide its on-frame height.
        expect(graph).toContain('[scrimmed][2:v]overlay=x-tl:y-tl[vout]');
        expect(graph).not.toMatch(/\[2:v\]scale=/);
        expect(graph).not.toContain('[ovl]');
        // Exactly ONE scale per image input remains (the scrim's), plus the
        // base's two (square-pixel, then cover to 16:9).
        expect(graph.match(/scale=/g)).toHaveLength(3);
    });

    it('sizes the content box in both axes from (scale, TOPSHELF_RENDER_MAX_WIDTH)', () => {
        // 1280 base → 720 reference height; boxW = 0.4*1280, boxH = 0.26*720.
        expect(computeOverlayBox(0.4, 1280)).toEqual({
            baseWidth: 1280,
            baseHeight: 720,
            boxW: 512,
            boxH: 187,
        });
        // The height bound does NOT move with the style's width fraction.
        expect(computeOverlayBox(0.25, 1280).boxH).toBe(187);
        expect(computeOverlayBox(0.25, 1280).boxW).toBe(320);
    });

    it('keeps the scrim band covering the whole overlay box', () => {
        const args = buildTopShelfFfmpegArgs({
            ...base,
            overlay: {
                style: { pos: 'tl', scrim: true, scale: 0.4 },
                contentPngPath: '/content.png',
                scrimPngPath: '/scrim.png',
                padding: 0.04,
            },
        });
        const graph = args[args.indexOf('-filter_complex') + 1];
        const scrimH = Number(/\[1:v\]scale=1280:(\d+)/.exec(graph)![1]);
        const box = computeOverlayBox(0.4, 1280);
        const padY = Math.round(0.04 * box.baseHeight);
        expect(scrimH).toBeGreaterThanOrEqual(padY + box.boxH);
        expect(scrimH).toBeLessThanOrEqual(box.baseHeight);
    });

    it('content input index tracks whether the scrim input is present', () => {
        const noScrim = buildTopShelfFfmpegArgs({
            ...base,
            overlay: {
                style: { pos: 'br', scrim: false, scale: 0.33 },
                contentPngPath: '/content.png',
                padding: 0.04,
            },
        });
        const graph = noScrim[noScrim.indexOf('-filter_complex') + 1];
        expect(graph).toContain('[base][1:v]overlay=x-br:y-br[vout]');
        expect(graph).not.toContain('[scr]');
        // Only the base's two (square-pixel, then cover to 16:9).
        expect(graph.match(/scale=/g)).toHaveLength(2);
    });

    it('top scrim is vflipped, bottom scrim is not', () => {
        const top = buildTopShelfFfmpegArgs({
            ...base,
            overlay: {
                style: { pos: 'tl', scrim: true, scale: 0.4 },
                contentPngPath: '/c.png',
                scrimPngPath: '/s.png',
                padding: 0.04,
            },
        });
        const bottom = buildTopShelfFfmpegArgs({
            ...base,
            overlay: {
                style: { pos: 'bl', scrim: true, scale: 0.4 },
                contentPngPath: '/c.png',
                scrimPngPath: '/s.png',
                padding: 0.04,
            },
        });
        expect(top[top.indexOf('-filter_complex') + 1]).toContain('vflip');
        expect(bottom[bottom.indexOf('-filter_complex') + 1]).not.toContain('vflip');
    });

    it('plain path scale string uses TOPSHELF_RENDER_MAX_WIDTH, never the hover-preview PREVIEW_MAX_WIDTH', () => {
        const args = buildTopShelfFfmpegArgs(base);
        expect(args[args.indexOf('-vf') + 1]).toBe(`scale='min(1280,iw)':-2`);
        expect(args[args.indexOf('-vf') + 1]).not.toContain('640');
    });

    it('overlay without scrim omits the scrim input', () => {
        const args = buildTopShelfFfmpegArgs({
            ...base,
            overlay: {
                style: { pos: 'br', scrim: false, scale: 0.33 },
                contentPngPath: '/content.png',
                padding: 0.04,
            },
        });
        expect(args).not.toContain('/scrim.png');
        expect(args).toContain('/content.png');
    });
});

describe('resolveAndEnqueueTopShelfVariant — overlay token', () => {
    // Drain the coalesced (fire-and-forget) render — every await inside
    // runRender resolves on the microtask queue with these mocks, so flushing
    // the microtask queue a bounded number of times settles it deterministically.
    async function flush(): Promise<void> {
        for (let i = 0; i < 50; i++) await Promise.resolve();
    }

    beforeEach(() => {
        __resetTopShelfRenderStateForTests();
        mockFindLocalTrailerForItem.mockResolvedValue(null);
        mockGetFilesForMediaItem.mockResolvedValue([
            { id: 'file-main', file_path: '/movie.mkv', duration_seconds: 6000, is_default: true },
        ]);
        mockMaterializeLogoPng.mockResolvedValue(true);
        mockSpawnFFmpegSafely.mockResolvedValue(undefined);
        mockFsStat.mockResolvedValue({ size: 4242 });
    });

    it('uses the compound token + content hash and records mode logo for an overlay render', async () => {
        const result = await resolveAndEnqueueTopShelfVariant(fakeSql, 'media-1', 'preview', {
            base: 'preview',
            mode: 'logo',
            style: { pos: 'tl', scrim: true, scale: 0.4 },
            contentHash: 'aaaaaaaaaaaaaaaa',
        });
        expect(result.state).toBe('pending');

        await flush();

        // Recorded under the COMPOUND token, not the plain 'preview' variant,
        // and the entry carries mode 'logo'.
        expect(mockRecordVariant).toHaveBeenCalledWith(
            'media-1',
            'preview-ov-logo-tl-s1-x40',
            expect.objectContaining({ mode: 'logo' }),
        );

        // Logo bytes materialized to a *.content.tmp.* file in the item dir,
        // with no badge (movie/series case).
        expect(mockMaterializeLogoPng).toHaveBeenCalledWith(
            'media-1',
            expect.stringContaining('.content.tmp.'),
            undefined,
            computeOverlayBox(0.4, 1280, 720),
            'tl',
        );
        // Scrim requested (style.scrim=true) but never deleted (shared asset).
        expect(mockEnsureScrimAsset).toHaveBeenCalled();

        // ffmpeg ran with the overlay filter graph, not a plain -vf.
        const args = mockSpawnFFmpegSafely.mock.calls[0][0].args as string[];
        expect(args).toContain('-filter_complex');
    });

    it('threads the episode badge into the logo materializer (ONE composited content PNG)', async () => {
        await resolveAndEnqueueTopShelfVariant(fakeSql, 'ep-1', 'preview', {
            base: 'preview',
            mode: 'logo',
            style: { pos: 'tl', scrim: true, scale: 0.4 },
            badge: 'S01E02',
            contentHash: 'bbbbbbbbbbbbbbbb',
        });
        await flush();

        // The materializer receives the SAME box the graph assumes, plus the
        // corner (so the block hugs the right edges of a right-anchored box).
        expect(mockMaterializeLogoPng).toHaveBeenCalledWith(
            'ep-1',
            expect.stringContaining('.content.tmp.'),
            'S01E02',
            computeOverlayBox(0.4, 1280, 720),
            'tl',
        );
        // Still exactly one content input in the graph (scrim + one overlay).
        const args = mockSpawnFFmpegSafely.mock.calls[0][0].args as string[];
        const graph = args[args.indexOf('-filter_complex') + 1];
        expect(graph.match(/overlay=/g)).toHaveLength(2); // scrim + content
        expect(mockRenderTextPng).not.toHaveBeenCalled();
    });

    it('a logo whose bytes are unavailable throws → negative-caches (no recordVariant)', async () => {
        mockMaterializeLogoPng.mockResolvedValue(false);

        await resolveAndEnqueueTopShelfVariant(fakeSql, 'media-1', 'preview', {
            base: 'preview',
            mode: 'logo',
            style: { pos: 'tl', scrim: true, scale: 0.4 },
            contentHash: 'aaaaaaaaaaaaaaaa',
        });
        await flush();

        expect(mockRecordVariant).not.toHaveBeenCalled();

        // Same contentKey is now negative-cached → the poll surfaces the long retry.
        const second = await resolveAndEnqueueTopShelfVariant(fakeSql, 'media-1', 'preview', {
            base: 'preview',
            mode: 'logo',
            style: { pos: 'tl', scrim: true, scale: 0.4 },
            contentHash: 'aaaaaaaaaaaaaaaa',
        });
        expect(second.state).toBe('pending');
        expect(second.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('plain (no overlay) render records under the bare variant with no mode', async () => {
        await resolveAndEnqueueTopShelfVariant(fakeSql, 'media-1', 'preview');
        await flush();

        expect(mockRecordVariant).toHaveBeenCalledTimes(1);
        const [mediaId, storeKey, entry] = mockRecordVariant.mock.calls[0];
        expect(mediaId).toBe('media-1');
        expect(storeKey).toBe('preview');
        expect((entry as { mode?: unknown }).mode).toBeUndefined();

        // Plain path uses -vf, never the overlay graph.
        const args = mockSpawnFFmpegSafely.mock.calls[0][0].args as string[];
        expect(args).toContain('-vf');
        expect(args).not.toContain('-filter_complex');
    });
});

describe('enqueueTopShelfRender — storeKey derivation without an explicit storeKey (FIX 7)', () => {
    async function flush(): Promise<void> {
        for (let i = 0; i < 50; i++) await Promise.resolve();
    }

    beforeEach(() => {
        __resetTopShelfRenderStateForTests();
        mockMaterializeLogoPng.mockResolvedValue(true);
        mockSpawnFFmpegSafely.mockResolvedValue(undefined);
        mockFsStat.mockResolvedValue({ size: 4242 });
    });

    it('derives the compound overlay token instead of falling back to the bare variant', async () => {
        const outcome = enqueueTopShelfRender({
            mediaId: 'media-x',
            variant: 'preview',
            // storeKey intentionally omitted — an overlay-burned artifact must
            // NOT mis-record under the plain 'preview' key.
            selection: {
                status: 'ready',
                sourceItemId: 'media-x',
                fileId: 'file-x',
                filePath: '/movie.mkv',
                fileVersion: 'fv-1',
                startSeconds: 0,
                durationSeconds: 30,
            },
            contentKey: 'content-key-fix7',
            overlay: {
                base: 'preview',
                mode: 'logo',
                style: { pos: 'tl', scrim: true, scale: 0.4 },
                contentHash: 'aaaaaaaaaaaaaaaa',
            },
        });
        expect(outcome.enqueued).toBe(true);

        await flush();

        expect(mockRecordVariant).toHaveBeenCalledWith(
            'media-x',
            'preview-ov-logo-tl-s1-x40',
            expect.objectContaining({ mode: 'logo' }),
        );
    });
});
