// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
//
// GET /api/plugins/[featureId]/realtime
//
// Host SSE endpoint that bridges the `plugin:rt:<featureId>` Valkey pub/sub
// channel (written by `ctx.realtime.publish`) to dashboard clients. The static
// `realtime` segment takes precedence over the sibling `[...rest]` catch-all
// route, and reuses the same `[featureId]` param name to avoid SvelteKit's
// conflicting-param error.
//
// Auth: an authenticated viewer is required — this path is outside the
// hooks.server.ts /api/v1 + /api/admin backstops, so the gate is explicit here.
import type { RequestHandler } from './$types';
import { subscribeToChannel } from '$lib/server/cache/valkey.js';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import {
    acquireSseConnectGuard,
    startGuardedSseKeepalive,
} from '$lib/server/utils/sse-connection-guard.js';

/** Namespace for both the connect rate limit and the connection-slot ceiling (C12). */
const PLUGIN_REALTIME_SSE_NAMESPACE = 'plugin-realtime';

// C12 (2026-09-16 fix plan): total live plugin-realtime SSE connections held
// by THIS replica process, across every feature channel. Mirrors the
// sibling per-producer registries (`play-session-events.service.ts`,
// `watch-together.service.ts`) used for the same process-wide ceiling check.
let activePluginRealtimeConnections = 0;
function getActivePluginRealtimeSSECount(): number {
    return activePluginRealtimeConnections;
}

export const GET: RequestHandler = async ({ params, locals, request }) => {
    if (!locals.user) return new Response('Unauthorized', { status: 401 });

    // Validate the feature exists before opening a subscription. Without this,
    // each unique bogus featureId would spawn a dedicated GlideClient (inside
    // subscribeToChannel) that lives until the HTTP stream closes — a
    // connection-leak vector. This also matches the sibling [...rest]
    // dispatcher, which 404s unknown features.
    const feature = taskRegistry.getAllFeatures().find((f) => f.id === params.featureId);
    if (!feature) return new Response('Not found', { status: 404 });

    // C12: this route is a hand-written +server.ts (no `mount()`/def), so
    // there is no declarative `rateLimit` field to enforce the connect
    // throttle before this handler runs — hand-roll it here, same mechanism
    // the def-level field is built on, matching watch-together's own
    // hand-rolled connect limiter.
    const guard = await acquireSseConnectGuard({
        namespace: PLUGIN_REALTIME_SSE_NAMESPACE,
        userId: locals.user.username,
        getActiveConnectionCount: getActivePluginRealtimeSSECount,
        connectRateLimit: {
            key: `sse-connect:${PLUGIN_REALTIME_SSE_NAMESPACE}:${locals.user.username}`,
            limit: 30,
            windowSec: 60,
        },
    });
    if (!guard.ok) return guard.response;
    const { slot } = guard;

    const channel = `plugin:rt:${params.featureId}`;

    const enc = new TextEncoder();

    // Hoisted above start() (rather than declared inside it, as the original
    // version had it) so cancel() below can share the SAME cleanup()/state —
    // fix-round-1 review finding: this route wired teardown only through
    // request.signal's abort listener and onDead, unlike both sibling SSE
    // producers in this batch (events.ts, logs.ts), which also wire
    // ReadableStream.cancel(). A response-body cancel that does not also
    // abort the request signal (a real, observed client behaviour — the
    // body reader can be cancelled independently of the request) left
    // cleanup() unrun, and activePluginRealtimeConnections (a bare integer
    // with no TTL safety net, unlike the Valkey slot key) could only drift
    // upward, eventually pinning this producer at a permanent 503 for every
    // user until process restart.
    let registered = false;
    let closed = false;
    let stopKeepalive: () => void = () => {};
    let unsub: (() => void | Promise<void>) | null = null;

    const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (registered) {
            activePluginRealtimeConnections--;
            registered = false;
        }
        stopKeepalive();
        if (unsub) void unsub();
        slot.release();
    };

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            activePluginRealtimeConnections++;
            registered = true;
            const send = (line: string): void => {
                if (closed) return;
                try {
                    controller.enqueue(enc.encode(line));
                } catch {
                    /* controller already closed */
                }
            };

            const cleanupAndClose = (): void => {
                cleanup();
                try {
                    controller.close();
                } catch {
                    /* already closed */
                }
            };

            try {
                send(': connected\n\n');

                // `subscribeToChannel` is async and returns an unsubscribe handle
                // (or null when Valkey is unavailable). Await it so we hold the real
                // cleanup function rather than a Promise.
                unsub = await subscribeToChannel(channel, (raw: string) => {
                    try {
                        const evt = JSON.parse(raw) as { topic?: string; payload?: unknown };
                        if (typeof evt.topic !== 'string') return;
                        send(`event: ${evt.topic}\ndata: ${JSON.stringify(evt.payload)}\n\n`);
                    } catch {
                        /* ignore malformed frames */
                    }
                });

                // Start the keepalive AFTER subscribe so onDead can release the
                // subscription: if the client vanishes on an idle transport (e.g.
                // HTTP/3 idle timeout) the `abort` event may never fire, and without
                // onDead the Valkey subscription would leak until it did. Also
                // refreshes the connection slot's TTL on every tick.
                stopKeepalive = startGuardedSseKeepalive(controller, slot, cleanupAndClose);

                if (request.signal.aborted) {
                    cleanupAndClose();
                    return;
                }
                request.signal.addEventListener('abort', cleanupAndClose);
            } catch (err) {
                // A known prior defect (fix round 1, finding 2): the slot
                // leaks if stream setup throws between registration and the
                // stream being handed back to the client. Release explicitly
                // on every setup failure — there is no cancel()/onDead for a
                // throw inside start().
                cleanup();
                throw err;
            }
        },
        cancel() {
            // The runtime calls this on a response-body cancel, independent
            // of whether request.signal ever aborts — see the docstring
            // above the hoisted state for why that distinction matters.
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
};
