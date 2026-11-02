// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for Playback API routes
 *
 * Provides validation for playback operations including streaming,
 * telemetry, trickplay, and subtitles.
 */

import { z } from 'zod';
import { nonEmptyStringSchema } from './common';

// ============================================================================
// Common Playback Parameters
// ============================================================================

/**
 * Schema for item ID path parameter
 * Used across all /api/playback/[itemId]/* routes
 */
export const itemIdParamsSchema = z.object({
    itemId: nonEmptyStringSchema,
});

export type ItemIdParams = z.infer<typeof itemIdParamsSchema>;

// ============================================================================
// Telemetry Schemas
// ============================================================================

/**
 * Valid client telemetry metric types
 */
export const clientMetricTypeSchema = z.enum([
    'bandwidth_estimate',
    'buffer_health',
    'rebuffer_event',
    'rebuffer_duration',
    'quality_switch',
    'playback_stall',
    'buffer_starvation',
    'playback_start',
    'playback_error',
    'seeking',
    'media_bitrate',
    'reconnect_event',
    'media_stalled',
    'delivery_window', // receiver-timed 30 s delivery window (value = achieved bps; metadata = spec Part 1)
]);

export type ClientMetricType = z.infer<typeof clientMetricTypeSchema>;

/**
 * Valid client types for telemetry
 */
export const clientTypeSchema = z.enum(['hls_js', 'native_hls', 'unknown']);

// ----------------------------------------------------------------------------
// Telemetry guard rails (L11 / L12)
// ----------------------------------------------------------------------------

/**
 * Maximum length of a telemetry deviceId (L11). Mirrors the
 * playback_session_quality.device_id / playback_telemetry.device_id text columns.
 */
const TELEMETRY_DEVICE_ID_MAX = 255;

/**
 * Bounds for telemetry event metadata (L12). Legitimate structured metadata
 * exists (codecs, dimensions, error detail), so we do NOT narrow the value type
 * to string-only — we cap size/shape instead:
 *   - at most this many top-level keys
 *   - serialized JSON no larger than this many bytes
 * This blocks unbounded payloads from a hostile/buggy client without rejecting
 * real structured telemetry.
 */
const TELEMETRY_METADATA_MAX_KEYS = 32;
const TELEMETRY_METADATA_MAX_BYTES = 4096;

/**
 * Shared refinement that bounds a telemetry metadata record's key count and
 * serialized size. Apply to a `z.record(...)` before `.optional()`.
 */
export function withMetadataSizeLimit<T extends z.ZodTypeAny>(schema: T) {
    return schema.refine(
        (value: unknown): boolean => {
            if (value === undefined || value === null) return true;
            if (typeof value !== 'object') return true;
            const keys = Object.keys(value as Record<string, unknown>);
            if (keys.length > TELEMETRY_METADATA_MAX_KEYS) return false;
            try {
                return JSON.stringify(value).length <= TELEMETRY_METADATA_MAX_BYTES;
            } catch {
                // Non-serializable (cycles, etc.) — reject as malformed.
                return false;
            }
        },
        {
            message: `metadata exceeds limits (max ${TELEMETRY_METADATA_MAX_KEYS} keys, ${TELEMETRY_METADATA_MAX_BYTES} bytes serialized)`,
        },
    );
}

/**
 * Telemetry deviceId field (L11) — optional, capped at 255 chars.
 */
const telemetryDeviceIdSchema = z.string().max(TELEMETRY_DEVICE_ID_MAX).optional();

/**
 * Schema for a single telemetry event
 */
export const telemetryEventSchema = z.object({
    type: clientMetricTypeSchema,
    value: z.number(),
    metadata: withMetadataSizeLimit(z.record(z.string(), z.string())).optional(),
    timestamp: z.number(),
});

export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

/**
 * Schema for telemetry report
 * POST /api/playback/telemetry
 */
export const telemetryReportSchema = z.object({
    // M9: playbackSessionId references play_sessions.id (uuid) — validate as UUID.
    playbackSessionId: z.string().guid(),
    // L11: cap deviceId length to match the device_id text column.
    deviceId: telemetryDeviceIdSchema,
    clientType: clientTypeSchema,
    events: z.array(telemetryEventSchema).min(0).max(100),
});

