// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock('$app/stores', () => ({
    page: readable({ data: {}, url: new URL('http://localhost/') }),
}));
vi.mock('$lib/paraglide/runtime', () => ({
    getLocale: () => 'en',
    setLocale: vi.fn(),
    locales: ['en', 'de'],
    isLocale: (v: string) => v === 'en' || v === 'de',
    experimentalStaticLocale: null,
}));

vi.mock('$lib/components/player/preferences-sync.svelte', () => ({
    playbackPreferences: { showEpisodeLanguages: true, ready: true },
    initializePreferences: vi.fn(async () => {}),
}));

import EpisodeHoverPanel from './EpisodeHoverPanel.svelte';

/**
 * Mirrors the component's PanelEpisode shape. Typed — NOT `unknown` — because the
 * repo runs a blocking tsgo typecheck pass over test files, and passing `unknown`
 * into a typed prop fails it two tasks later with a confusing error.
 */
interface TestEpisode {
    id: string;
    name?: string;
    episodeNumber: number;
    episodeNumberEnd?: number;
    seasonNumber: number;
    overview?: string;
    imageTag?: string;
    hasOwnStill?: boolean;
    runTimeTicks?: number;
    premiereDate?: string;
    externalIds?: Record<string, string | undefined>;
    audioLanguages?: string[];
    subtitleLanguages?: string[];
    played?: boolean;
    hasFile?: boolean;
    segments?: { episodeNumber: number; title: string }[];
}

const baseEpisode: TestEpisode = {
    id: 'ep-5',
    name: 'Gray Matter',
    episodeNumber: 5,
    seasonNumber: 1,
    overview:
        "Walter and Skyler attend a former colleague's party. Jesse tries to free himself from the drugs, while Walter organizes an intervention.",
    runTimeTicks: 48 * 60 * 10_000_000,
    premiereDate: '2008-02-24',
    audioLanguages: ['eng', 'deu'],
    subtitleLanguages: ['deu'],
};

function renderPanel(episode: TestEpisode) {
    const anchorEl = document.createElement('div');
    document.body.appendChild(anchorEl);
    return render(EpisodeHoverPanel, {
        props: {
            episode,
            anchorEl,
            resolvedSeriesId: 'series-1',
            panelId: 'test-panel',
        },
    });
}

describe('EpisodeHoverPanel', () => {
    afterEach(() => cleanup());

    test('renders the episode title with its number prefix', () => {
        renderPanel(baseEpisode);
        expect(screen.getByText('Gray Matter')).toBeTruthy();
        expect(screen.getByText(/E5/)).toBeTruthy();
    });

    test('renders the overview untruncated', () => {
        renderPanel(baseEpisode);
        expect(screen.getByText(/organizes an intervention/)).toBeTruthy();
    });

    test('renders runtime and air date', () => {
        renderPanel(baseEpisode);
        expect(screen.getByText(/48/)).toBeTruthy();
        expect(screen.getByText(/2008/)).toBeTruthy();
    });

    test('renders the multi-segment title list for combined episodes', () => {
        renderPanel({
            ...baseEpisode,
            name: 'Combined',
            segments: [
                { episodeNumber: 24, title: 'First Segment' },
                { episodeNumber: 25, title: 'Second Segment' },
            ],
        });
        expect(screen.getByText('First Segment')).toBeTruthy();
        expect(screen.getByText('Second Segment')).toBeTruthy();
    });

    test('carries role=tooltip and the supplied id for aria-describedby', () => {
        const { baseElement } = renderPanel(baseEpisode);
        const panel = baseElement.querySelector('[role="tooltip"]');
        expect(panel).toBeTruthy();
        expect(panel?.id).toBe('test-panel');
    });

    test('sets pointer-events:auto so it can be hovered out of the pointer-events:none portal', () => {
        const { baseElement } = renderPanel(baseEpisode);
        const panel = baseElement.querySelector('[role="tooltip"]') as HTMLElement | null;
        expect(panel?.style.pointerEvents).toBe('auto');
    });

    test('contains no scrollable region — the overview is clamped instead', () => {
        const { baseElement } = renderPanel(baseEpisode);
        const panel = baseElement.querySelector('[role="tooltip"]');
        expect(
            panel?.querySelector('.overflow-y-auto, .overflow-auto, .overflow-y-scroll'),
        ).toBeNull();
    });
});
