// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { render, cleanup, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
const { prefs, initialize } = vi.hoisted(() => ({
    prefs: { showEpisodeLanguages: true, ready: true },
    initialize: vi.fn(async () => {}),
}));
vi.mock('$lib/components/player/preferences-sync.svelte', () => ({
    playbackPreferences: prefs,
    initializePreferences: initialize,
}));
import EpisodeLanguageBadges from './EpisodeLanguageBadges.svelte';
afterEach(() => {
    cleanup();
    prefs.showEpisodeLanguages = true;
    initialize.mockClear();
});
test('shows languages and separator when enabled', () => {
    render(EpisodeLanguageBadges, {
        audioLanguages: ['jpn'],
        subtitleLanguages: ['deu'],
        showSeparator: true,
    });
    expect(initialize).not.toHaveBeenCalled();
    expect(screen.getByText('JA')).toBeTruthy();
    expect(screen.getByText('DE')).toBeTruthy();
    expect(screen.getByText('·')).toBeTruthy();
});
test('hides both language kinds and separator when disabled', () => {
    prefs.showEpisodeLanguages = false;
    render(EpisodeLanguageBadges, {
        audioLanguages: ['jpn'],
        subtitleLanguages: ['deu'],
        showSeparator: true,
    });
    expect(screen.queryByText('JA')).toBeNull();
    expect(screen.queryByText('DE')).toBeNull();
    expect(screen.queryByText('·')).toBeNull();
});
