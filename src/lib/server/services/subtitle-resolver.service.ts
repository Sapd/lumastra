// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subtitle Resolver Service
 *
 * Resolves and serves subtitles from local media files.
 * Lumastra-only mode — no Jellyfin backend dependency.
 *
 * Resolution strategy:
 * 1. Query media_streams to find the subtitle stream at the requested index
 * 2. External subtitle files (.srt/.ass/.vtt) — read from disk
 * 3. Embedded text subtitles (subrip, ass, webvtt) — extract via FFmpeg stdout
 * 4. Embedded bitmap subtitles (PGS/VobSub) — extract via FFmpeg temp file as binary
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { safeExists } from '$lib/server/utils/safe-fs.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isPathWithinMediaStore } from '$lib/server/utils/media-path-resolver.js';
import {
    getStreamsForFile,
    getStreamsForMediaItem,
    type MediaStreamRow,
} from '$lib/server/database/queries/media-streams.queries.js';
import {
    getFilesForMediaItem,
    type MediaFileRow,
} from '$lib/server/database/queries/media-files.queries.js';
import {
    getExternalSubtitlesForFile,
    getExternalSubtitlesForMediaItem,
} from '$lib/server/database/queries/external-subtitles.queries.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import {
    externalSubtitlePosition,
    isExternalSubtitleStreamIndex,
    pairExternalStreamRowsWithSidecars,
} from '$lib/server/utils/external-subtitle-index.js';
import {
    extractSubtitleStream,
    extractSubtitleStreamBinary,
    extractSubtitleStreamsBinary,
    FFmpegTimeoutError,
} from '$lib/server/utils/ffmpeg-subtitle-extractor.js';
import { MAX_SIDECAR_TEXT_BYTES } from '$lib/server/utils/sidecar-text.js';
import { readContainedFile, resolveContainedFile } from '$lib/server/utils/contained-fs.js';
import { LRUCache } from '$lib/server/cache/lru-cache.js';
import { SubtitleFileCacheService } from './cache/subtitle-file-cache.service.js';
import type postgres from 'postgres';

const logger = Logger.for('SubtitleResolver');

/** Maximum external subtitle file size; shared with every other sidecar text reader */
const MAX_SUBTITLE_FILE_SIZE = MAX_SIDECAR_TEXT_BYTES;

/** LRU cache for extracted subtitle content — string for text, Buffer for binary (30min TTL, max 100 entries) */
const subtitleCache = new LRUCache<string | Buffer>({
    maxSize: 100,
    defaultTTL: 30 * 60 * 1000,
    namespace: 'subtitle-resolver',
});

/** Clear the cache (used in tests) */
export function clearSubtitleCache(): void {
    subtitleCache.clear();
}

export interface ResolvedSubtitle {
    content: Buffer | string;
    contentType: string;
}

export interface ResolveSubtitleOptions {
    fileId?: string | null;
    format?: 'vtt' | 'srt' | 'ass' | 'pgssub' | 'sub';
}

/**
 * Resolve and return subtitle content for a given media item and stream index.
 *
 * @param sql - postgres.Sql instance
 * @param mediaItemId - Internal UUID of the media item
 * @param streamIndex - Absolute stream index from media_streams
 * @returns ResolvedSubtitle or null if not found / not supported
 */
