// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The setup wizard's per-folder inputs each get a folder picker (Browse).
 * Picking a folder there fills that row's input, same as typing the path.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));
vi.mock('$lib/paths', () => ({ resolve: (p: string) => p }));
const toasts = vi.hoisted(() => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));
vi.mock('$lib/stores/modal.store', () => ({ modals: { close: vi.fn(), open: vi.fn() } }));
vi.mock('$lib/api/admin', () => ({
    createLibrary: vi.fn(),
    validateLibraryPath: vi.fn(),
    triggerFileScanner: vi.fn(),
    browseLibraryFolders: vi.fn(async () => ({
        data: {
            path: null,
            entries: [{ name: 'a', path: '/srv/stuff/a', readable: true, childCount: 0 }],
        },
        error: null,
        status: 200,
    })),
}));

import LibrarySetupWizard from './LibrarySetupWizard.svelte';
import { createLibrary, triggerFileScanner, validateLibraryPath } from '$lib/api/admin';

describe('LibrarySetupWizard — folder picker', () => {
    afterEach(cleanup);

    it('fills a folder row from the picker', async () => {
        render(LibrarySetupWizard, { props: { onSaved: vi.fn() } });

        await fireEvent.click(screen.getByRole('button', { name: /browse/i }));
        await screen.findByText('a');
        await fireEvent.click(screen.getByText('a'));
        await screen.findByRole('button', { name: /select this folder/i });
        await fireEvent.click(screen.getByRole('button', { name: /select this folder/i }));

        const pathInputs = screen.getAllByPlaceholderText('/mnt/media/movies');
        expect((pathInputs[0] as HTMLInputElement).value).toBe('/srv/stuff/a');
    });
});

describe('LibrarySetupWizard — audiobooks only from AudiobookShelf', () => {
    afterEach(cleanup);

    it('offers no Audiobooks type and links to the AudiobookShelf settings', () => {
        render(LibrarySetupWizard, { props: { onSaved: vi.fn() } });
        expect(screen.queryByRole('button', { name: /audiobook/i })).toBeNull();
        expect(screen.getByRole('button', { name: /music/i })).toBeTruthy();
        const link = screen.getByRole('link', { name: 'AudiobookShelf settings' });
        expect(link.getAttribute('href')).toBe('/admin/settings/audiobookshelf');
    });
});

describe('LibrarySetupWizard — create', () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    async function createWithFolder(): Promise<void> {
        await fireEvent.input(screen.getAllByPlaceholderText('/mnt/media/movies')[0], {
            target: { value: '/srv/stuff/a' },
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Create library' }));
    }

    it('reports a scan that could not be started instead of "scanning now"', async () => {
        vi.mocked(validateLibraryPath).mockResolvedValue({
            data: { exists: true, isDirectory: true, readable: true, isEmpty: false },
            error: null,
            status: 200,
        } as never);
        vi.mocked(createLibrary).mockResolvedValue({
            data: { group: { id: 'g1' }, paths: [{ id: 'p1' }] },
            error: null,
            status: 201,
        } as never);
        vi.mocked(triggerFileScanner).mockResolvedValue({
            data: null,
            error: 'scanner busy',
            status: 503,
        } as never);
        const onSaved = vi.fn();
        render(LibrarySetupWizard, { props: { onSaved } });
        await createWithFolder();

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(triggerFileScanner).toHaveBeenCalledWith({ paths: ['p1'] });
        expect(toasts.success).not.toHaveBeenCalled();
        expect(toasts.warning).toHaveBeenCalledWith(expect.stringContaining('scanner busy'));
    });

    it('never falls back to the scan-every-library call when no folder ids come back', async () => {
        vi.mocked(validateLibraryPath).mockResolvedValue({
            data: null,
            error: 'timeout',
            status: 0,
        } as never);
        vi.mocked(createLibrary).mockResolvedValue({
            data: { group: { id: 'g1' }, paths: [] },
            error: null,
            status: 201,
        } as never);
        const onSaved = vi.fn();
        render(LibrarySetupWizard, { props: { onSaved } });
        await createWithFolder();

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(triggerFileScanner).not.toHaveBeenCalled();
        // The failed folder check is surfaced, not silently skipped.
        expect(toasts.warning).toHaveBeenCalledWith(expect.stringContaining('/srv/stuff/a'));
    });
});
