// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * One-library page. Drives the REAL page with `$lib/api/admin`
 * mocked, same shape as the overview page's own test
 * (`../page.svelte.test.ts`).
 *
 * Fixtures deliberately use a name/path that does NOT match the library's
 * type ("Evening" is a movie library, "/srv/stuff/a" is its folder) — the
 * design doc's invariant is that names and paths carry no meaning, so a test
 * that used "Movies"/"/data/movies" could pass by accident on a name-based
 * shortcut.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

const pageState = vi.hoisted(() => ({
    url: new URL('http://localhost/admin/library/sources/lib-1'),
    data: {},
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/state', () => ({ page: pageState }));
vi.mock('$app/stores', () => ({
    page: readable(pageState),
    navigating: readable(null),
}));
const goto = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', () => ({
    invalidateAll: vi.fn(),
    goto,
    replaceState: vi.fn(),
}));
vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

// The modal host isn't mounted in this harness — capture what `modals.open`
// was called with instead, same technique as
// src/routes/admin/users/client-diagnostics/page.svelte.test.ts.
const modals = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock('$lib/stores/modal.store', () => ({ modals }));

vi.mock('$lib/api/client.js', () => {
    const empty = async () => ({ data: null, error: null, status: 200 });
    return { apiGet: empty, apiPost: empty, apiPut: empty, apiPatch: empty, apiDelete: empty };
});

const api = vi.hoisted(() => ({
    getLibraryGroups: vi.fn(),
    getLibraryPaths: vi.fn(),
    updateLibrary: vi.fn(),
    deleteLibraryGroup: vi.fn(),
    patchLibraryPath: vi.fn(),
    deleteLibraryPath: vi.fn(),
    getRemoteLibraries: vi.fn(),
    getFileScannerStatus: vi.fn(),
    triggerFileScanner: vi.fn(),
    getLibraryGroupPermissions: vi.fn(),
    getAvailableGroups: vi.fn(),
    saveLibraryGroupPermissions: vi.fn(),
    getLatestScannerRunPerLibrary: vi.fn(),
    getScannerRuns: vi.fn(),
}));
vi.mock('$lib/api/admin', async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return { ...original, ...api };
});

import { getLocale, overwriteGetLocale } from '$lib/paraglide/runtime.js';
const originalGetLocale = getLocale;
afterEach(() => overwriteGetLocale(originalGetLocale));
import LibraryDetailPage from './+page.svelte';
import LibraryPathModal from '$lib/components/admin/LibraryPathModal.svelte';
import type { PageData } from './$types';

/**
 * happy-dom does not implement the `:checked` CSS pseudo-class for
 * `<option>` elements, which is what Svelte 5's `bind:value` on a `<select>`
 * queries to read the new selection after a `change` event — every select
 * interaction silently no-ops without this. Scoped to the one test that
 * changes a `<select>`; every other test leaves `querySelector` untouched.
 */
function withCheckedPseudoClass<T>(run: () => Promise<T>): Promise<T> {
    const original = Element.prototype.querySelector;
    Element.prototype.querySelector = function (this: Element, selector: string) {
        if (
            (selector === ':checked' || selector === 'option:checked') &&
            this instanceof HTMLSelectElement
        ) {
            return [...this.options].find((o) => o.selected) ?? null;
        }
        return original.call(this, selector);
    } as typeof original;
    return run().finally(() => {
        Element.prototype.querySelector = original;
    });
}

const LIB_ID = '11111111-1111-4111-8111-000000000009';
const PATH_ID = '22222222-2222-4222-8222-000000000009';

/** A movie library named "Evening" with one filesystem folder at "/srv/stuff/a" — see file header. */
function movieLibraryFixtures() {
    return {
        groups: [{ id: LIB_ID, name: 'Evening', icon: null, sortOrder: 0, maxAgeRating: null }],
        paths: [
            {
                id: PATH_ID,
                path: '/srv/stuff/a',
                mediaType: 'movie',
                language: 'en',
                provider: 'tmdb',
                enabled: true,
                providerPath: null,
                libraryGroupId: LIB_ID,
                editionLabel: null,
                scanChapters: false,
                fallbackProviders: [],
            },
        ],
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    api.getFileScannerStatus.mockResolvedValue({
        data: { isRunning: false, progress: null, libraries: [] },
        error: null,
    });
    api.getLibraryGroupPermissions.mockResolvedValue({ data: { permissions: [] }, error: null });
    api.getAvailableGroups.mockResolvedValue({ data: { groups: [] }, error: null });
    api.getLatestScannerRunPerLibrary.mockResolvedValue({ data: { items: [] }, error: null });
    api.getScannerRuns.mockResolvedValue({ data: { items: [] }, error: null });
});

