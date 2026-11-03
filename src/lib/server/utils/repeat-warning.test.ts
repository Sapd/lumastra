// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepeatWarning } from './repeat-warning.js';

describe('createRepeatWarning', () => {
    afterEach(() => vi.useRealTimers());

    it('warns once per window, counts the repeats and sends them to debug', () => {
        vi.useFakeTimers();
        const log = { warn: vi.fn(), debug: vi.fn() };
        const w = createRepeatWarning(log, 1_000);
        for (let i = 0; i < 5; i++) {
            w.warn('pass error', { err: 'ENOTFOUND' });
            vi.advanceTimersByTime(100);
        }
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.debug).toHaveBeenCalledTimes(4);
        vi.advanceTimersByTime(1_000);
        w.warn('pass error', { err: 'ENOTFOUND' });
        expect(log.warn).toHaveBeenCalledTimes(2);
        expect(log.warn.mock.calls[1][1]).toMatchObject({ repeatsSinceLastWarning: 4 });
    });

    it('warns again at once after reset()', () => {
        const log = { warn: vi.fn(), debug: vi.fn() };
        const w = createRepeatWarning(log, 60_000);
        w.warn('x');
        w.reset();
        w.warn('x');
        expect(log.warn).toHaveBeenCalledTimes(2);
    });
});
