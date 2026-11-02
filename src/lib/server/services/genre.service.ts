// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Genre Service
 *
 * Unified genre handling service that consolidates genre mapping logic
 * previously duplicated across multiple files
 */

export interface GenreInfo {
    id: number;
    name: string;
}

import { isMovie, isSeries } from '../utils/media-types.js';

/**
 * Centralized Genre Service
 * Eliminates duplicate genre mapping across recommendations, AI, and transform files
 */
export class GenreService {
    // Movie genres from TMDB
    private static readonly MOVIE_GENRES: Record<number, string> = {
        28: 'Action',
        12: 'Adventure',
        16: 'Animation',
        35: 'Comedy',
        80: 'Crime',
        99: 'Documentary',
        18: 'Drama',
        10751: 'Family',
        14: 'Fantasy',
        36: 'History',
        27: 'Horror',
        10402: 'Music',
        9648: 'Mystery',
        10749: 'Romance',
        878: 'Science Fiction',
        10770: 'TV Movie',
        53: 'Thriller',
        10752: 'War',
        37: 'Western',
    };

    // TV show genres from TMDB
    private static readonly TV_GENRES: Record<number, string> = {
        10759: 'Action & Adventure',
        16: 'Animation',
        35: 'Comedy',
        80: 'Crime',
        99: 'Documentary',
        18: 'Drama',
        10751: 'Family',
        10762: 'Kids',
        9648: 'Mystery',
        10763: 'News',
        10764: 'Reality',
        10765: 'Sci-Fi & Fantasy',
        10766: 'Soap',
        10767: 'Talk',
        10768: 'War & Politics',
        37: 'Western',
    };

    // Combined genre lookup for fallback
    private static readonly ALL_GENRES: Record<number, string> = {
        ...GenreService.MOVIE_GENRES,
        ...GenreService.TV_GENRES,
    };

    // Reverse lookup maps for name -> ID conversion
    private static readonly MOVIE_NAME_TO_ID: Record<string, number> = {};
    private static readonly TV_NAME_TO_ID: Record<string, number> = {};
    private static readonly ALL_NAME_TO_ID: Record<string, number> = {};

    // Initialize reverse lookups
    static {
        // Build reverse lookup maps
        Object.entries(GenreService.MOVIE_GENRES).forEach(([id, name]) => {
            GenreService.MOVIE_NAME_TO_ID[name.toLowerCase()] = Number.parseInt(id);
            GenreService.ALL_NAME_TO_ID[name.toLowerCase()] = Number.parseInt(id);
        });

        Object.entries(GenreService.TV_GENRES).forEach(([id, name]) => {
            GenreService.TV_NAME_TO_ID[name.toLowerCase()] = Number.parseInt(id);
            GenreService.ALL_NAME_TO_ID[name.toLowerCase()] = Number.parseInt(id);
        });
    }

    /**
     * Get genre name by ID for movies
     */
    static getMovieGenreName(genreId: number): string {
        return GenreService.MOVIE_GENRES[genreId] || 'Unknown';
    }

    /**
     * Get genre name by ID for TV shows
     */
    static getTVGenreName(genreId: number): string {
        return GenreService.TV_GENRES[genreId] || 'Unknown';
    }

    /**
     * Get genre name by ID with media type detection
     */
    static getGenreName(genreId: number, mediaType?: 'movie' | 'tv'): string {
        if (mediaType && isMovie(mediaType)) {
            return GenreService.getMovieGenreName(genreId);
        } else if (mediaType && isSeries(mediaType)) {
            return GenreService.getTVGenreName(genreId);
        }

        // Fallback: try movie first, then TV, then combined
        return GenreService.MOVIE_GENRES[genreId] || GenreService.TV_GENRES[genreId] || 'Unknown';
    }

