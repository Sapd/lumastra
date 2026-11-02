// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Valkey state for the admin attention payload: a short-TTL response cache, and
 * the presentation sidecar the read path needs now that derivation is a task.
 *
 * ── History (why the response cache exists) ────────────────────────────────────
 * The global bell polls `/api/admin/attention` on EVERY admin page every 60s, and
 * `getAttention()` USED TO run an 11-source signal fan-out (correlated NOT-EXISTS
 * scans, task_history aggregates, …) AND write-through the alert table on every
 * call. With several admin tabs open that fan-out was firing ~1/s on the shared web
 * DB pool, starving the playback path (admin dashboards share getDb() with
 * HLS/probe). Caching the computed JSON for a few seconds collapsed all concurrent
 * polls/tabs/replicas (Valkey is shared) to a single fan-out+write per TTL.
 *
 * ── Now ───────────────────────────────────────────────────────────────────────
 * The fan-out and the write-through moved to the `problem-derive` scheduled task
 * (60s, runOnStartup, maintenance class — so it runs once cluster-wide, on a
 * worker replica, never on web). `getAttention()` is a plain read of the persisted
 * table. The response cache stays: it still collapses concurrent polls across tabs
 * and replicas, and it still covers the three supplementary `includeOps` queries.
 * What it no longer guards is a fan-out — a cache miss now costs one SELECT.
 *
 * ack/snooze bust the cache so the badge updates promptly rather than waiting a
 * TTL. Because ack/snooze write the alert row directly, a bust now shows the
 * operator's action on the very next poll — it no longer has to wait for a derive.
 */

import { cacheDel, cacheGet, cacheSet } from '$lib/server/cache/valkey.js';
import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { AttentionRenderMap } from './types.js';

const logger = Logger.for('AttentionCache');

/** A few seconds of staleness is fine for dashboard counters; the bell polls at 60s. */
export const ATTENTION_CACHE_TTL_S = 20;

const cacheKey = (includeOps: boolean): string =>
    `v1:admin:attention:${includeOps ? 'ops' : 'base'}`;

/**
 * Cache-or-compute the attention payload under a single-flight lock. Collapses
 * concurrent misses (every open admin tab + the 60s bell poll, across replicas)
 * to a single signal fan-out + alert write-through per TTL instead of one per
 * caller. `compute` should return the serialized JSON body.
 */
export function getOrComputeAttention(
    includeOps: boolean,
    compute: () => Promise<string>,
): Promise<string> {
    return getOrComputeSingleFlight({
        cacheKey: cacheKey(includeOps),
        ttlSeconds: ATTENTION_CACHE_TTL_S,
        compute,
    });
}

/** Invalidate both variants — call after a mutation (ack/snooze) so the next poll recomputes. */
export function bustAttentionCache(): Promise<number> {
    return cacheDel([cacheKey(true), cacheKey(false)]);
}

// ──────────────────────────────────────────────────────────────────────────────
// Presentation sidecar
//
// `admin_attention_alerts` has no column for the typed `actions[]` or the
// glossary `term`, and this slice takes no migration. The derive cycle publishes
// them here; the read path overlays them onto the persisted rows. See the
// `AttentionRenderEntry` doc in types.ts for why this is not a schema change.
// ──────────────────────────────────────────────────────────────────────────────

const RENDER_KEY = 'v1:admin:attention:render';

/**
 * Comfortably longer than the 60s derive cadence, so the sidecar survives a long
 * run of missed cycles (a worker restart, a leader handoff) without the bell
 * losing its action buttons — but still finite, so it self-cleans if
 * `problem-derive` is paused or removed rather than pinning stale actions forever.
 */
export const ATTENTION_RENDER_TTL_S = 60 * 60;

/**
 * Publish the presentation sidecar for the cycle that just persisted.
 *
 * Best-effort by design: a failure here costs the bell its typed actions until
 * the next cycle, which is strictly better than failing a derive that has
 * already written the authoritative rows. Never throws.
 */
export async function publishAttentionRender(map: AttentionRenderMap): Promise<void> {
    try {
        await cacheSet(RENDER_KEY, JSON.stringify(map), ATTENTION_RENDER_TTL_S);
    } catch (err) {
        logger.warn('failed to publish attention render sidecar; actions degrade to investigate', {
            err: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Read the presentation sidecar. Returns an empty map when Valkey is unavailable
 * or the key has never been written — callers must treat that as "no overlay",
 * not as an error.
 */
export async function readAttentionRender(): Promise<AttentionRenderMap> {
    // No initialiser: the catch below returns, so control only reaches the
    // parse once `raw` has been assigned. Seeding it with null was dead
    // (no-useless-assignment) and implied a null could reach the parse.
    let raw: string | null;
    try {
        raw = await cacheGet(RENDER_KEY);
    } catch (err) {
        logger.warn('failed to read attention render sidecar; serving items without actions', {
            err: err instanceof Error ? err.message : String(err),
        });
        return {};
    }
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        // A non-object payload (corruption, a key collision) must degrade, not throw.
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed as AttentionRenderMap;
    } catch {
        return {};
    }
}
