// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The weekly licence check-in: when did this install last reach the licensing
 * server?
 *
 * Without it a valid licence never called out between enrolment and the last
 * 14 days before `exp` — during early access that is months — so the server
 * could not tell a running install from one deleted long ago. The refresh loop
 * now also calls `/api/license/refresh` when the last successful contact is
 * about a week old (jittered ±10 %). Any successful call counts as contact: a
 * renewal, the push relay token, or the check-in itself.
 *
 * The marker lives in Valkey with a TTL of about a week, so every process of
 * the install (web replicas, restarts) shares one schedule. Valkey failures
 * fall back to an in-process timestamp: a process then checks in at most once
 * a week on its own. A process never checks in during its first
 * {@link MIN_UPTIME_BEFORE_CHECK_IN_MS}, so a crash loop (or a run of quick
 * restarts while Valkey is down) cannot turn into one call per boot; the
 * check-in then happens on a later 6h tick.
 */

import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';

/** About how often an install with a valid licence checks in. */
export const CHECK_IN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CHECK_IN_JITTER = 0.1;
const KEY = 'v1:license-check-in';
/** No check-in before the process has been up this long. */
export const MIN_UPTIME_BEFORE_CHECK_IN_MS = 60 * 60 * 1000; // 1h

/** Roughly the process start (this module loads at boot via hooks.server.ts). */
let processStartedAt = Date.now();

/** In-process fallback for when the shared marker cannot be read or written. */
let lastContactAt: number | null = null;

/** The marker's TTL: the interval spread by ±{@link CHECK_IN_JITTER}. */
function markerTtlMs(rand: () => number = Math.random): number {
    return Math.round(CHECK_IN_INTERVAL_MS * (1 - CHECK_IN_JITTER + 2 * CHECK_IN_JITTER * rand()));
}

function markerCache() {
    return cacheManager.for(CACHE_NAMESPACES.licenseCheckIn);
}

/** A failed check-in waits this long before the next one (an offline install). */
export const CHECK_IN_FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1000; // 24h
let lastFailureAt: number | null = null;

/** A check-in failed: wait {@link CHECK_IN_FAILURE_BACKOFF_MS} before the next. */
export function noteCheckInFailure(now: number = Date.now()): void {
    lastFailureAt = now;
}

/** Whether the weekly check-in is due. Never throws. */
export async function checkInDue(now: number = Date.now()): Promise<boolean> {
    if (now - processStartedAt < MIN_UPTIME_BEFORE_CHECK_IN_MS) return false;
    if (lastFailureAt !== null && now - lastFailureAt < CHECK_IN_FAILURE_BACKOFF_MS) return false;
    // The shortest jittered interval, so the shared marker's own TTL decides
    // whenever Valkey works.
    if (
        lastContactAt !== null &&
        now - lastContactAt < CHECK_IN_INTERVAL_MS * (1 - CHECK_IN_JITTER)
    )
        return false;
    try {
        const marker = await markerCache().get<{ at: number }>(KEY);
        return !(marker && typeof marker.at === 'number');
    } catch {
        return true;
    }
}

/** Record a successful contact with the licensing server. Never throws. */
export async function noteLicenseServerContact(now: number = Date.now()): Promise<void> {
    lastContactAt = now;
    lastFailureAt = null;
    try {
        await markerCache().set(KEY, { at: now }, markerTtlMs());
    } catch {
        // Best-effort: the in-process timestamp still spaces this process's calls.
    }
}

/** Test hook: forget the in-process timestamp; `startedAt` sets the process start. */
export function resetLicenseCheckInForTests(startedAt: number = -Infinity): void {
    lastContactAt = null;
    lastFailureAt = null;
    processStartedAt = startedAt;
}
