// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import {
    calendarEventImageUrl,
    calendarModalImageUrl,
    type CalendarImageSource,
} from './calendar-image';
vi.mock('$lib/paths', () => ({ url: (path: string) => path }));

const episode: CalendarImageSource = {
    id: 'tmdb:123:series',
    catalogId: null,
    type: 'episode',
    ids: {},
    title: 'Special',
    context: {
        series: { id: 'tmdb:123:series', catalogId: null, title: 'Show' },
        seasonNumber: 0,
        episodeNumber: 1,
    },
    images: {
        thumb: {
            href: '/api/media/show/images/backdrop',
            variants: { card: '/api/media/show/images/backdrop?size=card' },
            source: 'series',
            revision: '1',
        },
    },
    monitored: true,
    hasFile: false,
};

describe('calendar descriptor artwork', () => {
    it('uses inherited descriptor variants for specials and discovery rows', () => {
        expect(calendarEventImageUrl(episode)).toBe('/api/media/show/images/backdrop?size=card');
        expect(calendarModalImageUrl(episode)).toBe('/api/media/show/images/backdrop?size=card');
    });
    it('omits artwork when no descriptor exists', () => {
        expect(calendarEventImageUrl({ ...episode, images: {} })).toBe('');
    });
});
