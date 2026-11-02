// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music replay outcomes and timestamp acceptance window for /play-sessions/replay.
 *
 * ## Why music needs its own batch vehicle
 *
 * `offline-playback.ts` already carries queued playback for video and
 * audiobooks, but it rejects music outright with `unsupported_media_type`:
 * that endpoint's job is writing a RESUME POINT, and a track has no resume
 * point worth restoring. Music's offline problem is the opposite one —
 * there is no position to save, but there IS a play-count/skip signal per
 * track, and a two-hour offline listen produces dozens of them.
 *
 * The shapes here deliberately mirror `offline-playback.ts`
 * (`status` / `reason` / `retryable` / `summary`) so a client can reuse the
 * flush-queue logic it already has instead of learning a second dialect.
 */

import { z } from 'zod';
import { MusicPlayEndRequestSchema } from './music.js';

/**
 * How far in the FUTURE a `startedAt` may claim to be before it is rejected.
 * Device clocks drift; this is skew tolerance, not a feature.
 */
export const MUSIC_PLAY_EVENT_MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Oldest `startedAt` the server will accept.
 *
 * Matches `OFFLINE_MAX_AGE_MS` in `offline-playback.ts` on purpose — a client
 * holding one offline queue should not have to remember two different
 * expiry rules depending on what kind of media the entry describes.
 *
 * There must be SOME cap: without one, a client with a badly wrong clock (or
 * a replayed queue file) can inject listening history at an arbitrary point
 * in the past, and those rows silently re-weight recency-ranked surfaces —
 * recently-played, the taste stations, and the download rotation lane — with
 * no way for a user to see why.
 */
export const MUSIC_PLAY_EVENT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Maximum events per batch request.
 *
 * Higher than `OFFLINE_MAX_BATCH` (50) because the unit is a TRACK, not a
 * listening session: a single long-haul flight yields on the order of a
 * hundred finished tracks but only a handful of audiobook sessions. Sized so
 * a typical offline backlog clears in one request rather than a paced loop.
 */
export const MUSIC_PLAY_END_MAX_BATCH = 100;

/** Cap on per-field issues surfaced for one `invalid` result. */
export const MUSIC_PLAY_END_INVALID_DETAILS_MAX = 10;

/**
 * RUNTIME envelope schema, mounted as `request.body`.
 *
 * `events` is `z.unknown()` on purpose, exactly as
 * `OfflineSessionsRequestSchema` does it, and for the same reason: if the
 * per-event shape were validated here, ONE malformed event among a hundred
 * would 422 the entire request before the handler ran. A client that only
 * drops a queued event after seeing a terminal per-event result would then
 * retry the same doomed batch forever, and the ninety-nine good events would
 * never land. Each event is instead re-validated individually inside the
 * handler and a failure becomes one `rejected`/`invalid` result alongside
 * normal results for its batch-mates.
 */
export const MusicPlayEndBatchRequestSchema = z
    .object({
        events: z.array(z.unknown()).min(1).max(MUSIC_PLAY_END_MAX_BATCH),
    })
    .meta({ id: 'MusicPlayEndBatchRequest' });

/**
 * Well-known rejection reasons. The wire schema remains an open string;
 * clients use the server's retryable flag for every reason, including unknown ones.
 */
export const MUSIC_PLAY_END_REJECTION_REASONS = [
    'invalid',
    'too_old',
    'too_far_future',
    'not_found',
    'write_failed',
    'not_processed',
] as const;

export const MusicPlayEndRejectionReasonSchema = z
    .string()
    .describe(
        'Open reason string. Well-known values: invalid, too_old, too_far_future, not_found, write_failed, not_processed. Use retryable for unknown values.',
    );
export type MusicPlayEndRejectionReason = (typeof MUSIC_PLAY_END_REJECTION_REASONS)[number];

/**
 * Rejections that resubmitting the SAME event can never fix.
 *
 *  - `invalid`   — the event's own shape is wrong; it will fail identically forever.
 *  - `too_old`   — past the age cap, and it only gets older.
 *  - `not_found` — the track is deleted or not visible to this user.
 *
 * Everything else is transient by construction: `write_failed` wrote nothing,
 * `too_far_future` becomes valid as server-now catches up with a fast device
 * clock, and `not_processed` is a defensive fallback that should never be
 * terminal.
 */
