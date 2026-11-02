// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { writable } from 'svelte/store';

const { page } = vi.hoisted(() => ({ page: { subscribe: vi.fn() } }));
vi.mock('$app/stores', () => ({ page }));

import AboutContent from './AboutContent.svelte';
import audiobookshelfLogo from '$lib/assets/providers/audiobookshelf-full.svg';

afterEach(cleanup);

describe('audiobookshelf credit on About', () => {
    test.each([
        { types: ['audiobook'], visible: true },
        { types: ['music', 'audiobook'], visible: true },
        { types: ['music'], visible: false },
        { types: [], visible: false },
        { types: undefined, visible: false },
    ])('library types $types show credit: $visible', ({ types, visible }) => {
        page.subscribe.mockImplementation(
            writable({ data: { appVersion: 'v1.0.0', activeLibraryTypes: types } }).subscribe,
        );
        render(AboutContent);
        expect(
            screen
                .getByRole('link', { name: 'ASS/SSA subtitle rendering with AkariSub' })
                .getAttribute('href'),
        ).toBe('https://github.com/altqx/akarisub');
        expect(
            screen
                .getByRole('link', { name: 'Bitmap subtitle rendering with libbitsub' })
                .getAttribute('href'),
        ).toBe('https://github.com/altqx/libbitsub');
        const credit = screen.queryByRole('link', {
            name: 'Audiobook integration with audiobookshelf',
        });
        expect(Boolean(credit)).toBe(visible);
        if (credit) {
            expect(credit.getAttribute('href')).toBe('https://www.audiobookshelf.org/');
            const logo = credit.querySelector('img');
            expect(logo?.getAttribute('src')).toBe(audiobookshelfLogo);
        }
    });
});

describe('metadata credits on About', () => {
    test.each([undefined, [], ['tmdb']])(
        'shows TMDB only in configured providers: %j',
        (providers) => {
            page.subscribe.mockImplementation(
                writable({ data: { metadataAttributionProviders: providers } }).subscribe,
            );
            render(AboutContent);
            expect(
                Boolean(
                    screen.queryByText(
                        'This product uses the TMDB API but is not endorsed or certified by TMDB.',
                    ),
                ),
            ).toBe(providers?.includes('tmdb') ?? false);
            expect(Boolean(screen.queryByAltText('TMDB'))).toBe(
                providers?.includes('tmdb') ?? false,
            );
        },
    );
    test('renders configured music sources with direct links', () => {
        page.subscribe.mockImplementation(
            writable({
                data: {
                    metadataAttributionProviders: [
                        'discogs',
                        'theaudiodb',
                        'deezer',
                        'musicbrainz',
                        'coverartarchive',
                        'lastfm',
                        'acoustid',
                        'lrclib',
                    ],
                },
            }).subscribe,
        );
        render(AboutContent);
        expect(
            screen.getByRole('link', { name: 'Data provided by Discogs' }).getAttribute('href'),
        ).toBe('https://www.discogs.com/');
        for (const [provider, url] of [
            ['TheAudioDB', 'https://www.theaudiodb.com/'],
            ['Deezer', 'https://www.deezer.com/'],
            ['MusicBrainz', 'https://musicbrainz.org/'],
            ['Cover Art Archive', 'https://coverartarchive.org/'],
            ['Last.fm', 'https://www.last.fm/'],
            ['AcoustID', 'https://acoustid.org/'],
            ['LRCLIB', 'https://lrclib.net/'],
        ]) {
            expect(
                screen
                    .getByRole('link', { name: `Data provided by ${provider}` })
                    .getAttribute('href'),
            ).toBe(url);
        }
        expect(screen.queryByRole('link', { name: 'Data provided by OMDb' })).toBeNull();
    });
});

test.each([{ providers: [] }, { providers: ['fribb', 'myanimelist', 'trakt', 'musicbrainz'] }])(
    'shows additional credits and MusicBrainz licence only when active: $providers', ({ providers }) => {
        page.subscribe.mockImplementation(writable({ data: { metadataAttributionProviders: providers } }).subscribe);
        render(AboutContent);
        for (const [id, name, url] of [
            ['fribb', 'Fribb anime-lists', 'https://github.com/Fribb/anime-lists'],
            ['myanimelist', 'MyAnimeList', 'https://myanimelist.net/'],
            ['trakt', 'Trakt', 'https://trakt.tv/'],
        ]) {
            const link = screen.queryByRole('link', { name: `Data provided by ${name}` });
            expect(Boolean(link)).toBe(providers.includes(id));
            if (link) expect(link.getAttribute('href')).toBe(url);
        }
        const licence = screen.queryByRole('link', { name: 'Core data: CC0; supplementary data: CC BY-NC-SA 3.0.' });
        expect(Boolean(licence)).toBe(providers.includes('musicbrainz'));
        if (licence) {
            expect(licence.getAttribute('href')).toBe('https://musicbrainz.org/doc/About/Data_License');
            expect(licence.parentElement?.textContent).toContain('Data provided by MusicBrainz');
        }
    },
);