export async function resolveSubtitle(
    sql: postgres.Sql,
    mediaItemId: string,
    streamIndex: number,
    options: ResolveSubtitleOptions = {},
): Promise<ResolvedSubtitle | null> {
    try {
        const requestedFormat = options.format ?? 'vtt';
        const requestedFileId = options.fileId ?? null;

        if (requestedFileId) {
            const selection = await resolvePlaybackSelection(sql, mediaItemId, {
                fileId: requestedFileId,
            });
            const selectedFile = selection.files[0];

            if (!selection.fileId || !selectedFile) {
                logger.debug('Requested subtitle file could not be resolved', {
                    mediaItemId,
                    requestedFileId,
                    streamIndex,
                });
                return null;
            }

            const selectedStreams = await getStreamsForFile(sql, selectedFile.id);

            // External subtitle files: pseudo-index 1000 + position in this
            // file's sidecar list (what PlaybackInfo hands out).
            if (isExternalSubtitleStreamIndex(streamIndex)) {
                return await resolveExternalSubtitleForFile(
                    sql,
                    selectedFile.id,
                    streamIndex,
                    externalSubtitlePosition(streamIndex),
                    requestedFormat,
                );
            }

            const selectedSubtitleStream = selectedStreams.find(
                (s) => s.stream_type === 'subtitle' && s.stream_index === streamIndex,
            );

            // A media_streams row marked external (imported from Jellyfin) is a
            // sidecar, not a stream of the video: FFmpeg on the file would find
            // nothing. Serve the sidecar it pairs with (same language + forced
            // flag); without one, 404 rather than another language's file.
            if (selectedSubtitleStream?.is_external === true) {
                const externalSubs = await getExternalSubtitlesForFile(sql, selectedFile.id);
                return await resolveExternalSubtitleFromRows(
                    sql,
                    externalSubs,
                    selectedFile.id,
                    streamIndex,
                    pairExternalStreamRowsWithSidecars(selectedStreams, externalSubs).get(
                        streamIndex,
                    ) ?? -1,
                    requestedFormat,
                );
            }

            if (!selectedSubtitleStream) {
                // No stream metadata in DB — file may not have been probed yet.
                // Fall back to direct ffmpeg extraction using the stream index.
                logger.debug(
                    'No subtitle stream metadata in DB for selected file, attempting direct extraction',
                    {
                        mediaItemId,
                        requestedFileId,
                        fileId: selectedFile.id,
                        streamIndex,
                        requestedFormat,
                    },
                );

                // Binary formats (PGS/VobSub) need binary extraction, not text
                if (requestedFormat === 'pgssub' || requestedFormat === 'sub') {
                    const binaryOutputFormat = requestedFormat === 'sub' ? 'sub' : 'sup';
                    return await resolveEmbeddedBinarySubtitleFromFile(
                        selectedFile,
                        mediaItemId,
                        streamIndex,
                        binaryOutputFormat,
                        undefined,
                    );
                }

                return await resolveEmbeddedTextSubtitleFromFile(
                    selectedFile,
                    mediaItemId,
                    streamIndex,
                    requestedFormat,
                );
            }

            if (
                selectedSubtitleStream.is_text_subtitle !== true &&
                isBitmapSubtitle(selectedSubtitleStream.codec)
            ) {
                return await resolveEmbeddedBinarySubtitleFromFile(
                    selectedFile,
                    mediaItemId,
                    streamIndex,
                    getBinaryOutputFormat(selectedSubtitleStream.codec, requestedFormat),
                    selectedSubtitleStream.codec,
                    bitmapTracksOf(selectedStreams),
                );
            }

            return await resolveEmbeddedTextSubtitleFromFile(
                selectedFile,
                mediaItemId,
                streamIndex,
                requestedFormat,
                selectedSubtitleStream.codec,
            );
        }

        if (isExternalSubtitleStreamIndex(streamIndex)) {
            return await resolveExternalSubtitle(
                sql,
                mediaItemId,
                streamIndex,
                externalSubtitlePosition(streamIndex),
                requestedFormat,
            );
        }

        const streams = await getStreamsForMediaItem(sql, mediaItemId);
        const subtitleStream = streams.find(
            (s) => s.stream_type === 'subtitle' && s.stream_index === streamIndex,
        );

        if (!subtitleStream) {
            // Stream index not in media_streams — may be a legacy virtual index
            // (max stream index + 1 + position) that PlaybackInfo handed out for
            // external subtitle files before the 1000 + position scheme.
            const maxStreamIndex = streams.reduce((max, s) => Math.max(max, s.stream_index), -1);
            if (streamIndex > maxStreamIndex) {
                const externalPosition = streamIndex - maxStreamIndex - 1;
                logger.debug('Trying external subtitle files for virtual index', {
                    mediaItemId,
                    streamIndex,
                    maxStreamIndex,
                    externalPosition,
                });
                return await resolveExternalSubtitle(
                    sql,
                    mediaItemId,
                    streamIndex,
                    externalPosition,
                    requestedFormat,
                );
            }

            logger.debug('No subtitle stream found', {
                mediaItemId,
                streamIndex,
            });
            return null;
        }

        if (subtitleStream.is_external === true) {
            return await resolveExternalSubtitle(
                sql,
                mediaItemId,
                streamIndex,
                streams
                    .filter((s) => s.stream_type === 'subtitle' && s.is_external === true)
                    .findIndex((s) => s.stream_index === streamIndex),
                requestedFormat,
            );
        }

        if (subtitleStream.is_text_subtitle === true) {
            return await resolveEmbeddedTextSubtitle(
                sql,
                mediaItemId,
                streamIndex,
                subtitleStream.codec,
                requestedFormat,
                subtitleStream.file_id,
            );
        }

        // Embedded bitmap subtitle (PGS/VobSub) — extract as binary
        if (isBitmapSubtitle(subtitleStream.codec)) {
            return await resolveEmbeddedBinarySubtitle(
                sql,
                mediaItemId,
                streamIndex,
                subtitleStream.codec,
                getBinaryOutputFormat(subtitleStream.codec, requestedFormat),
                subtitleStream.file_id,
            );
        }

        logger.debug('Unsupported subtitle codec', {
            mediaItemId,
            streamIndex,
            codec: subtitleStream.codec,
        });
        return null;
    } catch (error) {
        logger.error(
            'Failed to resolve subtitle',
            error instanceof Error ? error : new Error(String(error)),
            { mediaItemId, streamIndex },
        );
        return null;
    }
}