afterEach(() => {
    cleanup();
});

async function renderPage(): Promise<void> {
    render(LibraryDetailPage, { props: { data: { id: LIB_ID } as PageData } });
    await screen.findByText('Evening');
}

describe('library detail page — folders', () => {
    it("renders folders including a remote folder's upstream name", async () => {
        const { groups, paths } = movieLibraryFixtures();
        api.getLibraryGroups.mockResolvedValue({ data: { items: groups }, error: null });
        api.getLibraryPaths.mockResolvedValue({ data: { items: paths }, error: null });
        await renderPage();

        expect(screen.getByText('/srv/stuff/a')).toBeTruthy();
    });

    it("shows a remote folder by the upstream library's own name", async () => {
        const remoteGroupId = '11111111-1111-4111-8111-00000000000a';
        const remotePathId = '22222222-2222-4222-8222-00000000000a';
        api.getLibraryGroups.mockResolvedValue({
            data: {
                items: [
                    {
                        id: remoteGroupId,
                        name: 'Garage',
                        icon: null,
                        sortOrder: 0,
                        maxAgeRating: null,
                    },
                ],
            },
            error: null,
        });
        api.getLibraryPaths.mockResolvedValue({
            data: {
                items: [
                    {
                        id: remotePathId,
                        path: 'abs://upstream-uuid',
                        mediaType: 'audiobook',
                        language: 'de',
                        provider: 'audiobookshelf',
                        enabled: true,
                        providerPath: 'upstream-uuid',
                        libraryGroupId: remoteGroupId,
                        editionLabel: null,
                        scanChapters: false,
                        fallbackProviders: [],
                    },
                ],
            },
            error: null,
        });
        api.getRemoteLibraries.mockResolvedValue({
            data: {
                status: 'ok',
                provider: 'audiobookshelf',
                label: 'AudiobookShelf',
                mediaType: 'audiobook',
                settingsHref: '/admin/settings/audiobookshelf',
                requiredKeys: [],
                libraries: [
                    { id: 'upstream-uuid', name: 'Hörbücher DE', path: 'abs://upstream-uuid' },
                ],
            },
            error: null,
        });

        render(LibraryDetailPage, { props: { data: { id: remoteGroupId } as PageData } });
        await screen.findByText('Garage');

        await waitFor(() => expect(screen.getByText('Hörbücher DE')).toBeTruthy());
        // Type/provider are read-only for a remote-source library.
        expect(screen.queryByLabelText('Media Type')).toBeNull();
        // An empty remote library is a connection question: point at its settings.
        expect(
            screen
                .getByRole('link', { name: 'AudiobookShelf connection & sync health' })
                .getAttribute('href'),
        ).toBe('/admin/settings/audiobookshelf');
    });

    it('Add folder opens LibraryPathModal with inherited defaults', async () => {
        const { groups, paths } = movieLibraryFixtures();
        api.getLibraryGroups.mockResolvedValue({ data: { items: groups }, error: null });
        api.getLibraryPaths.mockResolvedValue({ data: { items: paths }, error: null });
        await renderPage();

        await fireEvent.click(screen.getByRole('button', { name: /Add folder/ }));

        expect(modals.open).toHaveBeenCalledWith(
            LibraryPathModal,
            expect.objectContaining({
                defaultGroupId: LIB_ID,
                defaultMediaType: 'movie',
                defaultProvider: 'tmdb',
                defaultLanguage: 'en',
            }),
        );
    });
});

