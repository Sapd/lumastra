// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    classifyLineup,
    countNoise,
    hasEventOnlyMarker,
    isInfoChannel,
    isSingleTitle,
    noiseKindsOf,
    parseSlot,
    type NoiseChannel,
} from './lineup-noise';

let nextIndex = 0;
const ch = (title: string, over: Partial<NoiseChannel> = {}): NoiseChannel => ({
    id: over.id ?? title,
    title,
    category_name: null,
    epg_channel_id: null,
    playlist_index: nextIndex++,
    ...over,
});

const ids = (set: Set<string>): string[] => [...set].sort();

describe('isInfoChannel', () => {
    it('finds announcement screens', () => {
        for (const name of [
            'Korira Event Info',
            'DE: VELO EVENT INFO',
            '☆ Welcome Channel ☆',
            'Programmübersicht (EPG)',
            '[Velo Teams] Programmübersicht',
            'Orb Sport Programmübersicht FHD',
            'Kanalübersicht',
            '☆ Welcome ☆',
        ]) {
            expect(isInfoChannel(name), name).toBe(true);
        }
    });

    it('leaves stations and shows with the same words alone', () => {
        for (const name of [
            'KWF Info HD',
            'HLV Info HD',
            '24/7 • Willkommen bei den Hafenbanden',
            'Willkommen in Seabright',
            'Welcome Hafenbande',
            'Welcome Home Kanal',
        ]) {
            expect(isInfoChannel(name), name).toBe(false);
        }
    });
});

describe('hasEventOnlyMarker', () => {
    it('reads the provider notes that a feed only carries events', () => {
        for (const name of [
            'MTK+ 3 [EVENT ONLY]',
            'DE: ZAVO SPORT 2 [ONLY DURING MATCH]',
            'DK: VELO SPORT 1 FHD (LIVE DURING EVENTS ONLY)',
            'NL: KONTI 2 HD (LIVE ON MATCH)',
            'Sport Klub 8 HD HR [Live During Events Only]',
        ]) {
            expect(hasEventOnlyMarker(name), name).toBe(true);
        }
    });

    it('needs both an event word and an only/during word in brackets', () => {
        expect(hasEventOnlyMarker('KWF Event (HD)')).toBe(false);
        expect(hasEventOnlyMarker('Telesport (Live)')).toBe(false);
        expect(hasEventOnlyMarker('Velo Events 1')).toBe(false);
    });
});

describe('parseSlot', () => {
    it('reads stem and number, quality, notes and short codes removed', () => {
        expect(parseSlot('ZAVO UK | Event 55')).toEqual({ stem: 'zavo uk | event', number: 55 });
        expect(parseSlot('MTK+ 3 [EVENT ONLY]')).toEqual({ stem: 'mtk+', number: 3 });
        expect(parseSlot('IT: ZAVO Event 4 IT HD+')).toEqual({ stem: 'it: zavo event', number: 4 });
        expect(parseSlot('BKL | 07')).toEqual({ stem: 'bkl', number: 7 });
        expect(parseSlot('Wimbleford: Court 13')).toEqual({
            stem: 'wimbleford: court',
            number: 13,
        });
    });

    it('needs a trailing number and a stem of three letters', () => {
        expect(parseSlot('Nordwelle')).toBeUndefined();
        expect(parseSlot('TV 1')).toBeUndefined();
        expect(parseSlot('UFC 273: One vs Two')).toBeUndefined();
    });
});

describe('isSingleTitle', () => {
    it('reads a film title with its year', () => {
        expect(isSingleTitle('Ein Film (1998)')).toBe(true);
        expect(isSingleTitle('TR • Ein Film (2011)')).toBe(true);
        expect(isSingleTitle('Kanal 1998')).toBe(false);
        expect(isSingleTitle('Telesport (2)')).toBe(false);
    });
});

