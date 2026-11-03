// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// PushOutbox — APNs delivery worker for `user_push_outbox`.
//
// Modelled directly on `webhook-outbox.ts`: an unref'd interval, a claim that
// bumps `next_attempt_at` forward instead of holding a row lock across IO, a
// per-row try/catch, and a CAS on `attempts` when rescheduling.
//
// NO LEADER ELECTION, deliberately. `claimReadyPushRows` selects
// `FOR UPDATE SKIP LOCKED` and pushes `next_attempt_at` past the claim TTL in
// the same transaction — that IS the cross-replica mutual exclusion, exactly as
// the webhook outbox runs unconditionally on every replica. Adding a leader
// check on top would only make delivery stop when the leader lock flaps.
//
// The ladder is short on purpose (see BACKOFF_SECONDS). The durable artifact of
// a notification is its `user_notifications` row and the live SSE frame; this
// worker delivers the lock-screen nudge on top of them. A nudge that arrives
// tomorrow is spam, so the row dies rather than lingering.

import { createRepeatWarning } from '$lib/server/utils/repeat-warning.js';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { UserId } from '$lib/shared/user-id';
import {
    claimReadyPushRows,
    markPushRowDead,
    markPushRowDelivered,
    reschedulePushRow,
    retireQueuedPushRows,
    type PushOutboxRow,
} from '$lib/server/database/queries/user-push-outbox.queries.js';
import {
    deactivatePushToken,
    getActivePushTokensForUser,
    type UserPushTokenRow,
} from '$lib/server/database/queries/user-push-tokens.queries.js';
import {
    countUnread,
    getNotificationById,
} from '$lib/server/database/queries/user-notifications.queries.js';
import {
    buildPushPayload,
    pushExpirationEpochSeconds,
    resolvePushLocale,
} from '$lib/server/services/push/push-payload.js';
import { resolvePushImageTarget } from '$lib/server/services/push/push-rich-content.js';
import { composePushContent } from '$lib/server/services/push/push-content-text.js';
import { currentPushTransportSelection } from '$lib/server/services/push/push-transport-selector.js';
import {
    buildPushContentUrl,
    buildPushImageUrl,
} from '$lib/server/services/push/push-rich-urls.js';
import {
    PushTransportError,
    type PushTransport,
} from '$lib/server/services/push/push-transport.js';
import { pushDeliveriesTotal } from './metrics.js';
import { awaitInFlightTick, LOOP_STOP_TIMEOUT_MS } from './loop-stop.js';

const log = Logger.for('PushOutbox');
const passFailures = createRepeatWarning(log);

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Backoff ladder in seconds: 1s, 10s, 60s, 5min, 15min → dead (~21 minutes).
 *
 * Deliberately far shorter than the webhook outbox's 24 hours. A "new episode"
 * banner arriving a day later is spam, not a notification — and the inbox row
 * survives regardless, so a dropped push loses a nudge, never the content.
 *
 * ~21 minutes rather than something shorter because the failure this ladder
 * actually rides out is CORRELATED: the relay going down takes every user's
 * pushes with it at the same instant. Our queue drains in one pass once it comes
 * back, while Apple's own retry window stays long — so buying the full 21
 * minutes costs almost nothing and covers a short relay blip end to end.
 */
const BACKOFF_SECONDS = [1, 10, 60, 300, 900] as const;

/**
 * Indexing convention, and it differs from `webhook-outbox.ts` on purpose:
 * that file calls `backoffSeconds(newAttempts)` (POST-increment), this one calls
 * `pushBackoffSeconds(row.attempts)` (PRE-increment). Pre-increment is what
 * makes the first retry wait `BACKOFF_SECONDS[0]` = 1s instead of skipping
 * straight to 10s. Change one side and the ladder silently shifts by a rung.
 */
export function pushBackoffSeconds(attempts: number): number {
    const idx = Math.min(attempts, BACKOFF_SECONDS.length - 1);
    return BACKOFF_SECONDS[idx];
}

/** Total ladder budget, used to decide whether a Retry-After still fits. */
const LADDER_BUDGET_SECONDS = BACKOFF_SECONDS.reduce<number>((a, b) => a + b, 0);

