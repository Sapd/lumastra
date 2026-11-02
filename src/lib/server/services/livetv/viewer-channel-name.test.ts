// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { splitProviderTag, viewerChannelName, viewerChannelNames } from './viewer-channel-name.js';

function names(raw: string[]): string[] {
    const result = viewerChannelNames(raw.map((name, i) => ({ id: `ch-${i}`, name })));
    return raw.map((_, i) => result.get(`ch-${i}`) ?? '');
}

describe('splitProviderTag', () => {
    it.each([
        ['UK: Nordwelle FHD', 'UK:', 'Nordwelle FHD', 'uk'],
        ['US : Nordwelle HD', 'US :', 'Nordwelle HD', 'us'],
        ['DE • KWF HDraw', 'DE •', 'KWF HDraw', 'de'],
        ['|UK| KWF', '|UK|', 'KWF', 'uk'],
        ['[Bouquet] KWF Info HD', '[Bouquet]', 'KWF Info HD', '[bouquet]'],
        ['SVC: Event 3', 'SVC', 'Event 3', 'svc'],
    ])('%s -> tag %s', (raw, tag, rest, tagKey) => {
        const split = splitProviderTag(raw);
        expect(split.tag).toBe(tag);
        expect(split.rest).toBe(rest);
        expect(split.tagKey).toBe(tagKey);
    });

    it('treats "US:" and "US :" as one tag', () => {
        expect(splitProviderTag('US: KWF').tagKey).toBe(splitProviderTag('US : KWF').tagKey);
    });

    it.each(['KWF HD', 'ZAVO 1 FHD', 'UK:', 'Sat.4 HD', '3kult'])('%s has no tag', (raw) => {
        expect(splitProviderTag(raw).tag).toBeUndefined();
    });
});

describe('viewerChannelName (one channel, no lineup)', () => {
    it.each([
        ['UK: Nordwelle FHD', 'Nordwelle'],
        ['AT: KWF HD', 'KWF'],
        ['DE • MTK HDʀᴀᴡ²', 'MTK'],
        ['[Bouquet] KWF Info HD', 'KWF Info'],
        ['Telesport 2 50FPS FHD', 'Telesport 2'],
        ['ZAVO 1 FHD HEVC (Alt 2)', 'ZAVO 1'],
        ['UK: Event 12', 'Event 12'],
    ])('%s -> %s', (raw, expected) => {
        expect(viewerChannelName(raw)).toBe(expected);
    });

    it('keeps a service tag: one channel cannot show it is the provider tag', () => {
        expect(viewerChannelName('SVC: Event 3 HD')).toBe('SVC: Event 3');
    });

    it('keeps a name that is only a tag', () => {
        expect(viewerChannelName('UK:')).toBe('UK:');
    });
});

describe('viewerChannelNames (lineup)', () => {
    it('drops country, bouquet and quality/feed words', () => {
        expect(
            names([
                'UK: Nordwelle FHD',
                'US : Pinotopia HD',
                'DE • KWF HDraw',
                '[Bouquet] Musa HD',
                'Telesport 2 50FPS FHD HEVC (Alt 2)',
            ]),
        ).toEqual(['Nordwelle', 'Pinotopia', 'KWF', 'Musa', 'Telesport 2']);
    });

    it('keeps the tags when two countries carry the same station name', () => {
        expect(names(['UK: Orb History HD', 'US: Orb History FHD'])).toEqual([
            'UK: Orb History',
            'US: Orb History',
        ]);
    });

    it('keeps the tag next to an untagged card of the same name', () => {
        expect(names(['Orb History HD', 'UK: Orb History HD'])).toEqual([
            'Orb History',
            'UK: Orb History',
        ]);
    });

    it('drops a tag the same name carries twice', () => {
        expect(names(['UK: Orb History HD', 'UK: Orb History SD'])).toEqual([
            'Orb History',
            'Orb History',
        ]);
    });

    it('strips a service tag several channels share, numbers kept', () => {
        expect(names(['SVC: Event 1', 'SVC: Event 2', 'SVC: Event 30 HD'])).toEqual([
            'Event 1',
            'Event 2',
            'Event 30',
        ]);
    });

    it('keeps a service tag only one or two channels carry', () => {
        expect(names(['XYZ: Hits', 'XYZ: Classics', 'KWF HD'])).toEqual([
            'XYZ: Hits',
            'XYZ: Classics',
            'KWF',
        ]);
    });

    it("keeps two services' numbered families apart, each as a whole", () => {
        const raw = [
            ...Array.from({ length: 30 }, (_, i) => `SVC: Event ${i + 1}`),
            ...Array.from({ length: 10 }, (_, i) => `PTV: Event ${i + 1}`),
        ];
        const result = names(raw);
        // Event 11..30 exist only at SVC, but the family keeps its tag as a whole.
        expect(result.slice(0, 30)).toEqual(raw.slice(0, 30));
        expect(result.slice(30)).toEqual(raw.slice(30));
    });

    it('an admin rename always wins', () => {
        const result = viewerChannelNames([
            { id: 'a', name: 'UK: Nordwelle FHD', adminDisplayName: 'Nordwelle UK FHD' },
            { id: 'b', name: 'UK: KWF HD', adminDisplayName: null },
        ]);
        expect(result.get('a')).toBe('Nordwelle UK FHD');
        expect(result.get('b')).toBe('KWF');
    });

    it('keeps the tag next to a card an admin renamed to the same name', () => {
        const result = viewerChannelNames([
            { id: 'a', name: 'US: Orb History HD', adminDisplayName: 'Orb History' },
            { id: 'b', name: 'UK: Orb History HD' },
        ]);
        expect(result.get('a')).toBe('Orb History');
        expect(result.get('b')).toBe('UK: Orb History');
    });
});

describe('UHD stays in the viewer name', () => {
    it('keeps UHD, drops the other quality and feed words', () => {
        expect(viewerChannelName('UK: Orb 1 UHD')).toBe('Orb 1 UHD');
        expect(viewerChannelName('Kanalo UHDʀᴀᴡ')).toBe('Kanalo UHD');
        expect(viewerChannelName('Kanalo UHD²')).toBe('Kanalo UHD');
        expect(viewerChannelName('Kanalo FHD')).toBe('Kanalo');
    });

    it('keeps a 4K written in the name and tidies the separator it leaves', () => {
        expect(viewerChannelName('Orb Sports Ultimate 4K')).toBe('Orb Sports Ultimate 4K');
        expect(viewerChannelName('ABC | 4k - LIVE PLAYOFFS')).toBe('ABC | LIVE PLAYOFFS 4K');
    });

    it('tells the UHD card apart from the normal feed in a lineup', () => {
        const names = viewerChannelNames([
            { id: 'a', name: 'Kanalo HD' },
            { id: 'b', name: 'Kanalo UHD' },
        ]);
        expect(names.get('a')).toBe('Kanalo');
        expect(names.get('b')).toBe('Kanalo UHD');
    });
});
