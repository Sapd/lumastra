// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hero pool rotation utilities.
 *
 * All functions are pure and client+server safe (no Node.js APIs).
 * Randomness is eliminated in favour of seeded determinism so that:
 *   - The same user/day/daypart always produces the same hero order.
 *   - Changing the daypart produces a different but stable rotation.
 */

import { hashSeed } from '$lib/shared/hash-seed.js';
import { daypartIndex } from '$lib/utils/time-period.js';

// Re-export hashSeed so callers can stay in one import
export { hashSeed };

// =============================================================================
// Seed construction
// =============================================================================

/**
 * Parts that together identify a unique rotation epoch.
 */
export interface HeroRotationSeedParts {
    /** Day bucket — typically Math.floor(epochMs / 86_400_000) */
    dateBucket: number;
    /** Daypart index (0–3: morning/afternoon/evening/late-night) */
    daypart: number;
    /** Optional user identifier for per-user variation */
    userKey?: string;
    /** Optional load count for intra-session variation (not used in Phase D) */
    loadCount?: number;
}

/**
 * Combine rotation parts into a single 32-bit seed via FNV-1a.
 * Stable: same parts ⇒ same seed.
 */
export function heroRotationSeed(parts: HeroRotationSeedParts): number {
    const str = [
        String(parts.dateBucket),
        String(parts.daypart),
        parts.userKey ?? '',
        parts.loadCount != null ? String(parts.loadCount) : '',
    ].join(':');
    return hashSeed(str);
}

// =============================================================================
// Pool rotation
// =============================================================================

/**
 * Options for rotateHeroPool.
 */
export interface RotateHeroPoolOptions {
    /**
     * If provided and less than pool.length, only return a windowSize-length
     * slice starting at the rotation offset (wrapping around the pool).
     */
    windowSize?: number;
    /**
     * When true, pool[0] is kept pinned at index 0 (highest-quality item stays
     * as the headline) and rotation is applied only to pool[1..].
     */
    pinFirst?: boolean;
}

/**
 * Rotate a pool of items by an offset derived from the seed.
 *
 * - If pool.length <= 1, returns the pool as-is.
 * - offset = seed % pool.length (for the rotated portion).
 * - If windowSize is given, only that many items are returned.
 * - If pinFirst is true, pool[0] stays at index 0; rotation applies to pool[1..].
 *
 * Pure: does not mutate the input array.
 */
export function rotateHeroPool<T>(
    pool: readonly T[],
    seed: number,
    opts: RotateHeroPoolOptions = {},
): T[] {
    const { windowSize, pinFirst = false } = opts;

    if (pool.length <= 1) return [...pool];

    if (pinFirst && pool.length > 1) {
        const pinned = pool[0];
        const rest = pool.slice(1);
        const rotated = rotateArray(rest, seed);
        const combined = [pinned, ...rotated];
        if (windowSize != null && windowSize > 0 && windowSize < combined.length) {
            return combined.slice(0, windowSize);
        }
        return combined;
    }

    const rotated = rotateArray(pool, seed);
    if (windowSize != null && windowSize > 0 && windowSize < rotated.length) {
        return rotated.slice(0, windowSize);
    }
    return rotated;
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function rotateArray<T>(arr: readonly T[], seed: number): T[] {
    if (arr.length <= 1) return [...arr];
    const offset = (seed >>> 0) % arr.length;
    return [...arr.slice(offset), ...arr.slice(0, offset)];
}

// =============================================================================
// Watching-pool helpers (Continue-Watching + Next-Up hero lead)
// =============================================================================

/**
 * Build the current-daypart rotation seed for a given user.
 *
 * Identical on server and client when called within the same daypart with the
 * same `userKey`, so SSR's chosen hero lead matches the client's first render.
 * Deterministic (no Math.random): it cycles through the day as the daypart
 * advances and stays stable within a daypart (reload-safe).
 */
export function currentDaypartSeed(userKey: string | undefined, now: Date = new Date()): number {
    const dateBucket = Math.floor(now.getTime() / 86_400_000);
    const daypart = daypartIndex(now);
    return heroRotationSeed({ dateBucket, daypart, userKey });
}

/**
 * Dedupe a pool while preserving first-seen order. The first item to claim a
 * key wins — so when Continue-Watching items are placed BEFORE Next-Up items,
 * a series the user is mid-watching is represented by its CW entry (with
 * progress), and the redundant Next-Up entry for the same series is dropped.
 *
 * Items whose key function returns `undefined`/empty are always kept (they are
 * un-dedupable — e.g. a row with no stable series/media identity).
 */
export function dedupeByKey<T>(pool: readonly T[], keyOf: (item: T) => string | undefined): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const item of pool) {
        const key = keyOf(item);
        if (!key) {
            out.push(item);
            continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

/**
 * Pick the daypart-rotated lead from a deduped pool.
 *
 * The pool is rotated by the daypart seed and `[0]` is returned. With the same
 * pool + seed this is deterministic, so SSR and the client agree on the lead.
 * Returns `undefined` for an empty pool (caller falls back to the generic slide).
 */
export function pickRotatedHeroLead<T>(pool: readonly T[], seed: number): T | undefined {
    if (pool.length === 0) return undefined;
    return rotateHeroPool(pool, seed)[0];
}
