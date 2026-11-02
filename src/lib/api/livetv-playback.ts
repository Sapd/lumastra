// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Frontend API client for LiveTV playback operations.
 *
 * Separate from livetv.ts (admin operations) — these are viewer-facing endpoints.
 */

import { apiGet, apiPost, apiDelete } from './client.js';
import type { ApiResult } from './types.js';
import {
    StreamLimitErrorResponseSchema,
    ProgramSearchResponseSchema,
    GuideResponseSchema,
    StationProgramsResponseSchema,
    LiveTvStationFeedsSchema,
    type LiveTvStationFeeds,
    type StreamLimitErrorResponse,
    type GroupedProgramSearchResult,
    type ProgramSearchItem,
    type ProgramSearchResponse,
    type GuideResponse,
} from '$lib/schemas/livetv.js';
import type { z } from 'zod';
import { pickNowNext } from '$lib/shared/livetv-now-next';
import {
    PlaybackSessionStartResponseSchema,
    type PlaybackSessionStartResponse,
} from '$lib/schemas/livetv-playback-sessions.js';
import {
    parseLiveTvFailureProblem,
    parseLiveTvSessionFailure,
    type LiveTvFailureInfo,
} from './livetv-failure-problem.js';
import { isRecord } from '$lib/utils/data-extraction.js';
import { NoContentSchema } from '$lib/schemas/common.js';
import type { LiveTvQualityChoice } from '$lib/components/player/livetv-quality-preference.js';
import { getLiveTvHevcSupport } from '$lib/components/player/livetv-hevc-support.js';

/**
 * Read the structured payload out of a problem+json `details` field, which the
 * server sends either as an object or as a JSON string.
 */
function problemDetailsRecord(details: unknown): Record<string, unknown> | null {
    if (isRecord(details)) return details;
    if (typeof details !== 'string') return null;
    try {
        const parsed: unknown = JSON.parse(details);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * The player's HEVC capability for the stream join, so an HEVC channel is served in a form
 * this browser decodes (fMP4 for Safari's native HLS, H.264 without HEVC). Omitted outside
 * a browser.
 */
function hevcParam(): { hevc?: string } {
    const hevc = getLiveTvHevcSupport();
    return hevc ? { hevc } : {};
}

/**
 * Get stream info for a channel — initiates watching.
 */
export function getStreamInfo(
    stationId: string,
    quality: LiveTvQualityChoice = 'server',
    feedId?: string,
) {
    return apiPost('/api/livetv/playback-sessions', PlaybackSessionStartResponseSchema, {
        stationId,
        feedId,
        quality,
        ...hevcParam(),
    });
}

/**
 * The feeds of the station a channel belongs to (viewer feed picker). 403 while
 * the administrator has feed choice turned off, 404 for a channel the viewer
 * cannot open.
 */
export function getStationFeeds(channelId: string): Promise<ApiResult<LiveTvStationFeeds>> {
    return apiGet(
        `/api/livetv/stations/${encodeURIComponent(channelId)}/feeds`,
        LiveTvStationFeedsSchema,
    );
}

/**
 * Get stream info with structured 503 stream limit handling.
 * Returns a discriminated union so callers can handle stream limits vs other errors.
 */
export async function getStreamInfoWithLimitCheck(
    channelId: string,
    qualityOrLegacyMaxBitrate: LiveTvQualityChoice | number = 'server',
    signal?: AbortSignal,
    feedId?: string,
    /** `preview` starts a hover preview: its own viewer, never superseding real playback. */
    purpose?: 'playback' | 'preview',
): Promise<
    | { ok: true; streamInfo: PlaybackSessionStartResponse }
    | { ok: false; kicked: true; reason: string }
    | { ok: false; streamLimit: StreamLimitErrorResponse }
    | { ok: false; failure: LiveTvFailureInfo }
    | { ok: false; capUnavailable: string }
    | { ok: false; error: string; status?: number }
> {
    let response: Response;
    try {
        response = await fetch('/api/livetv/playback-sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                stationId: channelId,
                feedId,
                ...(purpose === 'preview' ? { purpose } : {}),
                ...(typeof qualityOrLegacyMaxBitrate === 'number'
                    ? { maxBitrateBps: qualityOrLegacyMaxBitrate }
                    : { quality: qualityOrLegacyMaxBitrate }),
                ...hevcParam(),
            }),
            signal,
        });
    } catch {
        // Network error — the app/proxy could not be reached at all.
        return {
            ok: false,
            failure: {
                kind: 'failure',
                code: 'dependency_unavailable',
                retryable: true,
                retryAfterMs: 5_000,
            },
        };
    }
    try {
        if (response.ok) {
            const data = PlaybackSessionStartResponseSchema.parse(await response.json());
            return { ok: true, streamInfo: data };
        }
        if (response.status === 410) {
            // Session ends are terminal; only eviction means taken over.
            const body = await response.json();
            const reason = isRecord(body)
                ? typeof body.reason === 'string'
                    ? body.reason
                    : typeof body.details === 'string'
                      ? body.details
                      : undefined
                : undefined;
            if (reason === 'superseded' || reason === 'left')
                return { ok: false, error: reason, status: 410 };
            return {
                ok: false,
                kicked: true,
                reason: reason ?? 'evicted',
            };
        }
        const body: unknown = await response.json().catch(() => null);
        if (response.status === 503 || response.status === 409) {
            const parsed = StreamLimitErrorResponseSchema.safeParse(body);
            if (parsed.success) {
                return { ok: false, streamLimit: parsed.data };
            }
            // problem+json (the shape the /api/livetv stream def actually emits):
            // the structured payload rides JSON-encoded in `details`, so the flat
            // legacy schema above never matches. Without this branch every real
            // capacity refusal degraded to the generic "Stream unavailable (503)".
            if (isRecord(body) && body.code === 'stream_limit') {
                const payload = problemDetailsRecord(body.details);
                if (payload) {
                    const detailsParsed = StreamLimitErrorResponseSchema.safeParse({
                        error: 'stream_limit_reached',
                        ...payload,
                    });
                    if (detailsParsed.success) {
                        return { ok: false, streamLimit: detailsParsed.data };
                    }
                }
            }
            // A refused quality ceiling is recoverable — the channel itself is fine,
            // only the requested rung/ladder is not. Surfaced as its own variant so
            // the player can retry at Original instead of showing a dead screen.
            if (isRecord(body) && body.code === 'cap_unavailable') {
                return {
                    ok: false,
                    capUnavailable: typeof body.details === 'string' ? body.details : 'unavailable',
                };
            }
        }
        // A typed taxonomy failure (channel_offline, provider_auth_failed, ...).
        const failure = parseLiveTvFailureProblem(body);
        if (failure) return { ok: false, failure };
    } catch {
        // JSON parse or Zod validation failure — fall through to generic error
    }
    return {
        ok: false,
        error: `Stream unavailable (${response.status})`,
        status: response.status,
    };
}

