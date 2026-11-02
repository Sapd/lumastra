// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/admin/ingest/stream
//
// Admin-only SSE endpoint. Subscribes to the `pipeline:stage-state` pubsub
// channel and emits stage-state-changed frames to connected admin clients.
// Replay buffer is Valkey-backed so reconnects survive replica handoff:
//   - `INCR pipeline:sse:lastId` produces a cluster-wide monotonic id.
//   - LPUSH/LTRIM on `pipeline:sse:replay` stores the last 200 frames.
// On reconnect with `Last-Event-ID: N` we scan the LIST for ids > N
// and replay them, regardless of which replica handled them originally.
// Auth: admin session only — no PAT/scope-based auth.
//
// The Valkey-backed replay/broadcast fabric lives in sse-replay-hub.ts; this
// module only wires the pipeline pubsub subscription and admin auth onto it.
// Hub initialization and subscription are done in the def file.

import { mount } from '$lib/server/api/mount.js';
import {
    def,
    consumers,
    broadcastToConsumers,
} from '$lib/server/api/defs/admin/ingest/stream/index.js';
import type { Consumer } from '$lib/server/api/defs/admin/ingest/stream/index.js';

// Re-export for unit tests
export type { Consumer };
export const _consumersForTest = consumers;
export function _broadcastToConsumersForTest(
    frame: Parameters<typeof broadcastToConsumers>[0],
): void {
    broadcastToConsumers(frame);
}

const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = mount(def, {
    surface: 'internal',
});
export { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD };
