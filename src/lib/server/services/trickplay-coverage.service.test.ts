// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { getTrickplayBacklogCounts } from '../database/queries/trickplay-params.queries.js';
import { getTrickplayDisplayCounts } from './trickplay-coverage.service.js';

vi.mock('../database/queries/trickplay-params.queries.js', () => ({
    TRICKPLAY_PARAMS_PROCESSING_VERSION: 3,
    getTrickplayBacklogCounts: vi.fn(),
}));
const counts = { analyzed: 12, remaining: 3, ineligible: 2, failed: 1 };
const pool = (): postgres.Sql => (() => {}) as unknown as postgres.Sql;
afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
});
describe('trickplay display polling', () => {
    it('coalesces concurrent displays and does not extend freshness on hits', async () => {
        vi.useFakeTimers();
        const db = pool();
        vi.mocked(getTrickplayBacklogCounts).mockResolvedValue(counts);
        const results = await Promise.all(
            Array.from({ length: 20 }, () => getTrickplayDisplayCounts(db)),
        );
        expect(getTrickplayBacklogCounts).toHaveBeenCalledTimes(1);
        expect(results).toEqual(Array.from({ length: 20 }, () => counts));
        results[0].remaining = 999;
        vi.advanceTimersByTime(29_999);
        expect(await getTrickplayDisplayCounts(db)).toEqual(counts);
        expect(getTrickplayBacklogCounts).toHaveBeenCalledTimes(1);
        vi.mocked(getTrickplayBacklogCounts).mockResolvedValue({ ...counts, remaining: 1 });
        vi.advanceTimersByTime(1);
        expect((await getTrickplayDisplayCounts(db)).remaining).toBe(1);
        expect(getTrickplayBacklogCounts).toHaveBeenCalledTimes(2);
    });
    it('isolates DB pools and retries a failed reading immediately', async () => {
        const db = pool();
        vi.mocked(getTrickplayBacklogCounts)
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValue(counts);
        await expect(getTrickplayDisplayCounts(db)).rejects.toThrow('offline');
        expect(await getTrickplayDisplayCounts(db)).toEqual(counts);
        expect(await getTrickplayDisplayCounts(pool())).toEqual(counts);
        expect(getTrickplayBacklogCounts).toHaveBeenCalledTimes(3);
    });
});
