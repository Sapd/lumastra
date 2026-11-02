// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    deriveSeries,
    folderSeriesName,
    sequenceFromTitle,
    splitSeriesLabel,
    sequenceToSortOrder,
    SORT_ORDER_SCALE,
} from './series-derive';

describe('splitSeriesLabel', () => {
    it('splits the combined label AudiobookShelf actually returns', () => {
        expect(
            splitSeriesLabel(
                'Erweitertes Rowan-Vale-Universum (in Veröffentlichungsreihenfolge) #9',
            ),
        ).toEqual({
            name: 'Erweitertes Rowan-Vale-Universum (in Veröffentlichungsreihenfolge)',
            sequence: 9,
        });
    });

    it('keeps a label that has no embedded position', () => {
        expect(splitSeriesLabel('Die Hafen Akten')).toEqual({
            name: 'Die Hafen Akten',
            sequence: null,
        });
    });

    it('supports fractional interquels', () => {
        expect(splitSeriesLabel('Frontier #2.5').sequence).toBe(2.5);
        expect(splitSeriesLabel('Frontier #2,5').sequence).toBe(2.5);
    });

    it('does not mistake a # inside the name for a position', () => {
        expect(splitSeriesLabel('Die Sieben Laternenzeichen ???')).toEqual({
            name: 'Die Sieben Laternenzeichen ???',
            sequence: null,
        });
    });
});

describe('splitSeriesLabel — a labelled sequence in the # field', () => {
    // Measured on production: AudiobookShelf handed us
    // `series[0] = { name: "Milo Farrow #Book 3", sequence: null }`. The book was
    // stranded in a one-item "series" of its own while books 1, 2 and 5 grouped
    // under "Milo Farrow", and its position was lost as well.
    it('splits a label the way it splits a bare number', () => {
        expect(splitSeriesLabel('Milo Farrow #Book 3')).toEqual({
            name: 'Milo Farrow',
            sequence: 3,
        });
    });

    it('matches letters generically, never a specific word', () => {
        // "Book" is not special — nor is any German, French or Japanese
        // equivalent. The rule is structural: `#` + letters + digits + END.
        expect(splitSeriesLabel('Frontier #Band 4')).toEqual({ name: 'Frontier', sequence: 4 });
        expect(splitSeriesLabel('Frontier #Tome 4')).toEqual({ name: 'Frontier', sequence: 4 });
        expect(splitSeriesLabel('Frontier #Vol. 2.5')).toEqual({
            name: 'Frontier',
            sequence: 2.5,
        });
    });

    it('leaves a # that belongs to the NAME alone', () => {
        // The digits must run to the end. Trailing text after the number means
        // this is part of the title, not a sequence field — swallowing it would
        // rename the series to "Nr." and invent position 1.
        expect(splitSeriesLabel('Nr. #1 Detektei')).toEqual({
            name: 'Nr. #1 Detektei',
            sequence: null,
        });
    });

    it('still yields no sequence when the # field has no number at all', () => {
        // A missing position is recoverable; a wrong one silently misorders a
        // shelf. The name is still cleaned.
        expect(splitSeriesLabel('Milo Farrow #Prequel')).toEqual({
            name: 'Milo Farrow #Prequel',
            sequence: null,
        });
    });

    it('prefers the bare-number rule when both could match', () => {
        expect(splitSeriesLabel('Cloudrealm #8')).toEqual({ name: 'Cloudrealm', sequence: 8 });
    });
});

describe('sequenceFromTitle', () => {
    it('reads the leading number from a real radio-play title', () => {
        expect(sequenceFromTitle('65 - Als der Meister sich verlor')).toBe(65);
        expect(sequenceFromTitle('58 - Das letzte Problem')).toBe(58);
    });

    it('requires a separator, so a numeric TITLE is not a position', () => {
        expect(sequenceFromTitle('1984')).toBeNull();
        expect(sequenceFromTitle('2001 A Harbor Journey')).toBeNull();
    });

    it('accepts the separators that actually occur', () => {
        expect(sequenceFromTitle('12. Der Fall')).toBe(12);
        expect(sequenceFromTitle('12: Der Fall')).toBe(12);
        expect(sequenceFromTitle('12) Der Fall')).toBe(12);
        expect(sequenceFromTitle('12 – Der Fall')).toBe(12);
    });

    it('requires punctuation, not bare whitespace, so real titles survive', () => {
        // Would otherwise become position 12 and misorder the shelf.
        expect(sequenceFromTitle('12 Quiet Guests')).toBeNull();
        expect(sequenceFromTitle('7 Habits')).toBeNull();
    });

    it('accepts a slash separator — measured on a real 230-item series', () => {
        // AudiobookShelf surfaced these titles as "001/Die Jagd…", folding a
        // nested numbering folder into the title. Missing this dropped the
        // position for an entire 230-item radio-play series.
        expect(sequenceFromTitle('001/Die Jagd nach den Millionendieben')).toBe(1);
        expect(sequenceFromTitle('007/Rätsel um die alte Villa')).toBe(7);
    });

    it('rejects a year-like leading number, which is an omnibus not a position', () => {
        expect(sequenceFromTitle('1984 / Animal Farm')).toBeNull();
        expect(sequenceFromTitle('2001: A Space Odyssey')).toBeNull();
        // ...while a real position is untouched.
        expect(sequenceFromTitle('219 - Letzte Folge')).toBe(219);
    });

    it('is locale-neutral: no language token list', () => {
        // None of these carry a position we can trust, in any language.
        expect(sequenceFromTitle('Folge Fünf')).toBeNull();
        expect(sequenceFromTitle('Volume Five')).toBeNull();
        expect(sequenceFromTitle('第五巻')).toBeNull();
    });

    it('parses non-Latin decimal digits', () => {
        expect(sequenceFromTitle('٦٥ - عنوان')).toBe(65);
    });
});

