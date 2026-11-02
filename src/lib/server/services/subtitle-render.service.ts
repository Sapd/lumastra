// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Server-side rendering of BITMAP subtitles (PGS and VobSub) to PNG cues.
 *
 * ## Why this exists
 *
 * A bitmap subtitle has historically had exactly two delivery options, both bad:
 * burn it into the video (`SubtitleMethod=Encode`), which forces a full re-encode
 * of an otherwise copyable stream purely to draw text — and on HDR costs either
 * the HDR or the GPU encoder, since `overlay` is a CPU filter — or ship the raw
 * `.sup` and make every client carry a PGS decoder.
 *
 * Rendering server-side removes both. Clients receive positioned PNGs plus timing
 * and composite them in their own overlay, so no client needs a subtitle decoder
 * and no video is re-encoded.
 *
 * ## Cost
 *
 * Rendering is not the expensive part and never was. Decode plus PNG encode for a
 * feature-length track is well under a second; the minutes a cold request takes
 * are FFmpeg reading through a 2h remux to reach the subtitle stream, which is
 * paid identically whether the result is copied or rendered. Both land in the
 * binary subtitle cache, so it is paid once.
 *
 * ## Timing
 *
 * Cue times are milliseconds on the PLAYER's timeline — what `currentTime` reads —
 * so a client positions an overlay directly against playback position with no
 * correction of its own. That timeline comes from the extractor: `-copyts` keeps
 * the container's timestamps instead of rebasing them to the first packet, and
 * `normalizeSupTimestamps` then removes the container's `start_time` so the cues
 * agree with a transcode that begins at PTS 0. For a container starting at zero
 * this is the same thing as source media time; for one that does not, it is not,
 * and the player timeline is the one that matters here.
 *
 * PGS reaches that timeline via `-copyts` plus an explicit start_time subtraction;
 * VobSub reaches it by omitting `-copyts` and letting FFmpeg subtract at mux time.
 * Same destination, two routes — see `ffmpeg-subtitle-extractor` for why.
 *
 * Cues are absolute over the whole title and never rebased per seek. (The HLS
 * WebVTT sidecar path once did rebase, which is what made resumed playback show
 * subtitles early; it no longer does, so both paths now agree.)
 */

import type postgres from 'postgres';

import { SubtitleRenderBudgetError } from './subtitle-render-protocol.js';
import { runSubtitleWorker } from './subtitle-render-worker.js';
import type { BundleManifest } from './subtitle-render-core.js';
import { Logger } from '../utils/logger.js';
import { resolveSubtitle } from './subtitle-resolver.service.js';
import { resolvePlaybackSelection } from '../database/queries/media-file-resolution.queries.js';
import { getStreamsForFile } from '../database/queries/media-streams.queries.js';
import { SubtitleFileCacheService } from './cache/subtitle-file-cache.service.js';
import { LRUCache } from '../cache/lru-cache.js';

const logger = Logger.for('SubtitleRender');

/** Container magic + version. Bump the digit if the layout ever changes. */
const BUNDLE_MAGIC = 'LSR1';

/** One drawable image within a cue, positioned on the canvas. */
export interface RenderedRect {
    x: number;
    y: number;
    w: number;
    h: number;
    /** Opaque id; fetch via the rendered-image route. */
    image: string;
}

export interface RenderedCue {
    startMs: number;
    endMs: number;
    rects: RenderedRect[];
}

export interface RenderedSubtitleManifest {
    /** Canvas the rect coordinates are relative to. */
    canvas: { w: number; h: number };
    /** Absolute source-media milliseconds, ascending, non-overlapping. */
    cues: RenderedCue[];
}

/** Manifest plus the PNG bytes it references. */
export interface RenderedSubtitle {
    manifest: RenderedSubtitleManifest;
    getImage(id: string): Buffer | null;
}

/**
 * Serialised form: magic(4) manifestLength(4 BE) manifest(JSON) images(concatenated).
 *
 * One blob rather than N cache files keeps this on the existing binary cache with
 * its `probed_at` invalidation and storage location, and makes the whole render atomic —
 * there is no state where the manifest is cached but some of its images are not.
 */
