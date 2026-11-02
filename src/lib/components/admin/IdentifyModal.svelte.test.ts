// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Identify rematches a library item to a provider id and enqueues a metadata
 * sync. These tests pin that one confirmation sends one match, and that the
 * outcome reported is the server's, not a side effect of the search box.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
    searchProvider: vi.fn(),
    matchUnmatchedFileDetailed: vi.fn(),
    mergeMediaItems: vi.fn(),
    getRepairMediaFiles: vi.fn(),
    getFileEpisodes: vi.fn(),
    setFileEpisodes: vi.fn(),
    clearFileEpisodes: vi.fn(),
    searchFileEpisodeSeries: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock('$lib/api/admin', () => api);
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

import IdentifyModal from './IdentifyModal.svelte';

const RESULT = {
    provider: 'tmdb',
    externalId: '603',
    title: 'The Lantern',
    year: 1999,
    type: 'movie',
};

async function renderModal(onidentified = vi.fn()): Promise<HTMLElement> {
    api.searchProvider.mockResolvedValue({ data: { results: [RESULT] }, error: undefined });
    render(IdentifyModal, {
        props: {
            item: { id: 'item-1', title: 'The Lantern', mediaType: 'movie' },
            onidentified,
            onclose: vi.fn(),
        },
    });
    return (await screen.findByText('The Lantern', { selector: 'button *, button' })).closest(
        'button',
    ) as HTMLElement;
}

afterEach(() => {
    cleanup();
    vi.resetAllMocks();
});

describe('IdentifyModal confirm', () => {
    it('a repeated Enter in the result list sends one match', async () => {
        let resolveMatch!: (value: unknown) => void;
        api.matchUnmatchedFileDetailed.mockReturnValue(
            new Promise((resolve) => {
                resolveMatch = resolve;
            }),
        );
        const onidentified = vi.fn();
        const row = await renderModal(onidentified);

        await fireEvent.keyDown(row, { key: 'Enter' });
        await fireEvent.keyDown(row, { key: 'Enter' });
        resolveMatch({ ok: true });

        await waitFor(() => expect(onidentified).toHaveBeenCalledTimes(1));
        expect(api.matchUnmatchedFileDetailed).toHaveBeenCalledTimes(1);
    });

    it('typing a new search while the match runs still reports the match', async () => {
        let resolveMatch!: (value: unknown) => void;
        api.matchUnmatchedFileDetailed.mockReturnValue(
            new Promise((resolve) => {
                resolveMatch = resolve;
            }),
        );
        const onidentified = vi.fn();
        const row = await renderModal(onidentified);
        await fireEvent.keyDown(row, { key: 'Enter' });

        // Synthetic events on the locked search control cannot replace the pending pick.
        const search = screen.getByRole('searchbox');
        await fireEvent.input(search, { target: { value: 'Matrix Reloaded' } });
        await fireEvent.keyDown(search, { key: 'Enter' });
        resolveMatch({ ok: true });

        await waitFor(() => expect(onidentified).toHaveBeenCalledTimes(1));
        expect(toasts.error).not.toHaveBeenCalled();
        expect(toasts.success).toHaveBeenCalledWith(expect.stringContaining('The Lantern'), 8000);
    });
});

