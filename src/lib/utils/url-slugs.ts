// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { isAudiobook, isEpisode, isMovie, isSeries } from '$lib/utils/media-types';

export type TitleSlugKind = 'movie' | 'tv' | 'album' | 'artist' | 'actor' | 'audiobook';

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Pick the `?slug=` prefix for a media modal from a RAW media type.
 *
 * Shared by both modal-URL writers (`modal-url-sync.ts` on a card click,
 * `modal-utils.ts` on a deep-link restore) because they had two hand-rolled
 * copies of this three-way and drifted: an audiobook came out as
 * `slug=movie-milo-farrow-…` on prod. One copy even read an already-collapsed
 * `'movie' | 'tv' | 'episode'` value, so its `isAudiobook()` arm was
 * unreachable — a shipped fix that provably did nothing.
 *
 * MUST be given the raw type (any case convention), never the output of a
 * narrowing/normalizing step. Everything that is not a series or an audiobook
 * falls back to 'movie', which is what the slug vocabulary has always done —
 * the slug is cosmetic, the `?modal=<uuid>` param is what resolves.
 */
export function slugKindForMediaType(mediaType: string | null | undefined): TitleSlugKind {
    if (isSeries(mediaType)) return 'tv';
    if (isAudiobook(mediaType)) return 'audiobook';
    return 'movie';
}

function slugifySegment(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
}

function formatEpisodeToken(seasonNumber: number, episodeNumber: number): string {
    return `s${String(seasonNumber).padStart(2, '0')}e${String(episodeNumber).padStart(2, '0')}`;
}

export function buildTitleSlug(
    kind: TitleSlugKind,
    title: string | null | undefined,
): string | null {
    const normalized = title?.trim();
    if (!normalized) return null;

    const slug = slugifySegment(normalized);
    return slug ? `${kind}-${slug}` : kind;
}

export function buildEpisodeSlug(
    seriesTitle: string | null | undefined,
    seasonNumber: number,
    episodeNumber: number,
): string {
    const base = buildTitleSlug('tv', seriesTitle) ?? 'tv';
    return `${base}-${formatEpisodeToken(seasonNumber, episodeNumber)}`;
}

export function buildWatchSlug(input: {
    mediaType: string;
    title: string;
    seriesTitle?: string | null;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
}): string | null {
    if (isEpisode(input.mediaType) && input.seasonNumber != null && input.episodeNumber != null) {
        return buildEpisodeSlug(
            input.seriesTitle ?? input.title,
            input.seasonNumber,
            input.episodeNumber,
        );
    }

    if (isMovie(input.mediaType)) {
        return buildTitleSlug('movie', input.title);
    }

    if (isSeries(input.mediaType)) {
        return buildTitleSlug('tv', input.title);
    }

    return null;
}
