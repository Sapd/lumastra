// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveTvStation } from '$lib/schemas/livetv.js';

vi.mock('$lib/api/livetv-playback.js', () => ({
    fetchGuidePrograms: vi.fn().mockResolvedValue({
        status: 200,
        data: {
            stations: [],
            window: { from: '', to: '', asOf: '' },
            page: { limit: 200, nextCursor: null, hasMore: false },
        },
        error: null,
    }),
}));

const ChannelFamilyModal = (await import('./ChannelFamilyModal.svelte')).default;
afterEach(cleanup);

const channel = (id: string, withProgram: boolean): LiveTvStation =>
    ({
        id,
        feedId: id,
        name: `Event ${id}`,
        images: {},
        isVisible: true,
        sortOrder: 0,
        nowNext: { next: null, current: withProgram ? {
                id: `p${id}`,
                stationId: id,
                title: 'Final',
                startTime: new Date(Date.now() - 60_000).toISOString(),
                endTime: new Date(Date.now() + 3_600_000).toISOString(),
            } : null,
        },
    }) as LiveTvStation;

function renderFamily(channels: LiveTvStation[]) {
    render(ChannelFamilyModal, {
        props: { label: 'Event', channels, now: Date.now(), onPick: vi.fn(), onClose: vi.fn() },
    });
}

const pressedView = (): string | null =>
    screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('aria-pressed') === 'true')
        ?.textContent?.trim() ?? null;

describe('ChannelFamilyModal default view', () => {
    it('opens on the guide when a channel has a programme', () => {
        renderFamily([channel('1', false), channel('2', true)]);
        expect(pressedView()).toMatch(/Guide/);
    });

    it('opens on the channel grid when none has guide data', () => {
        renderFamily([channel('1', false), channel('2', false)]);
        expect(pressedView()).toMatch(/Grid|Raster/);
    });
});
