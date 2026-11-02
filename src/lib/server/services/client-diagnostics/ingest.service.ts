// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client diagnostics ingest: gate → budget → normalize/redact → fingerprint → insert.
 * user_id always comes from auth, never from the body.
 *
 * Fix round 1 (2026-09-26 review) hardened this module against four issues found by
 * review:
 *  1. The bundle decode semaphore now wraps base64 decode + inflate, not just inflate —
 *     a queued caller no longer holds a decoded buffer while waiting for a slot.
 *  2. The daily byte budget is read and spent under a per-user
 *     `pg_advisory_xact_lock`, inside the SAME transaction as the inserts it gates —
 *     concurrent requests from one user can no longer all observe the same "remaining
 *     budget" and collectively overshoot it (same class of bug as the conditional-INSERT-
 *     on-a-COUNT trap elsewhere in this repo).
 *  3. A batch's regular rows AND its playback incidents are written in ONE transaction
 *     (incidents via `recordPlaybackIncident`, which now runs on the transaction's own
 *     `sql` handle and reports whether it actually inserted a row), so an unexpected
 *     failure partway through rolls back the whole batch, and a duplicate — including a
 *     concurrent duplicate incident — is never double-counted as accepted.
 *  4. A log bundle's CONTENT is scrubbed server-side (inflate → scrub every line →
 *     re-gzip) before it is stored; `sha256`/`uncompressedBytes`/`contentBytes` describe
 *     the STORED (sanitized) bytes, and the byte budget charges the stored size, never
 *     the upload's original size.
 * Two further corrections from review:
 *  5. `playback_incident` is exempt from the daily byte budget entirely (always-on, like
 *     the feature gate itself) — it is excluded from both the budget SUM and the budget
 *     check. Its volume bound is instead a per-user cap of
 *     PLAYBACK_INCIDENT_MAX_ROWS_PER_USER new incident rows per rolling 24 h, checked
 *     under the same advisory lock (final review I1: 50 per batch × 60 req/min made the
 *     rate limit alone no bound).
 *  6. A retry — the same (user_id, event_id) resent, in a batch or as a bundle — is
 *     looked up and skipped BEFORE budgeting, so it is neither charged nor dropped.
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type postgres from 'postgres';
import {
    config,
    CLIENT_DIAGNOSTICS_DAILY_BYTES_PER_USER,
    PLAYBACK_INCIDENT_MAX_ROWS_PER_USER,
} from '$lib/server/config.js';
import {
    AUTOMATIC_KINDS,
    EVENT_LIMITS,
    type DiagnosticBundleInput,
    type DiagnosticEventInput,
} from '$lib/schemas/client-diagnostics.js';
import {
    playbackIncidentReportSchema,
    type PlaybackIncidentReportInput,
} from '$lib/schemas/playback.js';
import {
    insertClientDiagnostics,
    insertLogBundle,
    sumBytesLast24h,
    countKindLast24h,
    type NewClientDiagnostic,
} from '$lib/server/database/queries/client-diagnostics.queries.js';
import { recordPlaybackIncident } from '$lib/server/services/playback-incident.service.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { deepRedact, scrubText } from './redact.js';
import { fingerprintFor } from './fingerprint.js';
import { summaryFor, shortIdFor } from './summary.js';
import { inflateBounded, InflateLimitError } from './gzip.js';
import { withBundleSlot, BundleBusyError } from './semaphore.js';

let budgetOverride: number | null = null;
/** Test seam: ESM const bindings cannot be spied. */
export function setBudgetOverrideForTests(value: number | null): void {
    budgetOverride = value;
}
const dailyBudget = (): number => budgetOverride ?? CLIENT_DIAGNOSTICS_DAILY_BYTES_PER_USER;

let incidentCapOverride: number | null = null;
/** Test seam for the per-user rolling-24h playback-incident cap. */
export function setIncidentCapOverrideForTests(value: number | null): void {
    incidentCapOverride = value;
}
/** New playback incidents accepted per user per rolling 24 h via /diagnostics/events —
 *  their volume bound, since they are exempt from the byte budget (a batch may carry
 *  50 incidents at 60 requests/min, so the rate limit alone is no bound). */
const dailyIncidentCap = (): number => incidentCapOverride ?? PLAYBACK_INCIDENT_MAX_ROWS_PER_USER;

let storedBundleCapOverride: number | null = null;
/** Test seam for the stored (post-scrub, re-gzipped) bundle size cap. */
export function setStoredBundleCapOverrideForTests(value: number | null): void {
    storedBundleCapOverride = value;
}
const storedBundleCap = (): number => storedBundleCapOverride ?? EVENT_LIMITS.bundleGzipBytes;