export type TelemetryReportInput = z.infer<typeof telemetryReportSchema>;

// ============================================================================
// Stream Schemas
// ============================================================================

// ============================================================================
// Trickplay Schemas
// ============================================================================

/**
 * Schema for trickplay path parameters
 * GET /api/playback/[itemId]/trickplay/[width]
 */
/**
 * Trickplay route params.
 *
 * `itemId` is OPTIONAL on purpose. The media-id param is named by whichever
 * route mounts the handler, and the two mounts disagree: the internal route is
 * `/api/playback/[itemId]/trickplay/…` while the v1 route is
 * `/api/v1/playback/[id]/trickplay/…` (it re-exports the internal handler with
 * `export *`, so the handler runs under the V1 route's param names). Requiring
 * `itemId` therefore 422'd EVERY v1 request — `params.itemId` is never bound
 * there — which silently disabled seek-preview thumbnails for every native
 * client, on items that had hundreds of generated tiles ready to serve.
 *
 * Neither handler actually reads it: the id arrives as
 * `locals.resolvedIds.internalId` from `withIdResolution`, which accepts
 * `id | mediaId | itemId | seriesId`. Only `width` is consumed here, so this
 * schema validates shape, not identity — do not re-tighten it to one name.
 */
export const trickplayParamsSchema = z.object({
    itemId: nonEmptyStringSchema.optional(),
    id: nonEmptyStringSchema.optional(),
    width: z.coerce.number().int().positive(),
});

export type TrickplayParams = z.infer<typeof trickplayParamsSchema>;

/**
 * Schema for trickplay query parameters
 */
export const trickplayQuerySchema = z.object({
    index: z.coerce.number().int().min(0).optional().default(0),
    fileId: z.string().optional(),
});

export type TrickplayQueryParams = z.infer<typeof trickplayQuerySchema>;

/**
 * Schema for chapter query parameters
 */
export const timelineQuerySchema = z.object({
    fileId: z.string().optional(),
});

export type TimelineQueryParams = z.infer<typeof timelineQuerySchema>;

// ============================================================================
// Trickplay Generation Schemas
// ============================================================================

/**
 * Schema for trickplay generation request body
 * POST /api/admin/media/[id]/trickplay/generate
 */
export const trickplayGenerateBodySchema = z.object({
    width: z.number().int().positive().max(1920).optional(),
    force: z.boolean().optional(),
});

export type TrickplayGenerateBodyInput = z.infer<typeof trickplayGenerateBodySchema>;

/**
 * Schema for image sync request body
 * POST /api/admin/media/[id]/images/sync
 */
export const imageSyncBodySchema = z.object({
    mode: z.enum(['execute', 'plan']).optional(),
    scope: z.enum(['series', 'season', 'episode']).optional(),
    extractVideo: z.boolean().optional(),
    artworkType: z.enum(['poster', 'backdrop', 'thumb']).optional(),
    force: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
});

export type ImageSyncBodyInput = z.infer<typeof imageSyncBodySchema>;

// ============================================================================
// Subtitles Schemas
// ============================================================================

/**
 * Schema for subtitle path parameters
 * GET /api/playback/subtitles/[itemId]/[index]
 */
export const subtitleParamsSchema = z.object({
    itemId: nonEmptyStringSchema,
    index: z.coerce.number().int().min(0),
});

export type SubtitleParams = z.infer<typeof subtitleParamsSchema>;

/**
 * Valid subtitle formats
 */
export const subtitleFormatSchema = z.enum(['vtt', 'srt', 'ass', 'pgssub', 'sub']);

/**
 * Schema for subtitle query parameters
 */
export const subtitleQuerySchema = z.object({
    fileId: z
        .string()
        .optional()
        .describe('Selected file; omitted resolves the server default file.'),
    format: subtitleFormatSchema.optional().default('vtt'),
});

export type SubtitleQueryParams = z.infer<typeof subtitleQuerySchema>;

/**
 * Query for the server-rendered bitmap subtitle routes.
 *
 * `fileId` is required here (unlike `subtitleQuerySchema`): rendering resolves a
 * specific physical file's stream indices, and guessing the file would silently
 * render the wrong track for a multi-version item.
 */
export const renderedSubtitleQuerySchema = z.object({
    fileId: z.string().describe('Canonical Lumastra file selector. Required.'),
});

