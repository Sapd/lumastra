// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /runs/stream
//
// Admin-wide SSE endpoint. Subscribes to all task:events:<class> pubsub
// channels and emits CloudEvent frames to connected clients.
// Replay buffer is Valkey-backed so reconnects survive replica handoff:
//   - `INCR task:sse:lastId` produces a cluster-wide monotonic id.
//   - LPUSH/LTRIM on `task:sse:replay` stores the last 200 frames.
// On reconnect with `Last-Event-ID: N` we scan the LIST for ids > N
// and replay them, regardless of which replica handled them originally.
// Scope: runs:read
//
// The Valkey-backed replay/broadcast fabric lives in sse-replay-hub.ts; this
// module owns the task-event channel fan-out, CloudEvent shaping, and auth.
//
// B1 facade port: this def is dual-mounted onto BOTH `/api/v1/runs/stream`
// (token surface) and `/api/runs/stream` (internal forward-auth/cookie surface).
// Behaviour, CloudEvent shaping, replay semantics and scope (`runs:read`) are
// preserved EXACTLY from the former bespoke `/api/v1/runs/stream/+server.ts`.
// The module-level subscription side-effect runs once at import time, regardless
// of how many surfaces mount the def, because ES module instances are singletons.

import { defineEndpoint } from '$lib/server/api/define.js';
import { RESOURCE_CLASSES } from '@sapd/lumastra-plugin-sdk';
import { ulid } from 'ulid';
import { subscribeToChannel } from '$lib/server/cache/valkey.js';
import {
    createSseReplayHub,
    type SSEFrame,
    type Consumer,
} from '$lib/server/utils/sse-replay-hub.js';

const hub = createSseReplayHub({
    replayKey: 'task:sse:replay',
    replayIdKey: 'task:sse:lastId',
    defaultFrameType: 'task.event',
    evictionLogPrefix: '[sse-stream]',
});

// Exported for unit tests so they can assert bootstrap-window buffering
// without having to spin up a full SSE stream.
export type { Consumer };
export const _consumersForTest = hub.consumers;

export function _broadcastToConsumersForTest(frame: SSEFrame): void {
    hub.broadcast(frame);
}

// ── Module-level channel subscriptions (one per resource class) ───────────────
//
// These run once at module load time. The subscribe calls open dedicated
// Valkey subscription clients that persist for the lifetime of the replica.
// Failures are non-fatal: the frame is simply not broadcast.

// Subscribes to per-resource-class run CloudEvent channels plus `meta`.
// Derived from RESOURCE_CLASSES (@sapd/lumastra-plugin-sdk) so adding a new
// resource class can never silently drop its run.started/completed/failed
// events from the admin SSE bus — a hardcoded list previously drifted (a new
// `discovery` class was missed). `meta` is the non-class autonomous-action
// channel and is appended explicitly.
const CLASSES = [...RESOURCE_CLASSES, 'meta'] as const;
export type ChannelClass = (typeof CLASSES)[number];

// Whitelist of every meta subtype currently emitted by the task system. New
// subtypes must be added here AND have a matching `org.lumastra.task.meta.*`
// CloudEvent type registered with the admin client schema, otherwise
// `_metaCloudEventType` demotes them to `unknown` and downstream consumers
// can't pattern-match.
//
// Publishers grouped by file:
//   - orchestrator.ts: leader-elected, leader-reacquired, subscription-lost,
//                      transition-conflict, scheduler-tick, node-registered
//   - runner.ts:       pipeline-when-skip
//   - boot-recovery.ts: recovery-reclaimed
const META_TYPES = new Set([
    'leader-elected',
    'leader-reacquired',
    'subscription-lost',
    'transition-conflict',
    'node-registered',
    'scheduler-tick',
    'recovery-reclaimed',
    'pipeline-when-skip',
]);

/**
 * Derive a CloudEvent type string from a meta payload's `type` field.
 * Falls back to `org.lumastra.task.meta.unknown` for unrecognised subtypes.
 * Exported for unit tests.
 */
export function _metaCloudEventType(payloadType: string): string {
    const sub = payloadType.replace(/^org\.lumastra\.task\.meta\./, '');
    return META_TYPES.has(sub) ? `org.lumastra.task.meta.${sub}` : 'org.lumastra.task.meta.unknown';
}