describe('library detail page — local audiobook folder', () => {
    it('shows a notice and keeps Audiobook selectable for an existing local audiobook library', async () => {
        const { groups, paths } = movieLibraryFixtures();
        paths[0] = { ...paths[0], mediaType: 'audiobook', provider: 'musicbrainz' };
        api.getLibraryGroups.mockResolvedValue({ data: { items: groups }, error: null });
        api.getLibraryPaths.mockResolvedValue({ data: { items: paths }, error: null });
        await renderPage();

        expect(screen.getByTestId('local-audiobook-notice').textContent).toMatch(/imports nothing/);
        const options = Array.from(
            (screen.getByLabelText('Media Type') as HTMLSelectElement).options,
        ).map((o) => o.value);
        expect(options).toContain('audiobook');
    });

    it('does not offer Audiobook for a folder library of another type', async () => {
        const { groups, paths } = movieLibraryFixtures();
        api.getLibraryGroups.mockResolvedValue({ data: { items: groups }, error: null });
        api.getLibraryPaths.mockResolvedValue({ data: { items: paths }, error: null });
        await renderPage();

        expect(screen.queryByTestId('local-audiobook-notice')).toBeNull();
        const options = Array.from(
            (screen.getByLabelText('Media Type') as HTMLSelectElement).options,
        ).map((o) => o.value);
        expect(options).not.toContain('audiobook');
    });
});

describe('library detail page — settings', () => {
    it('disables Save until something changes, then sends only the changed fields', async () => {
        const { groups, paths } = movieLibraryFixtures();
        api.getLibraryGroups.mockResolvedValue({ data: { items: groups }, error: null });
        api.getLibraryPaths.mockResolvedValue({ data: { items: paths }, error: null });
        api.updateLibrary.mockResolvedValue({
            data: { group: groups[0], paths },
            error: null,
        });
        await renderPage();

        const save = screen.getByRole('button', { name: /^Save$/ });
        expect((save as HTMLButtonElement).disabled).toBe(true);

        const nameInput = screen.getByLabelText(/^Name/);
        await fireEvent.input(nameInput, { target: { value: 'Weeknights' } });

        expect((save as HTMLButtonElement).disabled).toBe(false);
        await fireEvent.click(save);

        await waitFor(() =>
            expect(api.updateLibrary).toHaveBeenCalledWith(LIB_ID, { name: 'Weeknights' }),
        );
    });

    const CUSTOM_GROUP_LABEL = 'Custom group...';
    const REMOVE_TEENS_LABEL = 'Remove teens';

    // Access used to have its own Edit/Save inside the Settings form; it is now
    // part of the form's one Save (PATCH /libraries/[id] allowed_groups).
    it('saves access with the rest of the form, through the one Save', async () => {
        const { groups, paths } = movieLibraryFixtures();
        api.getLibraryGroups.mockResolvedValue({ data: { items: groups }, error: null });
        api.getLibraryPaths.mockResolvedValue({ data: { items: paths }, error: null });
        api.updateLibrary.mockResolvedValue({ data: { group: groups[0], paths }, error: null });
        await renderPage();

        const save = screen.getByRole('button', { name: /^Save$/ });
        const custom = screen.getAllByLabelText(CUSTOM_GROUP_LABEL)[0];
        await fireEvent.input(custom, { target: { value: 'kids' } });
        await fireEvent.keyDown(custom, { key: 'Enter' });

        expect((save as HTMLButtonElement).disabled).toBe(false);
        await fireEvent.click(save);

        await waitFor(() =>
            expect(api.updateLibrary).toHaveBeenCalledWith(LIB_ID, { allowed_groups: ['kids'] }),
        );
        expect(api.saveLibraryGroupPermissions).not.toHaveBeenCalled();
    });

    it('lifting the last restriction sends an empty list (everyone)', async () => {
        const { groups, paths } = movieLibraryFixtures();
        api.getLibraryGroups.mockResolvedValue({ data: { items: groups }, error: null });
        api.getLibraryPaths.mockResolvedValue({ data: { items: paths }, error: null });
        api.getLibraryGroupPermissions.mockResolvedValue({
            data: { permissions: [{ libraryGroupId: LIB_ID, allowedGroups: ['teens'] }] },
            error: null,
        });
        api.updateLibrary.mockResolvedValue({ data: { group: groups[0], paths }, error: null });
        await renderPage();

        await fireEvent.click(await screen.findByRole('button', { name: REMOVE_TEENS_LABEL }));
        await fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

        await waitFor(() =>
            expect(api.updateLibrary).toHaveBeenCalledWith(LIB_ID, { allowed_groups: [] }),
        );
    });

    it('asks for confirmation before changing the media type', async () => {
        const { groups, paths } = movieLibraryFixtures();
        api.getLibraryGroups.mockResolvedValue({ data: { items: groups }, error: null });
        api.getLibraryPaths.mockResolvedValue({ data: { items: paths }, error: null });
        await renderPage();

        const mediaTypeSelect = screen.getByLabelText('Media Type');
        await withCheckedPseudoClass(() =>
            fireEvent.change(mediaTypeSelect, { target: { value: 'tv' } }),
        );

        const save = screen.getByRole('button', { name: /^Save$/ });
        await fireEvent.click(save);

        expect(api.updateLibrary).not.toHaveBeenCalled();
        expect(modals.open).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                onConfirm: expect.any(Function),
            }),
        );
    });
});

