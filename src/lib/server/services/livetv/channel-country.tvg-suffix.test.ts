// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { countryFromTvgSuffix, detectChannelRegion } from './channel-country';
import { processChannels } from './auto-processor';
import type { M3uChannel } from './m3u-parser';

function channel(name: string, tvgId: string, countryCode: string): M3uChannel {
    return {
        tvgId,
        tvgName: undefined,
        name,
        logoUrl: undefined,
        groupTitle: undefined,
        streamUrl: 'http://provider.example/live/1.ts',
        countryCode,
        extras: {},
    };
}

describe('tvg-id suffix countries', () => {
    it.each([
        ['gb', 'uk'],
        ['uk', 'uk'],
        ['de', 'de'],
        ['GB', 'uk'],
    ])('%s -> %s', (suffix, country) => {
        expect(countryFromTvgSuffix(suffix)).toBe(country);
    });

    it.each(['tv', 'co', 'io', 'me', undefined])('%s is no country', (suffix) => {
        expect(countryFromTvgSuffix(suffix)).toBeUndefined();
    });

    it('detectChannelRegion maps ".gb" to uk and drops generic TLDs', () => {
        expect(detectChannelRegion('Nordwelle', undefined, 'gb')).toBe('uk');
        expect(detectChannelRegion('Nordwelle', undefined, 'tv')).toBeUndefined();
        expect(detectChannelRegion('Nordwelle', undefined, 'co')).toBeUndefined();
        // A generic suffix falls through to the section's own country.
        expect(detectChannelRegion('Nordwelle', 'DE • Local', 'tv')).toBe('de');
    });

    it('processChannels stores the lineup country, not the raw suffix', () => {
        const { channels } = processChannels([
            channel('Harbour One', 'HarbourOne.gb', 'gb'),
            channel('Harbour Two', 'HarbourTwo.tv', 'tv'),
            channel('Harbour Three', 'HarbourThree.co', 'co'),
            channel('Harbour Four', 'HarbourFour.de', 'de'),
        ]);
        expect(channels.map((c) => c.region)).toEqual(['uk', undefined, undefined, 'de']);
    });
});
