// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutosave } from './autosave';

afterEach(() => {
    vi.useRealTimers();
});

describe('createAutosave', () => {
    it('folds a burst of edits into one save', async () => {
        vi.useFakeTimers();
        const save = vi.fn(async () => {});
        const a = createAutosave(save, 600);
        a.schedule();
        a.schedule();
        a.schedule();
        await vi.advanceTimersByTimeAsync(700);
        expect(save).toHaveBeenCalledTimes(1);
    });

    // Found by review: leaving the page while a save was in flight started a
    // second request at once, and the older one could land last.
    it('a flush while a save is in flight waits for it instead of overlapping', async () => {
        vi.useFakeTimers();
        let inFlight = 0;
        let maxInFlight = 0;
        const save = vi.fn(async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 1000));
            inFlight -= 1;
        });
        const a = createAutosave(save, 600);
        a.schedule();
        await vi.advanceTimersByTimeAsync(700); // first save starts
        a.schedule(); // another edit
        const flushed = a.flush(); // user leaves the page
        await vi.advanceTimersByTimeAsync(3000);
        await flushed;
        expect(save).toHaveBeenCalledTimes(2);
        expect(maxInFlight).toBe(1);
    });

    it('flush without a pending edit saves nothing', async () => {
        const save = vi.fn(async () => {});
        const a = createAutosave(save, 600);
        await a.flush();
        expect(save).not.toHaveBeenCalled();
    });

    it('a failed save does not wedge later ones', async () => {
        vi.useFakeTimers();
        const save = vi
            .fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValue(undefined);
        const a = createAutosave(save, 10);
        a.schedule();
        await vi.advanceTimersByTimeAsync(20);
        a.schedule();
        await vi.advanceTimersByTimeAsync(20);
        expect(save).toHaveBeenCalledTimes(2);
    });
});
