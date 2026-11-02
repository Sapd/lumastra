// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { MediaPreview, MediaPreviewContext } from '$lib/schemas/api-media-preview.js';
import {
    buildPlaybackProgress,
    type PlaybackProgressInput,
} from '$lib/schemas/api-playback-progress.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain.js';
import { buildPreviewIdentity, isCatalogUuid } from './media-handle.js';
import { resolveImageSets } from './image-descriptor/resolver.js';

/** Normalized producer input. Internal rows stay private to their owning service. */
export interface MediaPreviewInput {
    id?: string | null;
    type: string;
    ids?: Record<string, unknown> | null;
    title: string;
    subtitle?: string;
    year?: number | null;
    overview?: string | null;
    rating?: number | null;
    genres?: string[];
    durationMs?: number | null;
    score?: number;
    reason?: MediaPreview['reason'];
    context?: MediaPreviewContext;
    progress?: PlaybackProgressInput;
    lastPlayedAt?: string;
    isAvailable?: boolean;
    canRequest?: boolean;
    hasFile?: boolean;
}

/** Pure mapping; null means no resolvable identity and the caller must drop the row. */
export function buildMediaPreview(
    input: MediaPreviewInput,
    images: ImageSet = {},
): MediaPreview | null {
    const type = toPublicMediaType(input.type);
    if (!type) return null;
    const ids = Object.fromEntries(
        Object.entries(input.ids ?? {})
            .filter(([key, value]) => key !== 'internal' && value != null)
            .map(([key, value]) => [key, String(value)]),
    );
    const discoveryHandle = /^tmdb:([1-9]\d*):(movie|series)$/.exec(input.id ?? '');
    const identity = buildPreviewIdentity({
        uuid: isCatalogUuid(input.id)
            ? input.id
            : typeof input.ids?.internal === 'string'
              ? input.ids.internal
              : null,
        provider: 'tmdb',
        providerId: ids.tmdb ?? (discoveryHandle?.[2] === type ? discoveryHandle[1] : undefined),
        type,
    });
    // Upcoming episodes without a catalog row use the resolvable series handle.
    const episodeIdentity =
        type === 'episode' && input.context?.series
            ? buildPreviewIdentity({
                  uuid: input.context.series.catalogId,
                  provider: 'tmdb',
                  providerId: /^tmdb:([1-9]\d*):series$/.exec(input.context.series.id)?.[1],
                  type: 'series',
              })
            : null;
    const resolved =
        identity ?? (episodeIdentity ? { id: episodeIdentity.id, catalogId: null } : null);
    if (!resolved) return null;
    return {
        ...resolved,
        type,
        ids,
        title: input.title,
        images,
        ...(input.subtitle !== undefined && { subtitle: input.subtitle }),
        ...(input.year != null && { year: input.year }),
        ...(input.overview != null && { overview: input.overview }),
        ...(input.rating != null && { rating: input.rating }),
        ...(input.genres && { genres: input.genres }),
        ...(input.durationMs != null && { durationMs: input.durationMs }),
        ...(input.score !== undefined && { score: input.score }),
        ...(input.reason && { reason: input.reason }),
        ...(input.context && { context: input.context }),
        ...(input.lastPlayedAt && { lastPlayedAt: input.lastPlayedAt }),
        ...(input.progress && { progress: buildPlaybackProgress(input.progress) }),
        availability: {
            isAvailable: input.isAvailable ?? resolved.catalogId !== null,
            canRequest: input.canRequest ?? false,
            ...(input.hasFile !== undefined && { hasFile: input.hasFile }),
        },
    };
}

/** One artwork query for an entire page, including inherited episode artwork. */
export async function buildMediaPreviews(
    sql: postgres.Sql,
    surface: ApiSurface,
    inputs: MediaPreviewInput[],
    userId?: string,
): Promise<MediaPreview[]> {
    const previews = inputs
        .map((input) => buildMediaPreview(input))
        .filter((item): item is MediaPreview => item !== null);
    const images = await resolveImageSets(
        sql,
        surface,
        previews.map((item) => ({
            id: item.id,
            mediaType: item.type,
        })),
    );
    if (userId && previews.some((item) => item.catalogId !== null)) {
        const rows = await sql<
            Array<{
                media_id: string;
                resume_position_ms: number | null;
                runtime_ms: number | null;
                is_watched: boolean;
                last_event_at: Date | null;
            }>
        >`
            SELECT uws.media_id, uws.resume_position_ms, uws.runtime_ms, uws.is_watched, uws.last_event_at
            FROM user_media_state uws WHERE uws.user_id = ${userId}::uuid
              AND uws.media_id = ANY(${previews.flatMap((item) =>
                  item.catalogId ? [item.catalogId] : [],
              )}::uuid[])`;
        const progressById = new Map(rows.map((row) => [row.media_id, row]));
        for (const item of previews) {
            const state = progressById.get(item.id);
            if (state && !item.progress) {
                item.progress = buildPlaybackProgress({
                    positionMs:
                        state.resume_position_ms == null ? null : Number(state.resume_position_ms),
                    durationMs: state.runtime_ms == null ? null : Number(state.runtime_ms),
                    finished: state.is_watched,
                    updatedAt: state.last_event_at,
                });
            }
        }
    }
    const built = previews.map((item) => {
        const set = images.get(item.id) ?? {};
        if (item.type === 'episode' && item.catalogId === null && set.thumb) {
            return {
                ...item,
                images: { ...set, thumb: { ...set.thumb, source: 'series' as const } },
            };
        }
        return { ...item, images: set };
    });
    return decorateAudiobooks(sql, surface, built, userId);
}

