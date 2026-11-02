// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    countryFromGuideId,
    countryFromLabel,
    countryFromSection,
    countryFromSuffix,
    detectChannelRegion,
    expandRegions,
    isAdultLabel,
    isLoopChannel,
    isReligiousLabel,
    stripCountryTag,
} from './channel-country';

describe('countryFromLabel', () => {
    it.each([
        ['US: VDD HD', 'us'],
        ['UK: WBN 1 UHD', 'uk'],
        ['|BG| bTV', 'bg'],
        ['[DE] Nordwelle', 'de'],
        ['✦●✦ |BG| KIDS ✦●✦', 'bg'],
        ['FR| RIVAGE+ FHD', 'fr'],
        ['RO • Pro TV', 'ro'],
        ['AR_NS: AL WAHA', 'arab'],
        ['AR-KIDS: MOONTOON', 'arab'],
        ['EXY: ZEO HD', 'exyu'],
        ['KU| BAWAN TV', 'kurd'],
        ['SRB: PLV 1', 'rs'],
        ['ZA: UBUN 1', 'za'], // ISO fallback, not in the table
        ['FR- KANALO FOOT', 'fr'],
        ['AR - Orb Sports 2', 'arab'],
        ['Spain- MOVIDA 5', 'es'],
        ['Portugal - Orb Sport 2', 'pt'],
    ])('%s -> %s', (name, code) => {
        expect(countryFromLabel(name)).toBe(code);
    });

    it.each([
        'HR-Kanal HD',
        'N-Kanal HDraw',
        'LRV-alpha HD+',
        'S-TV Cinema Action',
        'X4 | Something',
        'TV: Some Show',
        'SD: Low Res Feed',
        'KONTI  | 01 - A vs B',
        'Nordwelle HD',
        '24/7 • Seabright',
        'EN- Orb Sports 2',
        'Orb Sports- HD4 EN',
        'Seaside - Live',
    ])('%s has no country', (name) => {
        expect(countryFromLabel(name)).toBeUndefined();
    });
});

describe('countryFromSection', () => {
    it.each([
        ['DE • Local RAW', 'de'],
        ['DE Kinder', 'de'],
        ['CH ALL SPORTS', 'ch'],
        ['AUSTRIA RAW', 'at'],
        ['SPORT • AUSTRIA MIX', 'at'],
        ['SWISS', 'ch'],
        ['ITALY ZAVO', 'it'],
        ['KURDISH', 'kurd'],
    ])('%s -> %s', (section, code) => {
        expect(countryFromSection(section)).toBe(code);
    });

    it.each(['FHD+ HEVC & WebTV', 'UHD 4k', 'FORMEL 1', 'DOKU RAW', 'ON DEMAND', 'TV-SHOWS'])(
        '%s has no country',
        (section) => {
            expect(countryFromSection(section)).toBeUndefined();
        },
    );
});

describe('isLoopChannel', () => {
    it.each([
        '24/7 • Seabright',
        '7/24 | PARADE MÜZİK 1',
        '24-7 Hafenbande',
        '✦ 24x7 Cartoons',
        'Max der Maurer S2 E5',
        'Show S01E03',
    ])('%s loops', (name) => expect(isLoopChannel(name)).toBe(true));
    it.each(['Orb 24/7 News', '[Not 24/7] Movies', 'MTK HD', 'Stadion Sport 24', 'Sport8 S'])(
        '%s does not',
        (name) => expect(isLoopChannel(name)).toBe(false),
    );
});

describe('adult and religious', () => {
    it('detects adult names and sections, not Adult Education', () => {
        expect(isAdultLabel('xXx • German Mix 1')).toBe(true);
        expect(isAdultLabel('+18 • Adult 1')).toBe(true);
        expect(isAdultLabel('PORNDECK: BABES')).toBe(true);
        expect(isAdultLabel('[RivagePlus] (18+) Velour TV')).toBe(true);
        expect(isAdultLabel('ADULT XXX')).toBe(true);
        expect(isAdultLabel('Adult Education')).toBe(false);
        expect(isAdultLabel('Maxxx Sports')).toBe(false);
    });

    it('detects religious keywords in any script case, including Turkish dotted I', () => {
        expect(isReligiousLabel('ISLAM: SAUDI QURAN FHD')).toBe(true);
        expect(isReligiousLabel('TR• LYNX • DİNİ')).toBe(true);
        expect(isReligiousLabel('RO • RELIGIE')).toBe(true);
        expect(isReligiousLabel('Bibel Kanal HD')).toBe(true);
        expect(isReligiousLabel('Dinara TV')).toBe(false);
        expect(isReligiousLabel('Kirchen TV')).toBe(false);
    });
});

