// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Regression test for the z-index click-through bug: VideoPlayer.svelte's
 * `.video-element` is `position: relative; z-index: 1` (added so it can be
 * compared against AudioOnlyBackdrop's z-index:0). Per CSS painting order,
 * ANY OTHER positioned descendant of `.player-container` left at the default
 * `z-index: auto` paints BEHIND that video (painting-order step 6 vs step 7)
 * even though it's drawn on top in the DOM/visually — so a real mouse click
 * hits the <video> instead (`document.elementFromPoint` resolves to it),
 * while `element.click()` still "works" because it bypasses hit-testing
 * entirely. This previously broke PlayerControls' whole control bar and
 * PlayerOverlay's back-button/title/loading/error/play-button layers.
 *
 * What this test can and cannot prove, and why:
 * - `document.elementFromPoint` is NOT used here. happy-dom does not run real
 *   layout or painting, so it cannot resolve screen coordinates to a topmost
 *   element the way a browser does — it has no concept of painting order at
 *   all, so calling it would either always miss or trivially "pass" without
 *   exercising anything.
 * - `getComputedStyle(el).zIndex` (the documented fallback) was tried and
 *   also does NOT work here: under this repo's `vitest.config.components.ts`
 *   (happy-dom + svelteTesting()), rendering a component injects zero
 *   `<style>` tags into `document.head` — Svelte's compiled scoped CSS never
 *   reaches the DOM in this harness, so every computed style read comes back
 *   empty regardless of what the component's `<style>` block says. Verified
 *   empirically (a component's class list is present and correct; its
 *   stylesheet is not).
 * - So this test reads the component's own `<style>` block from source and
 *   asserts the `z-index` declared for the exact selector, cross-checked
 *   against the *rendered* markup to confirm the component really applies
 *   that class name (catching a class-name typo the source-only half would
 *   miss). This proves the CSS declaration exists, is well-formed, and is
 *   above the documented video baseline — it does NOT prove real-browser
 *   paint order or that a mouse click actually reaches the element. That was
 *   confirmed manually on preprod for this fix (see task report) and is
 *   outside what this environment can exercise.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import PlayerControls from './PlayerControls.svelte';
import PlayerOverlay from './PlayerOverlay.svelte';
import VideoOverlays from './VideoOverlays.svelte';
import { playerStore } from './playerStore.svelte';

// Documented invariant from VideoPlayer.svelte's `.video-element` comment —
// the local player-container tier scale starts at 0 (backdrop), 1 (video).
const VIDEO_Z_INDEX = 1;

// import.meta.url isn't a real file:// URL under vitest's module runner, so
// resolve source files relative to the repo root instead.
const PLAYER_DIR = join(process.cwd(), 'src/lib/components/player');

function readComponentSource(filename: string): string {
    return readFileSync(join(PLAYER_DIR, filename), 'utf-8');
}

/**
 * Extracts the `z-index` declared for an exact (non-compound) selector's
 * rule block from a component's source text, e.g. `.controls-container {`
 * but not `.controls-container.controls-hidden {`. Strips `/* *\/` comments
 * first — several of the components under test carry explanatory comments
 * about this very regression that themselves mention `z-index: 1` (the
 * video's value) inline, which would otherwise be matched instead of the
 * real declaration.
 */
function declaredZIndex(source: string, selector: string): number | null {
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockMatch = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(withoutComments);
    if (!blockMatch) return null;
    const zMatch = /z-index:\s*(-?\d+)/.exec(blockMatch[1]);
    return zMatch ? Number(zMatch[1]) : null;
}

afterEach(() => {
    cleanup();
    playerStore.isPaused = true;
    playerStore.isBuffering = false;
    playerStore.isLoading = true;
    playerStore.error = null;
});

describe('player-container z-index stacking (click-through regression)', () => {
    it('PlayerControls .controls-container is rendered and declares z-index above the video', () => {
        const { container } = render(PlayerControls, { props: { visible: true } });
        expect(container.querySelector('.controls-container')).toBeTruthy();

        const source = readComponentSource('PlayerControls.svelte');
        const z = declaredZIndex(source, '.controls-container');
        expect(z).not.toBeNull();
        expect(z as number).toBeGreaterThan(VIDEO_Z_INDEX);
    });

    it('PlayerOverlay .top-overlay (back button/title) is rendered and declares z-index above the video', () => {
        const { container } = render(PlayerOverlay, { props: {} });
        expect(container.querySelector('.top-overlay')).toBeTruthy();

        const source = readComponentSource('PlayerOverlay.svelte');
        const z = declaredZIndex(source, '.top-overlay');
        expect(z).not.toBeNull();
        expect(z as number).toBeGreaterThan(VIDEO_Z_INDEX);
    });

    it('PlayerOverlay .center-overlay (loading/error/play button) is rendered and declares z-index above the video', () => {
        playerStore.isLoading = true;
        const { container } = render(PlayerOverlay, { props: {} });
        expect(container.querySelector('.center-overlay')).toBeTruthy();

        const source = readComponentSource('PlayerOverlay.svelte');
        const z = declaredZIndex(source, '.center-overlay');
        expect(z).not.toBeNull();
        expect(z as number).toBeGreaterThan(VIDEO_Z_INDEX);
    });

    it('AudioOnlyBackdrop is rendered and stays behind the video (z-index 0 < 1)', async () => {
        const AudioOnlyBackdrop = (await import('./AudioOnlyBackdrop.svelte')).default;
        const { container } = render(AudioOnlyBackdrop, {
            props: { artworkId: 'abc', title: 'X' },
        });
        expect(container.querySelector('.audio-only-backdrop')).toBeTruthy();

        const source = readComponentSource('AudioOnlyBackdrop.svelte');
        const z = declaredZIndex(source, '.audio-only-backdrop');
        expect(z).not.toBeNull();
        expect(z as number).toBeLessThan(VIDEO_Z_INDEX);
    });

    it('VideoPlayer .video-element declares the documented baseline z-index of 1', () => {
        const source = readComponentSource('VideoPlayer.svelte');
        const z = declaredZIndex(source, '.video-element');
        expect(z).toBe(VIDEO_Z_INDEX);
    });

    it("VideoOverlays .player-logo-container stays below PlayerControls' .controls-container", () => {
        // .player-logo-container is a direct, unwrapped child of .player-container
        // (VideoOverlays has no root element), so it compares via plain sibling
        // z-index against .controls-container — same flat tier as the video/overlay
        // checks above. If the logo's z-index exceeds .controls-container's, the
        // logo paints over the ENTIRE control bar, including anything nested inside
        // it (e.g. ProgressBar -> HoverPreview's trickplay scrub thumbnail), because
        // a descendant's z-index can never let it escape an ancestor stacking
        // context that itself lost the comparison at the parent level.
        const { container } = render(VideoOverlays, {
            props: { logoUrl: 'https://example.com/logo.png', showLogo: true },
        });
        expect(container.querySelector('.player-logo-container')).toBeTruthy();

        const logoSource = readComponentSource('VideoOverlays.svelte');
        const logoZ = declaredZIndex(logoSource, '.player-logo-container');
        expect(logoZ).not.toBeNull();

        const controlsSource = readComponentSource('PlayerControls.svelte');
        const controlsZ = declaredZIndex(controlsSource, '.controls-container');
        expect(controlsZ).not.toBeNull();

        expect(logoZ as number).toBeLessThan(controlsZ as number);
    });
});
