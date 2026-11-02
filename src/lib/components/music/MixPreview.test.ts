// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { musicTrackFromCard } from '$lib/utils/music-track';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MixPreview from './MixPreview.svelte';
import MixPreviewCard from './MixPreviewCard.svelte';
import ModalContainer from '$lib/components/ui/ModalContainer.svelte';
import { modals } from '$lib/stores/modal.store';
import type { MusicTrack } from '$lib/schemas/music';

vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: { enqueueFromBrew: vi.fn() },
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn() } }));
const tracks = [
    {
        id: 'one',
        title: 'First track',
        artists: [{ id: null, title: 'Artist' }],
        durationMs: 60000,
    },
    {
        id: 'two',
        title: 'Second track',
        artists: [{ id: null, title: 'Artist' }],
        durationMs: 120000,
    },
].map((track) => musicTrackFromCard(track));

beforeEach(() => {
    void modals.closeAll();
});
afterEach(cleanup);

describe('mix preview', () => {
    it('does not play on opening, discloses the selection, and rotates a chosen track', async () => {
        const onplay = vi.fn(async (_tracks: MusicTrack[]) => {});
        render(MixPreviewCard, {
            title: 'My mix',
            tracks,
            total: 1876,
            onclose: vi.fn(),
            onretry: vi.fn(),
            onplay,
        });
        expect(onplay).not.toHaveBeenCalled();
        expect(screen.getByText(/2-track selection from 1,876/)).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: 'Play Second track' }));
        expect(onplay).toHaveBeenCalledWith([tracks[1], tracks[0]]);
    });

    it('shuffles the displayed selection without mutating its order', async () => {
        const onplay = vi.fn(async (_tracks: MusicTrack[]) => {});
        render(MixPreviewCard, {
            title: 'My mix',
            tracks,
            onclose: vi.fn(),
            onretry: vi.fn(),
            onplay,
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Shuffle' }));
        expect(onplay.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(tracks));
        expect(tracks.map((track) => track.id)).toEqual(['one', 'two']);
    });

    it('offers retry for errors', async () => {
        const onretry = vi.fn();
        render(MixPreviewCard, {
            title: 'My mix',
            tracks: [],
            error: 'Could not load',
            onclose: vi.fn(),
            onretry,
        });
        expect(screen.getByRole('alert').textContent).toBe('Could not load');
        await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(onretry).toHaveBeenCalledOnce();
    });
});

describe('mix preview modal shell', () => {
    function open(onclose = vi.fn()): ReturnType<typeof render> {
        render(ModalContainer);
        return render(MixPreview, { title: 'My mix', tracks, onclose, onretry: vi.fn() });
    }

    it('opens in the shared modal stack like the album/artist modals', async () => {
        open();
        const dialog = await screen.findByRole('dialog', { name: 'My mix' });
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(await screen.findByText('First track')).toBeTruthy();
    });

    it('closes on a click outside the card and tells the caller', async () => {
        const onclose = vi.fn();
        open(onclose);
        await screen.findByRole('dialog', { name: 'My mix' });
        await fireEvent.click(document.querySelector('.backdrop')!);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(onclose).toHaveBeenCalledOnce();
    });

    it('closes on Escape and on the close button', async () => {
        const onclose = vi.fn();
        open(onclose);
        await screen.findByRole('dialog', { name: 'My mix' });
        await fireEvent.keyDown(window, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(onclose).toHaveBeenCalledOnce();
        cleanup();

        const onclose2 = vi.fn();
        open(onclose2);
        await screen.findByRole('dialog', { name: 'My mix' });
        await fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(onclose2).toHaveBeenCalledOnce();
    });

    it('closes without calling back when the caller unmounts it, and follows prop updates', async () => {
        const onclose = vi.fn();
        render(ModalContainer);
        const view = render(MixPreview, {
            title: 'My mix',
            tracks: [],
            loading: true,
            onclose,
            onretry: vi.fn(),
        });
        await screen.findByRole('status');
        await view.rerender({ title: 'My mix', tracks, loading: false, onclose, onretry: vi.fn() });
        await screen.findByText('Second track');
        view.unmount();
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(onclose).not.toHaveBeenCalled();
    });
});
