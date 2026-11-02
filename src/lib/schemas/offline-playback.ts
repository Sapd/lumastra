// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { lenientBatchBody } from './lenient-batch.js';

/** Clock-skew ceiling: a record may claim to have ended slightly in the future. */
export const OFFLINE_MAX_SKEW_MS = 5 * 60 * 1000;
/** Oldest record the endpoint accepts. Matches the pending-resolution buffer. */
export const OFFLINE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Tolerance when checking active play time against the wall-clock window. */
export const OFFLINE_ELAPSED_TOLERANCE_MS = 60 * 1000;
/** Maximum records per request. */
export const OFFLINE_MAX_BATCH = 50;
/**
 * Maximum number of per-field issues surfaced in a `reason: 'invalid'`
 * result's `details`. Bounds the response size against a pathological
 * payload (e.g. a record whose every field fails a distinct check).
 */
export const OFFLINE_INVALID_DETAILS_MAX = 10;

export const OfflinePlaybackRecordSchema = z
    .object({
        eventId: z.string().uuid().describe('Client-generated, retained until a terminal result'),
        mediaId: z.string().uuid(),
        startedAt: z.string().datetime(),
        endedAt: z.string().datetime().describe('Authoritative occurrence time; never upload time'),
        positionMs: z
            .number()
            .int()
            .nonnegative()
            .describe(
                'File-absolute playback position, exactly like the live player reports it — ' +
                    'NOT relative to an episode window inside a combined multi-episode file. ' +
                    'The server windows this per episode itself.',
            ),
        runtimeMs: z.number().int().nonnegative(),
        sessionElapsedMs: z
            .number()
            .int()
            .nonnegative()
            .describe('Active play time, excluding pause and buffering'),
        endReason: z.enum(['stopped', 'completion']),
        knownAsOf: z
            .string()
            .datetime()
            .nullish()
            .describe(
                'When this client last incorporated server state for the item — NOT when ' +
                    'the stretch started. It bounds the blind spot: anything written ' +
                    'elsewhere after it was invisible to this client, so the server will ' +
                    'not let this record lower the resume point below a position ' +
                    'established after it. Omit only if the client genuinely cannot track ' +
                    'it; an absent value is read as an UNBOUNDED blind spot (the record ' +
                    'may then not lower the resume point below any other source at all), ' +
                    'which is the safe reading but a blunter one than a real timestamp.',
            ),
    })
    .superRefine((v, ctx) => {
        const started = Date.parse(v.startedAt);
        const ended = Date.parse(v.endedAt);
        // A knowledge stamp in the future would widen the client's claimed
        // currency beyond anything it can have observed, which is the one
        // direction that disables the guard rather than tightening it.
        // Clamping silently would hide a broken client clock, so reject.
        if (v.knownAsOf != null && Date.parse(v.knownAsOf) > ended + OFFLINE_MAX_SKEW_MS) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'knownAsOf must not postdate endedAt',
                path: ['knownAsOf'],
            });
        }
        if (ended < started) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'endedAt must not precede startedAt',
                path: ['endedAt'],
            });
        }
        // `endedAt` is bounded by the endpoint against skew and max-age, but
        // `startedAt` never was — so a record could claim a window opening
        // years ago and that value lands verbatim in `watch_history` as the
        // session's start and duration. Bounded by the same max-age window,
        // since a record too old to accept is too old to have started in.
        if (ended - started > OFFLINE_MAX_AGE_MS) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'startedAt is implausibly far before endedAt',
                path: ['startedAt'],
            });
        }
        if (v.sessionElapsedMs > ended - started + OFFLINE_ELAPSED_TOLERANCE_MS) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'sessionElapsedMs exceeds the wall-clock window',
                path: ['sessionElapsedMs'],
            });
        }
    })
    .meta({ id: 'OfflinePlaybackRecord' });

export type OfflinePlaybackRecord = z.infer<typeof OfflinePlaybackRecordSchema>;

/** Runtime validates the envelope only; malformed records receive individual results. */
export const OfflineSessionsBatch = lenientBatchBody(OfflinePlaybackRecordSchema, {
    key: 'sessions',
    min: 1,
    max: OFFLINE_MAX_BATCH,
});
export const OfflineSessionsRequestSchema = OfflineSessionsBatch.runtime;

/**
 * Every reason a record can be rejected. Published as an enum rather than a
 * free string so a client can exhaustively map them instead of pattern-matching
 * on prose that could change under it.
 */
export const OFFLINE_REJECTION_REASONS = [
    'invalid',
    'too_old',
    'unsupported_media_type',
    'not_found',
    'too_far_future',
    'write_failed',
    'not_processed',
] as const;

export const OfflineRejectionReasonSchema = z.enum(OFFLINE_REJECTION_REASONS);
export type OfflineRejectionReason = (typeof OFFLINE_REJECTION_REASONS)[number];