async function resolveExternalSubtitle(
    sql: postgres.Sql,
    mediaItemId: string,
    streamIndex: number,
    externalStreamPosition: number,
    requestedFormat: 'vtt' | 'srt' | 'ass' | 'pgssub' | 'sub',
): Promise<ResolvedSubtitle | null> {
    const externalSubs = await getExternalSubtitlesForMediaItem(sql, mediaItemId);
    return resolveExternalSubtitleFromRows(
        sql,
        externalSubs,
        mediaItemId,
        streamIndex,
        externalStreamPosition,
        requestedFormat,
    );
}

async function resolveExternalSubtitleForFile(
    sql: postgres.Sql,
    fileId: string,
    streamIndex: number,
    externalStreamPosition: number,
    requestedFormat: 'vtt' | 'srt' | 'ass' | 'pgssub' | 'sub',
): Promise<ResolvedSubtitle | null> {
    const externalSubs = await getExternalSubtitlesForFile(sql, fileId);
    return resolveExternalSubtitleFromRows(
        sql,
        externalSubs,
        fileId,
        streamIndex,
        externalStreamPosition,
        requestedFormat,
    );
}

async function resolveExternalSubtitleFromRows(
    sql: postgres.Sql,
    externalSubs: Awaited<ReturnType<typeof getExternalSubtitlesForMediaItem>>,
    ownerId: string,
    streamIndex: number,
    externalStreamPosition: number,
    requestedFormat: 'vtt' | 'srt' | 'ass' | 'pgssub' | 'sub',
): Promise<ResolvedSubtitle | null> {
    if (externalStreamPosition < 0 || externalStreamPosition >= externalSubs.length) {
        logger.debug('External subtitle position out of range', {
            ownerId,
            streamIndex,
            externalStreamPosition,
            totalExternal: externalSubs.length,
        });
        return null;
    }

    const sub = externalSubs[externalStreamPosition];
    const resolvedPath = path.resolve(sub.subtitle_path);

    const withinRoots = await isPathWithinMediaStore(sql, resolvedPath);
    if (!withinRoots) {
        logger.warn(
            'External subtitle path is outside the metadata store and all library roots — blocked',
            {
                path: sub.subtitle_path,
            },
        );
        return null;
    }

    if (!(await safeExists(resolvedPath))) {
        logger.debug('External subtitle file not found on disk', {
            subtitlePath: resolvedPath,
        });
        return null;
    }

    // A symlink planted at the sidecar name must not reach readFile or ffmpeg.
    if (!(await resolveContainedFile(resolvedPath))) {
        logger.warn('External subtitle is not a contained regular file - refusing', {
            subtitlePath: resolvedPath,
        });
        return null;
    }

    const fileStat = await stat(resolvedPath);
    if (fileStat.size > MAX_SUBTITLE_FILE_SIZE) {
        logger.warn('External subtitle file exceeds size limit', {
            subtitlePath: resolvedPath,
            sizeBytes: fileStat.size,
            limitBytes: MAX_SUBTITLE_FILE_SIZE,
        });
        return null;
    }

    const format = sub.format.toLowerCase();
    const outputFormat = getTextOutputFormat(requestedFormat);

    if (format === 'vtt' && outputFormat === 'webvtt') {
        const content = await readContainedFile(resolvedPath, { maxBytes: MAX_SUBTITLE_FILE_SIZE });
        return {
            content,
            contentType: getTextContentType(outputFormat),
        };
    }

    // External subtitle files are standalone — pass the subtitle file itself as FFmpeg input.
    const content = await extractSubtitleStream({
        filePath: resolvedPath,
        streamIndex: 0,
        codec: format,
        outputFormat,
    });

    return { content, contentType: getTextContentType(outputFormat) };
}

