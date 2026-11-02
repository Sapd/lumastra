// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * "Load more" pages by offset, which shifts as new activity arrives: a
 * repeated row used to be appended (a duplicate key in the keyed each), and a
 * failed page load just stopped spinning.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem } from './activity-utils';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/state', () => ({
    page: { url: new URL('http://localhost/admin/users/activity'), data: {}, state: {} },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));
const apiGet = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client', () => ({ apiGet }));
vi.mock('$lib/api/admin', () => ({ getLocalUsers: vi.fn(async () => ({ data: null })) }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

import ActivityFeed from './ActivityFeed.svelte';

function item(id: number, title: string): ActivityItem {
    return {
        id,
        author: { userId: 'u1', displayName: 'testuser', images: { primary: { href: '/avatar', revision: '0', source: 'self' } } },
        activityType: 'finished',
        mediaId: null,
        mediaType: 'movie',
        ratingValue: null,
        externalIds: {},
        title,
        year: null,
        seriesName: null,
        seasonNumber: null,
        episodeNumber: null,
        completionPercentage: null,
        watchTimeSeconds: null,
        sourceService: null,
        metadata: null,
        bitrate: null,
        deviceId: null,
        deviceName: null,
        userAgent: null,
        clientName: null,
        clientVersion: null,
        ipAddress: null,
        playMethod: null,
        transcodeMode: null,
        resolutionWidth: null,
        resolution: null,
        videoCodec: null,
        audioCodec: null,
        container: null,
        stopReason: null,
        sourcePlaySessionId: null,
        sourceSessionId: null,
        planMode: null,
        planReasons: null,
        subtitleMethod: null,
        transcodeCodec: null,
        deliveryPath: null,
        totalDurationSeconds: null,
        currentPositionSeconds: null,
        currentProgressPercentage: null,
        isPaused: false,
        isActive: false,
        lastUpdateTime: null,
        activityTime: '2026-10-06T10:00:00.000Z',
        createdAt: '2026-10-06T10:00:00.000Z',
        occurrenceCount: 1,
    } as ActivityItem;
}

function page(items: ActivityItem[], hasMore: boolean) {
    return { data: { items, page: { limit: 2, offset: 0, hasMore } }, error: null };
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('ActivityFeed load more', () => {
    it('does not append a row that is already shown', async () => {
        apiGet
            .mockResolvedValueOnce(page([item(1, 'Alpha'), item(2, 'Beta')], true))
            .mockResolvedValueOnce(page([item(2, 'Beta'), item(3, 'Gamma')], false));

        render(ActivityFeed, { limit: 2 });
        await waitFor(() => expect(screen.getAllByText('Beta').length).toBeGreaterThan(0));
        const before = screen.getAllByText('Beta').length;

        await fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
        await waitFor(() => expect(screen.getAllByText('Gamma').length).toBeGreaterThan(0));
        expect(screen.getAllByText('Beta').length).toBe(before);
    });

    it('says so when a page fails to load', async () => {
        apiGet
            .mockResolvedValueOnce(page([item(1, 'Alpha')], true))
            .mockResolvedValueOnce({ data: null, error: 'boom' });

        render(ActivityFeed, { limit: 1 });
        await waitFor(() => expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0));
        await fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
        await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    });
});