describe('classifyLineup — event slots', () => {
    it('marks a numbered family without a guide, keeps one with a guide', () => {
        const slots = Array.from({ length: 9 }, (_, i) => ch(`Tennisball ${i + 1}`));
        const stations = Array.from({ length: 9 }, (_, i) =>
            ch(`Telesport ${i + 1}`, { epg_channel_id: `telesport${i + 1}.de` }),
        );
        const noise = classifyLineup([...slots, ...stations]);
        expect(ids(noise.eventSlot)).toEqual(ids(new Set(slots.map((c) => c.id))));
    });

    it('needs 8 numbers, or 5 when the stem says event or court', () => {
        const few = Array.from({ length: 6 }, (_, i) => ch(`Velo Sports ${i + 1}`));
        const events = Array.from({ length: 5 }, (_, i) => ch(`Korira Event ${i + 1}`));
        const courts = Array.from({ length: 5 }, (_, i) => ch(`Wimbleford: Court ${i + 1}`));
        const noise = classifyLineup([...few, ...events, ...courts]);
        expect(ids(noise.eventSlot)).toEqual(ids(new Set([...events, ...courts].map((c) => c.id))));
    });

    it('treats a guide id shared by many unrelated stations as no guide', () => {
        const words = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta'];
        const placeholderUsers = words.map((w) =>
            ch(`${w} Kanal`, { epg_channel_id: 'noguidebot' }),
        );
        const slots = Array.from({ length: 8 }, (_, i) =>
            ch(`Velo Arena ${i + 1}`, { epg_channel_id: 'noguidebot' }),
        );
        const guided = ['Nordwelle', 'KWF', 'Musa'].map((n) =>
            ch(n, { epg_channel_id: `${n.toLowerCase()}.de` }),
        );
        const noise = classifyLineup([...placeholderUsers, ...slots, ...guided]);
        expect(ids(noise.eventSlot)).toEqual(ids(new Set(slots.map((c) => c.id))));
    });

    it('without any guide in the lineup, only event stems and notes count', () => {
        const stations = Array.from({ length: 9 }, (_, i) => ch(`Velo Sport ${i + 1}`));
        const events = Array.from({ length: 6 }, (_, i) => ch(`Korira Event ${i + 1}`));
        const noise = classifyLineup([...stations, ...events]);
        expect(ids(noise.eventSlot)).toEqual(ids(new Set(events.map((c) => c.id))));
    });

    it('leaves a family member with its own schedule visible', () => {
        const slots = Array.from({ length: 9 }, (_, i) =>
            ch(`Tennisball ${i + 1}`, i === 0 ? { epg_channel_id: 'tennisball1.de' } : {}),
        );
        const noise = classifyLineup(slots);
        expect(noise.eventSlot.has('Tennisball 1')).toBe(false);
        expect(noise.eventSlot.size).toBe(8);
    });

    it('stays fast on hostile names', () => {
        const hostile = Array.from({ length: 12_000 }, (_, i) =>
            ch(`${'a- '.repeat(80)}${'('.repeat(20)}x${i}y`, { id: `h${i}` }),
        );
        const start = performance.now();
        classifyLineup(hostile);
        expect(performance.now() - start).toBeLessThan(3000);
    });

    it('marks a single channel with an event-only note', () => {
        const noise = classifyLineup([ch('Sport Klub 8 HD HR [Live During Events Only]')]);
        expect(noise.eventSlot.size).toBe(1);
    });

    it('does not count an episode loop as a slot', () => {
        const episodes = Array.from({ length: 9 }, (_, i) => ch(`Max der Maurer S1 E${i + 1}`));
        const noise = classifyLineup(episodes);
        expect(noise.eventSlot.size).toBe(0);
        expect(noise.loop.size).toBe(9);
    });
});

describe('classifyLineup — local stations', () => {
    const signs = ['KAAA', 'KBBB', 'KCCC', 'WDDD', 'WEEE', 'WFFF', 'KGGG', 'WHHH-LD'];

    it('marks a network with many call signs in brackets, whatever the layout', () => {
        const stations = signs.map((sign, i) =>
            ch(
                i % 2 === 0
                    ? `US : KVL - ST - TOWN${i} (${sign})`
                    : `US: KVL (${sign} - Town${i} ST)`,
            ),
        );
        const teams = signs.map((sign) => ch(`GRD Teams: WRT Eagles (${sign}) Town ST`));
        const noise = classifyLineup([...stations, ...teams]);
        expect(noise.localStation.size).toBe(16);
    });

    it('takes only K/W call signs, not bracketed language or country codes', () => {
        const codes = ['POL', 'ROU', 'BUL', 'SRB', 'HUN', 'CZE', 'GER', 'ITA', 'SWE'];
        const noise = classifyLineup(codes.map((code) => ch(`Telesport 2 (${code})`)));
        expect(noise.localStation.size).toBe(0);
    });

    it('needs 8 different call signs for one network', () => {
        const few = signs.slice(0, 7).map((sign) => ch(`US: KVL (${sign})`));
        const tags = signs.map((_, i) => ch(`Telesport ${i} (HDR)`));
        const noise = classifyLineup([...few, ...tags]);
        expect(noise.localStation.size).toBe(0);
    });

    it('leaves the network feeds without a call sign alone', () => {
        const stations = signs.map((sign) => ch(`US: KVL (${sign})`));
        const noise = classifyLineup([...stations, ch('US : KVL NEWS TOWN')]);
        expect(noise.localStation.has('US : KVL NEWS TOWN')).toBe(false);
    });
});