function unpackBundle(blob: Buffer): RenderedSubtitle | null {
    if (blob.length < 8 || blob.subarray(0, 4).toString('ascii') !== BUNDLE_MAGIC) {
        return null;
    }

    const jsonLength = blob.readUInt32BE(4);
    const jsonEnd = 8 + jsonLength;
    if (jsonEnd > blob.length) return null;

    let manifest: BundleManifest;
    try {
        manifest = JSON.parse(blob.subarray(8, jsonEnd).toString('utf-8')) as BundleManifest;
    } catch {
        return null;
    }
    if (!manifest?.index || !Array.isArray(manifest.cues)) return null;

    // A blob can be damaged by something other than the atomic write path — a
    // manual copy, a partial restore, filesystem corruption — and still carry
    // valid magic and parseable JSON. Without these checks such an entry is
    // served happily while every image 404s, and because each read touches the
    // file it never expires on its own.
    const canvasOk =
        Number.isFinite(manifest.canvas?.w) &&
        Number.isFinite(manifest.canvas?.h) &&
        manifest.canvas.w > 0 &&
        manifest.canvas.h > 0;
    if (!canvasOk) return null;

    const images = blob.subarray(jsonEnd);

    let covered = 0;
    for (const entry of Object.values(manifest.index)) {
        if (
            !Number.isSafeInteger(entry?.offset) ||
            !Number.isSafeInteger(entry?.length) ||
            entry.offset < 0 ||
            entry.length <= 0 ||
            entry.offset + entry.length > images.length
        ) {
            return null;
        }
        covered = Math.max(covered, entry.offset + entry.length);
    }
    if (covered !== images.length) return null;

    return {
        manifest: { canvas: manifest.canvas, cues: manifest.cues },
        getImage(id: string): Buffer | null {
            const entry = manifest.index[id];
            if (!entry) return null;
            const end = entry.offset + entry.length;
            if (end > images.length) return null;
            return images.subarray(entry.offset, end);
        },
    };
}

/** Codec substrings that mean VobSub rather than PGS. */
const VOBSUB_CODEC_HINTS = ['dvdsub', 'vobsub', 'dvd_subtitle'];

/**
 * Which binary container to ask the resolver for.
 *
 * Falls back to `pgssub` when the codec is unknown — an unprobed file has no
 * stream row to consult, and PGS is both the far more common bitmap format and
 * the one whose extraction previously worked on that path.
 */
async function resolveBinaryFormat(
    sql: postgres.Sql,
    fileId: string,
    streamIndex: number,
): Promise<'pgssub' | 'sub'> {
    try {
        const streams = await getStreamsForFile(sql, fileId);
        const codec = streams
            .find((row) => row.stream_type === 'subtitle' && row.stream_index === streamIndex)
            ?.codec?.toLowerCase();

        if (codec && VOBSUB_CODEC_HINTS.some((hint) => codec.includes(hint))) return 'sub';
    } catch {
        // Fall through to the PGS default.
    }
    return 'pgssub';
}

/**
 * The file's last probe time and path. The probe time invalidates a render made
 * from a file that has since been replaced; the path lets the cache find a render
 * stored alongside the media. Both null when the file cannot be resolved — the
 * caller then treats the cache as unvalidated rather than failing the request.
 */
async function getFileFacts(
    sql: postgres.Sql,
    mediaItemId: string,
    fileId: string,
): Promise<{ probedAt: Date | null; filePath: string | null }> {
    try {
        const selection = await resolvePlaybackSelection(sql, mediaItemId, { fileId });
        const file = selection.files[0];
        return { probedAt: file?.probed_at ?? null, filePath: file?.file_path ?? null };
    } catch {
        return { probedAt: null, filePath: null };
    }
}

/**
 * Unpacked bundles, kept hot for the length of a viewing.
 *
 * Each cue image is a separate request, so a feature film pulls ~1400 of them.
 * Without this, every one re-reads the whole multi-megabyte blob off disk and
 * re-parses its manifest just to slice out ~12 KB — tens of gigabytes of reads
 * per viewing, and enough resident memory under concurrency to be a denial of
 * service on its own. Small and short-lived: a handful of concurrent viewers,
 * dropped well before anyone watches the same film again.
 *
 * Sized for concurrent VIEWERS, not for a working set: the (N+1)th concurrent
 * bitmap-subtitle viewer evicts someone and turns every one of their image
 * requests back into a multi-megabyte blob read plus a manifest re-parse — the
 * exact amplification this exists to prevent, just past the limit.
 */
const hotBundles = new LRUCache<RenderedSubtitle>({
    maxSize: 16,
    defaultTTL: 30 * 60 * 1000,
    namespace: 'subtitle-render',
});

/**
 * Negative results, so a track whose bytes cannot render does not repeatedly
 * consume a worker slot on client retries.
 *
 * Only outcomes decided by the track's BYTES belong here — no cues, too many,
 * an unrecognised container. Budget failures remain retryable. A missing source does not: it is
 * what an extraction timeout looks like from here, and remembering it turned one
 * slow cold read into "this track has no subtitles" for ten minutes.
 */
const knownEmpty = new LRUCache<true>({
    maxSize: 64,
    defaultTTL: 10 * 60 * 1000,
    namespace: 'subtitle-render-empty',
});

/** In-flight renders, so concurrent requests share one decode+encode pass. */
const inflight = new Map<string, Promise<RenderedSubtitle | null>>();

/**
 * Drop the in-process caches, as a fresh process would see them.
 *
 * Exists for tests, which otherwise carry a hot bundle from one case into the
 * next and stop exercising the disk path at all.
 */
export function resetRenderedSubtitleCaches(): void {
    hotBundles.clear();
    knownEmpty.clear();
    inflight.clear();
}

