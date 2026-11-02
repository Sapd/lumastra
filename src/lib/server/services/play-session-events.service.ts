// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/play-session-events.service.ts
// Shared registry for SSE kill notifications — avoids circular dependency
// between play-sessions.service and the events route.
//
// Cross-pod kill notifications use Valkey pub/sub:
//   - Any pod that kills a session publishes to 'play-sessions:kill'
//   - All pods subscribe and deliver SSE events to their local clients
//   - Falls back to local-only delivery if Valkey is unavailable
//
// Admin messaging & maintenance-notice primitives share the same Valkey
// pub/sub + per-pod controller-map infrastructure. Three channels total:
//   - KILL_CHANNEL         : session-kill notifications (existing)
//   - ADMIN_MSG_CHANNEL    : per-session or broadcast-all admin toasts
//   - MAINTENANCE_CHANNEL  : pinned maintenance notice lifecycle events
//
// Maintenance notices additionally persist to Valkey (v1:maintenance:notice)
// with TTL so they survive reconnects and cross-pod restarts. An in-process
// EventEmitter (adminEvents) lets the user-level SSE route subscribe without
// creating a circular dependency back to this module.

import { EventEmitter } from 'node:events';
import {
    publishMessage,
    subscribeToChannel,
    cacheGet,
    cacheDel,
    setIfNotExists,
    isCoordinationValkeyHealthy,
} from '../cache/valkey.js';
import { Logger } from '../utils/logger.js';

const logger = Logger.for('PlaySessionEvents');
const encoder = new TextEncoder();
const KILL_CHANNEL = 'play-sessions:kill';
const TERMINATED_CHANNEL = 'play-sessions:terminated';
const ADMIN_MSG_CHANNEL = 'play-sessions:admin-message';
const MAINTENANCE_CHANNEL = 'play-sessions:maintenance';
const MAINTENANCE_KEY = 'v1:maintenance:notice';
const MAX_NOTICE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// session_id → Set<ReadableStreamDefaultController<Uint8Array>>
export const sessionControllers = new Map<
    string,
    Set<ReadableStreamDefaultController<Uint8Array>>
>();

/**
 * Total live play-session SSE connections held by THIS replica process,
 * across every session (C11, 2026-09-16 fix plan). Mirrors
 * `watch-together.service.ts`'s `getActiveSSEConnectionCount` — this
 * registry has no single `Set`/`size` to read directly since connections are
 * bucketed per session id, so this sums the per-session sets. Used by the
 * `GET {id}/events` handler to enforce the process-wide SSE connection
 * ceiling (`config.SSE_MAX_CONNECTIONS`) in the `play-sessions` namespace.
 */
export function getActivePlaySessionSSECount(): number {
    let total = 0;
    for (const perSession of sessionControllers.values()) {
        total += perSession.size;
    }
    return total;
}

/**
 * In-process EventEmitter for admin/maintenance events. The user-level SSE
 * route (src/routes/api/events/user/+server.ts) listens on this rather than
 * importing a service-level callback registry — keeps module graph acyclic.
 *
 * Emits:
 *   - 'admin_message_broadcast' (payload: AdminMessagePayload)
 *   - 'maintenance_notice'      (payload: MaintenanceNotice)
 *   - 'maintenance_cleared'     (no payload)
 */
export const adminEvents = new EventEmitter();
// Admin messaging can have many subscribers (one per connected user-SSE client).
// Default maxListeners of 10 is too low for a multi-user deploy.
adminEvents.setMaxListeners(0);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaintenanceNotice {
    id: string;
    message: string;
    /** Epoch milliseconds */
    endsAt: number;
    createdBy: string;
    /** Epoch milliseconds */
    createdAt: number;
}

/**
 * Wire shape for a maintenance_notice SSE frame sent to clients.
 *
 * Three fields describe one instant, on purpose:
 *   - `endsAt`    — epoch milliseconds, UTC. CANONICAL. Absolute, so a client
 *                   that reconnects mid-notice can still render the countdown;
 *                   this is the field to compute from.
 *   - `endsAtIso` — the same instant as ISO-8601, for clients whose decoder
 *                   maps a date string straight onto a native date type.
 *   - `remainingMs` — a convenience delta computed at DELIVERY time, so a
 *                   client whose clock disagrees with the server's still gets
 *                   a usable countdown length. Do not persist it.
 */