export const renderedSubtitleManifestQuerySchema = z.object({
    fileId: z
        .string()
        .optional()
        .describe('Selected file; omitted resolves the server default file.'),
});

export type RenderedSubtitleQueryParams = z.infer<typeof renderedSubtitleQuerySchema>;

/** One positioned image within a rendered subtitle cue. */
export const renderedSubtitleRectSchema = z.object({
    x: z.number().int().describe('Left edge on the canvas, in canvas pixels'),
    y: z.number().int().describe('Top edge on the canvas, in canvas pixels'),
    w: z.number().int().describe('Image width in pixels'),
    h: z.number().int().describe('Image height in pixels'),
    href: z.string().describe('Ready PNG URL for this positioned subtitle image'),
});

export const renderedSubtitleCueSchema = z.object({
    startMs: z
        .number()
        .int()
        .describe(
            'Cue start in milliseconds on the player timeline (what currentTime reads). Absolute over the whole title — never rebased per seek. Equals source media time except for containers with a non-zero start_time, which is removed so cues match a transcode starting at PTS 0.',
        ),
    endMs: z.number().int().describe('Cue end, same timeline as startMs'),
    rects: z.array(renderedSubtitleRectSchema),
});

/**
 * Manifest for a server-rendered bitmap subtitle track.
 *
 * Cues are ascending and non-overlapping, so a client can advance a single cursor
 * rather than maintaining an interval tree.
 */
export const renderedSubtitleManifestSchema = z.object({
    canvas: z
        .object({
            w: z.number().int().describe('Canvas width the rect coordinates assume'),
            h: z.number().int().describe('Canvas height the rect coordinates assume'),
        })
        .describe(
            'Video canvas the coordinates are relative to. Scale rects by the ratio of the displayed video size to this if they differ.',
        ),
    cues: z.array(renderedSubtitleCueSchema).describe('Ascending, non-overlapping'),
});

export type RenderedSubtitleManifest = z.infer<typeof renderedSubtitleManifestSchema>;

// ============================================================================
// HLS Schemas
// ============================================================================

/**
 * Schema for HLS manifest path parameters
 * GET/POST /api/playback/[itemId]/hls
 */
export const hlsLumastraParamsSchema = z.object({
    itemId: nonEmptyStringSchema,
});

export type HlsLumastraParams = z.infer<typeof hlsLumastraParamsSchema>;

// ============================================================================
// Preview Session Schemas
// ============================================================================

// ============================================================================
// Jellyfin Episode Lookup Schemas
// ============================================================================

/**
 * Schema for finding an episode by series name, season, and episode number
 * POST /api/jellyfin/episode
 */
export const jellyfinEpisodeLookupSchema = z.object({
    seriesName: nonEmptyStringSchema,
    season: z.number().int().positive(),
    episode: z.number().int().positive(),
});

export type JellyfinEpisodeLookupInput = z.infer<typeof jellyfinEpisodeLookupSchema>;

// ============================================================================
// Public API Telemetry Schemas
// ============================================================================

/**
 * Schema for public API telemetry report
 * POST /api/v1/playback/telemetry
 *
 * External players may not provide all metrics, so fields are optional.
 */
export const publicTelemetryReportSchema = z.object({
    // M9: playbackSessionId references play_sessions.id (uuid) — validate as UUID.
    playbackSessionId: z.string().guid(),
    // L11: cap deviceId length to match the device_id text column.
    deviceId: telemetryDeviceIdSchema,
    clientType: z.string().optional(),
    events: z
        .array(
            z.object({
                type: clientMetricTypeSchema,
                value: z.number(),
                // L12: bound metadata size (keep structured values, cap payload).
                metadata: withMetadataSizeLimit(z.record(z.string(), z.unknown())).optional(),
                timestamp: z.number().optional(),
            }),
        )
        .min(0)
        .max(100),
});

export type PublicTelemetryReportInput = z.infer<typeof publicTelemetryReportSchema>;

// ============================================================================
// Playback Incident Schemas
// ============================================================================

/** Mirrors PlaybackError.type from playback-manager.ts. */
export const playbackIncidentErrorTypeSchema = z.enum([
    'network',
    'media',
    'fatal',
    'decode',
    'session_expired',
]);

