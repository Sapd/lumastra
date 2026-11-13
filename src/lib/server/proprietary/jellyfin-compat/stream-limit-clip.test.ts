// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Renders the real "stream limit reached" clip with the configured ffmpeg and
 * checks it is the shape every Jellyfin client can play: H.264 Main yuv420p +
 * AAC stereo MP4 of the advertised length, plus a VOD HLS of the same clip.
 * Skipped when no ffmpeg/ffprobe is on hand (CI and the remote runner have the
 * pinned jellyfin-ffmpeg).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '$lib/server/config';
import {
    CLIP_DURATION_SECONDS,
    FOOTER_BASELINE,
    TEXT_BOTTOM,
    buildNoticeSvg,
    layoutNoticeText,
    ensureStreamLimitClip,
    noticeText,
    prepareFallbackCacheRoot,
    wrapText,
} from './stream-limit-clip';

function probeBin(): string | null {
    const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
    try {
        execFileSync(ffprobe, ['-version'], { stdio: 'ignore' });
        execFileSync(config.FFMPEG_PATH, ['-version'], { stdio: 'ignore' });
        return ffprobe;
    } catch {
        return null;
    }
}

const ffprobe = probeBin();

describe('notice text', () => {
    it('explains a Live TV provider limit, in English and German', () => {
        const en = noticeText('livetv_source', 'en', 2);
        expect(en.title).toBe('All TV streams in use');
        expect(en.paragraphs[0]).toBe(
            'The TV provider allows two channels at a time, and both are in use right now.',
        );
        expect(en.footer).toBe('');
        expect(en.paragraphs.join(' ')).not.toMatch(/free tier|Supporter/);
        expect(noticeText('livetv_source', 'en', 1).paragraphs[0]).toContain('one channel');
        expect(noticeText('livetv_source', 'en', 3).paragraphs[0]).toContain('three channels');
        const de = noticeText('livetv_source', 'de', 2);
        expect(de.title).toBe('Alle TV-Streams belegt');
        expect(de.paragraphs[0]).toContain('beide sind gerade belegt');
        // No footer line in the frame when there is no footer text.
        expect(buildNoticeSvg(en)).not.toContain('class="foot"');
    });

    it('wraps text into lines no longer than the limit', () => {
        const lines = wrapText(noticeText('livetv_source', 'en', 2).paragraphs[0]!, 58);
        expect(lines.length).toBeGreaterThan(1);
        for (const l of lines) expect(l.length).toBeLessThanOrEqual(58);
    });

    it('keeps every body line above the footer, in both languages', () => {
        for (const [kind, lang, n] of [
            ['livetv_source', 'en', 2],
            ['livetv_source', 'de', 5],
        ] as const) {
            const { fontPx, lines } = layoutNoticeText(noticeText(kind, lang, n).paragraphs);
            const last = lines[lines.length - 1]!;
            // Baseline plus descender stays inside the text area.
            expect(last.y + Math.round(fontPx * 0.25)).toBeLessThanOrEqual(TEXT_BOTTOM);
            expect(TEXT_BOTTOM).toBeLessThan(FOOTER_BASELINE - 22);
            for (const l of lines) {
                // ~0.55 em per glyph must fit the 1280 px frame with margins.
                expect(l.text.length * fontPx * 0.55).toBeLessThan(1280 - 2 * 80);
            }
        }
        // English keeps the full size.
        expect(layoutNoticeText(noticeText('livetv_source', 'en', 2).paragraphs).fontPx).toBe(34);
    });

    it('escapes text into the SVG', () => {
        const svg = buildNoticeSvg({ title: 't', paragraphs: ['a < b & c'], footer: 'f' });
        expect(svg).toContain('a &lt; b &amp; c');
    });
});