/** Kinds that never count toward, or are blocked by, the daily byte budget.
 *  compat_incident is server-written (not client spend), so it must not eat the
 *  user's own log-bundle / crash budget. */
const BUDGET_EXEMPT_KINDS = ['playback_incident', 'compat_incident'] as const;

/** Per-user lock key for the byte-budget critical section — shared by the events batch
 *  path and the bundle path so a user's spend is serialized across BOTH endpoints. */
const budgetLockKey = (userId: string): string => `client-diagnostics-budget:${userId}`;

export class InvalidIncidentError extends Error {}

/** Maps a normalized DiagnosticEventInput playback_incident's fields onto the shape
 *  playbackIncidentReportSchema/recordPlaybackIncident expect. */
function toLegacyIncidentShape(e: DiagnosticEventInput & { kind: 'playback_incident' }): unknown {
    const p = e.payload;
    return {
        attemptId: e.attemptId,
        playSessionId: e.playSessionId ?? '',
        incidentAt: e.occurredAt,
        triggerType: p.triggerType,
        errorType: p.errorType,
        stage: p.stage,
        httpStatus: p.httpStatus,
        serverDiagnosticCode: p.serverDiagnosticCode,
        reconnectCause: p.reconnectCause,
        message: p.message,
        timeline: p.timeline,
        clientInfo: p.clientInfo,
        deviceId: e.deviceId ?? null,
        mediaId: e.mediaId,
    };
}

function toRow(
    userId: string,
    e: DiagnosticEventInput,
    payload: Record<string, unknown>,
): NewClientDiagnostic {
    const serialized = JSON.stringify(payload);
    return {
        eventId: e.eventId,
        kind: e.kind,
        userId,
        deviceId: e.deviceId ?? null,
        platform: e.platform,
        appVersion: e.appVersion ?? null,
        appBuild: e.appBuild ?? null,
        osVersion: e.osVersion ?? null,
        deviceModel: e.deviceModel ?? null,
        playSessionId: e.playSessionId ?? null,
        attemptId: e.attemptId ?? null,
        mediaId: e.mediaId ?? null,
        occurredAt: new Date(e.occurredAt),
        fingerprint: fingerprintFor(e),
        occurrences: e.occurrences ?? 1,
        summary: summaryFor(e.kind, payload),
        payload,
        payloadBytes: Buffer.byteLength(serialized, 'utf8'),
    };
}