/** Mirrors PlaybackFailureStage from playback-diagnostics.ts. */
export const playbackIncidentStageSchema = z.enum([
    'manifest',
    'init-segment',
    'media-segment',
    'unknown',
]);

/** Mirrors ReconnectCause from reconnect-controller.ts. */
export const playbackIncidentReconnectCauseSchema = z.enum(['network', 'session-expired', 'stall']);

/**
 * A coarse sanity bound on the ring-buffer window (~120 entries by design;
 * this allows headroom). The SERVICE layer, not this schema, does the real
 * truncate-to-spec — this only rejects wildly oversized/malicious payloads.
 */
export const PLAYBACK_INCIDENT_TIMELINE_MAX_ENTRIES = 200;

/**
 * Serialized byte-size sanity cap for the whole `timeline` array — mirrors
 * `withMetadataSizeLimit`'s byte bound on `clientInfo`. The entry-count cap
 * above bounds how many events there can be, but says nothing about how big
 * each one is; without a byte cap, 200 entries stuffed with large free-text
 * fields could still produce a multi-megabyte payload.
 */
export const PLAYBACK_INCIDENT_TIMELINE_MAX_BYTES = 262_144; // 256 KiB

/**
 * Bounds for `incidentAt` (epoch ms). `.finite()` alone rejects `Infinity`/
 * `NaN`; the range further rejects absurd-but-finite values (e.g. epoch
 * SECONDS mistakenly sent as ms, or a garbage sentinel) that would otherwise
 * become `new Date(...)` → `Invalid Date` only once it reaches the INSERT.
 * The upper bound is computed at PARSE time (not module-load time) so it
 * tracks the real clock instead of freezing at server startup, while still
 * tolerating a generous client clock skew window.
 */
const INCIDENT_AT_MIN_MS = 946_684_800_000; // 2000-01-01T00:00:00Z
const INCIDENT_AT_MAX_SKEW_MS = 24 * 60 * 60 * 1000; // 24h of client clock skew

export const playbackIncidentReportSchema = z
    .object({
        attemptId: z.string().min(1).max(64),
        /**
         * Deliberately NOT `.min(1)`: the unload beacon has no session id to
         * send, and an incident fired before the first play session exists
         * (stream-limit rejection, 404 on the very first request) has none
         * either. Rejecting those drops exactly the reports worth having —
         * `attemptId` is the correlation key that matters, and a correlation
         * query on an empty play_session_id simply matches nothing.
         */
        playSessionId: z.string().max(64),
        /** Epoch ms, matching the existing per-event `timestamp` convention above. */
        incidentAt: z
            .number()
            .finite()
            .refine(
                (value) =>
                    value >= INCIDENT_AT_MIN_MS && value <= Date.now() + INCIDENT_AT_MAX_SKEW_MS,
                {
                    message: 'incidentAt must be a plausible epoch-ms timestamp',
                },
            )
            .describe(
                'Epoch MILLISECONDS (e.g. Date.now() in JS, or Date().timeIntervalSince1970 * 1000 ' +
                    'in Swift) — matching every other timestamp field in this API, never epoch seconds. ' +
                    'Rejected with 422 outside a plausible range (roughly 2000-01-01 through now plus a ' +
                    'generous clock-skew allowance), which also catches an epoch-seconds value sent by ' +
                    'mistake — it is far too small to land in that range.',
            ),
        triggerType: z.enum(['error', 'reconnect', 'terminal']),
        errorType: playbackIncidentErrorTypeSchema.nullable().optional(),
        stage: playbackIncidentStageSchema
            .nullable()
            .optional()
            .describe(
                'The request stage observed at failure time. Always send an explicit value when ' +
                    "classifiable, including 'unknown' as the deliberate fallback when the stage can't " +
                    "be determined (mirrors this API's own web client, which never omits this field) — " +
                    'omitting it entirely is only for a client that has no classification logic at all. ' +
                    "Deriving from the failing request's URI is the expected approach: a .m3u8/.m3u ext " +
                    "→ 'manifest', an init/header segment → 'init-segment', any other media segment → " +
                    "'media-segment'.",
            ),
        httpStatus: z.number().int().optional(),
        /** Validated against the real StreamDiagnosticCode allowlist server-side
         *  (in the service layer) — this schema only bounds it as a string. */
        serverDiagnosticCode: z.string().max(64).nullable().optional(),
        reconnectCause: playbackIncidentReconnectCauseSchema.nullable().optional(),
        message: z.string().max(500).nullable().optional(),
        timeline: z
            .array(z.record(z.string(), z.unknown()))
            .max(PLAYBACK_INCIDENT_TIMELINE_MAX_ENTRIES)
            .refine(
                (value) => {
                    try {
                        return JSON.stringify(value).length <= PLAYBACK_INCIDENT_TIMELINE_MAX_BYTES;
                    } catch {
                        // Non-serializable (cycles, etc.) — reject as malformed.
                        return false;
                    }
                },
                {
                    message: `timeline exceeds ${PLAYBACK_INCIDENT_TIMELINE_MAX_BYTES} bytes serialized`,
                },
            ),
        clientInfo: withMetadataSizeLimit(z.record(z.string(), z.unknown())).nullable().optional(),
        deviceId: telemetryDeviceIdSchema.nullable(),
        mediaId: z.string().uuid().nullable().optional(),
    })
    // Cross-field: a client that reports triggerType 'error' without an
    // errorType (or 'reconnect' without a reconnectCause) has sent an
    // internally inconsistent payload — nothing downstream can explain WHY
    // the incident fired. 'terminal' has no required sibling: it's a
    // catch-all for a session ending without a specific attributable error.
    .superRefine((data, ctx) => {
        if (data.triggerType === 'error' && !data.errorType) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['errorType'],
                message: 'errorType is required when triggerType is "error"',
            });
        }
        if (data.triggerType === 'reconnect' && !data.reconnectCause) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['reconnectCause'],
                message: 'reconnectCause is required when triggerType is "reconnect"',
            });
        }
    });

