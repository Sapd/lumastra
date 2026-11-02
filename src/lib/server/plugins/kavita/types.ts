// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Kavita API Types
 *
 * Based on Kavita OpenAPI schema
 * https://raw.githubusercontent.com/Kareadita/Kavita/develop/openapi.json
 */

// ============================================================================
// Enums
// ============================================================================

export enum MangaFormat {
    Image = 0,
    Archive = 1,
    Unknown = 2,
    Epub = 3,
    Pdf = 4,
}

export enum LibraryType {
    Manga = 0,
    Comic = 1,
    Book = 2,
    Images = 3,
    LightNovel = 4,
    ComicVine = 5,
}

export enum PublicationStatus {
    Ongoing = 0,
    Hiatus = 1,
    Completed = 2,
    Cancelled = 3,
    Ended = 4,
}

// ============================================================================
// API Response Types
// ============================================================================

export interface KavitaAuthResponse {
    token: string;
    refreshToken?: string;
    apiKey?: string;
    username?: string;
}

export interface LibraryDto {
    id: number;
    name: string;
    type: LibraryType;
    coverImage?: string;
}

export interface SeriesDto {
    id: number;
    name: string;
    originalName?: string;
    localizedName?: string;
    sortName?: string;
    summary?: string;
    pages: number;
    pagesRead: number;
    userRating: number;
    format: MangaFormat;
    created: string;
    lastChapterAdded: string;
    libraryId: number;
    libraryName?: string;
    coverImageLocked: boolean;
    localCoverImagePath?: string;
    // Additional fields
    wordCount?: number;
    minHoursToRead?: number;
    maxHoursToRead?: number;
    avgHoursToRead?: number;
    folderPath?: string;
    lastFolderScanned?: string;
    publicationStatus?: PublicationStatus;
}

export interface SearchResultDto {
    seriesId: number;
    name: string;
    originalName?: string;
    sortName?: string;
    localizedName?: string;
    format: MangaFormat;
    libraryName?: string;
    libraryId: number;
}

export interface PersonDto {
    id: number;
    name: string;
    role?: string;
}

export interface GenreTagDto {
    id: number;
    title: string;
}

export interface TagDto {
    id: number;
    title: string;
}

export interface CollectionTagDto {
    id: number;
    title: string;
    summary?: string;
    coverImage?: string;
    coverImageLocked: boolean;
    promoted: boolean;
    source?: number;
}

export interface ReadingListDto {
    id: number;
    title: string;
    summary?: string;
    promoted: boolean;
    coverImageLocked: boolean;
}

export interface ChapterDto {
    id: number;
    range?: string;
    number?: string;
    pages: number;
    isSpecial: boolean;
    title?: string;
    volumeId: number;
    pagesRead: number;
    coverImage?: string;
    created: string;
    releaseDate?: string;
    summary?: string;
    wordCount?: number;
    minHoursToRead?: number;
    maxHoursToRead?: number;
}

export interface MangaFileDto {
    id: number;
    filePath: string;
    pages: number;
    format: MangaFormat;
    created: string;
}

export interface BookmarkDto {
    id: number;
    page: number;
    volumeId: number;
    seriesId: number;
    chapterId: number;
}

export interface UserReviewDto {
    seriesId: number;
    libraryId: number;
    score: number;
    tagline?: string;
    body?: string;
}

/**
 * Main search response from /api/Search/search
 */
export interface SearchResultGroupDto {
    libraries: LibraryDto[];
    series: SearchResultDto[];
    collections: CollectionTagDto[];
    readingLists: ReadingListDto[];
    persons: PersonDto[];
    genres: GenreTagDto[];
    tags: TagDto[];
    files: MangaFileDto[];
    chapters: ChapterDto[];
    bookmarks: BookmarkDto[];
    annotations: UserReviewDto[];
}

// ============================================================================
// Internal Types (for the plugin)
// ============================================================================

export interface KavitaClientConfig {
    baseUrl: string;
    apiKey: string;
}

export interface KavitaSearchOptions {
    query: string;
    includeChapterAndFiles?: boolean;
}

/**
 * Unified search result item for dashboard integration
 */
export interface KavitaSearchItem {
    id: number;
    type: 'series' | 'collection' | 'readingList' | 'person';
    name: string;
    originalName?: string;
    format: MangaFormat;
    formatLabel: string;
    libraryId: number;
    libraryName?: string;
    libraryType?: LibraryType;
    summary?: string;
    coverUrl?: string;
}