describe('IdentifyModal duplicate series repair', () => {
    async function conflictModal(
        files: number,
        targetFiles = 1,
        onidentified = vi.fn(),
    ): Promise<void> {
        api.searchProvider.mockResolvedValue({
            data: { results: [{ ...RESULT, type: 'series' }] },
        });
        api.matchUnmatchedFileDetailed.mockResolvedValue({
            ok: false,
            status: 409,
            conflictMediaId: 'canonical',
            fileMediaId: 'source',
        });
        api.getRepairMediaFiles.mockImplementation(async (id: string) => ({
            data: {
                files:
                    id === 'canonical'
                        ? Array.from({ length: targetFiles }, (_, i) => ({
                              id: 'target-file-' + i,
                              file_path: '/canonical/existing.mkv',
                          }))
                        : Array.from({ length: files }, (_, i) => ({
                              id: 'file-' + i,
                              file_path: `/source/${i}.mkv`,
                          })),
            },
        }));
        render(IdentifyModal, {
            item: { id: 'source', title: 'The Lantern', mediaType: 'series' },
            onidentified,
            onclose: vi.fn(),
        });
        await screen.findByText('The Lantern', { selector: 'button *, button' });
        await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        await screen.findByText(
            `Files in source: ${files} · Files in existing entry: ${targetFiles}`,
        );
    }
    it('blocks both-have-files merge and exposes every source file for staged link review', async () => {
        await conflictModal(2);
        expect(
            (screen.getByRole('button', { name: 'Merge entries' }) as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(screen.getAllByRole('button', { name: 'Review episode links' })).toHaveLength(2);
        expect(api.mergeMediaItems).not.toHaveBeenCalled();
    });
    it('blocks both-fileless merges with actionable guidance and rechecks the handler', async () => {
        await conflictModal(0, 1);
        api.getRepairMediaFiles.mockResolvedValue({ data: { files: [] } });
        const merge = screen.getByRole('button', { name: 'Merge entries' }) as HTMLButtonElement;
        expect(merge.disabled).toBe(false);
        await fireEvent.click(merge);
        await screen.findByText(/Neither entry has files/);
        expect(merge.disabled).toBe(true);
        expect(api.mergeMediaItems).not.toHaveBeenCalled();
    });
    it('locks provider choices and ignores Enter during a deferred merge', async () => {
        const onidentified = vi.fn();
        await conflictModal(0, 1, onidentified);
        let resolveMerge!: (value: unknown) => void;
        api.mergeMediaItems.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveMerge = resolve;
            }),
        );
        await fireEvent.click(screen.getByRole('button', { name: 'Merge entries' }));
        await waitFor(() => expect(api.mergeMediaItems).toHaveBeenCalledOnce());
        const result = screen
            .getByText('The Lantern', { selector: 'button *, button' })
            .closest('button')!;
        expect(result.disabled).toBe(true);
        expect((screen.getByRole('searchbox') as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
        await fireEvent.keyDown(result, { key: 'Enter' });
        expect(api.matchUnmatchedFileDetailed).toHaveBeenCalledOnce();
        resolveMerge({ data: { keepId: 'canonical', itemsDeleted: 1, seasonsReparented: 0 } });
        await waitFor(() => expect(onidentified).toHaveBeenCalledWith('canonical'));
    });
    it('requires series reassignment even when the selected canonical series is fileless', async () => {
        await conflictModal(1, 0);
        expect(
            (screen.getByRole('button', { name: 'Merge entries' }) as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(screen.getByText(/Move all remaining source files/)).toBeTruthy();
        expect(screen.getAllByRole('button', { name: 'Review episode links' })).toHaveLength(1);
        expect(api.mergeMediaItems).not.toHaveBeenCalled();
    });
    it('refreshes ownership and retains the canonical entry after all source links moved', async () => {
        const onidentified = vi.fn();
        await conflictModal(0, 1, onidentified);
        api.mergeMediaItems.mockResolvedValue({
            data: { keepId: 'canonical', itemsDeleted: 1, seasonsReparented: 0 },
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Merge entries' }));
        await waitFor(() =>
            expect(api.mergeMediaItems).toHaveBeenCalledWith('canonical', 'source'),
        );
        expect(api.getRepairMediaFiles).toHaveBeenCalledTimes(4);
        await waitFor(() => expect(onidentified).toHaveBeenCalledWith('canonical'));
    });
});

it('moving one of several source files refreshes the remaining scope and keeps merge blocked', async () => {
    let remaining = 2;
    api.searchProvider.mockResolvedValue({ data: { results: [{ ...RESULT, type: 'series' }] } });
    api.matchUnmatchedFileDetailed.mockResolvedValue({
        ok: false,
        status: 409,
        conflictMediaId: 'canonical',
        fileMediaId: 'source',
    });
    api.getRepairMediaFiles.mockImplementation(async (id: string) => ({
        data: {
            files:
                id === 'canonical'
                    ? [{ id: 'target-file', file_path: '/canonical/existing.mkv' }]
                    : Array.from({ length: remaining }, (_, i) => ({
                          id: 'file-' + (i + (remaining === 1 ? 1 : 0)),
                          file_path: `/source/${i}.mkv`,
                      })),
        },
    }));
    const editorData = {
        file: { id: 'file-0', filePath: '/source/0.mkv', durationMs: 100000, manual: false },
        links: [],
        chapters: [],
        episodes: [
            { id: 'new-episode', seasonNumber: 1, episodeNumber: 1, title: 'Canonical episode' },
        ],
    };
    api.getFileEpisodes.mockResolvedValue({ data: editorData });
    api.setFileEpisodes.mockImplementation(async () => {
        remaining = 1;
        return {
            data: { ...editorData, links: [{ mediaItemId: 'new-episode', isDefault: true }] },
        };
    });
    render(IdentifyModal, {
        item: { id: 'source', title: 'The Lantern', mediaType: 'series' },
        onidentified: vi.fn(),
        onclose: vi.fn(),
    });
    await screen.findByText('The Lantern', { selector: 'button *, button' });
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    const repair = await screen.findAllByRole('button', { name: 'Review episode links' });
    await fireEvent.click(repair[0]);
    await screen.findByRole('option', { name: 'S01E01 — Canonical episode' });
    await fireEvent.change(screen.getByRole('combobox', { name: 'Choose an episode…' }), {
        target: { value: 'new-episode' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
    await waitFor(() => expect(remaining).toBe(1));
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await screen.findByText('Files in source: 1 · Files in existing entry: 1');
    await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })),
    );
    expect(
        (screen.getByRole('button', { name: 'Merge entries' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Review episode links' })).toHaveLength(1);
});

describe('IdentifyModal movie keeper identity', () => {
    async function movieConflict(onidentified = vi.fn()): Promise<void> {
        api.matchUnmatchedFileDetailed.mockResolvedValueOnce({
            ok: false,
            status: 409,
            conflictMediaId: 'canonical',
            fileMediaId: 'item-1',
        });
        api.getRepairMediaFiles.mockImplementation(async (id: string) => ({
            data: { files: id === 'item-1' ? [{ id: 'file', file_path: '/movie.mkv' }] : [] },
        }));
        api.mergeMediaItems.mockResolvedValue({
            data: { keepId: 'item-1', itemsDeleted: 1, seasonsReparented: 0 },
        });
        await renderModal(onidentified);
        await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        await screen.findByText('Files in source: 1 · Files in existing entry: 0');
        expect(screen.queryByRole('button', { name: 'Review episode links' })).toBeNull();
    }
    it('reapplies the selected provider identity to the file-bearing movie keeper', async () => {
        const onidentified = vi.fn();
        await movieConflict(onidentified);
        api.matchUnmatchedFileDetailed.mockResolvedValueOnce({ ok: true, status: 200 });
        await fireEvent.click(screen.getByRole('button', { name: 'Merge entries' }));
        await waitFor(() => expect(onidentified).toHaveBeenCalledWith('item-1'));
        expect(api.mergeMediaItems).toHaveBeenCalledWith('item-1', 'canonical');
        expect(api.matchUnmatchedFileDetailed).toHaveBeenLastCalledWith('item-1', {
            provider: 'tmdb',
            externalId: '603',
            type: 'movie',
        });
    });
    it('reports partial merge success and retries only identity when the post-merge match fails', async () => {
        const onidentified = vi.fn();
        await movieConflict(onidentified);
        api.matchUnmatchedFileDetailed.mockResolvedValueOnce({
            ok: false,
            status: 503,
            error: 'service offline',
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Merge entries' }));
        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith(
                expect.stringContaining('Entries merged: 1 removed; 0 seasons moved.'),
            ),
        );
        expect(onidentified).not.toHaveBeenCalled();
        expect(screen.getByRole('alert').textContent).toContain(
            'Entries merged: 1 removed; 0 seasons moved.',
        );
        expect(screen.getByRole('alert').textContent).toContain('service offline');
        expect(screen.getByRole('alert').textContent).toContain('Use Confirm to retry');
        expect(screen.queryByRole('button', { name: 'Merge entries' })).toBeNull();
        api.matchUnmatchedFileDetailed.mockResolvedValueOnce({ ok: true, status: 200 });
        await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        await waitFor(() => expect(onidentified).toHaveBeenCalledWith('item-1'));
        expect(api.mergeMediaItems).toHaveBeenCalledTimes(1);
    });
});
