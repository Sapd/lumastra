// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { CleanupHoldReason } from '$lib/server/database/queries/library-cleanup-holds.queries.js';

/** A walk that finds under this share of the known files looks like a broken mount. */
export const STALE_CLEANUP_MIN_RATIO = 0.2;
/** Below this many known files the ratio says nothing. */
export const STALE_CLEANUP_RATIO_MIN_KNOWN = 20;

/**
 * Whether stale cleanup of one library path must be held, and why: the walk
 * found no files although the database knows some ('no_files'), or under 20 %
 * of 20+ known files ('few_files'). Null when cleanup may run.
 */
export function staleCleanupGuard(walked: number, known: number): CleanupHoldReason | null {
    if (known === 0) return null;
    if (walked === 0) return 'no_files';
    if (known >= STALE_CLEANUP_RATIO_MIN_KNOWN && walked / known < STALE_CLEANUP_MIN_RATIO) {
        return 'few_files';
    }
    return null;
}
