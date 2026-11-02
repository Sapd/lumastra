// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Regression test for the Continue Watching rail rendering the popcorn
 * placeholder for audiobooks instead of their cover art.
 *
 * Root cause: the backdrop-variant card (used for continue-watching /
 * next-up rows) always preferred `item.backdrop` over `item.image`. Every
 * server-side CW transform (effective-watching.service.ts /
 * media-transformer.service.ts) populates `backdrop` unconditionally via
 * `getCatalogBackdropUrl`, even for media types that have no backdrop art.
 * For audiobooks, ImageProxyService.getImageByCatalogId() short-circuits any
 * non-'poster' role to `null` (an AudiobookShelf book has exactly one cover),
 * and the `/api/media/{id}/images/{role}` route turns that `null` into a 302
 * redirect to FALLBACK_IMAGE (the popcorn placeholder). So a truthy-but-dead
 * `item.backdrop` silently shadowed the working `item.image` poster href the
 * server already resolved.
 */

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UniversalMediaItem } from '$lib/schemas/api-responses';
import { FALLBACK_IMAGE } from '$lib/constants/images';
import UniversalMediaCard from './UniversalMediaCard.svelte';

// UniversalMediaCard / TrackTitleLine transitively import $env/dynamic/public.
vi.mock('$env/dynamic/public', () => ({ env: {} }));

vi.mock('$lib/utils/modal-utils', () => ({ openArtistModal: vi.fn() }));

afterEach(cleanup);

const AUDIOBOOK_UUID = '4993e963-4220-4f1e-adc0-fb475034149a';

// Shaped exactly like the server's ContinueWatchingItem → UniversalMediaItem
// transform for an audiobook: only `externalIds.internal` (no tmdb/jellyfin —
// an ABS book has no provider ids), a working poster href, and a `backdrop`
// href that resolves to the placeholder server-side (audiobooks have no
// backdrop art).
const audiobookCwItem: UniversalMediaItem = {
    id: `cw-${AUDIOBOOK_UUID}`,
    externalIds: { internal: AUDIOBOOK_UUID },
    mediaType: 'audiobook',
    title: 'Milo Farrow und der Stein der Weisen - Gesprochen von Felix Vale',
    image: `/api/media/${AUDIOBOOK_UUID}/images/poster?size=thumb`,
    backdrop: `/api/media/${AUDIOBOOK_UUID}/images/backdrop?size=thumb`,
    isAvailable: true,
    canRequest: false,
    progress: 6,
};

const MOVIE_UUID = '11111111-2222-3333-4444-555555555555';

// A video item with tmdb ids and a real backdrop — must keep preferring the
// backdrop image (unaffected by the audiobook-only carve-out).
const movieCwItem: UniversalMediaItem = {
    id: `cw-${MOVIE_UUID}`,
    externalIds: { internal: MOVIE_UUID, tmdb: '603' },
    mediaType: 'movie',
    title: 'The Lantern',
    image: `/api/media/${MOVIE_UUID}/images/poster?size=thumb`,
    backdrop: `/api/media/${MOVIE_UUID}/images/backdrop?size=thumb`,
    isAvailable: true,
    canRequest: false,
    progress: 42,
};

describe('UniversalMediaCard backdrop-variant image selection', () => {
    it('uses the catalog poster href for an audiobook, not the dead backdrop href or the fallback placeholder', () => {
        const { container } = render(UniversalMediaCard, {
            props: { item: audiobookCwItem, variant: 'backdrop' },
        });

        const img = container.querySelector('img');
        expect(img).toBeTruthy();
        expect(img!.src).toContain(audiobookCwItem.image);
        expect(img!.src).not.toContain('backdrop');
        expect(img!.src).not.toContain(FALLBACK_IMAGE);
    });

    it('still prefers the backdrop href for a video item with tmdb ids', () => {
        const { container } = render(UniversalMediaCard, {
            props: { item: movieCwItem, variant: 'backdrop' },
        });

        const img = container.querySelector('img');
        expect(img).toBeTruthy();
        expect(img!.src).toContain(movieCwItem.backdrop);
    });

    // The server no longer emits `backdrop` for audiobooks at all
    // (MediaTransformerService.getBackdropUrl → undefined). This is the shape
    // the browser now actually receives; the card must fall back to the poster
    // on its own rather than rendering the title-only placeholder box.
    it('falls back to the poster when an audiobook item has no backdrop field', () => {
        const { backdrop: _dropped, ...withoutBackdrop } = audiobookCwItem;
        const { container } = render(UniversalMediaCard, {
            props: { item: withoutBackdrop as UniversalMediaItem, variant: 'backdrop' },
        });

        const img = container.querySelector('img');
        expect(img).toBeTruthy();
        expect(img!.src).toContain(audiobookCwItem.image);
    });
});

describe('UniversalMediaCard backdrop-variant portrait-in-landscape layout', () => {
    // An audiobook cover is 2:3; the backdrop slot is 16:9. Neither cropping it
    // (object-cover) nor stretching it (object-fill) is acceptable, so the card
    // pillarboxes: whole cover via object-contain, gutters filled with a blurred
    // over-scaled copy of the same cover.
    it('pillarboxes an audiobook cover: blurred fill layer + contained foreground', () => {
        const { container } = render(UniversalMediaCard, {
            props: { item: audiobookCwItem, variant: 'backdrop' },
        });

        const imgs = Array.from(container.querySelectorAll('img'));
        expect(imgs).toHaveLength(2);

        const [fill, cover] = imgs;

        // Decorative fill: same cover, over-scaled, blurred, darkened, and
        // hidden from assistive tech (it is not a second image).
        expect(fill.getAttribute('aria-hidden')).toBe('true');
        expect(fill.getAttribute('alt')).toBe('');
        expect(fill.className).toContain('object-cover');
        expect(fill.className).toContain('blur-2xl');
        expect(fill.className).toContain('scale-150');
        expect(fill.src).toContain(audiobookCwItem.image);

        // Foreground: the whole cover, never cropped or stretched.
        expect(cover.className).toContain('object-contain');
        expect(cover.className).not.toContain('object-cover');
        expect(cover.getAttribute('alt')).toBe(audiobookCwItem.title);
        // Honest intrinsic aspect hint (2:3), not the slot's 16:9 — otherwise
        // the browser reserves the wrong box and the row reflows on load.
        expect(cover.getAttribute('width')).toBe('200');
        expect(cover.getAttribute('height')).toBe('300');
    });

    it('leaves a video item on the single cropped-to-fill image', () => {
        const { container } = render(UniversalMediaCard, {
            props: { item: movieCwItem, variant: 'backdrop' },
        });

        const imgs = Array.from(container.querySelectorAll('img'));
        expect(imgs).toHaveLength(1);
        expect(imgs[0].className).toContain('object-cover');
        expect(imgs[0].className).not.toContain('object-contain');
        expect(imgs[0].getAttribute('width')).toBe('320');
        expect(imgs[0].getAttribute('height')).toBe('180');
    });
});
