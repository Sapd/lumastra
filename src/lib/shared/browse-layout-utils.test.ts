// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
    difficultyBadgeClass,
    extractYear,
    groupBySecondaryKey,
    resolveItemUrl,
    sortByLessonNumber,
} from './browse-layout-utils';
import type { BrowseItem } from './browse-layout-utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<BrowseItem> = {}): BrowseItem {
    return {
        id: 'item-1',
        title: 'Test Item',
        media_type: 'educational',
        custom_metadata: {},
        custom_poster_url: null,
        episode_count: 1,
        first_episode_id: null,
        completed_count: 0,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// extractYear
// ---------------------------------------------------------------------------

describe('extractYear', () => {
    test('ISO date string → year', () => {
        expect(extractYear('2024-06-15')).toBe('2024');
    });

    test('partial date "2023-08" → year', () => {
        expect(extractYear('2023-08')).toBe('2023');
    });

    test('plain year string "2022" → year', () => {
        expect(extractYear('2022')).toBe('2022');
    });

    test('null → Unknown Year', () => {
        expect(extractYear(null)).toBe('Unknown Year');
    });

    test('undefined → Unknown Year', () => {
        expect(extractYear(undefined)).toBe('Unknown Year');
    });

    test('empty string → Unknown Year', () => {
        expect(extractYear('')).toBe('Unknown Year');
    });

    test('non-date string → Unknown Year', () => {
        expect(extractYear('Summer Trip')).toBe('Unknown Year');
    });
});

// ---------------------------------------------------------------------------
// groupBySecondaryKey
// ---------------------------------------------------------------------------

describe('groupBySecondaryKey', () => {
    test('groups items by a string metadata key', () => {
        const items = [
            makeItem({ id: 'a', custom_metadata: { course: 'Algebra 101' } }),
            makeItem({ id: 'b', custom_metadata: { course: 'Algebra 101' } }),
            makeItem({ id: 'c', custom_metadata: { course: 'Geometry' } }),
        ];
        const map = groupBySecondaryKey(items, 'course');
        expect(map.get('Algebra 101')).toHaveLength(2);
        expect(map.get('Geometry')).toHaveLength(1);
    });

    test('routes missing key to Uncategorized', () => {
        const items = [
            makeItem({ id: 'a', custom_metadata: {} }),
            makeItem({ id: 'b', custom_metadata: { course: null } }),
        ];
        const map = groupBySecondaryKey(items, 'course');
        expect(map.get('Uncategorized')).toHaveLength(2);
    });

    test('routes array values to Uncategorized', () => {
        const items = [makeItem({ id: 'a', custom_metadata: { tags: ['x', 'y'] } })];
        const map = groupBySecondaryKey(items, 'tags');
        expect(map.get('Uncategorized')).toHaveLength(1);
    });

    test('preserves insertion order', () => {
        const items = [
            makeItem({ id: 'a', custom_metadata: { dept: 'Zebra' } }),
            makeItem({ id: 'b', custom_metadata: { dept: 'Alpha' } }),
        ];
        const keys = [...groupBySecondaryKey(items, 'dept').keys()];
        expect(keys).toEqual(['Zebra', 'Alpha']);
    });
});

// ---------------------------------------------------------------------------
// sortByLessonNumber
// ---------------------------------------------------------------------------

describe('sortByLessonNumber', () => {
    test('sorts ascending by numeric lesson_number', () => {
        const items = [
            makeItem({ id: 'c', custom_metadata: { lesson_number: 3 } }),
            makeItem({ id: 'a', custom_metadata: { lesson_number: 1 } }),
            makeItem({ id: 'b', custom_metadata: { lesson_number: 2 } }),
        ];
        const sorted = sortByLessonNumber(items);
        expect(sorted.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    });

    test('string lesson_numbers are coerced numerically', () => {
        const items = [
            makeItem({ id: 'b', custom_metadata: { lesson_number: '10' } }),
            makeItem({ id: 'a', custom_metadata: { lesson_number: '2' } }),
        ];
        const sorted = sortByLessonNumber(items);
        expect(sorted.map((i) => i.id)).toEqual(['a', 'b']);
    });

    test('items without lesson_number sort to end, then by title', () => {
        const items = [
            makeItem({ id: 'z', title: 'Zzz', custom_metadata: {} }),
            makeItem({ id: 'a', custom_metadata: { lesson_number: 1 } }),
            makeItem({ id: 'b', title: 'Aaa', custom_metadata: {} }),
        ];
        const sorted = sortByLessonNumber(items);
        expect(sorted[0].id).toBe('a');
        expect(sorted[1].title).toBe('Aaa');
        expect(sorted[2].title).toBe('Zzz');
    });

    test('does not mutate the input array', () => {
        const items = [
            makeItem({ id: 'b', custom_metadata: { lesson_number: 2 } }),
            makeItem({ id: 'a', custom_metadata: { lesson_number: 1 } }),
        ];
        const original = [...items];
        sortByLessonNumber(items);
        expect(items[0].id).toBe(original[0].id);
    });
});

// ---------------------------------------------------------------------------
// difficultyBadgeClass
// ---------------------------------------------------------------------------

describe('difficultyBadgeClass', () => {
    test('beginner → green', () => {
        expect(difficultyBadgeClass('beginner')).toContain('green');
    });

    test('Intermediate (mixed case) → yellow', () => {
        expect(difficultyBadgeClass('Intermediate')).toContain('yellow');
    });

    test('advanced → red', () => {
        expect(difficultyBadgeClass('advanced')).toContain('red');
    });

    test('unknown → surface-600', () => {
        expect(difficultyBadgeClass('expert')).toContain('surface-600');
    });

    test('null → surface-600', () => {
        expect(difficultyBadgeClass(null)).toContain('surface-600');
    });
});

// ---------------------------------------------------------------------------
// resolveItemUrl
// ---------------------------------------------------------------------------

describe('resolveItemUrl', () => {
    test('multi-episode → series detail URL', () => {
        const item = makeItem({ id: 'series-1', episode_count: 5 });
        expect(resolveItemUrl(item, 'educational')).toBe('/library/educational/series-1');
    });

    test('single episode with first_episode_id → watch URL', () => {
        const item = makeItem({ id: 'series-2', episode_count: 1, first_episode_id: 'ep-42' });
        expect(resolveItemUrl(item, 'home_video')).toBe('/watch/ep-42');
    });

    test('single episode without first_episode_id → watch item.id', () => {
        const item = makeItem({ id: 'item-99', episode_count: 1, first_episode_id: null });
        expect(resolveItemUrl(item, 'personal')).toBe('/watch/item-99');
    });
});