/**
 * Rejections that resubmitting the SAME record can never fix.
 *
 *  - `invalid`                — the record's own shape is wrong.
 *  - `too_old`                — past the 90-day age cap, and only gets older.
 *  - `unsupported_media_type` — music has no resume point to write.
 *  - `not_found`              — the media is gone or not visible to this user.
 *
 * Everything else is transient by construction: `write_failed` rolled the whole
 * group back and wrote nothing, `too_far_future` becomes valid as server-now
 * catches up with a fast device clock, and `not_processed` is a defensive
 * fallback that should never be terminal.
 */
export const PERMANENT_OFFLINE_REJECTION_REASONS = [
    'invalid',
    'too_old',
    'unsupported_media_type',
    'not_found',
] as const satisfies readonly OfflineRejectionReason[];

/**
 * Whether a client should keep a record queued and resubmit it later.
 *
 * Deliberately inverted: permanence is an ALLOW-LIST and everything else —
 * including a reason this build does not recognise — is retryable. The two
 * misfilings are not symmetric. Calling a permanent reason retryable costs a
 * wasted batch slot until the record ages into `too_old`; calling a transient
 * one permanent destroys listening that was still recoverable. A future reason
 * added without classifying it therefore fails safe.
 *
 * Only a rejection is ever retryable — `accepted` and `duplicate` are both
 * terminal successes, and `duplicate` specifically means an earlier submission
 * already landed (its side effects, including the AudiobookShelf position push,
 * re-run on every resubmission).
 */
export function isRetryableOfflineResult(
    status: 'accepted' | 'duplicate' | 'rejected',
    reason: string | undefined,
): boolean {
    if (status !== 'rejected') return false;
    return !(PERMANENT_OFFLINE_REJECTION_REASONS as readonly string[]).includes(reason ?? '');
}

/**
 * One structured validation-failure entry — a field path plus a short reason
 * it failed. Deliberately carries no `value`: these records hold user
 * playback data and this response may be logged, so submitted values are
 * never echoed back (unlike `ValidationDetail.value` elsewhere in the API).
 */
export const OfflineResultDetailSchema = z.object({
    field: z.string().describe('Dot-joined path of the failing field, e.g. "eventId"'),
    message: z.string().describe('Short, non-echoing description of why the field failed'),
});
export type OfflineResultDetail = z.infer<typeof OfflineResultDetailSchema>;

export const OfflineSessionResultSchema = z.object({
    eventId: z
        .string()
        .nullable()
        .describe(
            'Submitted eventId, or null if the malformed record supplied no string id; results retain input order',
        ),
    status: z.enum(['accepted', 'duplicate', 'rejected']),
    reason: OfflineRejectionReasonSchema.optional(),
    /**
     * Present only when `reason` is `'invalid'`: the field path(s) that
     * failed Zod validation, so a client can tell a bad `eventId` apart from
     * a bad timestamp instead of a single opaque `invalid`. Bounded to
     * {@link OFFLINE_INVALID_DETAILS_MAX} entries. Never echoes submitted
     * values.
     */
    details: z.array(OfflineResultDetailSchema).max(OFFLINE_INVALID_DETAILS_MAX).optional(),
    retryable: z
        .boolean()
        .describe(
            'True when resubmitting this exact record later can still succeed. False for ' +
                'accepted/duplicate (both terminal successes) and for permanently-bad records.',
        ),
    /**
     * Whether this record is the one that determines the item's CURRENT state.
     *
     * `status` answers a narrower question than clients read it as: `accepted`
     * means the event row was written to the log, which is not the same as the
     * position being the one in effect. Arbitration runs afterwards, over every
     * source, and a perfectly valid record can lose it — to a newer position
     * another device set, to the offline blind-spot guard, or to a decisive
     * mark that clears the resume point. Measured on prod 2026-08-27: two
     * audiobook records came back `accepted` and both watch-state rows still
     * read `positionMs: 0`, with nothing in the response distinguishing that
     * from success.
     *
     * True means the resume point now materialised for this item is the one
     * this record reported, or (video only) this record's own completion is
     * why the point is cleared. False means the record is stored but inert:
     * something else is authoritative. That is a NORMAL, terminal outcome —
     * `retryable` stays false and the client must not resubmit — but it is
     * the client's cue to re-read the item's state rather than assume its
     * local position won.
     *
     * OPTIONAL on the wire on purpose. Making it required would be a one-way
     * door for Swift/tvOS codegen, and absent is meaningful in its own right:
     * a server too old to report it. Present on every result this build
     * returns.
     */
    applied: z
        .boolean()
        .optional()
        .describe(
            "True when this record's reported position is the resume point now in effect " +
                '(or its completion is why there is none). False when the record was stored ' +
                'but lost arbitration to another source — terminal, not retryable, but a ' +
                'signal to re-read state rather than trust the local position. Absent from ' +
                'servers that predate this field.',
        ),
});

/** The result shape as it appears ON THE WIRE — the service's own
 *  `OfflineSessionResult` has no `retryable`, which the endpoint derives. */
export type OfflineSessionResultWire = z.infer<typeof OfflineSessionResultSchema>;

export const OfflineSessionsResponseSchema = z.object({
    results: z.array(OfflineSessionResultSchema),
    summary: z.object({
        accepted: z.number().int().nonnegative(),
        duplicate: z.number().int().nonnegative(),
        rejected: z.number().int().nonnegative(),
    }),
});
