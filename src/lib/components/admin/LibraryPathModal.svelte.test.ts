// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Picking a library in the path editor brings that library's settings along.
 *
 * The bug: choosing the "Music" group left Media Type on "Movie" and the
 * provider on "TMDB", so the form was one click from filing a music folder
 * under a movie matcher (or from a save-time group-consistency rejection).
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));
vi.mock('$lib/paths', () => ({ resolve: (p: string) => p }));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('$lib/stores/modal.store', () => ({ modals: { close: vi.fn(), open: vi.fn() } }));
vi.mock('$lib/api/admin', () => ({
    createLibraryPath: vi.fn(),
    patchLibraryPath: vi.fn(),
    validateLibraryPath: vi.fn(),
    getRemoteLibraries: vi.fn(async () => ({ data: null, error: null })),
    browseLibraryFolders: vi.fn(async () => ({
        data: {
            path: null,
            entries: [{ name: 'a', path: '/srv/stuff/a', readable: true, childCount: 0 }],
        },
        error: null,
        status: 200,
    })),
}));

import LibraryPathModal from './LibraryPathModal.svelte';
import {
    createLibraryPath,
    patchLibraryPath,
    validateLibraryPath,
    getRemoteLibraries,
} from '$lib/api/admin';
import { getLocale, overwriteGetLocale } from '$lib/paraglide/runtime.js';
const originalGetLocale = getLocale;
import { toasts } from '$lib/stores/toast.store';
afterEach(() => overwriteGetLocale(originalGetLocale));

const groups = [
    {
        id: 'g-movies',
        name: 'Family',
        sortOrder: 0,
        mediaType: 'movie' as const,
        provider: 'tmdb' as const,
        language: 'en',
    },
    {
        id: 'g-music',
        name: 'Evening',
        sortOrder: 1,
        mediaType: 'music' as const,
        provider: 'tmdb' as const,
        language: 'de',
        fallbackProviders: ['anidb' as const],
    },
    { id: 'g-empty', name: 'Empty', sortOrder: 2 },
];

function select(id: string): HTMLSelectElement {
    return document.getElementById(id) as HTMLSelectElement;
}

describe('LibraryPathModal — group drives the path settings', () => {
    afterEach(cleanup);

    it("takes the chosen library's media type, provider and language", async () => {
        render(LibraryPathModal, { props: { groups, onSaved: vi.fn() } });
        expect(select('lp-media-type').value).toBe('movie');

        await fireEvent.change(select('lp-group'), { target: { value: 'g-music' } });

        expect(select('lp-media-type').value).toBe('music');
        expect(select('lp-provider').value).toBe('tmdb');
        // The server requires one fallback chain per library.
        expect((screen.getByRole('checkbox', { name: 'ANIDB' }) as HTMLInputElement).checked).toBe(
            true,
        );
        expect((document.getElementById('lp-language') as HTMLInputElement).value).toBe('de');
        expect(screen.getByText('Matches the other folders in Evening.')).toBeTruthy();
    });

    it('leaves the form alone for an empty library, which has nothing to bring', async () => {
        render(LibraryPathModal, { props: { groups, onSaved: vi.fn() } });
        await fireEvent.change(select('lp-media-type'), { target: { value: 'anime' } });

        await fireEvent.change(select('lp-group'), { target: { value: 'g-empty' } });

        expect(select('lp-media-type').value).toBe('anime');
        expect(screen.queryByText(/Matches the other folders/)).toBeNull();
    });

    it('fills the path input from the folder picker', async () => {
        render(LibraryPathModal, { props: { groups, onSaved: vi.fn() } });

        await fireEvent.click(screen.getByRole('button', { name: /browse/i }));
        await screen.findByText('a');
        await fireEvent.click(screen.getByText('a'));
        await screen.findByRole('button', { name: /select this folder/i });
        await fireEvent.click(screen.getByRole('button', { name: /select this folder/i }));

        expect((document.getElementById('lp-path') as HTMLInputElement).value).toBe('/srv/stuff/a');
    });
});