/** PGS/Blu-ray subtitle codecs */
const PGS_CODECS = ['pgs', 'pgssub', 'hdmv_pgs_subtitle'];

/** VobSub/DVD subtitle codecs */
const VOBSUB_CODECS = ['dvdsub', 'vobsub', 'dvd_subtitle'];

/**
 * NOT handled: `dvbsub`/`dvb_subtitle` and `xsub`.
 *
 * They are bitmap formats and belong here conceptually, but listing them would
 * only move where they fail. `getBinaryOutputFormat` sends anything that is not
 * VobSub to a `.sup` container, and FFmpeg's sup muxer accepts
 * `hdmv_pgs_subtitle` alone — a DVB or XSUB stream errors out there just as it
 * does on the text path. Supporting them means giving each a container FFmpeg
 * will actually mux (as VobSub gets MKV) and a decoder on the consuming side;
 * until then the text path's clean 404 is the honest outcome.
 */
export function isBitmapSubtitle(codec: string): boolean {
    const c = codec.toLowerCase();
    return PGS_CODECS.some((p) => c.includes(p)) || VOBSUB_CODECS.some((v) => c.includes(v));
}

function getBinaryOutputFormat(
    codec: string | undefined,
    requestedFormat: 'vtt' | 'srt' | 'ass' | 'pgssub' | 'sub',
): 'sup' | 'sub' {
    if (requestedFormat === 'sub') return 'sub';
    if (requestedFormat === 'pgssub') return 'sup';

    const c = codec?.toLowerCase() ?? '';
    if (VOBSUB_CODECS.some((v) => c.includes(v))) return 'sub';
    return 'sup';
}

function getBinaryContentType(codec: string | undefined, outputFormat: 'sup' | 'sub'): string {
    const c = codec?.toLowerCase() ?? '';
    if (outputFormat === 'sub' || VOBSUB_CODECS.some((v) => c.includes(v))) {
        return 'application/x-vobsub';
    }
    return 'application/octet-stream'; // PGS .sup
}

/** Output formats a subtitle request may ask for (the public `format` query). */
export type SubtitleFormat = 'vtt' | 'srt' | 'ass' | 'pgssub' | 'sub';

/** What a track is, as far as delivery formats go. */
export type SubtitleTrackKind = 'text' | 'pgs' | 'vobsub';

export interface SubtitleFormatMismatch {
    trackKind: SubtitleTrackKind;
    /** Formats that can carry this track. */
    validFormats: readonly SubtitleFormat[];
}

const TEXT_SUBTITLE_FORMATS: readonly SubtitleFormat[] = ['vtt', 'srt', 'ass'];

/**
 * Track kind from the stream metadata, or null when the track is unknown (no row
 * in media_streams, or the requested file cannot be resolved).
 */
async function getSubtitleTrackKind(
    sql: postgres.Sql,
    mediaItemId: string,
    streamIndex: number,
    fileId: string | null,
): Promise<SubtitleTrackKind | null> {
    if (isExternalSubtitleStreamIndex(streamIndex)) return 'text';

    let streams: MediaStreamRow[];
    if (fileId) {
        const selection = await resolvePlaybackSelection(sql, mediaItemId, { fileId });
        const selectedFile = selection.files[0];
        if (!selection.fileId || !selectedFile) return null;
        streams = await getStreamsForFile(sql, selectedFile.id);
    } else {
        streams = await getStreamsForMediaItem(sql, mediaItemId);
    }

    const stream = streams.find(
        (s) => s.stream_type === 'subtitle' && s.stream_index === streamIndex,
    );
    if (!stream) return null;
    // Same classification resolveSubtitle uses to pick its extraction path.
    if (stream.is_external === true) return 'text';
    if (stream.is_text_subtitle === true || !isBitmapSubtitle(stream.codec)) return 'text';
    const codec = stream.codec.toLowerCase();
    return VOBSUB_CODECS.some((v) => codec.includes(v)) ? 'vobsub' : 'pgs';
}