/**
 * Resolve a bitmap subtitle track to rendered PNG cues, via the binary cache.
 *
 * Returns null when the track is absent, is not a bitmap format, or produced no
 * displayable cues.
 */
export async function getRenderedSubtitle(
    sql: postgres.Sql,
    mediaItemId: string,
    streamIndex: number,
    fileId: string,
): Promise<RenderedSubtitle | null> {
    const cacheKey = `${mediaItemId}:${fileId}:${streamIndex}`;

    // The disk cache is keyed on the FILE, not just the item. A multi-version
    // item (1080p BDRip alongside a 4K remux) has different streams under the
    // same index, and an item-only key would serve one version's render for the
    // other — which is exactly why the route makes fileId mandatory.
    const cacheId = `${mediaItemId}_${fileId}`;

    const hot = hotBundles.get(cacheKey);
    if (hot) return hot;

    if (knownEmpty.get(cacheKey)) return null;

    // Claim the key BEFORE the first await. The cache read is itself async, so
    // checking it first would let two concurrent cold requests both miss, both
    // find no in-flight entry, and both start a multi-minute FFmpeg extraction.
    const pending = inflight.get(cacheKey);
    if (pending) return pending;

    // Set once the source bytes are in hand: from there on, a null result is
    // a property of the track and safe to remember (see knownEmpty).
    let sourceObtained = false;

    const task = (async (): Promise<RenderedSubtitle | null> => {
        const started = Date.now();

        // probed_at gates the cache the same way it gates the .sup cache: when
        // the underlying file is replaced and re-scanned, a render made from the
        // old file must not survive. Without this the entry is not merely stale
        // for a while — every read touches the file, so the TTL sweep never
        // reaps it and the wrong subtitles persist indefinitely.
        const { probedAt, filePath } = await getFileFacts(sql, mediaItemId, fileId);

        const cached = await SubtitleFileCacheService.getBinary(
            cacheId,
            streamIndex,
            'render',
            probedAt,
            filePath,
        );
        if (cached) {
            const unpacked = unpackBundle(cached);
            if (unpacked) {
                logger.debug('Serving rendered subtitle from cache', { mediaItemId, streamIndex });
                hotBundles.set(cacheKey, unpacked);
                return unpacked;
            }
            logger.warn('Discarding unreadable rendered-subtitle cache entry', {
                mediaItemId,
                streamIndex,
            });
        }

        // Reuses the existing binary extraction, including its own .sup cache —
        // so a track already pulled for a raw-PGS client renders without touching
        // the media file again.
        // Name the binary format explicitly, from the track's own codec.
        //
        // Neither constant works on its own. Always asking `pgssub` forces a
        // `.sup` container even for VobSub, which FFmpeg's sup muxer cannot
        // write. But omitting the format entirely leaves the default `vtt`,
        // which is only codec-aware on the path where the stream row EXISTS —
        // when the file has not been probed, the resolver's fallback branch
        // keys off the requested format alone and sends a bitmap track down the
        // TEXT extraction path, burning a full pass over the container to
        // return nothing.
        const format = await resolveBinaryFormat(sql, fileId, streamIndex);
        const source = await resolveSubtitle(sql, mediaItemId, streamIndex, { fileId, format });

        if (!source || !Buffer.isBuffer(source.content)) {
            logger.debug('No bitmap subtitle to render', { mediaItemId, streamIndex });
            return null;
        }
        sourceObtained = true;

        const blob = await runSubtitleWorker(source.content);
        if (!blob) return null;
        const unpacked = unpackBundle(blob);
        if (!unpacked) return null;
        await SubtitleFileCacheService.setBinary(
            cacheId,
            streamIndex,
            'render',
            blob,
            filePath,
        ).catch((err: unknown) => {
            // A cache write failure must not fail the request — the caller
            // already has a perfectly good render in hand.
            logger.warn('Failed to cache rendered subtitle', {
                mediaItemId,
                streamIndex,
                error: err instanceof Error ? err.message : String(err),
            });
        });

        logger.info('Rendered bitmap subtitle', {
            mediaItemId,
            streamIndex,
            cues: unpacked.manifest.cues.length,
            sourceBytes: source.content.length,
            renderedBytes: blob.length,
            ms: Date.now() - started,
        });

        hotBundles.set(cacheKey, unpacked);
        return unpacked;
    })()
        .then((result) => {
            if (!result && sourceObtained) knownEmpty.set(cacheKey, true);
            return result;
        })
        .catch((error: unknown) => {
            // Worker/queue failures are transient. Only a null byte-decided
            // result above belongs in knownEmpty; overload must allow retries.
            if (error instanceof SubtitleRenderBudgetError) {
                logger.warn('Bitmap subtitle render budget exceeded', {
                    mediaItemId,
                    streamIndex,
                    ...error.counts,
                });
                return null;
            }
            logger.warn('Rendering bitmap subtitle failed', {
                mediaItemId,
                streamIndex,
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        })
        .finally(() => {
            inflight.delete(cacheKey);
        });

    inflight.set(cacheKey, task);
    return task;
}
