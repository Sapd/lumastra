// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Valkey-backed SSE replay hub.
 *
 * Factored out of the two admin SSE endpoints (`/api/admin/ingest/stream` and
 * `/api/v1/runs/stream`), which shared an identical replay-buffer + consumer
 * broadcast fabric. Each endpoint instantiates its OWN hub (own consumer set,
 * own Valkey replay keys, own pubsub subscription) — the hub only owns the
 * transport-agnostic plumbing:
 *
 *  - cluster-wide monotonic frame ids (`INCR <replayIdKey>`)
 *  - a bounded Valkey LIST replay buffer (`LPUSH`/`LTRIM`/`EXPIRE`)
 *  - reconnect replay via `Last-Event-ID` (scan the LIST for ids > since)
 *  - a bootstrap-window local buffer so live broadcasts that race the replay
 *    drain are not dropped, then a careful replay→live flip
 *
 * The per-endpoint differences (pubsub channels, frame shaping, auth) stay in
 * the route modules; they drive the hub via `getClient`/`nextMonotonicId`/
 * `pushFrame`/`broadcast` and serve requests via `streamResponse`.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { SSE_KEEPALIVE_MS } from '$lib/server/utils/sse.js';
import { config } from '$lib/server/config.js';
import { problem } from '$lib/server/api/problem.js';
import { acquireUserConnectionSlot } from '$lib/server/utils/sse-connection-ceiling.js';

const encoder = new TextEncoder();

export interface SSEFrame {
    id: number;
    type: string;
    data: unknown;
}

/**
 * A consumer is a wrapper around the underlying ReadableStream controller that
 * can buffer frames during its bootstrap window. Between when the route handler
 * registers the consumer and when it finishes draining the Valkey replay
 * buffer, live pubsub broadcasts must NOT be dropped — they land in
 * `localBuffer` and are flushed after replay, deduped against the replay tail.
 */
export interface Consumer {
    controller: ReadableStreamDefaultController<Uint8Array>;
    /**
     * Buffer for frames that arrive during the replay-drain window. Mutable
     * because the post-replay flip swaps the array in atomically.
     */
    localBuffer: SSEFrame[];
    /** Flips to true once the route handler has drained Valkey replay. */
    replayDone: boolean;
    /**
     * Optional per-user filter. When set, `broadcast()` will only deliver
     * frames whose `targetUserId` field (in `frame.data`) matches this value
     * OR frames that have no `targetUserId` field (global frames).
     *
     * Used by the per-user `/api/v1/events` SSE endpoint so that a single hub
     * can serve all users without cross-user frame leakage.
     */
    targetUserId?: string;
    /**
     * The username this connection belongs to, when known (security fix
     * C28, 2026-09-16). Separate from `targetUserId` because the existing
     * cross-replica session-revocation signal (`auth-cache-bus.ts`'s
     * `{kind:'user-admin'}` invalidation, published by
     * `invalidateUserAdminCache()` at every disable/reset/delete path) keys
     * on USERNAME, not the `users.id` UUID. Used by
     * `closeConsumersForUsername()` to tear down an already-open stream when
     * its session is revoked — auth was previously checked only at connect.
     */
    targetUsername?: string;
    /**
     * The OAuth device session of the device-flow JWT that opened this
     * connection, when there is one. Used by
     * `closeConsumersForDeviceSessions()` so a device logout / revoke closes
     * that device's open stream (and only that device's).
     */
    targetDeviceSessionId?: string;
    /**
     * Release this consumer's per-user connection slot (P1). Idempotent —
     * safe to call from every cleanup path (abort, keepalive error, mid-drain
     * controller error, bootstrap failure) without double-releasing. Set by
     * `streamResponse()` right after a slot is successfully acquired.
     */
    releaseSlot?: () => void;
}

type ValkeyLike = { customCommand: (cmd: string[]) => Promise<unknown> };