/**
 * Audiobook items carry the shared `audiobook` block (people and series refs),
 * ISBN/ASIN in `ids` and the cover. The ids were already admitted by the caller's
 * access filter. A failed decoration leaves the plain preview rather than failing the page.
 */
async function decorateAudiobooks(
    sql: postgres.Sql,
    surface: ApiSurface,
    items: MediaPreview[],
    userId: string | undefined,
): Promise<MediaPreview[]> {
    const ids = items.flatMap((item) =>
        item.type === 'audiobook' && item.catalogId ? [item.catalogId] : [],
    );
    if (ids.length === 0) return items;
    const { audiobookPreviewsForAdmittedIds } =
        await import('$lib/server/database/queries/audiobook-catalog.queries.js');
    const books = await audiobookPreviewsForAdmittedIds(sql, ids, userId ?? null, surface).catch(
        () => [],
    );
    const byId = new Map(books.map((book) => [book.id, book]));
    return items.map((item) => {
        const book = item.type === 'audiobook' && item.catalogId ? byId.get(item.catalogId) : undefined;
        if (!book) return item;
        return {
            ...item,
            ids: { ...item.ids, ...book.ids },
            images: book.images,
            ...(book.subtitle ? { subtitle: book.subtitle } : {}),
            ...(book.audiobook ? { audiobook: book.audiobook } : {}),
            ...(item.progress ?? book.progress ? { progress: item.progress ?? book.progress } : {}),
        };
    });
}

/** Adapter for existing recommendation strategies; paging remains with the strategy. */
export async function recommendationPreviews(
    sql: postgres.Sql,
    surface: ApiSurface,
    items: Array<{
        media: {
            id: string;
            type: string;
            title: string;
            ids: Record<string, string>;
            year?: number | null;
            overview?: string;
            rating?: number;
            genres?: string[];
            durationMs?: number;
            seriesId?: string;
            seriesName?: string;
            seasonNumber?: number;
            episodeNumber?: number;
        };
        progress?: PlaybackProgressInput;
        score?: number;
        reason?: { kind: string; label?: string; seed?: string };
        isAvailable?: boolean;
        canRequest?: boolean;
        durationSeconds?: number;
        positionSeconds?: number;
        lastPlayedAt?: string;
    }>,
): Promise<MediaPreview[]> {
    return buildMediaPreviews(
        sql,
        surface,
        items.map((item) => {
            const watching = ['continue-watching', 'next-up', 'watchlist'].includes(
                item.reason?.kind ?? '',
            );
            const media = item.media;
            return {
                ...media,
                isAvailable: item.isAvailable,
                canRequest: item.canRequest,
                score: watching ? undefined : item.score,
                reason: item.reason,
                lastPlayedAt: item.lastPlayedAt,
                ...(item.progress && { progress: item.progress }),
                ...(media.seriesId && {
                    context: {
                        series: {
                            id: media.seriesId,
                            catalogId:
                                buildPreviewIdentity({ uuid: media.seriesId, type: 'series' })
                                    ?.catalogId ?? null,
                            title: media.seriesName ?? '',
                        },
                        seasonNumber: media.seasonNumber,
                        episodeNumber: media.episodeNumber,
                    },
                }),
                ...(watching && {
                    progress: item.progress ?? {
                        positionMs:
                            item.positionSeconds == null
                                ? null
                                : Math.round(item.positionSeconds * 1000),
                        durationMs:
                            item.durationSeconds == null
                                ? null
                                : Math.round(item.durationSeconds * 1000),
                        fraction: item.reason?.kind === 'continue-watching' ? item.score : undefined,
                        updatedAt: item.lastPlayedAt,
                    },
                }),
            };
        }),
    );
}
