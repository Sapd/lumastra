// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProgramGuide from './ProgramGuide.svelte';
import { fetchGuidePrograms } from '$lib/api/livetv-playback.js';
import type { GuideResponse } from '$lib/schemas/livetv.js';

vi.mock('$lib/api/livetv-playback.js', () => ({ fetchGuidePrograms: vi.fn() }));
vi.mock('$lib/paraglide/messages', async (original) => ({
    ...(await original<object>()),
    viewer_livetv_other: () => 'Other',
}));

const channels = [
    {
        id: 'channel',
        feedId: 'channel',
        name: 'News channel',
        images: {},
        categoryId: 'missing',
        sortOrder: 0,
        isVisible: true,
        nowNext: { current: null, next: null },
    },
];
const categories = [{ id: 'visible', name: 'Visible', sortOrder: 0, isVisible: true }];

function guideData(from: Date, to: Date, programs: Record<string, GuideResponse['stations'][number]['airings']> = {}): GuideResponse {
    return {
        stations: Object.entries(programs).map(([stationId, airings]) => ({
            stationId,
            airings,
            nowNext: { current: null, next: null },
        })),
        window: { from: from.toISOString(), to: to.toISOString(), asOf: from.toISOString() },
        page: { limit: 200, nextCursor: null, hasMore: false },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('ProgramGuide recovery and accessibility', () => {
    it('retains orphan-category channels and exposes a keyboard-focusable scroll region', async () => {
        vi.mocked(fetchGuidePrograms).mockImplementation(async (from, to) => ({
            data: guideData(from, to),
            error: null,
            status: 200,
        }));
        render(ProgramGuide, { channels, categories });
        await tick();
        expect(screen.getByRole('button', { name: /News channel/ })).toBeTruthy();
        expect(screen.getByRole('region').getAttribute('tabindex')).toBe('0');
        expect(screen.queryByRole('application')).toBeNull();
    });

    it('preserves loaded programs and retries a failed later window', async () => {
        const start = new Date(Date.now() - 60_000).toISOString();
        const end = new Date(Date.now() + 3_600_000).toISOString();
        vi.mocked(fetchGuidePrograms)
            .mockImplementationOnce(async (from, to) => ({
                data: guideData(from, to, {
                    channel: [
                        {
                            id: 'program',
                            stationId: 'channel',
                            title: 'Current news',
                            startTime: start,
                            endTime: end,
                        },
                    ],
                }),
                error: null,
                status: 200,
            }))
            .mockResolvedValueOnce({ data: null, error: 'offline', status: 503 })
            .mockImplementationOnce(async (from, to) => ({
                data: guideData(from, to),
                error: null,
                status: 200,
            }));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        render(ProgramGuide, { channels, categories });
        await vi.advanceTimersByTimeAsync(1);
        await tick();
        const region = screen.getByRole('region');
        region.scrollLeft = 10000;
        await fireEvent.scroll(region);
        await vi.advanceTimersByTimeAsync(30);
        expect(screen.getByRole('alert')).toBeTruthy();
        expect(screen.getByRole('button', { name: /News channel: Current news/ })).toBeTruthy();
        await fireEvent.click(screen.getByRole('alert').querySelector('button')!);
        await tick();
        expect(fetchGuidePrograms).toHaveBeenCalledTimes(3);
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.getByRole('button', { name: /News channel: Current news/ })).toBeTruthy();
        vi.mocked(console.warn).mockRestore();
    });
});