export type MaintenanceNoticeFrame = MaintenanceNotice & {
    endsAtIso: string;
    remainingMs: number;
};

/**
 * Attach a freshly-computed remainingMs (and the ISO rendering of endsAt) to
 * a MaintenanceNotice. Called at every delivery site (not at publish time) so
 * clients on a different clock still receive an accurate countdown anchor.
 */
export function withRemaining(notice: MaintenanceNotice): MaintenanceNoticeFrame {
    return {
        ...notice,
        endsAtIso: new Date(notice.endsAt).toISOString(),
        remainingMs: Math.max(0, notice.endsAt - Date.now()),
    };
}

export type BroadcastTarget =
    /**
     * One play session.
     *
     * `userId` is the owning `users.id` UUID, NOT a username. It used to be
     * `username` and the one producer (`defs/admin/sessions/[id]/message`)
     * passed `session.user_id` into it — a UUID compared against the SSE
     * connection's handle, so the equality never held and every
     * session-targeted toast was silently dropped from the per-user stream.
     * Only the web player's own session-scoped channel ever saw one, which is
     * why the native apps observed nothing. Matching on the UUID is exact and
     * has no case-folding hazard, unlike a handle.
     */
    { kind: 'session'; session_id: string; userId?: string } | { kind: 'all' };

export interface AdminMessagePayload {
    type: 'admin_message';
    /**
     * Stable per-broadcast identifier. The same payload is delivered through
     * two SSE channels (per-session + user-level), so clients dedupe on `id`
     * to avoid double-toasting users who have both streams active.
     */
    id: string;
    /**
     * Internal routing descriptor. NOT part of the published wire contract —
     * `playSessionId` / `deviceId` below are what a client reads. Kept because
     * the server-side fan-out (owner filter on the user stream, controller
     * lookup on the session stream) is expressed in terms of it.
     */
    target: BroadcastTarget;
    /**
     * The play session this message is FOR, when it is for one.
     *
     * Load-bearing, and the reason it exists: `/api/v1/events` is a PER-USER
     * stream. With two Apple TVs signed into one account, an admin messaging
     * the living-room TV reaches the stream of both — the server cannot tell
     * one client's connection from the other's. So the target travels on the
     * frame and the client filters:
     *
     *   absent  → render on every client of this user (the broadcast case)
     *   present → render only where it matches this client's own play session
     *
     * A client that ignores the field shows an extra toast on a second device;
     * a client that respects it is correct. Both beat dropping the message.
     */
    playSessionId?: string;
    /**
     * The device this message is for, when known. Set alongside
     * `playSessionId` for a session-targeted message (a client that knows its
     * device id but not its play-session id can still filter), and on its own
     * for a device-targeted message with no active playback.
     */
    deviceId?: string;
    severity: 'info' | 'warning' | 'error';
    message: string;
    durationMs?: number;
    sentBy: string;
    sentAt: number;
}

/**
 * Whether a payload should reach the per-user SSE stream of `userId`.
 *
 * `kind:'all'` reaches everyone. A session-targeted payload reaches only the
 * session's owner — and still reaches every CLIENT of that owner, because the
 * stream is per-user; narrowing to the one client is the frame's
 * `playSessionId` / `deviceId` job, done client-side.
 *
 * ⚠️ A session target that names NOBODY must FAIL CLOSED, and the reason is
 * the rename this function just went through. `userId` used to be called
 * `username` (and was fed the owner's UUID anyway — that was the bug). A pod
 * running the previous build publishes the legacy spelling onto the shared
 * Valkey channel, so during a rolling deploy a new pod sees a session target
 * with `userId` undefined. Failing open there would deliver one user's
 * operator message to EVERY connected user — a cross-user disclosure, where
 * the pre-rename behaviour was merely a silent drop. So the legacy field is
 * read and compared (it holds the same UUID), and anything that still names
 * nobody is dropped rather than broadcast.
 */
export function shouldDeliverAdminMessageToUserId(
    payload: AdminMessagePayload,
    userId: string,
): boolean {
    if (payload.target.kind === 'all') return true;
    if (payload.target.userId !== undefined) return payload.target.userId === userId;
    // Legacy spelling from a pre-rename pod. Same value, different key.
    const legacyOwner = (payload.target as { username?: unknown }).username;
    if (typeof legacyOwner === 'string') return legacyOwner === userId;
    return false;
}

