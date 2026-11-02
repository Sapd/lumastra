// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Embedded attachments (Matroska fonts) for Jellyfin clients — Jellyfin's
 * `MediaSource.MediaAttachments` and `GET /Videos/{id}/{mediaSourceId}/Attachments/{index}`.
 *
 * ASS/SSA subtitles name their fonts; a release that styles them ships the
 * fonts as Matroska attachments. A client rendering ASS itself (JASSUB in
 * jellyfin-web, libass in mpv-based apps) reads `MediaAttachments` from
 * PlaybackInfo and fetches each font by its `DeliveryUrl`. Without them it
 * falls back to a default font and the typesetting breaks.
 *
 * Attachments are not in media_streams (the scanner records audio, video and
 * subtitle streams only), so they are listed with ffprobe and extracted with
 * `ffmpeg -dump_attachment`, both cached in memory:
 *   - the listing per (path, size, mtime): an ffprobe of the Matroska header;
 *   - extracted bytes in a small LRU — a font is fetched once per playback.
 *
 * Differences from Jellyfin, on purpose:
 *   - PlaybackInfo lists attachments only for Matroska sources that carry an
 *     ASS/SSA subtitle track — the only case a client uses them — so other
 *     sources never pay for the probe. Jellyfin lists them for every source
 *     (it probes at scan time).
 *   - Jellyfin extracts to a disk cache; ours is in memory and bounded.
 *   - `DeliveryUrl` carries `api_key`: Jellyfin's attachment route is
 *     anonymous, ours is authenticated like every other /j stream route.
 */

import { stat, readFile, unlink, mkdtemp, rmdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger';
import { LRUCache } from '$lib/server/cache/lru-cache.js';
import { AsyncSemaphore } from '$lib/server/utils/async-semaphore.js';
import { spawnFFmpegSafely } from '$lib/server/utils/ffmpeg-spawn.js';
import { ffprobeLibraryInputArgs } from '$lib/server/utils/library-input-guard.js';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver';
import { assertTranscodeInputIsMedia } from '$lib/server/services/transcoding/input-guard.js';
import { normalizeSubtitleCodec } from './subtitle-delivery';

const execFileAsync = promisify(execFile);
const logger = Logger.for('JellyfinCompat:VideoAttachments');

/** Jellyfin's `MediaAttachment` DTO. `Index` is the container stream index. */
export interface JellyfinMediaAttachment {
    Codec?: string | null;
    CodecTag?: string | null;
    Comment?: string | null;
    Index: number;
    FileName?: string | null;
    MimeType?: string | null;
    DeliveryUrl?: string | null;
}

export interface VideoAttachment {
    index: number;
    codec: string | null;
    codecTag: string | null;
    fileName: string | null;
    mimeType: string | null;
    comment: string | null;
}

/** Hard limit on one attachment probe (a Matroska header read). */
const PROBE_TIMEOUT_MS = 8_000;
/**
 * How long PlaybackInfo waits for a cold listing. PlaybackInfo is the first
 * call of every /j playback; on a slow (network / rclone) mount a cold probe
 * can take seconds. On a miss the source is listed without attachments and
 * the probe keeps running to warm the cache for the next PlaybackInfo.
 */
export const PLAYBACKINFO_ATTACHMENT_BUDGET_MS = 1_500;
/** Concurrent attachment probes per replica. */
const probeSlots = new AsyncSemaphore(4);
/** A failed probe is not retried on every PlaybackInfo for this long. */
const FAILED_PROBE_TTL_MS = 10 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 30_000;
/** Largest attachment served. Full CJK fonts run to ~20 MB. */
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
/**
 * Larger attachments are served but not kept in memory: the LRU bounds the
 * entry count, so this bounds it to 32 × 2 MB. Typical fonts are well under it;
 * a big CJK font is re-extracted (a header read, not a full-file pass).
 */
const MAX_CACHED_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const CACHE_VERSION = 'v1';

const listingCache = new LRUCache<VideoAttachment[]>({
    maxSize: 500,
    defaultTTL: 6 * 60 * 60 * 1000,
    namespace: 'jf-attachment-list',
});
const bytesCache = new LRUCache<Buffer>({
    maxSize: 32,
    defaultTTL: 30 * 60 * 1000,
    namespace: 'jf-attachment-bytes',
});
const inflight = new Map<string, Promise<unknown>>();
const extractionSlots = new AsyncSemaphore(2);

/** Test hook. */
export function clearVideoAttachmentCaches(): void {
    listingCache.clear();
    bytesCache.clear();
    inflight.clear();
}

function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

async function fileKey(containerPath: string): Promise<string | null> {
    try {
        const s = await stat(containerPath);
        return `${CACHE_VERSION}:${containerPath}:${s.size}:${Math.floor(s.mtimeMs)}`;
    } catch {
        return null;
    }
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/** ffprobe's JSON for `-select_streams t` → our attachment list. */
export function parseAttachmentProbe(stdout: string): VideoAttachment[] {
    const parsed = JSON.parse(stdout) as { streams?: unknown };
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const out: VideoAttachment[] = [];
    for (const raw of streams) {
        if (!raw || typeof raw !== 'object') continue;
        const s = raw as Record<string, unknown>;
        if (typeof s.index !== 'number' || !Number.isInteger(s.index)) continue;
        const tags =
            s.tags && typeof s.tags === 'object' ? (s.tags as Record<string, unknown>) : {};
        const lowerTags = Object.fromEntries(
            Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]),
        );
        const codecTag = str(s.codec_tag_string);
        out.push({
            index: s.index,
            codec: str(s.codec_name),
            codecTag: codecTag && codecTag !== '[0][0][0][0]' ? codecTag : null,
            fileName: str(lowerTags.filename),
            mimeType: str(lowerTags.mimetype),
            comment: str(lowerTags.comment),
        });
    }
    return out;
}

