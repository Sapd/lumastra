// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { ChartConfiguration } from 'chart.js';
import type { WatchTimeStats } from '$lib/types/personal-stats';
import WatchTimeChart from './WatchTimeChart.svelte';

const chart = vi.hoisted(() => ({
    create: vi.fn<(config: ChartConfiguration) => void>(),
    destroy: vi.fn<() => void>(),
}));
vi.mock('chart.js', () => ({
    Chart: class {
        static register(): void {}
        constructor(_ctx: unknown, config: ChartConfiguration) {
            chart.create(config);
        }
        destroy(): void {
            chart.destroy();
        }
    },
    CategoryScale: {},
    LinearScale: {},
    BarElement: {},
    BarController: {},
    Title: {},
    Tooltip: {},
    Legend: {},
    Filler: {},
}));

function series(seconds: number): WatchTimeStats {
    return {
        periods: [
            {
                period: '2026-09-20',
                watchTimeSeconds: seconds,
                watchTimeFormatted: `${seconds / 60}m`,
                sessionCount: 1,
            },
        ],
        totalWatchTimeSeconds: seconds,
        avgPerPeriod: seconds,
        trend: 'stable',
        trendPercentage: 0,
    };
}

beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        createLinearGradient: () => ({ addColorStop: vi.fn() }),
    } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

test('new period data replaces bar values and destroys the old chart', async () => {
    const view = render(WatchTimeChart, { data: series(600), period: '7d' });
    flushSync();
    expect(chart.create.mock.calls[0][0].data.datasets[0].data).toEqual([10]);
    await view.rerender({ data: series(1200), period: '30d' });
    flushSync();
    expect(chart.destroy).toHaveBeenCalledOnce();
    expect(chart.create).toHaveBeenCalledTimes(2);
    expect(chart.create.mock.calls[1][0].data.datasets[0].data).toEqual([20]);
});

test('empty periods remove the chart and later results recreate it', async () => {
    const view = render(WatchTimeChart, { data: series(600), period: '7d' });
    flushSync();
    await view.rerender({ data: { ...series(0), periods: [] }, period: '30d' });
    flushSync();
    expect(chart.destroy).toHaveBeenCalledOnce();
    expect(view.container.querySelector('canvas')).toBeNull();
    await view.rerender({ data: series(1800), period: 'all' });
    flushSync();
    expect(chart.create).toHaveBeenCalledTimes(2);
    expect(chart.create.mock.calls[1][0].data.datasets[0].data).toEqual([30]);
});
