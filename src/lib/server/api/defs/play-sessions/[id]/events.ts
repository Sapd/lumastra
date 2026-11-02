// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/play-sessions/[id]/events.ts — GET /play-sessions/{id}/events
 *
 * Server-Sent Events (SSE) stream for a play session. Clients subscribe to
 * receive server-pushed control events (maintenance notices, kill signals, etc.)
 * while a session is active.
 *
 * Auth: {kind:'user'} — session ownership verified inside handler.
 *
 * raw: true — success response is text/event-stream, not JSON. Auth/ownership
 * failures before the stream opens still use problem+json.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    acquireSseConnectGuard,
    startGuardedSseKeepalive,
} from '$lib/server/utils/sse-connection-guard.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getSessionById } from '$lib/server/database/queries/play-sessions.queries.js';
import {
    sessionControllers,
    getActivePlaySessionSSECount,
    deliverMaintenanceOnConnect,
} from '$lib/server/services/play-session-events.service.js';

/** Namespace for both the connect rate limit and the connection-slot ceiling (C11). */
const PLAY_SESSIONS_SSE_NAMESPACE = 'play-sessions';

const logger = Logger.for('PlaySessionSSEDef');
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const PlaySessionEventsParams = z.object({
    id: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    // Class R: success body is text/event-stream; pre-stream failures are problem+json.
    raw: true,

    // C11 (2026-09-16 fix plan): bound CONNECT churn. This def has only a GET
    // handler (unlike watch-together's events def, which also carries a
    // high-frequency POST on the same def and so hand-rolls its own connect
    // limiter) — the declarative `rateLimit` field applies cleanly here and
    // is enforced by mount() on BOTH the internal and /api/v1 surfaces before
    // this handler ever runs.
    rateLimit: {
        limit: 30,
        windowSec: 60,
        keyBy: (event) =>
            `sse-connect:${PLAY_SESSIONS_SSE_NAMESPACE}:${event.locals.principal?.username ?? event.locals.user?.username ?? 'anonymous'}`,
    },

    request: {
        params: PlaySessionEventsParams,
    },

    handlers: {
        /**
         * GET /api/play-sessions/{id}/events
         *
         * Opens an SSE connection for the given play session. Verifies session
         * ownership before streaming. Returns text/event-stream with keepalive
         * comments on the shared SSE cadence (SSE_KEEPALIVE_MS) and replays any
         * active maintenance notice on connect.
         */
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const sessionId = ctx.input?.params?.id ?? event.params.id;
            if (!sessionId) return ApiProblem.notFound('Session not found');

            const session = await getSessionById(sql, sessionId);
            if (!session) return ApiProblem.notFound('Session not found');
            if (session.user_id !== userId) return ApiProblem.notFound('Session not found');

            // C11 (2026-09-16 fix plan): process-wide + per-user SSE connection
            // ceilings, checked as late as the cheap validation above allows —
            // right before the connection is actually registered — mirroring
            // watch-together's reference implementation.
            const guard = await acquireSseConnectGuard({
                namespace: PLAY_SESSIONS_SSE_NAMESPACE,
                userId,
                getActiveConnectionCount: getActivePlaySessionSSECount,
            });
            if (!guard.ok) return guard.response;
            const { slot } = guard;

            let controller: ReadableStreamDefaultController<Uint8Array>;
            let stopKeepalive: () => void = () => {};
            let removed = false;

            // Stop the keepalive, drop this controller from the broadcast set,
            // and release the connection slot. Idempotent (guarded by
            // `removed`) — called on stream cancel, on setup failure inside
            // start(), AND (via onDead) when a keepalive write fails because
            // the client vanished without a cancel, so none of those paths can
            // double-release or leave the slot pinned.
            const removeController = (): void => {
                if (removed) return;
                removed = true;
                stopKeepalive();
                sessionControllers.get(sessionId)?.delete(controller);
                if (sessionControllers.get(sessionId)?.size === 0) {
                    sessionControllers.delete(sessionId);
                }
                slot.release();
            };

            const stream = new ReadableStream<Uint8Array>({
                start(c) {
                    try {
                        controller = c;

                        // Register this controller under the session.
                        if (!sessionControllers.has(sessionId)) {
                            sessionControllers.set(sessionId, new Set());
                        }
                        sessionControllers.get(sessionId)!.add(controller);

                        // Send initial connected event.
                        controller.enqueue(
                            encoder.encode(`data: ${JSON.stringify({ type: 'connected' })}\n\n`),
                        );

                        // Replay any active maintenance notice so reconnecting clients
                        // don't miss a notice broadcast while they were disconnected.
                        void deliverMaintenanceOnConnect(controller).catch(() => {
                            // Non-fatal — maintenance replay is best-effort.
                        });

                        // Keepalive comment (shared interval — see SSE_KEEPALIVE_MS),
                        // refreshing the connection slot's TTL on every tick and
                        // releasing it on a detected-dead controller.
                        stopKeepalive = startGuardedSseKeepalive(
                            controller,
                            slot,
                            removeController,
                        );
                    } catch (err) {
                        // A known prior defect (fix round 1, finding 2): the slot
                        // leaks if stream setup throws between registration and
                        // the stream actually being handed back to the client.
                        // Release explicitly on every setup failure rather than
                        // relying on cancel()/onDead, neither of which fires for
                        // a throw inside start().
                        logger.warn(
                            'SSE stream setup failed',
                            { session_id: sessionId },
                            err as Error,
                        );
                        removeController();
                        throw err;
                    }
                },

                cancel() {
                    removeController();
                    logger.debug('SSE client disconnected', { session_id: sessionId });
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
        },
    },
});
