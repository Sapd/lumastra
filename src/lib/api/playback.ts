// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback API domain module
 *
 * Typed functions for playback info, progress reporting, stream URLs,
 * live TV, telemetry, sessions, device management, and preferences.
 */

import { playbackIncidentEvent } from '$lib/client-diagnostics/playback-incident.js';
import { DiagnosticIngestResponseSchema } from '$lib/schemas/client-diagnostics.js';
import { version } from '$app/environment';
import { apiGet, apiPost, apiPatch, apiDelete } from './client.js';
import type { ApiRequestOptions, ApiResult } from './types.js';
import {
    LiveTvStationsResponseSchema,
    TelemetryResponseSchema,
    PagedSessionsResponseSchema,
    ActiveSessionSchema,
    SessionsResponseSchema,
    JellyfinEpisodeResponseSchema,
    TimelineResponseSchema,
    CreatePreviewResponseSchema,
} from '$lib/schemas/api-playback-responses';
import {
    PlaybackStartResponseSchema,
    type PlaybackStartRequest,
} from '$lib/schemas/playback-start.js';
import {
    PlayabilityResponseSchema,
    type PlayabilityRequest,
    type PlayabilityResponse,
} from '$lib/schemas/api-playability.js';
import { NoContentSchema } from '$lib/schemas/common.js';
import { SpeedTestResultResponseSchema } from '$lib/schemas/api-network-responses.js';
import type {
    PlaybackIncidentReportInput,
    PlaybackIncidentResolveInput,
    SpeedTestResultInput,
} from '$lib/schemas/playback.js';

/** Catalog timeline for detail views before a playback session exists. */
export function getTimeline(itemId: string, fileId?: string) {
    const params = fileId ? `?fileId=${encodeURIComponent(fileId)}` : '';
    return apiGet(
        `/api/playback/${encodeURIComponent(itemId)}/timeline${params}`,
        TimelineResponseSchema,
    );
}

/** Follow the selected-file timeline issued by playback start. */
export function getTimelineByHref(href: string) {
    return apiGet(href, TimelineResponseSchema);
}

// =========================================================================
// LiveTV Channels
// =========================================================================

export function getLiveTvChannels() {
    return apiGet('/api/livetv/stations', LiveTvStationsResponseSchema);
}

// =========================================================================
// Telemetry
// =========================================================================

export function flushTelemetry(body: {
    playbackSessionId: string;
    deviceId?: string;
    clientType: string;
    events: unknown[];
}) {
    // The endpoint is a fire-and-forget sink that acknowledges with 204 (no
    // body); `.nullable()` lets the client accept that without a dev-mode
    // "204 schema mismatch" warning, while still validating a body if one is
    // ever returned. The result is not consumed by the caller.
    return apiPost('/api/playback/telemetry', TelemetryResponseSchema.nullable(), body);
}

// =========================================================================
// Network speed test
// =========================================================================

/**
 * Store the timings the client measured while downloading
 * `/api/network/speed-test`. The download endpoint records nothing, so this POST
 * is the entire trace of a test — and the 201 body carries the server-derived
 * throughput / slowest-bucket / stall numbers the UI displays (a client-supplied
 * summary is deliberately not accepted).
 *
 * Internal surface (cookie/forward-auth), like every other call in this module.
 */
export function postSpeedTestResult(body: SpeedTestResultInput) {
    return apiPost('/api/network/speed-test/results', SpeedTestResultResponseSchema, body);
}

// =========================================================================
// Playback Incidents
// =========================================================================

/**
 * Reports a client-observed playback error, reconnect, or terminal failure,
 * with a short window of lead-up context. Best-effort from the caller's
 * perspective — IncidentReporter (incident-reporter.ts) already swallows
 * delivery failures so a reporting hiccup never affects playback.
 */
export function reportPlaybackIncident(body: PlaybackIncidentReportInput) {
    return apiPost('/api/diagnostics/events', DiagnosticIngestResponseSchema, {
        events: [playbackIncidentEvent(body)],
    });
}

/**
 * Marks EVERY unresolved incident for `body.attemptId` as resolved, not just
 * the most recent one — a single attempt can accumulate several unresolved
 * rows before it recovers. A no-op (still resolves cleanly) if none exists.
 */
export function resolvePlaybackIncident(body: PlaybackIncidentResolveInput) {
    return apiPatch('/api/diagnostics/events/resolve', NoContentSchema, body);
}

// =========================================================================
// Sessions
// =========================================================================

/** Home widget: the same enriched, viewer-visible streams as its SSR seed. */
export function getHomeActiveSessions(options?: ApiRequestOptions) {
    return apiGet('/api/home/active-sessions', SessionsResponseSchema, {
        ...options,
        params: { ...options?.params, _t: Date.now() },
    });
}

