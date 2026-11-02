// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Sql } from 'postgres';
import type { z } from 'zod';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import type { PlaybackProgress } from '$lib/schemas/api-playback-progress.js';
import type { SearchResultItem, SuggestItem } from '$lib/server/services/search.service.js';
import type { SearchResultItemSchema } from './search-item.schemas.js';
import { isCatalogUuid } from '$lib/server/services/media-handle.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/resolver.js';

type SearchPreview = z.infer<typeof SearchResultItemSchema>;
type Input = Omit<SearchResultItem, 'progress' | 'rank'> & {
    progress?: PlaybackProgress;
    rank?: number;
};

/** Shape after cache reads: ranking and the cache remain independent of presentation. */
export async function searchPreviews(
    sql: Sql,
    surface: ApiSurface,
    rows: Input[],
): Promise<SearchPreview[]> {
    const imageItems = rows.flatMap((row) => [
        { id: row.id, mediaType: row.type },
        ...[...(row.artists ?? []), ...(row.remixerArtists ?? [])].flatMap((artist) =>
            artist.id ? [{ id: artist.id, mediaType: 'artist' }] : [],
        ),
    ]);
    const images = await resolveImageSets(sql, surface, imageItems);
    const artistPreview = (artist: { id?: string; title: string }) =>
        artist.id
            ? [
                  {
                      id: artist.id,
                      catalogId: isCatalogUuid(artist.id) ? artist.id : null,
                      type: 'artist' as const,
                      ids: {},
                      title: artist.title,
                      images: images.get(artist.id) ?? {},
                  },
              ]
            : [];
    return rows.map((row) => {
        const ids = Object.fromEntries(
            Object.entries(row.ids).filter(([key]) => key !== 'internal'),
        );
        const catalogId = isCatalogUuid(row.id) ? row.id : null;
        // Auxiliary sources' cover routes are outside the catalog image resolver.
        const cover = catalogId === null ? row.images.poster?.href : undefined;
        const resolvedImages = images.get(row.id) ?? {};
        return {
            id: row.id,
            catalogId,
            type: row.type,
            ids,
            title: row.title,
            matchedTitle: row.matchedTitle,
            year: row.year,
            overview: row.overview,
            images:
                Object.keys(resolvedImages).length || catalogId !== null
                    ? resolvedImages
                    : cover
                      ? {
                            poster: {
                                href: cover,
                                variants: { full: cover },
                                revision: cover,
                                source: 'self' as const,
                            },
                        }
                      : {},
            score: row.rank,
            reason: row.matchSource ? { kind: row.matchSource } : undefined,
            progress: row.progress,
            availability:
                row.isAvailable === undefined
                    ? undefined
                    : {
                          isAvailable: row.isAvailable,
                          canRequest: !row.isAvailable,
                      },
            context:
                row.seriesId || row.seasonNumber !== undefined || row.episodeNumber !== undefined
                    ? {
                          ...(row.seriesId
                              ? {
                                    series: {
                                        id: row.seriesId,
                                        catalogId: isCatalogUuid(row.seriesId)
                                            ? row.seriesId
                                            : null,
                                        title: row.seriesName ?? '',
                                    },
                                }
                              : {}),
                          seasonNumber: row.seasonNumber,
                          episodeNumber: row.episodeNumber,
                      }
                    : undefined,
            durationMs: row.duration === undefined ? undefined : Math.round(row.duration * 1000),
            subtitle: row.artist ?? row.author,
            artistId: row.artistId,
            artist: row.artist,
            albumId: row.albumId,
            album: row.album,
            artists: row.artists?.flatMap(artistPreview),
            remixerArtists: row.remixerArtists?.flatMap(artistPreview),
            requestMediaType: row.requestMediaType,
            libraryId: row.libraryId,
            author: row.author,
        };
    });
}

export async function suggestPreviews(
    sql: Sql,
    surface: ApiSurface,
    rows: SuggestItem[],
): Promise<SearchPreview[]> {
    return searchPreviews(
        sql,
        surface,
        rows.map((row) => ({
            ...row,
            type: row.mediaType,
            ids: row.ids ?? {},
            rank: undefined,
            matchSource: '',
        })),
    );
}