/**
 * Whether the requested output format can carry the track. A bitmap track (PGS,
 * VobSub) is delivered only as its own binary format, and a text track never as
 * one. Returns null when it fits or the track is unknown.
 *
 * Public routes call this before resolveSubtitle and answer a mismatch with 422.
 * resolveSubtitle itself keeps serving bitmap bytes for a text format, because
 * internal callers (HLS, Jellyfin compat, the prefetcher) depend on that.
 */
export async function findSubtitleFormatMismatch(
    sql: postgres.Sql,
    mediaItemId: string,
    streamIndex: number,
    options: ResolveSubtitleOptions = {},
): Promise<SubtitleFormatMismatch | null> {
    const requestedFormat = options.format ?? 'vtt';
    const kind = await getSubtitleTrackKind(sql, mediaItemId, streamIndex, options.fileId ?? null);
    if (kind === null) return null;

    if (kind === 'text') {
        if (requestedFormat !== 'pgssub' && requestedFormat !== 'sub') return null;
        return { trackKind: 'text', validFormats: TEXT_SUBTITLE_FORMATS };
    }

    const binaryFormat: SubtitleFormat = kind === 'vobsub' ? 'sub' : 'pgssub';
    if (requestedFormat === binaryFormat) return null;
    return { trackKind: kind, validFormats: [binaryFormat] };
}

/** Client-facing explanation of a {@link SubtitleFormatMismatch}. */
export function describeSubtitleFormatMismatch(
    mismatch: SubtitleFormatMismatch,
    requestedFormat: SubtitleFormat,
): string {
    if (mismatch.trackKind === 'text') {
        return `Format "${requestedFormat}" is only valid for bitmap subtitles; this track is text. Valid formats: ${mismatch.validFormats.join(', ')}.`;
    }
    const label = mismatch.trackKind === 'pgs' ? 'PGS' : 'VobSub';
    return `Format "${requestedFormat}" cannot deliver this ${label} bitmap track. Valid formats: ${mismatch.validFormats.join(', ')}, or the /rendered resource.`;
}

/**
 * Most tracks one shared extraction pass may carry, the requested one included.
 *
 * Extra outputs are NOT free on a long file: on prod a 2h16m remux took ~80s for
 * one PGS track and ~117s for two. Uncapped, a Blu-ray rip's 4-6 same-format
 * tracks would push the one request that pays for the pass towards the timeout.
 * Any sibling left out simply gets its own pass when it is first requested.
 */
const MAX_TRACKS_PER_PASS = 3;

/** Pending binary extractions — prevents duplicate concurrent FFmpeg calls */
const pendingBinaryExtractions = new Map<string, Promise<Buffer | null>>();

async function resolveEmbeddedBinarySubtitle(
    sql: postgres.Sql,
    mediaItemId: string,
    streamIndex: number,
    codec: string,
    outputFormat: 'sup' | 'sub',
    targetFileId?: string,
): Promise<ResolvedSubtitle | null> {
    // Fetch file info first — we need probed_at to validate caches,
    // and file_path for extraction. One indexed query per request is
    // acceptable at playback frequency.
    const files = await getFilesForMediaItem(sql, mediaItemId);
    if (files.length === 0) {
        logger.debug('No media files linked for binary subtitle extraction', {
            mediaItemId,
        });
        return null;
    }

    // Use the file that owns the matched stream (from media_streams.file_id),
    // not files[0] which may be a different file on multi-file items.
    const targetMatch = targetFileId ? files.find((f) => f.id === targetFileId) : undefined;
    if (targetFileId && !targetMatch) {
        logger.warn('Subtitle target file not found in item files, falling back to first file', {
            mediaItemId,
            targetFileId,
            fallbackFileId: files[0].id,
        });
    }
    const file = targetMatch ?? files[0];

    return resolveEmbeddedBinarySubtitleFromFile(
        file,
        mediaItemId,
        streamIndex,
        outputFormat,
        codec,
        bitmapTracksOf(await getStreamsForFile(sql, file.id)),
    );
}

/** An embedded bitmap track, in the binary format it is extracted as. */
interface BitmapTrack {
    streamIndex: number;
    outputFormat: 'sup' | 'sub';
}

/** The file's embedded bitmap subtitle tracks — candidates for a shared pass. */
function bitmapTracksOf(streams: MediaStreamRow[]): BitmapTrack[] {
    return streams
        .filter(
            (s) =>
                s.stream_type === 'subtitle' &&
                s.is_external !== true &&
                s.is_text_subtitle !== true &&
                typeof s.codec === 'string' &&
                isBitmapSubtitle(s.codec),
        )
        .map((s) => ({
            streamIndex: s.stream_index,
            outputFormat: getBinaryOutputFormat(s.codec, 'vtt'),
        }));
}