describe('library detail page — danger zone', () => {
    it("explains why a library with folders can't be deleted, instead of a mute disabled icon", async () => {
        const { groups, paths } = movieLibraryFixtures();
        api.getLibraryGroups.mockResolvedValue({ data: { items: groups }, error: null });
        api.getLibraryPaths.mockResolvedValue({ data: { items: paths }, error: null });
        await renderPage();

        const del = screen.getByRole('button', { name: /Delete library/ });
        expect((del as HTMLButtonElement).disabled).toBe(false);
        await fireEvent.click(del);

        expect(toasts.error).toHaveBeenCalledWith('Remove all folders first');
        expect(api.deleteLibraryGroup).not.toHaveBeenCalled();
    });

    it('deletes an empty library after confirmation and returns to the overview', async () => {
        api.getLibraryGroups.mockResolvedValue({
            data: {
                items: [
                    { id: LIB_ID, name: 'Evening', icon: null, sortOrder: 0, maxAgeRating: null },
                ],
            },
            error: null,
        });
        api.getLibraryPaths.mockResolvedValue({ data: { items: [] }, error: null });
        api.deleteLibraryGroup.mockResolvedValue({ data: null, error: null });
        await renderPage();

        const del = screen.getByRole('button', { name: /Delete library/ });
        await fireEvent.click(del);

        expect(modals.open).toHaveBeenCalled();
        const [, props] = modals.open.mock.calls.at(-1) as [
            unknown,
            { onConfirm: () => Promise<void> },
        ];
        await props.onConfirm();

        expect(api.deleteLibraryGroup).toHaveBeenCalledWith(LIB_ID);
        expect(goto).toHaveBeenCalledWith('/admin/library/sources');
    });
});

