// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import AvailabilityBanner from './AvailabilityBanner.svelte';
import type { LiveTvAvailability } from '$lib/schemas/livetv-availability';
import * as m from '$lib/paraglide/messages.js';
afterEach(cleanup);
it('reports unknown polling separately and renders simultaneous provider, service and partial outages', () => {
    const availability: LiveTvAvailability = {
        observedAt: new Date().toISOString(),
        evidenceUnavailable: false,
        channels: {},
        suppressedChannelIds: [],
        sources: ['upstream', 'service', 'partial'].map((playback, i) => ({
            sourceId: String(i),
            channelFeed: { state: 'unknown' },
            guideFeed: { state: 'unknown' },
            playback: playback as 'upstream' | 'service' | 'partial',
            failedChannelIds: [],
        })),
    };
    render(AvailabilityBanner, { availability, readError: true, onretry: vi.fn() });
    expect(screen.getByText(m.livetv_availability_unknown())).toBeTruthy();
    expect(screen.getByText(m.livetv_availability_outage())).toBeTruthy();
    expect(screen.getByText(m.livetv_availability_service())).toBeTruthy();
    expect(screen.getByText(m.livetv_availability_partial())).toBeTruthy();
    expect(screen.queryByText(m.livetv_availability_load_error())).toBeNull();
});