export async function ingestDiagnosticEvents(
    sql: postgres.Sql,
    userId: string,
    events: DiagnosticEventInput[],
): Promise<{ accepted: number; dropped: number }> {
    let dropped = 0;
    const keepTail = config.FEATURE_CLIENT_DIAGNOSTICS_LOG_TAIL;
    const gated = events.filter((e) => {
        const allowed = !AUTOMATIC_KINDS.has(e.kind) || config.FEATURE_CLIENT_DIAGNOSTICS;
        if (!allowed) dropped++;
        return allowed;
    });

    // Dedup by eventId WITHIN the batch, across BOTH kinds, in ONE unified pass over
    // `gated` in input order — ON CONFLICT stores one row per eventId, but splitting
    // into regular-row and incident candidates FIRST and deduping each set
    // independently (the previous shape) let the same eventId appearing once as a
    // regular kind and once as playback_incident escape dedup entirely: both would
    // proceed to budgeting/insertion below, and because regular rows are inserted
    // before incidents, the regular row would always win regardless of which one the
    // caller actually intended (or sent first). Deduping the unified stream before the
    // split makes the FIRST occurrence in the batch — regular or incident — win.
    // Later duplicates are neither accepted nor dropped — the same treatment as a
    // retry of an already-stored event.
    const seenEventIds = new Set<string>();
    const dedupedGated = gated.filter((e) => {
        if (seenEventIds.has(e.eventId)) return false;
        seenEventIds.add(e.eventId);
        return true;
    });

    const rowCandidates: { event: DiagnosticEventInput; raw: Record<string, unknown> }[] = [];
    const incidentCandidates: (DiagnosticEventInput & { kind: 'playback_incident' })[] = [];
    for (const e of dedupedGated) {
        const raw = { ...(e.payload as Record<string, unknown>) };
        if (!keepTail) delete raw.logTail;
        if (e.kind === 'playback_incident') {
            incidentCandidates.push({ ...e, payload: raw } as DiagnosticEventInput & {
                kind: 'playback_incident';
            });
        } else {
            rowCandidates.push({ event: e, raw });
        }
    }

    // Validate EVERY playback incident against the legacy normalizer's cross-field rule
    // (diagnostic-code allowlist, timeline truncation) BEFORE any row from this batch is
    // inserted — a 422 here must never leave a partial batch written. The validated,
    // zod-normalized shape is kept for the actual write below rather than re-derived.
    const validatedIncidents = new Map<string, PlaybackIncidentReportInput>();
    for (const inc of incidentCandidates) {
        const legacy = playbackIncidentReportSchema.safeParse(toLegacyIncidentShape(inc));
        if (!legacy.success) {
            throw new InvalidIncidentError(
                legacy.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
            );
        }
        validatedIncidents.set(inc.eventId, legacy.data);
    }

    if (rowCandidates.length === 0 && incidentCandidates.length === 0) {
        return { accepted: 0, dropped };
    }

    const allEventIds = [
        ...rowCandidates.map((c) => c.event.eventId),
        ...incidentCandidates.map((c) => c.eventId),
    ];

    // The whole batch — regular rows AND playback incidents — is written in ONE
    // transaction: an unexpected failure partway through rolls back everything rather
    // than leaving earlier rows committed against a batch the caller sees as failed.
    const accepted = await withTx(sql, async (tx) => {
        // Per-user advisory lock scoping the budget read + every write this batch makes.
        // Without it, concurrent requests from the same user can all read the same
        // "remaining budget" and collectively insert past it — the same class of bug as a
        // conditional INSERT on a COUNT with no lock. Held for the whole transaction, so
        // it also serializes against a concurrent bundle upload from the same user (see
        // `budgetLockKey`).
        await tx`SELECT pg_advisory_xact_lock(hashtext(${budgetLockKey(userId)}))`;

        // Retries — the same (user_id, event_id) resent in a later batch — are looked up
        // and skipped entirely, BEFORE budgeting: neither charged nor dropped, so a resend
        // at the exact budget boundary is a silent no-op, not a rejection.
        const existingRows = await tx<{ event_id: string }[]>`
            SELECT event_id FROM client_diagnostics
            WHERE user_id = ${userId}::uuid AND event_id = ANY(${allEventIds}::uuid[])
        `;
        const existing = new Set(existingRows.map((r) => r.event_id));

        // playback_incident is exempt from the budget entirely — excluded from the SUM
        // (so a heavy incident day never eats into other kinds' budget) and never charged
        // or blocked below.
        let budgetLeft =
            dailyBudget() -
            (await sumBytesLast24h(tx, userId, { excludeKinds: [...BUDGET_EXEMPT_KINDS] }));

        const rowsToInsert: NewClientDiagnostic[] = [];
        for (const { event, raw } of rowCandidates) {
            if (existing.has(event.eventId)) continue;
            const built = toRow(userId, event, deepRedact(raw));
            if (built.payloadBytes > budgetLeft) {
                dropped++;
                continue;
            }
            budgetLeft -= built.payloadBytes;
            rowsToInsert.push(built);
        }

        let acceptedCount = await insertClientDiagnostics(tx, rowsToInsert);

        // Incidents skip the byte budget but are capped at PLAYBACK_INCIDENT_MAX_ROWS_PER_USER
        // new rows per rolling 24 h, read under the same advisory lock so concurrent
        // batches cannot overshoot it. Excess incidents are counted as dropped.
        let incidentsLeft =
            incidentCandidates.length > 0
                ? dailyIncidentCap() - (await countKindLast24h(tx, userId, 'playback_incident'))
                : 0;

        for (const inc of incidentCandidates) {
            if (existing.has(inc.eventId)) continue;
            if (incidentsLeft <= 0) {
                dropped++;
                continue;
            }
            const validated = validatedIncidents.get(inc.eventId);
            if (!validated) continue; // unreachable — every candidate was validated above
            const p = inc.payload;
            const inserted = await recordPlaybackIncident(tx, userId, validated, {
                eventId: inc.eventId,
                platform: inc.platform,
                appVersion: inc.appVersion ?? null,
                appBuild: inc.appBuild ?? null,
                osVersion: inc.osVersion ?? null,
                deviceModel: inc.deviceModel ?? null,
                logTail: p.logTail,
            });
            if (inserted) {
                acceptedCount++;
                incidentsLeft--;
            }
        }

        return acceptedCount;
    });

    return { accepted, dropped };
}

/** Splits `text` into lines and runs `scrubText` over each — a log bundle's raw content
 *  (not just its structured fields) is redacted before it is ever written to disk. */
function scrubLines(text: string): string {
    return text
        .split('\n')
        .map((line) => scrubText(line))
        .join('\n');
}

