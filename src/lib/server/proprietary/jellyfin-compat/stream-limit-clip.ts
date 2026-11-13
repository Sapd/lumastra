// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The "stream limit reached" explanation clip a /j client plays instead of the
 * real media when a Live TV provider's own concurrent-stream limit is already
 * used up (see `NoticeKind`).
 *
 * Rendered ONCE per (kind, language, count, layout revision) — never per request — and
 * cached on disk:
 *
 * 1. sharp/librsvg rasterises one 1280x720 frame from an SVG (logo + text). The
 *    runtime image ships fontconfig + fonts-dejavu-core for exactly this (the
 *    Top Shelf overlays render text the same way), so no ffmpeg `drawtext`
 *    font path is needed.
 * 2. The bundled jellyfin-ffmpeg loops that frame with a silent stereo track into
 *    an H.264 (Main, yuv420p) + AAC-LC MP4 with `+faststart` — the most widely
 *    playable shape there is, so clients that cannot transcode still play it.
 * 3. The MP4 is remuxed (stream copy) into a short VOD HLS (MPEG-TS, 2 s
 *    segments) for clients that only follow `TranscodingUrl`.
 *
 * ffmpeg is fetched at container start (not baked into the image), so a
 * build-time render is not possible; the first capped PlaybackInfo pays a few
 * seconds, every later one reads the cached files. Writes go to a temp dir that
 * is renamed into place, so two replicas sharing /config never see a half-written
 * clip.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { config } from '$lib/server/config';
import { spawnFFmpegSafely } from '$lib/server/utils/ffmpeg-spawn';
import { Logger } from '$lib/server/utils/logger';
import logoSvg from '../../../../../static/branding/lumastra-logo-horizontal-ondark.svg?raw';

const logger = Logger.for('JellyfinCompat:StreamLimitClip');

export type NoticeLanguage = 'en' | 'de';

/**
 * Which limit the clip explains. Only `livetv_source`: the Live TV provider's
 * own concurrent-stream limit (an IPTV account setting). There is no /j stream
 * cap of Lumastra's own.
 */
export type NoticeKind = 'livetv_source';

/** Bump when the layout or encode settings change — old caches are then ignored. */
const LAYOUT_REV = 3;

export const CLIP_DURATION_SECONDS = 15;
export const CLIP_WIDTH = 1280;
export const CLIP_HEIGHT = 720;
const FPS = 25;
const HLS_SEGMENT_SECONDS = 2;
const RENDER_TIMEOUT_MS = 60_000;

export const CLIP_MP4 = 'clip.mp4';
export const CLIP_PLAYLIST = 'clip.m3u8';

const NUMBER_WORDS: Record<NoticeLanguage, string[]> = {
    en: ['', 'One', 'Two', 'Three', 'Four', 'Five'],
    de: ['', 'Ein', 'Zwei', 'Drei', 'Vier', 'Fünf'],
};

export interface NoticeText {
    /** Short title, used as the MediaSource name. */
    title: string;
    paragraphs: string[];
    /** Small grey line at the bottom; omitted when empty. */
    footer: string;
}

function liveTvSourceText(lang: NoticeLanguage, limit: number): NoticeText {
    const word = (NUMBER_WORDS[lang][limit] ?? String(limit)).toLowerCase();
    if (lang === 'de') {
        return {
            title: 'Alle TV-Streams belegt',
            paragraphs: [
                limit === 1
                    ? 'Der TV-Anbieter erlaubt einen Sender gleichzeitig, und der ist gerade belegt.'
                    : limit === 2
                      ? 'Der TV-Anbieter erlaubt zwei Sender gleichzeitig, und beide sind gerade belegt.'
                      : `Der TV-Anbieter erlaubt ${word} Sender gleichzeitig, und alle sind gerade belegt.`,
                'Ein Sender, der schon läuft, lässt sich trotzdem einschalten.',
                'Beende einen anderen Live-TV-Stream oder versuch es in einer Minute noch einmal.',
            ],
            footer: '',
        };
    }
    return {
        title: 'All TV streams in use',
        paragraphs: [
            limit === 1
                ? 'The TV provider allows one channel at a time, and it is in use right now.'
                : limit === 2
                  ? 'The TV provider allows two channels at a time, and both are in use right now.'
                  : `The TV provider allows ${word} channels at a time, and all of them are in use right now.`,
            'You can still watch a channel that is already playing.',
            'Stop another Live TV stream, or try again in a minute.',
        ],
        footer: '',
    };
}

