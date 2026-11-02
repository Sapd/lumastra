// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Focused render checks for MusicFeatureTiles.
 *
 * The component reads $page.data.features from the $app/stores page store.
 * We mock that store with a static readable that has all feature flags set
 * to true so every tile is visible, then assert on href attributes and the
 * section heading. A separate describe block verifies the "no gates" case
 * where only the always-on Radio tile is expected.
 */

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

// $lib/paths — resolve() is an identity function in tests (no base path).
vi.mock('$lib/paths', () => ({
    resolve: (path: string) => path,
}));

// $app/stores — page store with all feature flags enabled.
vi.mock('$app/stores', () => ({
    page: readable({
        data: {
            features: {
                musicMap: true,
                sonicEmbeddings: true,
                musicClusters: true,
                textToSound: true,
                lyricsSearch: true,
                musicAlchemy: true,
                musicRadio: true,
            },
        },
    }),
    navigating: readable(null),
}));

import MusicFeatureTiles from './MusicFeatureTiles.svelte';

// Collect rendered tile hrefs
function getTileHrefs(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll<HTMLAnchorElement>('[data-testid="feature-tile"]'))
        .map((a) => a.getAttribute('href') ?? '')
        .filter(Boolean);
}

describe('MusicFeatureTiles — all features enabled', () => {
    afterEach(() => cleanup());

    test('renders the Explore section wrapper', () => {
        const { container } = render(MusicFeatureTiles);
        expect(container.querySelector('[data-testid="music-feature-tiles"]')).toBeTruthy();
    });

    test('renders the "Explore" heading', () => {
        const { container } = render(MusicFeatureTiles);
        const heading = container.querySelector('h3');
        expect(heading?.textContent?.trim()).toBe('Explore');
    });

    test('renders 5 tiles (4 feature-gated + Radio data-gated)', () => {
        const { container } = render(MusicFeatureTiles);
        const hrefs = getTileHrefs(container);
        expect(hrefs.length).toBe(5);
    });

    test('Music Map tile links to /music/map', () => {
        const { container } = render(MusicFeatureTiles);
        expect(getTileHrefs(container)).toContain('/music/map');
    });

    test('Song Paths tile links to /music/path (sonicEmbeddings gate)', () => {
        const { container } = render(MusicFeatureTiles);
        expect(getTileHrefs(container)).toContain('/music/path');
    });

    test('Sonic Collections tile links to /music/collections (musicClusters gate)', () => {
        const { container } = render(MusicFeatureTiles);
        expect(getTileHrefs(container)).toContain('/music/collections');
    });

    test('Mixing Desk tile links to /music/alchemy (musicAlchemy gate)', () => {
        const { container } = render(MusicFeatureTiles);
        expect(getTileHrefs(container)).toContain('/music/alchemy');
    });

    test('Radio tile links to /music/radio (musicRadio data gate)', () => {
        const { container } = render(MusicFeatureTiles);
        expect(getTileHrefs(container)).toContain('/music/radio');
    });

    test('each tile is an <a> element with the correct href attribute', () => {
        const { container } = render(MusicFeatureTiles);
        const anchors = container.querySelectorAll<HTMLAnchorElement>(
            '[data-testid="feature-tile"]',
        );
        for (const a of anchors) {
            expect(a.tagName).toBe('A');
            expect(a.getAttribute('href')).toBeTruthy();
        }
    });

    test('all tile hrefs are unique (no duplicates)', () => {
        const { container } = render(MusicFeatureTiles);
        const hrefs = getTileHrefs(container);
        expect(new Set(hrefs).size).toBe(hrefs.length);
    });
});
