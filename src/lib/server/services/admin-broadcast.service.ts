// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin-broadcast.service.ts — the emitter for `admin.broadcast`.
 *
 * An administrator writes one announcement; every eligible user gets an
 * ordinary durable inbox row for it, and the announcement can be pinned above
 * their inbox until it stops being true.
 *
 * ## This is not the session toast, and the difference is the whole design
 *
 * `broadcastAdminMessage()` in `play-session-events.service.ts` already sends an
 * admin message — to live PLAY SESSIONS, over the `admin` signal kind, with a
 * 60-second staleness window and no durable row anywhere.
 * `docs/architecture/user-events.md` argued against giving that a durable twin
 * and the argument still stands: a "the stream is restarting in five minutes"
 * toast is worthless an hour later, and persisting it would fill inboxes with
 * expired urgency.
 *
 * This addresses PEOPLE rather than sessions, and every property follows from
 * that one difference:
 *
 *  - **Durable**, because the recipient being offline at send time is the normal
 *    case, not a delivery failure.
 *  - **No TTL** (`ttlMs: null`), because a pin can outlive the 30-day default
 *    and an announcement that silently aged out from under its own pin would
 *    leave an empty pinned block and no explanation.
 *  - **Pinnable**, because "maintenance this Sunday" has to stay visible until
 *    Sunday rather than until the next three notifications push it down.
 *  - **Immutable text**, matching every other notification kind: a row already
 *    delivered to a thousand inboxes and mirrored into a thousand push banners
 *    cannot be meaningfully edited. Retraction is deletion (which cascades),
 *    not an edit endpoint.
 *
 * The two features are deliberately NOT merged.
 *
 * @module services/admin-broadcast.service
 */

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, type AuditActor } from '$lib/server/utils/audit-log.js';
import { publishUserEvent, type PersistOutcome } from './notification-events.service.js';
import {
    insertBroadcast,
    listBroadcastRecipients,
    listBroadcastRecipientsByIds,
    type AdminBroadcastRow,
    type BroadcastAudience,
    type BroadcastRecipient,
} from '$lib/server/database/queries/admin-broadcasts.queries.js';

const logger = Logger.for('AdminBroadcast');

/**
 * The wire string this service emits, written as a literal here on purpose.
 *
 * Same reasoning as `user-notifier.service.ts`'s pair, and the same guard reads
 * this file: `event-kinds.test.ts` greps the emitter source to prove the
 * advertised kind name and the emitted one are the same string. Importing
 * `KIND_ADMIN_BROADCAST` from the taxonomy would make that check pass against a
 * file that emits nothing at all, which is precisely the drift the guard exists
 * to catch.
 */
export const EVENT_KIND_ADMIN_BROADCAST = 'admin.broadcast';

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface SendBroadcastOpts {
    title: string;
    body?: string | null;
    /**
     * External destination a recipient reaches by tapping the announcement.
     *
     * Already validated to be an absolute `http:`/`https:` URL by
     * `SendBroadcastRequestSchema` — this service does NOT re-check it, and
     * must not become a second place the rule lives. Absent or empty = an
     * announcement with no link, which is the ordinary case.
     */
    linkUrl?: string | null;
    audience: BroadcastAudience;
    /** Required when `audience === 'users'`; ignored otherwise. */
    userIds?: readonly string[];
    pinned: boolean;
    /** ISO instant; only meaningful when `pinned`. Absent = pin forever. */
    pinExpiresAt?: string | null;
    /** Whether recipients also get an APNs push. */
    pushEnabled: boolean;
    /**
     * Username of the admin sending it — stored verbatim in `admin_broadcasts.created_by`
     * (a plain text column, by design: it must survive the account being erased,
     * see migration 16.209.0's rationale). NOT what the audit trail attributes
     * the action to — see `actor`.
     */
    createdBy: string;
    /**
     * The credential that sent this, for the audit trail (security review
     * 2026-09-13, R5) — carries the PAT/service-token/session kind and
     * credential id that `createdBy` alone cannot. Build with `auditActor(event)`
     * at the HTTP boundary; distinct from `createdBy` because the DB column
     * needs a plain, durable username while the audit row needs the fuller
     * attribution.
     */
    actor: AuditActor;
}

/**
 * Why a send was refused, in a shape the route handler can turn into a problem
 * response.
 *
 * A discriminated result rather than a thrown error, because both failures are
 * ordinary bad input rather than exceptional conditions, and the handler has to
 * name the offending ids in a 422 body — information that a thrown `Error`
 * would have to smuggle through a message string.
 */
