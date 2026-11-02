// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browse Live TV by category ("genre"): the chip bar on /livetv narrows the
 * grid and the guide to one category, addressed in the URL as `?genre=<slug>`.
 */

import type { LiveTvCategory, LiveTvStation } from '$lib/schemas/livetv.js';

export const GENRE_PARAM = 'genre';
export const GENRE_STORAGE_KEY = 'livetv:genre';

/** "Live Events" -> "live-events", "24/7" -> "24-7", "Детские" -> "детские". */
export function genreSlug(name: string): string {
    return (
        name
            .toLowerCase()
            .normalize('NFKD')
            .replace(/\p{M}+/gu, '')
            .replace(/[^\p{L}\p{N}]+/gu, '-')
            .replace(/^-+|-+$/g, '') || 'category'
    );
}

export interface GenreChip {
    slug: string;
    name: string;
    count: number;
    /** A channel logo of the category, like the page's category rail shows. */
    imageUrl?: string;
}

/** One chip per category that has channels, in category order. */
export function buildGenreChips(
    channels: readonly LiveTvStation[],
    categories: readonly LiveTvCategory[],
): GenreChip[] {
    const counts: Record<string, number> = {};
    const logos: Record<string, string> = {};
    for (const ch of channels) {
        if (!ch.categoryId) continue;
        counts[ch.categoryId] = (counts[ch.categoryId] ?? 0) + 1;
        // Only the server's own image proxy (a same-origin path): a viewer's
        // browser never fetches a provider's URL directly.
        if (
            ch.images?.primary?.href?.startsWith('/') &&
            !ch.images?.primary?.href.startsWith('//') &&
            !logos[ch.categoryId]
        ) {
            logos[ch.categoryId] = ch.images?.primary?.href;
        }
    }
    // Names that slug alike ("Orb", "ORB") share one chip; filterByGenre
    // selects them together by the same slug.
    const chips: GenreChip[] = [];
    const bySlug: Record<string, GenreChip> = {};
    for (const c of [...categories].sort((a, b) => a.sortOrder - b.sortOrder)) {
        const count = counts[c.id] ?? 0;
        if (count === 0) continue;
        const slug = genreSlug(c.name);
        const existing = bySlug[slug];
        if (existing) {
            existing.count += count;
            existing.imageUrl ??= logos[c.id];
        } else {
            chips.push((bySlug[slug] = { slug, name: c.name, count, imageUrl: logos[c.id] }));
        }
    }
    return chips;
}

/**
 * The channels and categories of one genre, or everything for no/unknown slug
 * (a stale link or a removed category falls back to the full list).
 */
export function filterByGenre(
    channels: LiveTvStation[],
    categories: LiveTvCategory[],
    slug: string | null,
): { channels: LiveTvStation[]; categories: LiveTvCategory[]; active: boolean } {
    if (!slug) return { channels, categories, active: false };
    const ids = new Set(categories.filter((c) => genreSlug(c.name) === slug).map((c) => c.id));
    if (ids.size === 0) return { channels, categories, active: false };
    return {
        channels: channels.filter((ch) => ch.categoryId !== undefined && ids.has(ch.categoryId)),
        categories: categories.filter((c) => ids.has(c.id)),
        active: true,
    };
}