/**
 * Attempts allowed before the row dies — `length + 1`, NOT `length`.
 *
 * A ladder of N rungs describes the N waits BETWEEN attempts, so spending all N
 * of them takes N+1 attempts. With `MAX_ATTEMPTS = BACKOFF_SECONDS.length` the
 * last rung is unreachable: `pushBackoffSeconds` would only ever be called with
 * 0…3, the row would die after 1+10+60+300 = 371s ≈ 6 minutes, and the 900s
 * entry would be dead code that only the unit test's clamp assertion ever sees.
 * At `length + 1` the waits sum to exactly `LADDER_BUDGET_SECONDS` (1271s ≈ 21
 * min), which is what the throttle cut-off below and every doc comment claim.
 */
const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;

/**
 * How long a claim holds a row before another replica may take it.
 *
 * The budget this has to respect: one pass processes up to BATCH_SIZE rows
 * sequentially, and each row makes one transport call per
 * (bundle, environment, locale) group — so worst case is
 * `BATCH_SIZE × groups-per-row × per-call-duration < CLAIM_TTL_SECONDS`.
 * At 50 rows × ~2 groups that leaves ~3s per call. NOTHING ENFORCES THIS:
 * `PushTransport.send` carries no timeout in its contract, so a hung relay can
 * blow the TTL and let a second replica re-claim rows that are still in flight.
 *
 * What keeps that from being user-visible is `apns-collapse-id`: every send for
 * a row carries the notification id, so a double-send replaces the banner on the
 * lock screen instead of stacking a second one. That is a mitigation of the
 * SYMPTOM, not of the double-send — the real fix is a hard per-call timeout in
 * the transport implementation.
 */
const CLAIM_TTL_SECONDS = 300;
const DELIVERY_INTERVAL_MS = 1_000;
const BATCH_SIZE = 50;

// ── Helpers ───────────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * A device token is a credential: anyone holding it plus our relay's topic can
 * push to that device. Logs get shipped, tailed and pasted into issues, so only
 * ever emit a prefix long enough to correlate two lines about the same device.
 */
function tokenPreview(token: string): string {
    return `${token.slice(0, 8)}...`;
}

/**
 * Group key for one APNs call: an HTTP/2 stream targets ONE topic (`bundle_id`)
 * on ONE host (`environment`), and the alert text is rendered server-side per
 * locale.
 *
 * Keyed on the RESOLVED locale rather than the raw BCP-47 tag the client sent.
 * `en-US` and `en-GB` render byte-identical payloads, so splitting them would
 * buy two round-trips for one message. Every member of a bucket therefore
 * renders the same text, which is what lets the payload be built once from the
 * bucket's head.
 */
function groupKey(token: UserPushTokenRow): string {
    return [token.bundle_id, token.environment, resolvePushLocale(token.locale)].join('\u0000');
}

/** What one pass decided about a single group's transport call. */
interface GroupOutcome {
    /** Tokens APNs accepted. Appended to the row's `delivered_tokens`. */
    delivered: string[];
    /**
     * Non-null ⇒ retrying THIS GROUP can never help.
     *
     * Group-scoped, not row-scoped. `bundleId` is a client-supplied string, so
     * an iOS build registering an unknown bundle earns a relay 400 for its own
     * group alone — killing the whole row on it would take every other device's
     * group down with it. The row only dies when EVERY group failed
     * permanently (see `deliverRow`).
     */
    permanentReason: string | null;
    /** Honour an APNs `Retry-After` instead of the ladder's next rung. */
    retryAfterSeconds: number | null;
    /** At least one token or call failed in a way a retry could fix. */
    sawTransient: boolean;
}

// ── PushOutbox ────────────────────────────────────────────────────────────────

export class PushOutbox {
    private timer: ReturnType<typeof setInterval> | null = null;
    /** The delivery pass currently running, if any. stop() waits for it. */
    private inFlight: Promise<void> | null = null;
    private stopped = false;
    /**
     * Whether the retire-on-disable sweep has already run for the CURRENT
     * off-period. Reset the moment the flag comes back on, so the next
     * off-transition sweeps again.
     *
     * This exists because the feature is off by default: without it every
     * replica of every install runs one UPDATE per second, forever, for a
     * feature nobody enabled. One sweep per off-transition per replica is
     * enough — nothing can enqueue while the flag is off (the enqueue gate
     * checks the same flag first), so there is never new work to retire until
     * the flag has been on again, which is exactly when the latch clears.
     */
    private retiredWhileDisabled = false;