// ---------------------------------------------------------------------------
// Termination classification — single canonical signal
// ---------------------------------------------------------------------------

/**
 * Normalised termination kind. The actual `play_sessions.stop_reason` column
 * holds a wider set of strings (including `'admin:<username>'` from
 * `killSession`, plus arbitrary values from `stopSession`). This helper folds
 * that space into the three kinds the SSE wire protocol distinguishes.
 *
 * Mapping is 1:1 with wire formats per the spec — see notifySessionTerminated.
 */
export type TerminationKind = 'superseded' | 'kicked' | 'session_ended';

export function classifyStopReason(reason: string | null): TerminationKind {
    if (reason === null) return 'session_ended';
    // Case-insensitive match — producers in the codebase write lowercase
    // ('superseded', 'kicked', 'admin:<user>'), but we normalise here so a
    // typo or future producer that writes 'Superseded' / 'KICKED' still
    // routes correctly. Otherwise a misclassified row would silently
    // demote to session_ended and the user would lose the toast/modal.
    const r = reason.toLowerCase();
    if (r === 'superseded') return 'superseded';
    // Plain 'admin' (no colon) shouldn't be produced by current code, but
    // defensively classify it as kicked — matches the spirit of admin:*.
    // 'stream_limit' is the stream-limit reconciler's kick reason — same
    // "you were kicked" UX class as an admin kick, just a different cause.
    if (r === 'kicked' || r === 'admin' || r.startsWith('admin:') || r === 'stream_limit') {
        return 'kicked';
    }
    return 'session_ended';
}

// ---------------------------------------------------------------------------
// Kill-notification helpers (existing behavior — unchanged)
// ---------------------------------------------------------------------------

/** Deliver a kill SSE event to all local clients for a session (this pod only) */
function notifySessionKilledLocal(session_id: string, reason: string): void {
    const controllers = sessionControllers.get(session_id);
    if (!controllers) return;
    const payload = JSON.stringify({ type: 'kill', reason });
    for (const controller of controllers) {
        try {
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
            // Controller already closed
        }
    }
}

/** Deliver a session_terminated SSE event locally (this pod only) */
function notifySessionTerminatedLocal(session_id: string, reason: TerminationKind): void {
    const controllers = sessionControllers.get(session_id);
    if (!controllers) return;
    const payload = JSON.stringify({ type: 'session_terminated', reason });
    for (const controller of controllers) {
        try {
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
            // Controller already closed
        }
    }
}

/**
 * Notify all pods that a session was killed.
 * Publishes to Valkey so every replica delivers the SSE event to its local clients.
 * Falls back to local-only delivery if Valkey is unavailable.
 */
export function notifySessionKilled(session_id: string, reason: string): void {
    const message = JSON.stringify({ session_id, reason });

    publishMessage(KILL_CHANNEL, message)
        .then((published) => {
            if (!published) {
                // Valkey unavailable — fall back to local-only delivery
                notifySessionKilledLocal(session_id, reason);
            }
            // If published: subscription callback on each pod (including this one)
            // handles local SSE delivery via notifySessionKilledLocal
        })
        .catch(() => {
            notifySessionKilledLocal(session_id, reason);
        });
}

/**
 * Notify all pods that a session was terminated by a non-self agent (e.g.
 * superseded by a newer same-device session). Wire format is
 * `{type:'session_terminated', reason:'superseded'}` distinct from the
 * legacy `{type:'kill'}` shape — see spec §4.2 for the 1:1 mapping.
 *
 * Only call from publishers where another agent has terminated the session
 * out from under its owner. Routine self-stops (user closes the player,
 * playback completes) MUST NOT publish here — the client initiated them.
 *
 * Reason is intentionally narrowed to `'superseded'` only. Kicks (admin)
 * keep using `notifySessionKilled` for the legacy `{type:'kill'}` shape;
 * `'session_ended'` is silent (backstop-only). Future TerminationKind
 * additions need an explicit decision about wire format before being
 * accepted here — the type system enforces that decision.
 */
export function notifySessionTerminated(session_id: string, reason: 'superseded'): void {
    const message = JSON.stringify({ session_id, reason });

    publishMessage(TERMINATED_CHANNEL, message)
        .then((published) => {
            if (!published) {
                notifySessionTerminatedLocal(session_id, reason);
            }
        })
        .catch(() => {
            notifySessionTerminatedLocal(session_id, reason);
        });
}

