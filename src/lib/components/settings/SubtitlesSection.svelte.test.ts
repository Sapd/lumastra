// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { updatePreference, updatePreferences, initializePreferences } = vi.hoisted(() => ({
    updatePreference: vi.fn(),
    initializePreferences: vi.fn().mockResolvedValue(undefined),
    updatePreferences: vi.fn(),
}));

vi.mock('$lib/components/player/preferences-sync.svelte', () => ({
    updatePreference,
    initializePreferences,
    updatePreferences,
    SUBTITLE_STYLE_PRESETS: {
        default: {},
        outlined: {},
        background: {},
        shadow: {},
        none: {},
    },
    DEFAULT_SUBTITLE_STYLE: {
        preset: 'default',
        fontSize: 1,
        fontFamily: 'system',
        textColor: '#fff',
        backgroundColor: 'rgba(0,0,0,0.75)',
        outlineColor: '#000',
        outlineWidth: 0,
        shadowBlur: 4,
        positionY: 85,
    },
    playbackPreferences: {
        ready: true,
        loading: false,
        subtitleLanguage: null,
        subtitlesEnabled: true,
        forcedSubtitlesEnabled: true,
        subtitleStyle: {
            preset: 'default',
            fontSize: 1,
            fontFamily: 'system',
            textColor: '#fff',
            backgroundColor: 'rgba(0,0,0,0.75)',
            outlineColor: '#000',
            outlineWidth: 0,
            shadowBlur: 4,
            positionY: 85,
        },
    },
}));
// SavedCue uses svelte/transition (fade) which calls element.animate — not
// available in happy-dom. Stub it out since the tests don't cover SavedCue.
vi.mock('./SavedCue.svelte', () => ({ default: vi.fn() }));

import SubtitlesSection from './SubtitlesSection.svelte';

describe('SubtitlesSection', () => {
    afterEach(() => {
        cleanup();
        updatePreference.mockClear();
        updatePreferences.mockClear();
    });

    test('toggling subtitles enabled writes through the shared store', async () => {
        render(SubtitlesSection, { highlight: '' });
        const toggle = screen.getByRole('switch', { name: /Turn subtitles on/i });
        await fireEvent.click(toggle);
        expect(updatePreference).toHaveBeenCalledWith('subtitlesEnabled', false);
    });

    test('renders the Default subtitle language control', () => {
        render(SubtitlesSection, { highlight: '' });
        expect(screen.getByText(/Default subtitle language/)).toBeTruthy();
    });

    // The height slider used to move the caption DOWN as the knob moved right,
    // while its label counted "% from bottom" up.
    test('dragging the height slider right raises the caption', async () => {
        render(SubtitlesSection, { highlight: '' });
        const slider = screen.getByLabelText(/Height/) as HTMLInputElement;
        expect(slider.value).toBe('15');
        await fireEvent.input(slider, { target: { value: '30' } });
        expect(updatePreference).toHaveBeenCalledWith(
            'subtitleStyle',
            expect.objectContaining({ positionY: 70 }),
        );
    });

    test('the language control is a picker, not a code field', () => {
        render(SubtitlesSection, { highlight: '' });
        const select = screen.getByRole('combobox', { name: /Default subtitle language/ });
        expect(select.querySelectorAll('option').length).toBeGreaterThan(10);
    });

    test('changing the language clears a previously selected subtitle edition together', async () => {
        render(SubtitlesSection, { highlight: '' });
        const select = screen.getByRole('combobox', { name: /Default subtitle language/ });
        await fireEvent.change(select, { target: { value: 'ita' } });
        expect(updatePreferences).toHaveBeenCalledWith({
            subtitleLanguage: 'ita',
            subtitleTrackHint: null,
        });
    });
});