/** Wrap-step result describing a frame ready for broadcast. */
export interface PreparedFrame {
    type: string;
    data: unknown;
    /**
     * Whether this frame should be persisted to the Valkey-backed replay
     * buffer. We deliberately skip meta events: they're informational and
     * the buffer is sized for transition events — letting meta consume
     * slots would push real transitions out of the replay window.
     */
    shouldPushToReplay: boolean;
}

/**
 * Parse a raw pubsub message into a SSE frame. Pure helper, exported for
 * unit tests. Returns `null` if the payload is malformed and should be
 * dropped silently (callers must never crash the stream on bad input).
 *
 * For the `meta` channel we synthesise a full CloudEvent envelope so
 * `CloudEventSchema.safeParse` succeeds on the client. Publishers
 * (`emitMeta` in orchestrator/runner/boot-recovery) emit a thin
 * `{type, data?, ts?}` shape — the envelope is constructed here.
 */
export function _prepareFrame(cls: ChannelClass, message: string): PreparedFrame | null {
    let evt: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(message);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return null;
        }
        evt = parsed as Record<string, unknown>;
    } catch {
        return null;
    }

    if (cls === 'meta') {
        const rawType = typeof evt.type === 'string' ? evt.type : '';
        const cloudType = _metaCloudEventType(rawType);
        // Preserve the publisher's timestamp when present so the envelope's
        // `time` field reflects the actual emit time rather than the SSE
        // bridge's forwarding time. Fall back to `now` for publishers that
        // omit `ts` (e.g. boot-recovery's emitMeta).
        const ts = typeof evt.ts === 'string' ? evt.ts : new Date().toISOString();
        // Publishers emit either `{type, data, ts}` (orchestrator/runner)
        // or flat `{type, ...fields}` (boot-recovery). Only treat `data`
        // as nested when it's a non-null plain object — `null`, primitives,
        // and arrays all fall through to the flat-fold path so the envelope's
        // `data` is always an object and passes CloudEventSchema.
        const hasNestedData =
            evt.data != null && typeof evt.data === 'object' && !Array.isArray(evt.data);
        const envelope = {
            specversion: '1.0' as const,
            id: ulid(),
            source: '/lumastra/orchestrator',
            type: cloudType,
            subject: 'meta',
            time: ts,
            datacontenttype: 'application/json' as const,
            data: hasNestedData
                ? evt.data
                : (() => {
                      const rest = { ...evt };
                      delete rest.type;
                      delete rest.ts;
                      // When the publisher set a non-object `data` (null,
                      // string, number, array), drop it from the flat fold —
                      // it's never a meaningful payload, and forwarding `null`
                      // failed schema validation in the first place.
                      delete rest.data;
                      return rest;
                  })(),
        };
        return { type: cloudType, data: envelope, shouldPushToReplay: false };
    }

    const type = typeof evt.type === 'string' ? evt.type : `task.${cls}.event`;
    return { type, data: evt, shouldPushToReplay: true };
}

/**
 * Build a `org.lumastra.task.run.progress` CloudEvent envelope from a raw
 * progress pubsub message. ProgressTracker publishes a flat
 * `{ runId, stageId, processed, total, currentItem, ts }` payload to
 * `task:events:progress`. We wrap it into the canonical CloudEvent shape
 * so the runSSEBus's `CloudEventSchema.safeParse` path accepts it.
 *
 * Returns null on malformed input (drops silently — never crashes the stream).
 *
 * `shouldPushToReplay: false` — progress is ephemeral. A reconnecting client
 * re-seeds via /api/v1/runs?state=active (which now merges live Valkey
 * fields); replaying individual 250ms ticks would just pollute the buffer.
 *
 * Exported for unit tests.
 */