export type SendBroadcastResult =
    | {
          ok: true;
          broadcast: AdminBroadcastRow;
          /**
           * Recipients whose durable row actually landed.
           *
           * Distinct from `broadcast.recipientCount`, which records who the
           * announcement was ADDRESSED to and is fixed at insert time. These two
           * agree on every ordinary send and diverge exactly when a fan-out
           * partially failed — which is the only reason to carry both.
           */
          deliveredCount: number;
          /**
           * Recipients whose delivery did not land. `0` on an ordinary send.
           *
           * Non-zero is not an error the caller should turn into a failure
           * status: the announcement exists, most recipients have it, and
           * re-sending would duplicate it for them. It is information the admin
           * surface must SHOW rather than a condition it must handle.
           */
          failedCount: number;
      }
    /** One or more selected users do not exist, or are deleted/disabled. */
    | { ok: false; reason: 'unknown_recipients'; unknownIds: string[] }
    /** Nobody would receive it — an empty selection, or an install with no active users. */
    | { ok: false; reason: 'no_recipients' };

/**
 * Resolve who this broadcast is addressed to.
 *
 * The `users` audience validates STRICTLY: every id the admin selected must
 * resolve to an active account, and an id that does not fails the whole send.
 * Silently dropping the unknown ones is the tempting alternative and it is
 * wrong — an admin who selected twelve people and reached nine would have no
 * way to notice, and the `recipient_count` they see afterwards would look like a
 * successful send.
 */
async function resolveRecipients(
    sql: postgres.Sql,
    opts: SendBroadcastOpts,
): Promise<{ recipients: BroadcastRecipient[] } | { unknownIds: string[] }> {
    if (opts.audience === 'all') {
        return { recipients: await listBroadcastRecipients(sql) };
    }

    const requested = opts.userIds ?? [];
    // De-duplicated before the diff: a client that sends the same id twice is
    // asking for one delivery, and without this the "found" set would be
    // smaller than the "requested" set and every duplicate would look unknown.
    const wanted = [...new Set(requested)];
    const recipients = await listBroadcastRecipientsByIds(sql, wanted);

    const found = new Set(recipients.map((r) => r.id));
    const unknownIds = wanted.filter((id) => !found.has(id));
    if (unknownIds.length > 0) return { unknownIds };

    return { recipients };
}

/**
 * Send an admin broadcast: write the parent row, then one durable notification
 * per recipient.
 *
 * ## The fan-out is SEQUENTIAL, and that is not an oversight
 *
 * `publishUserEvent` is not a cheap function. Per call it takes a Valkey INCR, a
 * Postgres INSERT that arbitrates delivery, a replay-list push, a pub/sub
 * publish, and conditionally a webhook enqueue and a push-outbox enqueue.
 * `Promise.all` over a thousand recipients issues a thousand of each at once:
 * the connection pool is drained by one admin action, the outbox tables take a
 * thousand-row write burst, and the SSE replay LIST — a SHARED, bounded
 * 500-entry buffer — is overrun by a single broadcast, evicting every other
 * user's replayable frames.
 *
 * Sequential turns that into steady pressure. A broadcast is a deliberate,
 * rare, human-initiated action; taking a few seconds to fan out is invisible to
 * the admin and the difference between "the announcement went out" and "the
 * announcement went out and the pool stalled".
 *
 * ## Per-recipient failures do not abort the send — but they are COUNTED
 *
 * Continuing past a failed recipient is right: the announcement is already
 * written and most of the audience already has it, so unwinding would be worse
 * than a partial delivery. Continuing SILENTLY was not. `publishUserEvent`
 * swallows its own insert errors (a recipient deleted mid-fan-out FK-violates,
 * and this loop is deliberately slow enough for that window to be real), so
 * without reading its outcome the admin was told `recipientCount` recipients
 * were reached no matter how many actually were.
 *
 * So each iteration records what happened and the result reports
 * `deliveredCount`/`failedCount` alongside the addressed count. The try/catch is
 * belt-and-braces on top of that: `publishUserEvent` does not throw by contract,
 * and a bug that made it throw must degrade this into a counted failure rather
 * than abandoning the remaining recipients mid-loop.
 *
 * No retry. A retry needs an idempotency story per recipient and the operator
 * already has one that works — look at the count, re-send to the users who
 * missed it. This is visibility, not delivery machinery.
 */