    /**
     * Get genre ID by name
     */
    static getGenreId(genreName: string, mediaType?: 'movie' | 'tv'): number | undefined {
        const normalizedName = genreName.toLowerCase();

        if (mediaType && isMovie(mediaType)) {
            return GenreService.MOVIE_NAME_TO_ID[normalizedName];
        } else if (mediaType && isSeries(mediaType)) {
            return GenreService.TV_NAME_TO_ID[normalizedName];
        }

        return GenreService.ALL_NAME_TO_ID[normalizedName];
    }

    /**
     * Get all movie genres as array
     */
    static getAllMovieGenres(): GenreInfo[] {
        return Object.entries(GenreService.MOVIE_GENRES).map(([id, name]) => ({
            id: Number.parseInt(id),
            name,
        }));
    }

    /**
     * Get all TV genres as array
     */
    static getAllTVGenres(): GenreInfo[] {
        return Object.entries(GenreService.TV_GENRES).map(([id, name]) => ({
            id: Number.parseInt(id),
            name,
        }));
    }

    /**
     * Get all genres (combined) as array
     */
    static getAllGenres(): GenreInfo[] {
        return Object.entries(GenreService.ALL_GENRES).map(([id, name]) => ({
            id: Number.parseInt(id),
            name,
        }));
    }

    /**
     * Convert array of genre IDs to GenreInfo objects
     */
    static convertGenreIds(genreIds: number[], mediaType?: 'movie' | 'tv'): GenreInfo[] {
        return genreIds
            .map((id) => ({
                id,
                name: GenreService.getGenreName(id, mediaType),
            }))
            .filter((genre) => genre.name !== 'Unknown');
    }

    /**
     * Convert array of genre names to GenreInfo objects
     */
    static convertGenreNames(genreNames: string[], mediaType?: 'movie' | 'tv'): GenreInfo[] {
        return genreNames
            .map((name) => {
                const id = GenreService.getGenreId(name, mediaType);
                return id ? { id, name } : null;
            })
            .filter((genre): genre is GenreInfo => genre !== null);
    }

    /**
     * Normalize genre array from various sources
     */
    static normalizeGenres(
        genres?: string[] | GenreInfo[] | number[] | { id: number; name: string }[] | null,
        mediaType?: 'movie' | 'tv',
    ): GenreInfo[] {
        if (!genres || !Array.isArray(genres)) return [];

        // Handle different input formats
        if (genres.length === 0) return [];

        const firstItem = genres[0];

        // Array of GenreInfo objects
        if (typeof firstItem === 'object' && 'id' in firstItem && 'name' in firstItem) {
            return genres as GenreInfo[];
        }

        // Array of genre IDs
        if (typeof firstItem === 'number') {
            return GenreService.convertGenreIds(genres as number[], mediaType);
        }

        // Array of genre names
        if (typeof firstItem === 'string') {
            return GenreService.convertGenreNames(genres as string[], mediaType);
        }

        return [];
    }

    /**
     * Get genre names as string array
     */
    static getGenreNames(genres: GenreInfo[]): string[] {
        return genres.map((genre) => genre.name);
    }

    /**
     * Get genre IDs as number array
     */
    static getGenreIds(genres: GenreInfo[]): number[] {
        return genres.map((genre) => genre.id);
    }

    /**
     * Filter genres by media type compatibility
     */
    static filterByMediaType(genres: GenreInfo[], mediaType: 'movie' | 'tv'): GenreInfo[] {
        const validIds = isMovie(mediaType)
            ? Object.keys(GenreService.MOVIE_GENRES).map(Number)
            : Object.keys(GenreService.TV_GENRES).map(Number);

        return genres.filter((genre) => validIds.includes(genre.id));
    }

    /**
     * Get popular genres for a media type
     */
    static getPopularGenres(mediaType: 'movie' | 'tv', limit = 10): GenreInfo[] {
        // Predefined popular genres based on TMDB data
        const popularMovieIds = [28, 35, 18, 878, 53, 27, 10749, 16, 12, 14];
        const popularTVIds = [18, 35, 80, 10759, 9648, 10765, 10764, 99, 16, 10767];

        const genreIds = isMovie(mediaType) ? popularMovieIds : popularTVIds;

        return genreIds
            .slice(0, limit)
            .map((id) => ({
                id,
                name: GenreService.getGenreName(id, mediaType),
            }))
            .filter((genre) => genre.name !== 'Unknown');
    }