export type PlaybackIncidentReportInput = z.infer<typeof playbackIncidentReportSchema>;

export const playbackIncidentResolveSchema = z.object({
    attemptId: z.string().min(1).max(64),
});

export type PlaybackIncidentResolveInput = z.infer<typeof playbackIncidentResolveSchema>;

// ============================================================================
// Device Heartbeat Schemas
// ============================================================================

/**
 * Schema for device heartbeat request body.
 * Body is optional - empty body just heartbeats with existing info.
 */
export const deviceHeartbeatSchema = z.object({
    deviceName: z.string().optional(),
    deviceType: z.enum(['tv', 'mobile', 'web']).optional(),
    supportsWatchTogether: z.boolean().optional(),
});

export type DeviceHeartbeatInput = z.infer<typeof deviceHeartbeatSchema>;

// ============================================================================
// Public Send to Device Schemas
// ============================================================================

/**
 * Schema for sending media to device (public API)
 * POST /api/v1/playback/send-to-device
 *
 * Different from internal /api/playback/send-to-device which takes deviceId
 */
export const publicSendToDeviceSchema = z.object({
    deviceSessionId: nonEmptyStringSchema,
    itemId: nonEmptyStringSchema,
    title: nonEmptyStringSchema,
    mediaType: z.string().optional(),
    startPosition: z.number().optional(),
    fileId: z.string().optional(),
    backdropUrl: z.string().optional(),
    seasonId: z.string().optional(),
});

export type PublicSendToDeviceInput = z.infer<typeof publicSendToDeviceSchema>;

// ============================================================================
// Streaming Session Schemas
// ============================================================================

/**
 * Schema for creating a streaming session
 * POST /api/v1/playback/[itemId]/session
 *
 * Body is optional - empty body uses defaults.
 */
export const streamingSessionBodySchema = z.object({
    expiryHours: z.number().positive().max(72).optional(),
});

export type StreamingSessionBodyInput = z.infer<typeof streamingSessionBodySchema>;

/**
 * Schema for refreshing a streaming session query params
 * POST /api/v1/playback/stream-session/refresh?token=stream_xxx
 */
export const streamSessionRefreshQuerySchema = z.object({
    token: nonEmptyStringSchema,
});

export type StreamSessionRefreshQueryInput = z.infer<typeof streamSessionRefreshQuerySchema>;

/**
 * Schema for refreshing a streaming session body
 * POST /api/v1/playback/stream-session/refresh
 *
 * Body is optional - empty body uses defaults.
 */
