// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { CalendarImageSource } from './calendar-image';

/** The identifiers `POST /api/upcoming/exclude` accepts, besides the display name. */
export type MuteIdentity = { mediaType: 'series' | 'movie' } & (
    | {
          /** Catalog series (episodes) or movie `media_items.id`. */
          mediaId: string;
          tmdbId?: undefined;
      }
    | {
          mediaId?: undefined;
          /** TMDB id of a monitored-only row; scoped by `mediaType`. */
          tmdbId: number;
      }
);

/**
 * Which id mutes a calendar entry: the catalog UUID when it has one (the parent
 * series for an episode, the movie itself otherwise), else its TMDB id. An
 * entry with neither cannot be muted: titles are never a key, so this is null.
 */
export function calendarMuteIdentity(
    item: CalendarImageSource,
    isMovieItem: boolean,
): MuteIdentity | null {
    const mediaType = isMovieItem ? 'movie' : 'series';
    const mediaId = isMovieItem ? item.catalogId : item.context?.series?.catalogId;
    if (mediaId) return { mediaId, mediaType };
    // 0 is the arr payloads' "no id"; the server only accepts a positive id.
    const handle = isMovieItem ? item.id : item.context?.series?.id;
    const tmdbId = Number(item.ids.tmdb) || tmdbIdFromHandle(handle, mediaType);
    if (tmdbId > 0) return { tmdbId, mediaType };
    return null;
}

/**
 * A not-in-library episode carries no `ids` of its own: its series is only the
 * discovery handle `tmdb:<id>:series` (see `buildPreviewIdentity`). The TMDB id
 * inside that handle is a real id, so it keys the mute.
 */
function tmdbIdFromHandle(handle: string | undefined, mediaType: 'series' | 'movie'): number {
    const match = /^tmdb:([1-9]\d*):(movie|series)$/.exec(handle ?? '');
    return match && match[2] === mediaType ? Number(match[1]) : 0;
}

/** What the calendar context menu may offer for an entry. No action = no menu. */
export function calendarContextActions(
    item: CalendarImageSource,
    isMovieItem: boolean,
): { mute: MuteIdentity | null; follow: boolean } {
    const series = item.context?.series;
    return {
        mute: calendarMuteIdentity(item, isMovieItem),
        // Following keys on the catalog series UUID, never a discovery handle.
        follow: !isMovieItem && Boolean(series?.catalogId && series.title),
    };
}
