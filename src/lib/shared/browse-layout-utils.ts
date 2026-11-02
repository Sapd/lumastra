// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure utility functions used by the browse layout components.
 * Extracted here so they can be unit-tested independently of Svelte.
 */

export interface BrowseItem {
    id: string;
    title: string;
    media_type: string;
    custom_metadata: Record<string, unknown>;
    custom_poster_url: string | null;
    episode_count: number;
    first_episode_id: string | null;
    completed_count: number;
}

/**
 * Extract a four-digit year string from a date_filmed value (ISO date string,
 * partial date like "2024-06", or plain year string like "2024").
 * Returns 'Unknown Year' when the value is absent or unparseable.
 */
export function extractYear(dateFiled: unknown): string {
    if (dateFiled == null || dateFiled === '') return 'Unknown Year';
    const str = String(dateFiled).trim();
    // ISO date: "2024-06-15" → "2024", or year alone "2024"
    const match = str.match(/^(\d{4})/);
    return match ? match[1] : 'Unknown Year';
}

/**
 * Group items by a secondary metadata key, producing an ordered Map.
 * Items whose key value is missing / non-scalar land in 'Uncategorized'.
 */
export function groupBySecondaryKey(
    items: BrowseItem[],
    metadataKey: string,
): Map<string, BrowseItem[]> {
    const map = new Map<string, BrowseItem[]>();
    for (const item of items) {
        const raw = item.custom_metadata?.[metadataKey];
        const key =
            raw === null || raw === undefined || Array.isArray(raw) || typeof raw === 'object'
                ? 'Uncategorized'
                : String(raw);
        let bucket = map.get(key);
        if (!bucket) {
            bucket = [];
            map.set(key, bucket);
        }
        bucket.push(item);
    }
    return map;
}

/**
 * Sort items within a course by lesson_number (stored as string or number in
 * custom_metadata). Items without a lesson_number sort to the end, then by title.
 */
export function sortByLessonNumber(items: BrowseItem[]): BrowseItem[] {
    return [...items].sort((a, b) => {
        const numA = parseInt(String(a.custom_metadata?.lesson_number ?? ''), 10);
        const numB = parseInt(String(b.custom_metadata?.lesson_number ?? ''), 10);
        const hasA = !isNaN(numA);
        const hasB = !isNaN(numB);
        if (hasA && hasB) return numA - numB;
        if (hasA) return -1;
        if (hasB) return 1;
        return a.title.localeCompare(b.title);
    });
}

/**
 * Derive the difficulty badge colour class (Tailwind) from a difficulty string.
 * beginner → green, intermediate → yellow, advanced → red, unknown → grey.
 */
export function difficultyBadgeClass(difficulty: unknown): string {
    switch (String(difficulty ?? '').toLowerCase()) {
        case 'beginner':
            return 'bg-green-600 text-white';
        case 'intermediate':
            return 'bg-yellow-500 text-black';
        case 'advanced':
            return 'bg-red-600 text-white';
        default:
            return 'bg-surface-600 text-surface-200';
    }
}

/**
 * Determine the watch target for a BrowseItem card click:
 * - multi-episode → series detail page (/library/{type}/{id})
 * - single-episode  → watch page (/watch/{first_episode_id ?? id})
 */
export function resolveItemUrl(item: BrowseItem, libraryType: string): string {
    if (item.episode_count > 1) {
        return `/library/${libraryType}/${item.id}`;
    }
    return `/watch/${item.first_episode_id ?? item.id}`;
}