describe.skipIf(!ffprobe)('rendered clip', () => {
    let dir: string;
    let mp4: string;

    beforeAll(async () => {
        // Keep the render out of /config: the PREVIEW_CACHE_DIR parent is the cache root.
        const root = await fs.mkdtemp(join(tmpdir(), 'clip-test-'));
        process.env.PREVIEW_CACHE_DIR = join(root, 'preview');
        const clip = await ensureStreamLimitClip('livetv_source', 'en', 2);
        dir = clip.dir;
        mp4 = clip.mp4Path;
    }, 120_000);

    it('is H.264 Main yuv420p + AAC stereo, as long as advertised', () => {
        const json = JSON.parse(
            execFileSync(ffprobe!, [
                '-v',
                'error',
                '-show_streams',
                '-show_format',
                '-of',
                'json',
                mp4,
            ]).toString(),
        ) as {
            streams: {
                codec_type: string;
                codec_name: string;
                profile?: string;
                pix_fmt?: string;
                width?: number;
                height?: number;
                channels?: number;
            }[];
            format: { duration: string; format_name: string };
        };
        const v = json.streams.find((s) => s.codec_type === 'video')!;
        const a = json.streams.find((s) => s.codec_type === 'audio')!;
        expect(v.codec_name).toBe('h264');
        expect(v.profile).toBe('Main');
        expect(v.pix_fmt).toBe('yuv420p');
        expect([v.width, v.height]).toEqual([1280, 720]);
        expect(a.codec_name).toBe('aac');
        expect(a.channels).toBe(2);
        expect(json.format.format_name).toContain('mp4');
        expect(Math.abs(Number(json.format.duration) - CLIP_DURATION_SECONDS)).toBeLessThan(0.5);
    });

    it('has a VOD HLS playlist with relative segments that exist', async () => {
        const playlist = await fs.readFile(join(dir, 'clip.m3u8'), 'utf8');
        expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
        expect(playlist).toContain('#EXT-X-ENDLIST');
        const segs = playlist.split('\n').filter((l) => l.endsWith('.ts'));
        expect(segs.length).toBeGreaterThanOrEqual(6);
        for (const s of segs) {
            expect(s).toMatch(/^seg-\d{3}\.ts$/);
            expect((await fs.stat(join(dir, s))).size).toBeGreaterThan(0);
        }
    });

    it('renders the German clip into its own cache entry', async () => {
        const de = await ensureStreamLimitClip('livetv_source', 'de', 2);
        expect(de.dir).not.toBe(dir);
        expect(de.mp4Bytes).toBeGreaterThan(10_000);
    }, 120_000);

    it('a provider with another limit gets its own clip; neither evicts the other', async () => {
        const live1 = await ensureStreamLimitClip('livetv_source', 'en', 1);
        expect(live1.dir).not.toBe(dir);
        expect(live1.dir).toContain('livetv_source-en-1-');
        expect((await fs.stat(live1.mp4Path)).size).toBeGreaterThan(0);
        expect((await fs.stat(mp4)).size).toBeGreaterThan(0);
    }, 120_000);

    it('is rendered once: a second call reuses the files', async () => {
        const before = (await fs.stat(mp4)).mtimeMs;
        const again = await ensureStreamLimitClip('livetv_source', 'en', 2);
        expect(again.mp4Path).toBe(mp4);
        expect((await fs.stat(mp4)).mtimeMs).toBe(before);
    });
});

describe('prepareFallbackCacheRoot', () => {
    it('creates a 0700 per-user dir and reuses it', async () => {
        const base = await fs.mkdtemp(join(tmpdir(), 'slc-base-'));
        try {
            const a = await prepareFallbackCacheRoot(base);
            expect((await fs.stat(a)).mode & 0o077).toBe(0);
            expect(await prepareFallbackCacheRoot(base)).toBe(a);
        } finally {
            await fs.rm(base, { recursive: true, force: true });
        }
    });

    it('does not use a pre-planted group/world-writable dir', async () => {
        const base = await fs.mkdtemp(join(tmpdir(), 'slc-base-'));
        try {
            const first = await prepareFallbackCacheRoot(base);
            await fs.chmod(first, 0o777);
            const second = await prepareFallbackCacheRoot(base);
            expect(second).not.toBe(first);
            expect((await fs.stat(second)).mode & 0o022).toBe(0);
        } finally {
            await fs.rm(base, { recursive: true, force: true });
        }
    });

    it('does not follow a planted symlink at the name', async () => {
        const base = await fs.mkdtemp(join(tmpdir(), 'slc-base-'));
        const elsewhere = await fs.mkdtemp(join(tmpdir(), 'slc-else-'));
        try {
            const first = await prepareFallbackCacheRoot(base);
            await fs.rm(first, { recursive: true });
            await fs.symlink(elsewhere, first);
            const dir = await prepareFallbackCacheRoot(base);
            expect(dir).not.toBe(first);
        } finally {
            await fs.rm(base, { recursive: true, force: true });
            await fs.rm(elsewhere, { recursive: true, force: true });
        }
    });
});
