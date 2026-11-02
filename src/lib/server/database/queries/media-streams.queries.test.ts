// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { getStreamsForFile } from './media-streams.queries.js';

describe('getStreamsForFile', () => {
    it('returns results for file without mediaItemId guard', async () => {
        const row = {
            id: 's1',
            file_id: 'file-1',
            stream_type: 'video',
            stream_index: 0,
        };
        const mockSql = vi.fn().mockResolvedValue([row]);

        const result = await getStreamsForFile(mockSql as never, 'file-1');

        expect(result).toEqual([row]);
        expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('takes the ownership-JOIN branch when mediaItemId is provided', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);

        const result = await getStreamsForFile(mockSql as never, 'file-1', 'item-1');

        expect(result).toEqual([]);
        expect(mockSql).toHaveBeenCalledTimes(1);
    });
});