async function resolveEmbeddedBinarySubtitleFromFile(
    file: MediaFileRow,
    mediaItemId: string,
    streamIndex: number,
    outputFormat: 'sup' | 'sub',
    codecHint?: string,
    fileBitmapTracks: BitmapTrack[] = [],
): Promise<ResolvedSubtitle | null> {
    const contentType = getBinaryContentType(codecHint, outputFormat);
    const probedAt = file.probed_at;
    const binaryCacheId = `${mediaItemId}_${file.id}`;

    // Include probed_at epoch in the memory cache key so that a re-probe
    // (file replacement) automatically invalidates stale entries.
    const probedEpoch = probedAt ? Math.floor(probedAt.getTime() / 1000) : 0;
    const cacheKey = `${mediaItemId}:${file.id}:${streamIndex}:${outputFormat}:${probedEpoch}:bin`;

    // Layer 1: Memory cache (fastest)
    const cached = subtitleCache.get(cacheKey);
    if (cached && Buffer.isBuffer(cached)) {
        logger.debug('Serving binary subtitle from memory cache', {
            mediaItemId,
            streamIndex,
        });
        return { content: cached, contentType };
    }

    // Layer 2: File cache (persistent: central or alongside the media, no TTL)
    // Pass probedAt so entries older than the last probe are treated as stale.
    //
    // Keyed on the FILE, not the item. A multi-version item (a 1080p rip beside a
    // 4K remux) has different subtitle content under the same stream index, and an
    // item-only key served one version's extraction for the other. The in-memory
    // layer and the extraction-dedup key were already file-scoped; this was the
    // odd one out, and it silently undermined the render bundle's own per-file
    // key one layer above.
    const fileCached = await SubtitleFileCacheService.getBinary(
        binaryCacheId,
        streamIndex,
        outputFormat,
        probedAt,
        file.file_path,
    );
    if (fileCached) {
        logger.debug('Serving binary subtitle from file cache', {
            mediaItemId,
            streamIndex,
        });
        subtitleCache.set(cacheKey, fileCached);
        return { content: fileCached, contentType };
    }

    // Layer 3: FFmpeg extraction (with dedup guard)
    const extractionKey = `${file.id}:${streamIndex}:${outputFormat}`;
    const pending = pendingBinaryExtractions.get(extractionKey);
    let retryAlone = false;
    if (pending) {
        logger.debug('Joining pending binary extraction', {
            mediaItemId,
            streamIndex,
        });
        try {
            const data = await pending;
            return data ? { content: data, contentType } : null;
        } catch (error) {
            // A shared multi-track pass this track was riding on failed. After a
            // timeout, another read of the same file would time out too — give
            // up, as the request that owned the pass did. Otherwise the failure
            // may be another stream breaking the mux: retry THIS track alone,
            // not with the siblings again, or every joined request would rerun
            // the multi-track pass that just failed.
            if (error instanceof FFmpegTimeoutError) return null;
            logger.debug('Shared binary extraction failed, extracting alone', {
                mediaItemId,
                streamIndex,
            });
            retryAlone = true;
        }
    }

    const extractionPromise = (async (): Promise<Buffer | null> => {
        const data = await extractBinaryPass(
            file,
            binaryCacheId,
            mediaItemId,
            streamIndex,
            outputFormat,
            codecHint,
            retryAlone ? [] : fileBitmapTracks,
        );

        if (!data) {
            logger.warn('Binary subtitle extraction returned no data', {
                mediaItemId,
                streamIndex,
                codec: codecHint,
            });
            return null;
        }

        subtitleCache.set(cacheKey, data);
        return data;
    })();

    pendingBinaryExtractions.set(extractionKey, extractionPromise);
    try {
        const data = await extractionPromise;
        return data ? { content: data, contentType } : null;
    } finally {
        pendingBinaryExtractions.delete(extractionKey);
    }
}

/**
 * Extract the requested bitmap track, and every other uncached bitmap track of
 * the same format in the file, in ONE FFmpeg pass.
 *
 * A cold extraction costs a full read of the container regardless of how many
 * streams it feeds, and viewers routinely try several tracks of a Blu-ray rip
 * (4-6 bitmap tracks is common). Paying that read once per file instead of once
 * per track turns every later pick of a sibling into a cache hit. Siblings go
 * to the file cache only — the memory cache holds just what was asked for.
 *
 * Returns the requested track's data. Every successful output is written to the
 * file cache before returning.
 */