describe('LibraryPathModal — audiobooks only from AudiobookShelf', () => {
    afterEach(cleanup);

    function mediaTypeOptions(): string[] {
        return Array.from(select('lp-media-type').options).map((o) => o.value);
    }

    it('does not offer Audiobook for a new folder and points to AudiobookShelf', () => {
        render(LibraryPathModal, { props: { groups, onSaved: vi.fn() } });
        expect(mediaTypeOptions()).not.toContain('audiobook');
        expect(screen.getByText(/Audiobooks come only from AudiobookShelf/)).toBeTruthy();
        // The AudiobookShelf source stays available.
        expect(Array.from(select('lp-source').options).map((o) => o.value)).toContain(
            'audiobookshelf',
        );
    });

    it('keeps Audiobook for an existing local audiobook folder and explains why it is empty', () => {
        render(LibraryPathModal, {
            props: {
                groups,
                onSaved: vi.fn(),
                path: {
                    id: 'p-1',
                    path: '/srv/stuff/books',
                    mediaType: 'audiobook',
                    language: 'en',
                    provider: 'musicbrainz',
                    enabled: true,
                    libraryGroupId: 'g-empty',
                },
            },
        });
        expect(mediaTypeOptions()).toContain('audiobook');
        expect(select('lp-media-type').value).toBe('audiobook');
        expect(screen.getByTestId('local-audiobook-notice').textContent).toMatch(/imports nothing/);
    });
});

describe('LibraryPathModal — declared ABS language', () => {
    afterEach(cleanup);
    it('starts a newly selected remote source with no declared language', async () => {
        render(LibraryPathModal, { props: { groups, onSaved: vi.fn() } });
        await fireEvent.change(select('lp-source'), { target: { value: 'audiobookshelf' } });
        expect((document.getElementById('lp-language') as HTMLInputElement).value).toBe('');
    });

    it('allows clearing an ABS language instead of silently restoring English', async () => {
        vi.mocked(patchLibraryPath).mockResolvedValue({
            data: { path: {} },
            error: null,
            status: 200,
        } as Awaited<ReturnType<typeof patchLibraryPath>>);
        render(LibraryPathModal, {
            props: {
                groups,
                onSaved: vi.fn(),
                path: {
                    id: 'p-abs',
                    path: 'abs://books',
                    mediaType: 'audiobook',
                    language: 'de',
                    provider: 'audiobookshelf',
                    providerPath: 'books',
                    enabled: true,
                    libraryGroupId: 'g-empty',
                },
            },
        });
        await fireEvent.input(document.getElementById('lp-language')!, { target: { value: '' } });
        await fireEvent.click(screen.getByRole('button', { name: /save/i }));
        expect(patchLibraryPath).toHaveBeenCalledWith(
            'p-abs',
            expect.objectContaining({ language: '' }),
        );
    });
});

describe('LibraryPathModal — effective language default', () => {
    afterEach(cleanup);
    it('leaves a new library language to the server instead of forcing English', async () => {
        vi.mocked(validateLibraryPath).mockResolvedValue({
            data: { exists: true, isDirectory: true, readable: true, isEmpty: false },
            error: null,
            status: 200,
        } as Awaited<ReturnType<typeof validateLibraryPath>>);
        vi.mocked(createLibraryPath).mockResolvedValue({
            data: { path: {} },
            error: null,
            status: 201,
        } as Awaited<ReturnType<typeof createLibraryPath>>);
        render(LibraryPathModal, {
            props: { groups: [groups[2]], defaultGroupId: 'g-empty', onSaved: vi.fn() },
        });
        expect(screen.getByPlaceholderText('Configured metadata language')).toBeTruthy();
        await fireEvent.input(document.getElementById('lp-path')!, {
            target: { value: '/srv/stuff/a' },
        });
        await fireEvent.click(screen.getByRole('button', { name: /add folder/i }));
        await waitFor(() => expect(createLibraryPath).toHaveBeenCalled());
        expect(vi.mocked(createLibraryPath).mock.calls.at(-1)?.[0].language).toBeUndefined();
    });
});

