// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LibraryGrowthSparkline from './LibraryGrowthSparkline.svelte';
import type {
    LibraryStorageGrowth,
    LibraryVolumeGrowth,
} from '$lib/schemas/admin-library-storage-growth';

const api = vi.hoisted(() => ({ growth: vi.fn() }));
vi.mock('$lib/api/admin.js', () => ({ getLibraryStorageGrowth: api.growth }));

const TB = 1e12;

function growth(overrides: Partial<LibraryStorageGrowth> = {}): LibraryStorageGrowth {
    return {
        generatedAt: '2026-10-21T00:00:00Z',
        series: [
            { date: '2026-08-01', bytes: 40 * TB, approximate: false },
            { date: '2026-09-01', bytes: 44 * TB, approximate: false },
            { date: '2026-10-01', bytes: 48 * TB, approximate: false },
            { date: '2026-10-20', bytes: 53 * TB, approximate: false },
        ],
        byMediaType: [],
        volumes: [],
        ...overrides,
    };
}

function volume(estimate: LibraryVolumeGrowth['estimate']): LibraryVolumeGrowth {
    return {
        id: 'v1',
        libraries: ['Movies'],
        freeBytes: 4 * TB,
        totalBytes: 60 * TB,
        measuredOn: '2026-10-20',
        estimate,
    };
}

beforeEach(() => {
    api.growth.mockReset();
});
afterEach(cleanup);

async function renderWith(result: unknown) {
    api.growth.mockResolvedValue(result);
    const view = render(LibraryGrowthSparkline);
    await waitFor(() => expect(api.growth).toHaveBeenCalled());
    // let the resolved promise flush into state
    await new Promise((r) => setTimeout(r, 0));
    return view;
}

describe('LibraryGrowthSparkline', () => {
    it('renders nothing with fewer than two points', async () => {
        await renderWith({
            data: growth({ series: [{ date: '2026-10-20', bytes: TB, approximate: false }] }),
        });
        expect(screen.queryByTestId('library-growth')).toBeNull();
    });

    it('still shows the forecast when there is no curve to draw', async () => {
        await renderWith({
            data: growth({
                series: [{ date: '2026-10-20', bytes: TB, approximate: false }],
                volumes: [
                    volume({
                        state: 'filling',
                        daysUntilFull: 30,
                        daysUntilFullLow: 30,
                        bytesPerDay: 1,
                    }),
                ],
            }),
        });
        expect(screen.getByTestId('growth-forecast').dataset.tone).toBe('critical');
        expect(screen.queryByRole('slider')).toBeNull();
    });

    it('renders nothing on a fetch error', async () => {
        await renderWith({ error: 'boom' });
        expect(screen.queryByTestId('library-growth')).toBeNull();
    });

    it('renders nothing when the request throws', async () => {
        api.growth.mockRejectedValue(new Error('network'));
        render(LibraryGrowthSparkline);
        await waitFor(() => expect(api.growth).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 0));
        expect(screen.queryByTestId('library-growth')).toBeNull();
    });

    it('draws the line and the latest dot for a normal series', async () => {
        const { container } = await renderWith({ data: growth() });
        await screen.findByTestId('library-growth');
        const line = screen.getByTestId('growth-line-solid');
        expect(line.getAttribute('d')).toMatch(/^M/);
        expect(screen.queryByTestId('growth-line-approx')).toBeNull();
        expect(screen.getByTestId('growth-latest-dot')).toBeTruthy();
        expect(container.querySelector('[role="slider"]')?.getAttribute('aria-label')).toContain(
            'grew from',
        );
    });

    it('draws approximate points dashed', async () => {
        const g = growth();
        g.series[0].approximate = true;
        g.series[1].approximate = true;
        await renderWith({ data: g });
        const dashed = await screen.findByTestId('growth-line-approx');
        expect(dashed.getAttribute('stroke-dasharray')).toBeTruthy();
        expect(screen.getByTestId('growth-line-solid').getAttribute('stroke-dasharray')).toBeNull();
    });

    it('shows the forecast with a warning tone', async () => {
        await renderWith({
            data: growth({
                volumes: [
                    volume({
                        state: 'filling',
                        daysUntilFull: 120,
                        daysUntilFullLow: 90,
                        daysUntilFullHigh: 150,
                        bytesPerDay: 1e11,
                    }),
                ],
            }),
        });
        const line = await screen.findByTestId('growth-forecast');
        expect(line.textContent).toContain('until full');
        expect(line.className).toContain('text-amber-400');
        expect(line.getAttribute('data-tone')).toBe('warning');
    });

    it('shows the forecast with a critical tone', async () => {
        await renderWith({
            data: growth({
                volumes: [
                    volume({
                        state: 'filling',
                        daysUntilFull: 30,
                        daysUntilFullLow: 20,
                        daysUntilFullHigh: 40,
                        bytesPerDay: 1e11,
                    }),
                ],
            }),
        });
        const line = await screen.findByTestId('growth-forecast');
        expect(line.className).toContain('text-red-400');
        expect(line.getAttribute('data-tone')).toBe('critical');
    });

    it('hides the forecast when there are no volumes but keeps the chart', async () => {
        await renderWith({ data: growth({ volumes: [] }) });
        await screen.findByTestId('library-growth');
        expect(screen.queryByTestId('growth-forecast')).toBeNull();
    });

    it('explains insufficient data', async () => {
        await renderWith({
            data: growth({ volumes: [volume({ state: 'insufficient_data', snapshotDays: 4 })] }),
        });
        const line = await screen.findByTestId('growth-forecast');
        expect(line.textContent).toContain('14 days of measurements (4 so far)');
        expect(line.className).toContain('text-surface-400');
    });

    it('ArrowLeft moves the live readout to a date and size, Escape clears it', async () => {
        const { container } = await renderWith({ data: growth() });
        await screen.findByTestId('library-growth');
        const slider = container.querySelector('[role="slider"]') as HTMLElement;
        expect(screen.getByTestId('growth-readout').textContent).toBe('');
        await fireEvent.keyDown(slider, { key: 'ArrowLeft' });
        const readout = screen.getByTestId('growth-readout').textContent ?? '';
        expect(readout).toContain('48.0 TB');
        expect(readout).toContain('2026');
        expect(screen.getByTestId('growth-tooltip')).toBeTruthy();
        await fireEvent.keyDown(slider, { key: 'Home' });
        expect(screen.getByTestId('growth-readout').textContent).toContain('40.0 TB');
        await fireEvent.keyDown(slider, { key: 'Escape' });
        expect(screen.getByTestId('growth-readout').textContent).toBe('');
    });

    it('notes estimated points in the readout', async () => {
        const g = growth();
        g.series[0].approximate = true;
        const { container } = await renderWith({ data: g });
        await screen.findByTestId('library-growth');
        await fireEvent.keyDown(container.querySelector('[role="slider"]') as HTMLElement, {
            key: 'Home',
        });
        expect(screen.getByTestId('growth-readout').textContent).toContain(
            'estimated from file dates',
        );
    });
});
