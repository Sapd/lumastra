// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import ProgramGuide from './ProgramGuide.svelte';
import { LIVE_TV_AVAILABILITY_CONTEXT } from '$lib/shared/livetv-availability-context';
import { fetchGuidePrograms } from '$lib/api/livetv-playback.js';
import type { LiveTvAvailability } from '$lib/schemas/livetv-availability';
vi.mock('$lib/api/livetv-playback.js', () => ({ fetchGuidePrograms: vi.fn() }));
afterEach(cleanup);
it('reloads the current guide window after recovery without resetting either scroll axis', async () => {
    // eslint-disable-next-line no-undef -- Svelte compiler transforms the test module's rune
    let availability = $state<LiveTvAvailability>({
        observedAt: new Date().toISOString(),
        evidenceUnavailable: false,
        channels: {},
        suppressedChannelIds: [],
        sources: [
            {
                sourceId: 's',
                channelFeed: { state: 'healthy' },
                guideFeed: { state: 'failed', observedAt: '2026-10-04T00:00:00Z' },
                playback: 'unknown',
                failedChannelIds: [],
            },
        ],
    });
    vi.mocked(fetchGuidePrograms).mockResolvedValue({
        status: 200,
        data: {
            stations: [],
            window: { from: '', to: '', asOf: '' },
            page: { limit: 200, nextCursor: null, hasMore: false },
        },
        error: null,
    });
    const view = render(ProgramGuide, {
        props: {
            channels: [
                { id: 'a', feedId: 'a', name: 'A', images: {}, isVisible: true, nowNext: { current: null, next: null }, sortOrder: 0 },
            ],
            categories: [],
        },
        context: new Map([[LIVE_TV_AVAILABILITY_CONTEXT, () => availability]]),
    });
    await tick();
    await tick();
    const grid = view.container.querySelector('[aria-busy]') as HTMLElement;
    grid.scrollLeft = 345;
    grid.scrollTop = 123;
    const firstArgs = vi.mocked(fetchGuidePrograms).mock.calls[0];
    function recover(): void {
        availability = {
            ...availability,
            sources: [
                {
                    ...availability.sources[0],
                    guideFeed: { state: 'healthy', observedAt: '2026-10-04T00:10:00Z' },
                },
            ],
        };
    }
    recover();
    await tick();
    await tick();
    expect(fetchGuidePrograms).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchGuidePrograms).mock.calls[1]).toEqual(firstArgs);
    expect(grid.scrollLeft).toBe(345);
    expect(grid.scrollTop).toBe(123);
});
