// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { toPublicMediaType } from '$lib/shared/media-type-domain';
export interface TmdbContext {
    seriesTmdbId?: string | number | null;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
}
export function tmdbIdentityUrl(
    type: string,
    id: string | number | null | undefined,
    context: TmdbContext = {},
): string | null {
    type = toPublicMediaType(type) ?? type;
    const valid = (value: unknown): boolean =>
        typeof value === 'number'
            ? Number.isSafeInteger(value) && value > 0
            : typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
    const base = 'https://www.themoviedb.org';
    if (type === 'movie') return valid(id) ? `${base}/movie/${id}` : null;
    if (type === 'series') return valid(id) ? `${base}/tv/${id}` : null;
    if (type !== 'season' && type !== 'episode') return null;
    const season = context.seasonNumber;
    if (
        !valid(context.seriesTmdbId) ||
        season == null ||
        !Number.isSafeInteger(season) ||
        season < 0
    )
        return null;
    const url = `${base}/tv/${context.seriesTmdbId}/season/${season}`;
    return type === 'season'
        ? url
        : valid(context.episodeNumber)
          ? `${url}/episode/${context.episodeNumber}`
          : null;
}