/** List own playback sessions, or all sessions for an admin. */
export async function getActiveSessions(scope: 'mine' | 'all', options?: ApiRequestOptions) {
    const result = await apiGet('/api/play-sessions', PagedSessionsResponseSchema, {
        ...options,
        // `scope` is spread LAST so it always wins over a caller-supplied
        // `options.params.scope` — otherwise `{ params: { scope: 'all' } }`
        // would silently override the required positional argument above,
        // with no type error (params is a loosely-typed bag).
        params: { ...options?.params, _t: Date.now(), scope },
    });
    return {
        ...result,
        data: result.data
            ? {
                  ...result.data,
                  items: result.data.items.map((s) =>
                      ActiveSessionSchema.parse({
                          __id: s.playbackSessionId,
                          id: s.mediaId,
                          mediaItemId: s.mediaId,
                          title: s.title,
                          mediaType:
                              s.kind === 'music'
                                  ? 'music'
                                  : s.kind === 'live'
                                    ? 'tvchannel'
                                    : (s.mediaType ?? 'movie'),
                          playIsPlaying: s.status === 'ACTIVE',
                          playCurrentTime: s.positionMs / 1000,
                          playItemDuration: (s.durationMs ?? 0) / 1000,
                          deviceId: s.device.id,
                          clientname: s.device.name ?? undefined,
                          username: s.user?.displayName ?? undefined,
                          userId: s.user?.userId,
                      }),
                  ),
              }
            : result.data,
    };
}

/**
 * Stop a single play session the current user owns (or any, if admin).
 * Internal surface (cookie/forward-auth) — NOT /api/v1. 204 → { data: null }.
 */
export function cancelSession(sessionId: string, options?: ApiRequestOptions) {
    return apiDelete(
        `/api/play-sessions/${encodeURIComponent(sessionId)}`,
        NoContentSchema,
        undefined,
        options,
    );
}

// =========================================================================
// Preview Session
// =========================================================================

/** Release the dedicated preview when its memo releases the source. */
export function releasePreviewPlayback(previewSessionId: string): void {
    void apiDelete(
        `/api/playback/previews/${encodeURIComponent(previewSessionId)}`,
        NoContentSchema,
    ).catch(() => {});
}

export async function createPreviewSession(
    itemId: string,
    body: {
        startPositionSeconds?: number;
        internalId: string;
        fileId?: string;
        isLiveTv?: boolean;
        heroSafeCodec?: boolean;
        trailerPreferred?: boolean;
        trailerRequired?: boolean;
    },
) {
    const { internalId, ...options } = body;
    const result = await apiPost('/api/playback/previews', CreatePreviewResponseSchema, {
        mediaId: internalId || itemId,
        ...options,
    });
    const preview = result.data;
    return {
        ...result,
        data:
            preview && preview.mode !== 'none'
                ? {
                      playSessionId: preview.id,
                      sessionItemId: preview.mediaId,
                      streamUrl: preview.streamUrl,
                      playMethod: preview.playMethod,
                      transcodeMode: preview.transcodeMode,
                      hlsStartPosition: preview.hlsStartPosition,
                      mode: preview.mode,
                      reporting: preview.reporting,
                  }
                : preview,
    };
}

// =========================================================================
// Playability probe (no session or delivery URLs)
// =========================================================================

/** A busy probe is temporary: keep the player loading through Retry-After. */
export async function probePlayability(
    itemId: string,
    body: PlayabilityRequest,
    isCurrent: () => boolean = () => true,
): Promise<ApiResult<PlayabilityResponse>> {
    const probe = (): Promise<ApiResult<PlayabilityResponse>> =>
        apiPost(
            `/api/media/${encodeURIComponent(itemId)}/playability`,
            PlayabilityResponseSchema,
            body,
        );
    let result = await probe();
    for (let retry = 0; retry < 2 && result.status === 429 && isCurrent(); retry++) {
        await new Promise<void>((resolve) => setTimeout(resolve, result.retryAfterMs ?? 1000));
        // Navigation or another version selection invalidates the waiting probe.
        if (!isCurrent()) return result;
        result = await probe();
    }
    return result;
}

// =========================================================================
// Jellyfin Episode Proxy
// =========================================================================

export function findJellyfinEpisode(body: { seriesName: string; season: number; episode: number }) {
    return apiPost('/api/jellyfin/episode', JellyfinEpisodeResponseSchema, body);
}

// =========================================================================
// Play Sessions
// =========================================================================

export function startPlaySession(body: PlaybackStartRequest) {
    return apiPost('/api/play-sessions', PlaybackStartResponseSchema, {
        ...body,
        clientInfo: {
            ...body.clientInfo,
            client: 'web',
            version,
            userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
        },
    });
}

// =========================================================================
// LiveTV Channel Leave
// =========================================================================

// The endpoint answers 204 No Content — declaring a `{ success: true }` body made
// every leave log a 204-schema-mismatch warning, because the client validates `null`
// against the declared schema on a bodyless response.
export function leaveChannel(sessionId: string) {
    return apiDelete(
        `/api/livetv/playback-sessions/${encodeURIComponent(sessionId)}`,
        NoContentSchema,
    );
}
