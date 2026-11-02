// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
    getChatMessages: vi.fn(),
    sendChatMessage: vi.fn(),
    deleteChatMessage: vi.fn(),
}));
vi.mock('$lib/api/playlists', () => api);
vi.mock('$app/stores', async () => ({
    page: (await import('svelte/store')).readable({
        data: { clientTuning: { playlistChatPollMs: 5000 } },
    }),
}));
import PlaylistChat from './PlaylistChat.svelte';
import type { ChatMessageData } from '$lib/schemas/playlists';
const viewerId = '550e8400-e29b-41d4-a716-446655440000';
const message: ChatMessageData = {
    id: 1,
    author: {
        userId: viewerId,
        displayName: 'Viewer',
        images: { primary: { href: `/api/users/${viewerId}/images/avatar`, revision: '0', source: 'self' } },
    },
    message: 'First message',
    messageType: 'user',
    createdAt: '2026-09-29T12:00:00Z',
};
async function flush() {
    await Promise.resolve();
    await tick();
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    api.getChatMessages.mockResolvedValue({
        data: { items: [], page: { limit: 50, hasMore: false } },
    });
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
describe('playlist chat refresh and failures', () => {
    it('receives the first remote message in an initially empty chat', async () => {
        render(PlaylistChat, { playlistId: 1, currentUser: viewerId });
        await flush();
        api.getChatMessages.mockResolvedValue({
            data: { items: [message], page: { limit: 50, hasMore: false } },
        });
        await vi.advanceTimersByTimeAsync(5000);
        await flush();
        expect(screen.getByText('First message')).toBeTruthy();
    });
    it('does not leak a poll timer when unmounted during initial load', async () => {
        let finish!: (value: unknown) => void;
        api.getChatMessages.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const view = render(PlaylistChat, { playlistId: 1, currentUser: viewerId });
        await flush();
        view.unmount();
        finish({ data: { items: [], page: { limit: 50, hasMore: false } } });
        await flush();
        await vi.advanceTimersByTimeAsync(20000);
        expect(api.getChatMessages).toHaveBeenCalledTimes(1);
    });
    it('keeps the draft and reports a failed send', async () => {
        render(PlaylistChat, { playlistId: 1, currentUser: viewerId });
        await flush();
        api.sendChatMessage.mockResolvedValue({ error: 'offline' });
        const input = screen.getByRole('textbox');
        await fireEvent.input(input, { target: { value: 'Keep my draft' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await flush();
        expect(screen.getByRole('alert').textContent).toContain('Something went wrong');
        expect((input as HTMLInputElement).value).toBe('Keep my draft');
    });
    it('does not let a stale initial response erase a successful local send', async () => {
        let finish!: (value: unknown) => void;
        api.getChatMessages.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        api.sendChatMessage.mockResolvedValue({ data: message });
        render(PlaylistChat, { playlistId: 1, currentUser: viewerId });
        await flush();
        await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'First message' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await flush();
        finish({ data: { items: [], page: { limit: 50, hasMore: false } } });
        await flush();
        expect(screen.getByText('First message')).toBeTruthy();
    });
});
