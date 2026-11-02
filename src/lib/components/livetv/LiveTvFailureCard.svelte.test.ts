// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LiveTvFailureCard from './LiveTvFailureCard.svelte';
import * as m from '$lib/paraglide/messages.js';
import type { LiveTvFailureView } from '$lib/components/player/livetv-failure-retry.js';

afterEach(cleanup);

function handlers() {
    return {
        onRetry: vi.fn(),
        onCancelRetry: vi.fn(),
        onAnotherChannel: vi.fn(),
        onBack: vi.fn(),
    };
}

const base: LiveTvFailureView = { code: 'channel_offline', retryable: false, attempts: 0 };

describe('LiveTvFailureCard', () => {
    it('shows the code copy with another channel and back, but no retry, for a dead channel', async () => {
        const h = handlers();
        render(LiveTvFailureCard, { channelName: 'KWF', failure: base, ...h });
        expect(screen.getByTestId('livetv-failure-message').textContent).toContain(
            m.livetv_failure_msg_channel_offline(),
        );
        expect(screen.queryByTestId('livetv-failure-retry')).toBeNull();
        expect(screen.queryByTestId('livetv-failure-countdown')).toBeNull();
        await fireEvent.click(screen.getByTestId('livetv-failure-another'));
        await fireEvent.click(screen.getByTestId('livetv-failure-back'));
        expect(h.onAnotherChannel).toHaveBeenCalledOnce();
        expect(h.onBack).toHaveBeenCalledOnce();
    });

    it('shows a countdown with Cancel while an automatic retry is pending', async () => {
        const h = handlers();
        render(LiveTvFailureCard, {
            channelName: 'KWF',
            failure: {
                code: 'provider_connection_limit',
                retryable: true,
                attempts: 1,
                retryAt: Date.now() + 9_500,
            },
            ...h,
        });
        expect(screen.getByTestId('livetv-failure-countdown').textContent).toContain('10');
        expect(screen.queryByTestId('livetv-failure-retry')).toBeNull();
        await fireEvent.click(screen.getByTestId('livetv-failure-cancel'));
        expect(h.onCancelRetry).toHaveBeenCalledOnce();
    });

    it('offers a manual Try again once the automatic retries are used up', async () => {
        const h = handlers();
        render(LiveTvFailureCard, {
            channelName: 'KWF',
            failure: { code: 'upstream_stalled', retryable: true, attempts: 4 },
            ...h,
        });
        expect(screen.queryByTestId('livetv-failure-countdown')).toBeNull();
        await fireEvent.click(screen.getByTestId('livetv-failure-retry'));
        expect(h.onRetry).toHaveBeenCalledOnce();
    });

    it('lists the feeds tried for an admin only', () => {
        const failure: LiveTvFailureView = {
            code: 'all_feeds_failed',
            retryable: false,
            attempts: 0,
            feedsTried: [{ feedName: 'Main', reason: 'provider_unreachable' }],
        };
        render(LiveTvFailureCard, { channelName: 'KWF', failure, isAdmin: true, ...handlers() });
        expect(screen.getByTestId('livetv-failure-feeds').textContent).toContain('Main');
        cleanup();
        render(LiveTvFailureCard, { channelName: 'KWF', failure, isAdmin: false, ...handlers() });
        expect(screen.queryByTestId('livetv-failure-feeds')).toBeNull();
    });

    it('uses the plain wording and the Next channel label in simple mode', () => {
        render(LiveTvFailureCard, {
            channelName: 'KWF',
            failure: base,
            simple: true,
            isAdmin: true,
            ...handlers(),
        });
        expect(screen.getByTestId('livetv-failure-message').textContent).toContain(
            m.livetv_failure_msg_simple_channel_offline(),
        );
        expect(screen.getByTestId('livetv-failure-another').textContent).toContain(
            m.livetv_failure_another_channel_simple(),
        );
        expect(screen.queryByTestId('livetv-failure-feeds')).toBeNull();
    });
});
