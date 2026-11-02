// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TMDB Genre ID to Name Mapping
 *
 * Used for generating human-readable recommendation reasons
 * and filtering content by genre.
 *
 * @see https://developers.themoviedb.org/3/genres/get-movie-list
 */
import * as m from '$lib/paraglide/messages';

export const TMDB_GENRE_MAP: Record<number, string> = {
    28: m.genre_action(),
    12: m.genre_adventure(),
    16: m.genre_animation(),
    35: m.genre_comedy(),
    80: m.genre_crime(),
    99: m.genre_documentary(),
    18: m.genre_drama(),
    10751: m.genre_family(),
    14: m.genre_fantasy(),
    36: m.genre_history(),
    27: m.genre_horror(),
    10402: m.genre_music(),
    9648: m.genre_mystery(),
    10749: m.genre_romance(),
    878: m.genre_scifi(),
    53: m.genre_thriller(),
    10752: m.genre_war(),
    37: m.genre_western(),
};

function getGenreName(id: number): string {
    switch (id) {
        case 28:
            return m.genre_action();
        case 12:
            return m.genre_adventure();
        case 16:
            return m.genre_animation();
        case 35:
            return m.genre_comedy();
        case 80:
            return m.genre_crime();
        case 99:
            return m.genre_documentary();
        case 18:
            return m.genre_drama();
        case 10751:
            return m.genre_family();
        case 14:
            return m.genre_fantasy();
        case 36:
            return m.genre_history();
        case 27:
            return m.genre_horror();
        case 10402:
            return m.genre_music();
        case 9648:
            return m.genre_mystery();
        case 10749:
            return m.genre_romance();
        case 878:
            return m.genre_scifi();
        case 53:
            return m.genre_thriller();
        case 10752:
            return m.genre_war();
        case 37:
            return m.genre_western();
        default:
            return m.genre_unknown();
    }
}

/**
 * Get genre names from genre IDs.
 *
 * @param genreIds - Array of TMDB genre IDs
 * @returns Array of genre names (excludes 'Unknown')
 *
 * @example
 * const names = getGenreNames([28, 878]); // ['Action', 'Sci-Fi']
 */
export function getGenreNames(genreIds: number[]): string[] {
    return genreIds.map((id) => getGenreName(id)).filter((name) => name !== m.genre_unknown());
}