export interface SseReplayHubOptions {
    /** Valkey LIST key holding the replay buffer (e.g. `task:sse:replay`). */
    replayKey: string;
    /** Valkey counter key for cluster-wide monotonic ids (e.g. `task:sse:lastId`). */
    replayIdKey: string;
    /** Fallback frame type used when a buffered frame omits its own type. */
    defaultFrameType: string;
    /** Prefix for the once-per-process buffer-eviction warning. */
    evictionLogPrefix: string;
    /** Max frames retained in the replay LIST (default 200). */
    replayMax?: number;
    /** TTL for the replay LIST in seconds (default 3600). */
    replayTtlSec?: number;
    /** Per-consumer bootstrap-window buffer cap (default 1000). */
    maxLocalBuffer?: number;
    /**
     * Interval (ms) between keepalive comment frames written to each live
     * connection (default {@link SSE_KEEPALIVE_MS}). Keeps idle connections warm
     * so neither a transport idle timeout (notably HTTP/3 / QUIC) nor the proxy
     * chain (Cloudflare→HAProxy→nginx) drops a stream that has gone quiet between
     * events. Set to 0 to disable.
     */
    keepaliveIntervalMs?: number;
}

export interface SseReplayHub {
    /** The live consumer set (exposed for unit tests). */
    readonly consumers: Set<Consumer>;
    /** Current Valkey client, or null when unavailable. */
    getClient(): ValkeyLike | null;
    /** `INCR <replayIdKey>` → next cluster-wide monotonic id. */
    nextMonotonicId(client: ValkeyLike): Promise<number>;
    /** Persist a frame to the bounded Valkey replay LIST. */
    pushFrame(client: ValkeyLike, frame: SSEFrame): Promise<void>;
    /** Broadcast a frame to all consumers (buffering bootstrap-window ones). */
    broadcast(frame: SSEFrame): void;
    /**
     * Security fix C28 (2026-09-16): close every open consumer whose
     * `targetUsername` matches, and prune them from the consumer set.
     * Closing the underlying controller ends that consumer's stream; a
     * caller layering additional sources on top (e.g. `defs/events/index.ts`'s
     * merged hub+extra pump) observes this as the hub reader completing and
     * tears the rest of its own connection down from there.
     *
     * Call this wherever a user's sessions are revoked (disable, password
     * reset, delete) so an already-open stream cannot keep delivering that
     * account's frames past revocation. Returns the number of consumers
     * closed.
     */
    closeConsumersForUsername(username: string): number;
    /**
     * Close every open consumer opened by one of these OAuth device sessions
     * (device logout / revoke). Returns the number closed.
     */
    closeConsumersForDeviceSessions(deviceSessionIds: readonly string[]): number;
    /** Encode a frame as an SSE wire chunk. */
    encodeSSEFrame(frame: SSEFrame): Uint8Array;
    /**
     * Build the SSE `Response` for a request (replay → live bootstrap).
     *
     * P1 (2026-09-13 fix plan): before building the stream, this enforces a
     * process-wide connection ceiling (`config.SSE_MAX_CONNECTIONS`, 503 when
     * exceeded) and a per-user connection ceiling (`config.
     * SSE_MAX_CONNECTIONS_PER_USER`, 429 when exceeded). A caller MUST check
     * the returned Response's status before treating it as an SSE stream — a
     * refused connection comes back as an ordinary problem+json Response, NOT
     * a `text/event-stream` one.
     *
     * @param event     SvelteKit RequestEvent.
     * @param opts.targetUserId  When set, this consumer only receives frames
     *   whose `data.targetUserId` equals this value OR frames with no
     *   `targetUserId` field (i.e. global/broadcast frames). Used by the
     *   per-user `/api/v1/events` endpoint to prevent cross-user leakage. Also
     *   used, when present, as the identity the per-user connection ceiling is
     *   keyed on (falling back to `event.locals.principal/user.username`).
     */
    streamResponse(
        event: RequestEvent,
        opts?: { targetUserId?: string; targetUsername?: string; targetDeviceSessionId?: string },
    ): Promise<Response>;
}

