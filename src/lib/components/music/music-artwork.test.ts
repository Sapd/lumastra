// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ImageSet } from '$lib/schemas/api-image-descriptor';
import type { SearchResultItem } from '$lib/api/content';
import { musicTrackFromCard } from '$lib/utils/music-track';
import { buildImageSet } from '$lib/shared/image-descriptor';

const mocks = vi.hoisted(() => ({ search: vi.fn(), getSonicPath: vi.fn() }));
vi.mock('$lib/api/content', () => ({ search: mocks.search }));
vi.mock('$lib/api/music', () => ({ getSonicPath: mocks.getSonicPath, getTrack: vi.fn() }));
vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/music/path') }) }));
vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: { subscribe: readable({ currentTrack: null }).subscribe },
}));
vi.mock('$lib/stores/music-alchemy.store.svelte', () => ({
    musicAlchemyStore: {
        init: vi.fn(),
        seedTracks: [],
        avoidTracks: [],
        brewedTracks: [],
        moodAnchors: [],
        energy: 0.5,
        tempo: 0.5,
        obscurity: 0.5,
        seedCount: 0,
        addSeed: vi.fn(),
        addAvoid: vi.fn(),
    },
}));

import MixingDesk from './MixingDesk.svelte';
import SongPath from './SongPath.svelte';
import SeedAvoidPad from './SeedAvoidPad.svelte';
import BrewTicket from './BrewTicket.svelte';

const TRACK_ID = 'b646b554-2b18-40f5-b72a-c12460623689';
const ALBUM_ID = '67984085-d447-47bb-981c-4da636912ee8';
const images = buildImageSet('internal', {
    primary: { ownerId: ALBUM_ID, urlRole: 'poster', source: 'album', revision: 'cover-v2' },
});
const hrefOnly = { primary: { ...images.primary!, variants: undefined } };
const track = musicTrackFromCard({ id: TRACK_ID, title: 'Alchemy', images });
const item: SearchResultItem = {
    id: TRACK_ID,
    catalogId: TRACK_ID,
    type: 'track',
    ids: {},
    title: 'Alchemy',
    images,
    overview: 'Avantasia · Moonglow',
    album: 'Moonglow',
    albumId: ALBUM_ID,
};

/** Check the mounted byte route for EVERY rendered href, not just a URL snapshot. */
function expectArtwork(container: HTMLElement, expected: string[]): void {
    const srcs = Array.from(container.querySelectorAll('img'), (img) => img.getAttribute('src'));
    expect(srcs).toEqual(expected);
    for (const src of srcs) {
        expect(src).toBeTruthy();
        const url = new URL(src!, 'http://localhost');
        expect(url.pathname).toMatch(/^\/api\/(v1\/)?media\/[^/]+\/images\/poster$/);
        const surface = url.pathname.startsWith('/api/v1/') ? 'api/v1' : 'api';
        expect(
            existsSync(resolve(`src/routes/${surface}/media/[id]/images/[role]/+server.ts`)),
        ).toBe(true);
        expect(url.searchParams.get('size')).toMatch(/^(thumb|card)$/);
        expect(url.pathname).toContain(ALBUM_ID);
    }
}

afterEach(cleanup);
beforeEach(() => {
    mocks.search.mockReset();
    mocks.search.mockResolvedValue({
        data: { items: [item], page: { limit: 20, offset: 0, hasMore: false } },
    });
});

describe('Alchemy and Song Paths artwork contracts', () => {
    it.each<ImageSet>([images, hrefOnly, {}])(
        'Alchemy search keeps the advertised primary art: %j',
        async (art) => {
            mocks.search.mockResolvedValue({ data: { items: [{ ...item, images: art }] } });
            const { container } = render(MixingDesk);
            await fireEvent.input(container.querySelector('input')!, {
                target: { value: 'alchemy' },
            });
            await waitFor(() =>
                expect(container.querySelector('.result-title')?.textContent).toBe('Alchemy'),
            );
            expect(mocks.search).toHaveBeenCalledWith('alchemy', { types: 'track', limit: 30 });
            expectArtwork(
                container,
                art.primary ? [art.primary.variants?.thumb ?? art.primary.href] : [],
            );
        },
    );

    it.each<ImageSet>([images, hrefOnly, {}])(
        'Song Paths search and picked endpoint keep primary art: %j',
        async (art) => {
            mocks.search.mockResolvedValue({ data: { items: [{ ...item, images: art }] } });
            const { container } = render(SongPath);
            const input = container.querySelector('input[type="text"]')!;
            await fireEvent.focus(input);
            await fireEvent.input(input, { target: { value: 'alchemy' } });
            await waitFor(() =>
                expect(container.querySelector('.result-title')?.textContent).toBe('Alchemy'),
            );
            expectArtwork(
                container,
                art.primary ? [art.primary.variants?.thumb ?? art.primary.href] : [],
            );
            await fireEvent.click(container.querySelector('.result-row')!);
            expectArtwork(
                container,
                art.primary ? [art.primary.variants?.thumb ?? art.primary.href] : [],
            );
        },
    );

    it('path results use advertised album owners, including href-only steps and missing art', async () => {
        const { container } = render(SongPath);
        async function pick(slot: number, id: string): Promise<void> {
            mocks.search.mockResolvedValue({ data: { items: [{ ...item, id, catalogId: id }] } });
            const input = container.querySelectorAll('input[type="text"]')[slot]!;
            await fireEvent.focus(input);
            await fireEvent.input(input, { target: { value: 'alchemy' } });
            await waitFor(() => expect(container.querySelector('.result-row')).toBeTruthy());
            await fireEvent.click(container.querySelector('.result-row')!);
        }
        await pick(0, TRACK_ID);
        // The first input is now a chip, leaving only the To field.
        await pick(0, ALBUM_ID);
        mocks.getSonicPath.mockResolvedValue({
            data: {
                steps: [
                    { id: 'one', step: 0, similarityScore: 0.9, track },
                    {
                        id: 'two',
                        step: 1,
                        similarityScore: 0.8,
                        track: { ...track, images: hrefOnly },
                    },
                    { id: 'three', step: 2, similarityScore: 0.7, track: { ...track, images: {} } },
                ],
            },
        });
        await fireEvent.click(container.querySelector('.brew-btn')!);
        await waitFor(() => expect(container.querySelectorAll('.bridge-step').length).toBe(3));
        const thumb = images.primary!.variants!.thumb!;
        expectArtwork(container, [thumb, thumb, thumb, thumb, hrefOnly.primary.href, thumb]);
    });

    it.each(['seed', 'avoid'] as const)(
        '%s pad supports href-only artwork and omits missing images',
        (type) => {
            const tracks = [
                musicTrackFromCard({ ...track, images: hrefOnly }),
                musicTrackFromCard({ ...track, id: ALBUM_ID, images: {} }),
            ];
            const { container } = render(SeedAvoidPad, { tracks, type });
            expectArtwork(container, [hrefOnly.primary.href]);
        },
    );

    it('brew results support href-only artwork and omit missing images', () => {
        const tracks = [
            track,
            musicTrackFromCard({ ...track, id: ALBUM_ID, images: hrefOnly }),
            musicTrackFromCard({ ...track, id: 'no-art', images: {} }),
        ];
        const { container } = render(BrewTicket, { tracks, hasBrewed: true });
        expectArtwork(container, [images.primary!.variants!.thumb!, hrefOnly.primary.href]);
    });
});
