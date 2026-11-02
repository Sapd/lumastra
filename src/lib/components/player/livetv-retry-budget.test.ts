// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import {
    LIVETV_RETRY_BUDGET_WINDOW_MS,
    clearLiveTvRetryBudget,
    readLiveTvRetryBudget,
    writeLiveTvRetryBudget,
} from './livetv-retry-budget';

beforeEach(() => sessionStorage.clear());

describe('live TV retry budget storage', () => {
    it('round-trips per station and clears', () => {
        writeLiveTvRetryBudget('a', 2, 1000);
        writeLiveTvRetryBudget('b', 1, 1000);
        expect(readLiveTvRetryBudget('a', 2000)).toBe(2);
        expect(readLiveTvRetryBudget('b', 2000)).toBe(1);
        clearLiveTvRetryBudget('a');
        expect(readLiveTvRetryBudget('a', 2000)).toBe(0);
        expect(readLiveTvRetryBudget('b', 2000)).toBe(1);
    });

    it('ignores a stale or malformed entry', () => {
        writeLiveTvRetryBudget('a', 3, 1000);
        expect(readLiveTvRetryBudget('a', 1000 + LIVETV_RETRY_BUDGET_WINDOW_MS + 1)).toBe(0);
        sessionStorage.setItem('lumastra:livetv-retry:a', '{bad');
        expect(readLiveTvRetryBudget('a')).toBe(0);
    });
});
