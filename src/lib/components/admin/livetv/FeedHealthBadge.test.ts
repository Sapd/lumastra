// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { LiveTvChannelHealth } from '$lib/schemas/livetv-failures.js';
import FeedHealthBadge from './FeedHealthBadge.svelte';

function health(overrides: Partial<LiveTvChannelHealth>): LiveTvChannelHealth {
    return { state: 'ok', consecutiveFailures: 0, ...overrides };
}

describe('FeedHealthBadge', () => {
    test('renders nothing for an ok feed or a missing health', () => {
        const { unmount } = render(FeedHealthBadge, { health: health({}) });
        expect(screen.queryByTestId('feed-health')).toBeNull();
        unmount();
        render(FeedHealthBadge, { health: undefined });
        expect(screen.queryByTestId('feed-health')).toBeNull();
    });

    test('offline feed: red-state badge with reason, time and failure count', () => {
        render(FeedHealthBadge, {
            health: health({
                state: 'offline',
                consecutiveFailures: 5,
                lastReason: 'provider_auth_failed',
                lastFailureAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            }),
        });
        const badge = screen.getByTestId('feed-health-badge');
        expect(badge.getAttribute('data-state')).toBe('offline');
        expect(badge.className).toContain('red');
        const detail = screen.getByTestId('feed-health-detail').textContent ?? '';
        expect(detail).toContain('Login refused');
        expect(detail).toContain('5 failures in a row');
        expect(badge.getAttribute('title')).toBe(detail);
    });

    test('failing feed: amber badge; an unknown reason code keeps the count', () => {
        render(FeedHealthBadge, {
            health: health({ state: 'failing', consecutiveFailures: 2, lastReason: 'brand_new' }),
        });
        const badge = screen.getByTestId('feed-health-badge');
        expect(badge.getAttribute('data-state')).toBe('failing');
        expect(badge.className).toContain('amber');
        expect(screen.getByTestId('feed-health-detail').textContent).toBe('2 failures in a row');
    });

    test('Reset button only with onReset, and it calls it once', async () => {
        const user = userEvent.setup();
        const onReset = vi.fn().mockResolvedValue(undefined);
        const failing = health({ state: 'failing', consecutiveFailures: 1 });
        const { unmount } = render(FeedHealthBadge, { health: failing });
        expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
        unmount();

        render(FeedHealthBadge, { health: failing, onReset });
        await user.click(screen.getByRole('button', { name: 'Reset' }));
        expect(onReset).toHaveBeenCalledTimes(1);
    });
});
