// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Example names are fictional; production shapes and measurements are retained.
 * HeroSection.svelte.test.ts
 *
 * Guards the hero carousel's POINTER CONTRACT.
 *
 * The hero listens for pointerdown/pointerup on the carousel root to detect a
 * horizontal swipe. `3abcfe28a` additionally called `setPointerCapture()` on
 * every pointerdown so a native image drag couldn't steal the pointerup — and
 * that silently killed every click inside the hero, including the
 * Play / Resume ("Fortsetzen") button.
 *
 * Why: with an active pointer capture the browser retargets the compatibility
 * mouse events, so `click` is dispatched on the CAPTURE ELEMENT (the carousel)
 * rather than on the element under the cursor. The play <a>, the request <a>,
 * the audiobook <button> and the "open details" wrapper are all descendants —
 * none of them ever saw a click, and the <a>'s own default navigation was
 * suppressed too. Verified in Chromium: clicking a link inside a capturing
 * ancestor logs `click target=<ancestor>` and does not navigate.
 *
 * happy-dom does not model that retargeting, so a click-based assertion would
 * pass even while the app is broken. This test therefore asserts the invariant
 * one level down — the hero must never capture the pointer — which is exactly
 * what regressed.
 */

import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HeroSection from './HeroSection.svelte';
import type { PageSection } from '$lib/types/server-driven-ui';

// HeroSection transitively imports $env/dynamic/public (request-URL branding).
vi.mock('$env/dynamic/public', () => ({ env: {} }));

vi.mock('$app/navigation', () => ({
    goto: vi.fn(),
    afterNavigate: vi.fn(),
    beforeNavigate: vi.fn(),
    onNavigate: vi.fn(),
    pushState: vi.fn(),
    replaceState: vi.fn(),
    invalidate: vi.fn(),
    invalidateAll: vi.fn(),
    preloadData: vi.fn(),
    preloadCode: vi.fn(),
}));

const section = {
    id: 'hero',
    type: 'hero',
    title: 'Hero',
    items: [
        {
            id: 'tmdb:1396:tv',
            title: 'Drifting Clouds',
            mediaType: 'episode',
            backdrop: '/backdrop.jpg',
            image: '/poster.jpg',
            progress: 25,
            runtimeMinutes: 47,
            isAvailable: true,
            hasFiles: true,
            externalIds: { internal: '11111111-2222-3333-4444-555555555555' },
        },
    ],
} as unknown as PageSection;

/**
 * Five slides with a blurhash on every one, mirroring the `HERO_MAX_SLIDES`
 * default. `currentIndex` starts at 0, so `heroImageSlots(0, 5)` (see
 * hero-carousel.test.ts) is `{0, 1, 4}` — index 2 is a dot-jump target
 * (HeroControls renders one dot per slide, wired to an arbitrary-index `goTo`)
 * that is NOT in that window, so its <img> never mounts here.
 */
function slideWithBlurHash(id: string, title: string) {
    return {
        id,
        title,
        mediaType: 'movie',
        backdrop: `/backdrop-${id}.jpg`,
        image: `/poster-${id}.jpg`,
        backdropBlurHash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
        isAvailable: true,
        hasFiles: true,
        externalIds: { internal: `11111111-2222-3333-4444-55555555555${id}` },
    };
}

const multiSlideSection = {
    id: 'hero',
    type: 'hero',
    title: 'Hero',
    items: [0, 1, 2, 3, 4].map((i) => slideWithBlurHash(String(i), `Slide ${i}`)),
} as unknown as PageSection;

afterEach(cleanup);

