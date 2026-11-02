// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire schemas for client diagnostics.
 * Every field is `.optional()` XOR `.nullable()` — never both (Swift codegen); a test enforces it.
 */

import { z } from 'zod';
import {
    ROUTE_KEY,
    UUID_LOOKING,
    hasPureDigitSegment,
} from '$lib/shared/client-diagnostics-routing.js';
import {
    playbackIncidentErrorTypeSchema,
    playbackIncidentStageSchema,
    playbackIncidentReconnectCauseSchema,
    PLAYBACK_INCIDENT_TIMELINE_MAX_ENTRIES,
    PLAYBACK_INCIDENT_TIMELINE_MAX_BYTES,
    withMetadataSizeLimit,
} from './playback.js';

export const DIAGNOSTIC_KINDS = [
    'playback_incident',
    'crash',
    'hang',
    'js_error',
    'api_failures',
    'log_bundle',
    'compat_incident',
] as const;
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];
/** Kinds gated by FEATURE_CLIENT_DIAGNOSTICS. playback_incident is always on. */
export const AUTOMATIC_KINDS: ReadonlySet<DiagnosticKind> = new Set([
    'crash',
    'hang',
    'js_error',
    'api_failures',
    'compat_incident',
]);

export const EVENT_LIMITS = {
    batchMax: 50,
    logTailLines: 200,
    logTailBytes: 32 * 1024,
    payloadBytes: {
        playback_incident: PLAYBACK_INCIDENT_TIMELINE_MAX_BYTES + 40 * 1024,
        crash: 64 * 1024,
        hang: 64 * 1024,
        js_error: 16 * 1024,
        api_failures: 2 * 1024,
    },
    bundleGzipBytes: 2 * 1024 * 1024,
    bundleInflatedBytes: 16 * 1024 * 1024,
} as const;

const EPOCH_MIN_MS = 946_684_800_000; // 2000-01-01
const EPOCH_MAX_SKEW_MS = 24 * 60 * 60 * 1000;
const epochMsSchema = z
    .number()
    .finite()
    .refine((v) => v >= EPOCH_MIN_MS && v <= Date.now() + EPOCH_MAX_SKEW_MS, {
        message: 'must be a plausible epoch-MILLISECONDS timestamp',
    })
    .describe('Epoch milliseconds (never seconds).');

function sizeCapped<T extends z.ZodObject<z.ZodRawShape>>(schema: T, maxBytes: number): T {
    return schema.refine(
        (value: unknown) => {
            try {
                return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') <= maxBytes;
            } catch {
                return false;
            }
        },
        { message: `payload exceeds ${maxBytes} bytes serialized` },
    );
}

export const logTailSchema = sizeCapped(
    z.object({
        lines: z.array(z.string().max(2000)).max(EVENT_LIMITS.logTailLines),
        truncated: z.boolean(),
        source: z.enum(['current_run', 'previous_run']),
    }),
    EVENT_LIMITS.logTailBytes,
).describe('The last ≤200 redacted log lines before the event.');

const envelope = {
    eventId: z.string().uuid().describe('Client-minted idempotency key, stable across retries.'),
    platform: z.enum(['ios', 'tvos', 'web', 'other']),
    deviceId: z.string().min(1).max(128).optional(),
    appVersion: z.string().max(32).optional(),
    appBuild: z.string().max(32).optional(),
    osVersion: z.string().max(64).optional(),
    deviceModel: z.string().max(64).optional(),
    occurredAt: epochMsSchema,
    playSessionId: z.string().max(64).optional(),
    attemptId: z.string().min(1).max(64).optional(),
    mediaId: z.string().uuid().optional(),
    occurrences: z.number().int().min(1).max(1_000_000).optional(),
};

const frameSchema = z.object({
    binaryName: z.string().max(128).optional(),
    binaryUUID: z.string().max(40).optional(),
    offset: z.number().int().nonnegative().optional(),
    address: z.number().int().nonnegative().optional(),
    symbol: z.string().max(256).optional(),
});

const crashHangPayload = sizeCapped(
    z.object({
        source: z.enum(['metrickit_legacy', 'metrickit', 'exception_handler', 'abnormal_exit']),
        confidence: z.enum(['high', 'low']),
        exceptionType: z.number().int().optional(),
        exceptionCode: z.number().int().optional(),
        signal: z.number().int().optional(),
        terminationReason: z.string().max(500).optional(),
        exceptionName: z.string().max(200).optional(),
        exceptionReason: z.string().max(1000).optional(),
        hangDurationMs: z.number().int().nonnegative().optional(),
        callStacks: z
            .array(
                z.object({ threadAttributed: z.boolean(), frames: z.array(frameSchema).max(32) }),
            )
            .max(8),
        logTail: logTailSchema.optional(),
    }),
    EVENT_LIMITS.payloadBytes.crash,
);

