// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { runSpeedTest, postSpeedTestResult, toastError } = vi.hoisted(() => ({
    runSpeedTest: vi.fn(),
    postSpeedTestResult: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock('$lib/utils/network/speed-test-client', () => ({
    runSpeedTest,
    SPEED_TEST_BUCKET_MS: 250,
    SPEED_TEST_CAP_MS: 20_000,
}));
vi.mock('$lib/api/playback', () => ({ postSpeedTestResult }));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: toastError, success: vi.fn() },
}));
vi.mock('$lib/components/player/device-id', () => ({ getDeviceId: () => 'dashboard-test' }));

import ConnectionSection from './ConnectionSection.svelte';

const measurement = {
    bytesRequested: 16 * 1024 * 1024,
    bytesReceived: 16 * 1024 * 1024,
    durationMs: 2000,
    ttfbMs: 40,
    aborted: false,
    buckets: [{ ms: 250, bytes: 1000 }],
};

/** The 201 body a cadence run comes back with — buckets-based fields are null. */
const cadenceStored = {
    id: 9,
    mode: 'cadence' as const,
    throughputBps: 24_800_000,
    ttfbMs: 38,
    minBucketBps: null,
    stallMs: 0,
    requestCount: 8,
    maxTtfbMs: 910,
    minRequestBps: 4_200_000,
    bytesReceived: 8 * 4 * 1024 * 1024,
    durationMs: 31_000,
    aborted: false,
    createdAt: '2026-09-13T10:00:00.000Z',
};

describe('ConnectionSection', () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        localStorage.clear();
    });

    test('renders the Test connection button', () => {
        render(ConnectionSection, {});
        expect(screen.getByRole('button', { name: /Test connection/i })).toBeTruthy();
    });

    test('posts the measurement with device and client info, then renders the stored numbers', async () => {
        runSpeedTest.mockResolvedValue(measurement);
        postSpeedTestResult.mockResolvedValue({
            data: {
                id: 7,
                throughputBps: 67_100_000,
                ttfbMs: 41,
                minBucketBps: 12_340_000,
                stallMs: 250,
                bytesReceived: measurement.bytesReceived,
                durationMs: 2000,
                aborted: false,
                createdAt: '2026-09-12T10:00:00.000Z',
            },
            error: null,
            status: 201,
        });

        render(ConnectionSection, {});
        await fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));

        await waitFor(() => {
            // One decimal for Mbit/s, integers for the millisecond figures.
            expect(screen.getByText(/67\.1 Mbit\/s/)).toBeTruthy();
        });
        expect(screen.getByText(/first byte 41 ms/)).toBeTruthy();
        expect(screen.getByText(/slowest ¼ s 12\.3 Mbit\/s/)).toBeTruthy();
        expect(screen.getByText(/stalled 250 ms/)).toBeTruthy();

        expect(postSpeedTestResult).toHaveBeenCalledTimes(1);
        const body = postSpeedTestResult.mock.calls[0][0];
        expect(body).toMatchObject({ ...measurement, deviceId: 'dashboard-test' });
        expect(body.clientInfo.engine).toBe('web');
        expect(typeof body.clientInfo.ua).toBe('string');
    });

    test('a failed test shows the failure inline and as a toast', async () => {
        runSpeedTest.mockRejectedValue(new Error('offline'));

        render(ConnectionSection, {});
        await fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));

        await waitFor(() => {
            expect(screen.getByText(/could not be completed/i)).toBeTruthy();
        });
        expect(toastError).toHaveBeenCalledWith('The test could not be completed.');
        expect(postSpeedTestResult).not.toHaveBeenCalled();
    });

    test('a rejected POST is a failure too — no result line is invented', async () => {
        runSpeedTest.mockResolvedValue(measurement);
        postSpeedTestResult.mockResolvedValue({ data: null, error: 'Rate limited', status: 429 });

        render(ConnectionSection, {});
        await fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));

        await waitFor(() => {
            expect(screen.getByText(/could not be completed/i)).toBeTruthy();
        });
        expect(screen.queryByText(/Mbit\/s/)).toBeNull();
    });

    test('shows progress while the download is running', async () => {
        let release: (() => void) | undefined;
        runSpeedTest.mockImplementation(
            async (opts: {
                onProgress?: (p: { bytesReceived: number; elapsedMs: number }) => void;
            }) =>
                new Promise((resolve) => {
                    opts.onProgress?.({ bytesReceived: 4 * 1024 * 1024, elapsedMs: 500 });
                    release = () => resolve(measurement);
                }),
        );
        postSpeedTestResult.mockResolvedValue({ data: null, error: 'not reached', status: 500 });

        render(ConnectionSection, {});
        await fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));

        await waitFor(() => {
            const bar = screen.getByRole('progressbar');
            expect(bar.getAttribute('aria-valuenow')).toBe(String(4 * 1024 * 1024));
        });
        // Exact match, not a substring: the "Segment cadence (8 x 4 MB, 2 s
        // apart)" option also contains "4 MB".
        expect(screen.getByText('4 MB')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Testing/i })).toBeTruthy();

        release?.();
        await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
    });
});

