// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages';
import type { UniversalMediaItem } from '$lib/schemas/api-responses';
import UniversalMediaCard from './UniversalMediaCard.svelte';
import { transformSearchItem } from '$lib/utils/search/transformers';

const env = vi.hoisted(() => ({ PUBLIC_REQUESTURL: '/requests' }));
vi.mock('$env/dynamic/public', () => ({ env }));
vi.mock('$lib/utils/modal-utils', () => ({ openArtistModal: vi.fn() }));
vi.mock('$lib/utils/similar-prefetch', () => ({ prefetchSimilar: vi.fn() }));

const movie: UniversalMediaItem = {
    id: 'search-10000000-0000-0000-0000-000000000001',
    externalIds: { internal: '10000000-0000-0000-0000-000000000001' },
    mediaType: 'movie',
    title: 'A catalog movie',
    image: '/poster.png',
    isAvailable: false,
    hasFiles: false,
    canRequest: true,
};

beforeEach(() => {
    env.PUBLIC_REQUESTURL = '/requests';
    window.matchMedia = vi.fn().mockImplementation(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    }));
});
afterEach(cleanup);

describe('list card availability', () => {
    it.each([
        'movie',
        'series',
        'episode',
        'audiobook',
        'home_video',
        'training',
        'educational',
        'personal',
    ] as const)('does not advertise an unavailable catalog %s as playable', (mediaType) => {
        const { container } = render(UniversalMediaCard, {
            item: transformSearchItem(
                {
                    id: movie.externalIds!.internal!,
                    catalogId: movie.externalIds!.internal!,
                    type: mediaType,
                    title: movie.title,
                    ids: {},
                    images: {},
                    score: 1,
                    availability: {
                        isAvailable: false,
                        canRequest: ['movie', 'series'].includes(mediaType),
                    },
                },
                '',
            ),
            variant: 'list',
        });
        expect(container.querySelector('[data-play-button]')).toBeNull();
        expect(container.textContent).not.toContain(m.card_available());
    });

    it('requests an unavailable catalog movie instead of offering Play', async () => {
        const onrequest = vi.fn();
        const onplay = vi.fn();
        const onclick = vi.fn();
        render(UniversalMediaCard, { item: movie, variant: 'list', onrequest, onplay, onclick });
        await fireEvent.click(screen.getByRole('button', { name: new RegExp(m.request()) }));
        expect(onrequest).toHaveBeenCalledExactlyOnceWith(movie);
        expect(onplay).not.toHaveBeenCalled();
        expect(onclick).not.toHaveBeenCalled();
    });

    it('renders the unavailable API response without inferring availability from catalogId', () => {
        const item = transformSearchItem(
            {
                id: movie.externalIds!.internal!,
                catalogId: movie.externalIds!.internal!,
                type: 'movie',
                title: movie.title,
                ids: {},
                images: {},
                score: 1,
                availability: { isAvailable: false, canRequest: true },
            },
            '',
        );
        const { container } = render(UniversalMediaCard, { item, variant: 'list' });
        expect(container.querySelector('[data-play-button]')).toBeNull();
        expect(screen.getByRole('button', { name: new RegExp(m.request()) })).toBeTruthy();
    });

    it.each(['book', 'manga', 'comic'] as const)(
        'keeps %s Read actionable without a catalog ID',
        async (mediaType) => {
            const onplay = vi.fn();
            render(UniversalMediaCard, {
                item: transformSearchItem(
                    {
                        id: 'kavita-book-42',
                        catalogId: null,
                        type: mediaType,
                        title: 'A book',
                        ids: { kavita: '42' },
                        images: {},
                        score: 1,
                        availability: { isAvailable: true, canRequest: false },
                    },
                    '',
                ),
                variant: 'list',
                onplay,
            });
            await fireEvent.click(screen.getByRole('button', { name: new RegExp(m.card_read()) }));
            expect(onplay).toHaveBeenCalledOnce();
        },
    );

    it.each(['track', 'album', 'artist', 'tvchannel', 'audiobook'] as const)(
        'keeps available %s Play actionable',
        async (mediaType) => {
            const onplay = vi.fn();
            render(UniversalMediaCard, {
                item: { ...movie, mediaType, isAvailable: true, canRequest: false },
                variant: 'list',
                onplay,
            });
            await fireEvent.click(screen.getByRole('button', { name: new RegExp(m.card_play()) }));
            expect(onplay).toHaveBeenCalledOnce();
        },
    );

    it.each(['permission', 'configuration'] as const)(
        'hides Request when %s is absent',
        (missing) => {
            if (missing === 'configuration') env.PUBLIC_REQUESTURL = '';
            const { container } = render(UniversalMediaCard, {
                item: movie,
                variant: 'list',
                hasRequestPermission: missing !== 'permission',
            });
            expect(container.querySelector('[data-play-button]')).toBeNull();
            expect(screen.queryByRole('button', { name: new RegExp(m.request()) })).toBeNull();
        },
    );

    it('updates Play and Available when the catalog movie gains or loses files', async () => {
        const { container, rerender } = render(UniversalMediaCard, {
            item: movie,
            variant: 'list',
        });
        expect(container.querySelector('[data-play-button]')).toBeNull();
        await rerender({
            item: { ...movie, isAvailable: true, canRequest: false },
            variant: 'list',
        });
        expect(container.querySelector('[data-play-button]')).toBeTruthy();
        expect(container.textContent).toContain(m.card_available());
        await rerender({ item: movie, variant: 'list' });
        expect(container.querySelector('[data-play-button]')).toBeNull();
        expect(container.textContent).not.toContain(m.card_available());
    });
});