async function extractBinaryPass(
    file: MediaFileRow,
    binaryCacheId: string,
    mediaItemId: string,
    streamIndex: number,
    outputFormat: 'sup' | 'sub',
    codecHint: string | undefined,
    fileBitmapTracks: BitmapTrack[],
): Promise<Buffer | null> {
    const cacheWrite = (index: number, data: Buffer): Promise<void> =>
        SubtitleFileCacheService.setBinary(
            binaryCacheId,
            index,
            outputFormat,
            data,
            file.file_path,
        ).catch((err: unknown) =>
            logger.warn('Failed to cache binary subtitle to file', {
                streamIndex: index,
                error: err instanceof Error ? err.message : String(err),
            }),
        );

    const extractAlone = async (index: number): Promise<Buffer | null> => {
        const data = await extractSubtitleStreamBinary(file.file_path, index, outputFormat);
        if (data) await cacheWrite(index, data);
        return data;
    };

    // Same format only: -copyts is global and PGS and VobSub need opposite
    // settings, so a mixed file's other format waits for its own first request.
    const siblings: number[] = [];
    for (const track of fileBitmapTracks) {
        if (siblings.length >= MAX_TRACKS_PER_PASS - 1) break;
        if (track.streamIndex === streamIndex || track.outputFormat !== outputFormat) continue;
        if (siblings.includes(track.streamIndex)) continue;
        if (pendingBinaryExtractions.has(`${file.id}:${track.streamIndex}:${outputFormat}`)) {
            continue;
        }
        if (
            await SubtitleFileCacheService.hasFreshBinary(
                binaryCacheId,
                track.streamIndex,
                outputFormat,
                file.probed_at,
                file.file_path,
            )
        ) {
            continue;
        }
        siblings.push(track.streamIndex);
    }

    logger.info('Extracting binary subtitle', {
        mediaItemId,
        streamIndex,
        codec: codecHint,
        outputFormat,
        ...(siblings.length > 0 ? { alsoExtracting: siblings } : {}),
    });

    if (siblings.length === 0) return extractAlone(streamIndex);

    const pass = extractSubtitleStreamsBinary(
        file.file_path,
        [streamIndex, ...siblings],
        outputFormat,
    );

    // Register the siblings as in flight so a request for one of them joins this
    // pass instead of starting its own read of the same file. If the pass fails,
    // the entry REJECTS and a joined request extracts on its own (see Layer 3).
    // Retrying here instead would spawn a full read per sibling that nobody has
    // even asked for.
    const siblingWrites: Promise<Buffer | null>[] = [];
    for (const index of siblings) {
        const key = `${file.id}:${index}:${outputFormat}`;
        // Settles only once the sibling is in the file cache: released any
        // earlier, a request landing between FFmpeg exiting and the write
        // would find neither an entry nor a cache file, and read the file again.
        const joined = pass.then(async (results) => {
            const data = results.get(index) ?? null;
            if (data) await cacheWrite(index, data);
            return data;
        });
        const release = (): void => {
            if (pendingBinaryExtractions.get(key) === joined) {
                pendingBinaryExtractions.delete(key);
            }
        };
        // Also the rejection handler: an unjoined sibling's failure is not an error.
        joined.then(release, release);
        pendingBinaryExtractions.set(key, joined);
        siblingWrites.push(joined);
    }

    let results: Map<number, Buffer | null>;
    try {
        results = await pass;
    } catch (error) {
        // A timeout means the read itself is too slow; one output instead of
        // several would take just as long. Anything else may be one sibling
        // breaking the multi-output mux, so the requested track gets a solo try.
        if (error instanceof FFmpegTimeoutError) {
            logger.error('Binary subtitle extraction timed out', error, {
                mediaItemId,
                streamIndex,
                streams: [streamIndex, ...siblings],
            });
            return null;
        }
        logger.warn('Multi-track subtitle extraction failed; retrying the requested track alone', {
            mediaItemId,
            streamIndex,
            siblings,
            error: error instanceof Error ? error.message : String(error),
        });
        return extractAlone(streamIndex);
    }

    // The siblings write themselves (above); wait for them too, so the pass is
    // fully cached by the time this request returns.
    const data = results.get(streamIndex) ?? null;
    if (data) await cacheWrite(streamIndex, data);
    await Promise.allSettled(siblingWrites);

    return data;
}

