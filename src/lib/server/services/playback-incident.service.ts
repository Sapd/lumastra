// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Orchestrates playback incident ingestion: validates server_diagnostic_code
 * against the real allowlist (never trusts the client), truncates the
 * timeline to spec (keeping the tail), redacts secrets/emails/paths at WRITE time
 * (protects the database, not just a later copy step), and maps the
 * camelCase API shape to the snake_case DB row shape.
 */

import type postgres from 'postgres';
import {
    insertPlaybackIncidentEvent,
    resolveUnresolvedIncidentsByAttempt,
    type NewPlaybackIncidentEvent,
} from '$lib/server/database/queries/playback-incident-events.queries.js';
import { parseStreamDiagnosticCode } from '$lib/utils/playback-diagnostics.js';
import { deepRedact } from './client-diagnostics/redact.js';
import type {
    PlaybackIncidentReportInput,
    PlaybackIncidentResolveInput,
} from '$lib/schemas/playback.js';

const TIMELINE_MAX_ENTRIES = 120;

/**
 * Serialized-size ceiling for the stored timeline. The entry-count cap above
 * bounds HOW MANY events a row can carry but says nothing about how big each
 * one is — 120 entries stuffed with large free-text fields still fit inside
 * the schema's 256 KiB hostile-payload backstop, which would put an ~8x
 * oversized row in the table. This is the real bound; the schema's cap only
 * exists to reject wildly malicious payloads before they reach here.
 */
const TIMELINE_MAX_BYTES = 32 * 1024;

/**
 * Drops entries from the HEAD (oldest first) until the array serializes under
 * {@link TIMELINE_MAX_BYTES} — the same "keep the tail" policy as the
 * entry-count truncation, since the events closest to the incident are the
 * ones worth keeping. Sizes are measured once per entry walking backwards
 * from the tail, so this stays linear rather than re-serializing the whole
 * array per dropped entry.
 */
function truncateTimelineToBytes(timeline: unknown[]): unknown[] {
    let bytes = 2; // the enclosing '[' and ']'
    let firstKept = timeline.length;
    for (let i = timeline.length - 1; i >= 0; i--) {
        let entryBytes: number;
        try {
            entryBytes = Buffer.byteLength(JSON.stringify(timeline[i]) ?? 'null', 'utf8');
        } catch {
            // Non-serializable entry (cycle, BigInt) — it and everything older
            // than it is dropped rather than risking a throw at INSERT time.
            break;
        }
        // Every entry except the newest one also costs a ',' separator.
        const withEntry = bytes + entryBytes + (firstKept < timeline.length ? 1 : 0);
        if (withEntry > TIMELINE_MAX_BYTES) break;
        bytes = withEntry;
        firstKept = i;
    }
    return firstKept === 0 ? timeline : timeline.slice(firstKept);
}

/**
 * Full client-diagnostics redaction (same as every other kind): credential-shaped KEYS,
 * then credential patterns, Authorization headers, emails and home-directory paths in
 * every string leaf at any nesting depth.
 */
function redactTimeline(timeline: unknown[]): unknown[] {
    return deepRedact(timeline);
}

/**
 * Platform fallback for playback incidents ingested through diagnostics events.
 * The envelope's explicit platform is authoritative. When inferring a platform
 * from legacy metadata, `clientInfo.platform` wins if recognized; otherwise
 * the request User-Agent decides.
 *
 * Apple app UAs seen on prod: `Lumastra-tvOS/…`, `stellar-tvos/… CFNetwork`,
 * `Lumastra-iOS/…`, `lumastra-ios/… CFNetwork`. A browser (including Safari on an
 * iPhone) sends `Mozilla/…` and is the web client.
 */
export function resolveIncidentPlatform(
    clientInfo: Record<string, unknown> | null | undefined,
    userAgent: string | null | undefined,
): 'ios' | 'tvos' | 'web' | 'other' {
    const named = typeof clientInfo?.platform === 'string' ? clientInfo.platform.toLowerCase() : '';
    if (named === 'ios' || named === 'tvos' || named === 'web') return named;
    const ua = userAgent ?? '';
    if (/^(lumastra|stellar)-tvos\//i.test(ua)) return 'tvos';
    if (/^(lumastra|stellar)-ios\//i.test(ua)) return 'ios';
    if (/^Mozilla\//.test(ua)) return 'web';
    return 'other';
}

export interface IncidentWriteOptions {
    eventId?: string;
    platform?: 'ios' | 'tvos' | 'web' | 'other';
    appVersion?: string | null;
    appBuild?: string | null;
    osVersion?: string | null;
    deviceModel?: string | null;
    logTail?: unknown;
}

/**
 * Returns whether this call actually inserted a new row — `false` when
 * `(user_id, event_id)` already existed (idempotent retry/duplicate submission).
 * Callers writing a batch (client-diagnostics ingest) use this to count
 * `accepted` correctly instead of over-reporting on a concurrent duplicate.
 */
export async function recordPlaybackIncident(
    sql: postgres.Sql,
    userId: string,
    input: PlaybackIncidentReportInput,
    opts: IncidentWriteOptions = {},
): Promise<boolean> {
    const validatedDiagnosticCode = input.serverDiagnosticCode
        ? parseStreamDiagnosticCode(input.serverDiagnosticCode)
        : null;

    // Two-stage truncation, both keeping the tail: entry count first, then
    // serialized size. Count alone is not a bound on the row — see
    // TIMELINE_MAX_BYTES.
    const truncatedTimeline = redactTimeline(
        truncateTimelineToBytes(input.timeline.slice(-TIMELINE_MAX_ENTRIES)),
    );

    // message, timeline and clientInfo all get the full deepRedact pass (key names,
    // credential patterns, Authorization, emails, home paths) — the same treatment the
    // other client-diagnostics kinds get; credential-pattern-only stripping left emails
    // and home-directory user names in incident rows.
    const redactedMessage = input.message ? deepRedact(input.message) : null;
    const redactedClientInfo = input.clientInfo ? deepRedact(input.clientInfo) : null;

    const row: NewPlaybackIncidentEvent = {
        attemptId: input.attemptId,
        playSessionId: input.playSessionId,
        incidentAt: new Date(input.incidentAt),
        triggerType: input.triggerType,
        errorType: input.errorType ?? null,
        stage: input.stage ?? null,
        httpStatus: input.httpStatus ?? null,
        serverDiagnosticCode: validatedDiagnosticCode,
        reconnectCause: input.reconnectCause ?? null,
        message: redactedMessage,
        userId,
        deviceId: input.deviceId ?? null,
        mediaId: input.mediaId ?? null,
        timeline: truncatedTimeline,
        clientInfo: redactedClientInfo,
        ...opts,
        logTail: opts.logTail ? deepRedact(opts.logTail) : undefined,
    };

    const { inserted } = await insertPlaybackIncidentEvent(sql, row);
    return inserted;
}

export async function resolvePlaybackIncident(
    sql: postgres.Sql,
    userId: string,
    input: PlaybackIncidentResolveInput,
): Promise<void> {
    // Resolves ALL unresolved rows for this attempt in one atomic UPDATE, not
    // just the most recent — a no-op (0 rows affected) when none exist is a
    // legitimate, silent outcome (losing a "recovered" signal is acceptable).
    await resolveUnresolvedIncidentsByAttempt(sql, userId, input.attemptId);
}
