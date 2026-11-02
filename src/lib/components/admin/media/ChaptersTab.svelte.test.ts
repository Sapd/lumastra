// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The chapters tab has two ways to change a track's chapters: hand edits in the
 * table (saved with the header button) and a pasted tracklist (saved in one step
 * from the preview). These tests pin what reaches the API and when the tab
 * claims to have unsaved work, since both paths overwrite stored chapters.
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

import ChaptersTab from './ChaptersTab.svelte';

const STORED = [
    { title: 'Intro', start_ms: 0 },
    { title: 'Main', artist: 'Band', start_ms: 60_000 },
];

function stored(chapters: unknown[] = STORED): unknown {
    return { data: { custom_metadata: { chapters } }, error: undefined };
}

async function renderTab(chapters?: unknown[]): Promise<void> {
    api.getAdminCustomMetadata.mockResolvedValue(stored(chapters));
    render(ChaptersTab, { props: { mediaId: 'track-1', runtimeSeconds: 300 } });
    await screen.findByText(/^Chapters \(/);
}

function saveButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: 'Save' });
}

function titleInputs(): HTMLInputElement[] {
    return screen.getAllByPlaceholderText('Title') as HTMLInputElement[];
}

function pasteBox(): HTMLTextAreaElement {
    return document.getElementById('paste-tracklist-textarea') as HTMLTextAreaElement;
}

beforeEach(() => {
    api.updateAdminCustomMetadata.mockResolvedValue({ data: { ok: true }, error: undefined });
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('ChaptersTab hand edits', () => {
    it('keeps Save disabled until a chapter changes, and Discard restores the stored list', async () => {
        await renderTab();
        expect(saveButton().disabled).toBe(true);
        expect(screen.queryByText('Unsaved changes')).toBeNull();

        await fireEvent.input(titleInputs()[0], { target: { value: 'Opening' } });
        expect(saveButton().disabled).toBe(false);
        expect(screen.getByText('Unsaved changes')).toBeTruthy();

        await fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
        expect(titleInputs()[0].value).toBe('Intro');
        expect(saveButton().disabled).toBe(true);
    });

    it('treats a missing artist and an emptied artist field as the same chapter', async () => {
        await renderTab();
        const firstArtist = screen.getAllByPlaceholderText('Artist')[0];
        await fireEvent.input(firstArtist, { target: { value: 'x' } });
        await fireEvent.input(firstArtist, { target: { value: '' } });
        expect(saveButton().disabled).toBe(true);
    });

    it('keeps an edit typed while the save request is in flight', async () => {
        let finish: (value: unknown) => void = () => {};
        api.updateAdminCustomMetadata.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        await renderTab();

        await fireEvent.input(titleInputs()[0], { target: { value: 'Opening' } });
        await fireEvent.click(saveButton());
        await fireEvent.input(titleInputs()[1], { target: { value: 'Late edit' } });
        finish({ data: { ok: true }, error: undefined });

        await waitFor(() => expect(titleInputs()[1].value).toBe('Late edit'));
        expect(api.updateAdminCustomMetadata).toHaveBeenCalledWith('track-1', {
            chapters: [{ title: 'Opening', start_ms: 0 }, STORED[1]],
        });
        // The late edit was never sent, so the tab must still say so.
        expect(screen.getByText('Unsaved changes')).toBeTruthy();
    });
});

describe('ChaptersTab tracklist import', () => {
    const TRACKLIST = '0:00 Alpha - First (Official Video)\n1:30 Second';

    it('parses while typing and saves the parsed list with one click', async () => {
        await renderTab([]);
        await fireEvent.input(pasteBox(), { target: { value: TRACKLIST } });

        const importButton = await screen.findByRole('button', { name: 'Save chapters (2)' });
        await fireEvent.click(importButton);

        await waitFor(() =>
            expect(api.updateAdminCustomMetadata).toHaveBeenCalledWith('track-1', {
                chapters: [
                    { title: 'First', artist: 'Alpha', start_ms: 0 },
                    { title: 'Second', artist: undefined, start_ms: 90_000 },
                ],
            }),
        );
        await waitFor(() => expect(pasteBox().value).toBe(''));
        expect(titleInputs().map((i) => i.value)).toEqual(['First', 'Second']);
        expect(saveButton().disabled).toBe(true);
    });

    it('labels the import as a replacement when chapters already exist', async () => {
        await renderTab();
        await fireEvent.input(pasteBox(), { target: { value: TRACKLIST } });
        expect(
            await screen.findByRole('button', { name: 'Replace chapters and save (2)' }),
        ).toBeTruthy();
    });

    it('keeps the pasted text when the save fails', async () => {
        api.updateAdminCustomMetadata.mockResolvedValue({ data: undefined, error: 'boom' });
        await renderTab([]);
        await fireEvent.input(pasteBox(), { target: { value: TRACKLIST } });
        await fireEvent.click(await screen.findByRole('button', { name: 'Save chapters (2)' }));

        await waitFor(() => expect(api.updateAdminCustomMetadata).toHaveBeenCalled());
        expect(pasteBox().value).toBe(TRACKLIST);
        expect(screen.queryAllByPlaceholderText('Title')).toHaveLength(0);
    });

    it('asks before an import overwrites unsaved hand edits', async () => {
        // happy-dom ships no window.confirm, so install one rather than spy.
        const confirm = vi.fn(() => false);
        vi.stubGlobal('confirm', confirm);
        window.confirm = confirm;
        await renderTab();
        await fireEvent.input(titleInputs()[0], { target: { value: 'Opening' } });
        await fireEvent.input(pasteBox(), { target: { value: TRACKLIST } });
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Replace chapters and save (2)' }),
        );

        expect(confirm).toHaveBeenCalledOnce();
        expect(api.updateAdminCustomMetadata).not.toHaveBeenCalled();
        expect(titleInputs()[0].value).toBe('Opening');
    });
});

it('saves once and restores the prior ordered chapter list with Undo', async () => {
    const undoId = '00000000-0000-4000-8000-000000000005';
    await renderTab();
    api.updateAdminCustomMetadata.mockResolvedValue({ data: { updated: true, undoId } });
    api.undoAdminCuratedOutput.mockResolvedValue({ data: { updated: true } });
    await fireEvent.input(titleInputs()[0], { target: { value: 'A later opening' } });
    await fireEvent.click(saveButton());
    await fireEvent.click(await screen.findByRole('button', { name: 'Undo chapter changes' }));
    await waitFor(() => expect(titleInputs()[0].value).toBe('Intro'));
    expect(api.updateAdminCustomMetadata).toHaveBeenCalledOnce();
    expect(api.undoAdminCuratedOutput).toHaveBeenCalledExactlyOnceWith(
        'track-1',
        'chapters',
        undoId,
    );
});
