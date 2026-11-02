// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { bouquetLabel, categorizeChannel, GENRE } from './channel-genre';

describe('categorizeChannel', () => {
    it.each([
        ['PORNDECK: BABES', 'ADULT XXX', GENRE.adult],
        ['xXx • German Mix 1', 'StreamTV Porn', GENRE.adult],
        ['ISLAM: SAUDI QURAN', 'ISLAM: ISLAMIC', GENRE.religious],
        ['24/7 • Seabright', 'StreamTV • Series', GENRE.loop],
        ['Max der Maurer S2 E5', 'EVENTS • Misc', GENRE.loop],
        [
            'KONTI  | 01 - Harbor City vs Eastford United 8:00pm',
            'KONTI LIVE EVENT MIX',
            GENRE.events,
        ],
        ['BKL 02', 'EVENTS • BKL', GENRE.events],
        ['StreamTV Live Event 3', undefined, GENRE.events],
        ['ZAVO UK | Event 1', 'EVENTS • ZAVO UK', GENRE.events],
        ['Orb Topliga HDraw', 'Orb Topliga RAW SAT & Cable', GENRE.sports],
        ['KZK Spor', 'TR SPOR', GENRE.sports],
        ['MiMO HD', 'DE Kinder', GENRE.kids],
        ['Tagesblick24 HD', 'DE • News', GENRE.news],
        ['Wanderer Channel HD', 'Познавательные 2', GENRE.documentary],
        ['Velvet Music HD', 'DE MUSIC', GENRE.music],
        ['Orb Cinema Action HD', 'Orb HDraw & WHDraw WebTV', GENRE.movies],
        ['Radio Vier', 'DE • Radio', GENRE.radio],
        ['KAUFRING HD', 'DE WebTV ● ShopTV & Co', GENRE.shopping],
    ])('%s in %s -> %s', (name, group, genre) => {
        expect(categorizeChannel(name, group)).toBe(genre);
    });

    it('lets a clear name refine a catch-all section, but not a specific one', () => {
        expect(categorizeChannel('Telesport 1 HD', 'BG| GENERAL')).toBe(GENRE.sports);
        expect(categorizeChannel('bTV', 'BG| GENERAL')).toBe(GENRE.general);
        expect(categorizeChannel('Orb Sport News HD', 'DE • News')).toBe(GENRE.news);
    });

    it('falls back to the bouquet label, then General', () => {
        expect(categorizeChannel('Orb One HDraw', 'Orb HDraw & WHDraw WebTV')).toBe('Orb');
        expect(categorizeChannel('Nordwelle FHD', 'FHD+ HEVC & WebTV')).toBe(GENRE.general);
        expect(categorizeChannel('Javorína', 'SK • SLOVAKIA')).toBe(GENRE.general);
        expect(categorizeChannel('Nordwelle', undefined)).toBe(GENRE.general);
        // "Radio Weser TV" is television: radio is a section word only.
        expect(categorizeChannel('Radio Weser TV', 'FHD+ HEVC & WebTV')).toBe(GENRE.general);
    });
});

describe('bouquetLabel', () => {
    it.each([
        ['DE • Orb • Low Quali', 'Orb'],
        ['CZECH [OrbLinkCZ]', 'OrbLinkCZ'],
        ['NL VELOPLAY', 'VELOPLAY'],
        ['Tukan Prime', 'Tukan Prime'],
        ['SK • SLOVAKIA', undefined],
        ['FHD+ HEVC & WebTV', undefined],
        ['DE • Local RAW', undefined],
    ])('%s -> %s', (label, expected) => {
        expect(bouquetLabel(label)).toBe(expected);
    });
});

describe('generic genre words stay inside their words', () => {
    it('does not file look-alike words under a genre', () => {
        expect(categorizeChannel('Workshop TV', 'Workshop Kanal')).not.toBe(GENRE.shopping);
        expect(categorizeChannel('Transports', 'Transports')).not.toBe(GENRE.sports);
        expect(categorizeChannel('Eurosports 1', undefined)).toBe(GENRE.sports);
        expect(categorizeChannel('Euronews', undefined)).toBe(GENRE.news);
        expect(categorizeChannel('KAUFRING', 'DE WebTV ● ShopTV & Co')).toBe(GENRE.shopping);
    });
});

describe("more languages in group titles (an Xtream provider's groups)", () => {
    it.each([
        ['NL Algemeen', GENRE.general],
        ['AL GJENERALE', GENRE.general],
        ['NL Kinderen', GENRE.kids],
        ['DE Märchen', GENRE.kids],
        ['PL MUZYCZNE', GENRE.music],
        ['US Wrestling', GENRE.sports],
        ['TR Korku Gerilim', GENRE.movies],
    ])('%s -> %s', (group, genre) => {
        expect(categorizeChannel('Kanal Eins', group)).toBe(genre);
    });

    it('treats country words and HDR as noise in a bouquet label', () => {
        expect(bouquetLabel('EMIRATES')).toBeUndefined();
        expect(bouquetLabel('AZE')).toBeUndefined();
        expect(bouquetLabel('HDR')).toBeUndefined();
    });
});