/**
 * The on-screen text. Calm and factual — an explanation, not an ad.
 * `count` is the provider's stream limit.
 */
export function noticeText(_kind: NoticeKind, lang: NoticeLanguage, count: number): NoticeText {
    return liveTvSourceText(lang, count);
}

function escapeXml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function wrapGreedy(words: string[], maxChars: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (next.length > maxChars && line) {
            lines.push(line);
            line = word;
        } else {
            line = next;
        }
    }
    if (line) lines.push(line);
    return lines;
}

/**
 * Balanced word wrap by an average-advance estimate (DejaVu Sans averages
 * ~0.55 em per glyph; the limit leaves margin for a line of wide glyphs). Uses
 * as few lines as a greedy wrap would, but evens their lengths, so a paragraph
 * never ends on a lone orphaned word or two.
 */
export function wrapText(text: string, maxChars: number): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const greedy = wrapGreedy(words, maxChars);
    if (greedy.length <= 1) return greedy;
    for (let width = Math.ceil(text.length / greedy.length); width < maxChars; width++) {
        const balanced = wrapGreedy(words, width);
        if (balanced.length === greedy.length) return balanced;
    }
    return greedy;
}

const LOGO_W = 360;
// Logo viewBox is 7326.9 x 1623.6 → ~4.51:1.
const LOGO_H = Math.round(LOGO_W / 4.513);
const LOGO_TOP = 92;
const TEXT_TOP = LOGO_TOP + LOGO_H + 70;
/** Body text must end above this line; the footer sits below it. */
export const TEXT_BOTTOM = CLIP_HEIGHT - 90;
export const FOOTER_BASELINE = CLIP_HEIGHT - 52;
const FONT_MAX_PX = 34;
const FONT_MIN_PX = 24;
/** Line length that fits the safe area at FONT_MAX_PX; scales inversely with the size. */
const MAX_CHARS_AT_MAX = 58;

export interface NoticeLayout {
    fontPx: number;
    /** Body lines with their baseline y. */
    lines: { text: string; y: number }[];
}

/**
 * Body text layout: the largest font size in [24, 34] px at which the wrapped
 * paragraphs fit between the logo and the footer, centred in that space.
 * German runs ~25% longer than English, so it gets a smaller size rather than
 * running into the footer. Exported for tests.
 */
export function layoutNoticeText(paragraphs: string[]): NoticeLayout {
    const available = TEXT_BOTTOM - TEXT_TOP;
    let chosen: { fontPx: number; blocks: string[][]; height: number } | null = null;
    for (let fontPx = FONT_MAX_PX; fontPx >= FONT_MIN_PX; fontPx--) {
        const maxChars = Math.floor((MAX_CHARS_AT_MAX * FONT_MAX_PX) / fontPx);
        const blocks = paragraphs.map((p) => wrapText(p, maxChars));
        const lineCount = blocks.reduce((n, b) => n + b.length, 0);
        const height =
            lineCount * Math.round(fontPx * 1.38) + (blocks.length - 1) * Math.round(fontPx * 0.55);
        chosen = { fontPx, blocks, height };
        if (height <= available) break;
    }
    const { fontPx, blocks, height } = chosen!;
    const lineGap = Math.round(fontPx * 1.38);
    const paraGap = Math.round(fontPx * 0.55);
    let y = TEXT_TOP + Math.max(0, Math.round((available - height) / 2)) + fontPx;
    const lines: { text: string; y: number }[] = [];
    for (const block of blocks) {
        for (const ln of block) {
            lines.push({ text: ln, y });
            y += lineGap;
        }
        y += paraGap;
    }
    return { fontPx, lines };
}