export function createSseReplayHub(opts: SseReplayHubOptions): SseReplayHub {
    const replayMax = opts.replayMax ?? 200;
    const replayTtlSec = opts.replayTtlSec ?? 3600;
    const maxLocalBuffer = opts.maxLocalBuffer ?? 1000;
    const keepaliveIntervalMs = opts.keepaliveIntervalMs ?? SSE_KEEPALIVE_MS;

    // SSE comment line (`:`-prefixed). EventSource ignores it entirely — it
    // fires no message/named event — so it's a safe way to push bytes through
    // the proxy chain without the client mistaking it for a CloudEvent.
    const PRELUDE_CHUNK = encoder.encode(': connected\n\n');
    const KEEPALIVE_CHUNK = encoder.encode(': ping\n\n');

    const consumers = new Set<Consumer>();
    let evictionWarningLogged = false;

    // ── P1: per-user connection ceiling ─────────────────────────────────────
    //
    // Delegates to the shared acquireUserConnectionSlot() (sse-connection-
    // ceiling.ts) — extracted from here (fix round 1, finding 2) so the
    // watch-together SSE path, a completely separate connection registry, can
    // reuse the exact same Valkey-INCR/DECR-with-in-process-fallback mechanism
    // rather than reimplementing it. Namespaced by this hub's `replayKey` so
    // two different hub instances (events / runs-stream / admin-ingest-stream)
    // never share one budget.

    /**
     * Identity a connection's per-user ceiling is keyed on. Prefers the
     * explicit `targetUserId` a caller passed to `streamResponse()` (the
     * per-user `/events` endpoint always has one); falls back to the
     * authenticated principal/user for hub instances with no per-connection
     * targeting (runs/stream, admin/ingest/stream — still per-admin-user).
     */
    function resolveConnectionUserId(event: RequestEvent, targetUserId?: string): string {
        if (targetUserId) return targetUserId;
        const locals = (event.locals ?? {}) as {
            principal?: { username?: string };
            user?: { username?: string };
        };
        return locals.principal?.username ?? locals.user?.username ?? 'anonymous';
    }

    function getClient(): ValkeyLike | null {
        return getCoordinationClient() as unknown as ValkeyLike | null;
    }

    async function nextMonotonicId(client: ValkeyLike): Promise<number> {
        const raw = await client.customCommand(['INCR', opts.replayIdKey]);
        return Number(raw ?? 0);
    }

    async function pushFrame(client: ValkeyLike, frame: SSEFrame): Promise<void> {
        const encoded = `${frame.id}:${JSON.stringify({ type: frame.type, data: frame.data })}`;
        await client.customCommand(['LPUSH', opts.replayKey, encoded]);
        await client.customCommand(['LTRIM', opts.replayKey, '0', String(replayMax - 1)]);
        await client.customCommand(['EXPIRE', opts.replayKey, String(replayTtlSec)]);
    }

    /**
     * Pull frames with id > sinceId from the Valkey replay LIST, oldest first.
     * Best-effort: returns [] when Valkey is unavailable.
     */
    async function readReplaySince(sinceId: number): Promise<SSEFrame[]> {
        const client = getClient();
        if (!client) return [];
        let raw: unknown;
        try {
            raw = await client.customCommand([
                'LRANGE',
                opts.replayKey,
                '0',
                String(replayMax - 1),
            ]);
        } catch {
            return [];
        }
        if (!Array.isArray(raw)) return [];

        const frames: SSEFrame[] = [];
        for (const item of raw) {
            if (typeof item !== 'string') continue;
            const sepIdx = item.indexOf(':');
            if (sepIdx <= 0) continue;
            const id = Number(item.slice(0, sepIdx));
            if (!Number.isFinite(id) || id <= sinceId) continue;
            let parsed: { type?: unknown; data?: unknown };
            try {
                parsed = JSON.parse(item.slice(sepIdx + 1)) as {
                    type?: unknown;
                    data?: unknown;
                };
            } catch {
                continue;
            }
            frames.push({
                id,
                type: typeof parsed.type === 'string' ? parsed.type : opts.defaultFrameType,
                data: parsed.data,
            });
        }
        // LRANGE returns newest-first (LPUSH order). Sort ascending for replay.
        frames.sort((a, b) => a.id - b.id);
        return frames;
    }

    function encodeSSEFrame(frame: SSEFrame): Uint8Array {
        return encoder.encode(
            `id: ${frame.id}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`,
        );
    }

    /**
     * A frame naming a device session (`data.targetDeviceSessionId`) belongs to
     * that device's stream only: every other consumer — another device of the
     * same account, a browser tab, a PAT stream with no device session — skips
     * it. Fails closed: a consumer without a device session never gets one.
     */
    function deviceTargetMismatch(frame: SSEFrame, consumer: Consumer): boolean {
        const data = frame.data as Record<string, unknown> | null | undefined;
        const target = data && typeof data === 'object' ? data['targetDeviceSessionId'] : undefined;
        if (target === undefined) return false;
        return typeof target !== 'string' || target !== consumer.targetDeviceSessionId;
    }

    /** Frames that are never in the replay buffer (see publishUserEvent). */
    function isReplayable(frame: SSEFrame): boolean {
        const data = frame.data as Record<string, unknown> | null | undefined;
        if (!data || typeof data !== 'object') return true;
        return !('targetDeviceSessionId' in data) && data['replay'] !== false;
    }

    function broadcast(frame: SSEFrame): void {
        const encoded = encodeSSEFrame(frame);
        // Array.from so we can mutate `consumers` while iterating.
        for (const consumer of Array.from(consumers)) {
            if (deviceTargetMismatch(frame, consumer)) continue;
            // Per-user filter: when the consumer has a targetUserId set, only
            // deliver frames that either target that user specifically OR have
            // no targetUserId (global/broadcast frames).
            if (consumer.targetUserId !== undefined) {
                const data = frame.data as Record<string, unknown> | null | undefined;
                const frameTarget =
                    data && typeof data === 'object' ? data['targetUserId'] : undefined;
                if (frameTarget !== undefined && frameTarget !== consumer.targetUserId) {
                    continue;
                }
            }

            if (!consumer.replayDone) {
                // Bootstrap-window write — buffer for post-replay drain. The
                // dedup pass in start() filters anything ≤ maxReplayId so we
                // don't double-send frames the replay already covered. Cap the
                // buffer so a slow drain + broadcast burst can't grow it without
                // bound; evict oldest (FIFO) so the newest still lands — the
                // client can reconnect with Last-Event-ID to fill the gap.
                if (consumer.localBuffer.length >= maxLocalBuffer) {
                    consumer.localBuffer.shift();
                    if (!evictionWarningLogged) {
                        evictionWarningLogged = true;
                        console.warn(
                            `${opts.evictionLogPrefix} consumer localBuffer hit MAX_LOCAL_BUFFER=${maxLocalBuffer}; evicting oldest frames`,
                        );
                    }
                }
                consumer.localBuffer.push(frame);
                continue;
            }
            try {
                consumer.controller.enqueue(encoded);
            } catch {
                // Controller is closed — prune so the Set doesn't grow unbounded
                // for clients that disconnected without aborting.
                consumers.delete(consumer);
                consumer.releaseSlot?.();
            }
        }
    }

    function closeConsumersForUsername(username: string): number {
        // Fix round 2 (2026-09-16): this is reachable from a malformed
        // `{kind:'user-admin'}` pub/sub frame off the unvalidated
        // `JSON.parse` in auth-cache-bus.ts's handleInvalidationMessage —
        // `username` is typed as `string` there but not runtime-checked, so
        // a non-string value here used to throw on `.toLowerCase()` instead
        // of the previous (harmless, `!==` always true) no-op.
        if (typeof username !== 'string') return 0;
        // Case-fold (fix round 1, 2026-09-16): this repo's standing rule is
        // to case-fold EVERY username comparison — the connect-time source
        // (locals.principal?.username ?? locals.user?.username,
        // defs/events/index.ts) and the revocation-time source (the DB
        // row's target.username) have diverged in case before (HLS 404s,
        // selfOrAdmin, duplicate identity rows). An exact-match comparison
        // here would silently leave a case-variant session's stream open
        // past revocation — the exact failure this function exists to fix.
        const target = username.toLowerCase();
        let closed = 0;
        for (const consumer of Array.from(consumers)) {
            if (consumer.targetUsername !== target) continue;
            consumers.delete(consumer);
            consumer.releaseSlot?.();
            try {
                consumer.controller.close();
            } catch {
                /* already closed */
            }
            closed++;
        }
        return closed;
    }

    function closeConsumersForDeviceSessions(deviceSessionIds: readonly string[]): number {
        if (!Array.isArray(deviceSessionIds)) return 0;
        const targets = new Set(deviceSessionIds.filter((id) => typeof id === 'string'));
        if (targets.size === 0) return 0;
        let closed = 0;
        for (const consumer of Array.from(consumers)) {
            if (!consumer.targetDeviceSessionId || !targets.has(consumer.targetDeviceSessionId)) {
                continue;
            }
            consumers.delete(consumer);
            consumer.releaseSlot?.();
            try {
                consumer.controller.close();
            } catch {
                /* already closed */
            }
            closed++;
        }
        return closed;
    }

    async function streamResponse(
        event: RequestEvent,
        streamOpts?: {
            targetUserId?: string;
            targetUsername?: string;
            targetDeviceSessionId?: string;
        },
    ): Promise<Response> {
        // ── P1: connection ceilings, checked BEFORE building the stream ──────
        //
        // Process-wide first (cheap, synchronous, no Valkey round trip) — a
        // replica already at capacity refuses new connections regardless of
        // which user is asking.
        const maxConnections = config.SSE_MAX_CONNECTIONS;
        if (consumers.size >= maxConnections) {
            return problem('stream_limit', {
                error: 'SSE connection capacity reached — try again shortly',
            });
        }

        const connectionUserId = resolveConnectionUserId(event, streamOpts?.targetUserId);
        const maxPerUser = config.SSE_MAX_CONNECTIONS_PER_USER;
        const slot = await acquireUserConnectionSlot(opts.replayKey, connectionUserId, maxPerUser);
        if (!slot.ok) {
            return problem('rate_limited', {
                error: `Too many concurrent SSE connections for this user (max ${maxPerUser})`,
            });
        }

        // Defensive: clients sometimes send `null`, negatives, or floats as
        // Last-Event-ID. Clamp to a non-negative integer, default to 0.
        const sinceParam =
            event.url.searchParams.get('since') ??
            event.request.headers.get('last-event-id') ??
            '0';
        const sinceNum = Number(sinceParam);
        const sinceId = Number.isFinite(sinceNum) && sinceNum >= 0 ? Math.floor(sinceNum) : 0;

        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                // Bootstrap race fix: register the consumer FIRST with a local
                // buffer, then drain Valkey replay, then drain the local buffer
                // (deduped against the replay tail), then transition to live.
                // Registering before the replay await means a frame broadcast
                // during that window lands in localBuffer instead of being lost.
                const consumer: Consumer = {
                    controller,
                    localBuffer: [],
                    replayDone: false,
                    releaseSlot: slot.release,
                    ...(streamOpts?.targetUserId !== undefined
                        ? { targetUserId: streamOpts.targetUserId }
                        : {}),
                    // Case-folded at storage time (fix round 1) to match
                    // closeConsumersForUsername()'s case-folded lookup.
                    ...(streamOpts?.targetUsername !== undefined
                        ? { targetUsername: streamOpts.targetUsername.toLowerCase() }
                        : {}),
                    ...(streamOpts?.targetDeviceSessionId
                        ? { targetDeviceSessionId: streamOpts.targetDeviceSessionId }
                        : {}),
                };
                consumers.add(consumer);

                // Declared before the abort handler so the handler's closure can
                // clear it; assigned further down. Keeping the setInterval as the
                // LAST thing start() does means an earlier throw (e.g. a malformed
                // event with no request.signal) can't leak a live timer.
                let keepalive: ReturnType<typeof setInterval> | null = null;

                // Cleanup on client disconnect — registered before any await (and
                // before the keepalive timer) so an abort mid-replay still tears
                // the consumer down AND stops the keepalive.
                event.request.signal.addEventListener('abort', () => {
                    if (keepalive) clearInterval(keepalive);
                    keepalive = null;
                    consumers.delete(consumer);
                    consumer.releaseSlot?.();
                    try {
                        controller.close();
                    } catch {
                        // Already closed.
                    }
                });

                // Immediate prelude flush. The proxy chain (Cloudflare→HAProxy→
                // nginx) won't forward the response status+headers to the browser
                // until some body bytes flow, so a quiet stream (empty replay
                // buffer, no in-flight events) would leave EventSource.onopen
                // un-fired — the client sits on "Reconnecting…" until something
                // finally flushes the pipe. Writing one ignored comment line up
                // front forces that flush so onopen fires immediately.
                try {
                    controller.enqueue(PRELUDE_CHUNK);
                } catch {
                    // Controller already closed (client aborted before start
                    // completed) — nothing to do.
                }

                // Keepalive: keep the idle connection warm so the proxy chain
                // doesn't re-buffer or drop a stream that has gone quiet between
                // events. Comment frames are ignored by EventSource. Created last
                // so no earlier throw in start() can orphan the timer.
                if (keepaliveIntervalMs > 0) {
                    keepalive = setInterval(() => {
                        try {
                            controller.enqueue(KEEPALIVE_CHUNK);
                            // Refresh the connection-slot TTL alongside the
                            // keepalive tick — otherwise a connection that
                            // outlives SSE_CONN_TTL_SEC (1h) has its slot key
                            // expire while still held (final fix wave,
                            // 2026-09-13).
                            slot.refresh();
                        } catch {
                            // Controller closed — stop pinging and prune.
                            if (keepalive) clearInterval(keepalive);
                            keepalive = null;
                            consumers.delete(consumer);
                            consumer.releaseSlot?.();
                        }
                    }, keepaliveIntervalMs);
                }

                try {
                    const replay = await readReplaySince(sinceId);
                    for (const frame of replay) {
                        // Device-addressed frames are never pushed to the replay
                        // buffer; skip one anyway rather than trust that (a
                        // replayed "pause" would be wrong even for its device).
                        const fd = frame.data as Record<string, unknown> | null | undefined;
                        if (fd && typeof fd === 'object' && 'targetDeviceSessionId' in fd) continue;
                        // Mirror the broadcast() per-user filter: when this
                        // connection has a targetUserId, skip frames that carry
                        // a *different* targetUserId in their data.  Frames with
                        // no targetUserId field are global/broadcast frames and
                        // are always replayed.
                        if (consumer.targetUserId !== undefined) {
                            const d = frame.data as Record<string, unknown> | null | undefined;
                            const ft = d && typeof d === 'object' ? d['targetUserId'] : undefined;
                            if (ft !== undefined && ft !== consumer.targetUserId) {
                                continue;
                            }
                        }
                        controller.enqueue(encodeSSEFrame(frame));
                    }
                    // Anything ≤ this id is already covered by the replay; frames
                    // buffered during the await with id > maxReplayId are new.
                    const maxReplayId = replay.length ? replay[replay.length - 1].id : sinceId;

                    // Replay→live flip must be atomic w.r.t. the broadcast path:
                    // snapshot the buffer, clear the consumer's reference, THEN
                    // flip `replayDone`. A concurrent broadcast either ran before
                    // and is in `pending` (flushed below), or runs after the flip
                    // and goes straight to the controller.
                    const pending = consumer.localBuffer;
                    consumer.localBuffer = [];
                    consumer.replayDone = true;
                    // A buffered frame is a duplicate only if the replay actually
                    // carried it: frames that never enter the replay buffer
                    // (device-addressed ones, `replay: false` signals) can have
                    // ids below the replay tail and must still be delivered.
                    const replayedIds = new Set(replay.map((f) => f.id));
                    for (const frame of pending) {
                        if (
                            frame.id > maxReplayId ||
                            (!replayedIds.has(frame.id) && !isReplayable(frame))
                        ) {
                            try {
                                controller.enqueue(encodeSSEFrame(frame));
                            } catch {
                                // Controller closed mid-drain — prune and bail.
                                consumers.delete(consumer);
                                consumer.releaseSlot?.();
                                return;
                            }
                        }
                    }
                } catch (err) {
                    // Failed during bootstrap — pull this consumer so it doesn't
                    // sit consuming broadcast slots forever, then surface error.
                    if (keepalive) clearInterval(keepalive);
                    keepalive = null;
                    consumers.delete(consumer);
                    consumer.releaseSlot?.();
                    throw err;
                }
            },
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
            },
        });
    }

    return {
        consumers,
        getClient,
        nextMonotonicId,
        pushFrame,
        broadcast,
        closeConsumersForUsername,
        closeConsumersForDeviceSessions,
        encodeSSEFrame,
        streamResponse,
    };
}
