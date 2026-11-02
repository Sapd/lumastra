// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
    getFileScannerStatus: vi.fn(),
    triggerFileScanner: vi.fn(),
}));
vi.mock('$lib/api/admin', () => api);
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

import { LibraryScanController } from './library-scan-state.svelte';

const idle = { data: { isRunning: false, progress: null, libraries: [] }, error: null };
const running = { data: { isRunning: true, progress: null, libraries: [] }, error: null };

afterEach(() => {
    vi.clearAllMocks();
});

describe('LibraryScanController', () => {
    it('ends a scan that finished before any poll saw it running', async () => {
        api.getFileScannerStatus.mockResolvedValue(idle);
        const scan = new LibraryScanController();
        scan.prepareForNewScan();

        const results: boolean[] = [];
        for (let i = 0; i < LibraryScanController.EXPECT_POLLS; i++) {
            results.push(await scan.poll(() => []));
        }

        // Not forever: after the grace polls it reports "finished" once.
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.at(-1)).toBe(true);
        expect(scan.scanning).toBe(false);
    });

    it('reports a scan seen running as finished on the first idle poll', async () => {
        const scan = new LibraryScanController();
        scan.prepareForNewScan();
        api.getFileScannerStatus.mockResolvedValueOnce(running);
        expect(await scan.poll(() => [])).toBe(false);
        api.getFileScannerStatus.mockResolvedValueOnce(idle);
        expect(await scan.poll(() => [])).toBe(true);
        expect(scan.scanning).toBe(false);
    });

    it('runs one status request at a time', async () => {
        let release!: (v: unknown) => void;
        api.getFileScannerStatus.mockImplementationOnce(
            () => new Promise((resolve) => (release = resolve)),
        );
        const scan = new LibraryScanController();
        const first = scan.poll(() => []);
        expect(await scan.poll(() => [])).toBe(false);
        expect(api.getFileScannerStatus).toHaveBeenCalledTimes(1);
        release(idle);
        await first;
    });

    it('"Stop all" reports a refused abort', async () => {
        api.triggerFileScanner.mockResolvedValue({ data: null, error: 'refused' });
        const scan = new LibraryScanController();
        await scan.abortAll();
        expect(toasts.error).toHaveBeenCalledWith('refused');
        expect(scan.aborting).toBe(false);
    });
});
