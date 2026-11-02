// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/library-groups/index.ts POST (create a library group).
 *
 * The endpoint previously carried two divergent body schemas — a docs-only
 * schema advertising `displayName`/`sortOrder` and a runtime gate accepting
 * `mediaType`/`isPublic` (both silently dropped by the INSERT). These tests lock
 * the converged single-schema behaviour: the camelCase wire body maps to the
 * exact snake_case CreateLibraryGroupParams, `displayName` is optional (defaults
 * to `name` server-side), and `name`/`displayName` share the 128-char cap.
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

const mockGetAllLibraryGroups = vi.fn();
const mockCreateLibraryGroup = vi.fn();
vi.mock('$lib/server/database/queries/library-groups.queries.js', () => ({
    getAllLibraryGroups: (...args: unknown[]) => mockGetAllLibraryGroups(...args),
    createLibraryGroup: (...args: unknown[]) => mockCreateLibraryGroup(...args),
}));

const { def } = await import('./index.js');

const GROUP_ID = '11111111-2222-4333-8444-555555555555';

/** A library_groups row as createLibraryGroup returns it. */
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

function callPost(body: unknown): Promise<Response> {
    const handler = def.handlers.POST!;
    return Promise.resolve(handler({} as RequestEvent, makeCtx(body)));
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockCreateLibraryGroup.mockResolvedValue(makeGroupRow());
});

describe('POST /library-groups request schema', () => {
    it('accepts a minimal body with only name', () => {
        expect(bodySchema.safeParse({ name: 'Movies' }).success).toBe(true);
    });

    it('accepts name + displayName + sortOrder', () => {
        const result = bodySchema.safeParse({
            name: 'Movies',
            displayName: 'My Movies',
            sortOrder: 5,
        });
        expect(result.success).toBe(true);
    });

    it('rejects an empty name', () => {
        expect(bodySchema.safeParse({ name: '' }).success).toBe(false);
    });

    it('rejects a name longer than 128 chars', () => {
        expect(bodySchema.safeParse({ name: 'x'.repeat(129) }).success).toBe(false);
    });

    it('rejects a displayName longer than 128 chars', () => {
        const result = bodySchema.safeParse({ name: 'Movies', displayName: 'x'.repeat(129) });
        expect(result.success).toBe(false);
    });
});

describe('POST /library-groups handler', () => {
    it('maps the camelCase body to snake_case insert params', async () => {
        const response = await callPost({
            name: 'Movies',
            displayName: 'My Movies',
            sortOrder: 5,
        });

        expect(response.status).toBe(201);
        expect(mockCreateLibraryGroup).toHaveBeenCalledTimes(1);
        const [, params] = mockCreateLibraryGroup.mock.calls[0];
        expect(params).toEqual({
            name: 'Movies',
            display_name: 'My Movies',
            sort_order: 5,
        });

        const payload = (await response.json()) as { group: Record<string, unknown> };
        expect(payload.group.id).toBe(GROUP_ID);
        expect(payload.group.displayName).toBe('My Movies');
    });

    it('passes undefined display_name/sort_order when omitted (query defaults them)', async () => {
        await callPost({ name: 'Movies' });

        const [, params] = mockCreateLibraryGroup.mock.calls[0];
        expect(params).toEqual({
            name: 'Movies',
            display_name: undefined,
            sort_order: undefined,
        });
    });

    it('returns 503 when the database is unavailable', async () => {
        mockGetDb.mockReturnValue(null);

        const response = await callPost({ name: 'Movies' });

        expect(response.status).toBe(503);
        expect(mockCreateLibraryGroup).not.toHaveBeenCalled();
    });
});
