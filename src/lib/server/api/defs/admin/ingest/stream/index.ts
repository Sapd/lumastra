// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/ingest/stream
 *
 * Admin-only SSE endpoint. Subscribes to the `pipeline:stage-state` pubsub
 * channel and emits stage-state-changed frames to connected admin clients.
 * Replay buffer is Valkey-backed so reconnects survive replica handoff.
 *
 * This def file provides auth wiring only; the SSE hub is initialized at
 * module level in the +server.ts file (so it survives across requests).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { subscribeToChannel } from '$lib/server/cache/valkey.js';
import {
    PIPELINE_STAGE_STATE_CHANNEL,
    type StageStateChangedEvent,
} from '$lib/server/cache/pipeline-pubsub.js';
import {
    createSseReplayHub,
    type SSEFrame,
    type Consumer,
} from '$lib/server/utils/sse-replay-hub.js';

export const hub = createSseReplayHub({
    replayKey: 'pipeline:sse:replay',
    replayIdKey: 'pipeline:sse:lastId',
    defaultFrameType: 'stage-state-changed',
    evictionLogPrefix: '[pipeline-sse]',
});

// Exported for unit tests.
export type { Consumer };
export const consumers = hub.consumers;

export function broadcastToConsumers(frame: SSEFrame): void {
    hub.broadcast(frame);
}

async function setupSubscription(): Promise<void> {
    try {
        await subscribeToChannel(PIPELINE_STAGE_STATE_CHANNEL, (msg) => {
            let evt: StageStateChangedEvent;
            try {
                const parsed: unknown = JSON.parse(msg);
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    return;
                }
                evt = parsed as StageStateChangedEvent;
            } catch {
                return;
            }

            void (async () => {
                const client = hub.getClient();
                let id = 0;
                if (client) {
                    try {
                        id = await hub.nextMonotonicId(client);
                    } catch {
                        // INCR failed — degrade to id=0; un-replayable.
                    }
                }
                const frame: SSEFrame = {
                    id,
                    type: 'stage-state-changed',
                    data: evt,
                };
                if (client && id > 0) {
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

void setupSubscription();

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    // Not currently mounted under /api/v1 (admin-only, dashboard-internal), so
    // this docs block is not picked up by the /api/v1 spec generator today —
    // kept anyway as the source of truth for this endpoint's contract, and so
    // it is ready for free the moment this route is ever exposed there.
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'Stream pipeline stage-state events (SSE)',
            stability: 'protocol',
            description:
                'Server-Sent Events stream of pipeline stage-state-changed frames for the admin ingest dashboard. Admin-only; not a general third-party contract.',
            auth: 'none',
            responses: {
                200: {
                    sse: true,
                    description: 'text/event-stream of stage-state-changed frames',
                },
                401: 'Authentication required',
                429: 'Per-user SSE connection limit reached — too many concurrent streams for this user',
                503: {
                    description: 'Process-wide SSE connection capacity reached — try again shortly',
                    code: 'stream_limit',
                },
            },
        },
    },
    raw: true,
    // P1: bound CONNECT churn — see the identical comment on defs/events/index.ts.
    rateLimit: {
        limit: 30,
        windowSec: 60,
        keyBy: (event) =>
            `sse-connect:admin-ingest-stream:${event.locals.principal?.username ?? event.locals.user?.username ?? 'anonymous'}`,
    },
    handlers: {
        GET: async (event, _ctx) => hub.streamResponse(event),
    },
});
