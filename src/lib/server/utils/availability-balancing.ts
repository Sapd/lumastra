// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Interleaves available and requestable items, placing requestable items
 * every 3rd position.
 *
 * @template T - Type of items being balanced
 * @param items - Array of items to balance (already filtered and scored)
 * @param limit - Maximum number of items to return
 * @param availableRatio - Ratio of available items (0.0-1.0). Default 0.5 = 50% available.
 * @param isAvailable - Accessor function to determine if an item is available
 * @returns Balanced and interleaved array of items
 *
 * @example
 * ```typescript
 * const balanced = interleaveByAvailability(
 *     recommendations,
 *     10,
 *     0.5,
 *     item => item.isAvailable
 * );
 * ```
 */
export function interleaveByAvailability<T>(
    items: T[],
    limit: number,
    availableRatio: number,
    isAvailable: (item: T) => boolean,
): T[] {
    // Split into available and requestable
    const available = items.filter(isAvailable);
    const requestable = items.filter((item) => !isAvailable(item));

    // Calculate target counts based on ratio
    const targetAvailable = Math.ceil(limit * availableRatio);
    const targetRequestable = limit - targetAvailable;

    // Build balanced list
    let balanced: T[];
    if (available.length >= targetAvailable) {
        // We have enough available - take target from each
        balanced = [
            ...available.slice(0, targetAvailable),
            ...requestable.slice(0, targetRequestable),
        ];
    } else {
        // Not enough available - take what we have and fill with requestable
        const remaining = limit - available.length;
        balanced = [...available, ...requestable.slice(0, remaining)];
    }

    // Interleave: available at positions 1,2,4,5,7,8... requestable at 3,6,9...
    const availableItems = balanced.filter(isAvailable);
    const requestableItems = balanced.filter((item) => !isAvailable(item));
    const result: T[] = [];
    let aIdx = 0;
    let rIdx = 0;

    for (let i = 0; i < balanced.length; i++) {
        // Every 3rd position (1-indexed: 3, 6, 9...) gets a requestable if available
        if ((i + 1) % 3 === 0 && rIdx < requestableItems.length) {
            result.push(requestableItems[rIdx++]);
        } else if (aIdx < availableItems.length) {
            result.push(availableItems[aIdx++]);
        } else if (rIdx < requestableItems.length) {
            result.push(requestableItems[rIdx++]);
        }
    }

    return result;
}

/**
 * Caps each availability class at `limitPerClass` independently, preserving
 * the original relative order of items within (and across) both classes.
 *
 * Any boundary that truncates a MIXED pool of available and unavailable items
 * to N rows — when a downstream step filters by availability — lets one class
 * evict the other, collapsing availability-filtered rails to near-zero when
 * one class dominates the pool (see the `availability_ranked` CTE in
 * `for-you-helpers.queries.ts` for the SQL-side equivalent of this fix).
 * Truncating boundaries MUST preserve up to N items of EACH class instead.
 *
 * @template T - Type of items being capped
 * @param items - Array of items to cap (already scored/ordered upstream)
 * @param limitPerClass - Maximum number of items to keep per availability class
 * @param isAvailable - Accessor function to determine if an item is available
 * @returns Items with each class capped at `limitPerClass`, original order preserved
 */
export function capByAvailabilityClass<T>(
    items: readonly T[],
    limitPerClass: number,
    isAvailable: (item: T) => boolean,
): T[] {
    let availableCount = 0;
    let unavailableCount = 0;
    const result: T[] = [];

    for (const item of items) {
        if (isAvailable(item)) {
            if (availableCount >= limitPerClass) continue;
            availableCount++;
        } else {
            if (unavailableCount >= limitPerClass) continue;
            unavailableCount++;
        }
        result.push(item);
    }

    return result;
}
