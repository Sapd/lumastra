// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * notification-events.service.ts — per-user SSE hub + durable inbox.
 *
 * Two concerns live here:
 *
 * 1. **Per-user SSE hub** (`userEventsHub`):
 *    A single Valkey-backed `SseReplayHub` instance shared by all connected
 *    users. Per-user delivery isolation is enforced by setting `targetUserId`
 *    on each consumer so frames for user A are never sent to a consumer for
 *    user B.
 *
 *    Valkey keys:
 *      `user:events:replay`  — bounded replay LIST (newest-first, shared)
 *      `user:events:seq`     — cluster-wide monotonic frame id counter
 *
 * 2. **Frame publish helper** (`publishUserEvent`):
 *    Assigns a frame id and, for a kind that PERSISTS, writes the
 *    `user_notifications` row FIRST — the insert's outcome decides whether the
 *    frame is delivered at all (see `persistNotification` below). Only then does
 *    it push to Valkey replay and publish to the cross-pod channel.
 *
 * Event taxonomy — the closed set of kinds is `EVENT_KINDS` in
 * `$lib/server/api/event-kinds.js` (also what `events.kinds` in
 * GET /api/v1/server advertises). `PERSIST_KINDS` below is a
 * SEPARATE list sourced from that module's notification subset: it answers
 * "does publishing this kind write a durable row", not "can it be published
 * at all" — those are different questions and re-merging them is how this
 * taxonomy drifted before (see docs/architecture/user-events.md). Four kinds
 * pass the bar for a durable row today: `library.new_episode`,
 * `request.available`, `admin.broadcast` and `jellyfin.readonly_token`. Everything else in `EVENT_KINDS`
 * is a signal — `device.state`, `device.command_status`, `session_changed`,
 * `watch_state_set_changed`, `admin` — transient by design and never persisted.
 *
 * Note that `admin` (a signal) and `admin.broadcast` (a notification) are two
 * different features, not two spellings of one: `admin` is the perishable
 * play-session toast, `admin.broadcast` is a durable, pinnable announcement.
 */

import {
    createSseReplayHub,
    type SseReplayHub,
    type SSEFrame,
} from '$lib/server/utils/sse-replay-hub.js';
import { getDb } from '$lib/server/database/connection.js';
import { insertNotification } from '$lib/server/database/queries/user-notifications.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { NOTIFICATION_EVENT_KIND_NAMES } from '$lib/server/api/event-kinds.js';
import { publishMessage, subscribeToChannel } from '$lib/server/cache/valkey.js';
import { enqueueUserNotificationWebhook } from './user-webhook-notifier.service.js';
import { forwardUserNotification } from './notification-forwarder.service.js';
import { enqueueUserPush } from './push/user-push-notifier.service.js';
import { isUserId } from '$lib/shared/user-id.js';
import { isIsolationWorker } from '$lib/server/tasks/isolation/isolation-context.js';
import { onRemoteUserAdminInvalidate } from '$lib/server/cache/auth-cache-bus.js';
import { onDeviceSessionsRevoked } from '$lib/server/oauth/device-session-liveness.js';

const logger = Logger.for('NotificationEvents');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Event kinds that persist to the `user_notifications` table. */
const PERSIST_KINDS = new Set<string>(NOTIFICATION_EVENT_KIND_NAMES);

/**
 * Valkey pub/sub channel carrying user-event frames between pods.
 *
 * Required, not an optimisation: both notification kinds are emitted from the
 * pipeline-event dispatcher, which runs in the task orchestrator (worker pod),
 * while every SSE consumer is on a web pod. `broadcast()` on the emitting pod
 * reaches zero of them — always, not occasionally.
 */
const USER_EVENTS_CHANNEL = 'user:events:frames';

/** Default notification TTL for persisted events (30 days). */
const DEFAULT_NOTIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Local fallback frame id sequence when Valkey is unavailable. */
let localFallbackId = 0;

// ---------------------------------------------------------------------------
// Per-user SSE hub (module-level singleton)
// ---------------------------------------------------------------------------

/**
 * The single, shared SSE replay hub for all per-user event streams.
 *
 * Per-user isolation is achieved via `Consumer.targetUserId` (added to the
 * hub in the sse-replay-hub.ts patch). Frames carry a `targetUserId` field in
 * their `data` object so the hub's broadcast filter can route them correctly.
 *
 * Replay buffer is shared across users but is keyed by frame id (not userId),
 * so reconnecting consumers read from `Last-Event-ID` and the hub's filter
 * drops frames that belong to other users during replay drain.
 */
