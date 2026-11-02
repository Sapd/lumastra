// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Preview Admission Control
 *
 * A preview session must NEVER be able to bring the server down. This module is
 * the gate every new (non-reused) preview request passes through before a
 * transcode job is created. It enforces two independent, coordinated backstops:
 *
 *  1. Global budget — a hard ceiling on concurrent preview transcodes across all
 *     replicas (counted from the shared Valkey session keyspace). Responds
 *     instantly; stops previews from monopolizing encode capacity.
 *
 *  2. Load circuit breaker — when the box is actually under pressure (1-min load
 *     average per core over a threshold), previews are auto-disabled for a short
 *     cool-off window. This catches load from ANY source (real playback,
 *     background tasks, a noisy neighbour), not just previews.
 *
 * Admins can also disable previews manually (a durable Valkey flag). Reused
 * previews (see findReusablePreview) intentionally bypass this gate — handing
 * back an already-running job adds no meaningful load and preserves UX.
 *
 * All checks fail OPEN on infrastructure errors (Valkey down): a preview feature
 * must not hard-fail because coordination is unavailable — the per-replica
 * global transcode cap in FFmpegTranscodeService remains as a final backstop.
 */

import * as os from 'node:os';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { cacheGet, cacheSet, cacheDel, getKeysByPattern } from '$lib/server/cache/valkey.js';
import { getPreviewCacheStore } from '$lib/server/services/preview-cache.store.js';
import type { PreviewCacheStats } from '$lib/server/services/preview-cache.store.js';

const logger = Logger.for('PreviewAdmission');

// Valkey keys.
const AUTO_DISABLE_KEY = 'preview:autodisabled'; // set by the load breaker (TTL)
const ADMIN_DISABLE_KEY = 'preview:admin-disabled'; // set by an operator (durable)
// Must match REDIS_SESSION_PREFIX in preview-session.service.ts.
const SESSION_KEY_PATTERN = 'preview:session:v1:*';

// In-flight preview reservations on THIS replica (claimed at admission, released
// when createPreview finishes). This is the fix for the burst race: the Valkey
// session-key scan only counts ESTABLISHED sessions (the key is written at the
// very end of createPreview, after the expensive ffprobe + FFmpeg spawn), so N
// requests arriving inside that window would all see the same stale low count and
// all spawn. Counting reservations alongside the scan closes that window, and the
// synchronous claim below (no await between read and increment) serializes
// concurrent requests within the single-threaded event loop.
let inFlightReservations = 0;

/** Test-only: reset the in-flight reservation counter between cases. */
export function _resetPreviewReservationsForTest(): void {
    inFlightReservations = 0;
}

export interface PreviewAdmissionDecision {
    admit: boolean;
    /** HTTP status to return when !admit. */
    status?: number;
    /** Machine-readable reason (also used for logging/metrics). */
    reason?: 'admin_disabled' | 'load_shed' | 'global_budget';
    /** Human-readable message safe to surface to the client. */
    message?: string;
    /**
     * Release the reservation claimed by an admitted decision. MUST be called
     * exactly once (in a `finally`) after the preview create attempt finishes —
     * success or failure. Idempotent and a no-op on rejected decisions.
     */
    release?: () => void;
}

export interface PreviewAdmissionStatus {
    /** True when new previews are currently being refused for any reason. */
    disabled: boolean;
    reason: 'admin_disabled' | 'load_shed' | 'global_budget' | null;
    /** 1-minute load average divided by CPU core count. */
    loadRatio: number;
    loadShedRatio: number;
    /** Approximate concurrent preview count (bounded scan). */
    activeCount: number;
    maxGlobal: number;
    /** Whether an operator has manually disabled previews. */
    adminDisabled: boolean;
    /** Whether the load breaker is currently tripped. */
    autoDisabled: boolean;
    /** Preview artifact cache snapshot (entries, byte budget, hit/miss/eviction counts). */
    cache: PreviewCacheStats;
}

