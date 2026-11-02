// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Records HLS segment/playlist delivery failures into
 * `segment_delivery_failures`.
 *
 * Why this exists: the delivery layer sat between two queryable signals
 * (`playback_incident_events` on the client side, `transcode_failure_events`
 * on the FFmpeg side) and produced none of its own, so an investigation could
 * clear both neighbours and still be unable to see whether segments were
 * actually reaching the player. On Apple clients that blind spot is
 * expensive — AVFoundation penalty-boxes a variant on a single 404
 * (CoreMediaErrorDomain -12938) and never retries, turning one stray response
 * into a permanent stall.
 *
 * Two rules govern everything here:
 *
 *  1. NEVER affect the response. Recording is fire-and-forget and every error
 *     is swallowed: a diagnostics write must not turn a served segment into a
 *     failed one, and must not add latency to the hot path. `record()` returns
 *     void, not a promise, so a caller cannot accidentally await it.
 *  2. NEVER store the URL. Segment routes carry `api_key` in the query string
 *     (see `forward-auth.ts`), so a stored URL would be a credential at rest.
 *     Only the path's SHAPE is classified — resource kind and stream
 *     directory — never its text.
 */

import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    recordSegmentDeliveryFailure,
    type SegmentFailureCategory,
    type SegmentResourceKind,
} from '$lib/server/database/queries/segment-delivery-failures.queries.js';

const logger = Logger.for('SegmentDeliveryFailure');

/**
 * A play session id longer than this is not a real id — it is a malformed or
 * hostile path segment. Bound it so a junk request cannot write an unbounded
 * string, and so the aggregate key stays a key.
 */
const MAX_PLAY_SESSION_ID_CHARS = 200;

/** Stream directory names are short (`video_0`, `audio_1`); bound them too. */
const MAX_STREAM_VARIANT_CHARS = 64;

/**
 * Map an HTTP status onto a category.
 *
 * 503 is `not_ready` rather than an error: the handler answers it deliberately
 * while a job is still producing, precisely so Apple clients retry instead of
 * penalty-boxing the variant. Seeing a burst of `not_ready` is the system
 * working — seeing `gone` mid-session is the bug that costs a viewer their
 * stream.
 */
export function categorizeSegmentFailure(status: number): SegmentFailureCategory | null {
    if (status < 400) return null;
    if (status === 503) return 'not_ready';
    if (status === 404 || status === 410) return 'gone';
    if (status === 401 || status === 403) return 'forbidden';
    if (status >= 500) return 'server_error';
    return 'bad_request';
}

/**
 * Classify what was being fetched from the request path's shape.
 *
 * Shape only — the path is never stored. Order matters: an init segment and a
 * subtitle segment both end in a media extension, so the more specific tests
 * run first.
 */
export function classifySegmentResource(segmentPath: string | undefined): SegmentResourceKind {
    if (!segmentPath) return 'other';
    const path = segmentPath.split('?')[0];
    if (path.endsWith('.vtt') || /subs_/.test(path)) return 'subtitle';
    if (/init\.mp4$/.test(path) || /^init/.test(path.split('/').pop() ?? '')) return 'init';
    if (path.endsWith('.m3u8')) {
        // The master is the only playlist served from the output root; every
        // media playlist lives under its stream directory.
        return path.includes('/') ? 'media_playlist' : 'master_playlist';
    }
    if (/\.(ts|m4s|mp4|aac)$/.test(path)) return 'segment';
    return 'other';
}

/**
 * The stream directory a path is addressing (`video_0/seg_1.m4s` → `video_0`),
 * or null when the path has none. A directory name, never the full path.
 */
export function extractStreamVariant(segmentPath: string | undefined): string | null {
    if (!segmentPath) return null;
    const parts = segmentPath.split('?')[0].split('/').filter(Boolean);
    if (parts.length < 2) return null;
    // A traversal-shaped path has no meaningful "stream directory" — bail on
    // the whole path rather than reading a name out of the middle of it, which
    // would store an attacker-chosen string ('../../etc/passwd' yields 'etc').
    if (parts.some((part) => part === '.' || part === '..')) return null;
    const dir = parts[parts.length - 2];
    // Plain names only: a real stream directory is `video_0`/`audio_1`.
    if (!/^[A-Za-z0-9_-]+$/.test(dir)) return null;
    return dir.slice(0, MAX_STREAM_VARIANT_CHARS);
}

/**
 * Record one non-2xx segment/playlist response.
 *
 * Fire-and-forget by construction — returns void so no caller can await it,
 * and swallows every failure. A 2xx status, or a request with no play session
 * id to attribute the failure to, is a no-op.
 */
export function recordFailure(params: {
    playSessionId: string | undefined | null;
    status: number;
    segmentPath: string | undefined;
}): void {
    const category = categorizeSegmentFailure(params.status);
    if (!category) return;

    const playSessionId = params.playSessionId?.trim();
    // No session id means nothing to correlate the failure to, and the whole
    // value of this table is per-session correlation. Drop it rather than
    // accumulating unattributable rows.
    if (!playSessionId || playSessionId.length > MAX_PLAY_SESSION_ID_CHARS) return;

    const sql = getDb();
    if (!sql) return;

    void recordSegmentDeliveryFailure(sql, {
        playSessionId,
        category,
        httpStatus: params.status,
        resourceKind: classifySegmentResource(params.segmentPath),
        streamVariant: extractStreamVariant(params.segmentPath),
    }).catch((err) => {
        // Debug, not warn: this is diagnostics about diagnostics. A failing
        // recorder must not add noise to the logs of an install that is
        // already having a bad time serving segments.
        logger.debug('Failed to record segment delivery failure', {
            error: err instanceof Error ? err.message : String(err),
        });
    });
}
