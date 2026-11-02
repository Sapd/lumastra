// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { UserContext } from '$lib/server/types.js';

const { denied } = vi.hoisted(() => ({ denied: vi.fn() }));
vi.mock('$lib/server/cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups: denied,
    toLibraryAccessUser: (user: UserContext) => ({
        isAdmin: user.ownerIsAdmin && user.mediaAccessIsAdmin !== false,
    }),
}));
vi.mock('$lib/server/database/queries/builders/library-access.builder.js', () => ({
    buildLibraryAccessFilter: () => '',
}));
vi.mock('$lib/server/database/queries/builders/age-rating.builder.js', () => ({
    buildSeriesOwnedAgeRatingFilter: () => '',
}));
vi.mock('$lib/server/cache/valkey.js', () => ({
    subscribeToChannel: async () => undefined,
}));
import { checkMediaAccessBatch } from './media-access.js';

const user = { ownerIsAdmin: false, isAgeRestricted: false } as UserContext;
beforeEach(() => {
    denied.mockReset();
    denied.mockResolvedValue(['restricted-group']);
});

it('checks many ids with one content query and one permission lookup', async () => {
    const query = vi.fn().mockResolvedValue([{ id: 'a' }, { id: 'c' }]);
    expect(await checkMediaAccessBatch(query as unknown as Sql, ['a', 'b', 'c'], user)).toEqual(
        new Set(['a', 'c']),
    );
    expect(query.mock.calls.filter((call) => /^\s*SELECT\b/i.test(String(call[0])))).toHaveLength(
        1,
    );
    expect(denied).toHaveBeenCalledTimes(1);
});

it('fails closed on query and permission errors for non-admins', async () => {
    const query = vi.fn().mockRejectedValue(new Error('query failed'));
    expect(await checkMediaAccessBatch(query as unknown as Sql, ['a'], user)).toEqual(new Set());
    denied.mockRejectedValue(new Error('permissions failed'));
    expect(await checkMediaAccessBatch(query as unknown as Sql, ['a'], user)).toEqual(new Set());
});

it('keeps unrestricted unknown UUIDs while checking live audiobook retirement', async () => {
    denied.mockResolvedValue(null);
    const unknownId = '00000000-0000-4000-8000-000000000001';
    const query = vi.fn().mockResolvedValue([{ id: unknownId }]);
    expect(await checkMediaAccessBatch(query as unknown as Sql, [unknownId], user)).toEqual(
        new Set([unknownId]),
    );
    expect(query.mock.calls.filter((call) => /^\s*SELECT\b/i.test(String(call[0])))).toHaveLength(
        1,
    );
});