// Subscribe to the kill channel so this pod receives events from all replicas.
// Runs once at module initialization — if Valkey is unavailable, returns null (no-op).
void subscribeToChannel(KILL_CHANNEL, (message) => {
    try {
        const parsed = JSON.parse(message) as {
            session_id: string;
            reason: string;
        };
        notifySessionKilledLocal(parsed.session_id, parsed.reason);
    } catch {
        logger.warn('Received invalid kill notification on pub/sub channel', {
            message,
        });
    }
}).catch((err: unknown) => {
    logger.warn(
        'Failed to subscribe to kill channel — cross-pod kills will not deliver SSE',
        {},
        err as Error,
    );
});

void subscribeToChannel(TERMINATED_CHANNEL, (message) => {
    try {
        const parsed = JSON.parse(message) as {
            session_id: string;
            reason: TerminationKind;
        };
        notifySessionTerminatedLocal(parsed.session_id, parsed.reason);
    } catch {
        logger.warn('Received invalid session_terminated notification on pub/sub channel', {
            message,
        });
    }
}).catch((err: unknown) => {
    logger.warn(
        'Failed to subscribe to session_terminated channel — cross-pod supersede will not deliver SSE',
        {},
        err as Error,
    );
});

// ---------------------------------------------------------------------------
// Admin message delivery
// ---------------------------------------------------------------------------

/** Encode a payload as an SSE `data:` frame and enqueue on a controller. */
function enqueueFrame(
    controller: ReadableStreamDefaultController<Uint8Array>,
    payload: unknown,
): void {
    try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    } catch {
        // Controller already closed — ignored.
    }
}

/** Deliver admin-message payload to local controllers for the given target. */
function deliverAdminMessageLocal(payload: AdminMessagePayload): void {
    if (payload.target.kind === 'session') {
        const controllers = sessionControllers.get(payload.target.session_id);
        if (!controllers) return;
        for (const controller of controllers) {
            enqueueFrame(controller, payload);
        }
        return;
    }
    // kind === 'all'
    for (const [, controllers] of sessionControllers) {
        for (const controller of controllers) {
            enqueueFrame(controller, payload);
        }
    }
}

/**
 * Safely emit on adminEvents — swallows listener errors so one bad user-SSE
 * subscriber can't block fan-out to the rest.
 */
function safeEmit(event: string, ...args: unknown[]): void {
    try {
        adminEvents.emit(event, ...args);
    } catch (err) {
        logger.warn(`adminEvents emit failed for ${event}`, {}, err as Error);
    }
}

/**
 * Queue an admin message for SSE delivery. Publishes to Valkey pub/sub so
 * every pod delivers to its local sessionControllers AND fans out to its
 * local user-SSE subscribers via adminEvents; falls back to local delivery
 * + local emit when Valkey is unavailable.
 *
 * The adminEvents emit lives in the pub/sub subscriber (not here) so remote
 * pods also notify their user-SSE listeners. Single-pod deployments still
 * fire once — the subscriber callback runs on the publishing pod too.
 */
export function broadcastAdminMessage(opts: {
    target: BroadcastTarget;
    severity: 'info' | 'warning' | 'error';
    message: string;
    durationMs?: number;
    sentBy: string;
    /** Device that owns the targeted session, when the caller resolved one. */
    deviceId?: string;
}): void {
    // Promote the routing target onto the wire frame. The per-user stream
    // cannot filter per-client (see AdminMessagePayload.playSessionId), so a
    // targeted message has to say who it is for or it is either shown
    // everywhere or nowhere.
    const targetedSessionId = opts.target.kind === 'session' ? opts.target.session_id : undefined;

    const payload: AdminMessagePayload = {
        type: 'admin_message',
        id: crypto.randomUUID(),
        target: opts.target,
        ...(targetedSessionId !== undefined ? { playSessionId: targetedSessionId } : {}),
        ...(opts.deviceId !== undefined ? { deviceId: opts.deviceId } : {}),
        severity: opts.severity,
        message: opts.message,
        ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
        sentBy: opts.sentBy,
        sentAt: Date.now(),
    };

    // Cross-pod fan-out via Valkey pub/sub. Subscriber callback (below) runs
    // on every pod including this one, and is responsible for both the
    // local session-SSE delivery and the adminEvents emit for user-SSE.
    publishMessage(ADMIN_MSG_CHANNEL, JSON.stringify(payload))
        .then((published) => {
            if (!published) {
                // Valkey unavailable — subscriber won't fire. Deliver locally
                // AND emit on adminEvents so single-pod deployments still
                // fan out to user-SSE listeners.
                deliverAdminMessageLocal(payload);
                safeEmit('admin_message_broadcast', payload);
            }
        })
        .catch(() => {
            deliverAdminMessageLocal(payload);
            safeEmit('admin_message_broadcast', payload);
        });
}