export const userEventsHub: SseReplayHub = createSseReplayHub({
    replayKey: 'user:events:replay',
    replayIdKey: 'user:events:seq',
    defaultFrameType: 'event',
    evictionLogPrefix: '[UserEvents]',
    replayMax: 500,
    replayTtlSec: 3600,
    // keepaliveIntervalMs inherits the shared SSE_KEEPALIVE_MS default.
});

// Security fix C28 (2026-09-16): tear down an already-open per-user SSE
// stream on a SIBLING replica when its session is revoked. The disable/
// password-reset/delete paths (admin-user.service.ts) already publish
// `{kind:'user-admin', username}` on the cross-replica auth-cache-bus via
// `invalidateUserAdminCache()` — this reuses that existing signal rather
// than inventing a new channel. The revoking replica itself closes its own
// consumers directly (see credential-revocation.service.ts), since
// `onRemoteUserAdminInvalidate` deliberately skips the publisher's own
// process (see auth-cache-bus.ts's `_from` check).
// Device logout / revoke (this replica or another): close the revoked
// device's open /api/v1/events stream. Auth is otherwise only checked at
// connect time.
onDeviceSessionsRevoked((ids) => {
    try {
        userEventsHub.closeConsumersForDeviceSessions(ids);
    } catch (error) {
        logger.warn('onDeviceSessionsRevoked: closing SSE consumers failed', {
            error: String(error),
        });
    }
});

onRemoteUserAdminInvalidate((username) => {
    // Fix round 2 (2026-09-16): match credential-revocation.service.ts's
    // own call to the same function — best-effort, never let a close
    // failure (or a malformed pub/sub frame) escape this callback.
    try {
        userEventsHub.closeConsumersForUsername(username);
    } catch (error) {
        logger.warn('onRemoteUserAdminInvalidate: closing SSE consumers failed', {
            username,
            error: String(error),
        });
    }
});

// ---------------------------------------------------------------------------
// Frame shape
// ---------------------------------------------------------------------------

/**
 * Payload shape for a user event frame.
 * `targetUserId` is required for per-user delivery routing.
 */
export interface UserEventPayload {
    /** Internal user ID (UUID) — used by the hub filter to route the frame. */
    targetUserId: string;
    /**
     * Deliver only to the event stream of this device session (device remote
     * control). The hub skips every other consumer — other devices of the same
     * account and streams without a device session included — and the frame is
     * never pushed to the replay buffer: a "pause" replayed after a reconnect
     * would be wrong, and the device catches up from its command inbox instead.
     */
    targetDeviceSessionId?: string;
    /**
     * `false`: the frame is not pushed to the replay buffer (a signal the client
     * re-reads with a GET after a reconnect anyway, e.g. `device.state`). Present
     * only when false, so the hub can tell it apart from replayable frames.
     */
    replay?: false;
    /** Discriminated event kind (matches the taxonomy above). */
    kind: string;
    /** Arbitrary event-specific data. */
    data: Record<string, unknown>;
    /**
     * `user_notifications.id` of the durable row this frame was delivered for.
     *
     * PRESENT IFF THIS FRAME HAS A DURABLE ROW — that is the whole contract, and
     * both halves of it are load-bearing:
     *
     *  - Signal-class kinds never persist, so they never carry one. A client
     *    must not be able to ask the inbox about a frame that was never an
     *    inbox row.
     *  - A `failed` persist (DB down) still delivers the live frame, and it
     *    carries NO id, because there is no row to name. Inventing one would
     *    hand the client a 404 on the hydrate.
     *
     * A `conflict` never reaches the frame at all (it returns before delivery),
     * so the third case is closed by construction rather than by a check here.
     *
     * With it, a client that receives a live frame can hydrate the fully
     * rendered row — `display`/`link` included — from
     * `GET /notifications/{id}` instead of re-deriving a view from `data`.
     */
    notificationId?: string;
}

// ---------------------------------------------------------------------------
// Publish helper
// ---------------------------------------------------------------------------

/**
 * What the durable insert decided about this frame.
 *
 * `conflict` and `failed` must never be collapsed. A conflict is a POSITIVE
 * answer — the coalescing index already holds this notification, so some other
 * pod/shard is delivering it and a second live frame is a duplicate toast. A
 * failure is the ABSENCE of an answer — the DB is down or the insert threw, and
 * we know nothing about whether anyone else delivered.
 */