    constructor(
        private readonly sql: postgres.Sql,
        private readonly transport: PushTransport,
    ) {}

    start(): void {
        if (this.stopped || this.timer !== null) return;
        this.timer = setInterval(() => void this.tick(), DELIVERY_INTERVAL_MS);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    /**
     * Pause delivery (coordinator lost) and wait (bounded) for the pass in
     * flight. Unlike stop(), a later start() resumes delivery.
     */
    stopDelivery(timeoutMs: number = LOOP_STOP_TIMEOUT_MS): Promise<boolean> {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        return awaitInFlightTick('push-outbox', this.inFlight, timeoutMs);
    }

    /**
     * Stop delivering and wait (bounded) for the pass in flight. Resolves true
     * once no pass is running, false if the wait timed out.
     */
    stop(timeoutMs: number = LOOP_STOP_TIMEOUT_MS): Promise<boolean> {
        this.stopped = true;
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        return awaitInFlightTick('push-outbox', this.inFlight, timeoutMs);
    }

    private tick(): Promise<void> {
        if (this.stopped || this.inFlight) return Promise.resolve();
        this.inFlight = this.deliveryPass()
            .then(
                () => passFailures.reset(),
                (err: unknown) => {
                    // Every second while PostgreSQL is down: one warning per window.
                    passFailures.warn('PushOutbox delivery pass error', { err: errMsg(err) });
                },
            )
            .finally(() => {
                this.inFlight = null;
            });
        return this.inFlight;
    }

    /**
     * One delivery pass: retire-if-disabled, claim a batch, then resolve each
     * row's fate independently.
     *
     * Rows are processed sequentially rather than with `Promise.all`. Unlike the
     * webhook outbox — where each row is one HTTP POST to a different host — a
     * push row fans out to every one of a user's devices and the batch is 50
     * rows, so a parallel pass would open an unbounded number of concurrent
     * transport calls against a single relay.
     */
    async deliveryPass(): Promise<void> {
        // The operator gate, and it runs BEFORE the claim on purpose. Turning
        // the feature off has to STOP queued rows, not drain them: the enqueue
        // side already refuses to write new rows, so anything still pending was
        // queued while the switch was on and would otherwise keep pushing for
        // the length of the ladder after the operator said stop.
        if (!config.FEATURE_PUSH_NOTIFICATIONS) {
            // Latched to the off-TRANSITION, not run every tick. A disabled
            // install must do no periodic DB work at all — see
            // `retiredWhileDisabled`.
            if (this.retiredWhileDisabled) return;
            const retired = await retireQueuedPushRows(this.sql, 'feature_disabled');
            this.retiredWhileDisabled = true;
            if (retired > 0) {
                log.info('Retired queued push rows — feature disabled', { retired });
            }
            return;
        }
        this.retiredWhileDisabled = false;

        const rows = await claimReadyPushRows(this.sql, BATCH_SIZE, CLAIM_TTL_SECONDS);

        for (const row of rows) {
            try {
                await this.deliverRow(row);
            } catch (err) {
                // The claim already pushed `next_attempt_at` forward by the TTL,
                // so a row that blew up here (a DB hiccup mid-decision, say)
                // simply becomes eligible again in 5 minutes instead of
                // wedging the batch behind it.
                log.warn('PushOutbox: row failed', { id: row.id, err: errMsg(err) });
            }
        }
    }

    // -- Single row -----------------------------------------------------------

    private async deliverRow(row: PushOutboxRow): Promise<void> {
        const tokens = await getActivePushTokensForUser(this.sql, row.user_id as UserId);
        const already = new Set(row.delivered_tokens);
        const pending = tokens.filter((t) => !already.has(t.token));

        if (pending.length === 0) {
            // Nothing to send, so the row is done either way — but the two ways
            // are not the same health signal. `tokens.length === 0` means the
            // user has NO active device left (every token deactivated, or the
            // last one revoked between enqueue and now); counting that as
            // `delivered` would let a fleet that has lost every token read as
            // 100% healthy. The other case is a retry whose remaining tokens all
            // succeeded earlier, which genuinely is a delivery.
            await markPushRowDelivered(this.sql, row.id);
            pushDeliveriesTotal.inc({ outcome: tokens.length === 0 ? 'no_tokens' : 'delivered' });
            return;
        }

        const notification = await getNotificationById(this.sql, row.notification_id);
        if (!notification) {
            // The FK is ON DELETE CASCADE, so this is the narrow race where the
            // notification was pruned between the claim and this read.
            await markPushRowDead(this.sql, row.id, 'notification_gone');
            pushDeliveriesTotal.inc({ outcome: 'dead' });
            return;
        }

        const expirationEpochSeconds = pushExpirationEpochSeconds(notification.created_at);
        if (expirationEpochSeconds <= Math.floor(Date.now() / 1000)) {
            // The window is anchored to `created_at`, so a row that sat through
            // a worker or DB outage long enough can reach here already expired.
            // Sending anyway is the worst available outcome: APNs ACCEPTS a
            // past `apns-expiration`, silently drops the push, and returns
            // success — so every token comes back `ok`, the row is marked
            // delivered and DELETED, and the loss leaves no trace anywhere.
            // Dying with a truthful reason keeps it visible in the admin view.
            await markPushRowDead(this.sql, row.id, 'expired');
            pushDeliveriesTotal.inc({ outcome: 'dead' });
            log.info('PushOutbox: row expired before delivery', {
                id: row.id,
                expirationEpochSeconds,
            });
            return;
        }

        const badge = await countUnread(this.sql, row.user_id);

        // The artwork URL is resolved ONCE per row: it is locale-independent, and
        // the resolution is a real existence check against the artwork the byte
        // route would serve. `null` means this notification genuinely has no
        // picture, and the payload then omits `image_url` entirely — which is how
        // the extension distinguishes "no artwork" from "artwork we failed to
        // serve" and skips the fetch instead of showing a broken attachment.
        //
        // Best-effort, like every other part of this fan-out: a DB hiccup in the
        // presence check must degrade the banner, not kill the push.
        let imageUrl: string | undefined;
        try {
            const target = await resolvePushImageTarget(this.sql, row.kind, notification.payload);
            if (target) {
                imageUrl =
                    buildPushImageUrl(row.notification_id, notification.created_at) ?? undefined;
            }
        } catch (err) {
            log.warn('PushOutbox: artwork resolution failed, sending without image_url', {
                id: row.id,
                err: errMsg(err),
            });
        }

        const groups = new Map<string, UserPushTokenRow[]>();
        for (const t of pending) {
            const key = groupKey(t);
            const bucket = groups.get(key);
            if (bucket) bucket.push(t);
            else groups.set(key, [t]);
        }

        const delivered = [...row.delivered_tokens];
        let firstPermanentReason: string | null = null;
        let permanentGroups = 0;
        let retryAfter: number | null = null;
        let sawTransient = false;

        for (const bucket of groups.values()) {
            const outcome = await this.sendGroup(row, bucket, badge, expirationEpochSeconds, {
                createdAt: notification.created_at,
                imageUrl,
                payload: notification.payload,
            });
            delivered.push(...outcome.delivered);
            if (outcome.permanentReason !== null) {
                permanentGroups += 1;
                firstPermanentReason ??= outcome.permanentReason;
            }
            sawTransient ||= outcome.sawTransient;
            if (outcome.retryAfterSeconds !== null) {
                // Several groups can be throttled at once; respect the longest
                // wait Apple asked for rather than the last one seen.
                retryAfter = Math.max(retryAfter ?? 0, outcome.retryAfterSeconds);
            }
        }

        // The row dies on a permanent failure only when EVERY group hit one.
        // A single group failing permanently (an unknown `bundleId` from one
        // client build earning a relay 400, say) must not silence the user's
        // other devices — the surviving groups already delivered, and retrying
        // the broken one can never succeed, so there is nothing left to do for
        // it but log.
        const deadReason = permanentGroups === groups.size ? firstPermanentReason : null;
        if (deadReason === null && firstPermanentReason !== null) {
            log.warn('PushOutbox: one group failed permanently, others proceeded', {
                id: row.id,
                reason: firstPermanentReason,
                permanentGroups,
                groups: groups.size,
            });
            pushDeliveriesTotal.inc({ outcome: 'partial_dead' });
        }

        await this.resolveRow(row, { delivered, deadReason, retryAfter, sawTransient });
    }

    /** One transport call for one (bundle, environment, locale) bucket. */
    private async sendGroup(
        row: PushOutboxRow,
        bucket: UserPushTokenRow[],
        badge: number,
        expirationEpochSeconds: number,
        rich: { createdAt: Date; imageUrl: string | undefined; payload: unknown },
    ): Promise<GroupOutcome> {
        const out: GroupOutcome = {
            delivered: [],
            permanentReason: null,
            retryAfterSeconds: null,
            sawTransient: false,
        };
        const head = bucket[0];
        // The content URL is per-BUCKET, not per-row: the bucket key already
        // includes the resolved locale, and the locale is part of the signed path
        // (the endpoint is unauthenticated, so it has no user to read one from).
        const locale = resolvePushLocale(head.locale);

        // Content-free-ness is a property of the TRANSPORT, not of the product.
        // The relay is Lumastra-operated — a hop outside the operator's own
        // server — so a payload crossing it must never name the media. The
        // direct transport is a TLS connection from the operator's own server to
        // Apple, with no such intermediary, so withholding the title there buys
        // nothing and costs every user whose Notification Service Extension is
        // slow, unlucky or unsupported a generic banner for no reason.
        //
        // This used to be hardcoded `'content-free'`, which made the entire
        // content-ful branch of `buildPushPayload` unreachable from production
        // despite being implemented and tested.
        const transport = currentPushTransportSelection().kind;
        const contentFul = transport === 'direct';
        // Rendered from the SAME text renderer the NSE content endpoint and the
        // inbox use, so a banner that arrives already-populated is identical to
        // one the extension fills in.
        const text = contentFul ? composePushContent(row.kind, rich.payload, locale) : null;

        const payload = buildPushPayload({
            kind: row.kind,
            notificationId: row.notification_id,
            badge,
            locale: head.locale,
            mode: contentFul ? 'content-ful' : 'content-free',
            ...(text ? { mediaTitle: text.title, mediaSubtitle: text.body } : {}),
            // Both URLs name only the notification UUID, which `data.id` already
            // carries — so the relay learns nothing new, and the extension can
            // fetch real text and real artwork from the user's own server. Sent
            // on BOTH transports: on the direct one the extension still uses the
            // image URL for the attachment, and the content URL keeps the banner
            // correct if the payload is ever superseded.
            imageUrl: rich.imageUrl,
            contentUrl:
                buildPushContentUrl(row.notification_id, locale, rich.createdAt) ?? undefined,
        });

        const sentTokens = bucket.map((t) => t.token);
        // The authority on what this call covered. Results are attacker-shaped
        // input: they come back over the network from the relay, and everything
        // below that acts on a result — appending to `delivered_tokens`,
        // deactivating a token — is a write. Anchoring both to the tokens WE
        // sent is what keeps a buggy or hostile relay from reaching outside
        // this group.
        const sentSet = new Set(sentTokens);

        try {
            const results = await this.transport.send({
                bundleId: head.bundle_id,
                environment: head.environment,
                // Collapse on the notification id so a retry replaces the
                // earlier banner on the lock screen instead of stacking.
                collapseId: row.notification_id,
                expirationEpochSeconds,
                tokens: sentTokens,
                payload,
            });

            /** Sent tokens the relay actually reported on. */
            const answered = new Set<string>();

            for (const r of results) {
                if (!sentSet.has(r.token)) {
                    // A result naming a token this call never sent. The
                    // deactivation path below is keyed on
                    // (token, bundle_id, environment) — a triple that is
                    // unique across the WHOLE table, not per user — so acting
                    // on it would let one user's delivery retire a stranger's
                    // device. Ignore it, and say so: a relay returning tokens
                    // nobody asked about is either broken or hostile, and both
                    // are worth a log line.
                    log.warn('PushOutbox: relay returned a token that was not sent', {
                        id: row.id,
                        token: tokenPreview(r.token),
                        status: r.status,
                    });
                    continue;
                }
                if (answered.has(r.token)) {
                    // The relay named the same (sent) token more than once in
                    // one response. Only the FIRST result for a token counts
                    // — a legitimate relay never reports twice on one token
                    // in one call, so a second occurrence is exactly as
                    // attacker-shaped/broken-relay-shaped as a token that was
                    // never sent, and gets the same treatment: ignore and
                    // log, rather than double-appending to `delivered` (which
                    // would pad `delivered_tokens` with a duplicate) or
                    // calling `deactivatePushToken` twice for one result set.
                    // This works WITH the sent-token guard above rather than
                    // around it — both are the same principle, "act on a
                    // token's outcome at most once per call".
                    log.warn('PushOutbox: relay returned duplicate result for a token', {
                        id: row.id,
                        token: tokenPreview(r.token),
                        status: r.status,
                    });
                    continue;
                }
                answered.add(r.token);
                if (r.status === 'ok') {
                    out.delivered.push(r.token);
                } else if (
                    r.status === 'gone' ||
                    r.status === 'unregistered' ||
                    r.status === 'invalid'
                ) {
                    // All three are permanent facts about ONE TOKEN, so all
                    // three retire that token and leave the row alone.
                    //
                    // `invalid` belongs here despite being the same word as the
                    // whole-call PushTransportError kind. Per-token it is APNs
                    // `BadDeviceToken` — classically a sandbox token registered
                    // under environment='production'. Failing the ROW on it
                    // would be wrong twice over: a transient failure on a
                    // SIBLING token in the same pass would never be retried
                    // (deadReason outranks sawTransient below), and the bad
                    // token would survive to poison every future notification
                    // for this user with no self-healing path. Deactivating is
                    // the self-healing path — the client re-registers and gets a
                    // fresh row.
                    await deactivatePushToken(
                        this.sql,
                        r.token,
                        head.bundle_id,
                        head.environment,
                        r.status,
                        // Defence in depth. The token is already known to be
                        // one we sent for THIS row, so the user scope is
                        // redundant today — but the unique triple this UPDATE
                        // matches on spans every user in the table, so the
                        // blast radius of any future hole in the check above
                        // is the difference between "one user's own device"
                        // and "anyone's".
                        row.user_id as UserId,
                    );
                    log.info('PushOutbox: deactivated token', {
                        token: tokenPreview(r.token),
                        reason: r.status,
                    });
                } else {
                    out.sawTransient = true;
                }
            }

            // A token we sent that the relay said nothing about has NOT been
            // delivered. Treating silence as success would mark the row fully
            // delivered and delete it, losing the push with no trace — the
            // same silent-loss shape as an already-expired send. Count it as a
            // transient failure so the ladder retries it.
            const unanswered = sentTokens.filter((t) => !answered.has(t));
            if (unanswered.length > 0) {
                out.sawTransient = true;
                log.warn('PushOutbox: relay omitted results for tokens that were sent', {
                    id: row.id,
                    sent: sentTokens.length,
                    unanswered: unanswered.length,
                });
            }
        } catch (err) {
            if (!(err instanceof PushTransportError)) {
                // Not a transport-shaped failure at all (a bug, an aborted
                // socket). Treat as transient so the ladder — not this handler
                // — decides when to give up.
                log.warn('PushOutbox: transport threw a non-transport error', {
                    id: row.id,
                    err: errMsg(err),
                });
                out.sawTransient = true;
                return out;
            }
            switch (err.kind) {
                case 'no_credential':
                    // This install has no relay credential to present —
                    // PUSH_RELAY_TOKEN is unset and no licence-minted token
                    // exists. A permanent fact about the configuration: the
                    // ladder would spend six attempts and ~21 minutes on it
                    // and then report `max_attempts`, which reads as a relay
                    // outage and sends the operator looking at the network
                    // instead of at their settings.
                    out.permanentReason = 'no_relay_credential';
                    break;
                case 'not_entitled':
                    out.permanentReason = 'not_entitled';
                    break;
                case 'invalid':
                    // Whole-call `invalid` — a malformed request, a bad topic,
                    // an unimplemented transport. No retry fixes it, so this
                    // GROUP is done. Scoped to the group rather than the row
                    // because `bundleId` is an unvalidated client string: one
                    // iOS build registering an unknown bundle earns a relay
                    // 400 for its own group, and killing the row on it would
                    // take every other device's group down too. Deliberately
                    // NOT the same thing as a per-token `invalid` result
                    // above, which is about one device within a group.
                    out.permanentReason = 'invalid';
                    break;
                case 'throttled':
                    out.retryAfterSeconds = err.retryAfterSeconds ?? null;
                    out.sawTransient = true;
                    break;
                case 'unauthenticated':
                    // The transport refreshes and retries once internally;
                    // reaching here means the retry also failed. Transient.
                    out.sawTransient = true;
                    break;
                default:
                    out.sawTransient = true;
            }
            log.warn('PushOutbox: transport call failed', {
                id: row.id,
                kind: err.kind,
                tokens: bucket.length,
                err: err.message,
            });
        }
        return out;
    }

    /** Decide the row's fate once every group has reported. */
    private async resolveRow(
        row: PushOutboxRow,
        outcome: {
            delivered: string[];
            deadReason: string | null;
            retryAfter: number | null;
            sawTransient: boolean;
        },
    ): Promise<void> {
        const { delivered, deadReason, retryAfter, sawTransient } = outcome;

        if (deadReason) {
            await markPushRowDead(this.sql, row.id, deadReason);
            pushDeliveriesTotal.inc({ outcome: 'dead' });
            return;
        }
        if (!sawTransient) {
            await markPushRowDelivered(this.sql, row.id);
            pushDeliveriesTotal.inc({ outcome: 'delivered' });
            return;
        }

        if (retryAfter !== null) {
            // A relay `Retry-After` is a free, EXPECTED backoff — being asked
            // to slow down is not a failure of ours, so it must not spend a
            // rung of the permanent `MAX_ATTEMPTS` budget. Without this
            // branch a single rate-limited send could eat the row's whole
            // retry budget on nothing but waiting, well before it ever got a
            // chance to actually fail.
            //
            // That does not make the wait unbounded, though: a malicious or
            // broken relay that returns `Retry-After` forever must not retry
            // forever. Bound it the same way the design intends for a single
            // over-long `Retry-After` — against the ladder's OWN time budget
            // (`LADDER_BUDGET_SECONDS`, ~21 minutes) — but measured
            // cumulatively from when the row entered the outbox rather than
            // per-call, so repeated small waits exhaust the same budget a
            // single huge one already did below. Once no time is left, the
            // row dies `'throttled'` exactly as it would have on one
            // over-long `Retry-After` — a policy cut-off, not an APNs
            // expiration guard: `created_at + 4h` is still ahead of us here,
            // Apple would still accept the push. A banner held this long has
            // stopped being a notification and become spam.
            const elapsedSeconds = (Date.now() - row.created_at.getTime()) / 1000;
            const remainingBudget = LADDER_BUDGET_SECONDS - elapsedSeconds;
            if (retryAfter > remainingBudget) {
                await markPushRowDead(this.sql, row.id, 'throttled');
                pushDeliveriesTotal.inc({ outcome: 'dead' });
                return;
            }

            const rescheduled = await reschedulePushRow(
                this.sql,
                row.id,
                row.attempts,
                retryAfter,
                delivered,
                false, // consumesAttempt — a Retry-After never spends a ladder rung
            );
            pushDeliveriesTotal.inc({ outcome: 'retry' });
            if (!rescheduled) {
                // The CAS lost: another replica already advanced this row
                // (a genuine ladder rung, since THIS path never bumps
                // `attempts` itself). Its update stands; ours would have
                // clobbered `next_attempt_at`/`delivered_tokens` from a stale
                // read.
                log.info('PushOutbox: reschedule CAS lost, another pass owns the row', {
                    id: row.id,
                    attempts: row.attempts,
                });
            }
            return;
        }

        if (row.attempts + 1 >= MAX_ATTEMPTS) {
            await markPushRowDead(this.sql, row.id, 'max_attempts');
            pushDeliveriesTotal.inc({ outcome: 'dead' });
            return;
        }

        const rescheduled = await reschedulePushRow(
            this.sql,
            row.id,
            row.attempts,
            pushBackoffSeconds(row.attempts),
            delivered,
            true, // consumesAttempt — a genuine ladder rung
        );
        pushDeliveriesTotal.inc({ outcome: 'retry' });
        if (!rescheduled) {
            // The CAS lost: another replica already advanced this row's
            // attempts. Its update stands; ours would double-count the ladder.
            log.info('PushOutbox: reschedule CAS lost, another pass owns the row', {
                id: row.id,
                attempts: row.attempts,
            });
        }
    }
}