export function _prepareProgressFrame(message: string): PreparedFrame | null {
    let evt: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(message);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return null;
        }
        evt = parsed as Record<string, unknown>;
    } catch {
        return null;
    }
    const runId = typeof evt.runId === 'string' ? evt.runId : null;
    const stageId = typeof evt.stageId === 'string' ? evt.stageId : 'main';
    if (!runId) return null;
    const processed = typeof evt.processed === 'number' ? evt.processed : 0;
    const total = typeof evt.total === 'number' ? evt.total : 0;
    const currentItem = typeof evt.currentItem === 'string' ? evt.currentItem : undefined;
    const tsMs = typeof evt.ts === 'number' ? evt.ts : Date.now();
    const envelope = {
        specversion: '1.0' as const,
        id: ulid(),
        source: '/lumastra/orchestrator',
        type: 'org.lumastra.task.run.progress',
        subject: runId,
        time: new Date(tsMs).toISOString(),
        datacontenttype: 'application/json' as const,
        data: {
            runId,
            stages: [
                {
                    id: stageId,
                    processed,
                    total,
                    ...(currentItem ? { currentItem } : {}),
                },
            ],
        },
    };
    return {
        type: 'org.lumastra.task.run.progress',
        data: envelope,
        shouldPushToReplay: false,
    };
}

async function setupSubscriptions(): Promise<void> {
    // Per-class run CloudEvent channels (started/completed/failed/etc.)
    // plus the global meta channel.
    for (const cls of CLASSES) {
        const channel = `task:events:${cls}`;
        try {
            await subscribeToChannel(channel, (msg) => {
                const prepared = _prepareFrame(cls, msg);
                if (!prepared) return;

                // Off the hot path — INCR + LPUSH are best-effort. If
                // Valkey is unavailable the local consumer still receives
                // the frame; only cross-replica reconnect-replay is lost.
                void (async () => {
                    const client = hub.getClient();
                    let id = 0;
                    if (client && prepared.shouldPushToReplay) {
                        try {
                            id = await hub.nextMonotonicId(client);
                        } catch {
                            // INCR failed — degrade to id=0; client treats it as un-replayable.
                        }
                    }
                    const frame: SSEFrame = {
                        id,
                        type: prepared.type,
                        data: prepared.data,
                    };
                    if (client && id > 0 && prepared.shouldPushToReplay) {
                        try {
                            await hub.pushFrame(client, frame);
                        } catch {
                            // Replay-buffer push failed — broadcast anyway.
                        }
                    }
                    hub.broadcast(frame);
                })();
            });
        } catch {
            // Best-effort — subscription failure shouldn't crash the module.
        }
    }

    // Global progress channel — single channel for all runs, payload carries
    // runId. ProgressTracker publishes here every 250ms (throttled) + 30s
    // heartbeat. Frames are NOT pushed to the replay buffer (see
    // _prepareProgressFrame docstring).
    try {
        await subscribeToChannel('task:events:progress', (msg) => {
            const prepared = _prepareProgressFrame(msg);
            if (!prepared) return;
            const frame: SSEFrame = {
                id: 0,
                type: prepared.type,
                data: prepared.data,
            };
            hub.broadcast(frame);
        });
    } catch {
        // Non-fatal — progress is a nice-to-have, state transitions still flow.
    }
}

// Fire-and-forget — do not await at module level to avoid blocking Vite/SSR.
void setupSubscriptions();

// ── Endpoint definition ───────────────────────────────────────────────────────
//
// `raw: true` — Class R response (SSE stream). Pre-stream auth failures still
// emit problem+json (handled by mount's enforce()); the stream body itself is
// transport-native text/event-stream.
export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Runs'],
            summary: 'Stream run events (SSE)',
            stability: 'protocol',
            description:
                'Server-Sent Events stream of live run/stage transitions for the admin task UI. Authenticated via admin cookie (EventSource) or a short-TTL query token; not a general third-party contract.',
            auth: 'none',
            responses: {
                200: { sse: true, description: 'text/event-stream of run events' },
                401: 'Authentication required',
                429: 'Per-user SSE connection limit reached — too many concurrent streams for this user',
                503: {
                    description: 'Process-wide SSE connection capacity reached — try again shortly',
                    code: 'stream_limit',
                },
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['runs:read'] },
    raw: true,
    // P1: bound CONNECT churn — see the identical comment on defs/events/index.ts.
    rateLimit: {
        limit: 30,
        windowSec: 60,
        keyBy: (event) =>
            `sse-connect:runs-stream:${event.locals.principal?.username ?? event.locals.user?.username ?? 'anonymous'}`,
    },
    handlers: {
        GET: async (event) => {
            return hub.streamResponse(event);
        },
    },
});
