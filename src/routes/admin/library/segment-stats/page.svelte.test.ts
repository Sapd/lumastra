// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';
import Page from './+page.svelte';
import { apiGet } from '$lib/api/client.js';

vi.mock('$lib/api/client.js', () => ({ apiGet: vi.fn() }));
vi.mock('$app/stores', () => ({
    page: readable({ data: {}, url: new URL('http://localhost/admin/library/segment-stats') }),
    navigating: readable(null),
}));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));

// Shape of the production Outro payload the page shipped against: a large
// detector (chromaprint) next to a tiny one (cohort).
const stats = {
    type: 'Outro',
    bucketSeconds: 15,
    histogram: [
        { method: 'chromaprint', bucketStart: 15, items: 7423 },
        { method: 'chromaprint', bucketStart: 90, items: 7294 },
        { method: 'chromaprint', bucketStart: 135, items: 102 },
        { method: 'cohort', bucketStart: 15, items: 212 },
        { method: 'cohort', bucketStart: 150, items: 1 },
    ],
    summary: [
        {
            method: 'chromaprint',
            items: 14819,
            p50: 59,
            p90: 135,
            p99: 140,
            maxSeconds: 149,
            snappedToChapter: 0,
        },
        {
            method: 'cohort',
            items: 213,
            p50: 52,
            p90: 80,
            p99: 150,
            maxSeconds: 160,
            snappedToChapter: 14,
        },
    ],
    configCohorts: [
        {
            configHash: 'abcdef0123456789',
            detectorVersion: 4,
            items: 10,
            methods: 5,
            oldest: '2026-08-19T00:00:00.000Z',
            newest: '2026-09-26T00:00:00.000Z',
        },
    ],
    repairBacklog: {
        minLengthSeconds: 90,
        items: 510,
        lengths: [
            { bucketStart: 92, items: 53 },
            { bucketStart: 96, items: 35 },
        ],
    },
};

beforeEach(() => {
    vi.mocked(apiGet).mockResolvedValue({ data: stats, error: null, status: 200 });
});
afterEach(() => {
    cleanup();
    vi.resetAllMocks();
});

function barHeights(title: RegExp, container: HTMLElement): number[] {
    return [...container.querySelectorAll<HTMLElement>('[title]')]
        .filter((el) => title.test(el.title))
        .map((el) => parseFloat((el.firstElementChild as HTMLElement).style.height));
}

test('bar columns fill the chart height so percentage bars are not 0 px', async () => {
    const view = render(Page);
    await view.findByText('14,819');
    const column = view.container.querySelector<HTMLElement>('[title^="0s–15s"]');
    expect(column?.classList.contains('h-full')).toBe(true);
});

test('each detector is scaled to its own peak, not the largest detector', async () => {
    const view = render(Page);
    await view.findByText('14,819');
    // cohort's 15–30 s bucket is its own peak: full height, not 212/7423 ≈ 3 %.
    expect(barHeights(/^15s–30s · 212 /, view.container)).toEqual([100]);
    expect(barHeights(/^15s–30s · 7,423 /, view.container)).toEqual([100]);
});

test('durations render as m:ss instead of rounded minutes', async () => {
    const view = render(Page);
    await view.findByText('14,819');
    // p90 135 s used to render as "2m", indistinguishable from 120 s.
    expect(view.getAllByText('2:15').length).toBeGreaterThan(0);
    expect(view.queryByText('2m')).toBeNull();
});

test('bars at or above the repair threshold are highlighted', async () => {
    const view = render(Page);
    await view.findByText('14,819');
    const above = view.container.querySelector<HTMLElement>('[title^="1:30–1:45 · 7,294"]');
    const below = view.container.querySelector<HTMLElement>('[title^="15s–30s · 7,423"]');
    expect(above?.firstElementChild?.className).toContain('bg-amber-500');
    expect(below?.firstElementChild?.className).toContain('bg-cyan-500');
});

test('an emptied bucket field is clamped instead of sent to the server', async () => {
    const view = render(Page);
    await view.findByText('14,819');
    const input = view.getByLabelText(/Bucket width/) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: '' } });
    await fireEvent.change(input);
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    const url = vi.mocked(apiGet).mock.calls[1]?.[0] as string;
    expect(new URL(url, 'http://x').searchParams.get('bucketSeconds')).toBe('15');
});

test('the repair threshold field is only offered for Outro', async () => {
    const view = render(Page);
    await view.findByText('14,819');
    expect(view.queryByLabelText(/Repair threshold/)).not.toBeNull();
    await fireEvent.change(view.getByLabelText(/Segment type/), { target: { value: 'Intro' } });
    expect(view.queryByLabelText(/Repair threshold/)).toBeNull();
});

test('two cohorts sharing a config hash (detector bump) both render', async () => {
    const cohort = stats.configCohorts[0];
    vi.mocked(apiGet).mockResolvedValue({
        data: {
            ...stats,
            configCohorts: [cohort, { ...cohort, detectorVersion: 5, items: 3 }],
        },
        error: null,
        status: 200,
    });
    const view = render(Page);
    await view.findByText('14,819');
    // Keyed by hash alone, the second row threw each_key_duplicate and the
    // whole page failed to render.
    expect(view.getAllByText(/abcdef01/).length).toBe(2);
});