type SanitizedBundle = { gz: Buffer; uncompressedBytes: number; sha256: string };
type DecodeFailure = { reason: 'too_large' | 'bad_gzip' };

/**
 * Decodes, inflates (bounded), scrubs every line, and re-gzips a bundle upload (the
 * re-gzipped size is held to the same 2 MiB cap as the upload) — entirely
 * inside the decode-slot semaphore, so a queued caller never holds a decoded base64
 * buffer or an inflated log while waiting for a slot (base64 decode used to happen
 * BEFORE the slot was acquired).
 */
async function decodeAndSanitizeBundle(
    contentGzipBase64: string,
): Promise<SanitizedBundle | DecodeFailure> {
    return withBundleSlot(async () => {
        const gz = Buffer.from(contentGzipBase64, 'base64');
        if (gz.length > EVENT_LIMITS.bundleGzipBytes) return { reason: 'too_large' } as const;

        let inflated: { text?: string };
        try {
            inflated = await inflateBounded(gz, EVENT_LIMITS.bundleInflatedBytes, {
                keepText: true,
            });
        } catch (err) {
            if (err instanceof InflateLimitError) return { reason: 'too_large' } as const;
            return { reason: 'bad_gzip' } as const;
        }

        const sanitizedText = scrubLines(inflated.text ?? '');
        const sanitizedGz = gzipSync(Buffer.from(sanitizedText, 'utf8'));
        // The documented 2 MiB compressed limit applies to what is STORED: a scrub can
        // lengthen lines, and our gzip level may differ from the client's, so a valid
        // ≤ 2 MiB upload can re-gzip larger. Reject rather than store past the limit.
        if (sanitizedGz.length > storedBundleCap()) return { reason: 'too_large' } as const;
        return {
            gz: sanitizedGz,
            uncompressedBytes: Buffer.byteLength(sanitizedText, 'utf8'),
            sha256: createHash('sha256').update(sanitizedText, 'utf8').digest('hex'),
        };
    });
}

function isDecodeFailure(v: SanitizedBundle | DecodeFailure): v is DecodeFailure {
    return 'reason' in v;
}

/** Server-originated bundles (e.g. /j ClientLog) — never reachable from the public ingest schema. */
export interface ServerBundleOptions {
    trigger?: 'client_upload';
    extraPayload?: Record<string, unknown>;
}

export async function ingestLogBundle(
    sql: postgres.Sql,
    userId: string,
    input: DiagnosticBundleInput,
    server?: ServerBundleOptions,
): Promise<
    | { ok: true; diagnosticId: number; eventId: string; shortId: string }
    | { ok: false; reason: 'disabled' | 'budget' | 'too_large' | 'bad_gzip' | 'busy' }
