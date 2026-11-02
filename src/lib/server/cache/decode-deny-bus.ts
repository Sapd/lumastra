// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cross-replica sync for the learned GPU decode deny-map.
 *
 * The deny-map records "this GPU cannot hardware-decode codec X" and is hydrated
 * from Valkey ONCE per process, then written back whole on every change. On a
 * multi-replica deployment that gives two concrete failures:
 *
 *   • **A reset does not reach the other replicas.** The admin "Reset decode
 *     cache" button clears only the pod that happened to serve the request; the
 *     others keep enforcing the lesson. This is the one that matters — a reset is
 *     the operator's only escape hatch from a FALSE lesson, and one really did
 *     divert a decodable codec onto a broken path for two days.
 *   • **Whole-map writes clobber each other.** Pod B, which hydrated before pod A
 *     learned anything, writes its own map back on its next learn and silently
 *     erases A's lesson from Valkey.
 *
 * Publishing each mutation keeps every replica's in-memory map convergent, which
 * in turn makes the persisted blob convergent — so both failures go away without
 * introducing a distributed lock on what is, fundamentally, a cache.
 *
 * Unlike {@link ./auth-cache-bus.ts}, which only ever needs to INVALIDATE, this
 * bus carries the added entry too: a replica that misses a learn re-discovers it
 * only by failing a playback itself, so propagating costs one message and saves
 * one user-visible failure per replica.
 *
 * Channel layout:
 *   transcode:decode-deny:sync  — JSON payloads, see DecodeDenySyncEvent below.
 *
 * Uses the CACHE Valkey instance, matching auth-cache-bus: these messages are
 * transient, and a replica that misses one re-hydrates the durable state from
 * Valkey on its next restart.
 *
 * Startup: call startDecodeDenySubscriber() once after Valkey connects. Before
 * that, publishes still work — other replicas receive them.
 */

import { Logger } from '../utils/logger.js';
import { publishMessage, subscribeToChannel } from './valkey.js';

const logger = Logger.for('DecodeDenyBus');

/** The Valkey pub/sub channel for decode deny-map synchronisation. */
export const DECODE_DENY_SYNC_CHANNEL = 'transcode:decode-deny:sync';

/**
 * A learned lesson as it crosses the wire.
 *
 * Structurally identical to `LearnedDecodeEntry` in the transcoding service, but
 * declared here so this module stays free of a runtime import back into
 * hardware-detection (which imports this one). The receiving side re-validates
 * every field rather than trusting the payload.
 */
export interface DecodeDenyWireEntry {
    codec: string;
    bitDepth: number;
    learnedAt: string;
    learnedBy?: string;
    sample?: string;
}

/** Payload published when the deny-map changes on some replica. */
export type DecodeDenySyncEvent =
    | { kind: 'learn'; backend: string; key: string; entry: DecodeDenyWireEntry }
    | { kind: 'reset'; backend?: string };

// Process-local ID so a replica ignores its own publishes — it already applied
// the change locally before publishing.
const LOCAL_INSTANCE_ID = `${process.pid}-${Date.now()}`;

type LearnHandler = (backend: string, key: string, entry: DecodeDenyWireEntry) => void;
type ResetHandler = (backend?: string) => void;

const learnCallbacks = new Set<LearnHandler>();
const resetCallbacks = new Set<ResetHandler>();

/** Register the local applier for a remote learn (hardware-detection calls this once). */
export function onRemoteDecodeDenyLearn(fn: LearnHandler): void {
    learnCallbacks.add(fn);
}

/** Register the local applier for a remote reset. */
export function onRemoteDecodeDenyReset(fn: ResetHandler): void {
    resetCallbacks.add(fn);
}

/** Publish a deny-map change to the other replicas (fire-and-forget). */
export function publishDecodeDenySync(event: DecodeDenySyncEvent): void {
    const payload = JSON.stringify({ ...event, _from: LOCAL_INSTANCE_ID });
    // Best-effort by design. A failed publish degrades to exactly today's
    // behaviour (each replica learns independently, a reset reaches one pod) —
    // it must never fail the transcode path that triggered it.
    publishMessage(DECODE_DENY_SYNC_CHANNEL, payload).catch((err: unknown) => {
        logger.debug('decode deny sync publish failed (non-critical)', {
            error: err instanceof Error ? err.message : String(err),
        });
    });
}

