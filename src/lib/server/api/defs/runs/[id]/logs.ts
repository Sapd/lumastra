// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/runs/{id}/logs
 *
 * SSE stream of log entries for a single run.
 * Replays buffered entries (Last-Event-ID reconnect support) then tails live.
 *
 * Class R endpoint (SSE stream):
 *   - Tier-1 errors (before stream opens): problem+json
 *   - Tier-2 errors (mid-stream): `event: error` frame before close
 *
 * Requires `tasks:admin` scope. The raw:true flag tells mount() this is a
 * Class R endpoint.
 *
 * NOT `runs:read`: that scope is granted to every session (`buildPrincipal`
 * hands every non-admin session `['read','write']`, and `expandScopes()`
 * expands the coarse `read` alias to include `runs:read`), so it authorizes
 * any logged-in user and any `read`-scoped PAT — see the docstring on the
 * sibling `diagnostics.ts` def, which draws the same line for the same
 * reason. Log entries are emitted verbatim (`meta` as `extra`, including
 * debug-level output) and can carry the same class of internal detail
 * (filesystem paths, task input) diagnostics.ts protects, so this endpoint
 * needs the same operational-reads gate — `tasks:admin`, consistent with
 * 2026-09-12's C16 move of other operational reads. The run LIST endpoint
 * (`defs/runs/index.ts`) is unaffected and stays on `runs:read`.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { logBuffer, type LogEntry } from '$lib/server/tasks/log-buffer.js';
import {
    acquireSseConnectGuard,
    startGuardedSseKeepalive,
} from '$lib/server/utils/sse-connection-guard.js';

const encoder = new TextEncoder();

/** Namespace for both the connect rate limit and the connection-slot ceiling (C18). */
const RUNS_LOGS_SSE_NAMESPACE = 'runs-logs';

// C18 (2026-09-16 fix plan): total live run-log SSE connections held by THIS
// replica process, across every run. There is no single Set/consumer
// registry to read directly here — each connection tracks only its own
// cleanup closure — so this module tracks a plain counter instead, mirroring
// the sibling per-producer registries (`play-session-events.service.ts`,
// `watch-together.service.ts`) used for the SAME process-wide ceiling check.
let activeRunLogConnections = 0;
function getActiveRunLogSSECount(): number {
    return activeRunLogConnections;
}

function sseIdFor(entry: LogEntry): number {
    return entry.seq ?? entry.ts;
}

function toWireEntry(entry: LogEntry, id: number): Record<string, unknown> {
    return {
        ts: entry.ts,
        seq: entry.seq ?? id,
        level: entry.level,
        msg: entry.message,
        ...(entry.meta ? { extra: entry.meta } : {}),
    };
}

function encodeSSE(entry: LogEntry, id: number): Uint8Array {
    return encoder.encode(`id: ${id}\ndata: ${JSON.stringify(toWireEntry(entry, id))}\n\n`);
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Runs'],
            summary: 'Stream run logs (SSE)',
            stability: 'beta',
            auth: 'bearer',
            description:
                "Opens an SSE stream for a task run's log output. " +
                'Replays buffered log entries since `Last-Event-ID`, then tails live output. ' +
                'Stream closes when the run finishes. Requires `tasks:admin` scope.',
            responses: {
                200: {
                    sse: true,
                    description: 'Log SSE stream',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Run not found',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    raw: true,
    // C18 (2026-09-16 fix plan): bound CONNECT churn, same pair
    // `admin/ingest/stream/index.ts` (an equally admin-only SSE endpoint)
    // already carries — this def has only a GET handler, so the declarative
    // `rateLimit` field applies cleanly and is enforced by mount() before the
    // handler ever runs.
    rateLimit: {
        limit: 30,
        windowSec: 60,
        keyBy: (event) =>
            `sse-connect:${RUNS_LOGS_SSE_NAMESPACE}:${event.locals.principal?.username ?? event.locals.user?.username ?? 'anonymous'}`,
    },
    handlers: {
        GET: async (event) => {
            const { id: runId } = event.params as { id: string };

            const sinceParam =
                event.url.searchParams.get('since') ??
                event.request.headers.get('last-event-id') ??
                '0';
            const sinceNum = Number(sinceParam);
            const sinceId = Number.isFinite(sinceNum) && sinceNum >= 0 ? Math.floor(sinceNum) : 0;

            // C18: process-wide + per-user SSE connection ceilings, checked
            // right before the connection is actually registered. `identity`
            // falls back to 'anonymous' only defensively — the scope auth
            // above already guarantees a principal exists by the time this
            // handler runs (mirrors `resolveConnectionUserId` in
            // sse-replay-hub.ts).
            const identity =
                event.locals.principal?.username ?? event.locals.user?.username ?? 'anonymous';
            const guard = await acquireSseConnectGuard({
                namespace: RUNS_LOGS_SSE_NAMESPACE,
                userId: identity,
                getActiveConnectionCount: getActiveRunLogSSECount,
            });
            if (!guard.ok) return guard.response;
            const { slot } = guard;

            let stopHeartbeat: () => void = () => {};
            let unsub: (() => void | Promise<void>) | null = null;
            let registered = false;
            let released = false;

            function cleanup(): void {
                if (released) return;
                released = true;
                if (registered) {
                    activeRunLogConnections--;
                    registered = false;
                }
                stopHeartbeat();
                if (unsub) {
                    void unsub();
                    unsub = null;
                }
                slot.release();
            }

            const stream = new ReadableStream<Uint8Array>({
                async start(controller) {
                    activeRunLogConnections++;
                    registered = true;
                    try {
                        controller.enqueue(encoder.encode(`retry: 3000\n: connected\n\n`));

                        const buffered = await logBuffer.readRecent(runId, 1000);
                        let lastId = sinceId;
                        for (const entry of buffered) {
                            const id = sseIdFor(entry);
                            if (id > lastId) {
                                controller.enqueue(encodeSSE(entry, id));
                                lastId = id;
                            }
                        }

                        unsub = await logBuffer.subscribe(runId, (entry) => {
                            const id = sseIdFor(entry);
                            if (id > lastId) {
                                try {
                                    controller.enqueue(encodeSSE(entry, id));
                                } catch {
                                    // Controller may be closed on client disconnect.
                                }
                                lastId = id;
                            }
                        });

                        if (event.request.signal.aborted) {
                            cleanup();
                            try {
                                controller.close();
                            } catch {
                                // Already closed.
                            }
                            return;
                        }

                        // Keepalive on the shared cadence, refreshing the
                        // connection slot's TTL on every tick and releasing it
                        // on a detected-dead controller.
                        stopHeartbeat = startGuardedSseKeepalive(controller, slot, cleanup);

                        event.request.signal.addEventListener('abort', () => {
                            cleanup();
                            try {
                                controller.close();
                            } catch {
                                // Already closed.
                            }
                        });
                    } catch (err) {
                        // A known prior defect (fix round 1, finding 2): the
                        // slot leaks if stream setup throws between
                        // registration and the stream being handed back to
                        // the client. Release explicitly on every setup
                        // failure — cancel()/onDead never fire for a throw
                        // inside start().
                        cleanup();
                        throw err;
                    }
                },
                cancel() {
                    cleanup();
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