/** The SVG for the single frame. Exported for tests. */
export function buildNoticeSvg(text: NoticeText): string {
    const logoDataUri = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}`;
    const { fontPx, lines } = layoutNoticeText(text.paragraphs);
    const tspans = lines.map(
        (l) => `<text x="${CLIP_WIDTH / 2}" y="${l.y}" class="body">${escapeXml(l.text)}</text>`,
    );

    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${CLIP_WIDTH}" height="${CLIP_HEIGHT}" viewBox="0 0 ${CLIP_WIDTH} ${CLIP_HEIGHT}">
<style>
.body { font-family: 'DejaVu Sans', sans-serif; font-size: ${fontPx}px; fill: #e8ebf2; text-anchor: middle; }
.foot { font-family: 'DejaVu Sans', sans-serif; font-size: 22px; fill: #8c93a3; text-anchor: middle; }
</style>
<rect width="100%" height="100%" fill="#0d1017"/>
<image x="${(CLIP_WIDTH - LOGO_W) / 2}" y="${LOGO_TOP}" width="${LOGO_W}" height="${LOGO_H}" href="${logoDataUri}" xlink:href="${logoDataUri}"/>
${tspans.join('\n')}
${text.footer ? `<text x="${CLIP_WIDTH / 2}" y="${FOOTER_BASELINE}" class="foot">${escapeXml(text.footer)}</text>` : ''}
</svg>`;
}

/**
 * Cache root. `/config/cache/...` in the container (the PREVIEW_CACHE_DIR
 * parent, so it lives on the persisted config volume); falls back to the OS temp
 * dir when that is not writable (local dev, tests).
 */
async function resolveCacheRoot(): Promise<string> {
    const preferred = join(dirname(config.PREVIEW_CACHE_DIR), 'stream-limit-notice');
    try {
        await fs.mkdir(preferred, { recursive: true });
        await fs.access(preferred, fs.constants.W_OK);
        return preferred;
    } catch {
        return prepareFallbackCacheRoot(tmpdir());
    }
}

/**
 * A shared tmpdir lets another local user pre-create the cache dir (and plant
 * clips or symlinks in it). Use a per-uid name, create it 0700 and only accept
 * it when it is a real directory we own that nobody else can write; otherwise
 * take a fresh mkdtemp dir.
 */
export async function prepareFallbackCacheRoot(base: string): Promise<string> {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const dir = join(base, `lumastra-stream-limit-notice-${uid ?? 'u'}`);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const st = await fs.lstat(dir);
    const owned = uid === undefined || st.uid === uid;
    if (st.isDirectory() && owned && (st.mode & 0o022) === 0) return dir;
    return fs.mkdtemp(join(base, 'lumastra-stream-limit-notice-'));
}

function clipKey(kind: NoticeKind, lang: NoticeLanguage, cap: number): string {
    const text = noticeText(kind, lang, cap);
    return createHash('sha256')
        .update(JSON.stringify({ LAYOUT_REV, kind, lang, cap, text, CLIP_DURATION_SECONDS }))
        .digest('hex')
        .slice(0, 16);
}

export interface StreamLimitClip {
    dir: string;
    mp4Path: string;
    playlistPath: string;
    mp4Bytes: number;
}

async function readClip(dir: string): Promise<StreamLimitClip | null> {
    try {
        const mp4Path = join(dir, CLIP_MP4);
        const playlistPath = join(dir, CLIP_PLAYLIST);
        const [mp4, pl] = await Promise.all([fs.stat(mp4Path), fs.stat(playlistPath)]);
        if (mp4.size <= 0 || pl.size <= 0) return null;
        return { dir, mp4Path, playlistPath, mp4Bytes: mp4.size };
    } catch {
        return null;
    }
}

