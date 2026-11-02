// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveTvStartupDeadline } from './livetv-startup-deadline.js';
afterEach(() => vi.useRealTimers());
describe('Live TV startup deadline', () => {
    it('bounds stalled fetch/native/HLS startup and aborts the pending attempt', () => {
        vi.useFakeTimers();
        const expired = vi.fn();
        const deadline = new LiveTvStartupDeadline();
        const signal = deadline.begin(expired);
        vi.advanceTimersByTime(25_000);
        expect(expired).toHaveBeenCalledOnce();
        expect(signal.aborted).toBe(true);
    });
    it('retry and channel switches cancel old attempts without allowing late expiration to replace the new state', () => {
        vi.useFakeTimers();
        const deadline = new LiveTvStartupDeadline();
        const oldExpired = vi.fn();
        const newExpired = vi.fn();
        const oldSignal = deadline.begin(oldExpired);
        vi.advanceTimersByTime(20_000);
        deadline.begin(newExpired);
        expect(oldSignal.aborted).toBe(true);
        vi.advanceTimersByTime(5000);
        expect(oldExpired).not.toHaveBeenCalled();
        expect(newExpired).not.toHaveBeenCalled();
        deadline.cancel();
        vi.advanceTimersByTime(25_000);
        expect(newExpired).not.toHaveBeenCalled();
    });
    it('genuine progress and pause cancel the watchdog without aborting established playback', () => {
        vi.useFakeTimers();
        const deadline = new LiveTvStartupDeadline();
        const expired = vi.fn();
        const signal = deadline.begin(expired);
        deadline.cancel(false);
        vi.advanceTimersByTime(30_000);
        expect(expired).not.toHaveBeenCalled();
        expect(signal.aborted).toBe(false);
    });
});
