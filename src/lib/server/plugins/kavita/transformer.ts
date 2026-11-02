// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Kavita Data Transformer
 *
 * Transforms Kavita API responses to unified dashboard MediaItem format
 */

import type { MediaItem } from '$lib/server/types.js';
import type {
    SearchResultGroupDto,
    SearchResultDto,
    CollectionTagDto,
    ReadingListDto,
    PersonDto,
    MangaFormat,
} from './types.js';
import { type SeriesMetadataDto } from './client.js';

/**
 * Map MangaFormat enum to human-readable string
 */
export function formatLabel(format: MangaFormat): string {
    switch (format) {
        case 0:
            return 'Image';
        case 1:
            return 'Archive';
        case 2:
            return 'Unknown';
        case 3:
            return 'EPUB';
        case 4:
            return 'PDF';
        default:
            return 'Unknown';
    }
}

/**
 * Map library name to media type
 * This is a heuristic based on common library naming conventions
 */
export function inferMediaType(
    libraryName?: string,
    format?: MangaFormat,
): 'book' | 'manga' | 'comic' {
    const name = (libraryName || '').toLowerCase();

    // Check library name for hints
    if (name.includes('manga') || name.includes('manhua') || name.includes('manhwa')) {
        return 'manga';
    }
    if (name.includes('comic') || name.includes('comics')) {
        return 'comic';
    }
    if (
        name.includes('book') ||
        name.includes('novel') ||
        name.includes('light novel') ||
        name.includes('bücher') ||
        name.includes('buch') ||
        name.includes('ebook') ||
        name.includes('literatur')
    ) {
        return 'book';
    }

    // Check format - EPUB/PDF are typically books
    if (format === 3 || format === 4) {
        // EPUB or PDF
        return 'book';
    }

    // Default to BOOK for unknown
    return 'book';
}

/**
 * Strip HTML tags and clean up text for display
 */
function stripHtml(html: string): string {
    return html
        .replaceAll(/<[^>]*>/g, ' ') // Remove HTML tags
        .replaceAll('&nbsp;', ' ') // Replace nbsp
        .replaceAll('&amp;', '&') // Replace ampersand
        .replaceAll('&lt;', '<') // Replace less than
        .replaceAll('&gt;', '>') // Replace greater than
        .replaceAll('&quot;', '"') // Replace quotes
        .replaceAll('&#39;', "'") // Replace apostrophe
        .replaceAll(/\s+/g, ' ') // Collapse whitespace
        .trim();
}

/**
 * Get first N sentences from text
 */
function getFirstSentences(text: string, count: number = 2): string {
    const cleaned = stripHtml(text);
    // Match sentences ending with . ! or ?
    const sentences = cleaned.match(/[^.!?]*[.!?]/g);
    if (!sentences) return cleaned.slice(0, 200);
    return sentences.slice(0, count).join(' ').trim();
}

/**
 * Transform a Kavita series search result to MediaItem
 */
export function transformSeriesResult(
    series: SearchResultDto,
    metadata?: SeriesMetadataDto,
): MediaItem {
    const mediaType = inferMediaType(series.libraryName, series.format);

    // Build description from metadata summary or localized name
    let description: string | undefined;
    if (metadata?.summary) {
        description = getFirstSentences(metadata.summary, 2);
    } else if (series.localizedName && series.localizedName !== series.name) {
        description = series.localizedName;
    }

    // Get author from metadata writers
    const author = metadata?.writers?.[0]?.name;

    return {
        id: `kavita-series-${series.seriesId}`,
        title: series.name,
        overview: description,
        author,
        // Kavita reports 0 for an unknown release year — `|| undefined` drops it.
        year: metadata?.releaseYear || undefined,
        mediaType,
        studio: series.libraryName,
        imageUrl: `/api/image/kavita/series/${series.seriesId}`,
        // Kavita-specific fields for URL construction
        libraryId: series.libraryId,
        isAvailable: true, // Content is in Kavita, so it's available
    };
}

/**
 * Transform a Kavita collection to MediaItem
 */
export function transformCollectionResult(collection: CollectionTagDto): MediaItem {
    return {
        id: `kavita-collection-${collection.id}`,
        title: collection.title,
        overview: collection.summary,
        mediaType: 'book', // Collections are generic
        imageUrl: `/api/image/kavita/collection/${collection.id}`,
        isAvailable: true,
    };
}

/**
 * Transform a Kavita reading list to MediaItem
 */
export function transformReadingListResult(readingList: ReadingListDto): MediaItem {
    return {
        id: `kavita-readinglist-${readingList.id}`,
        title: readingList.title,
        overview: readingList.summary,
        mediaType: 'book', // Reading lists are generic
        imageUrl: `/api/image/kavita/readinglist/${readingList.id}`,
        isAvailable: true,
    };
}

/**
 * Transform a Kavita person (author/artist) to MediaItem
 */
export function transformPersonResult(person: PersonDto): MediaItem {
    return {
        id: `kavita-person-${person.id}`,
        title: person.name,
        overview: person.role,
        mediaType: 'book', // Persons are associated with books
        author: person.name,
        imageUrl: `/api/image/kavita/person/${person.id}`,
        isAvailable: true,
    };
}

/**
 * Transform full Kavita search results to MediaItem array
 * @param results - Search results from Kavita API
 * @param metadataMap - Optional map of series ID to metadata (for summaries)
 */
export function transformSearchResults(
    results: SearchResultGroupDto,
    metadataMap?: Map<number, SeriesMetadataDto>,
): MediaItem[] {
    const items: MediaItem[] = [];

    // Transform series (primary results)
    if (results.series?.length) {
        for (const series of results.series) {
            const metadata = metadataMap?.get(series.seriesId);
            items.push(transformSeriesResult(series, metadata));
        }
    }

    // Transform collections
    if (results.collections?.length) {
        for (const collection of results.collections) {
            items.push(transformCollectionResult(collection));
        }
    }

    // Transform reading lists
    if (results.readingLists?.length) {
        for (const readingList of results.readingLists) {
            items.push(transformReadingListResult(readingList));
        }
    }

    // Transform persons (authors/artists) - optional, might be noisy
    // Uncomment if you want author search results
    // if (results.persons?.length) {
    //     for (const person of results.persons) {
    //         items.push(transformPersonResult(person));
    //     }
    // }

    return items;
}

/**
 * Get the total count of search results
 */
export function getSearchResultCount(results: SearchResultGroupDto): number {
    return (
        (results.series?.length ?? 0) +
        (results.collections?.length ?? 0) +
        (results.readingLists?.length ?? 0)
    );
}
