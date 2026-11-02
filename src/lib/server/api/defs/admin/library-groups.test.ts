// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/library-groups — the admin list of libraries with item counts.
 *
 * Regression: the list used to come straight from getLibraryGroupsWithCounts,
 * whose HAVING drops every group without items — a library created a minute
 * ago vanished from the admin page meant to manage it ("No libraries yet").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('$lib/server/services/library-backdrop.service.js', () => ({
    getLibraryBackdropHash: async () => 'library-revision',
}));

import type { RequestEvent } from '@sveltejs/kit';

const { mockGetDb, mockGetAll, mockGetWithCounts } = vi.hoisted(() => ({
    mockGetDb: vi.fn(),
    mockGetAll: vi.fn(),
    mockGetWithCounts: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: mockGetDb }));
vi.mock('$lib/server/database/queries/library-groups.queries.js', () => ({
    getAllLibraryGroups: mockGetAll,
    getLibraryGroupsWithCounts: mockGetWithCounts,
    createLibraryGroup: vi.fn(),
}));

import { def } from './library-groups.js';

function group(id: string, name: string) {
    return {
        id,
        name,
        description: null,
        icon: null,
        sort_order: 0,
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-01'),
        max_age_rating: null,
        metadata_provider_chain: null,
        field_priority_overrides: null,
        is_public: false,
        display_name: null,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
});

describe('GET /api/admin/library-groups', () => {
    it('lists a library that has no items yet, with itemCount 0', async () => {
        mockGetAll.mockResolvedValue([group('g-full', 'Evening'), group('g-new', 'Shelf')]);
        // The count query omits the empty library entirely.
        mockGetWithCounts.mockResolvedValue([{ ...group('g-full', 'Evening'), item_count: 42 }]);

        const res = await def.handlers.GET!({} as RequestEvent, {} as never);
        const body = (await res.json()) as { items: { id: string; itemCount?: number }[] };

        expect(body.items.map((i) => [i.id, i.itemCount])).toEqual([
            ['g-full', 42],
            ['g-new', 0],
        ]);
    });
});