export const streamSessionRefreshBodySchema = z.object({
    expiryHours: z.number().positive().max(72).optional(),
});

export type StreamSessionRefreshBodyInput = z.infer<typeof streamSessionRefreshBodySchema>;

// ============================================================================
// Network speed test
// ============================================================================

export const SPEED_TEST_MIN_BYTES = 1 * 1024 * 1024;
export const SPEED_TEST_MAX_BYTES = 64 * 1024 * 1024;
export const SPEED_TEST_DEFAULT_BYTES = 16 * 1024 * 1024;

/**
 * `long` mode payload — the whole 64 MiB ceiling, with a 60 s client-side cap.
 *
 * An ALIAS of `SPEED_TEST_MAX_BYTES` rather than a second 64 MiB literal: `long`
 * is by definition "as big as this endpoint will serve", so raising the ceiling
 * must raise the long profile with it and cannot leave the two silently apart.
 */
export const SPEED_TEST_LONG_BYTES = SPEED_TEST_MAX_BYTES;
export const SPEED_TEST_LONG_CAP_MS = 60_000;

/**
 * `cadence` mode: 8 sequential 4 MiB fetches 2 s apart, mimicking an HLS
 * segment fetch pattern. 8 x 4 MiB = 32 MiB requested in total, inside the
 * 64 MiB `bytesRequested` ceiling.
 */
export const SPEED_TEST_CADENCE_CHUNK_BYTES = 4 * 1024 * 1024;
export const SPEED_TEST_CADENCE_REQUESTS = 8;
export const SPEED_TEST_CADENCE_GAP_MS = 2000;

/**
 * Which shape of test produced a result.
 *
 * The mode is a CLIENT concern over an unchanged payload endpoint — the server
 * only needs to know it in order to apply the right maths and to label the row.
 * `single` is the default so a client written before modes existed keeps working.
 */
export const speedTestModeSchema = z.enum(['single', 'long', 'cadence']);

export type SpeedTestMode = z.infer<typeof speedTestModeSchema>;

/**
 * Schema for the speed-test download query params
 * GET /api/network/speed-test?bytes=...
 */
export const speedTestQuerySchema = z.object({
    bytes: z.coerce
        .number()
        .int()
        .min(SPEED_TEST_MIN_BYTES)
        .max(SPEED_TEST_MAX_BYTES)
        .default(SPEED_TEST_DEFAULT_BYTES),
});

/**
 * Key-count ceiling on a speed-test result's `clientInfo` bag (spec Part 2).
 *
 * Tighter than the 32-key telemetry metadata bound on purpose: `clientInfo` is
 * engine/platform/app-version provenance, not a metric bag, and the stored jsonb
 * is read back by the admin UI. A client that wants to send more than this is
 * sending something else.
 */
const SPEED_TEST_CLIENT_INFO_MAX_KEYS = 16;

/**
 * Schema for a single 250 ms measurement bucket within a speed-test result.
 */
export const speedTestBucketSchema = z.object({
    ms: z.number().int().min(1).max(1000),
    bytes: z.number().int().min(0),
});

/**
 * One fetch within a `cadence` run: the bytes it carried and its own timings.
 *
 * `bytes` has no lower bound beyond 0 on purpose — a request that received
 * nothing is exactly the evidence a cadence run exists to surface, and rejecting
 * it would throw away the worst segment of the run.
 */
export const speedTestRequestSchema = z
    .object({
        bytes: z.number().int().min(0),
        ttfbMs: z.number().int().min(0).max(120_000),
        durationMs: z.number().int().min(0).max(120_000),
    })
    .refine((q) => q.ttfbMs <= q.durationMs, {
        message: 'ttfbMs exceeds durationMs',
        path: ['ttfbMs'],
    });

export type SpeedTestRequestInput = z.infer<typeof speedTestRequestSchema>;

/** Ceiling on the per-request list — 8 x the cadence request count, with room. */
const SPEED_TEST_MAX_REQUESTS = 64;

/**
 * Bucket ceiling. 250 ms buckets over the 60 s `long` cap = 240.
 */
const SPEED_TEST_MAX_BUCKETS = 240;

/**
 * Schema for the speed-test result posted back by the client.
 * POST /api/network/speed-test
 */