export type PersistOutcome = 'inserted' | 'conflict' | 'failed' | 'not-applicable';

/**
 * The outcome plus the id of the row it refers to.
 *
 * The id is carried out because the push enqueue keys on `notification_id` — it
 * is the outbox's idempotency guard and its FK back to the inbox row. Only the
 * `inserted` branch can produce one: a conflict wrote nothing here (the winning
 * shard owns that row and the push for it), and a failure has no row at all.
 * Every non-`inserted` path therefore returns `null` rather than an id borrowed
 * from somewhere else.
 */
type PersistResult = { outcome: PersistOutcome; notificationId: string | null };

/**
 * Write the durable row for a persisting kind.
 *
 * Best-effort by contract: this never throws into `publishUserEvent`, which
 * never throws into its caller (an emitter running inside the pipeline
 * dispatcher's transaction must not fail an event whose other effects already
 * landed).
 */
async function persistNotification(opts: {
    userId: string;
    kind: string;
    payload: Record<string, unknown>;
    ttlMs?: number | null;
    broadcastId?: string;
}): Promise<PersistResult> {
    const sql = getDb();
    if (!sql) {
        logger.warn('DB unavailable — notification not persisted', {
            kind: opts.kind,
            userId: opts.userId,
        });
        return { outcome: 'failed', notificationId: null };
    }
    // `null` is an EXPLICIT "never expires", not a missing value, so it must not
    // fall through to the 30-day default the way `undefined` does. The
    // distinction is checked with `=== null` rather than `??` for exactly that
    // reason: `opts.ttlMs ?? DEFAULT` would silently give an admin broadcast a
    // TTL, and a pinned announcement that vanishes after 30 days while still
    // pinned is a permanent, invisible hole in the pinned block.
    const ttlMs = opts.ttlMs === null ? null : (opts.ttlMs ?? DEFAULT_NOTIFICATION_TTL_MS);
    const expiresAt = ttlMs === null ? null : new Date(Date.now() + ttlMs);
    try {
        const result = await insertNotification(sql, {
            userId: opts.userId,
            kind: opts.kind,
            payload: opts.payload,
            expiresAt,
            ...(opts.broadcastId ? { broadcastId: opts.broadcastId } : {}),
        });
        return {
            outcome: result.inserted ? 'inserted' : 'conflict',
            notificationId: result.row?.id ?? null,
        };
    } catch (err) {
        logger.warn(
            'Failed to persist notification',
            { kind: opts.kind, userId: opts.userId },
            err as Error,
        );
        return { outcome: 'failed', notificationId: null };
    }
}

/**
 * Publish a user event:
 *   1. Assign a cluster-wide monotonic frame id (via Valkey INCR).
 *   2. For a PERSIST_KINDS kind, insert the `user_notifications` row and let
 *      that insert arbitrate delivery — a conflict returns here and nothing
 *      else happens.
 *   3. Push the frame to the bounded Valkey replay LIST.
 *   4. Publish the frame to `USER_EVENTS_CHANNEL` so EVERY pod broadcasts it
 *      to its own consumers — including this one (see the subscriber below).
 *   5. Queue the user's own outbound webhook, if the operator enabled the
 *      feature and the user registered an endpoint — and ONLY when step 2
 *      actually inserted (see the comment at the call site).
 *   6. Queue an APNs push for the user's registered devices, on the SAME
 *      `inserted` gate and for the same reason.
 *
 * **The insert is the arbiter of live delivery, not the emitter's pre-check.**
 * `hasCoalescedNotificationToday` is a check-then-act read in a different
 * transaction, and the outbox dispatcher drains `hashtext(media_item_id)` shards
 * in parallel on any multi-core host: two episodes of one season ARE handled
 * concurrently, both pre-checks pass, and the unique index then keeps exactly
 * one durable row. Broadcasting before the insert therefore produced one row and
 * TWO toasts. Persisting first and delivering only on `inserted` closes that;
 * do not reorder these two steps back.
 *
 * Signal kinds (`device.state` and friends) keep the original
 * broadcast-only path — they have no durable row and must not acquire a DB
 * dependency to reach a consumer.
 *
 * Best-effort: Valkey or DB failures are logged, not thrown (callers must not
 * block on SSE delivery succeeding).
 *
 * ## The return value
 *
 * Returns the durable insert's {@link PersistOutcome}. Because this function
 * swallows its own failures, that return is the ONLY way a caller can learn that
 * a delivery degraded — a caught insert error becomes `'failed'` here and a
 * `logger.warn` and nothing else. Every existing caller ignores it and is
 * unaffected; the admin broadcast fan-out reads it, because an operator writing
 * to a thousand inboxes is entitled to know that thirty of them got nothing
 * rather than being told the send succeeded uniformly.
 *
 * `'conflict'` is NOT a failure — see the type's own note: it means the
 * coalescing index already holds this notification and somebody else is
 * delivering it. Only `'failed'` means nobody is.
 */