describe('folderSeriesName', () => {
    it('takes the immediate parent folder', () => {
        expect(folderSeriesName('Die Sieben Laternenzeichen ???/148 - Der Fall.m4b')).toBe(
            'Die Sieben Laternenzeichen ???',
        );
    });

    it('takes only the leaf of a nested path', () => {
        expect(folderSeriesName('Stefan Wolf/KLMN/001 - Die Jagd.m4b')).toBe('KLMN');
    });

    it('returns null for a file at the library root', () => {
        expect(folderSeriesName('Standalone.m4b')).toBeNull();
    });

    it('handles Windows separators from a foreign host', () => {
        expect(folderSeriesName('Stefan Wolf\\KLMN\\001.m4b')).toBe('KLMN');
    });

    it('handles a trailing slash on a folder-shaped item', () => {
        expect(folderSeriesName('Sherlock Holmes [Hafen]/58/')).toBe('Sherlock Holmes [Hafen]');
    });
});

describe('deriveSeries — the measured real-world cases', () => {
    it('audiobook: series from the ABS label, position from its #N', () => {
        expect(
            deriveSeries({
                seriesName: 'Erweitertes Rowan-Vale-Universum (in Veröffentlichungsreihenfolge) #9',
                title: 'Operation Rainbow',
                relPath: 'Tom Clancy/Operation Rainbow.m4b',
            }),
        ).toEqual({
            name: 'Erweitertes Rowan-Vale-Universum (in Veröffentlichungsreihenfolge)',
            sequence: 9,
            source: 'abs-series',
        });
    });

    it('radio play: EMPTY seriesName → folder for the name, title for the position', () => {
        expect(
            deriveSeries({
                seriesName: '',
                title: '65 - Als der Meister sich verlor',
                relPath: 'Sherlock Holmes [Hafen]/65 - Als der Meister sich verlor.m4b',
            }),
        ).toEqual({
            name: 'Sherlock Holmes [Hafen]',
            sequence: 65,
            source: 'folder',
        });
    });

    it('a structural ABS sequence beats anything parsed', () => {
        expect(
            deriveSeries({
                seriesName: 'KLMN #7',
                absSequence: '12',
                title: '99 - Something',
            }).sequence,
        ).toBe(12);
    });

    it('standalone book at the library root has no series and no position', () => {
        expect(deriveSeries({ seriesName: null, title: '1984', relPath: '1984.m4b' })).toEqual({
            name: null,
            sequence: null,
            source: 'none',
        });
    });

    it('never invents a position for a standalone book', () => {
        // Title looks positional, but with no series there is nothing to order within.
        expect(deriveSeries({ title: '65 - Some Title', relPath: 'Top.m4b' }).sequence).toBeNull();
    });

    it('missing everything degrades quietly rather than throwing', () => {
        expect(deriveSeries({})).toEqual({ name: null, sequence: null, source: 'none' });
    });
});

describe('sequenceToSortOrder', () => {
    it('scales so interquels sort between neighbours', () => {
        const two = sequenceToSortOrder(2)!;
        const twoFive = sequenceToSortOrder(2.5)!;
        const three = sequenceToSortOrder(3)!;
        expect(two).toBeLessThan(twoFive);
        expect(twoFive).toBeLessThan(three);
        expect(two).toBe(2 * SORT_ORDER_SCALE);
    });

    it('passes null through and rejects nonsense', () => {
        expect(sequenceToSortOrder(null)).toBeNull();
        expect(sequenceToSortOrder(-1)).toBeNull();
        expect(sequenceToSortOrder(Number.NaN)).toBeNull();
    });

    it('clamps an absurd upstream value instead of overflowing the int column', () => {
        expect(sequenceToSortOrder(9_999_999_999)).toBeLessThanOrEqual(2_000_000_000);
    });
});
