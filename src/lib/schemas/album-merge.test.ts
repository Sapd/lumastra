// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { AlbumMergeOptionsSchema } from './album-merge.js';
import { MergeMediaRequestSchema } from '../server/api/defs/admin/media/_merge-docs.js';

const pair = {
    keepId: '10000000-0000-4000-8000-000000000001',
    mergeId: '10000000-0000-4000-8000-000000000002',
};
describe('album merge title validation', () => {
    it('trims only the title and leaves the other options unchanged', () => {
        const input = { ...pair, mode: 'preview', title: '  Lunar Lanterns  ' };
        expect(MergeMediaRequestSchema.parse(input)).toEqual({ ...input, title: 'Lunar Lanterns' });
        expect(
            AlbumMergeOptionsSchema.parse({ ...pair, title: 'X'.repeat(500) }).title,
        ).toHaveLength(500);
    });
    it.each(['', '   ', 'X'.repeat(501), null, 42])('rejects invalid title %j', (title) => {
        expect(MergeMediaRequestSchema.safeParse({ ...pair, mode: 'preview', title }).success).toBe(
            false,
        );
    });
    it('rejects title in legacy media mode but accepts requests without a title', () => {
        expect(
            MergeMediaRequestSchema.safeParse({ ...pair, title: 'Lunar Lanterns' }).success,
        ).toBe(false);
        expect(MergeMediaRequestSchema.parse(pair)).toEqual(pair);
    });
});
