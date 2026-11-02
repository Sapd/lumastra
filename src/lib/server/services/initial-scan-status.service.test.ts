// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ progress: vi.fn(), initial: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => vi.fn() }));
vi.mock('$lib/server/database/queries/file-scanner-runs.queries.js', () => ({
    getInitialScanKeys: mocks.initial,
}));
vi.mock(
    '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/progress-store.js',
    () => ({ getScanProgressByKey: mocks.progress }),
);
beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mocks.progress.mockReset();
    mocks.initial.mockReset();
});
afterEach(() => {
    vi.useRealTimers();
});
describe('initial scan status', () => {
    it('reports discovery, rough progress, caches and refreshes after completion', async () => {
        mocks.progress.mockResolvedValue(new Map([['path', { processedFiles: 0 }]]));
        mocks.initial.mockResolvedValue(['path']);
        const { getInitialScanStatus } = await import('./initial-scan-status.service.js');
        expect(await getInitialScanStatus()).toEqual({ initialScanRunning: true, itemsSoFar: 0 });
        mocks.progress.mockResolvedValue(new Map([['path', { processedFiles: 42 }]]));
        expect(await getInitialScanStatus()).toEqual({ initialScanRunning: true, itemsSoFar: 0 });
        expect(mocks.progress).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(5001);
        expect(await getInitialScanStatus()).toEqual({ initialScanRunning: true, itemsSoFar: 42 });
        mocks.progress.mockResolvedValue(new Map());
        await vi.advanceTimersByTimeAsync(5001);
        expect(await getInitialScanStatus()).toEqual({ initialScanRunning: false, itemsSoFar: 0 });
    });
    it('excludes rescans and does not expose paths', async () => {
        mocks.progress.mockResolvedValue(
            new Map([
                ['first', { processedFiles: 7 }],
                ['rescan', { processedFiles: 100 }],
            ]),
        );
        mocks.initial.mockResolvedValue(['first']);
        const { getInitialScanStatus } = await import('./initial-scan-status.service.js');
        expect(await getInitialScanStatus()).toEqual({ initialScanRunning: true, itemsSoFar: 7 });
    });
    it('coalesces concurrent polls', async () => {
        mocks.progress.mockResolvedValue(new Map());
        const { getInitialScanStatus } = await import('./initial-scan-status.service.js');
        await Promise.all([getInitialScanStatus(), getInitialScanStatus()]);
        expect(mocks.progress).toHaveBeenCalledTimes(1);
    });
});
