// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrickplayManifestResponse } from '$lib/schemas/playback-trickplay';
import HoverPreview from './HoverPreview.svelte';
import FilmstripOverlay from './FilmstripOverlay.svelte';

// A 21:29 episode: the second sheet starts at 16:40 and has only three rows.
const manifest: TrickplayManifestResponse = {
    fileId: '741bc18e-23a7-48b5-abcb-e7c84dcb2959',
    width: 320,
    height: 256,
    tileColumns: 10,
    tileRows: 10,
    intervalMs: 10000,
    thumbnailCount: 129,
    sheets: [
        { index: 0, startMs: 0, endMs: 1000000, href: '/sheet0.webp' },
        { index: 1, startMs: 1000000, endMs: 1290000, href: '/sheet1.webp' },
    ],
};

afterEach(cleanup);

describe('trickplay sheet proportions', () => {
    it.each([990, 1000, 1280])('preserves hover image proportions at %s seconds', (time) => {
        const tile = Math.floor(time / 10) % 100;
        const { container } = render(HoverPreview, {
            hoverTime: time,
            trickplayImage: time < 1000 ? '/sheet0.webp' : '/sheet1.webp',
            trickplayInfo: manifest,
            tilePos: { x: (tile % 10) * 320, y: Math.floor(tile / 10) * 256 },
            previewPos: { left: '50%', transform: 'translateX(-50%)' },
        });
        const image = container.querySelector<HTMLElement>('.trickplay-thumbnail');
        expect(image).not.toBeNull();
        // A fixed height stretches compact final sheets. Width-only scaling also
        // supports imported sheets with padded rows, whose height can differ.
        expect(image?.style.backgroundSize).toBe('3200px auto');
        expect(image?.style.height).toBe('256px');
        expect(image?.style.backgroundPosition).toBe(
            `${-(tile % 10) * 320}px ${-Math.floor(tile / 10) * 256}px`,
        );
    });

    it('preserves proportions for filmstrip images spanning the sheet boundary', () => {
        const { container } = render(FilmstripOverlay, {
            filmstripActiveTime: 1000,
            filmstripPrecision: 1,
            trickplayInfo: manifest,
            duration: 1289.493,
            filmstripThumbnails: [990, 1000, 1280].map((time) => {
                const tile = Math.floor(time / 10) % 100;
                return {
                    time,
                    spriteIndex: time < 1000 ? 0 : 1,
                    tilePos: { x: (tile % 10) * 320, y: Math.floor(tile / 10) * 256 },
                    isLoaded: true,
                    isLoading: false,
                    isFailed: false,
                    isCenter: time === 1000,
                };
            }),
            getSpriteSheetUrl: (index: number) => `/sheet${index}.webp`,
            getSegmentAtTime: () => null,
        });
        const images = container.querySelectorAll<HTMLElement>('.filmstrip-thumb-inner');
        expect(images).toHaveLength(3);
        for (const image of images) {
            expect(image.style.backgroundSize).toBe('3200px auto');
            expect(image.style.height).toBe('256px');
        }
    });
});
