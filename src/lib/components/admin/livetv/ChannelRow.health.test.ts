// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { AdminChannel } from '$lib/schemas/livetv.js';
import ChannelRow from './ChannelRow.svelte';

function makeChannel(overrides: Partial<AdminChannel> = {}): AdminChannel {
    return {
        id: 'ch-1',
        name: 'Test Channel',
        images: {},
        sortOrder: 0,
        isVisible: true,
        ...overrides,
    } as AdminChannel;
}

describe('ChannelRow health badge', () => {
    test.each(['table', 'card'] as const)('%s: no badge for a healthy channel', (mode) => {
        render(ChannelRow, {
            channel: makeChannel({ health: { state: 'ok', consecutiveFailures: 0 } }),
            mode,
        });
        expect(screen.queryByTestId('feed-health-badge')).toBeNull();
    });

    test.each(['table', 'card'] as const)('%s: offline badge and Reset call', async (mode) => {
        const user = userEvent.setup();
        const onHealthReset = vi.fn().mockResolvedValue(true);
        render(ChannelRow, {
            channel: makeChannel({
                health: { state: 'offline', consecutiveFailures: 3, lastReason: 'channel_offline' },
            }),
            mode,
            onHealthReset,
        });
        expect(screen.getByTestId('feed-health-badge').getAttribute('data-state')).toBe('offline');
        await user.click(screen.getByRole('button', { name: 'Reset' }));
        expect(onHealthReset).toHaveBeenCalledWith('ch-1');
    });
});