/** A stable message/toast key (`audiobook_playback_failed`), never display text. */
const DIAGNOSTIC_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;

const apiRouteSchema = z
    .string()
    .regex(ROUTE_KEY, 'route must be an operationId or a templated path')
    .refine((v) => !hasPureDigitSegment(v), {
        message: 'route must not contain a raw numeric id segment — template it as :id',
    });
const apiMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const apiOutcomeSchema = z.enum(['status_4xx', 'status_5xx', 'network', 'timeout', 'decode']);
const problemCodeSchema = z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .describe('problem+json `code` of the failed response.');

const jsErrorPayload = sizeCapped(
    z.object({
        errorId: z.string().max(100).optional().describe('The reference shown on the error page.'),
        name: z.string().max(128),
        message: z.string().max(2000),
        stack: z.string().max(8192).optional(),
        route: z
            .string()
            .max(256)
            .regex(
                /^(?!.*[?#])(?!.*:\/\/).*$/,
                'route must be a pathname only, no query/fragment/scheme',
            )
            .optional()
            .describe('Pathname only — never a query string.'),
        origin: z
            .enum(['handle_error', 'window_error', 'unhandled_rejection', 'error_toast'])
            .describe(
                '`error_toast`: the user saw a failure message (a toast or a player error state).',
            ),
        tag: z.enum(['chunk_load']).optional(),
        toastKey: z
            .string()
            .regex(DIAGNOSTIC_KEY)
            .optional()
            .describe(
                'Message key of the failure the user saw; `untagged` when the caller set none.',
            ),
        cause: z
            .object({
                method: apiMethodSchema,
                route: apiRouteSchema,
                outcome: apiOutcomeSchema,
                status: z.number().int().min(100).max(599).optional(),
                problemCode: problemCodeSchema.optional(),
            })
            .optional()
            .describe('The API call that failed in this tab just before the failure message.'),
        logTail: logTailSchema.optional(),
    }),
    EVENT_LIMITS.payloadBytes.js_error,
);

const apiFailuresPayload = sizeCapped(
    z.object({
        windowStart: epochMsSchema,
        windowEnd: epochMsSchema,
        method: apiMethodSchema,
        route: apiRouteSchema,
        outcome: apiOutcomeSchema,
        keyPath: z
            .string()
            .max(200)
            .refine((v) => !UUID_LOOKING.test(v), 'keyPath must not contain a raw UUID')
            .describe('Decode path of the first issue, e.g. items.3.image.url.')
            .optional(),
        issueCount: z.number().int().min(1).max(10_000).optional(),
        detail: z.string().max(300).optional(),
        status: z.number().int().min(100).max(599).optional(),
        problemCode: problemCodeSchema.optional(),
        requestId: z
            .string()
            .regex(/^[A-Za-z0-9_.:-]{1,100}$/)
            .optional()
            .describe('Server correlation id from the problem+json body, when it had one.'),
    }),
    EVENT_LIMITS.payloadBytes.api_failures,
);

/** Same fields and bounds as the legacy report body minus the envelope-promoted ones. */
const playbackIncidentPayload = sizeCapped(
    z.object({
        triggerType: z.enum(['error', 'reconnect', 'terminal']),
        errorType: playbackIncidentErrorTypeSchema.optional(),
        stage: playbackIncidentStageSchema.optional(),
        httpStatus: z.number().int().optional(),
        serverDiagnosticCode: z.string().max(64).optional(),
        reconnectCause: playbackIncidentReconnectCauseSchema.optional(),
        message: z.string().max(500).optional(),
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
        clientInfo: withMetadataSizeLimit(z.record(z.string(), z.unknown())).optional(),
        logTail: logTailSchema.optional(),
    }),
    EVENT_LIMITS.payloadBytes.playback_incident,
);

export const diagnosticEventSchema = z.discriminatedUnion('kind', [
    z.object({
        ...envelope,
        kind: z.literal('playback_incident'),
        attemptId: envelope.attemptId.unwrap(),
        payload: playbackIncidentPayload,
    }),
    z.object({ ...envelope, kind: z.literal('crash'), payload: crashHangPayload }),
    z.object({ ...envelope, kind: z.literal('hang'), payload: crashHangPayload }),
    z.object({ ...envelope, kind: z.literal('js_error'), payload: jsErrorPayload }),
    z.object({ ...envelope, kind: z.literal('api_failures'), payload: apiFailuresPayload }),
]);
export type DiagnosticEventInput = z.infer<typeof diagnosticEventSchema>;

export const diagnosticEventBatchSchema = z.object({
    events: z.array(diagnosticEventSchema).min(1).max(EVENT_LIMITS.batchMax),
});

export const diagnosticResolveSchema = z.object({ attemptId: z.string().min(1).max(64) });

/**
 * Strict base64 shape: length a multiple of 4, and `=` padding (0, 1, or 2
 * chars) only in the final group. This is stricter than a bare character-set
 * check — `AAAAA` (wrong length) and `AAAA=` (padding not at the end of a
 * 4-char group) are both rejected by this pattern, not just by decoding.
 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;

/**
 * Decoded byte length computed arithmetically from the (already
 * regex-validated multiple-of-4) base64 string length and its trailing `=`
 * padding — avoids allocating a decode buffer just to size-check it.
 */
function base64DecodedLength(value: string): number {
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    return (value.length / 4) * 3 - padding;
}

export const diagnosticBundleSchema = z.object({
    ...envelope,
    note: z.string().max(1000).optional(),
    trigger: z.enum(['user', 'admin_request', 'playback_prompt']),
    requestId: z.string().uuid().optional(),
    scope: z.enum(['account', 'device']),
    // Server user ids of every account whose log segments a device-scoped bundle
    // contains. Stored lowercased + de-duplicated (Apple clients send uppercase uuids);
    // GDPR erasure matches them case-sensitively against lower(userId).
    accountIds: z.array(z.string().uuid()).max(16).optional(),
    contentGzipBase64: z
        .string()
        .min(4)
        .max(Math.ceil((EVENT_LIMITS.bundleGzipBytes * 4) / 3) + 4)
        .regex(BASE64, 'must be well-formed base64 (multiple of 4, padding only at the end)')
        .refine((v) => base64DecodedLength(v) <= EVENT_LIMITS.bundleGzipBytes, {
            message: `decoded content exceeds ${EVENT_LIMITS.bundleGzipBytes} bytes`,
        }),
});
export type DiagnosticBundleInput = z.infer<typeof diagnosticBundleSchema>;

export const DiagnosticIngestResponseSchema = z.object({
    accepted: z.number().int(),
    dropped: z.number().int(),
});
export const DiagnosticBundleResponseSchema = z.object({
    diagnosticId: z.number().int(),
    eventId: z.string().uuid(),
    shortId: z
        .string()
        .describe('Human reference, e.g. 7F3A-91C2 — the first 8 hex chars of eventId.'),
});

export const ClientDiagnosticSummarySchema = z.object({
    id: z.number().int(),
    eventId: z.string(),
    shortId: z.string(),
    kind: z.enum(DIAGNOSTIC_KINDS),
    platform: z.enum(['ios', 'tvos', 'web', 'other']),
    userId: z.string().nullable(),
    username: z.string().nullable(),
    deviceId: z.string().nullable(),
    deviceName: z.string().nullable(),
    appVersion: z.string().nullable(),
    osVersion: z.string().nullable(),
    deviceModel: z.string().nullable(),
    playSessionId: z.string().nullable(),
    mediaId: z.string().nullable(),
    mediaTitle: z.string().nullable(),
    occurredAt: z.string(),
    receivedAt: z.string(),
    fingerprint: z.string().nullable(),
    occurrences: z.number().int(),
    summary: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    hasBlob: z.boolean(),
});
export type ClientDiagnosticSummary = z.infer<typeof ClientDiagnosticSummarySchema>;

/**
 * Same shape as `PlaybackIncidentPageSchema` in ./api-playback-incidents.ts
 * (including its optional `offset`/`total`) — defined locally rather than
 * imported, since that legacy module is slated for removal and this schema
 * must not depend on it.
 */
const clientDiagnosticPageSchema = z.object({
    limit: z.number().int(),
    offset: z.number().int().optional(),
    hasMore: z.boolean(),
    total: z.number().int().optional(),
});

export const ClientDiagnosticListResponseSchema = z.object({
    items: z.array(ClientDiagnosticSummarySchema),
    page: clientDiagnosticPageSchema,
});

export const ClientDiagnosticDetailSchema = ClientDiagnosticSummarySchema.extend({
    appBuild: z.string().nullable(),
    attemptId: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    blob: z
        .object({
            contentBytes: z.number().int(),
            uncompressedBytes: z.number().int(),
            sha256: z.string(),
        })
        .nullable(),
});
export type ClientDiagnosticDetail = z.infer<typeof ClientDiagnosticDetailSchema>;

export const GithubReportResponseSchema = z.object({
    markdown: z
        .string()
        .describe('Redacted human-readable summary, safe to paste into a GitHub issue'),
    issueUrl: z
        .string()
        .url()
        .describe('Prefilled GitHub issue-form URL (length-capped; open it in the browser)'),
    report: z
        .record(z.string(), z.unknown())
        .describe('Redacted machine-readable report; attach as a JSON file to the issue'),
});
export type GithubReportResponse = z.infer<typeof GithubReportResponseSchema>;

export const ClientDiagnosticClearedResponseSchema = z.object({ cleared: z.number().int() });
