// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { groupPhysicalFiles } from './physical-files.js';
describe('physical file inventory', () => {
    it('groups a shared file once and retains every cross-season association', () => {
        const rows = [
            { id: 'physical-a', media_item_id: 'episode-a', season: 1, startMs: 0, endMs: 90000 },
            {
                id: 'physical-a',
                media_item_id: 'episode-b',
                season: 2,
                startMs: 90000,
                endMs: 180000,
            },
            { id: 'physical-b', media_item_id: 'episode-b', season: 2, startMs: null, endMs: null },
        ];
        const physical = groupPhysicalFiles(rows);
        expect(physical).toHaveLength(2);
        expect(physical[0].associations).toEqual(rows.slice(0, 2));
        expect(physical[1].associations).toEqual(rows.slice(2));
    });
});

it('shows mixed association data for a container and prefers the selected leaf metadata', () => {
    const rows = [
        {
            id: 'file',
            media_item_id: 'a',
            file_label: 'First',
            is_default: true,
            file_sort_order: 0,
        },
        {
            id: 'file',
            media_item_id: 'b',
            file_label: 'Second',
            is_default: false,
            file_sort_order: 2,
        },
    ];
    const [container] = groupPhysicalFiles(rows, 'series');
    expect(container.file_label).toBeUndefined();
    expect(container.is_default).toBeUndefined();
    expect(container.file_sort_order).toBeUndefined();
    expect(container.mixedAssociationFields).toEqual([
        'file_label',
        'is_default',
        'file_sort_order',
    ]);
    const [leaf] = groupPhysicalFiles(rows, 'b');
    expect(leaf.file_label).toBe('Second');
    expect(leaf.is_default).toBe(false);
    expect(leaf.file_sort_order).toBe(2);
    expect(leaf.associations).toEqual(rows);
});
