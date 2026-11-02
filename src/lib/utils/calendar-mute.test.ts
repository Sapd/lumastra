// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { calendarContextActions, calendarMuteIdentity } from './calendar-mute';
import type { CalendarImageSource } from './calendar-image';
const episode: CalendarImageSource = {
    id: 'episode-id',
    catalogId: 'episode-id',
    ids: {},
    type: 'episode',
    title: 'Special',
    images: {},
    context: {
        series: { id: 'series-id', catalogId: 'series-id', title: 'Show' },
        seasonNumber: 0,
        episodeNumber: 1,
    },
};

describe('calendarMuteIdentity', () => {
    it('mutes the parent catalog series for an episode including specials', () => {
        expect(calendarMuteIdentity(episode, false)).toEqual({
            mediaId: 'series-id',
            mediaType: 'series',
        });
    });
    it('uses a movie catalog id, or its external tmdb id for discovery', () => {
        expect(calendarMuteIdentity({ ...episode, type: 'movie' }, true)).toEqual({
            mediaId: 'episode-id',
            mediaType: 'movie',
        });
        expect(
            calendarMuteIdentity({ ...episode, catalogId: null, ids: { tmdb: '123' } }, true),
        ).toEqual({ tmdbId: 123, mediaType: 'movie' });
    });
    it('mutes a not-in-library episode by the TMDB id inside its series handle', () => {
        const discovery = {
            ...episode,
            context: {
                ...episode.context!,
                series: { id: 'tmdb:4242:series', catalogId: null, title: 'Show' },
            },
        };
        expect(calendarMuteIdentity(discovery, false)).toEqual({
            tmdbId: 4242,
            mediaType: 'series',
        });
        expect(calendarContextActions(discovery, false)).toEqual({
            mute: { tmdbId: 4242, mediaType: 'series' },
            follow: false,
        });
        // a movie handle never keys a series mute
        const wrongType = {
            ...discovery,
            context: {
                ...discovery.context!,
                series: { ...discovery.context!.series!, id: 'tmdb:4242:movie' },
            },
        };
        expect(calendarMuteIdentity(wrongType, false)).toBeNull();
    });
    it('offers follow only for a catalog series, and nothing for an unresolvable entry', () => {
        expect(calendarContextActions(episode, false).follow).toBe(true);
        expect(
            calendarContextActions({ ...episode, catalogId: null, context: undefined }, false),
        ).toEqual({ mute: null, follow: false });
    });
    it('does not mistake a discovery handle for a library UUID', () => {
        expect(
            calendarMuteIdentity({ ...episode, catalogId: null, context: undefined }, false),
        ).toBeNull();
    });
});
