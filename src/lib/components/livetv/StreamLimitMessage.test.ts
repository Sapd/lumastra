// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, test, vi } from 'vitest';
import StreamLimitMessage from './StreamLimitMessage.svelte';

function renderMessage(limit: number, viewers: number) {
    const onJoinChannel = vi.fn();
    render(StreamLimitMessage, {
        limit,
        activeChannels: [{ channelId: 'ch-1', channelName: 'Orb Sports Centre Court', viewers }],
        showActiveStreams: true,
        onJoinChannel,
        onRetry: vi.fn(),
        onClose: vi.fn(),
    });
    return { onJoinChannel };
}

describe('StreamLimitMessage', () => {
    test('says one stream, not "1 streams"', () => {
        renderMessage(1, 2);
        expect(screen.getByText('This provider allows one stream at a time')).toBeTruthy();
    });

    test('names the limit when it is more than one', () => {
        renderMessage(3, 2);
        expect(screen.getByText('This provider allows 3 streams at a time')).toBeTruthy();
    });

    test('shows the viewer count only when someone is watching', () => {
        renderMessage(1, 2);
        expect(screen.getByText(/2 viewers/)).toBeTruthy();
    });

    test('hides "0 viewers"', () => {
        renderMessage(1, 0);
        expect(screen.queryByText(/0 viewers/)).toBeNull();
        expect(screen.getByText(/No extra connection needed/)).toBeTruthy();
    });

    test('joins the channel when the row is pressed', async () => {
        const { onJoinChannel } = renderMessage(1, 1);
        await fireEvent.click(
            screen.getByRole('button', { name: 'Watch Orb Sports Centre Court' }),
        );
        expect(onJoinChannel).toHaveBeenCalledWith('ch-1');
    });
});
