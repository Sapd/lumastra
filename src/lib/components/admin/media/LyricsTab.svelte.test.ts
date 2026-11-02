// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The lyrics tab edits `custom_metadata.lyrics`, which every other writer
 * (LRCLIB fetch, lyrics.service, the user lyrics endpoint) stores as an object
 * `{ plain, synced, source, fetchedAt }`. The player's lyrics endpoint ignores
 * anything else, so these tests pin the shape the tab reads and writes, and
 * what it does with edits that are not saved yet.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
    getAdminCustomMetadata: vi.fn(),
    updateAdminCustomMetadata: vi.fn(),
    undoAdminCuratedOutput: vi.fn(),
}));

vi.mock('$lib/api/admin', () => api);
vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import LyricsTab from './LyricsTab.svelte';

const FETCHED = {
    plain: 'First line\nSecond line',
    synced: '[00:01.00]First line\n[00:05.00]Second line',
    source: 'lrclib',
    fetchedAt: '2026-10-01T00:00:00.000Z',
};

function stored(lyrics: unknown): unknown {
    return { data: { custom_metadata: lyrics === undefined ? {} : { lyrics } }, error: undefined };
}

async function renderTab(lyrics: unknown, onsaved?: () => void): Promise<void> {
    api.getAdminCustomMetadata.mockResolvedValue(stored(lyrics));
    render(LyricsTab, { props: { mediaId: 'track-1', onsaved } });
    await waitFor(() => expect(screen.queryByText('Loading lyrics...')).toBeNull());
}

function editor(): HTMLTextAreaElement {
    return screen.getByPlaceholderText('Enter lyrics here...') as HTMLTextAreaElement;
}

beforeEach(() => {
    api.updateAdminCustomMetadata.mockResolvedValue({ data: { updated: true }, error: undefined });
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('LyricsTab stored shape', () => {
    it('shows lyrics stored as the {plain, synced, source} object', async () => {
        await renderTab(FETCHED);
        expect(screen.getByText(/First line\s+Second line/)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Synced' })).toBeTruthy();
        expect(screen.getByText('lrclib')).toBeTruthy();
    });

    it('saves an edit as the object shape and drops the synced lyrics it replaces', async () => {
        const onsaved = vi.fn();
        await renderTab(FETCHED, onsaved);
        await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        await fireEvent.input(editor(), { target: { value: 'Corrected line' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(onsaved).toHaveBeenCalledTimes(1));
        expect(api.updateAdminCustomMetadata).toHaveBeenCalledWith('track-1', {
            lyrics: expect.objectContaining({
                plain: 'Corrected line',
                synced: null,
                source: 'user',
            }),
        });
    });

    it('warns in the editor that saving replaces the synced lyrics', async () => {
        await renderTab(FETCHED);
        await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        expect(
            screen.getByText('Saving replaces the synced (timed) lyrics with this text.'),
        ).toBeTruthy();
    });

    it('lets a track without lyrics get them typed in by hand', async () => {
        await renderTab(undefined);
        await fireEvent.click(screen.getByRole('button', { name: 'Add lyrics manually' }));
        await fireEvent.input(editor(), { target: { value: 'Hand typed' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(api.updateAdminCustomMetadata).toHaveBeenCalledTimes(1));
        expect(api.updateAdminCustomMetadata.mock.calls[0][1].lyrics.plain).toBe('Hand typed');
    });
});

describe('LyricsTab unsaved edits', () => {
    it('keeps an edit when switching sub-tabs and back', async () => {
        await renderTab(FETCHED);
        await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        await fireEvent.input(editor(), { target: { value: 'Draft' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Plain' }));
        await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

        expect(editor().value).toBe('Draft');
        expect(screen.getByText('Unsaved changes')).toBeTruthy();
    });

    it('keeps text typed while the save is in flight as unsaved', async () => {
        let resolveSave!: (value: unknown) => void;
        api.updateAdminCustomMetadata.mockReturnValue(
            new Promise((resolve) => {
                resolveSave = resolve;
            }),
        );
        await renderTab(FETCHED);
        await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        await fireEvent.input(editor(), { target: { value: 'Sent' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await fireEvent.input(editor(), { target: { value: 'Sent plus more' } });

        resolveSave({ data: { updated: true }, error: undefined });

        await waitFor(() => expect(screen.getByText('Unsaved changes')).toBeTruthy());
        expect(editor().value).toBe('Sent plus more');
    });

    it('asks before a fetch would replace unsaved edits', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        // happy-dom ships no window.confirm, so install one rather than spy.
        const confirm = vi.fn(() => false);
        vi.stubGlobal('confirm', confirm);
        window.confirm = confirm;
        await renderTab(FETCHED);
        await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        await fireEvent.input(editor(), { target: { value: 'Draft' } });
        await fireEvent.click(screen.getByRole('button', { name: /Fetch from LRCLIB/ }));

        expect(confirm).toHaveBeenCalledWith('Discard your unsaved lyrics changes?');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(editor().value).toBe('Draft');
    });
});

it('restores timed lyrics and their source after a plain-text override', async () => {
    const undoId = '00000000-0000-4000-8000-000000000006';
    await renderTab(FETCHED);
    api.updateAdminCustomMetadata.mockResolvedValue({ data: { updated: true, undoId } });
    api.undoAdminCuratedOutput.mockResolvedValue({ data: { updated: true } });
    await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await fireEvent.input(editor(), { target: { value: 'A new unsynchronized line' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Undo lyrics changes' }));
    expect(api.undoAdminCuratedOutput).toHaveBeenCalledExactlyOnceWith('track-1', 'lyrics', undoId);
    await fireEvent.click(screen.getByRole('button', { name: 'Synced' }));
    expect(await screen.findByText('First line')).toBeTruthy();
    expect(screen.getByText('lrclib')).toBeTruthy();
});