export async function publishUserEvent(opts: {
    userId: string;
    kind: string;
    data: Record<string, unknown>;
    /** Override persist behaviour. Default: derived from PERSIST_KINDS. */
    persist?: boolean;
    /**
     * Override the default 30-day TTL for persisted rows (ms).
     *
     * `null` means NEVER EXPIRES and is distinct from omitting the option:
     * omitting takes the default, `null` overrides it. An admin broadcast passes
     * `null` because it can be pinned indefinitely and a pinned announcement
     * that silently aged out of every inbox would leave the pinned block empty
     * with nothing to explain why.
     */
    ttlMs?: number | null;
    /**
     * The `admin_broadcasts` row this event is one recipient copy of.
     *
     * Written to the durable row's `broadcast_id` column so pin state is
     * joinable. Only meaningful for a persisting kind; ignored otherwise, since
     * there is no row to put it on.
     */
    broadcastId?: string;
    /**
     * Skip the APNs enqueue for THIS call only (step 6), while still doing the
     * insert, replay push, pub/sub fan-out and webhook.
     *
     * A per-invocation override, deliberately NOT a taxonomy change.
     * `PUSH_KINDS` answers "is this KIND the sort of thing that pushes", which
     * is a property of the kind and stays derived from the notification class.
     * "Did the admin tick the push box on this particular broadcast" is a
     * property of one send. Folding the second into the first would make a
     * per-send checkbox look like a permanent statement about the kind, and the
     * next broadcast — which does want a push — would have to undo it.
     */
    skipPush?: boolean;
    /** Only this device's stream gets the frame; see {@link UserEventPayload.targetDeviceSessionId}. */
    targetDeviceSessionId?: string;
    /**
     * `false`: skip the shared replay buffer. For frequent signals a client
     * recovers with a GET (`device.state`, `device.command_status`): they would
     * push durable notifications out of the bounded buffer.
     */
    replay?: boolean;
}): Promise<PersistOutcome> {
    const payload: UserEventPayload = {
        targetUserId: opts.userId,
        ...(opts.targetDeviceSessionId
            ? { targetDeviceSessionId: opts.targetDeviceSessionId }
            : {}),
        ...(opts.replay === false ? { replay: false as const } : {}),
        kind: opts.kind,
        data: opts.data,
    };

    // Step 1: assign the frame id. Only the INCR — the replay push waits until
    // step 3, after the persist decision. The split is deliberate: an id is a
    // counter and gaps in it are already normal (`Last-Event-ID` is compared,
    // not enumerated), whereas the replay LIST is a bounded 500-entry buffer
    // SHARED by every user, so a frame that is never delivered must not evict
    // someone else's. Burning an id costs nothing; burning a replay slot for a
    // frame nobody receives is a lie told to the next reconnecting consumer.
    const client = userEventsHub.getClient();
    let frameId: number;
    if (client) {
        try {
            frameId = await userEventsHub.nextMonotonicId(client);
        } catch (err) {
            logger.warn(
                'Failed to assign user event frame id from Valkey',
                { kind: opts.kind },
                err as Error,
            );
            // Valkey unavailable: use local fallback id to avoid frameId=0 corruption
            frameId = ++localFallbackId;
        }
    } else {
        // Valkey client unavailable (e.g. connection down or Redis disabled): use local fallback
        logger.warn('Valkey unavailable for user event — using local fallback frameId', {
            kind: opts.kind,
            userId: opts.userId,
        });
        frameId = ++localFallbackId;
    }

    // Step 2: persist FIRST for the notification class, and let the insert decide
    // whether this frame is delivered at all.
    const shouldPersist = opts.persist !== undefined ? opts.persist : PERSIST_KINDS.has(opts.kind);
    const { outcome: persisted, notificationId } = shouldPersist
        ? await persistNotification({
              userId: opts.userId,
              kind: opts.kind,
              // frameId is part of the stored payload so a client can reconcile
              // an inbox row against the live frame it may already have seen.
              payload: { frameId, ...payload.data },
              ttlMs: opts.ttlMs,
              ...(opts.broadcastId ? { broadcastId: opts.broadcastId } : {}),
          })
        : { outcome: 'not-applicable' as const, notificationId: null };

    if (persisted === 'conflict') {
        // Someone else already wrote this notification (parallel outbox shard,
        // or another pod). They deliver it; a second frame here is the duplicate
        // toast this ordering exists to prevent. No replay push, no publish.
        return persisted;
    }

    // `failed` deliberately falls through to delivery. A conflict is knowledge
    // ("already delivered"); a failure is the absence of it ("the DB is down"),
    // and collapsing the two would mean a Postgres outage silently turns the
    // whole notification system off — live frames included, with no inbox row to
    // recover from either. The cost is named honestly: while the DB is
    // unreachable, every parallel shard falls through, so a season drop can
    // produce several toasts. That is a transient, self-correcting annoyance
    // during an outage; a permanently missed notification is not.

    // Step 3: push to the bounded replay LIST, now that the frame is going out.
    //
    // The durable row's id is attached HERE rather than when `payload` was built,
    // because until the insert returned there was no row to name. Only the
    // `inserted` branch produces one — see `UserEventPayload.notificationId` for
    // why `failed` and the signal kinds deliberately go out without it.
    if (persisted === 'inserted' && notificationId) {
        payload.notificationId = notificationId;
    }
    // Watch-state signals predate the hub and have a published direct-payload
    // contract. Keep those fields at the top level when delivering across pods;
    // the additional routing fields are accepted by its loose frame schema.
    const frame: SSEFrame = {
        id: frameId,
        type: opts.kind,
        data:
            opts.kind === 'watch_state_set_changed'
                ? { ...opts.data, targetUserId: opts.userId, replay: false }
                : payload,
    };
    // Device-addressed frames are never replayed (see UserEventPayload).
    if (client && !opts.targetDeviceSessionId && opts.replay !== false) {
        try {
            await userEventsHub.pushFrame(client, frame);
        } catch (err) {
            logger.warn(
                'Failed to push user event to Valkey replay',
                { kind: opts.kind },
                err as Error,
            );
        }
    }

    // Step 4: cross-pod fan-out. The local broadcast deliberately lives in the
    // pub/sub subscriber below and NOT here — that callback runs on the
    // publishing pod too, so broadcasting here as well would double-deliver to
    // every consumer on the emitting pod. Same shape as the kill/admin/
    // maintenance channels in play-session-events.service.ts.
    let published = false;
    try {
        published = await publishMessage(USER_EVENTS_CHANNEL, JSON.stringify(frame));
    } catch (err) {
        logger.warn(
            'Failed to publish user event to Valkey pub/sub',
            { kind: opts.kind, userId: opts.userId },
            err as Error,
        );
    }
    if (!published) {
        // Valkey unavailable — the subscriber will never fire, so this pod's
        // consumers only see the frame if we hand it to them directly. Single-pod
        // deployments therefore keep working with Valkey down; cross-pod delivery
        // is what is actually lost.
        userEventsHub.broadcast(frame);
    }

    // Step 5: the user's own outbound webhook, when the operator has enabled the
    // feature and the user has registered an endpoint.
    //
    // ONLY on `inserted`. The `conflict` case already returned above — a
    // coalesced duplicate produces no row, no toast and, by sitting behind that
    // return, no webhook. The `failed` case reaches here and is deliberately
    // EXCLUDED: a failed insert means nothing arbitrated this event, so every
    // parallel outbox shard would enqueue one, and unlike a duplicate toast a
    // duplicate outbox row is durable and retried for 24 hours. See the header
    // of user-webhook-notifier.service.ts.
    //
    // Last, and never awaited by anything the caller depends on: the durable row
    // and the live frame are the product, this is a fan-out on top of them.
    if (persisted === 'inserted') {
        await enqueueUserNotificationWebhook({
            userId: opts.userId,
            kind: opts.kind,
            data: opts.data,
        });
    }

    // Step 5b: operator webhooks subscribed to `org.lumastra.user.notification`
    // (a Telegram bot, n8n …), when the user opted in to forwarding. Same
    // `inserted` gate and the same reasoning as step 5; the row id is the
    // forwarded event's id, so it needs one.
    if (persisted === 'inserted' && notificationId) {
        await forwardUserNotification({
            userId: opts.userId,
            kind: opts.kind,
            data: opts.data,
            notificationId,
        });
    }

    // Step 6: the user's registered Apple devices.
    //
    // Push rides the same 'inserted' gate as the webhook, and for the same
    // reason — see the header of user-push-notifier.service.ts.
    //
    // `skipPush` bypasses ONLY this step. Everything above it has already run,
    // which is the whole shape of the feature: an admin who unticks "send a
    // push" still wants the announcement in the inbox, on the SSE wire and out
    // through the user's webhook — they are declining a lock-screen
    // interruption, not the message.
    //
    // `isUserId` rather than a cast or `toUserId`: this function must not throw
    // into its caller, and `toUserId` throws on a non-UUID. The guard narrows
    // instead, so a caller that passed something other than a `users.id` UUID
    // simply gets no push rather than an exception unwinding an emitter whose
    // durable row and live frame have already landed.
    if (persisted === 'inserted' && !opts.skipPush) {
        if (notificationId && isUserId(opts.userId)) {
            await enqueueUserPush({
                userId: opts.userId,
                notificationId,
                kind: opts.kind,
            });
        } else {
            // Unreachable today: `inserted` means Postgres accepted the row, so
            // it returned a uuid id and it accepted `user_id::uuid`. Logged
            // rather than dropped because the failure it guards against is
            // SILENT — "push stopped working for some users" with nothing in the
            // logs is the worst shape this bug could take, and naming the failed
            // condition is what turns it back into a five-minute diagnosis.
            logger.warn('Skipped push enqueue for an inserted notification', {
                kind: opts.kind,
                userId: opts.userId,
                reason: !notificationId ? 'no-notification-id' : 'user-id-not-a-uuid',
            });
        }
    }

    return persisted;
}

