// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search Result Transformers
 *
 * Utilities for transforming search results into UI-ready formats.
 * Extracted from Search.svelte to improve testability and reusability.
 */

import { pickVariantUrl } from '$lib/utils/image-utils.js';
import type { SearchResultItem as V1SearchResultItem } from '$lib/api/content';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
import type { UniversalMediaType } from '$lib/schemas/api-responses';
import { MatchSourceSchema } from '$lib/schemas/api-responses';
import type { ExternalIds } from '$lib/types/api-common';
import { url } from '$lib/paths';
import * as m from '$lib/paraglide/messages';
import { secondaryTitle } from './matched-title';

/**
 * Map v1 API type discriminator to UI media type string.
 * 'series' -> 'tv' (UI category key)
 */
export function v1TypeToUiMediaType(type: V1SearchResultItem['type']): string {
    if (type === 'series') return 'tv';
    // The cross-entity 'request' type maps to the legacy 'anfragen' UI media type
    // (the open-handler dispatch map + SearchCategory are keyed on 'anfragen').
    if (type === 'request') return 'anfragen';
    return type;
}

/**
 * Highlight search terms in a text snippet.
 * Escapes HTML and wraps matching terms with <mark> tags.
 *
 * @param text - The text to highlight
 * @param query - The search query
 * @returns HTML string with highlighted terms
 *
 * @example
 * highlightSearchTerms('The Silent Beacon', 'silent')
 * // 'The <mark class="...">Silent</mark> Beacon'
 */
export function highlightSearchTerms(text: string, query: string): string {
    if (!text) return text;

    // Escape HTML entities first
    const escapeHtml = (str: string) =>
        str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

    const escapedText = escapeHtml(text);

    if (!query) return escapedText;

    // Extract search terms (split by whitespace, filter short terms)
    const terms = query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length >= 2)
        .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); // Escape regex chars

    if (terms.length === 0) return escapedText;

    // Build regex to match any term (case insensitive)
    const regex = new RegExp(`(${terms.join('|')})`, 'gi');

    // Replace matches with highlighted version
    return escapedText.replace(
        regex,
        '<mark class="bg-primary-500/40 text-white px-0.5 rounded">$1</mark>',
    );
}

/**
 * Build a subtitle for a search result item.
 * Handles different media types (episodes, movies, series).
 *
 * The year is deliberately NOT part of the subtitle: the list-variant card
 * already renders `item.year` in its metadata row, and including it here
 * showed the year twice on every movie/series result.
 *
 * Book/manga/comic rows show the author instead, when one is present.
 *
 * @param item - The v1 search result item
 * @returns Formatted subtitle string (e.g., "Series Name • S1 E3")
 */
export function buildSubtitle(item: V1SearchResultItem): string {
    const matched = secondaryTitle(item.matchedTitle, item.title);
    const parts: string[] = matched ? [matched] : [];

    if (item.type === 'episode' && item.context?.series?.title) {
        parts.push(item.context?.series?.title);
        if (item.context?.seasonNumber != null && item.context?.episodeNumber != null) {
            parts.push(`S${item.context?.seasonNumber} E${item.context?.episodeNumber}`);
        }
    } else if (
        (item.type === 'book' || item.type === 'manga' || item.type === 'comic') &&
        item.author
    ) {
        parts.push(m.search_by_author({ author: item.author }));
    }

    return parts.join(' • ');
}

/**
 * Transform a v1 search result item into a UniversalMediaItem for rendering.
 *
 * @param item - The v1 search result from API
 * @param query - The search query (for highlighting match snippets)
 * @returns UniversalMediaItem ready for card rendering
 */
export function descriptionExcerpt(overview: string, query: string): string {
    const text = overview.replace(/\s+/g, ' ').trim();
    const positions = query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length >= 2)
        .map((term) => text.toLowerCase().indexOf(term))
        .filter((position) => position >= 0);
    const position = positions.length ? Math.min(...positions) : 0;
    let start = Math.max(0, position - 45);
    if (start > 0) {
        const boundary = text.indexOf(' ', start);
        if (boundary >= 0 && boundary < position) start = boundary + 1;
    }
    let end = Math.min(text.length, start + 160);
    if (end < text.length) {
        const boundary = text.lastIndexOf(' ', end);
        if (boundary > position) end = boundary;
    }
    return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function transformSearchItem(item: V1SearchResultItem, query: string): UniversalMediaItem {
    const uiMediaType = v1TypeToUiMediaType(item.type);
    const isMusic = item.type === 'track' || item.type === 'album' || item.type === 'artist';
    const externalIds: ExternalIds = { ...item.ids, internal: item.catalogId ?? undefined };
    const descriptor = item.images.poster ?? item.images.thumb ?? item.images.primary;
    const image = descriptor ? url(pickVariantUrl(descriptor, 'thumb')) : '';
    const isCatalogVideo = [
        'movie',
        'series',
        'episode',
        'home_video',
        'training',
        'educational',
        'personal',
    ].includes(item.type);
    // Auxiliary sources may omit availability; catalog video needs an explicit signal.
    const isAvailable = item.availability?.isAvailable ?? !isCatalogVideo;

    return {
        // Music card actions use item.id directly for queues, ratings and playback.
        id: isMusic ? (item.catalogId ?? item.id) : `search-${item.id}`,
        externalIds,
        mediaType: uiMediaType as UniversalMediaType,
        title: item.title,
        subtitle: buildSubtitle(item),
        image,
        overview: item.overview || '',
        matchSource: MatchSourceSchema.safeParse(item.reason?.kind).data,
        matchSnippet:
            item.reason?.kind === 'overview' && item.overview
                ? descriptionExcerpt(item.overview, query)
                : undefined,
        isAvailable,
        hasFiles: item.availability?.hasFile ?? item.availability?.isAvailable ?? false,
        progress: item.progress?.fraction != null ? item.progress.fraction * 100 : undefined,
        canRequest:
            (item.availability?.canRequest ?? false) &&
            (item.type === 'movie' || item.type === 'series'),
        year: item.year,
        durationMs: item.durationMs,
        artists: item.artists,
        remixerArtists: item.remixerArtists,
        isPlayed: item.progress?.finished,
        // Episode-specific fields
        seasonNumber: item.context?.seasonNumber,
        episodeNumber: item.context?.episodeNumber,
        seriesName: item.context?.series?.title,
        seriesId: item.context?.series?.id,
        // Store original item data for event handling. requestMediaType is
        // surfaced at the top of clickData because handleAnfragenOpen reads it
        // directly (clickData.requestMediaType) to pick the request modal type.
        clickData: {
            originalItem: item,
            mediaType: uiMediaType,
            ...(isMusic ? { artistId: item.artistId, albumId: item.albumId } : {}),
            ...(item.requestMediaType ? { requestMediaType: item.requestMediaType } : {}),
        },
    };
}
