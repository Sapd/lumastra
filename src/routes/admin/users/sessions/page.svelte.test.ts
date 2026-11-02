// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The sessions page shows playback only: sessions, stream throughput, transcodes.
 * CPU, memory and GPU moved to the cluster view (per host): the page answered by a
 * random web replica cannot say anything about the machine that transcodes.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }));
vi.mock('$app/state', () => ({
    page: { url: new URL('http://localhost:3000/admin/users/sessions'), data: {}, state: {} },
}));
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return {
        page: readable({ url: new URL('http://localhost:3000/admin/users/sessions'), data: {} }),
        navigating: readable(null),
    };
});
vi.mock('$app/navigation', () => ({
    goto: vi.fn(),
    invalidate: vi.fn(),
    invalidateAll: vi.fn(),
    pushState: vi.fn(),
    replaceState: vi.fn(),
}));

const api = vi.hoisted(() => ({
    getAdminPlaySessions: vi.fn(),
    getFfmpegJobs: vi.fn(),
    getStreamThroughput: vi.fn(),
    getSystemMetrics: vi.fn(),
}));
vi.mock('$lib/api/admin', () => api);
vi.mock('$lib/api/livetv', () => ({ getProxyStatus: vi.fn(), killProxyConnection: vi.fn() }));
vi.mock('$lib/services/sse/watch-state-sse', async () => {
    const { writable } = await import('svelte/store');
    return { sessionChangedRevision: writable(0) };
});

import Page from './+page.svelte';

const data = {
    features: { ffmpegAvailable: true, liveTvSource: 'disabled' },
} as unknown as import('../../$types').LayoutData;

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

function mockApis(): void {
    api.getAdminPlaySessions.mockResolvedValue({
        data: { sessions: [], untrackedJellyfinSessions: [] },
        error: null,
    });
    api.getFfmpegJobs.mockResolvedValue({ data: { jobs: [], count: 0 }, error: null });
    api.getStreamThroughput.mockResolvedValue({
        data: {
            mediaBandwidth: {
                totalBytesPerSec: 2_500_000,
                totalMbps: 20,
                hlsSegmentsMbps: 12,
                directPlayMbps: 8,
                liveTVMbps: 0,
                proxiedStreamsMbps: 0,
                imagesMbps: 0,
                subtitlesMbps: 0,
                trickplayMbps: 0,
                history: [],
            },
        },
        error: null,
    });
}

describe('admin sessions page', () => {
    it("links to the per-host system load instead of showing one replica's CPU/RAM/GPU", async () => {
        mockApis();
        render(Page, { props: { data } });

        const link = await screen.findByTestId('sessions-system-load-link');
        expect(link.getAttribute('href')).toBe('/admin/system/health?tab=cluster');
        expect(link.textContent).toContain('System load');

        await waitFor(() => expect(api.getStreamThroughput).toHaveBeenCalled());
        // The per-replica endpoint (and its GPU test encode) is no longer used here.
        expect(api.getSystemMetrics).not.toHaveBeenCalled();
        expect(screen.queryByText(/CPU Usage/i)).toBeNull();
    });

    it('shows cluster-wide stream bandwidth without expanding a panel', async () => {
        mockApis();
        render(Page, { props: { data } });

        expect(await screen.findByText('20.0 Mbps')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Stream Bandwidth/i })).toBeNull();
    });
});