describe('LibraryPathModal — German folder create/edit', () => {
    afterEach(cleanup);
    it.each([false, true])('localizes the form and save toast (edit=%s)', async (edit) => {
        overwriteGetLocale(() => 'de');
        vi.mocked(validateLibraryPath).mockResolvedValue({
            data: { exists: true, isDirectory: true, readable: true, isEmpty: false },
            error: null,
            status: 200,
        } as Awaited<ReturnType<typeof validateLibraryPath>>);
        vi.mocked(createLibraryPath).mockResolvedValue({
            data: { path: {} },
            error: null,
            status: 201,
        } as Awaited<ReturnType<typeof createLibraryPath>>);
        vi.mocked(patchLibraryPath).mockResolvedValue({
            data: { path: {} },
            error: null,
            status: 200,
        } as Awaited<ReturnType<typeof patchLibraryPath>>);
        render(LibraryPathModal, {
            props: {
                groups,
                defaultGroupId: 'g-movies',
                onSaved: vi.fn(),
                ...(edit
                    ? {
                          path: {
                              id: 'p-movie',
                              path: '/srv/films',
                              mediaType: 'movie' as const,
                              language: 'de',
                              provider: 'tmdb' as const,
                              enabled: true,
                              libraryGroupId: 'g-movies',
                          },
                      }
                    : {}),
            },
        });
        expect(
            screen.getByRole('heading', { name: edit ? 'Ordner bearbeiten' : 'Ordner hinzufügen' }),
        ).toBeTruthy();
        expect(screen.getByLabelText('Medientyp')).toBeTruthy();
        expect(screen.getByRole('option', { name: 'Serien' })).toBeTruthy();
        expect(screen.queryByText('Fernseher')).toBeNull();
        expect(screen.getByLabelText('Metadatenanbieter')).toBeTruthy();
        expect(screen.getByText('Kapitel aus Dateien auslesen')).toBeTruthy();
        if (!edit)
            await fireEvent.input(document.getElementById('lp-path')!, {
                target: { value: '/srv/films' },
            });
        await fireEvent.click(
            screen.getByRole('button', {
                name: edit ? 'Änderungen speichern' : 'Ordner hinzufügen',
            }),
        );
        await waitFor(() =>
            expect(toasts.success).toHaveBeenCalledWith(
                edit ? 'Ordner aktualisiert' : 'Ordner hinzugefügt',
            ),
        );
    });
    it('localizes folder validation errors', async () => {
        overwriteGetLocale(() => 'de');
        vi.mocked(validateLibraryPath).mockResolvedValue({
            data: { exists: false, isDirectory: false, readable: false, isEmpty: false },
            error: null,
            status: 200,
        } as Awaited<ReturnType<typeof validateLibraryPath>>);
        render(LibraryPathModal, {
            props: { groups, defaultGroupId: 'g-movies', onSaved: vi.fn() },
        });
        await fireEvent.input(document.getElementById('lp-path')!, {
            target: { value: '/missing' },
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Ordner hinzufügen' }));
        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith(
                expect.stringContaining('Ordner „/missing“ wurde nicht gefunden'),
            ),
        );
    });
});

it('localizes the nested remote picker and import save toast', async () => {
    overwriteGetLocale(() => 'de');
    vi.mocked(getRemoteLibraries).mockResolvedValue({
        data: {
            provider: 'audiobookshelf',
            mediaType: 'audiobook',
            label: 'AudiobookShelf',
            status: 'ok',
            settingsHref: '/admin/settings/connections',
            requiredKeys: [],
            libraries: [
                {
                    id: 'books',
                    name: 'Meine Bücher',
                    kind: 'book',
                    supported: true,
                    path: 'abs://books',
                },
            ],
        },
        error: null,
        status: 200,
    });
    vi.mocked(createLibraryPath).mockResolvedValue({
        data: { path: {} },
        error: null,
        status: 201,
    } as Awaited<ReturnType<typeof createLibraryPath>>);
    render(LibraryPathModal, {
        props: { groups: [groups[2]], defaultGroupId: 'g-empty', onSaved: vi.fn() },
    });
    await fireEvent.change(select('lp-source'), { target: { value: 'audiobookshelf' } });
    await screen.findByRole('option', { name: 'Meine Bücher' });
    expect(screen.getByText('Die Namen stammen direkt aus AudiobookShelf.')).toBeTruthy();
    await fireEvent.change(select('lp-remote-library'), { target: { value: 'books' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Ordner hinzufügen' }));
    await waitFor(() =>
        expect(toasts.success).toHaveBeenCalledWith(
            'Meine Bücher hinzugefügt. Die erste Synchronisierung startet in Kürze.',
        ),
    );
});
