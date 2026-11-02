// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { LiveTvStation, LiveTvAiring } from '$lib/schemas/livetv.js';
import {
    DISC_COLORS,
    buildSimpleLineup,
    discColor,
    initials,
    findByNumber,
    nowNext,
    pickStartChannel,
    progressPercent,
    stepChannel,
} from './simple-lineup.js';

function channel(id: string, name: string, currentProgram?: LiveTvAiring): LiveTvStation {
    return {
        id,
        feedId: id,
        name,
        images: {},
        isVisible: true,
        sortOrder: 0,
        nowNext: { current: currentProgram ?? null, next: null },
    };
}

function program(id: string, start: string, end: string, title = id): LiveTvAiring {
    return { id, stationId: 'c', title, startTime: start, endTime: end };
}

const lineup = buildSimpleLineup(
    ['b', 'gone', 'a', 'c'],
    [channel('a', 'Nordwelle'), channel('b', 'Kanal Sieben'), channel('c', 'Sonnenland TV')],
);

describe('buildSimpleLineup', () => {
    it('keeps the helper order, skips missing channels and numbers from 1', () => {
        expect(lineup.map((c) => [c.number, c.channel.id])).toEqual([
            [1, 'b'],
            [2, 'a'],
            [3, 'c'],
        ]);
    });
});

describe('stepChannel', () => {
    it('zaps up and down and wraps around like a TV', () => {
        expect(stepChannel(lineup, 'b', 1)?.channel.id).toBe('a');
        expect(stepChannel(lineup, 'c', 1)?.channel.id).toBe('b');
        expect(stepChannel(lineup, 'b', -1)?.channel.id).toBe('c');
    });
    it('steps into the lineup from a channel that is not in it', () => {
        expect(stepChannel(lineup, 'other', 1)?.number).toBe(1);
        expect(stepChannel(lineup, 'other', -1)?.number).toBe(3);
        expect(stepChannel([], 'b', 1)).toBeUndefined();
    });
});

describe('findByNumber / pickStartChannel', () => {
    it('finds a typed channel number', () => {
        expect(findByNumber(lineup, 3)?.channel.id).toBe('c');
        expect(findByNumber(lineup, 9)).toBeUndefined();
    });
    it('prefers the last watched channel, then the start channel, then channel 1', () => {
        expect(pickStartChannel(lineup, 'c', 'a')?.channel.id).toBe('a');
        expect(pickStartChannel(lineup, 'c', 'gone')?.channel.id).toBe('c');
        expect(pickStartChannel(lineup, undefined, null)?.channel.id).toBe('b');
    });
});

describe('nowNext', () => {
    const now = Date.parse('2026-10-16T20:30:00Z');
    it('finds now and next from guide programmes in any order', () => {
        const result = nowNext(
            [
                program('late', '2026-10-16T22:00:00Z', '2026-10-16T23:00:00Z'),
                program('next', '2026-10-16T21:00:00Z', '2026-10-16T22:00:00Z'),
                program('now', '2026-10-16T20:00:00Z', '2026-10-16T21:00:00Z'),
            ],
            now,
        );
        expect(result.now?.id).toBe('now');
        expect(result.next?.id).toBe('next');
    });
    it("falls back to the channel's current programme and returns nothing without a guide", () => {
        const current = program('cur', '2026-10-16T20:00:00Z', '2026-10-16T21:00:00Z');
        expect(nowNext(undefined, now, { current, next: null })).toEqual({ now: current, next: undefined });
        expect(nowNext([], now)).toEqual({ now: undefined, next: undefined });
    });
    it('rejects future fallback as current and promotes it at the half-open boundary', () => {
        const future = program('future', '2026-10-16T21:00:00Z', '2026-10-16T22:00:00Z');
        const fallback = { current: future, next: null };
        expect(nowNext(undefined, now, fallback)).toEqual({ now: undefined, next: future });
        expect(nowNext(undefined, Date.parse(future.startTime), fallback)).toEqual({ now: future, next: undefined });
        expect(nowNext(undefined, Date.parse(future.endTime), fallback)).toEqual({ now: undefined, next: undefined });
    });
    it('uses the fallback current during a guide gap and keeps the guide next', () => {
        const current = program('current', '2026-10-16T20:00:00Z', '2026-10-16T21:00:00Z');
        const ended = program('ended', '2026-10-16T19:00:00Z', '2026-10-16T20:00:00Z');
        const next = program('next', '2026-10-16T21:00:00Z', '2026-10-16T22:00:00Z');
        expect(nowNext([ended, next], now, { current, next: null })).toEqual({
            now: current, next,
        });
    });
    it('shows the next programme during a gap', () => {
        const result = nowNext(
            [program('next', '2026-10-16T21:00:00Z', '2026-10-16T22:00:00Z')],
            now,
        );
        expect(result).toEqual({ now: undefined, next: expect.objectContaining({ id: 'next' }) });
    });
});

describe('progressPercent', () => {
    it('is clamped to 0..100', () => {
        const p = program('p', '2026-10-16T20:00:00Z', '2026-10-16T21:00:00Z');
        expect(progressPercent(p, Date.parse('2026-10-16T20:30:00Z'))).toBe(50);
        expect(progressPercent(p, Date.parse('2026-10-16T19:00:00Z'))).toBe(0);
        expect(progressPercent(p, Date.parse('2026-10-16T22:00:00Z'))).toBe(100);
    });
});

describe('discColor', () => {
    it('is stable per name and from the palette', () => {
        expect(discColor('Nordwelle')).toBe(discColor('Nordwelle'));
        expect(DISC_COLORS).toContain(discColor('Kanal Sieben'));
    });
});

describe('initials', () => {
    it('takes two letters from one or two words', () => {
        expect(initials('Kanal Sieben')).toBe('KS');
        expect(initials('Nordwelle')).toBe('NO');
        expect(initials('Nachrichten 24')).toBe('N2');
        expect(initials('  ')).toBe('?');
    });
});