/**
 * Backends the deny-map may be keyed by.
 *
 * The wire `backend` becomes a MAP KEY, which the next local mutation persists to
 * Valkey and every replica then hydrates — so an unvalidated string does not stay
 * confined to the receiving process. Every other field is already re-validated;
 * this closes the one that was passed through on a cast.
 */
const KNOWN_BACKENDS = new Set(['qsv', 'vaapi', 'nvenc', 'amf', 'videotoolbox', 'none']);

/** Validate a wire entry — a malformed payload must not corrupt the local map. */
function toWireEntry(value: unknown): DecodeDenyWireEntry | null {
    if (!value || typeof value !== 'object') return null;
    const e = value as Record<string, unknown>;
    const codec = typeof e.codec === 'string' ? e.codec.toLowerCase() : null;
    // Same rule as the write and hydrate paths: a lesson without a codec and a
    // real bit depth cannot be scoped, so it is never applied.
    const bitDepth = typeof e.bitDepth === 'number' && e.bitDepth > 0 ? e.bitDepth : null;
    if (!codec || bitDepth === null) return null;
    return {
        codec,
        bitDepth,
        learnedAt: typeof e.learnedAt === 'string' ? e.learnedAt : new Date(0).toISOString(),
        // Carried through verbatim: validity is keyed on it, and rewriting it with
        // the RECEIVER's build would make another replica's lesson look locally
        // learned and outlive the build that recorded it.
        learnedBy: typeof e.learnedBy === 'string' ? e.learnedBy : undefined,
        sample: typeof e.sample === 'string' ? e.sample : undefined,
    };
}

/** Handle one raw pub/sub message. */
function handleSyncMessage(raw: string): void {
    let event: DecodeDenySyncEvent & { _from?: string };
    try {
        event = JSON.parse(raw) as typeof event;
    } catch {
        logger.warn('decode deny sync: malformed message ignored', { raw });
        return;
    }

    // Our own publish — the local map already has it.
    if (event._from === LOCAL_INSTANCE_ID) return;

    switch (event.kind) {
        case 'learn': {
            const entry = toWireEntry(event.entry);
            if (
                !entry ||
                typeof event.key !== 'string' ||
                !KNOWN_BACKENDS.has(event.backend as string)
            ) {
                logger.warn('decode deny sync: incomplete learn event ignored', { raw });
                return;
            }
            for (const fn of learnCallbacks) fn(event.backend, event.key, entry);
            break;
        }
        case 'reset':
            for (const fn of resetCallbacks) fn(event.backend);
            break;
        default:
            logger.debug('decode deny sync: unknown kind, ignoring', { raw });
    }
}

let subscriberStarted = false;
let subscriberStartup: Promise<boolean> | undefined;

/**
 * Start the cross-replica deny-map subscriber. Idempotent.
 *
 * A silent no-op when Valkey is unavailable: replicas then behave exactly as they
 * did before this bus existed, which is degraded but correct.
 */
export async function startDecodeDenySubscriber(): Promise<boolean> {
    if (subscriberStarted) return true;
    if (subscriberStartup) return subscriberStartup;
    const attempt = (async (): Promise<boolean> => {
        const unsubscribe = await subscribeToChannel(DECODE_DENY_SYNC_CHANNEL, handleSyncMessage);
        if (!unsubscribe) {
            logger.warn(
                'decode deny sync subscriber not started — this replica will not receive peers’ resets',
                { channel: DECODE_DENY_SYNC_CHANNEL },
            );
            return false;
        }
        subscriberStarted = true;
        logger.info('decode deny sync subscriber started', { channel: DECODE_DENY_SYNC_CHANNEL });
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
export function _resetDecodeDenyBusForTests(): void {
    learnCallbacks.clear();
    resetCallbacks.clear();
    subscriberStarted = false;
    subscriberStartup = undefined;
}

/** Test seam: deliver a raw message as if it arrived from another replica. */
export function _handleSyncMessageForTests(raw: string): void {
    handleSyncMessage(raw);
}
