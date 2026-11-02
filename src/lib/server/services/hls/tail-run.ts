// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tail-cache worker's run: its remux args, and the reader that turns a
 * finished run (`<tailDir>/stream_<i>/index.m3u8`, fMP4) into the last
 * segment of each stream plus where that segment ends on the run's clock: the
 * first sample's presentation time (tfdt + composition offset) plus its
 * `#EXTINF`. See `tailRunEntries` in ./end-segment-cache.ts for how those ends
 * become source-timeline positions.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { readFragmentStart, readTrackTimescale } from './fmp4-timing.js';
import {
    lastExtinfSeconds,
    storeEndSegment,
    tailRunEntries,
    type EndSegmentCache,
    type TailRunStream,
} from './end-segment-cache.js';

/**
 * FFmpeg args of the remux tail worker: `-c copy` from `seekToSeconds` into
 * `<tailDir>/stream_<i>/`, audio tracks first, then video (the main job's
 * demux layout).
 */
export function buildRemuxTailRunArgs(options: {
    seekToSeconds: number;
    inputFile: string;
    audioTrackCount: number;
    segmentSeconds: number;
    tailDir: string;
}): string[] {
    const streamMapParts: string[] = [];
    const mapArgs: string[] = [];
    for (let i = 0; i < options.audioTrackCount; i++) {
        mapArgs.push('-map', `0:a:${i}`);
        streamMapParts.push(`a:${i},name:${i}`);
    }
    mapArgs.push('-map', '0:v:0');
    streamMapParts.push(`v:0,name:${options.audioTrackCount}`);

    return [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        options.seekToSeconds.toString(),
        '-i',
        options.inputFile,
        ...mapArgs,
        '-c',
        'copy',
        '-avoid_negative_ts',
        'make_zero',
        '-f',
        'hls',
        '-hls_time',
        options.segmentSeconds.toString(),
        '-hls_segment_type',
        'fmp4',
        '-hls_fmp4_init_filename',
        `init_%v.mp4`,
        '-hls_playlist_type',
        'vod',
        '-hls_flags',
        // `temp_file`: matches the main job's build-args default
        // (ffmpeg-args-builder.ts) — ffmpeg writes each segment to a
        // `.tmp` file and renames it into place only once the write is
        // complete, so nothing ever observes a partially-written segment
        // file. Without it, a reader landing between ffmpeg's create and
        // its final write (a kill/abort mid-segment, a slow/contended
        // filesystem) can see a truncated file at the final name — the
        // exact shape of a real prod incident where a served segment was
        // ~3% of its expected size.
        'independent_segments+temp_file',
        '-var_stream_map',
        streamMapParts.join(' '),
        '-hls_segment_filename',
        path.join(options.tailDir, 'stream_%v', 'segment_%05d.m4s'),
        path.join(options.tailDir, 'stream_%v', 'index.m3u8'),
    ];
}

/** Last `#EXT-X-MAP` URI and last segment URI of a media playlist. */
function playlistTail(playlist: string): { initUri: string; segmentUri: string } | null {
    let initUri: string | null = null;
    let segmentUri: string | null = null;
    for (const raw of playlist.split('\n')) {
        const line = raw.trim();
        const map = /^#EXT-X-MAP:.*URI="([^"]+)"/.exec(line);
        if (map) initUri = map[1];
        else if (line && !line.startsWith('#')) segmentUri = line;
    }
    return initUri && segmentUri ? { initUri, segmentUri } : null;
}

/** Inside `dir` only: the run's playlists are FFmpeg output, still never trusted with `..`. */
function resolveInside(dir: string, uri: string): string | null {
    const resolved = path.resolve(dir, uri);
    return resolved.startsWith(path.resolve(dir) + path.sep) ? resolved : null;
}

async function readStream(tailDir: string, streamDir: string): Promise<TailRunStream | null> {
    const dir = path.join(tailDir, streamDir);
    const playlist = await fs.readFile(path.join(dir, 'index.m3u8'), 'utf8');
    // A run FFmpeg did not finish has no closed playlist; its last listed
    // segment may not be its end.
    if (!/^#EXT-X-ENDLIST\s*$/m.test(playlist)) return null;
    const tail = playlistTail(playlist);
    const extinf = lastExtinfSeconds(playlist);
    if (!tail || extinf === null) return null;
    const initPath = resolveInside(dir, tail.initUri);
    const segmentPath = resolveInside(dir, tail.segmentUri);
    if (!initPath || !segmentPath) return null;

    const timescale = readTrackTimescale(await fs.readFile(initPath));
    if (!timescale) return null;
    const buffer = await fs.readFile(segmentPath);
    const start = readFragmentStart(buffer, timescale);
    if (!start) return null;
    return { streamDir, buffer, runEndSeconds: start.presentationSeconds + extinf };
}

/**
 * Every stream of the run, or `null` when any one cannot be read or timed.
 * All or nothing on purpose: the ends are only meaningful relative to the
 * longest stream, and a missing longest stream would make the next one look
 * like it reaches the end of the container.
 */
export async function readTailRunStreams(
    tailDir: string,
    streamDirs: string[],
): Promise<TailRunStream[] | null> {
    const streams: TailRunStream[] = [];
    for (const streamDir of streamDirs) {
        try {
            const stream = await readStream(tailDir, streamDir);
            if (!stream) return null;
            streams.push(stream);
        } catch {
            // best-effort: a stream the run did not write; the caller caches nothing.
            return null;
        }
    }
    return streams;
}

/** What {@link cacheTailRun} did with one stream, for the worker's log. */
export interface TailRunCacheResult {
    streamDir: string;
    stored: boolean;
    mediaEndSeconds?: number;
    size: number;
}

/**
 * Put the last segment of each stream of a finished tail run into the
 * end-segment cache as `tail_run` entries (see ./end-segment-cache.ts).
 * `null` when the run cannot be read or timed: nothing is cached then.
 */
export async function cacheTailRun(options: {
    cache: EndSegmentCache;
    tailDir: string;
    streamDirs: string[];
    totalSeconds: number;
    /** The stream's playlist cadence as far as it is known now. */
    segmentSecondsFor: (streamDir: string) => number;
}): Promise<TailRunCacheResult[] | null> {
    const streams = await readTailRunStreams(options.tailDir, options.streamDirs);
    if (!streams) return null;
    const results: TailRunCacheResult[] = [];
    for (const [streamDir, entry] of tailRunEntries(streams, options.totalSeconds)) {
        const stored = storeEndSegment(options.cache, streamDir, entry, {
            totalSeconds: options.totalSeconds,
            segmentSeconds: options.segmentSecondsFor(streamDir),
        });
        results.push({
            streamDir,
            stored,
            mediaEndSeconds:
                entry.kind === 'tail_run' ? Number(entry.mediaEndSeconds.toFixed(3)) : undefined,
            size: entry.buffer.length,
        });
    }
    return results;
}
