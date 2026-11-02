// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    parseLRCTimestamp,
    parseLRC,
    getCurrentLine,
    getVisibleLines,
    findLyricInterludes,
    estimateSungMs,
    type SyncedLyricLine,
} from './lrc-parser';

describe('lrc-parser (client)', () => {
    // ---------------------------------------------------------------------------
    // parseLRCTimestamp
    // ---------------------------------------------------------------------------
    describe('parseLRCTimestamp', () => {
        it('parses [MM:SS.xx] centisecond format', () => {
            expect(parseLRCTimestamp('[01:23.45]')).toBe(83_450);
        });

        it('parses [MM:SS.xxx] millisecond format', () => {
            expect(parseLRCTimestamp('[01:23.456]')).toBe(83_456);
        });

        it('parses [MM:SS] without fractional part', () => {
            expect(parseLRCTimestamp('[02:00]')).toBe(120_000);
        });

        it('parses [00:00.00] as zero', () => {
            expect(parseLRCTimestamp('[00:00.00]')).toBe(0);
        });

        it('parses large minute values', () => {
            expect(parseLRCTimestamp('[10:00.00]')).toBe(600_000);
        });

        it('returns null for a metadata tag like [ti:Title]', () => {
            expect(parseLRCTimestamp('[ti:Title]')).toBeNull();
        });

        it('returns null for an empty string', () => {
            expect(parseLRCTimestamp('')).toBeNull();
        });

        it('returns null for bare text without brackets', () => {
            expect(parseLRCTimestamp('01:23.45')).toBeNull();
        });

        it('returns null for a malformed timestamp', () => {
            expect(parseLRCTimestamp('[1:2.3]')).toBeNull(); // seconds must be 2 digits
        });
    });

    // ---------------------------------------------------------------------------
    // parseLRC
    // ---------------------------------------------------------------------------
    describe('parseLRC', () => {
        it('returns empty lines and empty metadata for an empty string', () => {
            const result = parseLRC('');
            expect(result.lines).toEqual([]);
            expect(result.metadata).toEqual({});
        });

        it('parses standard timed lyric lines', () => {
            const lrc = ['[00:01.00]Hello world', '[00:05.00]Second line'].join('\n');

            const { lines } = parseLRC(lrc);
            expect(lines).toHaveLength(2);
            expect(lines[0].startMs).toBe(1_000);
            expect(lines[0].text).toBe('Hello world');
            expect(lines[1].startMs).toBe(5_000);
        });

        it('calculates endMs as the startMs of the following line', () => {
            const lrc = '[00:01.00]First\n[00:05.00]Second';
            const { lines } = parseLRC(lrc);
            expect(lines[0].endMs).toBe(5_000);
            expect(lines[1].endMs).toBeUndefined();
        });

        it('ignores metadata headers and populates metadata map', () => {
            const lrc = [
                '[ti:My Song]',
                '[ar:Some Artist]',
                '[al:The Album]',
                '[00:01.00]Lyric line',
            ].join('\n');

            const { lines, metadata } = parseLRC(lrc);
            expect(lines).toHaveLength(1);
            expect(metadata['ti']).toBe('My Song');
            expect(metadata['ar']).toBe('Some Artist');
            expect(metadata['al']).toBe('The Album');
        });

        it('handles multiple timestamps on a single line', () => {
            const lrc = '[00:12.34][00:45.67]Repeated line';
            const { lines } = parseLRC(lrc);
            expect(lines).toHaveLength(2);
            expect(lines[0].startMs).toBe(12_340);
            expect(lines[1].startMs).toBe(45_670);
            expect(lines[0].text).toBe('Repeated line');
            expect(lines[1].text).toBe('Repeated line');
        });

        it('sorts lines by startMs regardless of input order', () => {
            const lrc = '[00:10.00]Late\n[00:01.00]Early';
            const { lines } = parseLRC(lrc);
            expect(lines[0].startMs).toBe(1_000);
            expect(lines[0].text).toBe('Early');
        });

        it('skips blank lines without errors', () => {
            const lrc = '\n[00:01.00]Hello\n\n[00:05.00]World\n';
            const { lines } = parseLRC(lrc);
            expect(lines).toHaveLength(2);
        });

        it('skips non-timed, non-metadata lines', () => {
            const lrc = 'This is just plain text\n[00:01.00]Lyric';
            const { lines } = parseLRC(lrc);
            expect(lines).toHaveLength(1);
        });

        it('handles Windows line endings (CRLF)', () => {
            const lrc = '[00:01.00]First\r\n[00:05.00]Second';
            const { lines } = parseLRC(lrc);
            expect(lines).toHaveLength(2);
        });

        it('keeps empty-text lines (instrumental markers)', () => {
            const lrc = '[00:01.00]\n[00:05.00]Lyric';
            const { lines } = parseLRC(lrc);
            expect(lines).toHaveLength(2);
            expect(lines[0].text).toBe('');
        });

        it('parses enhanced [MM:SS.xxx] timestamps', () => {
            const lrc = '[01:23.456]Enhanced';
            const { lines } = parseLRC(lrc);
            expect(lines[0].startMs).toBe(83_456);
        });
    });

    // ---------------------------------------------------------------------------
    // getCurrentLine
    // ---------------------------------------------------------------------------
    describe('getCurrentLine', () => {
        const lines: SyncedLyricLine[] = [
            { startMs: 1_000, endMs: 5_000, text: 'Line 1' },
            { startMs: 5_000, endMs: 10_000, text: 'Line 2' },
            { startMs: 10_000, text: 'Line 3' },
        ];

        it('returns -1 for an empty lines array', () => {
            expect(getCurrentLine([], 5_000)).toBe(-1);
        });

        it('returns -1 when currentTimeMs is before the first line', () => {
            expect(getCurrentLine(lines, 0)).toBe(-1);
            expect(getCurrentLine(lines, 999)).toBe(-1);
        });

        it('returns 0 at exactly the first line startMs', () => {
            expect(getCurrentLine(lines, 1_000)).toBe(0);
        });

        it('returns correct index at an exact timestamp', () => {
            expect(getCurrentLine(lines, 5_000)).toBe(1);
            expect(getCurrentLine(lines, 10_000)).toBe(2);
        });

        it('returns the previous line when between timestamps', () => {
            expect(getCurrentLine(lines, 7_500)).toBe(1);
        });

        it('returns the last line index once playback is past it', () => {
            expect(getCurrentLine(lines, 99_999)).toBe(2);
        });

        it('handles a single line correctly', () => {
            const single = [{ startMs: 2_000, text: 'Only line' }];
            expect(getCurrentLine(single, 1_000)).toBe(-1);
            expect(getCurrentLine(single, 2_000)).toBe(0);
            expect(getCurrentLine(single, 9_000)).toBe(0);
        });
    });

    // ---------------------------------------------------------------------------
    // getVisibleLines
    // ---------------------------------------------------------------------------
    describe('getVisibleLines', () => {
        const makeLine = (startMs: number, i: number): SyncedLyricLine => ({
            startMs,
            text: `Line ${i}`,
        });
        const lines: SyncedLyricLine[] = Array.from({ length: 10 }, (_, i) =>
            makeLine(i * 1_000, i),
        );

        it('returns empty result for an empty lines array', () => {
            const result = getVisibleLines([], 3);
            expect(result.lines).toEqual([]);
            expect(result.startIndex).toBe(0);
        });

        it('returns a window of windowSize lines on each side', () => {
            const { lines: visible, startIndex } = getVisibleLines(lines, 5, 2);
            expect(startIndex).toBe(3);
            expect(visible).toHaveLength(5); // indices 3–7
            expect(visible[0].text).toBe('Line 3');
            expect(visible[4].text).toBe('Line 7');
        });

        it('clamps to the start of the array at the beginning', () => {
            const { lines: visible, startIndex } = getVisibleLines(lines, 1, 5);
            expect(startIndex).toBe(0);
            expect(visible[0].text).toBe('Line 0');
        });

        it('clamps to the end of the array at the end', () => {
            const { lines: visible } = getVisibleLines(lines, 9, 5);
            // endIndex = min(10, 9+5+1) = 10, startIndex = max(0, 9-5) = 4
            expect(visible[visible.length - 1].text).toBe('Line 9');
        });

        it('treats currentIndex -1 as position 0 (before first line)', () => {
            const { lines: visible, startIndex } = getVisibleLines(lines, -1, 2);
            expect(startIndex).toBe(0);
            // center=0, start=max(0,0-2)=0, end=min(10,0+2+1)=3
            expect(visible).toHaveLength(3);
        });

        it('uses 5 as default windowSize', () => {
            const { lines: visible } = getVisibleLines(lines, 5);
            // center=5, start=0, end=10 → all 10 lines
            expect(visible).toHaveLength(10);
        });
    });
});