/** The attachments in a media file (container path), cached. [] on probe failure. */
export async function listVideoAttachments(containerPath: string): Promise<VideoAttachment[]> {
    const key = await fileKey(containerPath);
    if (!key) return [];
    const cached = listingCache.get(key);
    if (cached) return cached;
    return once(`list:${key}`, async () => {
        await probeSlots.acquire();
        try {
            await assertTranscodeInputIsMedia({ localFilePath: containerPath });
            const { stdout } = await execFileAsync(
                config.FFPROBE_PATH,
                [
                    '-v',
                    'error',
                    '-select_streams',
                    't',
                    '-show_entries',
                    'stream=index,codec_name,codec_tag_string:stream_tags',
                    '-of',
                    'json',
                    ...(await ffprobeLibraryInputArgs()),
                    containerPath,
                ],
                { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
            );
            const list = parseAttachmentProbe(stdout);
            listingCache.set(key, list);
            return list;
        } catch (error) {
            logger.warn('Attachment probe failed', {
                path: containerPath,
                error: error instanceof Error ? error.message : String(error),
            });
            listingCache.set(key, [], FAILED_PROBE_TTL_MS);
            return [];
        } finally {
            probeSlots.release();
        }
    });
}

/**
 * The bytes of attachment stream `index` (container stream index), or null
 * when the file has no such attachment or it is over {@link MAX_ATTACHMENT_BYTES}.
 */
export async function extractVideoAttachment(
    containerPath: string,
    index: number,
): Promise<{ attachment: VideoAttachment; data: Buffer } | null> {
    const attachment = (await listVideoAttachments(containerPath)).find((a) => a.index === index);
    if (!attachment) return null;
    const key = `${(await fileKey(containerPath)) ?? containerPath}#${index}`;
    const cached = bytesCache.get(key);
    if (cached) return { attachment, data: cached };

    const data = await once(`bytes:${key}`, () =>
        extractionSlots.withPermit(() => dumpAttachment(containerPath, index)),
    );
    if (!data) return null;
    if (data.length <= MAX_CACHED_ATTACHMENT_BYTES) bytesCache.set(key, data);
    return { attachment, data };
}

async function dumpAttachment(containerPath: string, index: number): Promise<Buffer | null> {
    let dir: string;
    try {
        dir = await mkdtemp(join(tmpdir(), 'lumastra-attachment-'));
    } catch (error) {
        logger.warn('Could not create a temp dir for an attachment', { error: String(error) });
        return null;
    }
    const out = join(dir, 'attachment.bin');
    try {
        await assertTranscodeInputIsMedia({ localFilePath: containerPath });
        // Jellyfin's AttachmentExtractor: -dump_attachment needs an input and
        // an output to run, so a zero-length null output.
        await spawnFFmpegSafely({
            libraryInput: containerPath,
            args: [
                '-v',
                'error',
                `-dump_attachment:${index}`,
                out,
                '-i',
                containerPath,
                '-t',
                '0',
                '-f',
                'null',
                '-',
            ],
            timeout: EXTRACT_TIMEOUT_MS,
            context: { operation: 'attachment-extraction', index },
        }).catch((error: unknown) => {
            // ffmpeg can exit non-zero after writing the attachment (e.g. an
            // input it cannot fully decode); the file decides.
            logger.debug('ffmpeg exited with an error while dumping an attachment', {
                index,
                error: error instanceof Error ? error.message : String(error),
            });
        });
        const s = await stat(out).catch(() => null);
        if (!s || s.size === 0) return null;
        if (s.size > MAX_ATTACHMENT_BYTES) {
            logger.warn('Attachment over size limit', { index, sizeBytes: s.size });
            return null;
        }
        return await readFile(out);
    } catch (error) {
        // A refused input (playlist body) or an unreadable file: nothing to serve.
        logger.warn('Attachment extraction failed', {
            index,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    } finally {
        await unlink(out).catch(() => undefined);
        await rmdir(dir).catch(() => undefined);
    }
}

/** Font types an attachment may be served as; see attachmentContentType. */
const FONT_MIME_TYPES = new Set([
    'font/ttf',
    'font/otf',
    'font/sfnt',
    'font/collection',
    'font/woff',
    'font/woff2',
    'application/font-sfnt',
    'application/font-woff',
    'application/x-font-ttf',
    'application/x-font-otf',
    'application/x-font-opentype',
    'application/x-font-truetype',
    'application/x-truetype-font',
    'application/vnd.ms-opentype',
]);

/**
 * The attachment's own mimetype when it is a font type, else
 * application/octet-stream. Jellyfin passes any tag through; we don't: the
 * tag is written by whoever made the file, and a `text/html` attachment
 * would render as a page on our origin.
 */
export function attachmentContentType(attachment: VideoAttachment): string {
    const type = attachment.mimeType?.trim().toLowerCase() ?? '';
    return FONT_MIME_TYPES.has(type) ? type : 'application/octet-stream';
}

const MATROSKA_CONTAINERS = new Set(['mkv', 'mka', 'mks', 'webm', 'matroska']);

/** Whether a source is one a client would want fonts for (see module comment). */
export function wantsAttachments(
    container: string | null | undefined,
    subtitleCodecs: readonly (string | null | undefined)[],
): boolean {
    if (!MATROSKA_CONTAINERS.has((container ?? '').toLowerCase())) return false;
    return subtitleCodecs.some((c) => {
        const codec = normalizeSubtitleCodec(c);
        return codec === 'ass' || codec === 'ssa';
    });
}

/**
 * `MediaSource.MediaAttachments` for PlaybackInfo. Never throws: an
 * unreadable file or a failed probe lists nothing.
 */
/** `promise`'s value, or null when it has not settled within `ms` (it keeps running). */
async function withinBudget<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

export async function mediaAttachmentsForSource(
    sql: postgres.Sql,
    opts: {
        itemId: string;
        fileId: string;
        filePath: string;
        container: string | null | undefined;
        subtitleCodecs: readonly (string | null | undefined)[];
        apiKey: string;
    },
): Promise<JellyfinMediaAttachment[]> {
    if (!wantsAttachments(opts.container, opts.subtitleCodecs)) return [];
    try {
        const pathInfo = await resolveMediaPath(opts.filePath, { skipLocalAccessCheck: true }, sql);
        if (!pathInfo?.isAccessible) return [];
        const attachments = await withinBudget(
            listVideoAttachments(pathInfo.containerPath),
            PLAYBACKINFO_ATTACHMENT_BUDGET_MS,
        );
        if (attachments === null) {
            logger.debug('Attachment listing over the PlaybackInfo budget; listed without', {
                fileId: opts.fileId,
            });
            return [];
        }
        const query = opts.apiKey ? `?api_key=${encodeURIComponent(opts.apiKey)}` : '';
        return attachments.map((a) => ({
            Codec: a.codec,
            CodecTag: a.codecTag,
            Comment: a.comment,
            Index: a.index,
            FileName: a.fileName,
            MimeType: a.mimeType,
            DeliveryUrl: `/Videos/${opts.itemId}/${opts.fileId}/Attachments/${a.index}${query}`,
        }));
    } catch (error) {
        logger.warn('Could not list attachments', {
            fileId: opts.fileId,
            error: error instanceof Error ? error.message : String(error),
        });
        return [];
    }
}
