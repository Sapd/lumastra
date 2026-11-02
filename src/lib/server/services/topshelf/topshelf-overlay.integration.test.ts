// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * End-to-end integration test for the Top Shelf overlay ffmpeg filter graph
 * (§4.4 / §9.2). Unlike `topshelf-render.service.test.ts` (which stubs
 * `spawnFFmpegSafely` and only pins the STRUCTURE of the arg list), this test
 * runs a REAL ffmpeg process against a real lavfi-synthesized source and
 * asserts the resulting MP4 actually decodes — it is the authority on whether
 * the exact `scale`/`overlay` filter-graph expressions in
 * `buildTopShelfFfmpegArgs` are valid on this container's ffmpeg (8.0.1).
 *
 * It also EXTRACTS A FRAME and inspects its pixels: rendering over a solid
 * BLACK source makes every non-black pixel overlay ink, so "the label is not
 * clipped at either end", "the burned logo sits in the requested corner" and
 * "the burn stays inside the padded overlay box" become measurable rather than
 * eyeballed. Set `TOPSHELF_OVERLAY_FRAME_DIR=/some/dir` to also keep the
 * extracted frames for visual inspection.
 *
 * THE BOX IS THE POINT. The overlay content PNG is materialized at exactly
 * `boxW x boxH` and ffmpeg overlays it with no rescale, so the burn occupies a
 * KNOWN rectangle at the padded corner for every logo shape. The tall-logo and
 * wide-logo cases below are the regression guards for the two geometry bugs
 * that motivated the box: a stacked logo used to render ~88% of the frame
 * height with a badge scaled up to match, and a burn whose size was decided by
 * the content PNG's own aspect could land outside the intended padded box.
 *
 * Mirrors `topshelf-preview.integration.test.ts`'s ffmpeg-availability
 * gating: `checkFFmpegAvailability(true)` is awaited at MODULE TOP LEVEL
 * (top-level await), not inside a `beforeAll`, because `describe.runIf(...)`
 * predicates are evaluated at collection time — before any `beforeAll` hook
 * would have a chance to set a flag.
 */
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';

// `TOPSHELF_PREVIEW_CACHE_DIR` must land in `process.env` BEFORE `config.ts`
// is (re-)evaluated: it snapshots `process.env` into a module-level object
// at import time, and the shared vitest.integration setup already imports
// (and thus caches) `config.ts` before this file's own top-level code runs.
// `vi.resetModules()` clears that cache so the dynamic imports below force a
// fresh `config.ts` evaluation that observes the env var set immediately
// prior — mirrors `topshelf-preview.integration.test.ts`'s dynamic-import
// dance. Without this, `ensureScrimAsset()` (called from the text-overlay
// test) tries to `mkdir` the production default (`/config/cache/topshelf`),
// which doesn't exist outside the container.
const cacheDir = await fs.mkdtemp(join(tmpdir(), 'topshelf-overlay-cache-'));
vi.resetModules();
process.env.TOPSHELF_PREVIEW_CACHE_DIR = cacheDir;

const { checkFFmpegAvailability, spawnFFmpegSafely } =
    await import('$lib/server/utils/ffmpeg-spawn.js');
const { probeMediaFile } = await import('$lib/server/utils/ffprobe.js');
const { buildTopShelfFfmpegArgs } = await import('./topshelf-render.service.js');
const { renderTextPng, ensureScrimAsset, composeLogoWithBadge, badgeChipHeight } =
    await import('./topshelf-overlay-render.js');
const { computeOverlayBox } = await import('./topshelf-overlay.js');
const { config } = await import('$lib/server/config.js');

const ffmpegAvailable = await checkFFmpegAvailability(true);

const SOURCE_WIDTH = 1280;
const SOURCE_HEIGHT = 720;
const SOURCE_DURATION_SECONDS = 2;
/**
 * The overlay path forces the base to exactly this width (absolute sizing).
 * Top Shelf's OWN render knob — NOT `PREVIEW_MAX_WIDTH` (the hover-preview
 * 640px default), which `buildTopShelfFfmpegArgs` no longer reads.
 */
const BASE_WIDTH = config.TOPSHELF_RENDER_MAX_WIDTH;
const BASE_HEIGHT = config.TOPSHELF_RENDER_MAX_HEIGHT;
const PADDING = config.TOPSHELF_OVERLAY_SAFE_PADDING;
const SCALE = 0.4;
/** The one box every assertion below is expressed in terms of. */
const BOX = computeOverlayBox(SCALE, BASE_WIDTH, BASE_HEIGHT);

