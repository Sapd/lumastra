// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared SSE connect-guard scaffolding (2026-09-16 fix plan, Batch A / Task 7,
 * C11+C12+C18).
 *
 * `watch-together/[code]/events.ts` is the reference implementation for the
 * process-wide + per-user SSE connection ceiling (delta invariant #8): check
 * the process-wide cap, then reserve a per-user slot via
 * `acquireUserConnectionSlot()`, then keep the slot's Valkey TTL alive from
 * the connection's own keepalive tick, and release it on EVERY exit path
 * (cancel, keepalive-detected-dead, and any throw between reserving the slot
 * and the stream actually being handed back to the client).
 *
 * Three more SSE producers needed the exact same scaffolding
 * (`play-sessions/[id]/events`, `/api/plugins/[featureId]/realtime`,
 * `defs/runs/[id]/logs`) — this module factors it into one shared helper so
 * each of those three add ONE call instead of re-deriving the
 * check-cap/reserve-slot/wire-keepalive/release-on-every-exit sequence from
 * scratch (and risking a copy that misses one of the exit paths, which is
 * exactly how the prior round's `sessionControllers` gap and the admin
 * ingest/runs-stream duplication happened).
 *
 * `watch-together` itself is left as-is: it already carries both guards, its
 * GET handler shares a def with a high-frequency POST (so it hand-rolls the
 * connect rate limit instead of the def-level `rateLimit` field — see its
 * own comment), and refactoring an already-correct, already-tested
 * implementation for symmetry alone would be pure regression risk with no
 * security benefit. New producers reuse this helper; the reference keeps its
 * own copy of the same shape.
 */

import { config } from '$lib/server/config.js';
import { problem, ApiProblem } from '$lib/server/api/problem.js';
import {
    acquireUserConnectionSlot,
    type ConnectionSlot,
} from '$lib/server/utils/sse-connection-ceiling.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { startSseKeepalive, type SseKeepaliveOptions } from '$lib/server/utils/sse.js';

export interface SseConnectGuardConfig {
    /**
     * Namespace both the per-user connection-slot ceiling (`sse:conns:
     * {namespace}:{userId}`) and — when `connectRateLimit` is supplied — the
     * connect rate-limit key are scoped under. Must be unique per SSE
     * producer so two unrelated producers never share one budget.
     */
    namespace: string;
    /** Identity the per-user ceiling is keyed on (username, matching every sibling producer). */
    userId: string;
    /** Per-user connection ceiling. Defaults to `config.SSE_MAX_CONNECTIONS_PER_USER`. */
    maxPerUser?: number;
    /** Process-wide (this producer's own registry) connection ceiling. Defaults to `config.SSE_MAX_CONNECTIONS`. */
    maxProcessWide?: number;
    /** Returns the number of connections THIS producer currently holds (its own registry — never a cross-producer total). */
    getActiveConnectionCount: () => number;
    /**
     * Supply this when the caller has no def-level `EndpointDef.rateLimit`
     * already enforcing a connect throttle before the handler runs (i.e. a
     * hand-written `+server.ts`, or a def whose GET shares a method with a
     * high-frequency POST). A def-based producer with its own `rateLimit`
     * field (mount.ts enforces it before the handler runs) should omit this.
     */
    connectRateLimit?: { key: string; limit: number; windowSec: number };
}

export type SseConnectGuardResult =
    { ok: true; slot: ConnectionSlot } | { ok: false; response: Response };

/**
 * Enforce the connect rate limit (if supplied), then the process-wide cap,
 * then reserve a per-user connection slot — in that order, cheapest checks
 * first, exactly as `watch-together`'s handler and `sse-replay-hub.ts`'s
 * `streamResponse()` already do. Returns the reserved slot on success, or the
 * problem+json `Response` to return verbatim on refusal (429 connect-rate or
 * per-user-cap, 503 process-wide cap).
 */
export async function acquireSseConnectGuard(
    cfg: SseConnectGuardConfig,
): Promise<SseConnectGuardResult> {
    if (cfg.connectRateLimit) {
        const { key, limit, windowSec } = cfg.connectRateLimit;
        const rl = await checkRateLimit(key, limit, windowSec);
        if (!rl.allowed) {
            return {
                ok: false,
                response: ApiProblem.rateLimited(
                    Math.max(0, Math.ceil(rl.resetAt - Date.now() / 1000)),
                ),
            };
        }
    }

    const maxPerUser = cfg.maxPerUser ?? config.SSE_MAX_CONNECTIONS_PER_USER;
    const maxProcessWide = cfg.maxProcessWide ?? config.SSE_MAX_CONNECTIONS;

    if (cfg.getActiveConnectionCount() >= maxProcessWide) {
        return {
            ok: false,
            response: problem('stream_limit', {
                error: 'SSE connection capacity reached — try again shortly',
            }),
        };
    }

    const slot = await acquireUserConnectionSlot(cfg.namespace, cfg.userId, maxPerUser);
    if (!slot.ok) {
        return {
            ok: false,
            response: problem('rate_limited', {
                error: `Too many concurrent SSE connections for this user (max ${maxPerUser})`,
            }),
        };
    }

    return { ok: true, slot };
}

/**
 * Wire a connection slot into `startSseKeepalive`: every tick refreshes the
 * slot's Valkey TTL (`ConnectionSlot.refresh`) so a connection that outlives
 * `SSE_CONN_TTL_SEC` doesn't have its slot key expire out from under it, and
 * a detected-dead controller runs `cleanup` (which must call
 * `slot.release()` — see each producer's own `cleanup`/`removeController`).
 * Matches the wiring `watch-together`'s reference implementation hand-rolls.
 */
export function startGuardedSseKeepalive(
    controller: ReadableStreamDefaultController<Uint8Array>,
    slot: ConnectionSlot,
    cleanup: () => void,
    opts: SseKeepaliveOptions = {},
): () => void {
    return startSseKeepalive(controller, {
        intervalMs: opts.intervalMs,
        onTick: () => {
            slot.refresh();
            opts.onTick?.();
        },
        onDead: () => {
            cleanup();
            opts.onDead?.();
        },
    });
}
