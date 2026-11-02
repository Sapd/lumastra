// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Response schemas for the admin playback-incident list/detail endpoints
 * (`GET /admin/playback-incidents`, `GET /admin/playback-incidents/{id}`).
 * Single source of truth per this codebase's Zod-schemas convention.
 */

import { z } from 'zod';
import { SpeedTestSummaryListSchema } from './api-network-responses.js';

const baseFields = {
    id: z.number().describe('Row id (playback_incident_events.id)'),
    attemptId: z
        .string()
        .describe('Client-generated id, stable across session renewal on reconnect'),
    playSessionId: z
        .string()
        .describe('Play session id at flush time — NOT stable across a reconnect'),
    incidentAt: z.string().describe('ISO timestamp the client recorded for the incident'),
    serverRecordedAt: z.string().describe('ISO timestamp when the server stored the incident'),
    triggerType: z.enum(['error', 'reconnect', 'terminal']),
    errorType: z.string().nullable(),
    stage: z.string().nullable(),
    httpStatus: z.number().nullable(),
    serverDiagnosticCode: z
        .string()
        .nullable()
        .describe('Validated server-side against the StreamDiagnosticCode allowlist at ingest'),
    reconnectCause: z.string().nullable(),
    message: z.string().nullable(),
    userId: z.string().nullable(),
    deviceId: z.string().nullable(),
    mediaId: z.string().nullable(),
    username: z.string().nullable(),
    deviceName: z.string().nullable(),
    mediaTitle: z.string().nullable(),
    resolvedAt: z.string().nullable(),
};

export const PlaybackIncidentSummarySchema = z.object(baseFields);

/** Mirrors the codebase-wide `{ items, page }` collection envelope (see
 *  `paginate()` in `$lib/server/api/problem.ts`) — `hasMore` is mandatory on
 *  every genuinely paginated response. */
export const PlaybackIncidentPageSchema = z.object({
    limit: z.number().int(),
    offset: z.number().int().optional(),
    hasMore: z.boolean(),
    total: z.number().int().optional(),
});

export const PlaybackIncidentListResponseSchema = z.object({
    items: z.array(PlaybackIncidentSummarySchema),
    page: PlaybackIncidentPageSchema,
});

export const PlaybackIncidentDetailSchema = z.object({
    ...baseFields,
    timeline: z.array(z.record(z.string(), z.unknown())),
    clientInfo: z.record(z.string(), z.unknown()).nullable(),
});

export const CorrelatedTranscodeFailureSchema = z.object({
    occurredAt: z.string(),
    category: z.string(),
    summary: z.string().nullable(),
});

/**
 * One receiver-timed delivery window (`playback_telemetry.metric_type =
 * 'delivery_window'`).
 *
 * Every number but `throughputBps` is nullable: the underlying `metadata` is a
 * free-form jsonb bag written by whichever client version was playing, so a
 * field the reporter did not send must read as "unknown", never as 0. The
 * admin drawer shows these raw rather than averaged — a link that is usually
 * ample and periodically collapses is a SHAPE, and an average erases it.
 */
export const DeliveryWindowSchema = z
    .object({
        recordedAt: z.string().describe('ISO timestamp the window was recorded'),
        throughputBps: z
            .number()
            .describe('Bits per second the receiver actually achieved over the window'),
        bytes: z.number().nullable().describe('Bytes received in the window'),
        segments: z.number().nullable().describe('Segments completed in the window'),
        mediaSec: z.number().nullable().describe('Seconds of media those segments covered'),
        transferMs: z.number().nullable().describe('Milliseconds spent transferring'),
        wallMaxMs: z.number().nullable().describe('Longest single wall-clock segment fetch (ms)'),
        ttfbMaxMs: z.number().nullable().describe('Worst time-to-first-byte in the window (ms)'),
        minSegBps: z
            .number()
            .nullable()
            .describe('Slowest single segment in the window, in bits per second'),
        overdue: z
            .number()
            .nullable()
            .describe('Segment downloads the player reported as overdue (native players only)'),
        stalls: z.number().nullable().describe('Stalls observed during the window'),
        bufferAheadSec: z
            .number()
            .nullable()
            .describe('Buffer ahead of the playhead at the end of the window (seconds)'),
        engine: z.string().nullable().describe('Playback engine that reported the window'),
    })
    .meta({
        id: 'DeliveryWindow',
        description: 'One client-timed delivery window for a play session',
    });

export const PlaybackIncidentDetailResponseSchema = z.object({
    incident: PlaybackIncidentDetailSchema,
    correlatedTranscodeFailures: z.array(CorrelatedTranscodeFailureSchema),
    /** Oldest → newest, so the drawer can plot them as a timeline unreversed. */
    deliveryWindows: z
        .array(DeliveryWindowSchema)
        .describe("Receiver-timed delivery windows for this incident's play session, oldest first"),
    /**
     * The user's own active measurements around the incident — the one number
     * that separates "their line was bad" from "our delivery was bad".
     */
    speedTests: SpeedTestSummaryListSchema.describe(
        "Speed tests this incident's user ran in the last 7 days, newest first",
    ),
});

/** DELETE response for the admin list's per-row and clear-all buttons. */
export const PlaybackIncidentClearedResponseSchema = z.object({
    cleared: z
        .number()
        .int()
        .nonnegative()
        .describe('Number of playback_incident_events rows removed'),
});

export type PlaybackIncidentSummary = z.infer<typeof PlaybackIncidentSummarySchema>;
export type PlaybackIncidentPage = z.infer<typeof PlaybackIncidentPageSchema>;
export type PlaybackIncidentDetail = z.infer<typeof PlaybackIncidentDetailSchema>;
export type CorrelatedTranscodeFailure = z.infer<typeof CorrelatedTranscodeFailureSchema>;
export type DeliveryWindow = z.infer<typeof DeliveryWindowSchema>;
export type PlaybackIncidentListResponse = z.infer<typeof PlaybackIncidentListResponseSchema>;
export type PlaybackIncidentDetailResponse = z.infer<typeof PlaybackIncidentDetailResponseSchema>;
export type PlaybackIncidentClearedResponse = z.infer<typeof PlaybackIncidentClearedResponseSchema>;