/** Optional dump target for the extracted frames (visual inspection). */
const FRAME_DIR = process.env.TOPSHELF_OVERLAY_FRAME_DIR;

/** Colour-bar source — realistic content for the decode/probe assertions. */
const LAVFI_BARS = `testsrc=size=${SOURCE_WIDTH}x${SOURCE_HEIGHT}:rate=24`;
/** Solid-black source — every non-black pixel in the frame is then overlay ink. */
const LAVFI_BLACK = `color=c=black:size=${SOURCE_WIDTH}x${SOURCE_HEIGHT}:rate=24`;

/** Synthesize a tiny lavfi clip — fast, deterministic, no fixture file. */
async function generateTestSource(dir: string, lavfi: string, name = 'src.mp4'): Promise<string> {
    const src = join(dir, name);
    await spawnFFmpegSafely({
        args: [
            '-f',
            'lavfi',
            '-i',
            lavfi,
            '-t',
            String(SOURCE_DURATION_SECONDS),
            '-pix_fmt',
            'yuv420p',
            '-y',
            src,
        ],
        timeout: 60_000,
        context: { operation: 'topshelf-overlay-test-src' },
    });
    return src;
}

/**
 * Synthesize a logo PNG with real glyphs at a given aspect ratio. Text (rather
 * than a solid block) is what makes a LEFT-side clip visible: a solid rectangle
 * looks identical whether or not its leading third was cut off.
 */
async function makeLogo(
    outPath: string,
    opts: { width: number; height: number; lines: string[] },
): Promise<string> {
    const rowH = opts.height / opts.lines.length;
    // Size the rows so the LONGEST one comfortably fits the fixture's own
    // width (0.68em average advance leaves headroom over DejaVu Sans Bold's
    // ~0.62). `textLength` is NOT usable here — librsvg ignores it, which is
    // exactly how an over-sized fixture would silently clip itself and make a
    // pipeline clip indistinguishable from a fixture clip.
    const longest = Math.max(...opts.lines.map((l) => l.length));
    const fontPx = Math.round(Math.min(rowH * 0.7, (opts.width - 8) / (longest * 0.68)));
    const text = opts.lines
        .map(
            (line, i) =>
                `<text x="4" y="${Math.round(rowH * (i + 0.75))}" font-size="${fontPx}" fill="#ffffff">${line}</text>`,
        )
        .join('\n  ');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width}" height="${opts.height}">
  <style>text { font-family: sans-serif; font-weight: 700; }</style>
  ${text}
