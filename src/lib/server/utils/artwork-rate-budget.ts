// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rolling-hour cap on provider-artwork materializations.
 *
 * Each provider-artwork-* run processes exactly ONE media item, so a "per-run
 * item cap" is meaningless; the operator control that actually bounds a
 * multi-hour, multi-GB drain is a RATE. The counter lives in Valkey because
 * the drain runs across replicas.
 *
 * Fail-OPEN by design: this is a courtesy brake on bandwidth, not a safety
 * guard. The safety guard is the per-volume disk-headroom check
 * (`artwork-volume-headroom.ts`), which reads the filesystem directly and does
 * not depend on Valkey.
 */

import { isValkeyReady, incr, expire, cacheGet } from '../cache/valkey.js';
import { Logger } from './logger.js';

const logger = Logger.for('ArtworkRateBudget');

const HOUR_MS = 3_600_000;
/** Two hours, so a bucket outlives its own hour even under clock skew. */
const BUCKET_TTL_SECONDS = 7200;

/** Versioned, hour-bucketed counter key. */
export function artworkBudgetKey(nowMs: number): string {
    return `v1:artwork-backfill:budget:${Math.floor(nowMs / HOUR_MS)}`;
}

/**
 * Claim one unit of this hour's budget.
 *
 * @param maxPerHour `<= 0` means unlimited.
 * @returns `true` when the caller may proceed.
 */
export async function consumeArtworkBudget(
    maxPerHour: number,
    nowMs: number = Date.now(),
): Promise<boolean> {
    if (maxPerHour <= 0) return true;
    if (!isValkeyReady()) return true;

    const key = artworkBudgetKey(nowMs);
    try {
        const used = await incr(key);
        if (used === 1) {
            await expire(key, BUCKET_TTL_SECONDS);
        }
        return used <= maxPerHour;
    } catch (err) {
        logger.warn('Artwork budget check failed; allowing the run (fail-open)', {
            error: err instanceof Error ? err.message : String(err),
        });
        return true;
    }
}

/** Current bucket usage, for the dry-run report. Never increments. */
export async function peekArtworkBudget(nowMs: number = Date.now()): Promise<number> {
    if (!isValkeyReady()) return 0;
    try {
        const raw = await cacheGet(artworkBudgetKey(nowMs));
        const parsed = Number.parseInt(raw ?? '', 10);
        return Number.isFinite(parsed) ? parsed : 0;
    } catch {
        return 0;
    }
}