describe('detectChannelRegion', () => {
    it('prefers adult and religious over any country', () => {
        expect(detectChannelRegion('xXx • German Mix', 'StreamTV Porn', 'de')).toBe('adult');
        expect(detectChannelRegion('TR: DİNİ FİLMLER', 'TR• LYNX • DİNİ', undefined)).toBe(
            'religious',
        );
    });

    it('takes the name tag, then a trailing tag, then the tvg-id country, then the section, then its script', () => {
        // Providers reuse tvg-ids across countries; the name tag is their own label.
        expect(detectChannelRegion('UK: WBN', 'US • Regional', 'ie')).toBe('uk');
        expect(detectChannelRegion('VIP SPORT: ORB SPORT 3 (AR)', 'Sports', 'us')).toBe('arab');
        expect(detectChannelRegion('WBN', 'US • Regional', 'ie')).toBe('ie');
        expect(detectChannelRegion('BE: FLN 1', 'SK • SLOVAKIA', undefined)).toBe('be');
        expect(detectChannelRegion('Nordwelle FHD', 'DE • Local', undefined)).toBe('de');
        expect(detectChannelRegion('Wanderer Channel HD', 'Познавательные 2', undefined)).toBe(
            'ru',
        );
        expect(detectChannelRegion('Інтер', 'Українські', undefined)).toBe('ua');
        expect(detectChannelRegion('Orb One HDraw', 'Orb HDraw & WHDraw WebTV', undefined)).toBe(
            undefined,
        );
    });
});

describe('countryFromSuffix', () => {
    it('reads a trailing bracketed country tag only', () => {
        expect(countryFromSuffix('Orb Sport 3 (AR)')).toBe('arab');
        expect(countryFromSuffix('Klub 8 [HR]')).toBe('hr');
        expect(countryFromSuffix('Nordwelle (HD)')).toBeUndefined();
        expect(countryFromSuffix('Nordwelle (TV)')).toBeUndefined();
        expect(countryFromSuffix('Nordwelle HR')).toBeUndefined();
    });
});

describe('stripCountryTag with a written-out country', () => {
    it('strips "Spain- " like "ES: "', () => {
        expect(stripCountryTag('Spain- MOVIDA 5')).toBe('MOVIDA 5');
        expect(stripCountryTag('Seaside - Live')).toBeUndefined();
    });
});

describe('expandRegions', () => {
    it('adds member countries of a region', () => {
        expect(expandRegions(['exyu'])).toEqual(
            new Set(['exyu', 'rs', 'hr', 'ba', 'mk', 'me', 'si']),
        );
        expect(expandRegions(['de', 'uk'])).toEqual(new Set(['de', 'uk']));
    });
});

describe('review cases', () => {
    it('reads Cyrillic sections by script detail', () => {
        expect(detectChannelRegion('X', 'Основные 2', undefined)).toBe('ru');
        expect(detectChannelRegion('X', 'Детские 2', undefined)).toBe('ru');
        expect(detectChannelRegion('X', 'Филми и сериали', undefined)).toBe('ru');
        expect(detectChannelRegion('X', 'Българска телевизия', undefined)).toBe('bg');
        expect(detectChannelRegion('X', 'Њуз канали', undefined)).toBe('rs');
    });

    it('does not read a plain-space section title as a country for NO/IN/ME/SI', () => {
        expect(countryFromSection('NO LIMIT')).toBeUndefined();
        expect(countryFromSection('IN CONCERT')).toBeUndefined();
        expect(countryFromSection('NO: FJR')).toBe('no');
        expect(countryFromSection('AT Rivage+')).toBe('at');
    });

    it('extends adult and religious words without catching Evangeline', () => {
        expect(isAdultLabel('Erotik Kanal')).toBe(true);
        expect(isAdultLabel('Adult Education')).toBe(false);
        expect(isAdultLabel('PARADE MIX ADULT 35')).toBe(true);
        expect(isAdultLabel('Adults Only')).toBe(true);
        expect(isAdultLabel('Adult Movies')).toBe(true);
        expect(isAdultLabel('Adult Education')).toBe(false);
        expect(isAdultLabel('Canal Adulto')).toBe(true);
        expect(isReligiousLabel('Evangeline Rising')).toBe(false);
        expect(isReligiousLabel('Evangelical TV')).toBe(true);
        expect(isReligiousLabel('Iglesia TV')).toBe(true);
    });

    it('caps very long labels', () => {
        const long = 'US: ' + 'x'.repeat(100_000);
        expect(detectChannelRegion(long, long, undefined)).toBe('us');
    });
});

describe('stripCountryTag', () => {
    it.each([
        ['AT: TORQ HD', 'TORQ HD'],
        ['ES| TORQ HD', 'TORQ HD'],
        ['|BG| bTV', 'bTV'],
        ['[DE] Nordwelle', 'Nordwelle'],
    ])('%s -> %s', (name, stripped) => {
        expect(stripCountryTag(name)).toBe(stripped);
    });

    it.each(['TORQ HD', 'N-Kanal HDraw', 'TV: Some Show', '', 'DE:', '[AT]'])(
        '%s has no tag',
        (name) => {
            expect(stripCountryTag(name)).toBeUndefined();
        },
    );
});

describe('countryFromGuideId', () => {
    it.each([
        ['TORQ.uk', 'uk'],
        ['torq.it', 'it'],
        ['KWF.de', 'de'],
        ['Foo.gb', 'uk'],
        ['KWF.de@SD', 'de'],
    ])('%s -> %s', (id, code) => {
        expect(countryFromGuideId(id)).toBe(code);
    });

    it.each([
        'TORQHD',
        'Some.tv',
        'Foo.co',
        'Bar.io',
        '5673a8729576cd423de4fd11b5d1d08e',
        'TORQ HD',
        undefined,
    ])('%s has no country', (id) => {
        expect(countryFromGuideId(id)).toBeUndefined();
    });
});
