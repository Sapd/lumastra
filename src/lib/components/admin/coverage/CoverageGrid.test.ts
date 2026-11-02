// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'vitest';
import CoverageGrid from './CoverageGrid.svelte';
import type { StageStatus } from '$lib/types/pipeline.js';

function makeItem(id: string, title: string, stageCompletion: Record<string, StageStatus> = {}) {
    return {
        id,
        title,
        media_type: 'movie',
        library_group_id: null,
        stage_completion: stageCompletion,
        added_at: new Date().toISOString(),
    };
}

describe('CoverageGrid', () => {
    test('renders one data row per item', () => {
        const items = [
            makeItem('1', 'Alpha', { 'tmdb-sync': 'completed' }),
            makeItem('2', 'Beta', { 'tmdb-sync': 'pending' }),
            makeItem('3', 'Gamma', { 'tmdb-sync': 'failed_transient' }),
        ];
        const { container } = render(CoverageGrid, { items });
        const rows = container.querySelectorAll('tbody tr');
        expect(rows).toHaveLength(3);
    });

    test('computes union of stage_ids and renders correct header cells', () => {
        const items = [
            makeItem('1', 'Alpha', {
                'stage-a': 'completed',
                'stage-b': 'pending',
            }),
            makeItem('2', 'Beta', {
                'stage-b': 'completed',
                'stage-c': 'running',
            }),
        ];
        const { container } = render(CoverageGrid, { items });
        const headerCells = container.querySelectorAll('thead th');
        // 2 fixed columns (Item, Type) + 3 stage columns (stage-a, stage-b, stage-c)
        expect(headerCells).toHaveLength(5);
    });

    test('renders placeholder cell when a stage is missing for an item', () => {
        const items = [
            makeItem('1', 'Alpha', { 'stage-a': 'completed' }),
            makeItem('2', 'Beta', { 'stage-b': 'completed' }),
        ];
        const { container } = render(CoverageGrid, { items });
        // Each row has stage-a and stage-b; each item is missing one → 2 placeholder spans.
        // The label is deliberately NOT "not applicable": that string belongs to
        // `skipped_permanent` (a stage that was evaluated and deliberately skipped),
        // and the legend used to render both with the same words, so an operator
        // could not tell "we looked and it doesn't apply" from "there is no such
        // step for this item at all". Keep the two distinct here.
        const placeholders = container.querySelectorAll(
            '[aria-label="doesn\'t apply to this item"]',
        );
        expect(placeholders).toHaveLength(2);
    });

    test('renders empty state message when items is empty', () => {
        const { container } = render(CoverageGrid, { items: [] });
        const cell = container.querySelector('td');
        expect(cell?.textContent?.trim()).toBe('No items match the current filters.');
    });

    test('item title links to pipeline tab', () => {
        const items = [makeItem('abc-123', 'My Movie', { 'tmdb-sync': 'completed' })];
        const { container } = render(CoverageGrid, { items });
        const link = container.querySelector('a[href="/admin/library/media/abc-123?tab=pipeline"]');
        expect(link).not.toBeNull();
        expect(link?.textContent?.trim()).toBe('My Movie');
    });

    test('displays tv media_type as series', () => {
        const item = {
            id: '1',
            title: 'A Show',
            media_type: 'tv',
            library_group_id: null,
            stage_completion: {},
            added_at: new Date().toISOString(),
        };
        const { container } = render(CoverageGrid, { items: [item] });
        const typeCells = container.querySelectorAll('tbody td:nth-child(2)');
        expect(typeCells[0]?.textContent?.trim()).toBe('series');
    });
});
