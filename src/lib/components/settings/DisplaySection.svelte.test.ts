// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock('$lib/api/for-you', () => ({
    getActiveDampers: vi.fn(async () => ({ data: { dampers: [] } })),
    clearDamper: vi.fn(),
    clearAllDampers: vi.fn(),
}));
vi.mock('./NotificationWebhookPanel.svelte', () => ({ default: vi.fn() }));
vi.mock('./NotificationForwardingPanel.svelte', () => ({ default: vi.fn() }));

const { updatePlaybackPreferences } = vi.hoisted(() => ({
    updatePlaybackPreferences: vi.fn<() => Promise<{ error: string | null }>>(async () => ({
        error: null,
    })),
}));

vi.mock('$app/stores', () => ({
    page: readable({ data: { features: { dockToggle: true } } }),
}));
vi.mock('$lib/api/user', () => ({
    getSearchPreference: vi.fn(async () => ({ data: { fulltextSearch: false } })),
    updateSearchPreference: vi.fn(async () => ({ error: null })),
    getPlaybackPreferences: vi.fn(async () => ({
        data: { metadataLanguage: null, metadataTitleLanguage: 'de' },
    })),
    updatePlaybackPreferences,
}));
vi.mock('$lib/paraglide/runtime.js', () => ({
    getLocale: () => 'en',
    setLocale: vi.fn(),
    locales: ['en', 'de'],
    isLocale: (v: string) => v === 'en' || v === 'de',
    experimentalStaticLocale: null,
}));

const { preferenceState, updatePreference } = vi.hoisted(() => ({
    preferenceState: {
        showEpisodeLanguages: true,
        ready: true,
        storageUnavailable: false,
        loading: false,
    },
    updatePreference: vi.fn(),
}));
vi.mock('$lib/components/player/preferences-sync.svelte', () => ({
    playbackPreferences: preferenceState,
    initializePreferences: vi.fn(async () => {}),
    updatePreference,
}));

import DisplaySection from './DisplaySection.svelte';

// Admin has configured 'de' as an additional metadata language on top of the
// 'en' primary (config.TMDB_LANGUAGE) — pickers visible. Delivered as a prop
// from the route-scoped loader (src/routes/settings/display/+page.server.ts).
const metadataLanguages = { primary: 'en', additional: ['de'] };

describe('DisplaySection', () => {
    afterEach(() => {
        cleanup();
        updatePlaybackPreferences.mockClear();
    });

    test('episode language toggle uses the shared account preference', async () => {
        render(DisplaySection, {});
        const toggle = screen.getByRole('switch', { name: 'Show episode languages' });
        expect(toggle.getAttribute('aria-checked')).toBe('true');
        await fireEvent.click(toggle);
        expect(updatePreference).toHaveBeenCalledWith('showEpisodeLanguages', false);
    });

    test('renders the Interface language picker (scoped label)', () => {
        render(DisplaySection, {});
        expect(screen.getByText(/Interface language/)).toBeTruthy();
    });

    test('renders the fulltext search default row', () => {
        render(DisplaySection, {});
        expect(screen.getByText(/Full-text search/i)).toBeTruthy();
    });

    test('hides the metadata language pickers when no additional languages are configured', () => {
        render(DisplaySection, {});
        expect(screen.queryByText(/Descriptions language/i)).toBeNull();
        expect(screen.queryByText(/Titles language/i)).toBeNull();
    });

    test('renders the metadata language pickers when the admin has configured additional languages', async () => {
        render(DisplaySection, { metadataLanguages });
        expect(screen.getByText(/Descriptions language/i)).toBeTruthy();
        expect(screen.getByText(/Titles language/i)).toBeTruthy();
        // Loaded via getPlaybackPreferences (metadataTitleLanguage: 'de').
        await waitFor(() => {
            const titleSelect = screen.getByLabelText(/Titles language/i) as HTMLSelectElement;
            expect(titleSelect.value).toBe('de');
        });
    });

    test('offers "Follow app language" plus the primary and admin-configured languages', () => {
        render(DisplaySection, { metadataLanguages });
        const descriptionsSelect = screen.getByLabelText(
            /Descriptions language/i,
        ) as HTMLSelectElement;
        const values = [...descriptionsSelect.options].map((o) => o.value);
        expect(values).toEqual(['', 'en', 'de']);
        expect(descriptionsSelect.options[0].textContent).toMatch(/Follow app language/i);
    });

    test('changing the titles language persists via updatePlaybackPreferences', async () => {
        render(DisplaySection, { metadataLanguages });
        const titleSelect = screen.getByLabelText(/Titles language/i) as HTMLSelectElement;
        await fireEvent.change(titleSelect, { target: { value: 'en' } });
        expect(updatePlaybackPreferences).toHaveBeenCalledWith({ metadataTitleLanguage: 'en' });
    });

    test('maps the empty ("follow app language") option to null at the API boundary', async () => {
        render(DisplaySection, { metadataLanguages });
        const descriptionsSelect = screen.getByLabelText(
            /Descriptions language/i,
        ) as HTMLSelectElement;
        await fireEvent.change(descriptionsSelect, { target: { value: '' } });
        expect(updatePlaybackPreferences).toHaveBeenCalledWith({ metadataLanguage: null });
    });

    test('shows an API save failure and restores the previous language', async () => {
        render(DisplaySection, { metadataLanguages });
        const select = screen.getByLabelText(/Titles language/i) as HTMLSelectElement;
        await waitFor(() => expect(select.value).toBe('de'));
        updatePlaybackPreferences.mockResolvedValueOnce({ error: 'Unavailable' });
        await fireEvent.change(select, { target: { value: 'en' } });
        await waitFor(() => expect(select.value).toBe('de'));
        expect(screen.getByRole('alert').textContent).toContain('previous setting');
    });

    test('shows saving until completion, then confirms the successful save', async () => {
        render(DisplaySection, { metadataLanguages });
        const select = screen.getByLabelText(/Titles language/i) as HTMLSelectElement;
        await waitFor(() => expect(select.value).toBe('de'));
        let finish!: (value: { error: null }) => void;
        updatePlaybackPreferences.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        await fireEvent.change(select, { target: { value: 'en' } });
        expect(select.disabled).toBe(true);
        expect(screen.getByText('Saving…')).toBeTruthy();
        finish({ error: null });
        expect(await screen.findByText('Saved')).toBeTruthy();
        expect(select.disabled).toBe(false);
    });
});