> {
    if (!config.FEATURE_CLIENT_LOG_BUNDLES) return { ok: false, reason: 'disabled' };

    // Cheap idempotency short-circuit BEFORE spending a decode slot on a retry — a resend
    // of an already-stored bundle is a no-op success, never charged or re-decoded. The
    // transaction below re-checks under the advisory lock, closing the race window
    // against a concurrent send of the same bundle.
    const alreadyStored = await sql<{ id: number }[]>`
        SELECT id FROM client_diagnostics WHERE user_id = ${userId}::uuid AND event_id = ${input.eventId}::uuid
    `;
    if (alreadyStored[0]) {
        return {
            ok: true,
            diagnosticId: alreadyStored[0].id,
            eventId: input.eventId,
            shortId: shortIdFor(input.eventId),
        };
    }

    let sanitized: SanitizedBundle | DecodeFailure;
    try {
        sanitized = await decodeAndSanitizeBundle(input.contentGzipBase64);
    } catch (err) {
        if (err instanceof BundleBusyError) return { ok: false, reason: 'busy' };
        throw err;
    }
    if (isDecodeFailure(sanitized)) return { ok: false, reason: sanitized.reason };

    // requestId is honoured only once sub-project 5 adds client_diagnostic_requests and an
    // ownership check; until then it is dropped and the bundle is stored as a plain
    // user-triggered send, never reaching payload.
    const payload: Record<string, unknown> = deepRedact({
        ...(input.note ? { note: input.note } : {}),
        trigger: server?.trigger ?? (input.trigger === 'admin_request' ? 'user' : input.trigger),
        scope: input.scope,
        ...(server?.extraPayload ?? {}),
        ...(input.accountIds
            ? // Lowercased + de-duplicated: erasure matches `payload->'accountIds' ?
              // lower(userId)`, and Apple clients send uppercase uuids.
              { accountIds: [...new Set(input.accountIds.map((id) => id.toLowerCase()))] }
            : {}),
        contentBytes: sanitized.gz.length,
        uncompressedBytes: sanitized.uncompressedBytes,
        sha256: sanitized.sha256,
    });

    return withTx(sql, async (tx) => {
        // Same per-user lock/key as the events path — a bundle upload and an events batch
        // from the same user are serialized against each other's budget accounting.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${budgetLockKey(userId)}))`;

        const existing = await tx<{ id: number }[]>`
            SELECT id FROM client_diagnostics WHERE user_id = ${userId}::uuid AND event_id = ${input.eventId}::uuid
        `;
        if (existing[0]) {
            return {
                ok: true as const,
                diagnosticId: existing[0].id,
                eventId: input.eventId,
                shortId: shortIdFor(input.eventId),
            };
        }

        // Budget charges the STORED (sanitized) size, never the original upload's.
        const budgetLeft =
            dailyBudget() -
            (await sumBytesLast24h(tx, userId, { excludeKinds: [...BUDGET_EXEMPT_KINDS] }));
        if (sanitized.gz.length > budgetLeft)
            return { ok: false as const, reason: 'budget' as const };

        const created = await insertLogBundle(
            tx,
            {
                eventId: input.eventId,
                kind: 'log_bundle',
                userId,
                deviceId: input.deviceId ?? null,
                platform: input.platform,
                appVersion: input.appVersion ?? null,
                appBuild: input.appBuild ?? null,
                osVersion: input.osVersion ?? null,
                deviceModel: input.deviceModel ?? null,
                playSessionId: input.playSessionId ?? null,
                attemptId: null,
                mediaId: input.mediaId ?? null,
                occurredAt: new Date(input.occurredAt),
                fingerprint: null,
                occurrences: 1,
                summary: summaryFor('log_bundle', payload),
                payload,
                payloadBytes: sanitized.gz.length,
            },
            {
                content: sanitized.gz,
                uncompressedBytes: sanitized.uncompressedBytes,
                sha256: sanitized.sha256,
            },
        );
        const id =
            created?.id ??
            (
                await tx<{ id: number }[]>`
                    SELECT id FROM client_diagnostics
                    WHERE user_id = ${userId}::uuid AND event_id = ${input.eventId}::uuid
                `
            )[0].id;
        return {
            ok: true as const,
            diagnosticId: id,
            eventId: input.eventId,
            shortId: shortIdFor(input.eventId),
        };
    });
}

/** Fixed namespace UUID for deriving deterministic eventIds from a legacy `/client-errors`
 *  beacon's `errorId` (UUIDv5-style, RFC 4122 §4.3, computed by hand with `node:crypto`
 *  rather than pulling in a uuid dependency for one call site). */
const JS_ERROR_LEGACY_NAMESPACE = 'a3f0c9d4-6b2e-4b7a-9c1d-8e5f2a7b3c60';

/** Deterministic UUIDv5-style id derived from `namespace` + `name`, so the same input
 *  always produces the same id — a resent beacon for the same errorId maps to the same
 *  eventId instead of minting a new row every retry. Exported for direct unit testing
 *  of the derivation (see processing.test.ts) — this is a pure function, not a test
 *  seam for mocking. */
export function deterministicUuidFrom(namespace: string, name: string): string {
    const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
    const hash = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest();
    const bytes = hash.subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 4122
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function recordJsErrorFromLegacy(
    sql: postgres.Sql,
    userId: string,
    body: {
        errorId: string;
        name?: string;
        message?: string;
        stack?: string;
        path?: string;
        /** The reporting tab's SvelteKit build (`$app/environment` version). */
        appVersion?: string;
    },
): Promise<void> {
    if (!config.FEATURE_CLIENT_DIAGNOSTICS) return;
    const event: DiagnosticEventInput = {
        // Deterministic, not randomUUID(): a resent beacon for the same errorId must map
        // to the same eventId so the (user_id, event_id) unique key makes the resend a
        // no-op instead of a second row.
        eventId: deterministicUuidFrom(JS_ERROR_LEGACY_NAMESPACE, body.errorId),
        platform: 'web',
        ...(body.appVersion ? { appVersion: body.appVersion } : {}),
        occurredAt: Date.now(),
        kind: 'js_error',
        payload: {
            errorId: body.errorId,
            name: body.name ?? 'Error',
            message: scrubText(body.message ?? ''),
            ...(body.stack ? { stack: scrubText(body.stack) } : {}),
            ...(body.path ? { route: body.path } : {}),
            origin: 'handle_error',
        },
    };
    await ingestDiagnosticEvents(sql, userId, [event]);
}
