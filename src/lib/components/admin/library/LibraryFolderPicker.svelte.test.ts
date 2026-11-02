// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Folder picker (Add folder / setup wizard): Browse opens an inline panel
 * (never a stacked modal) that lists subdirectories from
 * `browseLibraryFolders`, lets the operator drill in and select a folder,
 * and never offers an already-configured library folder as a target.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const browseLibraryFolders = vi.fn();

vi.mock('$lib/api/admin', () => ({
    browseLibraryFolders: (...args: unknown[]) => browseLibraryFolders(...args),
}));

import LibraryFolderPicker from './LibraryFolderPicker.svelte';

afterEach(() => {
    cleanup();
    browseLibraryFolders.mockReset();
});

describe('LibraryFolderPicker', () => {
    it('opens on Browse, lists roots, navigates into a directory, and selects a folder', async () => {
        browseLibraryFolders.mockImplementation(async (path?: string) => {
            if (!path) {
                return {
                    data: {
                        path: null,
                        entries: [{ name: 'data', path: '/data', readable: true, childCount: 2 }],
                    },
                    error: null,
                    status: 200,
                };
            }
            if (path === '/data') {
                return {
                    data: {
                        path: '/data',
                        entries: [
                            {
                                name: 'stuff',
                                path: '/data/stuff',
                                readable: true,
                                childCount: 0,
                            },
                        ],
                    },
                    error: null,
                    status: 200,
                };
            }
            throw new Error(`unexpected path ${path}`);
        });

        const onSelect = vi.fn();
        render(LibraryFolderPicker, { props: { onSelect } });

        await fireEvent.click(screen.getByRole('button', { name: /browse/i }));

        await waitFor(() => expect(screen.getByText('data')).toBeTruthy());
        expect(screen.getByText('Roots')).toBeTruthy();

        await fireEvent.click(screen.getByText('data'));

        await waitFor(() => expect(screen.getByText('stuff')).toBeTruthy());
        expect(screen.getByRole('button', { name: /select this folder/i })).toBeTruthy();

        await fireEvent.click(screen.getByRole('button', { name: /select this folder/i }));

        expect(onSelect).toHaveBeenCalledWith('/data');
        // Selecting closes the panel.
        expect(screen.queryByText('stuff')).toBeNull();
    });

    it('does not let the operator pick a folder that is already a library', async () => {
        browseLibraryFolders.mockResolvedValue({
            data: {
                path: null,
                entries: [
                    {
                        name: 'stuff',
                        path: '/srv/stuff',
                        readable: true,
                        childCount: 1,
                        libraryGroupId: 'g1',
                        libraryName: 'Family',
                    },
                ],
            },
            error: null,
            status: 200,
        });

        render(LibraryFolderPicker, { props: { onSelect: vi.fn() } });
        await fireEvent.click(screen.getByRole('button', { name: /browse/i }));

        await waitFor(() => expect(screen.getByText('stuff')).toBeTruthy());
        expect(screen.getByText('already in Family')).toBeTruthy();

        const entryButton = screen.getByRole('button', {
            name: /stuff.*already in Family/i,
        }) as HTMLButtonElement;
        expect(entryButton.disabled).toBe(true);

        await fireEvent.click(entryButton);
        // Disabled — no navigation happened, still on the roots listing.
        expect(browseLibraryFolders).toHaveBeenCalledTimes(1);
    });

    it('shows a friendly message on a 403 from the server', async () => {
        browseLibraryFolders.mockResolvedValue({
            data: null,
            error: 'Outside allowed roots',
            status: 403,
        });

        render(LibraryFolderPicker, { props: { onSelect: vi.fn() } });
        await fireEvent.click(screen.getByRole('button', { name: /browse/i }));

        await waitFor(() =>
            expect(screen.getByText(/outside the folders the server lets you browse/)).toBeTruthy(),
        );
    });

    it('closes on Escape and returns focus to the Browse button', async () => {
        browseLibraryFolders.mockResolvedValue({
            data: { path: null, entries: [] },
            error: null,
            status: 200,
        });

        render(LibraryFolderPicker, { props: { onSelect: vi.fn() } });
        const browseButton = screen.getByRole('button', { name: /browse/i });
        await fireEvent.click(browseButton);

        await waitFor(() => expect(screen.getByText('No subfolders here')).toBeTruthy());

        const panel = screen.getByRole('group', { name: /choose a folder/i });
        await fireEvent.keyDown(panel, { key: 'Escape' });

        expect(screen.queryByText('No subfolders here')).toBeNull();
        expect(document.activeElement).toBe(browseButton);
    });
});
