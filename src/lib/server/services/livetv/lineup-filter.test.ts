// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    isChannelKept,
    parseLineupFilter,
    type LineupChannel,
    type LineupFilter,
} from './lineup-filter';
import type { NoiseKind } from './lineup-noise';

const filter = (over: Partial<LineupFilter> = {}): LineupFilter => ({
    countries: [],
    includeUntagged: true,
    hideLoopChannels: false,
    hideInfoChannels: false,
    hideEventSlots: false,
    hideLocalStations: false,
    hideRadio: false,
    hiddenCategories: [],
    ...over,
});
const ch = (
    title: string,
    country_code: string | null,
    category_name: string | null = null,
    id = title,
): LineupChannel => ({
    id,
    title,
    country_code,
    category_name,
});

describe('isChannelKept', () => {
    it('keeps everything without countries, categories or the 24/7 switch', () => {
        expect(isChannelKept(ch('RO: Pro TV', 'ro'), filter())).toBe(true);
        expect(isChannelKept(ch('24/7 • Seabright', null), filter())).toBe(true);
    });

    it('keeps the selected countries and drops the rest (DE + AT + UK + US)', () => {
        const f = filter({ countries: ['de', 'at', 'uk', 'us'] });
        expect(isChannelKept(ch('US: VDD', 'us'), f)).toBe(true);
        expect(isChannelKept(ch('AT: OSK 1', 'at'), f)).toBe(true);
        expect(isChannelKept(ch('RO: Pro TV', 'ro'), f)).toBe(false);
        expect(isChannelKept(ch('TR: KZK 1', 'tr'), f)).toBe(false);
        expect(isChannelKept(ch('PORNDECK: X', 'adult'), f)).toBe(false);
        expect(isChannelKept(ch('ISLAM: QURAN', 'religious'), f)).toBe(false);
    });

    it('decides untagged channels by includeUntagged', () => {
        expect(isChannelKept(ch('Nordwelle FHD', null), filter({ countries: ['de'] }))).toBe(true);
        expect(
            isChannelKept(
                ch('Nordwelle FHD', null),
                filter({ countries: ['de'], includeUntagged: false }),
            ),
        ).toBe(false);
    });

    it('keeps the members of a selected region', () => {
        const f = filter({ countries: ['exyu'] });
        expect(isChannelKept(ch('SRB: PLV 1', 'rs'), f)).toBe(true);
        expect(isChannelKept(ch('EXY: ZEO', 'exyu'), f)).toBe(true);
    });

    it('hides 24/7 channels and hidden categories, also an uncategorized one', () => {
        const f = filter({ hideLoopChannels: true, hiddenCategories: ['Adult', 'Uncategorized'] });
        expect(isChannelKept(ch('24/7 • Seabright', 'de'), f)).toBe(false);
        expect(isChannelKept(ch('Some Show', null, '24/7 • Series'), f)).toBe(false);
        expect(isChannelKept(ch('X', null, 'Adult'), f)).toBe(false);
        expect(isChannelKept(ch('Y', null, null), f)).toBe(false);
        expect(isChannelKept(ch('KWF HD', 'de', 'News'), f)).toBe(true);
    });
});

describe('parseLineupFilter', () => {
    it('returns null for nothing and fills defaults for partial values', () => {
        expect(parseLineupFilter(null)).toBeNull();
        expect(parseLineupFilter('x')).toBeNull();
        expect(parseLineupFilter({})).toBeNull();
        expect(parseLineupFilter([])).toBeNull();
        expect(parseLineupFilter({ hiddenCategories: ['x'] })).toBeNull();
        expect(parseLineupFilter({ countries: ['de', 3] })).toEqual({
            countries: ['de'],
            includeUntagged: true,
            hideLoopChannels: false,
            hideInfoChannels: false,
            hideEventSlots: false,
            hideLocalStations: false,
            hideRadio: false,
            hiddenCategories: [],
        });
    });

    it('reads a filter stored before the noise switches as hiding none of it', () => {
        const stored = {
            countries: ['us', 'uk', 'de', 'at'],
            channelOrder: 'traditional',
            includeUntagged: true,
            hiddenCategories: [],
            hideLoopChannels: true,
            preferHighQuality: true,
        };
        expect(parseLineupFilter(stored)).toMatchObject({
            hideLoopChannels: true,
            hideInfoChannels: false,
            hideEventSlots: false,
            hideLocalStations: false,
            hideRadio: false,
        });
        expect(
            parseLineupFilter({ ...stored, hideRadio: true, hideEventSlots: 'yes' }),
        ).toMatchObject({ hideRadio: true, hideEventSlots: false });
    });
});

describe('isChannelKept — noise switches', () => {
    const kinds = (...k: NoiseKind[]): Set<NoiseKind> => new Set(k);

    it("hides a channel of a kind only while that kind's switch is on", () => {
        const slot = ch('Korira Event 4', null, 'Live Events');
        expect(isChannelKept(slot, filter(), kinds('eventSlot'))).toBe(true);
        expect(isChannelKept(slot, filter({ hideEventSlots: true }), kinds('eventSlot'))).toBe(
            false,
        );
        expect(isChannelKept(slot, filter({ hideRadio: true }), kinds('eventSlot'))).toBe(true);
    });

    it('maps every switch to its kind', () => {
        const c = ch('x', null);
        expect(isChannelKept(c, filter({ hideInfoChannels: true }), kinds('info'))).toBe(false);
        expect(isChannelKept(c, filter({ hideLocalStations: true }), kinds('localStation'))).toBe(
            false,
        );
        expect(isChannelKept(c, filter({ hideRadio: true }), kinds('radio'))).toBe(false);
        expect(isChannelKept(c, filter({ hideLoopChannels: true }), kinds('loop'))).toBe(false);
    });

    it('still applies the country filter to a channel of no kind', () => {
        const f = filter({ countries: ['de'], includeUntagged: false, hideRadio: true });
        expect(isChannelKept(ch('RO: Pro TV', 'ro'), f, kinds())).toBe(false);
        expect(isChannelKept(ch('DE: KWF', 'de'), f, kinds())).toBe(true);
    });
});
