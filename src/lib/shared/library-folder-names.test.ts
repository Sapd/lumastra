// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    isAudiobookFolderName,
    isLibraryFolderName,
    libraryTypeForFolderName,
} from './library-folder-names.js';

describe('library folder names', () => {
    it.each([
        ['movies', 'movie'],
        ['Filme', 'movie'],
        ['Kino', 'movie'],
        ['Kinderfilme', 'movie'],
        ['TV Shows', 'tv'],
        ['tv_shows', 'tv'],
        ['Serien', 'tv'],
        ['TV-Serien', 'tv'],
        ['Fernsehserien', 'tv'],
        ['Anime', 'anime'],
        ['Musik', 'music'],
        ['music', 'music'],
        // French
        ['Films', 'movie'],
        ['Séries', 'tv'],
        ['Musique', 'music'],
        // Spanish
        ['Películas', 'movie'],
        ['Peliculas', 'movie'],
        ['Series', 'tv'],
        ['Música', 'music'],
        // Portuguese
        ['Filmes', 'movie'],
        ['Séries', 'tv'],
        // Italian
        ['Film', 'movie'],
        ['Serie TV', 'tv'],
        ['Musica', 'music'],
        // Dutch
        ['Muziek', 'music'],
        ['Tv-series', 'tv'],
        // Polish
        ['Filmy', 'movie'],
        ['Seriale', 'tv'],
        ['Muzyka', 'music'],
        // Czech
        ['Seriály', 'tv'],
        ['Serialy', 'tv'],
        ['Hudba', 'music'],
    ])('%s is a %s library', (name, type) => {
        expect(libraryTypeForFolderName(name)).toBe(type);
        expect(isLibraryFolderName(name)).toBe(true);
    });

    it.each([
        'Kinder',
        'kids',
        'Dokus',
        'Dokumentationen',
        'Documentaries',
        'Enfants',
        'Niños',
        'Documentales',
        'Bambini',
        'Dzieci',
        'Děti',
        'Pro děti',
    ])('%s is a library folder without a type', (name) => {
        expect(isLibraryFolderName(name)).toBe(true);
        expect(libraryTypeForFolderName(name)).toBeNull();
    });

    it.each(['downloads', 'Alien (1979)', 'media', 'Urlaub 2019'])(
        '%s is not a library folder',
        (name) => {
            expect(isLibraryFolderName(name)).toBe(false);
            expect(libraryTypeForFolderName(name)).toBeNull();
        },
    );

    it.each([
        'Audiobooks',
        'Hörbücher',
        'Hoerbuecher',
        'Livres audio',
        'Audiolibros',
        'Audioknihy',
    ])('%s is an audiobook folder, not a library', (name) => {
        expect(isAudiobookFolderName(name)).toBe(true);
        expect(isLibraryFolderName(name)).toBe(false);
    });
});