async function resolveEmbeddedTextSubtitle(
    sql: postgres.Sql,
    mediaItemId: string,
    streamIndex: number,
    codec: string,
    requestedFormat: 'vtt' | 'srt' | 'ass' | 'pgssub' | 'sub',
    targetFileId?: string,
): Promise<ResolvedSubtitle | null> {
    // Fetch file info first — we need probed_at to validate the memory cache
    // and file_path for extraction.
    const files = await getFilesForMediaItem(sql, mediaItemId);

    if (files.length === 0) {
        logger.debug('No media files linked for embedded subtitle extraction', {
            mediaItemId,
        });
        return null;
    }

    // Use the file that owns the matched stream (from media_streams.file_id),
    // not files[0] which may be a different file on multi-file items.
    const targetMatch = targetFileId ? files.find((f) => f.id === targetFileId) : undefined;
    if (targetFileId && !targetMatch) {
        logger.warn('Subtitle target file not found in item files, falling back to first file', {
            mediaItemId,
            targetFileId,
            fallbackFileId: files[0].id,
        });
    }
    const file = targetMatch ?? files[0];

    return resolveEmbeddedTextSubtitleFromFile(
        file,
        mediaItemId,
        streamIndex,
        requestedFormat,
        codec,
    );
}

async function resolveEmbeddedTextSubtitleFromFile(
    file: MediaFileRow,
    mediaItemId: string,
    streamIndex: number,
    requestedFormat: 'vtt' | 'srt' | 'ass' | 'pgssub' | 'sub',
    codec?: string,
): Promise<ResolvedSubtitle | null> {
    const outputFormat = getTextOutputFormat(requestedFormat);
    const probedEpoch = file.probed_at ? Math.floor(file.probed_at.getTime() / 1000) : 0;

    // Include file ID and output format so version switches and format changes
    // do not reuse stale extraction results.
    const cacheKey = `${mediaItemId}:${file.id}:${streamIndex}:${outputFormat}:${probedEpoch}`;
    const cached = subtitleCache.get(cacheKey);
    if (cached && typeof cached === 'string') {
        logger.debug('Serving cached embedded subtitle', {
            mediaItemId,
            streamIndex,
            outputFormat,
        });
        return {
            content: cached,
            contentType: getTextContentType(outputFormat),
        };
    }

    // Disk tier: shared by every replica (the `.cache` volume) and survives
    // restarts. A cold extraction reads the whole container, so this is also
    // what lets prefetchNextEpisodeSubtitle warm a track for whichever replica
    // serves the next request. `probed_at` invalidates a replaced file.
    // Only for a probed file: invalidateFileProbeData clears probed_at when the
    // content changes, and without a probed_at an entry could never be told
    // stale — the old file's subtitles would be served until the 7-day TTL.
    const diskExt = TEXT_DISK_EXTENSION[outputFormat];
    const useDisk = file.probed_at !== null;
    const onDisk = useDisk
        ? await SubtitleFileCacheService.get(file.id, streamIndex, file.probed_at, diskExt)
        : null;
    if (onDisk !== null) {
        subtitleCache.set(cacheKey, onDisk);
        return { content: onDisk, contentType: getTextContentType(outputFormat) };
    }

    const content = await extractSubtitleStream({
        filePath: file.file_path,
        streamIndex,
        codec,
        outputFormat,
    });

    subtitleCache.set(cacheKey, content);
    if (useDisk) {
        await SubtitleFileCacheService.set(file.id, streamIndex, content, diskExt).catch(() => {
            // Disk tier is best-effort; the response already has its content.
        });
    }

    return {
        content,
        contentType: getTextContentType(outputFormat),
    };
}

const TEXT_DISK_EXTENSION = { webvtt: 'vtt', srt: 'srt', ass: 'ass' } as const;

function getTextOutputFormat(
    format: 'vtt' | 'srt' | 'ass' | 'pgssub' | 'sub',
): 'webvtt' | 'srt' | 'ass' {
    if (format === 'ass') return 'ass';
    if (format === 'srt') return 'srt';
    return 'webvtt';
}

function getTextContentType(outputFormat: 'webvtt' | 'srt' | 'ass'): string {
    switch (outputFormat) {
        case 'ass':
            return 'text/x-ssa; charset=utf-8';
        case 'srt':
            return 'text/srt; charset=utf-8';
        default:
            return 'text/vtt; charset=utf-8';
    }
}
