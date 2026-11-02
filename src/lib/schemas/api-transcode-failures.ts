// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const TranscodeIncidentSchema = z.object({
    category: z.string().describe('Failure category from the FFmpeg classifier'),
    encoder: z.string().nullable().describe('GPU encoder, or null for software'),
    occurrences: z.number().describe('Total recorded attempts in this group'),
    distinctFiles: z
        .number()
        .describe('Distinct media files affected — 1 is a bad file, many is a bad system'),
    distinctSessions: z.number().describe('Distinct playback sessions affected'),
    firstSeen: z.string().describe('ISO timestamp of the earliest attempt'),
    lastSeen: z.string().describe('ISO timestamp of the most recent attempt'),
});

export const TranscodeIncidentsResponseSchema = z.object({
    incidents: z.array(TranscodeIncidentSchema),
    truncated: z
        .boolean()
        .optional()
        .describe('True when more incident groups exist than `incidents` lists (newest first)'),
    totalGroups: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Number of incident groups matching the filter, listed or not'),
});

export const TranscodeFailureAttemptSchema = z.object({
    id: z.string(),
    jobId: z.string(),
    attempt: z.number(),
    occurredAt: z.string(),
    outcome: z.enum(['retried', 'bridged', 'learned', 'failed', 'killed', 'spawn_failed']),
    exitCode: z.number().nullable(),
    signal: z.string().nullable(),
    category: z.string(),
    summary: z.string().nullable(),
    argv: z.array(z.string()),
    stderrTail: z.string().nullable(),
    encoder: z.string().nullable(),
    hwaccel: z.string().nullable(),
    mediaId: z.string().nullable(),
    fileId: z.string().nullable(),
    source: z.record(z.string(), z.unknown()).nullable(),
    decision: z.record(z.string(), z.unknown()).nullable(),
    env: z.record(z.string(), z.unknown()).nullable(),
    transcodeSpeed: z.number().nullable(),
    probeDump: z.string().nullable(),
});

export const TranscodeFailureSessionResponseSchema = z.object({
    attempts: z.array(TranscodeFailureAttemptSchema),
});

export const TranscodeIncidentSessionSchema = z.object({
    playSessionId: z.string(),
    mediaId: z.string().nullable(),
    fileId: z
        .string()
        .nullable()
        .describe('Media file id, or null for preview/cache jobs with no linked file'),
    mediaTitle: z
        .string()
        .nullable()
        .describe('Title of the associated media item when resolvable — never a filesystem path'),
    attemptCount: z.number().describe('Attempts in THIS incident group, not the full chain'),
    firstSeen: z.string().describe('ISO timestamp of the earliest matching attempt'),
    lastSeen: z.string().describe('ISO timestamp of the most recent matching attempt'),
    terminalOutcome: z
        .enum(['retried', 'bridged', 'learned', 'failed', 'killed', 'spawn_failed'])
        .nullable()
        .describe(
            "Outcome of the session's last attempt overall, or null when the full chain ends on a non-terminal retry",
        ),
});

export const TranscodeIncidentSessionsResponseSchema = z.object({
    sessions: z.array(TranscodeIncidentSessionSchema),
});

export const TranscodeProbeResponseSchema = z.object({
    probeDump: z
        .string()
        .nullable()
        .describe(
            'ffmpeg -i source dump ("Input #0..." onward), or null when unavailable (no linked file, unmounted volume, deleted file, or probe timeout)',
        ),
});

/** DELETE response for the admin page's per-incident and clear-all buttons. */
export const TranscodeClearedResponseSchema = z.object({
    cleared: z
        .number()
        .int()
        .nonnegative()
        .describe('Number of transcode_failure_events rows removed'),
});

export type TranscodeIncident = z.infer<typeof TranscodeIncidentSchema>;
export type TranscodeFailureAttempt = z.infer<typeof TranscodeFailureAttemptSchema>;
export type TranscodeIncidentSession = z.infer<typeof TranscodeIncidentSessionSchema>;
export type TranscodeProbeResponse = z.infer<typeof TranscodeProbeResponseSchema>;
export type TranscodeClearedResponse = z.infer<typeof TranscodeClearedResponseSchema>;