// ---------------------------------------------------------------------------
// Cross-pod subscriber
// ---------------------------------------------------------------------------

/**
 * Parse a wire frame, or null when it is not one we can safely deliver.
 *
 * The `targetUserId` check is a delivery guard rather than a formality: the hub
 * treats a frame with no `targetUserId` as global and hands it to every
 * consumer, so a truncated or foreign message on this channel would fan one
 * user's notification out to all of them. Dropping it is the only safe reading.
 */
function parseUserEventFrame(message: string): SSEFrame | null {
    let raw: unknown;
    try {
        raw = JSON.parse(message);
    } catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null) return null;
    const { id, type, data } = raw as { id?: unknown; type?: unknown; data?: unknown };
    if (typeof id !== 'number' || !Number.isFinite(id)) return null;
    if (typeof type !== 'string' || type.length === 0) return null;
    if (typeof data !== 'object' || data === null) return null;
    const targetUserId = (data as Record<string, unknown>)['targetUserId'];
    if (typeof targetUserId !== 'string' || targetUserId.length === 0) return null;
    return { id, type, data };
}

/**
 * This callback runs on EVERY pod including the publishing one, which is what
 * makes the broadcast happen exactly once per pod instead of twice on the
 * emitter and never on the others.
 */
function onUserEventMessage(message: string): void {
    const frame = parseUserEventFrame(message);
    if (!frame) {
        logger.warn('Received invalid user event on pub/sub channel', { message });
        return;
    }
    userEventsHub.broadcast(frame);
}

/** Attempts before the process gives up on cross-pod delivery for good. */
const SUBSCRIBE_MAX_ATTEMPTS = 6;
/** First backoff step; doubles per attempt up to SUBSCRIBE_MAX_DELAY_MS. */
const SUBSCRIBE_BASE_DELAY_MS = 1_000;
const SUBSCRIBE_MAX_DELAY_MS = 30_000;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        // Never hold the process open just to wait out a backoff.
        if (typeof timer.unref === 'function') timer.unref();
    });
}

/**
 * Subscribe to the cross-pod channel, retrying with backoff.
 *
 * A single attempt at module load is a permanent failure mode, not a transient
 * one: `subscribeToChannel` has no reconnect loop of its own, so a pod that
 * boots while Valkey is still starting never receives another cross-pod frame
 * for its entire process lifetime. Worse, it fails SILENTLY — `publishMessage()`
 * starts succeeding as soon as Valkey comes up, which suppresses
 * `publishUserEvent`'s `!published` local-broadcast fallback, so the pod
 * publishes frames that its own consumers never see.
 *
 * Bounded rather than infinite: an install with Valkey deliberately disabled
 * returns null on every attempt, and an unbounded loop would log forever for a
 * configuration that is working as intended. After the last attempt we say so
 * loudly, once.
 *
 * And NOT ENTERED AT ALL when there is no cache URL. Bounding that case was
 * only half the fix: six warnings and one alarming error, spread over ~31
 * seconds of every boot, for a single-pod install that is working exactly as
 * configured — and the error's own text ("this pod will NOT deliver cross-pod
 * user events") describes a problem such an install cannot have. Retrying is
 * for a Valkey that is not up YET; a missing CACHE_URL is not a race, it is
 * the configuration, and it cannot change while the process runs.
 *
 * It also stopped being only a cosmetic issue. The backoff arms real timers, so
 * the loop keeps logging long after whichever module imported this one is done
 * — in the unit suite that means a straggler console line arriving while a
 * later test file's worker is tearing down, which vitest reports as
 * `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`
 * and turns into a non-zero exit on a run where all 23k tests passed. It took
 * main red twice on 2026-09-08 (runs 253 and 255), attributed both times to an
 * unrelated file — the one whose worker happened to be closing.
 */