export const speedTestResultSchema = z
    .object({
        bytesRequested: z.number().int().min(SPEED_TEST_MIN_BYTES).max(SPEED_TEST_MAX_BYTES),
        bytesReceived: z.number().int().min(0),
        durationMs: z.number().int().min(0).max(120_000),
        ttfbMs: z.number().int().min(0).max(120_000),
        aborted: z.boolean().default(false),
        buckets: z.array(speedTestBucketSchema).max(SPEED_TEST_MAX_BUCKETS),
        mode: speedTestModeSchema.default('single'),
        requests: z.array(speedTestRequestSchema).max(SPEED_TEST_MAX_REQUESTS).optional(),
        deviceId: z.string().max(255).optional(),
        clientInfo: z
            .record(z.string().max(64), z.string().max(256))
            .refine((o) => Object.keys(o).length <= SPEED_TEST_CLIENT_INFO_MAX_KEYS, {
                message: `clientInfo exceeds ${SPEED_TEST_CLIENT_INFO_MAX_KEYS} keys`,
            })
            .optional(),
    })
    .refine((r) => r.bytesReceived <= r.bytesRequested, {
        message: 'bytesReceived exceeds bytesRequested',
        path: ['bytesReceived'],
    })
    .refine((r) => r.ttfbMs <= r.durationMs, {
        message: 'ttfbMs exceeds durationMs',
        path: ['ttfbMs'],
    })
    // A cadence run IS its per-request list: without it there is nothing to
    // summarise that the wall clock would not misreport, since the pauses are
    // inside `durationMs`.
    .refine((r) => r.mode !== 'cadence' || (r.requests?.length ?? 0) > 0, {
        message: 'requests is required when mode is cadence',
        path: ['requests'],
    })
    // And the converse: a single/long run has exactly one request, so a list
    // here would be a client contradicting its own mode.
    .refine((r) => r.mode === 'cadence' || (r.requests?.length ?? 0) === 0, {
        message: 'requests is only accepted when mode is cadence',
        path: ['requests'],
    })
    // The per-request series must account for every byte the run claims.
    // Without this a client could pair a 32 MiB total with one 1 ms request and
    // the summary — which divides by the per-request windows — would report an
    // arbitrarily large speed off a payload that never arrived that way.
    .refine(
        (r) =>
            r.mode !== 'cadence' ||
            (r.requests ?? []).reduce((acc, q) => acc + q.bytes, 0) === r.bytesReceived,
        {
            message: 'bytesReceived must equal the sum of requests[].bytes for a cadence run',
            path: ['bytesReceived'],
        },
    )
    // Cadence times whole fetches, not 250 ms slices, so a bucket series here is
    // the same contradiction as `requests` on a single run — and the summary
    // ignores it, which would make a sent one silently disappear.
    .refine((r) => r.mode !== 'cadence' || r.buckets.length === 0, {
        message: 'buckets must be empty when mode is cadence',
        path: ['buckets'],
    });

export type SpeedTestResultInput = z.infer<typeof speedTestResultSchema>;

/** Ready-to-use subtitle delivery for one selected physical media file. */
export const timelineSubtitleDescriptorSchema = z.object({
    id: z
        .string()
        .describe(
            'Stable track id shared with playability: <fileId>:<index> for embedded tracks, the sidecar id for external tracks.',
        ),
    index: z
        .number()
        .int()
        .min(0)
        .describe(
            'Absolute container stream index; external sidecars use 1000 + position within the selected file.',
        ),
    kind: z.enum(['embedded', 'external']),
    method: z
        .enum(['external_vtt', 'client_render', 'burn_in', 'none'])
        .optional()
        .describe('Capability-specific delivery method, present on playback start.'),
    codec: z.string(),
    language: z.string().nullable(),
    title: z.string().optional(),
    default: z.boolean(),
    forced: z.boolean(),
    format: z.enum(['text', 'bitmap']),
    hrefs: z.object({
        text: z.string().optional(),
        raw: z.string().optional(),
        rendered: z.string().optional(),
    }),
});
export type TimelineSubtitleDescriptor = z.infer<typeof timelineSubtitleDescriptorSchema>;

export const timelineDeliverySchema = z.object({
    href: z.string(),
    subtitles: z.array(timelineSubtitleDescriptorSchema),
});
export type TimelineDelivery = z.infer<typeof timelineDeliverySchema>;
