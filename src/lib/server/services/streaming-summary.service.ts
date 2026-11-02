// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Streaming-summary service — builds the compact, ambient "Streaming now" payload
 * for the admin Operations drawer. Read-only; NOT part of the attention model.
 *
 * Cheap by construction: one bounded query over play_sessions + one Valkey-backed
 * bandwidth gauge read. Safe to call on the drawer's open-gated poll.
 */

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getActiveStreams,
    type ActiveStreamRow,
} from '$lib/server/database/queries/streaming-summary.queries.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import type {
    StreamingSummary,
    StreamMethod,
    StreamRow,
} from '$lib/schemas/api-streaming-responses.js';

const logger = Logger.for('StreamingSummaryService');

/** How many per-stream rows the compact strip shows before "+N more". */
const STREAM_CAP = 8;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Collapse the 4 wire play-methods to the 3 the operator cares about. Unknown/null
 *  defaults to 'direct' — the least-alarming, most-common case for mirrored sessions. */
function coarseMethod(playMethod: string | null): StreamMethod {
    if (playMethod === 'full_transcode' || playMethod === 'audio_transcode') return 'transcode';
    if (playMethod === 'remux') return 'remux';
    return 'direct';
}

function rowTitle(r: ActiveStreamRow): string {
    if (r.series_title) {
        if (r.season_number != null && r.episode_number != null) {
            return `${r.series_title} · S${pad(r.season_number)}E${pad(r.episode_number)}`;
        }
        return r.series_title;
    }
    return r.media_title ?? 'Unknown';
}

function mapRow(r: ActiveStreamRow): StreamRow {
    const row: StreamRow = {
        user: r.user_id ?? 'unknown',
        username: r.owner_username ?? r.user_id ?? 'unknown',
        title: rowTitle(r),
        method: coarseMethod(r.play_method),
    };
    if (r.source) row.source = r.source;
    if (r.device_id) row.deviceId = r.device_id;
    if (r.bitrate_kbps != null && r.bitrate_kbps > 0) {
        row.bitrateMbps = Math.round((r.bitrate_kbps / 1000) * 10) / 10;
    }
    if (r.runtime_ms != null && r.runtime_ms > 0 && r.position_ms != null) {
        row.progress = Math.min(1, Math.max(0, r.position_ms / r.runtime_ms));
    }
    if (r.status === 'PAUSED') row.paused = true;
    return row;
}

/**
 * Pure projection of session rows + an aggregate bandwidth gauge into the wire shape.
 * Extracted so the mapping is unit-testable without a DB or Valkey.
 *
 * `aggregateMbps` is the real proxied throughput (bytes the app is pushing). When it
 * is 0/unknown — e.g. all traffic is direct-Jellyfin the app never proxies — we fall
 * back to the summed declared bitrate so the headline isn't a misleading "0 Mbps".
 */
export function buildStreamingSummary(
    rows: ActiveStreamRow[],
    aggregateMbps: number | null,
    cap = STREAM_CAP,
): StreamingSummary {
    const streams = rows.map(mapRow);
    const declaredMbps = streams.reduce((sum, s) => sum + (s.bitrateMbps ?? 0), 0);
    const proxied = aggregateMbps ?? 0;
    const bandwidthMbps = Math.round((proxied > 0 ? proxied : declaredMbps) * 10) / 10;
    return {
        streamCount: streams.length,
        userCount: new Set(rows.map((r) => r.user_id ?? 'unknown')).size,
        transcodeCount: streams.filter((s) => s.method === 'transcode').length,
        bandwidthMbps,
        streams: streams.slice(0, cap),
    };
}

/** Fetch + build the summary. Bandwidth is best-effort: a gauge hiccup must not fail
 *  the (already best-effort) ambient strip. */
export async function getStreamingSummary(
    sql: postgres.Sql,
    cap = STREAM_CAP,
): Promise<StreamingSummary> {
    const rows = await getActiveStreams(sql, 100);
    let aggregateMbps: number | null = null;
    try {
        const metrics = await bandwidthTracker.getAggregatedMetrics();
        aggregateMbps = metrics?.totalMbps ?? null;
    } catch (err) {
        logger.warn('bandwidth gauge read failed; falling back to declared bitrate', { err });
    }
    return buildStreamingSummary(rows, aggregateMbps, cap);
}
