// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { getChaptersForEpisode, getChaptersForFile } from './episode-chapters.queries.js';

/** Join the tagged-template literal parts of the Nth `sql` call into one string. */
function sqlTextOf(mockSql: ReturnType<typeof vi.fn>, call = 0): string {
    return (mockSql.mock.calls[call][0] as unknown as TemplateStringsArray).join('?');
}

/**
 * Regression guard for the 500 on GET /api/admin/media/{id}/chapters (and its
 * v1 twin): `media_item_id` is not a column on `episode_chapters`, but
 * MediaChaptersResponseSchema declares it required-and-nullable, so a getter
 * that only does `SELECT ec.*` / `SELECT *` produces rows whose key is absent
 * and blows up the handler's `.parse()`. Every non-series getter must project
 * it from `media_file_items`. Covered end-to-end against a real database in
 * episode-chapters.queries.integration.test.ts; this keeps it catchable in the
 * DB-less unit suite.
 */
describe('media_item_id projection', () => {
    it('getChaptersForEpisode projects media_item_id', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);
        await getChaptersForEpisode(mockSql as never, 'item-1');
        expect(sqlTextOf(mockSql)).toMatch(/media_item_id\b/);
        expect(sqlTextOf(mockSql)).toMatch(/SELECT ec\.\*, mfi\.media_item_id/);
    });

    it('getChaptersForFile projects media_item_id on the ownership-JOIN branch', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);
        await getChaptersForFile(mockSql as never, 'file-1', 'item-1');
        expect(sqlTextOf(mockSql)).toMatch(/SELECT ec\.\*, mfi\.media_item_id/);
    });

    it('getChaptersForFile projects media_item_id on the bare branch', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);
        await getChaptersForFile(mockSql as never, 'file-1');
        const text = sqlTextOf(mockSql);
        expect(text).toMatch(/owner\.media_item_id/);
        // LATERAL, not a plain JOIN: media_file_items is keyed
        // (file_id, media_item_id), so joining would emit one row per link.
        expect(text).toMatch(/LEFT JOIN LATERAL/);
    });
});

describe('getChaptersForFile', () => {
    it('returns results for file without mediaItemId guard', async () => {
        const row = {
            id: 'ch1',
            file_id: 'file-1',
            chapter_index: 0,
            title: 'Intro',
        };
        const mockSql = vi.fn().mockResolvedValue([row]);

        const result = await getChaptersForFile(mockSql as never, 'file-1');

        expect(result).toEqual([row]);
        expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('takes the ownership-JOIN branch when mediaItemId is provided', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);

        const result = await getChaptersForFile(mockSql as never, 'file-1', 'item-1');

        expect(result).toEqual([]);
        expect(mockSql).toHaveBeenCalledTimes(1);
    });
});
