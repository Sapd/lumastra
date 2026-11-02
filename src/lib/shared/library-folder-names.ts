// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Folder names that mark a media library, in English and the common European
 * languages: German, French, Spanish, Portuguese, Italian, Dutch, Polish and
 * Czech.
 *
 * Used twice and kept here so the two agree: `/api/setup/library-mounts`
 * looks inside a folder that groups libraries (`/data/media` holding
 * `movies/`, `serien/`, `musique/`), and the setup wizard preselects the type
 * of each folder it suggests. A name that holds either type ("kids", "Kinder",
 * "Documentaires") still counts as a library folder, but gets no type.
 *
 * Entries are written the way {@link normalize} leaves a name: lower case, no
 * separators, German umlauts spelled out, other accents dropped.
 */

export type LibraryFolderType = 'movie' | 'tv' | 'anime' | 'music';

const TYPED_NAMES: Record<LibraryFolderType, readonly string[]> = {
    movie: [
        // English
        'movie',
        'movies',
        'film',
        'films',
        'cinema',
        // German
        'filme',
        'kino',
        'kinofilme',
        'spielfilme',
        'kinderfilme',
        // Spanish
        'peliculas',
        'cine',
        // Portuguese
        'filmes',
        // Polish, Czech
        'filmy',
    ],
    tv: [
        // English
        'tv',
        'tvshows',
        'shows',
        'series',
        'television',
        // German
        'serien',
        'tvserien',
        'fernsehserien',
        'fernsehen',
        'sendungen',
        'kinderserien',
        // Italian ("Serie TV"), Dutch ("Series", "Tv-series")
        'serie',
        'serietv',
        'tvseries',
        // Polish
        'seriale',
        // Czech
        'serialy',
    ],
    anime: ['anime'],
    music: [
        'music',
        // German
        'musik',
        // French
        'musique',
        // Spanish, Portuguese, Italian
        'musica',
        // Dutch
        'muziek',
        // Polish
        'muzyka',
        // Czech
        'hudba',
    ],
};

/** Library folders whose content can be either type, so no type is guessed. */
const UNTYPED_NAMES: readonly string[] = [
    // English
    'kids',
    'documentary',
    'documentaries',
    // German
    'kinder',
    'doku',
    'dokus',
    'dokumentation',
    'dokumentationen',
    'dokumentarfilme',
    // French
    'enfants',
    'jeunesse',
    'documentaires',
    // Spanish, Portuguese
    'ninos',
    'infantil',
    'documentales',
    'documentarios',
    // Italian
    'bambini',
    'documentari',
    // Dutch
    'kinderen',
    // Polish
    'dzieci',
    'dokumenty',
    // Czech
    'deti',
    'prodeti',
];

/**
 * Lower case, separators removed, German umlauts spelled out (ö → oe), then
 * every other accent dropped, so "TV Shows", "TV-Serien", "Hörbücher",
 * "Películas", "Séries" and "Seriály" match their entries above with or
 * without their accents.
 */
function normalize(name: string): string {
    return name
        .normalize('NFC')
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[\s._-]+/g, '');
}

/**
 * Audiobook folders. Audiobooks come only from Audiobookshelf, so the wizard
 * never suggests these as a library (no library type would scan them).
 */
const AUDIOBOOK_NAMES: readonly string[] = [
    'audiobook',
    'audiobooks',
    'hoerbuch',
    'hoerbuecher',
    'hoerspiele',
    'livresaudio',
    'audiolibros',
    'audiolivros',
    'audiolibri',
    'luisterboeken',
    'audiobooki',
    'audioknihy',
];

const TYPE_BY_NAME = new Map<string, LibraryFolderType>(
    (Object.entries(TYPED_NAMES) as [LibraryFolderType, readonly string[]][]).flatMap(
        ([type, names]) => names.map((n) => [n, type] as const),
    ),
);
const UNTYPED = new Set(UNTYPED_NAMES);
const AUDIOBOOKS = new Set(AUDIOBOOK_NAMES);

/** The library type a folder name stands for, or null when it does not say. */
export function libraryTypeForFolderName(name: string): LibraryFolderType | null {
    return TYPE_BY_NAME.get(normalize(name)) ?? null;
}

/** True when a folder is named like a library ("movies", "Serien", "Kinder"). */
export function isLibraryFolderName(name: string): boolean {
    const n = normalize(name);
    return TYPE_BY_NAME.has(n) || UNTYPED.has(n);
}

/** True for an audiobook folder ("Audiobooks", "Hörbücher"), which is no library candidate. */
export function isAudiobookFolderName(name: string): boolean {
    return AUDIOBOOKS.has(normalize(name));
}
