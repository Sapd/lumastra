// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// valkey-types.ts — shared primitives for the task system's Valkey integration.
//
// Single home for the three utilities that were copy-pasted across every
// task-system module:
//
//   ValkeyLike   — minimal interface satisfied by GlideClient (and mocks).
//   errMessage   — safe error-to-string for log fields.
//   nowIso       — current timestamp as ISO 8601 string.
//   requireClient — throw-on-null accessor for the live Glide client.
//
// Import rules:
//   ValkeyLike   → `import type { ValkeyLike } from './valkey-types.js';`
//   The rest     → `import { errMessage, nowIso, requireClient } from './valkey-types.js';`

import { getCoordinationClient, publishMessage } from '$lib/server/cache/valkey.js';

// ── ValkeyLike ────────────────────────────────────────────────────────────────

/**
 * Minimal interface that every Valkey client used by the task system must
 * satisfy. GlideClient is a structural superset of this interface, so a
 * `GlideClient` instance is always assignable to `ValkeyLike` without casting.
 */
export interface ValkeyLike {
    customCommand: (cmd: string[]) => Promise<unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract a human-readable message from an unknown thrown value.
 * Safe to call in every `catch` block without narrowing.
 */
export function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Current wall-clock time as an ISO 8601 string, used for timestamp fields
 * in task_history and Valkey run hashes.
 */
export function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Return the live Glide client, or throw if Valkey is not yet connected.
 * Used as the default `getClient` in modules that need a client but don't
 * accept an injected one (e.g. state-machine, orchestrator, runner).
 */
export function requireClient(): ValkeyLike {
    // The task system's keyed state (task:run/stage/identity, lock:orch, circuit,
    // resource-budget, hard-kill on BullMQ keys) is COORDINATION state and must
    // live on the noeviction instance. Collapses to the cache client in
    // single-instance mode, so this is safe there too.
    const c = getCoordinationClient();
    if (!c) throw new Error('Valkey coordination client is not connected');
    return c as unknown as ValkeyLike;
}

/** Valkey pub/sub channel for self-observability meta events (admin SSE bridge). */
export const TASK_META_CHANNEL = 'task:events:meta';

/**
 * Best-effort PUBLISH of a meta event to `task:events:meta`. Shared by the
 * orchestrator + runner so the envelope shape `{ type, data, ts }` stays
 * consistent in ONE place. Failures are swallowed — meta events must never
 * block the terminal write that already landed.
 */
export async function emitMetaEvent(type: string, data: unknown): Promise<void> {
    try {
        // Pub/sub rides the CACHE client (eviction-immune; the admin SSE bridge
        // subscribes there) — NOT the coordination client `requireClient` now
        // returns, or a two-instance split would strand subscribers.
        await publishMessage(TASK_META_CHANNEL, JSON.stringify({ type, data, ts: nowIso() }));
    } catch {
        // Self-observability is best-effort.
    }
}