// Subscribe to admin-message channel for cross-pod delivery. Runs on every
// pod (including the publishing one) so each replica delivers to its local
// session-SSE clients AND fans out to its local user-SSE listeners.
void subscribeToChannel(ADMIN_MSG_CHANNEL, (message) => {
    try {
        const parsed = JSON.parse(message) as AdminMessagePayload;
        deliverAdminMessageLocal(parsed);
        safeEmit('admin_message_broadcast', parsed);
    } catch {
        logger.warn('Received invalid admin-message on pub/sub channel', {
            message,
        });
    }
}).catch((err: unknown) => {
    logger.warn(
        'Failed to subscribe to admin-message channel — cross-pod admin toasts will not deliver',
        {},
        err as Error,
    );
});

// ---------------------------------------------------------------------------
// Maintenance notice — persisted + broadcast
// ---------------------------------------------------------------------------

function parseMaintenanceNotice(raw: string | null): MaintenanceNotice | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<MaintenanceNotice>;
        if (
            typeof parsed.id !== 'string' ||
            typeof parsed.message !== 'string' ||
            typeof parsed.endsAt !== 'number' ||
            typeof parsed.createdBy !== 'string' ||
            typeof parsed.createdAt !== 'number'
        ) {
            return null;
        }
        return {
            id: parsed.id,
            message: parsed.message,
            endsAt: parsed.endsAt,
            createdBy: parsed.createdBy,
            createdAt: parsed.createdAt,
        };
    } catch {
        return null;
    }
}

type MaintenanceWirePayload =
    ({ type: 'maintenance_notice' } & MaintenanceNoticeFrame) | { type: 'maintenance_cleared' };

/** Deliver a maintenance-related payload to every local controller. */
function deliverMaintenanceLocal(payload: MaintenanceWirePayload): void {
    for (const [, controllers] of sessionControllers) {
        for (const controller of controllers) {
            enqueueFrame(controller, payload);
        }
    }
}

/**
 * Persist + broadcast a maintenance notice.
 * Rejects (throws) if:
 *  - a notice is already active
 *  - endsAt is in the past
 *  - endsAt > 24h from now
 *
 * Those validation errors bubble so the route handler can map them to
 * appropriate HTTP responses (400/409).
 */
export async function setMaintenanceNotice(opts: {
    message: string;
    endsAt: number;
    createdBy: string;
}): Promise<MaintenanceNotice> {
    const now = Date.now();

    if (opts.endsAt <= now) {
        throw new Error('Maintenance endsAt must be in the future (past)');
    }
    if (opts.endsAt - now > MAX_NOTICE_DURATION_MS) {
        throw new Error('Maintenance endsAt must be within 24 hours from now');
    }

    const notice: MaintenanceNotice = {
        id: crypto.randomUUID(),
        message: opts.message,
        endsAt: opts.endsAt,
        createdBy: opts.createdBy,
        createdAt: now,
    };

    // TTL = remaining seconds + 60s buffer so stale keys auto-expire even
    // if the process dies before clearMaintenanceNotice() runs.
    const ttlSeconds = Math.ceil((opts.endsAt - now) / 1000) + 60;

    // Atomic SET-NX — closes the TOCTOU window that existed when two admins
    // submitted concurrently (both GET-saw no notice, both SET, second won).
    const acquired = await setIfNotExists(MAINTENANCE_KEY, JSON.stringify(notice), ttlSeconds);
    if (!acquired) {
        // setIfNotExists returns false for BOTH "key already exists" and
        // "Valkey unavailable" — disambiguate via a health probe so admins
        // don't see "already active" during an outage.
        if (!(await isCoordinationValkeyHealthy())) {
            throw new Error('Valkey unavailable — cannot persist maintenance notice');
        }
        throw new Error(
            'A maintenance notice is already active — clear it before setting a new one',
        );
    }

    // Publish the base notice (without remainingMs) so every receiving pod
    // recomputes remainingMs at its own delivery time.
    const pubPayload = { type: 'maintenance_notice' as const, ...notice };

    // Cross-pod fan-out — subscriber (below) handles BOTH local session-SSE
    // delivery and the adminEvents emit for user-SSE. The fallback path
    // (publish returned false) also triggers an emit so single-pod deploys
    // still notify user-SSE.
    publishMessage(MAINTENANCE_CHANNEL, JSON.stringify(pubPayload))
        .then((published) => {
            if (!published) {
                deliverMaintenanceLocal({
                    type: 'maintenance_notice',
                    ...withRemaining(notice),
                });
                safeEmit('maintenance_notice', withRemaining(notice));
            }
        })
        .catch(() => {
            deliverMaintenanceLocal({
                type: 'maintenance_notice',
                ...withRemaining(notice),
            });
            safeEmit('maintenance_notice', withRemaining(notice));
        });

    return notice;
}