describe('library detail page — issues', () => {
    it('renders no Issues section when the latest runs have no errors', async () => {
        const { groups, paths } = movieLibraryFixtures();
        api.getLibraryGroups.mockResolvedValue({ data: { items: groups }, error: null });
        api.getLibraryPaths.mockResolvedValue({ data: { items: paths }, error: null });
        // beforeEach already stubs getLatestScannerRunPerLibrary to `{ items: [] }`.
        await renderPage();

        expect(screen.queryByText('Issues')).toBeNull();
    });

    it("groups the latest runs' error samples by cause, with the fix text and file list", async () => {
        const { groups, paths } = movieLibraryFixtures();
        api.getLibraryGroups.mockResolvedValue({ data: { items: groups }, error: null });
        api.getLibraryPaths.mockResolvedValue({ data: { items: paths }, error: null });
        api.getLatestScannerRunPerLibrary.mockResolvedValue({
            data: {
                items: [
                    {
                        id: 'run-1',
                        libraryPathId: PATH_ID,
                        libraryPath: '/srv/stuff/a',
                        startedAt: '2026-09-27T00:00:00.000Z',
                        completedAt: '2026-09-27T00:05:00.000Z',
                        totalFiles: 10,
                        matched: 2,
                        updated: 0,
                        added: 2,
                        unmatched: 0,
                        errors: 2,
                        errorSamples: [
                            '/srv/stuff/a/Movie1.mkv: ffprobe failed: moov atom not found',
                            '/srv/stuff/a/Movie2.mkv: permission denied reading the file (EACCES/EPERM)',
                        ],
                        status: 'completed',
                        durationMs: 300000,
                        matchRate: 20,
                        createdAt: '2026-09-27T00:00:00.000Z',
                    },
                ],
            },
            error: null,
        });
        await renderPage();

        await screen.findByText('Issues');
        expect(screen.getByText('Permission denied')).toBeTruthy();
        expect(screen.getByText("Files ffprobe couldn't read")).toBeTruthy();
        expect(screen.getByText("Check the container user's read permission")).toBeTruthy();
        expect(screen.getByText('The files may be damaged or incomplete')).toBeTruthy();
        // Shown relative to the library's own folder, not the full path.
        expect(screen.getByText('Movie2.mkv')).toBeTruthy();
        // The ffprobe reason carries its own colon ("ffprobe failed: <detail>");
        // the file is still shown by its own name, nothing glued on.
        expect(screen.getByText('Movie1.mkv')).toBeTruthy();

        const link = screen.getByRole('link', { name: /Open in Media/ });
        expect(link.getAttribute('href')).toBe(`/admin/library/media?library=${LIB_ID}`);
        const fixMatches = screen.getByRole('link', { name: /Open in Fix matches/ });
        expect(fixMatches.getAttribute('href')).toBe(
            `/admin/library/fix-matches?library=${LIB_ID}`,
        );
    });
});

describe('library detail page — save while editing, load failures', () => {
    it('keeps a field typed while the save was running, and still shows it as unsaved', async () => {
        const { groups, paths } = movieLibraryFixtures();
        api.getLibraryGroups.mockResolvedValue({ data: { items: groups }, error: null });
        api.getLibraryPaths.mockResolvedValue({ data: { items: paths }, error: null });
        let finishSave!: () => void;
        api.updateLibrary.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finishSave = () =>
                        resolve({
                            data: { group: { ...groups[0], name: 'Weeknights' }, paths },
                            error: null,
                        });
                }),
        );
        await renderPage();

        await fireEvent.input(screen.getByLabelText(/^Name/), {
            target: { value: 'Weeknights' },
        });
        await fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
        await waitFor(() => expect(api.updateLibrary).toHaveBeenCalled());

        // Typed while the request is in flight…
        await fireEvent.input(screen.getByLabelText(/^Description/), {
            target: { value: 'Late films' },
        });
        finishSave();

        // …survives the response and is still a pending change.
        await waitFor(() =>
            expect(
                (screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement).disabled,
            ).toBe(false),
        );
        expect((screen.getByLabelText(/^Description/) as HTMLInputElement).value).toBe(
            'Late films',
        );
        expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Weeknights');
    });

    it('shows a retry instead of "not found" when the library list fails to load', async () => {
        const { groups, paths } = movieLibraryFixtures();
        api.getLibraryGroups.mockResolvedValueOnce({ data: null, error: 'HTTP 500' });
        api.getLibraryPaths.mockResolvedValue({ data: { items: paths }, error: null });
        render(LibraryDetailPage, { props: { data: { id: LIB_ID } as PageData } });

        await screen.findByText('This library could not be loaded.');
        expect(screen.queryByText(/not found/i)).toBeNull();

        api.getLibraryGroups.mockResolvedValue({ data: { items: groups }, error: null });
        await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByText('Evening');
    });
});

it('offers Serien rather than a television device in German library settings', async () => {
    overwriteGetLocale(() => 'de');
    const { groups, paths } = movieLibraryFixtures();
    api.getLibraryGroups.mockResolvedValue({ data: { items: groups }, error: null });
    api.getLibraryPaths.mockResolvedValue({ data: { items: paths }, error: null });
    await renderPage();
    const types = document.getElementById('lib-media-type') as HTMLSelectElement;
    expect(types.querySelector('option[value="tv"]')?.textContent).toBe('Serien');
    expect(types.textContent).not.toContain('Fernseher');
});