</svg>`;
    await sharp(Buffer.from(svg)).png().toFile(outPath);
    return outPath;
}

/** Copy an artifact out to `TOPSHELF_OVERLAY_FRAME_DIR` when that debug hook is set. */
async function keepArtifact(path: string): Promise<string> {
    if (FRAME_DIR) {
        await fs.mkdir(FRAME_DIR, { recursive: true });
        await fs.copyFile(path, join(FRAME_DIR, basename(path)));
    }
    return path;
}

/** Extract a single frame ~1s into the clip as a PNG. */
async function extractFrame(mp4Path: string, outPath: string): Promise<string> {
    await spawnFFmpegSafely({
        args: ['-ss', '1', '-i', mp4Path, '-frames:v', '1', '-y', outPath],
        timeout: 60_000,
        context: { operation: 'topshelf-overlay-test-frame' },
    });
    return keepArtifact(outPath);
}

interface InkBox {
    width: number;
    height: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    pixels: number;
}

/**
 * Bounding box of every pixel brighter than `threshold` — over a BLACK source
 * that is exactly the overlay's ink (glyphs, logo, badge plate).
 */
async function inkBox(framePath: string, threshold = 90): Promise<InkBox> {
    const { data, info } = await sharp(framePath).raw().toBuffer({ resolveWithObject: true });
    let minX = info.width;
    let maxX = -1;
    let minY = info.height;
    let maxY = -1;
    let pixels = 0;
    for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
            const i = (y * info.width + x) * info.channels;
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (lum < threshold) continue;
            pixels++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    return { width: info.width, height: info.height, minX, maxX, minY, maxY, pixels };
}

/** Overlay args for the shared "black source, top-left, scrimmed" shape. */
async function overlayArgs(
    src: string,
    content: string,
    out: string,
    pos: 'tl' | 'tr' | 'bl' | 'br' = 'tl',
    scrim = true,
): Promise<string[]> {
    return buildTopShelfFfmpegArgs({
        variant: 'preview',
        sourcePath: src,
        startSeconds: 0,
        durationSeconds: SOURCE_DURATION_SECONDS,
        outputPath: out,
        overlay: {
            style: { pos, scrim, scale: SCALE },
            contentPngPath: content,
            ...(scrim ? { scrimPngPath: await ensureScrimAsset() } : {}),
            padding: PADDING,
        },
    });
}

/**
 * The padded rectangle the burn must live inside, for a given corner. ffmpeg
 * truncates the overlay offset expression and may round it to an even offset
 * for chroma alignment, hence the few px of slack.
 */
function expectedBox(pos: 'tl' | 'tr' | 'bl' | 'br', frameW: number, frameH: number) {
    const padX = Math.round(frameW * PADDING);
    const padY = Math.round(frameH * PADDING);
    const left = pos === 'tl' || pos === 'bl' ? padX : frameW - padX - BOX.boxW;
    const top = pos === 'tl' || pos === 'tr' ? padY : frameH - padY - BOX.boxH;
    return { left, top, right: left + BOX.boxW, bottom: top + BOX.boxH };
}

/** Assert the ink is fully inside the padded box (both bugs' regression guard). */
function expectInkInsideBox(box: InkBox, pos: 'tl' | 'tr' | 'bl' | 'br'): void {
    const e = expectedBox(pos, box.width, box.height);
    const SLACK = 4;
    expect(box.pixels).toBeGreaterThan(0);
    // Nothing off the LEFT (or past any other edge) of the padded box.
    expect(box.minX).toBeGreaterThanOrEqual(e.left - SLACK);
    expect(box.maxX).toBeLessThanOrEqual(e.right + SLACK);
    expect(box.minY).toBeGreaterThanOrEqual(e.top - SLACK);
    expect(box.maxY).toBeLessThanOrEqual(e.bottom + SLACK);
    // And therefore never clipped by the frame itself.
    expect(box.minX).toBeGreaterThan(0);
    expect(box.maxX).toBeLessThan(box.width - 1);
    expect(box.minY).toBeGreaterThan(0);
    expect(box.maxY).toBeLessThan(box.height - 1);
}

describe.runIf(ffmpegAvailable)('topshelf overlay render (e2e)', () => {
    it('burns a TEXT overlay (with scrim, XML-escaped "&", top-left) into a valid faststart MP4', async () => {
        const dir = await fs.mkdtemp(join(tmpdir(), 'topshelf-overlay-'));
        try {
            const src = await generateTestSource(dir, LAVFI_BARS);

            // Exercises escapeXml's `&` handling inside renderTextPng.
            const content = join(dir, 'content-text.png');
            await renderTextPng('S01E02 · Tom & Jerry', content, BOX);

            const out = join(dir, 'out-text.mp4');
            await spawnFFmpegSafely({
                args: await overlayArgs(src, content, out),
                timeout: 120_000,
                context: { operation: 'topshelf-overlay-test-text' },
            });

            const stat = await fs.stat(out);
            expect(stat.size).toBeGreaterThan(0);

            const probe = await probeMediaFile(out);
            expect(probe.success).toBe(true);
            expect(probe.video).not.toBeNull();
            expect(probe.video?.codec).toBe('h264');
            expect(probe.video?.pixelFormat).toBe('yuv420p');
            // Absolute sizing: the overlay path forces the base width.
            expect(probe.video?.width).toBe(BASE_WIDTH);
            expect(probe.video?.height).toBeGreaterThan(0);
        } finally {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }, 60_000);

    it('burns a LOGO-style image overlay (bottom-right, scrim off) into a valid faststart MP4', async () => {
        const dir = await fs.mkdtemp(join(tmpdir(), 'topshelf-overlay-'));
        try {
            const src = await generateTestSource(dir, LAVFI_BARS);

            const logo = join(dir, 'logo-src.png');
            await makeLogo(logo, { width: 400, height: 160, lines: ['LOGO'] });
            const content = join(dir, 'content-logo.png');
            await composeLogoWithBadge(await fs.readFile(logo), null, content, BOX, 'br');

            const out = join(dir, 'out-logo.mp4');
            await spawnFFmpegSafely({
                args: await overlayArgs(src, content, out, 'br', false),
                timeout: 120_000,
                context: { operation: 'topshelf-overlay-test-logo' },
            });

            const stat = await fs.stat(out);
            expect(stat.size).toBeGreaterThan(0);

            const probe = await probeMediaFile(out);
            expect(probe.success).toBe(true);
            expect(probe.video).not.toBeNull();
            expect(probe.video?.codec).toBe('h264');
            expect(probe.video?.pixelFormat).toBe('yuv420p');
        } finally {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }, 60_000);

    it('logo-only (movie style, top-left): the burned logo lands in the padded box, unclipped', async () => {
        const dir = await fs.mkdtemp(join(tmpdir(), 'topshelf-overlay-'));
        try {
            const src = await generateTestSource(dir, LAVFI_BLACK);
            const logo = join(dir, 'logo.png');
            await makeLogo(logo, { width: 600, height: 200, lines: ['LOGOTYPE'] });
            const content = join(dir, 'content.png');
            await composeLogoWithBadge(await fs.readFile(logo), null, content, BOX);
            const meta = await sharp(content).metadata();
            expect(meta.width).toBe(BOX.boxW);
            expect(meta.height).toBe(BOX.boxH);

            const out = join(dir, 'out-logo-only.mp4');
            await spawnFFmpegSafely({
                args: await overlayArgs(src, content, out, 'tl'),
                timeout: 120_000,
                context: { operation: 'topshelf-overlay-frame-logo' },
            });

            const box = await inkBox(await extractFrame(out, join(dir, 'frame-logo.png')));
            expect(box.width).toBe(BASE_WIDTH);
            expectInkInsideBox(box, 'tl');
        } finally {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }, 60_000);

    /**
     * NON-16:9 SOURCE REGRESSION GUARD. tvOS aspect-fills the shelf, so the
     * burn must land in a frame that already IS 16:9. A 4:3 episode (Star Trek
     * TNG, 960x720) used to render at 1280x960; the shelf then cut its top
     * 120px, and the logo and `S03E13` badge with them. A scope source is the
     * mirror case (cut left/right), and an anamorphic one must be measured by
     * its display shape (720x576 at SAR 16:15 is 4:3, not 5:4).
     */
    for (const [label, lavfi] of [
        ['4:3', 'color=c=black:size=960x720:rate=24'],
        ['2.39:1 scope', 'color=c=black:size=1280x536:rate=24'],
        ['anamorphic 4:3', 'color=c=black:size=720x576:rate=24,setsar=16/15'],
    ] as const) {
        it(`${label} source: cover-cropped to the 16:9 base, logo still inside the padded box`, async () => {
            const dir = await fs.mkdtemp(join(tmpdir(), 'topshelf-overlay-'));
            try {
                const src = await generateTestSource(dir, lavfi);
                const logo = join(dir, 'logo.png');
                await makeLogo(logo, { width: 300, height: 260, lines: ['STAR', 'TREK'] });
                const content = join(dir, 'content.png');
                await composeLogoWithBadge(await fs.readFile(logo), 'S03E13', content, BOX);

                const out = join(dir, 'out-aspect.mp4');
                await spawnFFmpegSafely({
                    args: await overlayArgs(src, content, out, 'tl'),
                    timeout: 120_000,
                    context: { operation: 'topshelf-overlay-frame-aspect' },
                });

                const probe = await probeMediaFile(out);
                expect(probe.video?.width).toBe(BASE_WIDTH);
                expect(probe.video?.height).toBe(BASE_HEIGHT);
                const box = await inkBox(await extractFrame(out, join(dir, 'frame-aspect.png')));
                expect(box.height).toBe(BASE_HEIGHT);
                expectInkInsideBox(box, 'tl');
            } finally {
                await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
            }
        }, 60_000);
    }

    /**
     * BUG 1 REGRESSION GUARD — a stacked/near-square logo. Sized by width only,
     * this composite rendered ~88% of the frame height with a badge upscaled by
     * the same 1.4x factor. Bounded by the box, it can never exceed `boxH`.
     */
    it('TALL stacked logo + badge: fits the box, never dominates the frame, badge stays small', async () => {
        const dir = await fs.mkdtemp(join(tmpdir(), 'topshelf-overlay-'));
        try {
            const src = await generateTestSource(dir, LAVFI_BLACK);
            const logo = join(dir, 'logo-tall.png');
            // ~1:1 overall, two stacked rows — the Drifting-Clouds shape.
            await makeLogo(logo, { width: 900, height: 900, lines: ['BREAKING', 'BAD'] });

            const content = join(dir, 'content-tall.png');
            await composeLogoWithBadge(await fs.readFile(logo), 'S01E01', content, BOX);
            await keepArtifact(content);
            const meta = await sharp(content).metadata();
            expect(meta.width).toBe(BOX.boxW);
            expect(meta.height).toBe(BOX.boxH);

            const out = join(dir, 'out-tall.mp4');
            await spawnFFmpegSafely({
                args: await overlayArgs(src, content, out, 'tl'),
                timeout: 120_000,
                context: { operation: 'topshelf-overlay-frame-tall' },
            });

            const frame = await extractFrame(out, join(dir, 'frame-tall.png'));
            const box = await inkBox(frame);
            expect(box.width).toBe(BASE_WIDTH);
            expectInkInsideBox(box, 'tl');
            // The whole burn is a corner badge, not a title card.
            expect(box.maxY - box.minY + 1).toBeLessThanOrEqual(BOX.boxH);
            expect((box.maxY - box.minY + 1) / box.height).toBeLessThan(0.3);

            // The badge chip is genuinely small: its ink lives in the bottom
            // slice of the box and is only a few percent of the frame height.
            const chipH = badgeChipHeight(BOX.boxH);
            expect(chipH).toBeLessThanOrEqual(Math.round(BOX.boxH * 0.25));
            expect(chipH / BOX.baseHeight).toBeLessThan(0.07);
            const e = expectedBox('tl', box.width, box.height);
            const strip = await sharp(frame)
                .extract({
                    left: 0,
                    top: e.bottom - chipH,
                    width: box.width,
                    height: chipH,
                })
                .raw()
                .toBuffer({ resolveWithObject: true });
            expect(countBright(strip.data, strip.info.channels)).toBeGreaterThan(50);
        } finally {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }, 60_000);

    /**
     * BUG 2 REGRESSION GUARD — a wide logo, the shape that was reported
     * rendering off the LEFT edge (leading glyphs of the wordmark and all but
     * the last character of the badge missing). The ink-box assertion is the
     * automated form of "nothing escaped the padded box".
     */
    it('WIDE logo + badge: nothing escapes the padded box on the left (or any edge)', async () => {
        const dir = await fs.mkdtemp(join(tmpdir(), 'topshelf-overlay-'));
        try {
            const src = await generateTestSource(dir, LAVFI_BLACK);
            const logo = join(dir, 'logo-wide.png');
            // ~5:1 — the Picard shape.
            await makeLogo(logo, { width: 2000, height: 400, lines: ['PICARD WORDMARK'] });

            const content = join(dir, 'content-wide.png');
            await composeLogoWithBadge(await fs.readFile(logo), 'S01E01', content, BOX);
            await keepArtifact(content);
            const meta = await sharp(content).metadata();
            expect(meta.width).toBe(BOX.boxW);
            expect(meta.height).toBe(BOX.boxH);

            const out = join(dir, 'out-wide.mp4');
            await spawnFFmpegSafely({
                args: await overlayArgs(src, content, out, 'tl'),
                timeout: 120_000,
                context: { operation: 'topshelf-overlay-frame-wide' },
            });

            const frame = await extractFrame(out, join(dir, 'frame-wide.png'));
            const box = await inkBox(frame);
            expect(box.width).toBe(BASE_WIDTH);
            expectInkInsideBox(box, 'tl');
            // Specifically: the leading glyphs are present — ink starts at the
            // padded inset, not at (or beyond) the frame edge.
            const e = expectedBox('tl', box.width, box.height);
            expect(box.minX).toBeGreaterThanOrEqual(e.left - 4);
        } finally {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }, 60_000);

    it('anchors the box at the far edges for a bottom-right corner too', async () => {
        const dir = await fs.mkdtemp(join(tmpdir(), 'topshelf-overlay-'));
        try {
            const src = await generateTestSource(dir, LAVFI_BLACK);
            const logo = join(dir, 'logo-br.png');
            await makeLogo(logo, { width: 1200, height: 500, lines: ['STAR HARBOR', 'PICARD'] });

            const content = join(dir, 'content-br.png');
            // The content block hugs the box's bottom-right edges for a `br`
            // corner, so the burn sits AT the frame corner instead of floating
            // by however much the logo's aspect leaves over inside the box.
            await composeLogoWithBadge(await fs.readFile(logo), 'S02E07', content, BOX, 'br');
            await keepArtifact(content);

            const out = join(dir, 'out-br.mp4');
            await spawnFFmpegSafely({
                args: await overlayArgs(src, content, out, 'br'),
                timeout: 120_000,
                context: { operation: 'topshelf-overlay-frame-br' },
            });

            const box = await inkBox(await extractFrame(out, join(dir, 'frame-br.png')));
            expect(box.width).toBe(BASE_WIDTH);
            expectInkInsideBox(box, 'br');
        } finally {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }, 60_000);

    it('every logo aspect ratio composites to EXACTLY the box, ink included', async () => {
        const dir = await fs.mkdtemp(join(tmpdir(), 'topshelf-overlay-'));
        try {
            // 0.5:1 (portrait) through 14:1 (banner) — the old canvas was
            // `max(logoW, chipW) x (logoH + gap + chipH)`, so its aspect (and
            // therefore its on-frame height, once ffmpeg sized it by width)
            // was whatever the input happened to be.
            for (const aspect of [0.5, 1, 2, 5, 14]) {
                const logo = join(dir, `logo-${aspect}.png`);
                await makeLogo(logo, {
                    width: Math.round(600 * aspect),
                    height: 600,
                    lines: ['LOGO'],
                });
                for (const badge of ['S01E01', null]) {
                    const content = join(dir, `content-${aspect}-${badge ?? 'none'}.png`);
                    await composeLogoWithBadge(await fs.readFile(logo), badge, content, BOX);
                    const meta = await sharp(content).metadata();
                    expect(meta.width).toBe(BOX.boxW);
                    expect(meta.height).toBe(BOX.boxH);
                    // `fit: 'inside'` bounds BOTH axes, so the drawn ink is
                    // inside the canvas with no negative offset anywhere.
                    const trimmed = await sharp(content)
                        .trim({ threshold: 1 })
                        .toBuffer({ resolveWithObject: true });
                    expect(Math.abs(trimmed.info.trimOffsetLeft!)).toBeGreaterThanOrEqual(0);
                    expect(
                        Math.abs(trimmed.info.trimOffsetLeft!) + trimmed.info.width,
                    ).toBeLessThanOrEqual(BOX.boxW);
                    expect(
                        Math.abs(trimmed.info.trimOffsetTop!) + trimmed.info.height,
                    ).toBeLessThanOrEqual(BOX.boxH);
                }
            }
        } finally {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }, 60_000);

    it('long fallback TEXT shrinks to fit and stays fully inside the padded box', async () => {
        const dir = await fs.mkdtemp(join(tmpdir(), 'topshelf-overlay-'));
        try {
            const src = await generateTestSource(dir, LAVFI_BLACK);
            const content = join(dir, 'content-long.png');
            await renderTextPng(
                'S01E02 · A Very Long Episode Title That Must Ellipsize',
                content,
                BOX,
            );
            await keepArtifact(content);

            // The content PNG is exactly the box, and its ink fits inside with
            // a margin on BOTH sides — the clipping regression guard.
            const canvas = await sharp(content).metadata();
            expect(canvas.width).toBe(BOX.boxW);
            expect(canvas.height).toBe(BOX.boxH);
            const textInk = await sharp(content)
                .trim({ threshold: 1 })
                .toBuffer({ resolveWithObject: true });
            expect(textInk.info.trimOffsetLeft).toBeDefined();
            const inkLeft = Math.abs(textInk.info.trimOffsetLeft!);
            expect(inkLeft).toBeGreaterThan(0); // left stroke not cut by x=0
            expect(inkLeft + textInk.info.width).toBeLessThanOrEqual(BOX.boxW);
            expect(textInk.info.height).toBeLessThanOrEqual(BOX.boxH);

            const out = join(dir, 'out-text-long.mp4');
            await spawnFFmpegSafely({
                args: await overlayArgs(src, content, out, 'tl'),
                timeout: 120_000,
                context: { operation: 'topshelf-overlay-frame-text' },
            });

            const frame = await extractFrame(out, join(dir, 'frame-text-long.png'));
            const box = await inkBox(frame, 70);
            expect(box.width).toBe(BASE_WIDTH);
            expectInkInsideBox(box, 'tl');
        } finally {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }, 60_000);
});

/** Count pixels brighter than the ink threshold in a raw RGB(A) buffer. */
function countBright(data: Buffer, channels: number, threshold = 90): number {
    let n = 0;
    for (let i = 0; i + channels - 1 < data.length; i += channels) {
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum >= threshold) n++;
    }
    return n;
}