async function subscribeWithRetry(): Promise<void> {
    // Read straight from the environment, exactly as cache/valkey.ts does for
    // the same variable and for the same reason ($env/dynamic/private is not
    // available to tsx-launched scripts). Deliberately NOT a new exported
    // predicate on the cache module: 65 unit-test files replace that module
    // with a partial `vi.mock` factory, and a module-init call to a newly
    // exported name fails in every one of them that has this service in its
    // graph — six files, measured, before this was reverted. A fix for a flake
    // that reds main is a poor place to introduce a wide, hard-to-enumerate
    // breakage.
    // Isolation workers never hold a pub/sub subscription (subscribeToChannel
    // returns null there by design); they only publish. Retrying would end in
    // a false "gave up subscribing" ERROR on every isolated task run.
    if (isIsolationWorker()) return;
    // Pub/sub runs on the task Valkey (TASK_CACHE_URL), not the optional cache.
    if (!process.env.TASK_CACHE_URL) {
        logger.debug(
            'No TASK_CACHE_URL configured — not subscribing to the user-events channel. ' +
                'Cross-pod delivery is inapplicable; publishUserEvent broadcasts locally.',
        );
        return;
    }
    for (let attempt = 1; attempt <= SUBSCRIBE_MAX_ATTEMPTS; attempt++) {
        try {
            const unsubscribe = await subscribeToChannel(USER_EVENTS_CHANNEL, onUserEventMessage);
            if (unsubscribe) {
                if (attempt > 1) {
                    logger.info('Subscribed to user-events channel after retry', { attempt });
                }
                return;
            }
            logger.warn('User-events channel subscribe returned no subscription', {
                attempt,
                maxAttempts: SUBSCRIBE_MAX_ATTEMPTS,
            });
        } catch (err) {
            logger.warn(
                'User-events channel subscribe attempt failed',
                { attempt, maxAttempts: SUBSCRIBE_MAX_ATTEMPTS },
                err as Error,
            );
        }
        if (attempt === SUBSCRIBE_MAX_ATTEMPTS) break;
        await delay(Math.min(SUBSCRIBE_BASE_DELAY_MS * 2 ** (attempt - 1), SUBSCRIBE_MAX_DELAY_MS));
    }
    logger.error(
        'Gave up subscribing to the user-events channel — this pod will NOT deliver cross-pod ' +
            'user events for the rest of its lifetime. Notifications emitted on the worker pod ' +
            'will only reach clients via GET /api/v1/notifications until it is restarted. ' +
            'Single-pod installs are unaffected (publishUserEvent broadcasts locally when the ' +
            'publish itself fails).',
        new Error('user-events subscribe exhausted retries'),
        { attempts: SUBSCRIBE_MAX_ATTEMPTS },
    );
}

// Subscribe once at module init.
void subscribeWithRetry();
