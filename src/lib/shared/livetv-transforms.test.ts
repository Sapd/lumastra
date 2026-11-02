// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import {
    isOffAirProgram,
    formatRemainingTime,
    liveTvChannelToUniversalItem,
    orderFavoritesFirst,
} from './livetv-transforms.js';

vi.mock('$lib/paraglide/messages.js', () => ({
    livetv_remaining_m: ({ minutes }: { minutes: number }) => `${minutes}m`,
    livetv_remaining_hm: ({ hours, minutes }: { hours: number; minutes: number }) =>
        `${hours}h ${minutes}m`,
}));

describe('isOffAirProgram', () => {
    it('matches known off-air titles case-insensitively', () => {
        expect(isOffAirProgram('Sendepause')).toBe(true);
        expect(isOffAirProgram('SENDEPAUSE')).toBe(true);
        expect(isOffAirProgram('sendeschluss')).toBe(true);
        expect(isOffAirProgram('No Programming')).toBe(true);
        expect(isOffAirProgram('no program')).toBe(true);
        expect(isOffAirProgram('Off Air')).toBe(true);
        expect(isOffAirProgram('off-air')).toBe(true);
        expect(isOffAirProgram('Pause')).toBe(true);
    });

    it('matches with surrounding whitespace trimmed', () => {
        expect(isOffAirProgram('  Sendepause  ')).toBe(true);
    });

    it('does not match real show titles that merely contain a keyword', () => {
        expect(isOffAirProgram('Pause for Thought')).toBe(false);
        expect(isOffAirProgram('The Off Air Show')).toBe(false);
        expect(isOffAirProgram('Breaking News')).toBe(false);
    });

    it('returns false for undefined/null/empty titles', () => {
        expect(isOffAirProgram(undefined)).toBe(false);
        expect(isOffAirProgram(null)).toBe(false);
        expect(isOffAirProgram('')).toBe(false);
    });
});

describe('formatRemainingTime', () => {
    it('formats minutes-only under 90 minutes', () => {
        expect(formatRemainingTime(1)).toBe('1m');
        expect(formatRemainingTime(89)).toBe('89m');
    });

    it('formats hours and minutes at or above 90 minutes', () => {
        expect(formatRemainingTime(90)).toBe('1h 30m');
        expect(formatRemainingTime(1182)).toBe('19h 42m');
    });

    it('formats exact hour boundaries', () => {
        expect(formatRemainingTime(120)).toBe('2h 0m');
    });
});

describe('station card identity', () => {
    it('keeps watch and preview identity stable when the shown feed differs', () => {
        const item = liveTvChannelToUniversalItem({
            id: 'station',
            feedId: 'shown-feed',
            images: {},
            name: 'News',
            sortOrder: 0,
            isVisible: true,
            nowNext: { current: null, next: null },
        });
        expect(item.id).toBe('station');
        expect(item.externalIds?.internal).toBe('station');
        expect(item.nativeStreamUrl).toBe('/api/livetv/stations/station');
    });
});

describe('orderFavoritesFirst', () => {
    const byId = (entry: { id: string }) => entry.id;
    const entries = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

    it('puts favorites first in favorite order and keeps the rest in place', () => {
        expect(orderFavoritesFirst(entries, ['d', 'b'], byId).map(byId)).toEqual([
            'd',
            'b',
            'a',
            'c',
        ]);
    });

    it('ignores favorites that are not in the list', () => {
        expect(orderFavoritesFirst(entries, ['x', 'c'], byId).map(byId)).toEqual([
            'c',
            'a',
            'b',
            'd',
        ]);
    });

    it('keeps every feed of a favorite station together', () => {
        const feeds = [
            { id: 'f1', station: 's1' },
            { id: 'f2', station: 's2' },
            { id: 'f3', station: 's2' },
        ];
        expect(orderFavoritesFirst(feeds, ['s2'], (f) => f.station).map(byId)).toEqual([
            'f2',
            'f3',
            'f1',
        ]);
    });
});