export const PERMANENT_MUSIC_PLAY_END_REJECTION_REASONS = [
    'invalid',
    'too_old',
    'not_found',
] as const satisfies readonly MusicPlayEndRejectionReason[];

/**
 * Whether a client should keep an event queued and resubmit it later.
 *
 * Deliberately inverted, matching `isRetryableOfflineResult`: permanence is an
 * ALLOW-LIST and anything else — including a reason this build does not
 * recognise — is retryable. The two misfilings are not symmetric. Treating a
 * permanent reason as retryable costs one wasted batch slot until the event
 * ages out; treating a transient one as permanent silently discards listening
 * that was still recoverable. A reason added later without being classified
 * therefore fails safe.
 *
 * Only a rejection is ever retryable — `recorded` and `duplicate` are both
 * terminal successes, and `duplicate` specifically means an earlier submission
 * already landed.
 */
export function isRetryableMusicPlayEndResult(
    status: 'recorded' | 'duplicate' | 'rejected',
    reason: string | undefined,
): boolean {
    if (status !== 'rejected') return false;
    return !(PERMANENT_MUSIC_PLAY_END_REJECTION_REASONS as readonly string[]).includes(
        reason ?? '',
    );
}

/**
 * One structured validation-failure entry. Carries no `value`: these events
 * describe what a user listened to and this response may be logged, so
 * submitted values are never echoed back.
 */
export const MusicPlayEndResultDetailSchema = z.object({
    field: z.string().describe('Dot-joined path of the failing field, e.g. "startedAt"'),
    message: z.string().describe('Short, non-echoing description of why the field failed'),
});
export type MusicPlayEndResultDetail = z.infer<typeof MusicPlayEndResultDetailSchema>;

export const MusicPlayEndBatchResultSchema = z
    .object({
        /**
         * Position of this event in the submitted `events` array. This — not
         * `eventId` — is the join key, because an event can be rejected as
         * `invalid` precisely BECAUSE its `eventId` was missing or malformed,
         * and such a result still has to be attributable to a queue entry.
         */
        index: z.number().int().nonnegative(),
        /**
         * Echo of the submitted `eventId`, or null when the event did not
         * carry a usable one. Never a server-minted substitute: inventing an
         * id here would let a client believe an id was accepted that the
         * server will not recognise on the next retry.
         */
        eventId: z.string().nullable(),
        status: z
            .enum(['recorded', 'duplicate', 'rejected'])
            .describe(
                '`recorded` — newly written. `duplicate` — this (user, eventId) was already ' +
                    'recorded by an earlier request and was NOT counted again; treat exactly ' +
                    'like `recorded` and drop the queue entry. `rejected` — see `reason` and ' +
                    '`retryable`.',
            ),
        reason: MusicPlayEndRejectionReasonSchema.nullable(),
        details: z.array(MusicPlayEndResultDetailSchema).max(MUSIC_PLAY_END_INVALID_DETAILS_MAX),
        retryable: z
            .boolean()
            .describe(
                'True when resubmitting this exact event later can still succeed. False for ' +
                    'recorded/duplicate (both terminal successes) and for permanently-bad events. ' +
                    'Computed server-side so an unfamiliar `reason` still yields a correct ' +
                    'keep-or-drop decision.',
            ),
    })
    .meta({ id: 'MusicPlayEndBatchResult' });

export const MusicPlayEndBatchResponseSchema = z
    .object({
        results: z
            .array(MusicPlayEndBatchResultSchema)
            .describe('One result per submitted event, in submission order.'),
        summary: z.object({
            recorded: z.number().int().nonnegative(),
            duplicate: z.number().int().nonnegative(),
            rejected: z.number().int().nonnegative(),
        }),
    })
    .meta({ id: 'MusicPlayEndBatchResponse' });

export type MusicPlayEndBatchResponse = z.infer<typeof MusicPlayEndBatchResponseSchema>;

/** Re-exported so the batch endpoint and its tests have one import site. */
export { MusicPlayEndRequestSchema };
