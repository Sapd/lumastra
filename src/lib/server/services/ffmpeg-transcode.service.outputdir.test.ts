// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for resolveOutputBaseDir — the pure helper that lets a caller
 * (the preview cache) pin FFmpeg's generation-0 output to an exact directory
 * instead of the derived per-session dir under FFMPEG_TRANSCODE_DIR.
 *
 * The traversal tests below are the C1 backstop guard (security review 3,
 * 2026-09-15): `resolveOutputBaseDir` is the SECOND, independent guard behind
 * startHlsPlayback's charset validation — a `playSessionId` containing `..`
 * must never produce a path outside `config.FFMPEG_TRANSCODE_DIR`, regardless
 * of whether the calling route validated its input. RED before this fix:
 * `path.join` normalizes `..` rather than rejecting it, so
 * `resolveOutputBaseDir({ playSessionId: '../x' })` returned
 * `/tmp/x` (outside `/tmp/lumastra-transcode`) instead of throwing.
 *
 * The `.` / `''` tests below are fix-round-1 findings (reviewer, 2026-09-16):
 * `isPathInsideDirectory` treats an EQUAL path as "inside" (correct for a
 * file-containment check, wrong here), and `path.join(base, '.')` /
 * `path.join(base, '')` both yield `base` itself — so
 * `resolveOutputBaseDir({ playSessionId: '.' })` returned
 * `FFMPEG_TRANSCODE_DIR` unchanged instead of throwing. Through
 * `getSessionOutputDir` -> `deleteOutputDirectory` -> `fs.rm(dir, {
 * recursive: true, force: true })` that would recursively wipe the shared
 * transcode root — every live session for every user — not just escape it.
 */

import { describe, it, expect } from 'vitest';
import { resolveOutputBaseDir } from './ffmpeg-transcode.service.js';

describe('resolveOutputBaseDir', () => {
    it('uses jobConfig.outputDir when provided', () => {
        expect(
            resolveOutputBaseDir({
                playSessionId: 'preview-x',
                outputDir: '/cache/aa/bb',
            } as never),
        ).toBe('/cache/aa/bb');
    });

    it('falls back to the derived session dir otherwise', () => {
        const d = resolveOutputBaseDir({ playSessionId: 'preview-x' } as never);
        expect(d).toContain('preview-x');
    });

    it('throws when playSessionId escapes FFMPEG_TRANSCODE_DIR via ..', () => {
        expect(() => resolveOutputBaseDir({ playSessionId: '../x' } as never)).toThrow(
            /escapes FFMPEG_TRANSCODE_DIR/,
        );
    });

    it('throws when playSessionId is a deeper traversal (../../app)', () => {
        expect(() => resolveOutputBaseDir({ playSessionId: '../../app' } as never)).toThrow(
            /escapes FFMPEG_TRANSCODE_DIR/,
        );
    });

    it('throws when playSessionId is "." (would resolve to the transcode root itself)', () => {
        expect(() => resolveOutputBaseDir({ playSessionId: '.' } as never)).toThrow(
            /escapes FFMPEG_TRANSCODE_DIR/,
        );
    });

    it('throws when playSessionId is "" (would resolve to the transcode root itself)', () => {
        expect(() => resolveOutputBaseDir({ playSessionId: '' } as never)).toThrow(
            /escapes FFMPEG_TRANSCODE_DIR/,
        );
    });

    it('does not throw for an ordinary session id', () => {
        expect(() => resolveOutputBaseDir({ playSessionId: 'preview-x' } as never)).not.toThrow();
    });
});