describe('classifyLineup — loops', () => {
    it('keeps the 24/7 and episode rules', () => {
        const noise = classifyLineup([
            ch('24/7 • Seabright'),
            ch('✦ 24x7 Cartoons'),
            ch('7/24 | PARADE MÜZİK 1'),
            ch('Max der Maurer S2 E5'),
            ch('Orb 24/7 News'),
            ch('Hafenbande', { category_name: '24/7' }),
        ]);
        expect(ids(noise.loop)).toEqual(
            [
                '24/7 • Seabright',
                '✦ 24x7 Cartoons',
                '7/24 | PARADE MÜZİK 1',
                'Max der Maurer S2 E5',
                'Hafenbande',
            ].sort(),
        );
    });

    it("marks a provider's family of 30+ themes, not a network's theme channels", () => {
        const themes = Array.from({ length: 32 }, (_, i) => ch(`Korira Cinema Star ${i} Name`));
        const network = [
            'Action',
            'Comedy',
            'Family',
            'Thriller',
            'Premiere',
            'Classics',
            'Highlights',
        ].map((t) => ch(`Orb Cinema ${t} FHD`, { epg_channel_id: `orbcinema${t}.de` }));
        const noise = classifyLineup([...themes, ...network]);
        expect(noise.loop.size).toBe(32);
        for (const c of network) expect(noise.loop.has(c.id)).toBe(false);
    });

    it('caps the run and never grows it from its own finds', () => {
        nextIndex = 0;
        const plain = Array.from({ length: 45 }, (_, i) =>
            ch(
                `Bergsender ${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26)]}`,
            ),
        );
        const noise = classifyLineup([ch('24/7 • Seabright'), ...plain]);
        expect(noise.loop.size).toBe(1 + 30);
    });

    it('a film year with a schedule of its own is no loop', () => {
        const noise = classifyLineup([
            ch('Velo Cup (2026)', { epg_channel_id: 'velocup.de' }),
            ch('Ein Film (1998)'),
        ]);
        expect(ids(noise.loop)).toEqual(['Ein Film (1998)']);
    });

    it('extends a loop run over single titles without a guide, up to a station', () => {
        nextIndex = 0;
        const lineup = [
            ch('Nordwelle HD', { epg_channel_id: 'nordwelle.de' }),
            ch('Hafen TV'),
            ch('Rapunzine'),
            ch('Der kleine Ritter - Abenteuer auf der Burg'),
            ch('Max der Maurer S1 E1'),
            ch('Max der Maurer S1 E2'),
            ch('Das Geheimnis der grünen Schuhe'),
            ch('Telesport 1 HD'),
            ch('Waldmärchen'),
        ];
        const noise = classifyLineup(lineup);
        expect(ids(noise.loop)).toEqual(
            [
                'Rapunzine',
                'Der kleine Ritter - Abenteuer auf der Burg',
                'Max der Maurer S1 E1',
                'Max der Maurer S1 E2',
                'Das Geheimnis der grünen Schuhe',
            ].sort(),
        );
    });
});

describe('classifyLineup — radio and counts', () => {
    it('marks the Radio category and counts every kind', () => {
        const noise = classifyLineup([
            ch('Hafenwelle', { category_name: 'Radio' }),
            ch('Korira Event Info'),
            ch('Nordwelle', { epg_channel_id: 'nordwelle.de' }),
        ]);
        expect(countNoise(noise)).toEqual({
            info: 1,
            eventSlot: 0,
            localStation: 0,
            loop: 0,
            radio: 1,
        });
        expect([...noiseKindsOf(noise, 'Hafenwelle')]).toEqual(['radio']);
        expect(noiseKindsOf(noise, 'Nordwelle').size).toBe(0);
    });
});