/**
 * Send heartbeat to keep the stream session alive.
 */
// Preserve the typed termination reason; successful keepalive has no body. A 410 with
// reason 'failed' also carries the taxonomy code in `failure`.
export async function sendHeartbeat(keepaliveHref: string, signal?: AbortSignal) {
    const response = await fetch(keepaliveHref, {
        method: 'POST',
        signal,
    });
    if (response.ok)
        return {
            status: response.status,
            error: null,
            reason: undefined,
            failure: undefined as LiveTvFailureInfo | undefined,
        };
    const body: unknown = await response.json().catch(() => null);
    const reason = isRecord(body) && typeof body.reason === 'string' ? body.reason : undefined;
    return {
        status: response.status,
        error: isRecord(body) && typeof body.error === 'string' ? body.error : 'heartbeat_failed',
        reason,
        failure: reason === 'failed' ? (parseLiveTvFailureProblem(body) ?? undefined) : undefined,
    };
}

/**
 * Why a Live TV playback session ended: the typed failure when the channel failed
 * (`endReason: 'failed'`), else `null`. Used by the player after a media request
 * answered 410 to learn the code. Never throws.
 */
export async function getPlaybackSessionFailure(
    sessionId: string,
    signal?: AbortSignal,
): Promise<LiveTvFailureInfo | null> {
    try {
        const response = await fetch(
            `/api/livetv/playback-sessions/${encodeURIComponent(sessionId)}`,
            { signal },
        );
        if (!response.ok) return null;
        return parseLiveTvSessionFailure(await response.json());
    } catch {
        return null;
    }
}

/**
 * Leave a channel stream session.
 */
// 204 No Content — see the note on the identical helper in $lib/api/playback.ts.
export function leaveChannel(sessionId: string) {
    return apiDelete(
        `/api/livetv/playback-sessions/${encodeURIComponent(sessionId)}`,
        NoContentSchema,
    );
}

/**
 * Search EPG airings by query text (`/api/livetv/programs/search`): `{ items, page }`
 * with one item per airing, keyed by `stationId`. Group them for display with
 * {@link groupProgramAirings}.
 */
export function searchPrograms(
    query: string,
    limit: number = 30,
): Promise<ApiResult<ProgramSearchResponse>> {
    return apiGet(
        `/api/livetv/programs/search?q=${encodeURIComponent(query)}&limit=${limit}`,
        ProgramSearchResponseSchema,
    );
}

/**
 * Merge airings of the same show (title, UTC day, temporal status) across stations into
 * one row with a station list, keeping the server's order (live first, then relevance).
 */
