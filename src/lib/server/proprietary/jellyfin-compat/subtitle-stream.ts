// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The /j subtitle file routes (Jellyfin's SubtitleController):
 *
 *   GET /Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream.{format}
 *   GET /Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/{startPositionTicks}/Stream.{format}
 *   GET /Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/subtitles.m3u8?segmentLength=N
 *
 * All three resolve the track through the one SubtitleResolverService
 * (embedded streams by stream index, sidecar files at 1000 + position) and
 * share the access check. On top of the plain file, Jellyfin's query params:
 *   - `StartPositionTicks` / `EndPositionTicks`: drop cues outside the window;
 *   - `CopyTimestamps=false` (default): shift the kept cues by the start, so a
 *     client that started a transcode at an offset gets cues on its timeline;
 *   - `AddVttTimeMap=true`: the X-TIMESTAMP-MAP header HLS WebVTT segments need.
 * subtitles.m3u8 is the HLS subtitle playlist whose segments are exactly such
 * windowed `Stream.vtt` requests.
 *
 * Differences from Jellyfin, on purpose:
 *   - The window is applied to WebVTT and SRT output only. Jellyfin applies it
 *     when it converts, and returns a same-format file (ASS→ASS, SRT→SRT)
 *     untouched; we apply it whenever the output is text we can parse, which
 *     is what the request asks for. ASS and bitmap output are returned whole.
 *   - Segment URIs authenticate with `api_key` (Jellyfin: `ApiKey`); /j
 *     accepts both.
 *   - The time map anchors at MPEGTS:0, not Jellyfin's 900000 (addVttTimeMap).
 */

import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/database';
import { Logger } from '$lib/server/utils/logger';
import { resolveSubtitle } from '$lib/server/services/subtitle-resolver.service';
import {
    checkMediaAccess,
    userNeedsMediaAccessCheck,
} from '$lib/server/middleware/media-access.js';
import {
    getFilesForMediaItem,
    getOwnerItemForFile,
} from '$lib/server/database/queries/media-files.queries';
import { getMediaItemById } from '$lib/server/database/queries/catalog-operations.queries';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { formatFromStreamFile } from './subtitle-delivery';
import { resolveMediaSourceFileId } from './media-source-id';
import { getJfToken, getParam } from './utils';

const logger = Logger.for('JellyfinCompat:SubtitleDelivery');

const TICKS_PER_MS = 10_000;
const TICKS_PER_SECOND = 10_000_000;

export interface SubtitleWindow {
    startTicks: number;
    /** 0 = to the end. */
    endTicks: number;
    /** Keep the source timeline instead of shifting by `startTicks`. */
    copyTimestamps: boolean;
}

// ---------------------------------------------------------------------------
// Cue windowing (Jellyfin's SubtitleEncoder.FilterEvents)
// ---------------------------------------------------------------------------

const VTT_TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const TIMING_LINE = new RegExp(`^\\s*(${VTT_TIME.source})\\s*-->\\s*(${VTT_TIME.source})(.*)$`);

