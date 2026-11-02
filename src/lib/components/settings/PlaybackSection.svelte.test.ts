// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { updatePreference, initializePreferences } = vi.hoisted(() => ({
    updatePreference: vi.fn(),
    initializePreferences: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/components/player/preferences-sync.svelte', () => ({
    updatePreference,
    initializePreferences,
    playbackPreferences: {
        ready: true,
        loading: false,
        audioLanguage: null,
        qualityMode: 'original',
        maxBitrateBps: null,
        preferredResolution: null,
        autoplayNextEpisode: true,
        skipIntroAutomatically: false,
        skipCreditsAutomatically: false,
        nextEpisodeCountdownSeconds: null,
        nextEpisodeCountdownSecondsDefault: 10,
        stillWatchingEnabled: false,
    },
}));

// SavedCue uses svelte/transition (fade) which calls element.animate — not
// available in happy-dom. Stub it out since the tests don't cover SavedCue.
vi.mock('./SavedCue.svelte', () => ({ default: vi.fn() }));

import PlaybackSection from './PlaybackSection.svelte';

describe('PlaybackSection', () => {
    afterEach(() => {
        cleanup();
        updatePreference.mockClear();
    });

    test('the still-watching prompt is offered under autoplay and writes through', async () => {
        render(PlaybackSection, { highlight: '' });
        const toggle = screen.getByRole('switch', { name: /still watching/i });
        await fireEvent.click(toggle);
        expect(updatePreference).toHaveBeenCalledWith('stillWatchingEnabled', true);
    });

    test('toggling autoplay writes through the shared store (no toast)', async () => {
        render(PlaybackSection, { highlight: '' });
        const toggle = screen.getByRole('switch', { name: /Autoplay next episode/i });
        await fireEvent.click(toggle);
        expect(updatePreference).toHaveBeenCalledWith('autoplayNextEpisode', false);
    });

    test('highlight prop rings the matching control row', () => {
        const { container } = render(PlaybackSection, { highlight: 'skip-intro' });
        expect(container.querySelector('#playback-skip-intro')?.className).toContain('ring-2');
    });

    test('invalid countdown never writes a truncated or out-of-range value', async () => {
        render(PlaybackSection);
        const input = screen.getByRole('spinbutton', { name: /countdown/i });
        await fireEvent.change(input, { target: { value: '3.5' } });
        expect(updatePreference).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toBeTruthy();
        await fireEvent.change(input, { target: { value: '15' } });
        expect(updatePreference).toHaveBeenCalledWith('nextEpisodeCountdownSeconds', 15);
    });
});
