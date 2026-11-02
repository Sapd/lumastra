// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/library-groups/[id].ts PATCH (update a library group).
 *
 * The PATCH gate previously accepted `mediaType`/`isPublic` (silently dropped)
 * and its docs advertised `displayName`/`sortOrder` that no column backed. These
 * tests lock the converged single-schema behaviour: the camelCase partial-update
 * body maps to the exact snake_case UpdateLibraryGroupParams, absent fields stay
 * undefined (so the query preserves them), and `displayName` now round-trips.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('$lib/server/services/library-backdrop.service.js', () => ({
    getLibraryBackdropHash: async () => 'library-revision',
}));

import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/index.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

const mockGetLibraryGroupById = vi.fn();
const mockUpdateLibraryGroup = vi.fn();
const mockDeleteLibraryGroup = vi.fn();
vi.mock('$lib/server/database/queries/library-groups.queries.js', () => ({
    getLibraryGroupById: (...args: unknown[]) => mockGetLibraryGroupById(...args),
    updateLibraryGroup: (...args: unknown[]) => mockUpdateLibraryGroup(...args),
    deleteLibraryGroup: (...args: unknown[]) => mockDeleteLibraryGroup(...args),
}));

const { def } = await import('./[id].js');

const GROUP_ID = '11111111-2222-4333-8444-555555555555';

function makeGroupRow(overrides: Record<string, unknown> = {}) {
    return {
        id: GROUP_ID,
        name: 'Movies',
        display_name: 'My Movies',
        description: null,
        icon: null,
        sort_order: 0,
        max_age_rating: null,
        metadata_provider_chain: null,
        field_priority_overrides: null,
        created_at: new Date('2026-07-01T00:00:00.000Z'),
        updated_at: new Date('2026-07-01T00:00:00.000Z'),
        ...overrides,
    };
}

const bodySchema = def.request!.body!;

function makeCtx(body: unknown): ApiContext {
    return {
        surface: 'v1',
        input: { body, query: undefined, params: undefined },
    } as ApiContext;
}

function makeEvent(): RequestEvent {
    return { params: { id: GROUP_ID } } as RequestEvent;
}

function callPatch(body: unknown): Promise<Response> {
    const handler = def.handlers.PATCH!;
    return Promise.resolve(handler(makeEvent(), makeCtx(body)));
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockUpdateLibraryGroup.mockResolvedValue(makeGroupRow());
});

describe('PATCH /library-groups/{id} request schema', () => {
    it('accepts a displayName-only partial update', () => {
        expect(bodySchema.safeParse({ displayName: 'Renamed' }).success).toBe(true);
    });

    it('accepts name + sortOrder', () => {
        expect(bodySchema.safeParse({ name: 'Movies', sortOrder: 3 }).success).toBe(true);
    });

    it('rejects a displayName longer than 128 chars', () => {
        expect(bodySchema.safeParse({ displayName: 'x'.repeat(129) }).success).toBe(false);
    });
});

describe('PATCH /library-groups/{id} handler', () => {
    it('maps displayName to display_name, leaving other columns untouched', async () => {
        const response = await callPatch({ displayName: 'Renamed' });

        expect(response.status).toBe(200);
        expect(mockUpdateLibraryGroup).toHaveBeenCalledTimes(1);
        const [, id, params] = mockUpdateLibraryGroup.mock.calls[0];
        expect(id).toBe(GROUP_ID);
        expect(params).toEqual({
            name: undefined,
            display_name: 'Renamed',
            sort_order: undefined,
        });
    });

    it('maps name + sortOrder to snake_case', async () => {
        await callPatch({ name: 'Films', sortOrder: 3 });

        const [, , params] = mockUpdateLibraryGroup.mock.calls[0];
        expect(params).toEqual({
            name: 'Films',
            display_name: undefined,
            sort_order: 3,
        });
    });

    it('returns 404 when the group does not exist', async () => {
        mockUpdateLibraryGroup.mockResolvedValue(null);

        const response = await callPatch({ displayName: 'Renamed' });

        expect(response.status).toBe(404);
    });
});

it.each(['GET', 'PATCH'] as const)(
    '%s returns 404 for malformed group ids before querying',
    async (method) => {
        const ev = makeEvent();
        ev.params.id = 'not-a-uuid';
        const response = await def.handlers[method]!(ev, makeCtx({}));
        expect(response.status).toBe(404);
        expect(mockGetLibraryGroupById).not.toHaveBeenCalled();
        expect(mockUpdateLibraryGroup).not.toHaveBeenCalled();
    },
);