describe('HeroSection LQIP placeholder (blank-box-on-jump fix)', () => {
    it('renders a blurhash placeholder for a slide outside the active ± 1 image-slot window', () => {
        const { container } = render(HeroSection, { props: { section: multiSlideSection } });

        const slides = container.querySelectorAll('.hero-slide');
        expect(slides.length).toBe(5);

        // Index 2 is not in heroImageSlots(0, 5) = {0, 1, 4}: its <img> should
        // NOT be mounted yet...
        const skippedSlide = slides[2];
        expect(skippedSlide.querySelector('img.slide-image')).toBeNull();

        // ...but it must still have a placeholder covering the box so a later
        // dot-jump to it doesn't cross-fade against an empty div. Pre-fix, the
        // LQIP div was gated to `index === 0` only, so this would be null.
        expect(
            skippedSlide.querySelector('.hero-lqip'),
            'a slide outside the image-slot window must still get an LQIP placeholder',
        ).not.toBeNull();
    });

    it('gives every slide with a blurhash its own placeholder, not just index 0', () => {
        const { container } = render(HeroSection, { props: { section: multiSlideSection } });

        const slides = container.querySelectorAll('.hero-slide');
        const withPlaceholder = Array.from(slides).filter((s) => s.querySelector('.hero-lqip'));
        expect(withPlaceholder.length).toBe(5);
    });

    it('keeps the LQIP hidden for an already-loaded slide after an `items` reference change that preserves its render key (regression: eca3138880)', async () => {
        // eca3138880 generalized the LQIP to per-slide arrays, but its reset
        // effect nulls `slideImgEls` on every `items` reference change — even
        // for a slide whose render key (and therefore DOM node/<img>) survived
        // the swap. `{@attach captureSlideImg(index)}` only re-runs when
        // `index` changes, so a surviving slide's `slideImgEls[i]` stays null
        // forever and the cached-image guard can never re-flip `imageLoaded[i]`
        // back to true — permanently re-covering an already-loaded backdrop
        // with the blurred placeholder.
        const { container, rerender } = render(HeroSection, {
            props: { section: multiSlideSection },
        });

        const slide0 = () => container.querySelectorAll('.hero-slide')[0];
        const slide0Lqip = () => slide0().querySelector('.hero-lqip');
        const slide0Img = () => slide0().querySelector('img.slide-image');

        expect(slide0Img(), 'index 0 is in the active ± 1 image-slot window').not.toBeNull();
        // happy-dom's freshly-created <img> reports `.complete === true`
        // synchronously (nothing actually fetches it) — exactly the
        // "cached image" case the attach's `.complete` check exists for, so
        // the LQIP is already hidden without an explicit `load` event.
        expect(slide0Lqip()?.classList.contains('hidden')).toBe(true);
        // A real load event must not change that.
        await fireEvent.load(slide0Img()!);
        expect(slide0Lqip()?.classList.contains('hidden')).toBe(true);

        // A refresh swaps in a content-different list (a new item at index 4
        // — different composite key), which the reconcile effect treats as
        // genuinely different and re-points `items` to a NEW array reference.
        // Index 0 keeps the SAME render key, so the keyed {#each} reuses its
        // existing DOM node/<img> untouched.
        const refreshedSection = {
            ...multiSlideSection,
            items: [
                slideWithBlurHash('0', 'Slide 0'),
                slideWithBlurHash('1', 'Slide 1'),
                slideWithBlurHash('2', 'Slide 2'),
                slideWithBlurHash('3', 'Slide 3'),
                slideWithBlurHash('5', 'Slide 5 (new)'),
            ],
        } as unknown as PageSection;

        await rerender({ section: refreshedSection });

        expect(
            slide0Lqip()?.classList.contains('hidden'),
            'slide 0 kept its render key across the refresh — its already-loaded backdrop must not be re-covered by the LQIP placeholder',
        ).toBe(true);
    });

    it('shows the LQIP again once a loaded slide is evicted from the image-slot window (regression: eca3138880, minor)', async () => {
        // heroImageSlots(currentIndex, len) only mounts <img> for the active
        // slide ± 1. Moving away unmounts index 0's <img>. Without a cleanup
        // on `captureSlideImg`'s attach, `slideImgEls[0]` keeps pointing at
        // the now-detached node and `imageLoaded[0]` is never reset, so the
        // LQIP stays hidden even though there is no image mounted at all —
        // a dot-jump back would cross-fade against a bare box.
        const { container, component } = render(HeroSection, {
            props: { section: multiSlideSection },
        });

        const slide0 = () => container.querySelectorAll('.hero-slide')[0];
        const slide0Lqip = () => slide0().querySelector('.hero-lqip');

        expect(
            slide0().querySelector('img.slide-image'),
            'index 0 starts in the image-slot window',
        ).not.toBeNull();
        expect(
            slide0Lqip()?.classList.contains('hidden'),
            'already-loaded backdrop hides its LQIP',
        ).toBe(true);

        // Move the active slide to 2: heroImageSlots(2, 5) = {1, 2, 3} — index
        // 0 falls out of the window and its <img> unmounts.
        (component as unknown as { goTo: (i: number) => void }).goTo(2);
        await tick();
        await tick();

        expect(
            slide0().querySelector('img.slide-image'),
            'index 0 left the image-slot window',
        ).toBeNull();
        expect(
            slide0Lqip()?.classList.contains('hidden'),
            'no image is mounted for slide 0 any more — the LQIP must be visible, not hidden behind a stale imageLoaded flag',
        ).toBe(false);
    });
});

