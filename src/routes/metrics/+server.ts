// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /metrics — Prometheus text exposition endpoint.
//
// Auth gate (dual — any one path suffices):
//
//   1. LUMASTRA_METRICS_PUBLIC=true → unauthenticated scraping (opt-in).
//   2. Authorization: Bearer <LUMASTRA_METRICS_BEARER_TOKEN> → static pre-shared
//      token; works before the DB is up (zero-DB bootstrap scrape path).
//   3. Authorization: Bearer <pat_…|svc_…> with `metrics:read` scope → standard
//      PAT or service token. Requires DB (token validated against the store).
//      Admin sessions that call this endpoint also satisfy this path.
//
// Paths 2 and 3 are independent: configuring a static token does NOT disable
// PAT/svc-token auth, and vice versa.
//
// `enforce` is imported lazily (dynamic import inside the handler) to avoid
// pulling the full api/mount.ts → catalog.service → plugin-context module
// graph into tests that only mock the static-token / public paths.

import crypto from 'node:crypto';
import type { RequestHandler } from './$types.js';
import { tasksRegistry } from '$lib/server/tasks/metrics.js';
import { LUMASTRA_METRICS_BEARER_TOKEN, LUMASTRA_METRICS_PUBLIC } from '$lib/server/config.js';

const BEARER_PREFIX = 'Bearer ';

/** Lazy import: scrapes that never reach here (401) and unit tests that mock only the registry stay light. */
async function renderMetrics(): Promise<string> {
    try {
        const { refreshQueueDepthMetrics } =
            await import('$lib/server/tasks/queue-depth-collector.js');
        await refreshQueueDepthMetrics();
    } catch {
        // queue depth is best-effort; the registry itself must still be served
    }
    return tasksRegistry.metrics();
}

/**
 * Constant-time equality that does not leak length through an early return.
 * Same pattern as webhook-dispatch.ts's secretMatches (security review
 * 2026-09-12, P2): `===` on a secret leaks timing information proportional
 * to the length of the matching prefix.
 */
function secretMatches(presented: string | null, expected: string): boolean {
    if (presented === null) return false;
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // timingSafeEqual REQUIRES equal lengths, so hash both first: the digests
    // are always 32 bytes and a length difference stops being a fast path.
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

export const GET: RequestHandler = async (event) => {
    // Path 1: fully public opt-in.
    if (LUMASTRA_METRICS_PUBLIC) {
        const body = await renderMetrics();
        return new Response(body, {
            headers: { 'Content-Type': tasksRegistry.contentType },
        });
    }

    const authHeader = event.request.headers.get('authorization');
    const presentedToken =
        authHeader && authHeader.startsWith(BEARER_PREFIX)
            ? authHeader.slice(BEARER_PREFIX.length)
            : null;

    // Path 2: static bearer token — zero-DB bootstrap scrape path.
    // Check first so that when LUMASTRA_METRICS_BEARER_TOKEN is set it always
    // works even if the PAT/svc-token subsystem is degraded.
    if (
        LUMASTRA_METRICS_BEARER_TOKEN &&
        secretMatches(presentedToken, LUMASTRA_METRICS_BEARER_TOKEN)
    ) {
        const body = await renderMetrics();
        return new Response(body, {
            headers: { 'Content-Type': tasksRegistry.contentType },
        });
    }

    // Path 3: PAT or service token with metrics:read scope.
    // enforce() checks event.locals.principal (set by resolveAuth) first, then
    // falls back to authenticate() + scopeGranted() for token-only callers.
    // Lazy import keeps the import graph minimal for the static-token and public
    // paths and avoids pulling the full task-registry module graph into tests.
    const { enforce } = await import('$lib/server/api/mount.js');
    const scopeResult = await enforce({ kind: 'scope', anyOf: ['metrics:read'] }, event);
    if (scopeResult === null) {
        const body = await renderMetrics();
        return new Response(body, {
            headers: { 'Content-Type': tasksRegistry.contentType },
        });
    }

    // Nothing matched — reject.
    return new Response('Unauthorized', { status: 401 });
};