export async function sendBroadcast(
    sql: postgres.Sql,
    opts: SendBroadcastOpts,
): Promise<SendBroadcastResult> {
    const resolved = await resolveRecipients(sql, opts);
    if ('unknownIds' in resolved) {
        return { ok: false, reason: 'unknown_recipients', unknownIds: resolved.unknownIds };
    }

    const { recipients } = resolved;
    if (recipients.length === 0) {
        return { ok: false, reason: 'no_recipients' };
    }

    // The parent row first — every recipient copy needs its id, and the count
    // records who it was ADDRESSED to rather than how many copies survive later
    // deletions.
    const broadcast = await insertBroadcast(sql, {
        title: opts.title,
        body: opts.body ?? null,
        audience: opts.audience,
        recipientCount: recipients.length,
        pushEnabled: opts.pushEnabled,
        pinned: opts.pinned,
        ...(opts.pinExpiresAt ? { pinExpiresAt: opts.pinExpiresAt } : {}),
        createdBy: opts.createdBy,
    });

    let deliveredCount = 0;
    let failedCount = 0;

    for (const recipient of recipients) {
        let outcome: PersistOutcome;
        try {
            outcome = await publishUserEvent({
                userId: recipient.id,
                kind: EVENT_KIND_ADMIN_BROADCAST,
                // `title`/`body` are duplicated into every recipient's payload
                // rather than being read back through `broadcastId` at render
                // time. That is on purpose: the payload is what
                // `composePushContent` renders from, on the push path as well as
                // the inbox path, and the push content endpoint is reached by an
                // iOS Notification Service Extension with a few hundred
                // milliseconds and no appetite for an extra join. It also makes
                // the row self-describing — an exported inbox row still says
                // what the announcement said.
                //
                // Deliberately NO `coalesceKey`: that field feeds the unique
                // daily index from migration 16.191.0, and adding one would cap
                // an administrator at a single broadcast per user per UTC day.
                //
                // `linkUrl` rides in the payload for the same reason the text
                // does: the presenter builds the row's `link` from it on every
                // read, and the parent `admin_broadcasts` row is not consulted
                // at render time. It is spread on presence — an announcement
                // with no link carries no key at all, so `buildNotificationPresentation`
                // omits `link` exactly as it did before this field existed.
                data: {
                    broadcastId: broadcast.id,
                    title: opts.title,
                    ...(opts.body ? { body: opts.body } : {}),
                    ...(opts.linkUrl ? { linkUrl: opts.linkUrl } : {}),
                },
                broadcastId: broadcast.id,
                // Never expires — see the module header.
                ttlMs: null,
                skipPush: !opts.pushEnabled,
            });
        } catch (err) {
            // Contractually unreachable — see the header. Counted rather than
            // rethrown so one bad recipient cannot abandon the rest.
            logger.warn(
                'Broadcast fan-out threw for a recipient',
                { broadcastId: broadcast.id, userId: recipient.id },
                err as Error,
            );
            outcome = 'failed';
        }

        // `'conflict'` counts as DELIVERED: it means a durable row for this
        // notification already exists and another writer owns its delivery, not
        // that this recipient was missed. Only `'failed'` means nobody wrote
        // one. (`admin.broadcast` carries no `coalesceKey`, so nothing can
        // arbitrate a conflict for it today — reading it as a failure would
        // still be wrong the moment something does.)
        if (outcome === 'failed') {
            failedCount++;
        } else {
            deliveredCount++;
        }
    }

    if (failedCount > 0) {
        logger.warn('Admin broadcast partially delivered', {
            broadcastId: broadcast.id,
            recipientCount: recipients.length,
            deliveredCount,
            failedCount,
        });
    }

    auditLog('notification.broadcast.send', broadcast.id, opts.actor, {
        audience: opts.audience,
        recipientCount: recipients.length,
        // In the audit trail as well as the response: "who was addressed" and
        // "who was reached" are different facts, and an operator reconstructing
        // a complaint months later needs the second one from the record rather
        // than from a log line that has since rotated away.
        deliveredCount,
        failedCount,
        pinned: opts.pinned,
        pushEnabled: opts.pushEnabled,
        // Recorded because it is the one part of an announcement that sends
        // recipients somewhere this server does not control. "Which admin
        // pointed every user at that address, and when" is precisely the
        // question an audit trail exists to answer.
        ...(opts.linkUrl ? { linkUrl: opts.linkUrl } : {}),
    });

    logger.info('Admin broadcast sent', {
        broadcastId: broadcast.id,
        audience: opts.audience,
        recipientCount: recipients.length,
        deliveredCount,
        failedCount,
        pinned: opts.pinned,
        pushEnabled: opts.pushEnabled,
    });

    return { ok: true, broadcast, deliveredCount, failedCount };
}