/**
 * Clear any active maintenance notice. Safe to call when no notice exists.
 */
export async function clearMaintenanceNotice(): Promise<void> {
    await cacheDel(MAINTENANCE_KEY);

    const payload = { type: 'maintenance_cleared' as const };

    // Same pattern: subscriber fans out adminEvents, fallback also emits.
    publishMessage(MAINTENANCE_CHANNEL, JSON.stringify(payload))
        .then((published) => {
            if (!published) {
                deliverMaintenanceLocal(payload);
                safeEmit('maintenance_cleared');
            }
        })
        .catch(() => {
            deliverMaintenanceLocal(payload);
            safeEmit('maintenance_cleared');
        });
}

/**
 * Return the active maintenance notice, or null if none is set (or the set
 * one has already expired per its endsAt — defensive check in case the
 * Valkey TTL buffer has not yet evicted the key).
 */
export async function getActiveMaintenanceNotice(): Promise<MaintenanceNotice | null> {
    const raw = await cacheGet(MAINTENANCE_KEY);
    const parsed = parseMaintenanceNotice(raw);
    if (!parsed) return null;
    if (parsed.endsAt <= Date.now()) return null;
    return parsed;
}

/**
 * Push the current maintenance-notice state to a freshly-connected SSE
 * controller. Always sends a frame so the client converges on server state:
 *   - Active notice → `maintenance_notice` frame
 *   - No notice    → `maintenance_cleared` frame
 *
 * The cleared frame is essential: if a client missed the `maintenance_cleared`
 * event during an SSE flap, replaying nothing would leave the client's local
 * store stuck on the stale notice until `endsAt` elapsed.
 */
export async function deliverMaintenanceOnConnect(
    controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
    const notice = await getActiveMaintenanceNotice();
    if (notice) {
        enqueueFrame(controller, {
            type: 'maintenance_notice',
            ...withRemaining(notice),
        });
    } else {
        enqueueFrame(controller, { type: 'maintenance_cleared' });
    }
}

// Subscribe to maintenance channel for cross-pod delivery. Runs on every
// pod (including publisher) so each replica fans out to its local
// session-SSE clients and its local user-SSE listeners via adminEvents.
// remainingMs is computed here (at delivery time on this pod) so clients
// receive a value accurate to their pod's clock, not the publishing pod's.
void subscribeToChannel(MAINTENANCE_CHANNEL, (message) => {
    try {
        const parsed = JSON.parse(message) as
            ({ type: 'maintenance_notice' } & MaintenanceNotice) | { type: 'maintenance_cleared' };
        if (parsed.type === 'maintenance_notice') {
            const { type: _t, ...notice } = parsed;
            void _t;
            const frame = withRemaining(notice);
            deliverMaintenanceLocal({ type: 'maintenance_notice', ...frame });
            // Strip the discriminator before emitting — listeners expect the
            // MaintenanceNotice shape, not the wire payload.
            safeEmit('maintenance_notice', frame);
        } else if (parsed.type === 'maintenance_cleared') {
            deliverMaintenanceLocal(parsed);
            safeEmit('maintenance_cleared');
        }
    } catch {
        logger.warn('Received invalid maintenance message on pub/sub channel', {
            message,
        });
    }
}).catch((err: unknown) => {
    logger.warn(
        'Failed to subscribe to maintenance channel — cross-pod maintenance notices will not deliver',
        {},
        err as Error,
    );
});