function parseTimeMs(raw: string): number | null {
    const m = VTT_TIME.exec(raw);
    if (!m) return null;
    const hours = m[1] ? Number(m[1]) : 0;
    const ms = Number(m[4].padEnd(3, '0'));
    return ((hours * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + ms;
}

function formatTimeMs(totalMs: number, separator: '.' | ','): string {
    const ms = Math.max(0, Math.round(totalMs));
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms % 1000, 3)}`;
}

/**
 * Drop the cues that ended before the window or start after it, and (unless
 * `copyTimestamps`) move the rest onto the window's timeline. Non-cue blocks
 * (the WEBVTT header, NOTE, STYLE, REGION) are kept. SRT cues are renumbered.
 */
export function applySubtitleWindow(
    text: string,
    format: 'vtt' | 'srt',
    window: SubtitleWindow,
): string {
    const startMs = window.startTicks / TICKS_PER_MS;
    const endMs = window.endTicks / TICKS_PER_MS;
    const shiftMs = window.copyTimestamps ? 0 : startMs;
    const separator = format === 'srt' ? ',' : '.';
    const newline = text.includes('\r\n') ? '\r\n' : '\n';

    const blocks = text
        .replace(/^\uFEFF/, '')
        .split(/\r?\n(?:[ \t]*\r?\n)+/)
        .map((b) => b.replace(/(?:\r?\n)+$/, ''))
        .filter((b) => b.trim() !== '');
    const out: string[] = [];
    let srtNumber = 0;

    for (const block of blocks) {
        const lines = block.split(/\r?\n/);
        const timingAt = lines.findIndex((l) => l.includes('-->'));
        const timing = timingAt >= 0 ? TIMING_LINE.exec(lines[timingAt]) : null;
        if (!timing) {
            // SRT has no non-cue blocks; a malformed one is dropped there.
            if (format === 'vtt') out.push(block);
            continue;
        }
        const cueStart = parseTimeMs(timing[1]);
        const cueEnd = parseTimeMs(timing[6]);
        if (cueStart === null || cueEnd === null) continue;
        if (cueStart < startMs && cueEnd < startMs) continue;
        if (endMs > 0 && cueStart > endMs) continue;

        const settings = timing[11] ?? '';
        const newTiming =
            `${formatTimeMs(cueStart - shiftMs, separator)} --> ` +
            `${formatTimeMs(cueEnd - shiftMs, separator)}${settings}`;
        const payload = lines.slice(timingAt + 1);
        if (format === 'srt') {
            srtNumber += 1;
            out.push([String(srtNumber), newTiming, ...payload].join(newline));
        } else {
            out.push([...lines.slice(0, timingAt), newTiming, ...payload].join(newline));
        }
    }
    return out.join(newline + newline) + newline;
}

/**
 * Jellyfin's `AddVttTimeMap`: the MPEG-TS anchor HLS WebVTT segments need.
 * Jellyfin anchors at MPEGTS:900000 (its transcodes' first PTS); ours start at
 * PTS 0, and every other WebVTT segment we serve (webvtt-parser.ts) uses
 * MPEGTS:0 — a 900000 anchor would show every cue 10 s late against our video.
 */
export function addVttTimeMap(text: string): string {
    return text.replace(
        /^(\uFEFF?WEBVTT[^\r\n]*)/,
        '$1\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000',
    );
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export interface SubtitleRouteParams {
    itemId: string | undefined;
    mediaSourceId: string | undefined;
    index: string | undefined;
}

const INT_RE = /^\d{1,10}$/;
const TICKS_RE = /^\d{1,19}$/;

function parseBool(raw: string | null): boolean {
    return raw?.toLowerCase() === 'true';
}

function parseTicks(raw: string | null | undefined): number | null {
    if (raw === null || raw === undefined || raw === '') return 0;
    if (!TICKS_RE.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
}

/**
 * Resolve the item behind a /Subtitles URL and check the caller may see it.
 * Android TV passes MediaSource.Id (a media_files uuid) as the item id, so a
 * file id is mapped to its owning item first (cached).
 */
async function gateSubtitleItem(
    event: RequestEvent,
    itemId: string,
): Promise<{ sql: NonNullable<ReturnType<typeof getDb>>; itemId: string } | Response> {
    // Jellyfin binds the item id as a Guid (400 otherwise); the owner lookup
    // casts to uuid and would 500 on anything else.
    if (!isUuid(itemId)) return new Response('Invalid item id', { status: 400 });
    const sql = getDb();
    if (!sql) return new Response('Database unavailable', { status: 503 });
    const resolvedItemId = (await getOwnerItemForFile(sql, itemId)) ?? itemId;
    if (
        (await userNeedsMediaAccessCheck(sql, event.locals.user)) &&
        !(await checkMediaAccess(sql, resolvedItemId, event.locals.user))
    ) {
        return new Response(null, { status: 404 });
    }
    return { sql, itemId: resolvedItemId };
}

/**
 * `Stream.{format}` with or without the start-ticks path segment.
 * `routeStartTicks` is that segment (undefined for the short form); a
 * `StartPositionTicks` query param wins over it, as in Jellyfin.
 */
export async function serveSubtitleStream(
    event: RequestEvent,
    params: SubtitleRouteParams & { streamFile: string | undefined; routeStartTicks?: string },
): Promise<Response> {
    const { itemId, index: rawIndex, streamFile } = params;
    if (!itemId || !rawIndex) {
        return new Response('Missing parameters', { status: 400 });
    }
    if (!INT_RE.test(rawIndex)) {
        return new Response('Invalid subtitle index', { status: 400 });
    }
    const index = Number(rawIndex);

    const queryStart = getParam(event.url, 'StartPositionTicks');
    const startTicks = parseTicks(queryStart ?? params.routeStartTicks);
    const endTicks = parseTicks(getParam(event.url, 'EndPositionTicks'));
    if (startTicks === null || endTicks === null) {
        return new Response('Invalid position ticks', { status: 400 });
    }

    const gate = await gateSubtitleItem(event, itemId);
    if (gate instanceof Response) return gate;

    const format = formatFromStreamFile(streamFile);
    try {
        // A client that builds the URL from MediaSource.Id sends the file
        // token; subtitles.m3u8's relative segment URIs inherit it.
        const fileId =
            (await resolveMediaSourceFileId(params.mediaSourceId)) ?? params.mediaSourceId;
        const result = await resolveSubtitle(gate.sql, gate.itemId, index, {
            fileId,
            format,
        });

        if (!result) {
            logger.debug('Subtitle not resolved', {
                itemId,
                index,
                requestedFormat: streamFile?.split('.').pop()?.toLowerCase(),
            });
            return new Response(null, { status: 404 });
        }

        const windowed = startTicks > 0 || endTicks > 0;
        const timeMap = format === 'vtt' && parseBool(getParam(event.url, 'AddVttTimeMap'));
        const isText = format === 'vtt' || format === 'srt';
        let body: string | Uint8Array<ArrayBuffer> = Buffer.isBuffer(result.content)
            ? // A sidecar in the requested format comes back as the file's bytes.
              isText && (windowed || timeMap)
                ? result.content.toString('utf8')
                : new Uint8Array(result.content)
            : result.content;
        if (typeof body === 'string' && isText) {
            if (windowed) {
                body = applySubtitleWindow(body, format, {
                    startTicks,
                    endTicks,
                    copyTimestamps: parseBool(getParam(event.url, 'CopyTimestamps')),
                });
            }
            if (timeMap) {
                body = addVttTimeMap(body);
            }
        }

        return new Response(body, {
            status: 200,
            headers: {
                'Content-Type': result.contentType,
                // private: the URL carries api_key and the item is access-gated,
                // so a shared cache must not hand it to someone else.
                'Cache-Control': 'private, max-age=86400',
                'Access-Control-Allow-Origin': '*',
            },
        });
    } catch (error) {
        logger.error('Failed to serve subtitle', error as Error, {
            itemId,
            index,
        });
        return new Response('Failed to serve subtitle', { status: 500 });
    }
}

/**
 * Jellyfin's `GetSubtitlePlaylist`: a VOD playlist cutting the media source's
 * runtime into `segmentLength`-second windowed WebVTT requests.
 */
export function buildSubtitlePlaylist(
    runtimeTicks: number,
    segmentLengthSeconds: number,
    apiKey: string,
): string {
    const segmentTicks = segmentLengthSeconds * TICKS_PER_SECOND;
    const lines = [
        '#EXTM3U',
        `#EXT-X-TARGETDURATION:${segmentLengthSeconds}`,
        '#EXT-X-VERSION:3',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
    ];
    for (let position = 0; position < runtimeTicks; position += segmentTicks) {
        const length = Math.min(runtimeTicks - position, segmentTicks);
        const end = Math.min(runtimeTicks, position + segmentTicks);
        lines.push(`#EXTINF:${length / TICKS_PER_SECOND},`);
        const query = new URLSearchParams({
            CopyTimestamps: 'true',
            AddVttTimeMap: 'true',
            StartPositionTicks: String(position),
            EndPositionTicks: String(end),
        });
        if (apiKey) query.set('api_key', apiKey);
        lines.push(`Stream.vtt?${query.toString()}`);
    }
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
}