/** 1-minute load average per CPU core. Returns 0 if unavailable (e.g. Windows). */
export function getSystemLoadRatio(): number {
    try {
        const cores = Math.max(1, os.cpus().length);
        const load1 = os.loadavg()[0] ?? 0;
        // os.loadavg() returns [0,0,0] on platforms without load reporting.
        if (load1 <= 0) return 0;
        return load1 / cores;
    } catch {
        return 0;
    }
}

/**
 * Cross-category emergency load-shed for REAL (non-preview) transcodes. The per-category
 * transcode caps are independent and additive with no shared ceiling, and only the
 * preview breaker watches system load — so a saturating mix of video + music + livetv is
 * invisible to any breaker. This is the shared last-resort gate video and music admission
 * consult before spawning: when the 1-min load-average-per-core exceeds
 * LUMASTRA_TRANSCODE_LOAD_SHED_RATIO, a NEW real transcode is refused so the box sheds
 * load before it collapses (which would fail EVERY in-flight stream). Unlike previews,
 * this DOES affect playback, so it defaults to 0 (disabled) — an operator opts in with a
 * threshold set above their measured normal peak. Returns { shed, loadRatio, threshold }.
 */
export function checkRealTranscodeLoadShed(): {
    shed: boolean;
    loadRatio: number;
    threshold: number;
} {
    const threshold = config.LUMASTRA_TRANSCODE_LOAD_SHED_RATIO;
    if (threshold <= 0) return { shed: false, loadRatio: 0, threshold };
    const loadRatio = getSystemLoadRatio();
    return { shed: loadRatio > threshold, loadRatio, threshold };
}

/**
 * Count concurrent previews across replicas via a bounded scan of the shared
 * session keyspace. Bounded to `maxGlobal + 1` so the cost stays O(cap) — we
 * only need to know whether the ceiling is reached, not the exact total.
 */
async function countActivePreviews(maxGlobal: number): Promise<number> {
    try {
        const keys = await getKeysByPattern(SESSION_KEY_PATTERN, maxGlobal + 1);
        return keys.length;
    } catch {
        // Valkey unavailable — fail open (return 0). The per-replica FFmpeg
        // global cap still protects the box.
        return -1;
    }
}

/** True when an operator has manually disabled previews. */
async function isAdminDisabled(): Promise<boolean> {
    try {
        return (await cacheGet(ADMIN_DISABLE_KEY)) !== null;
    } catch {
        return false;
    }
}

/** True when the load breaker is currently tripped (cool-off flag present). */
async function isAutoDisabled(): Promise<boolean> {
    try {
        return (await cacheGet(AUTO_DISABLE_KEY)) !== null;
    } catch {
        return false;
    }
}

/**
 * Trip the load breaker: set the cool-off flag (idempotent) and log the
 * transition once (only when it wasn't already tripped).
 */
async function tripLoadBreaker(loadRatio: number, threshold: number): Promise<void> {
    try {
        const already = await isAutoDisabled();
        await cacheSet(AUTO_DISABLE_KEY, String(Date.now()), config.PREVIEW_AUTODISABLE_SECONDS);
        if (!already) {
            logger.warn(
                'Preview load breaker TRIPPED — auto-disabling new preview sessions temporarily',
                {
                    loadRatioPerCore: Number(loadRatio.toFixed(2)),
                    threshold,
                    cooloffSeconds: config.PREVIEW_AUTODISABLE_SECONDS,
                },
            );
        }
    } catch {
        /* best-effort — if we can't set the flag, we still reject this request */
    }
}

/**
 * The admission gate. Call once per NEW preview request (not for reused ones).
 */
