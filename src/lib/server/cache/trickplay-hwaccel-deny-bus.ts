// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cross-replica reset bus for the trickplay hardware-decode deny latch.
 *
 * `trickplay-generator.service.ts` keeps a module-scope `hwaccelDisabledCodecs`
 * Set in front of the Valkey-backed deny list: once a codec is proven
 * undecodable on this box, every later `resolveDecodeMode()` call short-circuits
 * on the Set BEFORE ever consulting the cache again. That is deliberate — it is
 * what stops a proven-bad codec from re-probing the GPU on every single source
 * — but it also means an admin clearing the Valkey entries only ever reaches
 * the ONE replica that served the request. Every other replica keeps enforcing
 * the lesson until its process restarts.
 *
 * That is exactly the shape of the 2026-08-07 incident: a `-color_range` bug
 * made AV1+10bit decode fail, the deny-map learned "av1@10bit is undecodable",
 * and there was no way to tell a live process to forget it — deleting the
 * Valkey key by hand was not sufficient. This bus is the operator's escape
 * hatch: the admin reset publishes here, and every replica drops the entry
 * from its own in-process Set the moment the message arrives, no restart
 * required.
 *
 * Unlike {@link ./decode-deny-bus.ts} (the transcoding backend's own deny-map,
 * keyed by GPU backend + codec + bit depth, with the added complexity of
 * replicating "learn" events too), this deny-map only needs LEARN to propagate,
 * and it already does: a replica that misses a local learn still gets it from
 * the cache on its next `resolveDecodeMode()` call, because the Set is only
 * checked FIRST once it already holds the codec. So this bus only ever needs
 * to invalidate — same shape as {@link ./auth-cache-bus.ts}.
 *
 * Channel layout:
 *   trickplay:hwaccel-deny:reset — JSON payloads, see
 *   TrickplayHwaccelDenyResetEvent below.
 *
 * Uses the CACHE Valkey instance: these messages are transient, and a replica
 * that misses one still self-heals on its next restart (fresh module state) or
 * once the underlying deny entry's own TTL expires.
 *
 * Startup: call startTrickplayHwaccelDenySubscriber() once after Valkey
 * connects. Before that, publishes still work — other replicas receive them.
 */

import { Logger } from '../utils/logger.js';
import { publishMessage, subscribeToChannel } from './valkey.js';

const logger = Logger.for('TrickplayHwaccelDenyBus');

/** The Valkey pub/sub channel for trickplay hwaccel-deny resets. */
export const TRICKPLAY_HWACCEL_DENY_RESET_CHANNEL = 'trickplay:hwaccel-deny:reset';

/** Payload published when the trickplay hwaccel deny latch should be cleared. */
export type TrickplayHwaccelDenyResetEvent =
    { kind: 'reset-all' } | { kind: 'reset-key'; codecKey: string };

// Process-local ID so a replica ignores its own publishes — it already applied
// the change locally before publishing.
const LOCAL_INSTANCE_ID = `${process.pid}-${Date.now()}`;

type ResetHandler = (event: TrickplayHwaccelDenyResetEvent) => void;

const resetCallbacks = new Set<ResetHandler>();

/** Register the local applier for a remote reset (trickplay-generator.service.ts calls this once). */
export function onRemoteTrickplayHwaccelDenyReset(fn: ResetHandler): void {
    resetCallbacks.add(fn);
}

/** Publish a deny-latch reset to the other replicas (fire-and-forget). */
export function publishTrickplayHwaccelDenyReset(event: TrickplayHwaccelDenyResetEvent): void {
    const payload = JSON.stringify({ ...event, _from: LOCAL_INSTANCE_ID });
    // Best-effort by design. A failed publish degrades to exactly today's
    // behaviour (only the replica that served the admin request clears its
    // latch) — it must never fail the admin action that triggered it.
    publishMessage(TRICKPLAY_HWACCEL_DENY_RESET_CHANNEL, payload).catch((err: unknown) => {
        logger.debug('trickplay hwaccel-deny reset publish failed (non-critical)', {
            error: err instanceof Error ? err.message : String(err),
        });
    });
}

/** Handle one raw pub/sub message. */
function handleResetMessage(raw: string): void {
    let event: TrickplayHwaccelDenyResetEvent & { _from?: string };
    try {
        event = JSON.parse(raw) as typeof event;
    } catch {
        logger.warn('trickplay hwaccel-deny reset: malformed message ignored', { raw });
        return;
    }

    // Our own publish — the local latch already reflects it.
    if (event._from === LOCAL_INSTANCE_ID) return;

    switch (event.kind) {
        case 'reset-all':
            for (const fn of resetCallbacks) fn({ kind: 'reset-all' });
            break;
        case 'reset-key':
            if (typeof event.codecKey !== 'string' || event.codecKey.length === 0) {
                logger.warn('trickplay hwaccel-deny reset: reset-key with no codecKey ignored', {
                    raw,
                });
                return;
            }
            for (const fn of resetCallbacks) fn({ kind: 'reset-key', codecKey: event.codecKey });
            break;
        default:
            logger.debug('trickplay hwaccel-deny reset: unknown kind, ignoring', { raw });
    }
}

let subscriberStarted = false;
let subscriberStartup: Promise<boolean> | undefined;

/**
 * Start the cross-replica reset subscriber. Idempotent.
 *
 * A silent no-op when Valkey is unavailable: replicas then behave exactly as
 * they did before this bus existed, which is degraded but correct.
 */
export async function startTrickplayHwaccelDenySubscriber(): Promise<boolean> {
    if (subscriberStarted) return true;
    if (subscriberStartup) return subscriberStartup;
    const attempt = (async (): Promise<boolean> => {
        const unsubscribe = await subscribeToChannel(
            TRICKPLAY_HWACCEL_DENY_RESET_CHANNEL,
            handleResetMessage,
        );
        if (!unsubscribe) {
            logger.warn(
                'trickplay hwaccel-deny reset subscriber not started — this replica will not receive peers’ resets',
                { channel: TRICKPLAY_HWACCEL_DENY_RESET_CHANNEL },
            );
            return false;
        }
        subscriberStarted = true;
        logger.info('trickplay hwaccel-deny reset subscriber started', {
            channel: TRICKPLAY_HWACCEL_DENY_RESET_CHANNEL,
        });
        return true;
    })();
    subscriberStartup = attempt;
    try {
        return await attempt;
    } finally {
        if (subscriberStartup === attempt) subscriberStartup = undefined;
    }
}

/** Test seam: drop registered handlers and allow the subscriber to start again. */
export function _resetTrickplayHwaccelDenyBusForTests(): void {
    resetCallbacks.clear();
    subscriberStarted = false;
    subscriberStartup = undefined;
}

/** Test seam: deliver a raw message as if it arrived from another replica. */
export function _handleTrickplayHwaccelDenyResetForTests(raw: string): void {
    handleResetMessage(raw);
}