describe('findLyricInterludes', () => {
    const line = (startMs: number, text: string): SyncedLyricLine => ({ startMs, text });

    it('reports the intro before a late first line', () => {
        expect(findLyricInterludes([line(12_000, 'Hello')])).toEqual([
            { afterIndex: -1, startMs: 0, endMs: 12_000 },
        ]);
    });

    it('ignores a short intro', () => {
        expect(findLyricInterludes([line(3_000, 'Hello'), line(5_000, 'there')])).toEqual([]);
    });

    it('treats a blank line as the start of an instrumental break', () => {
        expect(findLyricInterludes([line(1_000, 'a'), line(4_000, ''), line(20_000, 'b')])).toEqual(
            [{ afterIndex: 1, startMs: 4_000, endMs: 20_000 }],
        );
    });

    it('starts the break after the estimated singing time of a sung line', () => {
        const text = 'four words right here';
        const result = findLyricInterludes([line(0, text), line(30_000, 'next')]);
        expect(result).toEqual([{ afterIndex: 0, startMs: estimateSungMs(text), endMs: 30_000 }]);
    });

    it('does not count a long sung line as silence', () => {
        // 7 s is the cap: a 10 s spacing leaves only 3 s of estimated silence
        const text = 'a b c d e f g h i j k l m n o p';
        expect(findLyricInterludes([line(0, text), line(10_000, 'next')])).toEqual([]);
    });

    it('reports nothing after the last line', () => {
        expect(findLyricInterludes([line(0, 'only')])).toEqual([]);
    });
});