export async function checkPreviewAdmission(): Promise<PreviewAdmissionDecision> {
    // 1. Operator manual override — highest priority, durable.
    if (await isAdminDisabled()) {
        return {
            admit: false,
            status: 503,
            reason: 'admin_disabled',
            message: 'Video previews are temporarily disabled by an administrator.',
        };
    }

    // 2. Load circuit breaker.
    const shedRatio = config.PREVIEW_LOAD_SHED_RATIO;
    if (shedRatio > 0) {
        const loadRatio = getSystemLoadRatio();
        if (loadRatio > shedRatio) {
            // Breach: trip (or extend) the cool-off flag and reject.
            await tripLoadBreaker(loadRatio, shedRatio);
            return {
                admit: false,
                status: 503,
                reason: 'load_shed',
                message: 'Video previews are temporarily unavailable (server busy).',
            };
        }
        // Below threshold but a recent breach may still be cooling off. Honour
        // the flag so we don't immediately re-admit into a still-hot box; it
        // clears on its own via TTL once load stays down.
        if (await isAutoDisabled()) {
            return {
                admit: false,
                status: 503,
                reason: 'load_shed',
                message: 'Video previews are temporarily unavailable (server busy).',
            };
        }
    }

    // 3. Global concurrent-preview budget — ATOMIC reserve-before-spawn.
    const maxGlobal = config.PREVIEW_MAX_GLOBAL;
    if (maxGlobal > 0) {
        // Established sessions (Valkey scan; -1 → Valkey down → treat as 0 so the
        // in-flight counter alone still caps the burst even without coordination).
        const established = Math.max(0, await countActivePreviews(maxGlobal + 1));

        // --- synchronous claim: no `await` between this read and the increment ---
        // Concurrent requests run this block to completion without interleaving, so
        // they cannot all pass a stale count. `established` may lag, but
        // `inFlightReservations` accounts for every not-yet-established request.
        if (established + inFlightReservations >= maxGlobal) {
            return {
                admit: false,
                status: 429,
                reason: 'global_budget',
                message: 'Too many active video previews right now. Please try again shortly.',
            };
        }
        inFlightReservations++;
        // ------------------------------------------------------------------------

        let released = false;
        return {
            admit: true,
            release: () => {
                if (released) return;
                released = true;
                if (inFlightReservations > 0) inFlightReservations--;
            },
        };
    }

    return { admit: true };
}

/** Snapshot for the admin control panel / diagnostics. */
export async function getPreviewAdmissionStatus(): Promise<PreviewAdmissionStatus> {
    const maxGlobal = config.PREVIEW_MAX_GLOBAL;
    const [adminDisabled, autoDisabled, established] = await Promise.all([
        isAdminDisabled(),
        isAutoDisabled(),
        countActivePreviews(maxGlobal + 1).then((n) => (n < 0 ? 0 : n)),
    ]);
    // Reported count includes in-flight reservations so the admin view matches the
    // number the budget check actually enforces against.
    const activeCount = established + inFlightReservations;
    const loadRatio = getSystemLoadRatio();
    const shedRatio = config.PREVIEW_LOAD_SHED_RATIO;

    const reason: PreviewAdmissionStatus['reason'] = adminDisabled
        ? 'admin_disabled'
        : autoDisabled
          ? 'load_shed'
          : activeCount >= maxGlobal
            ? 'global_budget'
            : null;

    return {
        disabled: reason !== null,
        reason,
        loadRatio: Number(loadRatio.toFixed(2)),
        loadShedRatio: shedRatio,
        activeCount,
        maxGlobal,
        adminDisabled,
        autoDisabled,
        cache: getPreviewCacheStore().stats(),
    };
}

/** Operator control: manually disable/enable previews (durable across the flag's life). */
export async function setPreviewsAdminDisabled(disabled: boolean): Promise<void> {
    if (disabled) {
        await cacheSet(ADMIN_DISABLE_KEY, String(Date.now()));
        logger.warn('Previews manually DISABLED by operator');
    } else {
        await cacheDel(ADMIN_DISABLE_KEY);
        logger.info('Previews manually RE-ENABLED by operator');
    }
}