    /**
     * Search genres by name (fuzzy matching)
     */
    static searchGenres(query: string, mediaType?: 'movie' | 'tv'): GenreInfo[] {
        const normalizedQuery = query.toLowerCase();
        const allGenres =
            mediaType && isMovie(mediaType)
                ? GenreService.getAllMovieGenres()
                : mediaType && isSeries(mediaType)
                  ? GenreService.getAllTVGenres()
                  : GenreService.getAllGenres();

        return allGenres
            .filter(
                (genre) =>
                    genre.name.toLowerCase().includes(normalizedQuery) ||
                    genre.name.toLowerCase().startsWith(normalizedQuery),
            )
            .sort((a, b) => {
                // Prioritize exact matches and starts-with matches
                const aStartsWith = a.name.toLowerCase().startsWith(normalizedQuery);
                const bStartsWith = b.name.toLowerCase().startsWith(normalizedQuery);

                if (aStartsWith && !bStartsWith) return -1;
                if (!aStartsWith && bStartsWith) return 1;

                return a.name.localeCompare(b.name);
            });
    }

    /**
     * Calculate genre similarity between two arrays
     */
    static calculateGenreSimilarity(genres1: GenreInfo[], genres2: GenreInfo[]): number {
        if (!genres1.length || !genres2.length) return 0;

        const ids1 = new Set(genres1.map((g) => g.id));
        const ids2 = new Set(genres2.map((g) => g.id));

        const intersection = new Set([...ids1].filter((id) => ids2.has(id)));
        const union = new Set([...ids1, ...ids2]);

        return union.size > 0 ? intersection.size / union.size : 0;
    }

    /**
     * Get complementary genres (genres that often appear together)
     */
    static getComplementaryGenres(genreId: number, mediaType?: 'movie' | 'tv'): GenreInfo[] {
        // Predefined complementary genre relationships
        const complementaryPairs: Record<number, number[]> = {
            // Action often pairs with Adventure, Thriller, Crime
            28: [12, 53, 80],
            // Comedy often pairs with Romance, Family
            35: [10749, 10751],
            // Drama often pairs with Romance, Crime, Mystery
            18: [10749, 80, 9648],
            // Horror often pairs with Thriller, Mystery
            27: [53, 9648],
            // Sci-Fi often pairs with Action, Adventure, Thriller
            878: [28, 12, 53],
            // Fantasy often pairs with Adventure, Family
            14: [12, 10751],
            // Romance often pairs with Comedy, Drama
            10749: [35, 18],
            // Crime often pairs with Drama, Thriller, Action
            80: [18, 53, 28],
        };

        const complementaryIds = complementaryPairs[genreId] || [];

        return complementaryIds
            .map((id) => ({
                id,
                name: GenreService.getGenreName(id, mediaType),
            }))
            .filter((genre) => genre.name !== 'Unknown');
    }

    /**
     * Validate genre data integrity
     */
    static validateGenre(genre: unknown): genre is GenreInfo {
        return !!(
            genre &&
            typeof genre === 'object' &&
            typeof (genre as GenreInfo).id === 'number' &&
            typeof (genre as GenreInfo).name === 'string' &&
            (genre as GenreInfo).id > 0 &&
            (genre as GenreInfo).name.length > 0
        );
    }

    /**
     * Clean and validate genre array
     */
    static cleanGenreArray(genres: unknown[]): GenreInfo[] {
        return genres.filter(GenreService.validateGenre).filter(
            (genre, index, self) =>
                // Remove duplicates by ID
                index === self.findIndex((g) => g.id === genre.id),
        );
    }
}

// Export singleton instance for convenience
export const genreService = GenreService;