export function groupProgramAirings(items: ProgramSearchItem[]): GroupedProgramSearchResult[] {
    const groups = new Map<string, GroupedProgramSearchResult>();
    for (const item of items) {
        const key = `${item.title.toLowerCase()}|${item.startTime.slice(0, 10)}|${item.temporalStatus}`;
        const group = groups.get(key);
        if (!group) {
            groups.set(key, {
                title: item.title,
                description: item.description,
                temporalStatus: item.temporalStatus,
                startTime: item.startTime,
                endTime: item.endTime,
                channels: [item.station],
            });
            continue;
        }
        if (item.startTime < group.startTime) group.startTime = item.startTime;
        if (item.endTime > group.endTime) group.endTime = item.endTime;
        group.description ??= item.description;
        if (!group.channels.some((station) => station.id === item.station.id)) {
            group.channels.push(item.station);
        }
    }
    return [...groups.values()];
}

/**
 * Fetch bulk EPG programs in the given time window: for all channels, or only
 * for `stationIds` when given.
 */
export async function fetchGuidePrograms(
    from: Date,
    to: Date,
    stationIds?: string[],
): Promise<ApiResult<GuideResponse>> {
    if (stationIds?.length === 0) {
        return {
            data: {
                window: {
                    from: from.toISOString(),
                    to: to.toISOString(),
                    asOf: new Date().toISOString(),
                },
                stations: [],
                page: { limit: 200, nextCursor: null, hasMore: false },
            },
            error: null,
            status: 200,
        };
    }
    const stations = new Map<string, GuideResponse['stations'][number]>();
    const unknown = new Set<string>();
    let last: ApiResult<GuideResponse> | undefined;
    let asOf: string | undefined;
    const scopes: (string[] | undefined)[] = stationIds
        ? Array.from({ length: Math.ceil(stationIds.length / 50) }, (_, index) =>
              stationIds.slice(index * 50, (index + 1) * 50),
          )
        : [undefined];
    // Split every caller's window, including availability refreshes after the
    // guide has been extended. Each time slice pages the complete lineup.
    const maxSpan = 24 * 60 * 60 * 1000;
    for (let start = from.getTime(); start < to.getTime(); start += maxSpan) {
        const end = Math.min(start + maxSpan, to.getTime());
        for (const scope of scopes) {
            let cursor: string | null = null;
            const seenCursors = new Set<string>();
            let pages = 0;
            do {
                const params = new URLSearchParams({
                    from: new Date(start).toISOString(),
                    to: new Date(end).toISOString(),
                });
                if (scope) params.set('stationIds', scope.join(','));
                else params.set('limit', '200');
                if (cursor) params.set('cursor', cursor);
                last = await apiGet(`/api/livetv/guide?${params}`, GuideResponseSchema);
                if (last.error || !last.data) return last;
                asOf ??= last.data.window.asOf;
                for (const station of last.data.stations) {
                    const previous = stations.get(station.stationId);
                    const byId = new Map(
                        [...(previous?.airings ?? []), ...station.airings].map((airing) => [
                            airing.id,
                            airing,
                        ]),
                    );
                    const airings = [...byId.values()].sort(
                        (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime),
                    );
                    stations.set(station.stationId, { ...station, airings });
                }
                for (const id of last.data.unknownStationIds ?? []) unknown.add(id);
                cursor = !scope && last.data.page.hasMore ? last.data.page.nextCursor : null;
                pages++;
                if (cursor && seenCursors.has(cursor)) break;
                if (cursor) seenCursors.add(cursor);
            } while (cursor && pages < 100);
        }
    }
    if (!last?.data || asOf === undefined)
        return { data: null, error: 'Invalid guide window', status: 422 };
    return {
        ...last,
        data: {
            window: { from: from.toISOString(), to: to.toISOString(), asOf },
            stations: [...stations.values()].map((station) => ({
                ...station,
                nowNext: pickNowNext(station.airings, Date.parse(asOf)),
            })),
            ...(unknown.size ? { unknownStationIds: [...unknown] } : {}),
            page: { limit: 200, nextCursor: null, hasMore: false },
        },
    };
}

export type ChannelProgramsResponse = z.infer<typeof StationProgramsResponseSchema>;

/** Fetch a station schedule within an explicit UTC window (at most 24 hours). */
export function getChannelPrograms(
    stationId: string,
    from: string,
    to: string,
): Promise<ApiResult<ChannelProgramsResponse>> {
    const params = new URLSearchParams({ from, to });
    return apiGet(
        `/api/livetv/stations/${encodeURIComponent(stationId)}/programs?${params}`,
        StationProgramsResponseSchema,
    );
}

let pendingSession: PlaybackSessionStartResponse | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

export function handoffPlaybackSession(info: PlaybackSessionStartResponse): void {
    if (pendingSession) void leaveChannel(pendingSession.playbackSessionId);
    clearTimeout(pendingTimer);
    pendingSession = info;
    pendingTimer = setTimeout(() => {
        if (pendingSession?.playbackSessionId !== info.playbackSessionId) return;
        pendingSession = null;
        void leaveChannel(info.playbackSessionId);
    }, info.reporting.intervalMs);
}

export function claimPlaybackSession(stationId: string): PlaybackSessionStartResponse | null {
    if (pendingSession?.stationId !== stationId) return null;
    clearTimeout(pendingTimer);
    const info = pendingSession;
    pendingSession = null;
    return info;
}
