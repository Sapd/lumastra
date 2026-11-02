// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { mapLibraryGroupToApi } from './library-group.mapper.js';
import type { LibraryGroupRow } from '$lib/server/database/queries/library-groups.queries.js';

function row(overrides: Partial<LibraryGroupRow> = {}): LibraryGroupRow {
    return {
        id: 'group-1',
        name: 'Evening',
        display_name: null,
        description: null,
        icon: null,
        sort_order: 0,
        max_age_rating: null,
        metadata_provider_chain: null,
        field_priority_overrides: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    };
}

describe('mapLibraryGroupToApi — itemCount', () => {
    it('includes itemCount when the caller passes one (getLibraryGroupsWithCounts)', () => {
        const api = mapLibraryGroupToApi(row(), 42);
        expect(api.itemCount).toBe(42);
    });

    it('omits itemCount when the caller does not pass one (every other caller)', () => {
        const api = mapLibraryGroupToApi(row());
        expect(api.itemCount).toBeUndefined();
    });

    it('reports a zero item count as 0, not as absent', () => {
        const api = mapLibraryGroupToApi(row(), 0);
        expect(api.itemCount).toBe(0);
    });
});
