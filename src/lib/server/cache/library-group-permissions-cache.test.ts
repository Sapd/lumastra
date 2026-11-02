// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const { mockGetAll } = vi.hoisted(() => ({ mockGetAll: vi.fn() }));

vi.mock('../database/queries/library-group-permissions.queries.js', () => ({
    getAllLibraryGroupPermissions: mockGetAll,
}));
vi.mock('./valkey.js', () => ({
    publishMessage: vi.fn(async () => {}),
    subscribeToChannel: vi.fn(async () => null),
}));

import {
    getDeniedLibraryGroups,
    invalidateLibraryGroupPermissionsCache,
} from './library-group-permissions-cache.js';

const sql = {} as postgres.Sql;
const user = { isAdmin: false, userGroups: ['adults'] };
const KIDS_ONLY = [{ library_group_id: 'g-restricted', allowed_groups: ['kids'] }];

beforeEach(() => {
    mockGetAll.mockReset();
    invalidateLibraryGroupPermissionsCache();
});

describe('library group permissions cache', () => {
    it('does not cache a load that was in flight when the permissions changed', async () => {
        // A request starts loading BEFORE the admin adds the restriction…
        let release!: (rows: unknown[]) => void;
        mockGetAll.mockImplementationOnce(
            () => new Promise((resolve) => (release = resolve as (rows: unknown[]) => void)),
        );
        const inFlight = getDeniedLibraryGroups(sql, user);

        // …the admin saves (invalidate), then the old read completes.
        invalidateLibraryGroupPermissionsCache();
        release([]);
        expect(await inFlight).toBeNull();

        // The next request must read the new rows, not the stale empty map.
        mockGetAll.mockResolvedValueOnce(KIDS_ONLY);
        expect(await getDeniedLibraryGroups(sql, user)).toEqual(['g-restricted']);
        expect(mockGetAll).toHaveBeenCalledTimes(2);
    });

    it('serves from the cache when nothing changed', async () => {
        mockGetAll.mockResolvedValue(KIDS_ONLY);
        await getDeniedLibraryGroups(sql, user);
        await getDeniedLibraryGroups(sql, user);
        expect(mockGetAll).toHaveBeenCalledTimes(1);
    });
});
