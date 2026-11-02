// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The surface `defineSubtitleProvider` was missing.
 *
 * The behaviour that matters is telling two different silences apart. "No
 * subtitle provider is installed" and "asked N providers, none had this
 * release" look identical if you only check `candidates.length` — and they
 * send the operator to opposite places: install a plugin, versus accept that
 * this release has none. The endpoint returns a `providers` count for exactly
 * this reason, so the UI is obliged to use it.
 */

import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSearch, mockInstall, mockError, mockSuccess } = vi.hoisted(() => ({
    mockSearch: vi.fn(),
    mockInstall: vi.fn(),
    mockError: vi.fn(),
    mockSuccess: vi.fn(),
}));

vi.mock('$lib/api/admin.js', () => ({
    searchSubtitles: mockSearch,
    installSubtitle: mockInstall,
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: mockError, success: mockSuccess, info: vi.fn() },
}));

import SubtitleSearchPanel from './SubtitleSearchPanel.svelte';

const CANDIDATE = {
    id: 'cand-1',
    providerId: 'opensubs',
    language: 'en',
    format: 'srt',
    releaseName: 'Movie.2021.1080p.BluRay',
};

async function openAndSearch(fileId: string | null = 'file-1') {
    render(SubtitleSearchPanel, { mediaItemId: 'item-1', fileId, onchanged: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Find subtitles' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Search' }));
}

describe('SubtitleSearchPanel', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(cleanup);

    it('says nothing was ASKED when no provider is installed', async () => {
        mockSearch.mockResolvedValue({ data: { candidates: [], providers: 0 }, error: null });
        await openAndSearch();
        await waitFor(() =>
            expect(screen.getByText(/No subtitle provider is installed/)).toBeTruthy(),
        );
        // Must not read as "this release has no subtitles".
        expect(screen.queryByText(/nothing matched this release/)).toBeNull();
    });

    it('says nothing MATCHED when providers were asked and came back empty', async () => {
        mockSearch.mockResolvedValue({ data: { candidates: [], providers: 2 }, error: null });
        await openAndSearch();
        await waitFor(() => expect(screen.getByText(/nothing matched this release/)).toBeTruthy());
        expect(screen.queryByText(/No subtitle provider is installed/)).toBeNull();
    });

    it('renders candidates in the order the host ranked them', async () => {
        // The host ranks language first, hash match second. Re-sorting here
        // would override a decision made where the preferences live.
        mockSearch.mockResolvedValue({
            data: {
                candidates: [
                    { ...CANDIDATE, id: 'first', releaseName: 'FIRST' },
                    { ...CANDIDATE, id: 'second', releaseName: 'SECOND' },
                    { ...CANDIDATE, id: 'third', releaseName: 'THIRD' },
                ],
                providers: 1,
            },
            error: null,
        });
        await openAndSearch();
        await waitFor(() => expect(screen.getByText('FIRST')).toBeTruthy());
        const rendered = screen.getAllByText(/FIRST|SECOND|THIRD/).map((e) => e.textContent);
        expect(rendered).toEqual(['FIRST', 'SECOND', 'THIRD']);
    });

    it('labels an exact file match rather than hiding it in the ordering', async () => {
        // hashMatch is the difference between subtitles that stay in sync and
        // subtitles that drift — worth saying out loud.
        mockSearch.mockResolvedValue({
            data: { candidates: [{ ...CANDIDATE, hashMatch: true }], providers: 1 },
            error: null,
        });
        await openAndSearch();
        await waitFor(() => expect(screen.getByText(/exact file match/)).toBeTruthy());
    });

    it('sends the provider and candidate ids the host handed back', async () => {
        mockSearch.mockResolvedValue({
            data: { candidates: [CANDIDATE], providers: 1 },
            error: null,
        });
        mockInstall.mockResolvedValue({
            data: { subtitlePath: '/movies/x.en.srt', language: 'en', format: 'srt' },
            error: null,
        });
        await openAndSearch();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy());
        await fireEvent.click(screen.getByRole('button', { name: 'Install' }));

        await waitFor(() => expect(mockInstall).toHaveBeenCalled());
        expect(mockInstall.mock.calls[0][0]).toMatchObject({
            mediaItemId: 'item-1',
            fileId: 'file-1',
            providerId: 'opensubs',
            candidateId: 'cand-1',
            language: 'en',
        });
    });

    it('cannot install without a file — the sidecar has to land next to one', async () => {
        mockSearch.mockResolvedValue({
            data: { candidates: [CANDIDATE], providers: 1 },
            error: null,
        });
        await openAndSearch(null);
        await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy());
        expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(true);
    });

    it('surfaces the endpoint reason on a failed install', async () => {
        // The endpoint returns an operator-readable reason on every failure
        // path deliberately; a generic toast would throw that away.
        mockSearch.mockResolvedValue({
            data: { candidates: [CANDIDATE], providers: 1 },
            error: null,
        });
        mockInstall.mockResolvedValue({ data: null, error: 'provider returned a 403' });
        await openAndSearch();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy());
        await fireEvent.click(screen.getByRole('button', { name: 'Install' }));
        await waitFor(() => expect(mockError).toHaveBeenCalledWith('provider returned a 403'));
    });
});
