// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Strip audiobook chapter/file lists from LIST-surface media items.
 *
 * `customMetadata.audiobookshelf.chapters` and `.audioFiles` are per-chapter /
 * per-file arrays the AudiobookShelf sync writes onto
 * `media_items.custom_metadata` (see `media-sources/_helpers/audiobookshelf/
 * sweep.ts`). A single in-progress audiobook can carry hundreds of entries in
 * each array — on prod, removing just these two arrays from one Continue
 * Watching row shrank `/__data.json` from 177 KB to 19 KB.
 *
 * No list surface renders them: `HeroSection` reads only `authors` /
 * `narrators` off `customMetadata.audiobookshelf`, and the audiobook PLAYER
 * rebuilds its own chapter timeline from the play session's `audioTracks`,
 * never from a list item's `customMetadata`. Every other `audiobookshelf`
 * field (authors, narrators, series, …) is left untouched.
 *
 * IMPORTANT — apply this ONLY at internal, page/endpoint-boundary seams (the
 * homepage load, `/browse`'s load, `/api/recommendations`,
 * `/api/for-you/watching`, and — per a later task — `/browse`'s genre rows).
 * Never call this from `section-builder.ts`, `effective-watching.service.ts`,
 * or any other module that also feeds `/api/v1/*` or a media-detail response
 * — those must stay byte-identical, and detail views / the player legitimately
 * need the full arrays. Mirrors `trimSectionOverviews` in
 * `src/routes/+page.server.ts`, which trims rail `overview` text at the same
 * kind of boundary for the same reason.
 */

import type { PageSection } from '$lib/types/server-driven-ui.js';

/**
 * Drop `chapters` / `audioFiles` from a `customMetadata.audiobookshelf` blob,
 * keeping every other field. Returns the SAME reference when there is nothing
 * to strip (no `customMetadata`, no `audiobookshelf`, or neither array
 * present), so callers can cheaply detect "unchanged".
 */
export function stripAudiobookListArraysFromMetadata(
    customMetadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
    if (!customMetadata) return customMetadata;
    const audiobookshelf = customMetadata.audiobookshelf;
    if (!audiobookshelf || typeof audiobookshelf !== 'object' || Array.isArray(audiobookshelf)) {
        return customMetadata;
    }
    const shelf = audiobookshelf as Record<string, unknown>;
    if (!('chapters' in shelf) && !('audioFiles' in shelf)) return customMetadata;

    const restShelf: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(shelf)) {
        if (key === 'chapters' || key === 'audioFiles') continue;
        restShelf[key] = value;
    }

    return { ...customMetadata, audiobookshelf: restShelf };
}

/**
 * Apply {@link stripAudiobookListArraysFromMetadata} to one list item (a rail
 * card, a hero slide, or any other object carrying an optional
 * `customMetadata` field). Generic over the item shape so it works for
 * `UniversalMediaItem`, `HeroFirstSlide`, and ad-hoc response objects alike.
 */
export function stripAudiobookListArraysFromItem<
    T extends { customMetadata?: Record<string, unknown> | null },
>(item: T): T {
    const stripped = stripAudiobookListArraysFromMetadata(item.customMetadata);
    if (stripped === item.customMetadata) return item;
    return { ...item, customMetadata: stripped ?? undefined } as T;
}

/**
 * Apply {@link stripAudiobookListArraysFromItem} across every item of every
 * section — the shape `buildWatchingSections()` returns.
 */
export function stripAudiobookListArraysFromSections(sections: PageSection[]): PageSection[] {
    return sections.map((section) => ({
        ...section,
        items: section.items.map(stripAudiobookListArraysFromItem),
    }));
}
