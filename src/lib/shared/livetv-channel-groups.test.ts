// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { LiveTvStation } from '$lib/schemas/livetv.js';
import { groupNumberedFamilies, isChannelFamily } from './livetv-channel-groups';

function makeChannel(
    overrides: Partial<LiveTvStation> & { id: string; name: string },
): LiveTvStation {
    return {
        feedId: overrides.id,
        images: {},
        sortOrder: 0,
        isVisible: true,
        nowNext: { current: null, next: null },
        ...overrides,
    };
}

function makeNumberedChannels(
    prefix: string,
    count: number,
    withEpgIndices: number[] = [],
): LiveTvStation[] {
    return Array.from({ length: count }, (_, i) => {
        const num = i + 1;
        const channel = makeChannel({
            id: `${prefix}-${num}`,
            feedId: `${prefix}-${num}`,
            name: `${prefix} ${num}`,
            sortOrder: num,
        });
        if (withEpgIndices.includes(num)) {
            channel.nowNext.current = {
                id: `prog-${prefix}-${num}`,
                stationId: channel.id,
                title: `Live Match ${num}`,
                startTime: '2026-07-10T10:00:00Z',
                endTime: '2026-07-10T12:00:00Z',
            };
        }
        return channel;
    });
}

describe('groupNumberedFamilies', () => {
    it('collapses a run of numbered channels into a single family', () => {
        const channels = makeNumberedChannels('ZAVO EVENT', 6);

        const { items } = groupNumberedFamilies(channels);

        expect(items).toHaveLength(1);
        const [family] = items;
        expect(isChannelFamily(family)).toBe(true);
        if (isChannelFamily(family)) {
            expect(family.label).toBe('ZAVO EVENT');
            expect(family.channels).toHaveLength(6);
        }
    });

    it('keeps channels with real EPG data outside the collapsed family', () => {
        const channels = makeNumberedChannels('Telesport Extra', 8, [3, 5]);

        const { items } = groupNumberedFamilies(channels);

        // 2 individual (EPG) channels + 1 family item for the remaining 6
        expect(items).toHaveLength(3);

        const individuals = items.filter((item) => !isChannelFamily(item)) as LiveTvStation[];
        expect(individuals.map((c) => c.name).sort()).toEqual([
            'Telesport Extra 3',
            'Telesport Extra 5',
        ]);

        const family = items.find(isChannelFamily);
        expect(family?.channels).toHaveLength(6);
        expect(family?.channels.some((c) => c.name === 'Telesport Extra 3')).toBe(false);
        expect(family?.channels.some((c) => c.name === 'Telesport Extra 5')).toBe(false);
    });

    it('does not collapse when fewer than minSize EPG-less members remain', () => {
        // 5 channels total, but 3 have EPG data — only 2 collapsible, below default minSize (5)
        const channels = makeNumberedChannels('EIS2', 5, [1, 2, 3]);

        const { items } = groupNumberedFamilies(channels);

        expect(items).toHaveLength(5);
        expect(items.every((item) => !isChannelFamily(item))).toBe(true);
    });

    it('respects a custom minSize', () => {
        const channels = makeNumberedChannels('News Feed', 3);

        expect(groupNumberedFamilies(channels).items).toHaveLength(3);
        expect(groupNumberedFamilies(channels).items.some(isChannelFamily)).toBe(false);

        const { items } = groupNumberedFamilies(channels, 3);
        expect(items).toHaveLength(1);
        expect(isChannelFamily(items[0])).toBe(true);
    });

    it('leaves non-numbered channel names untouched', () => {
        const channels = [
            makeChannel({ id: 'c1', feedId: 'c1', name: 'VDD' }),
            makeChannel({ id: 'c2', feedId: 'c2', name: 'VELO' }),
            makeChannel({ id: 'c3', feedId: 'c3', name: 'WBN News' }),
        ];

        const { items } = groupNumberedFamilies(channels);

        expect(items).toEqual(channels);
    });

    it('does not treat a short prefix (< 3 chars) as a family', () => {
        const channels = Array.from({ length: 6 }, (_, i) =>
            makeChannel({ id: `a${i + 1}`, feedId: `a${i + 1}`, name: `A ${i + 1}` }),
        );

        const { items } = groupNumberedFamilies(channels);

        expect(items).toEqual(channels);
    });

    it('orders family members numerically regardless of input order', () => {
        const shuffled = [1, 10, 2, 9, 3, 8, 4].map((num) =>
            makeChannel({
                id: `s${num}`,
                feedId: `s${num}`,
                name: `sportvista.TV EIS2 ${num}`,
                sortOrder: num,
            }),
        );

        const { items } = groupNumberedFamilies(shuffled);

        const family = items.find(isChannelFamily);
        expect(family).toBeDefined();
        expect(family?.channels.map((c) => c.name)).toEqual([
            'sportvista.TV EIS2 1',
            'sportvista.TV EIS2 2',
            'sportvista.TV EIS2 3',
            'sportvista.TV EIS2 4',
            'sportvista.TV EIS2 8',
            'sportvista.TV EIS2 9',
            'sportvista.TV EIS2 10',
        ]);
    });

    it('places the family item at the position of the first collapsed member', () => {
        const channels = [
            makeChannel({ id: 'lead', feedId: 'lead', name: 'WBN One' }),
            ...makeNumberedChannels('ZAVO EVENT', 6),
            makeChannel({ id: 'trail', feedId: 'trail', name: 'WBN Two' }),
        ];

        const { items } = groupNumberedFamilies(channels);

        expect(items).toHaveLength(3);
        expect(isChannelFamily(items[0])).toBe(false);
        expect(isChannelFamily(items[1])).toBe(true);
        expect(isChannelFamily(items[2])).toBe(false);
    });

    it('collapses slots whose number is followed by a note or a quality tag', () => {
        const channels = [
            ...Array.from({ length: 5 }, (_, i) =>
                makeChannel({
                    id: `a-${i + 1}`,
                    feedId: `a-${i + 1}`,
                    name: `Korira+ ${i + 1} [EVENT ONLY]`,
                }),
            ),
            ...Array.from({ length: 5 }, (_, i) =>
                makeChannel({
                    id: `b-${i + 1}`,
                    feedId: `b-${i + 1}`,
                    name: `Velo Event ${i + 1} FHD (LIVE ON MATCH)`,
                }),
            ),
        ];

        const { items } = groupNumberedFamilies(channels);

        expect(items).toHaveLength(2);
        expect(items.map((item) => (isChannelFamily(item) ? item.label : item.name))).toEqual([
            'Korira+',
            'Velo Event',
        ]);
    });
});