/** The media source's runtime: the picked file's duration, else the item's. */
async function sourceRuntimeSeconds(
    sql: NonNullable<ReturnType<typeof getDb>>,
    itemId: string,
    mediaSourceId: string | undefined,
    itemRuntimeSeconds: number | null,
): Promise<number | null> {
    const fileId = await resolveMediaSourceFileId(mediaSourceId);
    if (fileId) {
        const file = (await getFilesForMediaItem(sql, itemId)).find((f) => f.id === fileId);
        const duration = Number(file?.duration_seconds);
        if (Number.isFinite(duration) && duration > 0) return duration;
    }
    return itemRuntimeSeconds;
}

export async function serveSubtitlePlaylist(
    event: RequestEvent,
    params: SubtitleRouteParams,
): Promise<Response> {
    const { itemId, index: rawIndex } = params;
    if (!itemId || !rawIndex || !INT_RE.test(rawIndex)) {
        return new Response('Invalid subtitle index', { status: 400 });
    }
    const rawSegmentLength = getParam(event.url, 'SegmentLength');
    const segmentLength =
        rawSegmentLength && INT_RE.test(rawSegmentLength) ? Number(rawSegmentLength) : 0;
    if (segmentLength <= 0) {
        return new Response(
            'segmentLength was not given, or it was given incorrectly. (It should be bigger than 0)',
            { status: 400 },
        );
    }

    const gate = await gateSubtitleItem(event, itemId);
    if (gate instanceof Response) return gate;

    const item = await getMediaItemById(gate.sql, gate.itemId);
    if (!item) return new Response(null, { status: 404 });

    const itemRuntime =
        'runtime_seconds' in item && typeof item.runtime_seconds === 'number'
            ? item.runtime_seconds
            : null;
    const runtimeSeconds = await sourceRuntimeSeconds(
        gate.sql,
        gate.itemId,
        params.mediaSourceId,
        itemRuntime,
    );
    const runtimeTicks = Math.round((runtimeSeconds ?? 0) * TICKS_PER_SECOND);
    if (runtimeTicks <= 0) {
        return new Response('HLS Subtitles are not supported for this media.', { status: 400 });
    }

    const apiKey = getJfToken(event.locals as unknown as Record<string, unknown>);
    return new Response(buildSubtitlePlaylist(runtimeTicks, segmentLength, apiKey), {
        status: 200,
        headers: {
            'Content-Type': 'application/x-mpegURL',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
        },
    });
}
