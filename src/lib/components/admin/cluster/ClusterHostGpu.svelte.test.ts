// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ClusterHostGpu from './ClusterHostGpu.svelte';
import type { ClusterHostGroup } from './cluster-hosts.js';

function group(over: Partial<ClusterHostGroup> = {}): ClusterHostGroup {
    return {
        id: 'boot:test',
        known: true,
        services: [],
        serviceRssBytes: 0,
        hostMemoryWarn: false,
        gpuClients: 0,
        gpuAccess: [{ configured: 'qsv', accessible: true }],
        gpus: [
            {
                kind: 'dri',
                device: 'renderD128',
                name: 'Intel Arc A380',
                awakePercent: 100,
                freqMhz: 2400,
                powerWatts: 24.3,
            },
        ],
        ...over,
    };
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('GPU device and activity hierarchy', () => {
    it('links configuration and the auto-opening diagnostic panel from a GPU access failure', () => {
        render(ClusterHostGpu, {
            group: group({
                gpuAccess: [{ configured: 'qsv', accessible: false, error: 'Permission denied' }],
            }),
        });
        expect(
            screen
                .getByRole('link', { name: 'Configure hardware acceleration' })
                .getAttribute('href'),
        ).toContain('/admin/settings/playback?category=ffmpeg-hardware');
        expect(
            screen
                .getByRole('link', { name: 'GPU diagnostics & activity' })
                .getAttribute('href'),
        ).toContain('/admin/system/health?tab=cluster#hardware-encoder-check');
    });
    it('keeps Intel device readiness visible without inventing utilization, temperature or VRAM', async () => {
        render(ClusterHostGpu, { group: group() });
        await tick();
        expect(screen.getByText('Intel Arc A380')).toBeTruthy();
        expect(screen.getByText('QSV ready')).toBeTruthy();
        expect(screen.getByText('Host-wide utilization is not measured')).toBeTruthy();
        expect(screen.getByTestId('cluster-host-gpu-video-unavailable')).toBeTruthy();
        expect(screen.queryByRole('meter')).toBeNull();
        expect(screen.queryByText('Temperature')).toBeNull();
        expect(screen.queryByText('VRAM')).toBeNull();
        expect(
            screen.getByTestId('cluster-host-gpu-sparkline').querySelector('polyline'),
        ).toBeNull();
    });
    it('labels host utilization separately from Lumastra activity and clamps meter widths', () => {
        render(ClusterHostGpu, {
            group: group({
                gpuClients: 2,
                gpuEngines: { video: 145, render: -1 },
                gpus: [
                    {
                        kind: 'nvidia',
                        device: 'nvidia0',
                        busyPercent: 60,
                        encoderPercent: 25,
                        encodeSessions: 2,
                        maxEncodeSessions: 2,
                        memUsedBytes: 1024 ** 3,
                        memTotalBytes: 4 * 1024 ** 3,
                        temperatureC: 42,
                    },
                ],
            }),
        });
        expect(
            screen
                .getByRole('meter', { name: 'nvidia0: Utilization' })
                .getAttribute('aria-valuenow'),
        ).toBe('60');
        const video = screen.getByRole('meter', { name: /Lumastra processing activity: Video/ });
        expect(video.getAttribute('aria-valuenow')).toBe('100');
        expect(
            within(screen.getByTestId('cluster-host-gpu-engine-video')).getByText('100 %'),
        ).toBeTruthy();
        expect(
            within(screen.getByTestId('cluster-host-gpu-engine-render')).getByText('0 %'),
        ).toBeTruthy();
        expect(video.firstElementChild?.getAttribute('style')).toContain('width: 100%');
        expect(
            screen
                .getByRole('meter', { name: /Lumastra processing activity: Render/ })
                .getAttribute('aria-valuenow'),
        ).toBe('0');
        expect(
            screen.getByText('At least one GPU has reached its encoder session limit'),
        ).toBeTruthy();
        expect(screen.getByText('Temperature')).toBeTruthy();
        expect(screen.getByText('VRAM')).toBeTruthy();
    });
    it('a successful refresh with missing engines breaks the chart instead of falling to zero', async () => {
        const view = render(ClusterHostGpu, {
            group: group({ gpuClients: 1, gpuEngines: { video: 40 } }),
        });
        await tick();
        await view.rerender({ group: group({ gpuClients: 1, gpuEngines: { video: 60 } }) });
        const chart = screen.getByTestId('cluster-host-gpu-sparkline');
        expect(chart.querySelector('polyline')?.getAttribute('points')).toContain(',40.00');
        await view.rerender({ group: group() });
        expect(chart.querySelector('polyline')?.getAttribute('points')).not.toContain(',100.00');
        expect(screen.getByTestId('cluster-host-gpu-video-unavailable')).toBeTruthy();
        await view.rerender({ group: group({ gpuEngines: { video: 0 } }) });
        expect(chart.querySelectorAll('polyline')).toHaveLength(1);
        expect(
            within(screen.getByTestId('cluster-host-gpu-engine-video')).getByText('0 %'),
        ).toBeTruthy();
    });
});

it('an unknown zero encoder cap never renders a maximum or a capacity warning', () => {
    render(ClusterHostGpu, {
        group: group({
            gpus: [{ kind: 'nvidia', device: 'nvidia0', encodeSessions: 2, maxEncodeSessions: 0 }],
        }),
    });
    expect(screen.getByText('2 encode sessions')).toBeTruthy();
    expect(screen.queryByText(/2 \/ 0 encode sessions/)).toBeNull();
    expect(screen.queryByText(/reached its encoder session limit/)).toBeNull();
});

it('keeps recovery measurements separate from earlier samples after missed poll intervals', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
    const view = render(ClusterHostGpu, { group: group({ gpuEngines: { video: 40 } }) });
    await tick();
    vi.setSystemTime(new Date('2026-10-23T12:00:30Z'));
    await view.rerender({ group: group({ gpuEngines: { video: 70 } }) });
    expect(screen.getByTestId('cluster-host-gpu-sparkline').querySelector('polyline')).toBeNull();
    expect(
        within(screen.getByTestId('cluster-host-gpu-history-values'))
            .getAllByRole('listitem')
            .map((el) => el.textContent),
    ).toEqual(['40 %', 'Not measured', 'Not measured', '70 %']);
});
