// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Problem Derivation — the attention board's only scheduled writer.
 *
 * Every 60s (and on startup) this runs the existing `deriveAttention` →
 * `reconcile` → upsert/resolve path and publishes the render sidecar. Nothing
 * about WHAT is derived changes here; only WHEN.
 *
 * ── Why this task exists ──────────────────────────────────────────────────────
 * Derivation used to run on the READ path. `getAttention()` performed the full
 * signal fan-out AND wrote through to `admin_attention_alerts` on every call, and
 * it is called from the admin status payload — which the global notification bell
 * polls on EVERY admin page, every 60s. With a few admin tabs open that fan-out
 * fired roughly once a second on the shared web DB pool, the same pool that serves
 * HLS and probe; the mitigation was a 20s Valkey single-flight cache whose comment
 * (`attention-cache.ts`) documents the starvation it was papering over.
 *
 * That was the hard ceiling on producer count: each new producer made an operator
 * page load slower and added write amplification on the playback pool. Moving the
 * cycle here removes the ceiling. Reads are now a plain SELECT. This mirrors the
 * health-invariants task, which got the same shape right for `health_check_findings`.
 *
 * ── Leader gating ─────────────────────────────────────────────────────────────
 * This task WRITES, so it must run once cluster-wide. It is gated exactly the way
 * every other cluster-singleton builtin is (stage-sweep, health-invariants,
 * artwork-reaper) rather than by a bespoke lock:
 *
 *   - `scope: 'global'` + a constant `identityFor` — one identity, so the
 *     orchestrator's SETNX identity dedup collapses concurrent enqueues;
 *   - the scheduler's cluster-wide fire claim, so one tick produces one run;
 *   - `resourceClass: 'maintenance'` — the maintenance lane, never the ingest
 *     fast lane and never contending with playback;
 *   - `quotas: { maxConcurrent: 1 }` — two cycles must never interleave their
 *     reconcile against the same rows;
 *   - leader election is `WORKER_MODE`-gated in the orchestrator, so a web replica
 *     never leads and therefore never derives. Web only ever reads.
 *
 * ── Self-reference ────────────────────────────────────────────────────────────
 * `problem-derive` is itself a scheduled task, so the overdue-schedule and
 * failed-run-spike sources can raise alerts ABOUT it. That is intentional for a
 * degraded cycle (slow, erroring) but cannot catch a totally dead one — nothing
 * derives, so nothing reports. The liveness bridge (`tasks:` and the other
 * domain prefixes it emits) covers that case from the scheduler/worker
 * heartbeats instead, which is where it belongs.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { runAttentionDerivation } from '$lib/server/services/attention/attention-service.js';

/**
 * The admin status store polls every 30s (`admin-status.store.svelte.ts`), so at
 * 60s a poll sees at most one cycle of staleness. Faster is not free — the fan-out
 * this replaced is exactly what made the read path expensive — and slower would
 * make an operator's remediation take more than one poll to disappear from the
 * board. The 20s response cache in front of the read path already contributed a
 * comparable delay before this change, so the net regression is small.
 */
const PROBLEM_DERIVE_SCHEDULE_EVERY = '60s';

const inputSchema = z.object({}).passthrough();

interface ProblemDeriveResult {
    /** Alerts written (inserted or refreshed) this cycle. */
    upserted: number;
    /** Alerts moved to resolved history this cycle. */
    resolved: number;
    /** Board verdict as of this cycle. */
    verdict: string;
    /** Unacked, unsnoozed item count — what the bell badge shows. */
    unreadCount: number;
    /**
     * How many id namespaces could not be read this cycle. Non-zero means part of
     * the board is last-known-good rather than freshly observed; those alerts were
     * carried forward instead of resolved ("couldn't read" ≠ "gone").
     */
    protectedNamespaces: number;
}

export const problemDeriveTask = defineTask<Record<string, unknown>, ProblemDeriveResult>({
    id: 'problem-derive',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'maintenance',
    name: 'Attention Board Derivation',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    schedule: {
        every: PROBLEM_DERIVE_SCHEDULE_EVERY,
        // Load-bearing. Reads project the persisted table, which the PREVIOUS
        // process populated, so a restart never shows an empty board — but only
        // because the first cycle after boot lands within seconds rather than
        // waiting out a full interval. Without this a fresh install would read
        // "healthy" for a whole cycle before anything had ever been derived.
        runOnStartup: true,
    },

    identityFor: () => 'global',
    scope: 'global',
    resourceClass: 'maintenance',
    // Two cycles reconciling the same rows would race first_seen and the ack
    // watermarks against each other.
    quotas: { maxConcurrent: 1 },

    inputSchema,

    // Generous against a slow signal source but well inside the point where
    // cycles would pile up: individual sources already degrade into
    // `failedPrefixes` rather than hanging the cycle.
    timeout: { hard: '2m', soft: '90s' },

    async execute(ctx) {
        const outcome = await runAttentionDerivation(ctx.sql);

        // Prefixes that are only warming (cold right after boot) are expected;
        // warn only when a source is unreadable for some other reason.
        const warming = new Set(outcome.warmingPrefixes ?? []);
        const unreadable = outcome.protectedPrefixes.filter((p) => !warming.has(p));
        if (unreadable.length > 0) {
            ctx.logger.warn('attention derive completed with unreadable sources', {
                protectedPrefixes: outcome.protectedPrefixes,
            });
        } else if (outcome.protectedPrefixes.length > 0) {
            ctx.logger.debug('attention derive completed with warming sources', {
                protectedPrefixes: outcome.protectedPrefixes,
            });
        }

        const result: ProblemDeriveResult = {
            upserted: outcome.upserted,
            resolved: outcome.resolved,
            verdict: outcome.verdict,
            unreadCount: outcome.unreadCount,
            protectedNamespaces: outcome.protectedPrefixes.length,
        };

        return {
            success: true,
            itemsProcessed: outcome.upserted + outcome.resolved,
            result,
        };
    },
});

registry.registerTask(problemDeriveTask);