describe('HeroSection pointer contract', () => {
    let captureSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        captureSpy = vi.fn();
        // happy-dom does not implement the pointer-capture API at all, so the
        // component's optional call (`?.`) would no-op. Install it so a
        // regression is observable.
        (Element.prototype as unknown as Record<string, unknown>).setPointerCapture = captureSpy;
        (Element.prototype as unknown as Record<string, unknown>).releasePointerCapture = vi.fn();
        (Element.prototype as unknown as Record<string, unknown>).hasPointerCapture = () => false;
    });

    it('does not capture the pointer on pointerdown (capture retargets the click off the play button)', async () => {
        const { container } = render(HeroSection, { props: { section } });

        const carousel = container.querySelector('.hero-carousel, section');
        expect(carousel, 'hero carousel root should render').not.toBeNull();

        carousel?.dispatchEvent(
            new PointerEvent('pointerdown', {
                bubbles: true,
                clientX: 100,
                clientY: 100,
                button: 0,
                pointerId: 1,
            }),
        );

        expect(
            captureSpy,
            'the hero must not setPointerCapture() — it retargets the subsequent click to the carousel, so the Play/Resume button never receives it',
        ).not.toHaveBeenCalled();
    });

    it('keeps the backdrop undraggable — that, not pointer capture, is what protects the swipe', () => {
        const { container } = render(HeroSection, { props: { section } });

        const backdrop = container.querySelector('.slide-image');
        expect(backdrop, 'backdrop image should render').not.toBeNull();
        // A native image drag fires pointercancel and swallows the pointerup, so
        // a swipe starting on the artwork would never commit. Verified in
        // Chromium: dragging a draggable <img> loses the swipe EVEN WITH pointer
        // capture set, while an undraggable one completes it without capture.
        expect(backdrop?.getAttribute('draggable')).toBe('false');
    });

    it('renders the play affordance as a real /watch link so it works without JS too', () => {
        const { container } = render(HeroSection, { props: { section } });

        const play = container.querySelector('a.lumastra-hero-play');
        expect(play, 'play/resume anchor should render for a watchable item').not.toBeNull();
        expect(play?.getAttribute('href')).toContain('/watch/');
    });
});

// Prod 2026-09-25: a VISIBLE, unattended home tab rotated the hero for 30
// hours (5,995 preview-session POSTs). `visibilitychange` never fires for a
// window nobody is looking at, so rotation must stop on input-idle too.
describe('HeroSection idle pause', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function activeSlideTitle(container: HTMLElement): string | null {
        const active = container.querySelector('.is-active');
        return (
            active?.getAttribute('data-slide-title') ??
            active?.textContent?.trim().slice(0, 40) ??
            null
        );
    }

    it('stops rotating after the user has been idle, and resumes on input', async () => {
        const { container } = render(HeroSection, { props: { section: multiSlideSection } });
        await tick();

        // Well past the idle threshold (5 min) with no input at all.
        await vi.advanceTimersByTimeAsync(6 * 60_000);
        const frozen = activeSlideTitle(container);
        // Sample every 10s (the rotation interval) — a window-length check can
        // land back on the same slide after a full cycle and pass vacuously.
        const seen = new Set<string | null>();
        for (let i = 0; i < 12; i++) {
            await vi.advanceTimersByTimeAsync(10_000);
            seen.add(activeSlideTitle(container));
        }
        expect([...seen]).toEqual([frozen]);

        // Any input resumes the rotation.
        window.dispatchEvent(new Event('pointermove'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(activeSlideTitle(container)).not.toBe(frozen);
    });
});
