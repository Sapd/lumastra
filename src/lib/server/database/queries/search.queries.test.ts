// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { searchMedia, searchMediaFulltext } from './search.queries.js';
import { unrestrictedAccess, denyAllAccess } from './builders/media-access-boundary.js';

describe.each([searchMedia, searchMediaFulltext])('catalog search %s', (search) => {
    it('does not turn database errors into successful empty results', async () => {
        const failure = new Error('Database unavailable');
        const sql = vi.fn(() => {
            throw failure;
        }) as unknown as postgres.Sql;
        await expect(search(sql, 'matrix', unrestrictedAccess())).rejects.toBe(failure);
    });

    it('executes filter-only searches while preserving the deny-all boundary', async () => {
        const failure = new Error('SQL reached');
        const sql = vi.fn(() => {
            throw failure;
        }) as unknown as postgres.Sql;
        await expect(
            search(sql, '*', denyAllAccess(), { filters: { yearMin: 2020 } }),
        ).resolves.toEqual([]);
        expect(sql).not.toHaveBeenCalled();
        await expect(
            search(sql, '*', unrestrictedAccess(), { filters: { yearMin: 2020 } }),
        ).rejects.toBe(failure);
    });
});