async function renderClip(
    kind: NoticeKind,
    lang: NoticeLanguage,
    cap: number,
    finalDir: string,
): Promise<void> {
    const work = `${finalDir}.tmp-${randomUUID()}`;
    await fs.mkdir(work, { recursive: true });
    try {
        const framePath = join(work, 'frame.png');
        await sharp(Buffer.from(buildNoticeSvg(noticeText(kind, lang, cap))))
            .png()
            .toFile(framePath);

        await spawnFFmpegSafely({
            args: [
                '-hide_banner',
                '-y',
                '-loop',
                '1',
                '-framerate',
                String(FPS),
                '-i',
                framePath,
                '-f',
                'lavfi',
                '-i',
                'anullsrc=channel_layout=stereo:sample_rate=48000',
                '-t',
                String(CLIP_DURATION_SECONDS),
                '-vf',
                'fade=t=in:st=0:d=0.6,format=yuv420p',
                '-c:v',
                'libx264',
                '-preset',
                'veryfast',
                '-tune',
                'stillimage',
                '-profile:v',
                'main',
                '-level:v',
                '3.1',
                '-g',
                String(FPS * HLS_SEGMENT_SECONDS),
                '-keyint_min',
                String(FPS * HLS_SEGMENT_SECONDS),
                '-sc_threshold',
                '0',
                '-c:a',
                'aac',
                '-b:a',
                '96k',
                '-ac',
                '2',
                '-movflags',
                '+faststart',
                '-metadata',
                `title=${noticeText(kind, lang, cap).title}`,
                join(work, CLIP_MP4),
            ],
            timeout: RENDER_TIMEOUT_MS,
            context: { operation: 'stream-limit-clip', kind, lang, cap },
        });

        await spawnFFmpegSafely({
            args: [
                '-hide_banner',
                '-y',
                '-i',
                join(work, CLIP_MP4),
                '-c',
                'copy',
                '-f',
                'hls',
                '-hls_time',
                String(HLS_SEGMENT_SECONDS),
                '-hls_playlist_type',
                'vod',
                '-hls_segment_type',
                'mpegts',
                '-hls_segment_filename',
                join(work, 'seg-%03d.ts'),
                join(work, CLIP_PLAYLIST),
            ],
            timeout: RENDER_TIMEOUT_MS,
            context: { operation: 'stream-limit-clip-hls', kind, lang, cap },
        });

        await fs.rm(framePath, { force: true });
        try {
            await fs.rename(work, finalDir);
        } catch (err) {
            // Another replica (shared /config) finished first — theirs is as good.
            if ((await readClip(finalDir)) === null) throw err;
            await fs.rm(work, { recursive: true, force: true });
        }
    } catch (err) {
        await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
        throw err;
    }
}

/**
 * Drop clips this one supersedes: the same kind, language and count rendered
 * from an older layout revision or text (`<kind>-<lang>-<count>-<16 hex>`), and
 * the pre-kind `<lang>-<16 hex>` names of the first release. Clips for another
 * count stay — two Live TV sources with different limits each keep theirs.
 * In-flight `.tmp-` dirs of another replica are never touched. Best effort.
 */
async function removeSupersededClips(root: string, prefix: string, current: string): Promise<void> {
    try {
        const legacy = /^(en|de)-[0-9a-f]{16}$/;
        for (const name of await fs.readdir(root)) {
            const path = join(root, name);
            if (path === current) continue;
            const sameSlot =
                name.startsWith(prefix) && /^[0-9a-f]{16}$/.test(name.slice(prefix.length));
            // `jellyfin_cap-*`: clips of the removed free-tier /j cap.
            if (sameSlot || legacy.test(name) || name.startsWith('jellyfin_cap-')) {
                await fs.rm(path, { recursive: true, force: true });
            }
        }
    } catch {
        // A stale clip only costs ~300 KB of disk.
    }
}

const inflight = new Map<string, Promise<StreamLimitClip>>();

/**
 * The cached clip for this language and cap, rendering it on first use. Single
 * flight per process. Rejects when ffmpeg is missing or the render fails — the
 * caller falls back to a plain Jellyfin error response.
 */
export function ensureStreamLimitClip(
    kind: NoticeKind,
    lang: NoticeLanguage,
    cap: number,
): Promise<StreamLimitClip> {
    const key = clipKey(kind, lang, cap);
    const running = inflight.get(key);
    if (running) return running;

    const job = (async () => {
        const root = await resolveCacheRoot();
        const prefix = `${kind}-${lang}-${cap}-`;
        const dir = join(root, `${prefix}${key}`);
        const cached = await readClip(dir);
        if (cached) return cached;
        const started = Date.now();
        await renderClip(kind, lang, cap, dir);
        const clip = await readClip(dir);
        if (!clip) throw new Error('stream-limit clip render produced no output');
        await removeSupersededClips(root, prefix, dir);
        logger.info('Rendered stream-limit clip', {
            kind,
            lang,
            cap,
            dir,
            bytes: clip.mp4Bytes,
            ms: Date.now() - started,
        });
        return clip;
    })();
    inflight.set(key, job);
    // Only the render is shared; once settled, the next call re-checks the disk
    // (two stats), so a failure retries and a cleared cache re-renders.
    job.then(
        () => inflight.delete(key),
        () => inflight.delete(key),
    );
    return job;
}

/** Test seam. */
export function __resetStreamLimitClipForTests(): void {
    inflight.clear();
}