describe('ConnectionSection — test profiles', () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        localStorage.clear();
    });

    test('offers the three profiles and defaults to the quick one', () => {
        render(ConnectionSection, {});
        const select = screen.getByRole('combobox', { name: /Test profile/i }) as HTMLSelectElement;
        expect(select.value).toBe('single');
        expect([...select.options].map((o) => o.value)).toEqual(['single', 'long', 'cadence']);
        expect(screen.getByRole('option', { name: 'Quick (16 MB)' })).toBeTruthy();
        expect(screen.getByRole('option', { name: 'Long (64 MB, up to 60 s)' })).toBeTruthy();
        expect(
            screen.getByRole('option', { name: 'Segment cadence (8 × 4 MB, 2 s apart)' }),
        ).toBeTruthy();
    });

    test('remembers the chosen profile across a remount', async () => {
        const first = render(ConnectionSection, {});
        await fireEvent.change(screen.getByRole('combobox', { name: /Test profile/i }), {
            target: { value: 'cadence' },
        });
        expect(localStorage.getItem('dashboard_speed_test_mode')).toBe('cadence');

        // A reload is a fresh mount reading the same storage — not component state.
        first.unmount();
        render(ConnectionSection, {});
        expect(
            (screen.getByRole('combobox', { name: /Test profile/i }) as HTMLSelectElement).value,
        ).toBe('cadence');
    });

    test('a stored value the schema does not know falls back to the quick profile', () => {
        localStorage.setItem('dashboard_speed_test_mode', 'turbo');
        render(ConnectionSection, {});
        expect(
            (screen.getByRole('combobox', { name: /Test profile/i }) as HTMLSelectElement).value,
        ).toBe('single');
    });

    test('runs the selected profile and posts it alongside the measurement', async () => {
        runSpeedTest.mockResolvedValue({
            bytesRequested: 8 * 4 * 1024 * 1024,
            bytesReceived: 8 * 4 * 1024 * 1024,
            durationMs: 31_000,
            ttfbMs: 38,
            aborted: false,
            buckets: [],
            requests: Array.from({ length: 8 }, () => ({
                bytes: 4 * 1024 * 1024,
                ttfbMs: 40,
                durationMs: 1400,
            })),
        });
        postSpeedTestResult.mockResolvedValue({ data: cadenceStored, error: null, status: 201 });

        render(ConnectionSection, {});
        await fireEvent.change(screen.getByRole('combobox', { name: /Test profile/i }), {
            target: { value: 'cadence' },
        });
        await fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));

        await waitFor(() => expect(postSpeedTestResult).toHaveBeenCalledTimes(1));
        expect(runSpeedTest).toHaveBeenCalledWith(expect.objectContaining({ mode: 'cadence' }));
        const body = postSpeedTestResult.mock.calls[0][0];
        expect(body.mode).toBe('cadence');
        expect(body.requests).toHaveLength(8);
        expect(body.buckets).toEqual([]);
    });

    test('a cadence result reads as segments, not as a slowest quarter-second', async () => {
        runSpeedTest.mockResolvedValue({
            bytesRequested: 8 * 4 * 1024 * 1024,
            bytesReceived: 8 * 4 * 1024 * 1024,
            durationMs: 31_000,
            ttfbMs: 38,
            aborted: false,
            buckets: [],
            requests: [{ bytes: 4 * 1024 * 1024, ttfbMs: 40, durationMs: 1400 }],
        });
        postSpeedTestResult.mockResolvedValue({ data: cadenceStored, error: null, status: 201 });

        render(ConnectionSection, {});
        await fireEvent.change(screen.getByRole('combobox', { name: /Test profile/i }), {
            target: { value: 'cadence' },
        });
        await fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));

        await waitFor(() => expect(screen.getByText(/24\.8 Mbit\/s/)).toBeTruthy());
        expect(screen.getByText(/over 8 segments/)).toBeTruthy();
        expect(screen.getByText(/worst segment 4\.2 Mbit\/s/)).toBeTruthy();
        expect(screen.getByText(/worst first byte 910 ms/)).toBeTruthy();
        // The buckets sentence must NOT appear — there were no buckets.
        expect(screen.queryByText(/slowest ¼ s/)).toBeNull();
        expect(screen.queryByText(/stalled/)).toBeNull();
    });

    test('switching profile clears a result that described the previous one', async () => {
        runSpeedTest.mockResolvedValue(measurement);
        postSpeedTestResult.mockResolvedValue({
            data: {
                id: 3,
                mode: 'single' as const,
                throughputBps: 67_100_000,
                ttfbMs: 41,
                minBucketBps: 12_340_000,
                stallMs: 250,
                requestCount: 1,
                maxTtfbMs: null,
                minRequestBps: null,
                bytesReceived: measurement.bytesReceived,
                durationMs: 2000,
                aborted: false,
                createdAt: '2026-09-13T10:00:00.000Z',
            },
            error: null,
            status: 201,
        });

        render(ConnectionSection, {});
        await fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));
        await waitFor(() => expect(screen.getByText(/67\.1 Mbit\/s/)).toBeTruthy());

        await fireEvent.change(screen.getByRole('combobox', { name: /Test profile/i }), {
            target: { value: 'long' },
        });
        expect(screen.queryByText(/67\.1 Mbit\/s/)).toBeNull();
    });
});
