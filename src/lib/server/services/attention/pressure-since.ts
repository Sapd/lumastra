// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "Since when has this been true" for the resource-pressure attention producer.
 *
 * Heartbeats are snapshots: one beat at 90 % of a memory limit is a GC pause or a
 * burst, not a problem. The alert must only fire once the same condition has held
 * across derive cycles, so something has to remember when each condition was first
 * seen. Derivation runs once cluster-wide (the problem-derive task, one at a time),
 * but the worker that runs it can change, so the map lives in Valkey with a short
 * TTL and a process-local copy covers a missing or flushed cache: the earlier of
 * the two timestamps wins. Losing both only restarts the clock (the alert comes
 * later), never raises a false one.
 *
 * A condition that drops out for less than {@link PRESSURE_GAP_GRACE_MS} keeps its
 * clock AND is handed back (with its last snapshot) so the alert holds: a container
 * sawing between 84 % and 90 % with GC, a missed heartbeat or one OOM restart must
 * neither restart the 10-minute clock nor resolve a firing alert (which would drop
 * the operator's ack).
 */

import { cacheGet, cacheSet } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { PressureCondition } from './adapters.js';

const logger = Logger.for('attention:pressure-since');

// Pressure snapshots now exclude clean file cache; discard clocks using the old basis.
const KEY = 'v3:attention:resource-pressure-since';
/** Longer than a few missed 60 s derive cycles; a longer gap restarts every clock. */
const TTL_SECONDS = 15 * 60;
/** How long a condition may be absent and still count as continuing. */
export const PRESSURE_GAP_GRACE_MS = 3 * 60_000;

export interface PressureClock<T> {
    /** Epoch ms the unbroken run started. */
    first: number;
    /** Epoch ms the condition was last observed. */
    last: number;
    /** The condition as last observed (what the alert text reports). */
    value: T;
}

let local = new Map<string, PressureClock<unknown>>();
/** When `local` was last written; an old copy (this process stopped deriving) is dropped. */
let localAt = 0;

/** Validate persisted snapshots and guard consumers against malformed clocks. */
export function isPressureClock(raw: unknown): raw is PressureClock<PressureCondition> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
    const c = raw as Partial<PressureClock<unknown>>;
    if (
        typeof c.first !== 'number' ||
        typeof c.last !== 'number' ||
        !Number.isFinite(c.first) ||
        !Number.isFinite(c.last) ||
        typeof c.value !== 'object' ||
        c.value === null ||
        Array.isArray(c.value)
    ) {
        return false;
    }
    const value = c.value as Partial<PressureCondition>;
    return (
        typeof value.key === 'string' &&
        typeof value.subject === 'string' &&
        (value.kind === 'container' || value.kind === 'containerPeak' || value.kind === 'host') &&
        (value.level === 'warn' || value.level === 'critical') &&
        typeof value.ratio === 'number' &&
        Number.isFinite(value.ratio) &&
        typeof value.where === 'string' &&
        (value.role === undefined || typeof value.role === 'string') &&
        (value.usesNonReclaimable === undefined || typeof value.usesNonReclaimable === 'boolean') &&
        [
            value.usedBytes,
            value.limitBytes,
            value.peakBytes,
            value.reclaimableFileBytes,
            value.availableBytes,
            value.totalBytes,
        ].every((v) => v === undefined || (typeof v === 'number' && Number.isFinite(v)))
    );
}

function parse(raw: string | null): Map<string, PressureClock<unknown>> {
    if (!raw) return new Map();
    try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        const out = new Map<string, PressureClock<unknown>>();
        for (const [key, v] of Object.entries(obj)) {
            if (isPressureClock(v)) {
                out.set(key, { first: v.first, last: v.last, value: v.value });
            }
        }
        return out;
    } catch {
        return new Map();
    }
}

/**
 * Records the conditions that hold right now (`active`, by clock key) and returns
 * every clock that is still running: the active ones, plus ones last seen within
 * {@link PRESSURE_GAP_GRACE_MS} (with their last snapshot). Anything older is
 * forgotten, so a condition that clears for longer starts a new clock.
 */
export async function trackPressureSince<T>(
    active: ReadonlyMap<string, T>,
    now: number = Date.now(),
): Promise<Map<string, PressureClock<T>>> {
    const stored = parse(await cacheGet(KEY));
    if (now < localAt || now - localAt > TTL_SECONDS * 1000) local = new Map();

    const next = new Map<string, PressureClock<T>>();
    const prior = (key: string): PressureClock<unknown> | undefined => {
        const candidates = [stored.get(key), local.get(key)].filter(
            (c): c is PressureClock<unknown> =>
                c !== undefined && c.first <= now && now - c.last <= PRESSURE_GAP_GRACE_MS,
        );
        if (candidates.length === 0) return undefined;
        return {
            first: Math.min(...candidates.map((c) => c.first)),
            last: Math.max(...candidates.map((c) => c.last)),
            value: candidates.reduce((a, b) => (b.last > a.last ? b : a)).value,
        };
    };
    for (const [key, value] of active) {
        next.set(key, { first: prior(key)?.first ?? now, last: now, value });
    }
    for (const key of new Set([...stored.keys(), ...local.keys()])) {
        if (next.has(key)) continue;
        const p = prior(key);
        if (p) next.set(key, p as PressureClock<T>);
    }

    local = next;
    localAt = now;
    // Nothing running and nothing stored: no write every cycle on a calm install.
    if (next.size > 0 || stored.size > 0) {
        const ok = await cacheSet(KEY, JSON.stringify(Object.fromEntries(next)), TTL_SECONDS);
        if (!ok) logger.debug('could not store pressure clocks; keeping the local copy');
    }
    return next;
}

/** Test seam. */
export function resetPressureSinceForTests(): void {
    local = new Map();
    localAt = 0;
}
