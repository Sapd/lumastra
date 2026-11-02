// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { extractTitleSegmentsFromFilename } from './episode-filename-titles.js';

describe('extractTitleSegmentsFromFilename', () => {
    it('removes an explicit release ordinal before the title', () => {
        expect(
            extractTitleSegmentsFromFilename(
                'Amber Lantern - S01E01 - 004 - The Clockmaker Calls.mkv',
            ),
        ).toEqual(['The Clockmaker Calls']);
    });
    it('parses a 2-segment dotted release name', () => {
        const result = extractTitleSegmentsFromFilename(
            'Harborfolk.Grosse.Pause.S01E05E06.Vorname.Ashley.-.Hilfe.Miss.Finster.ist.verknallt.German.DL.480p.DSNP.WEB-DL.AAC.2.0.H.264-4SF.mkv',
        );
        expect(result).toHaveLength(2);
        expect(result[0]).toBe('Vorname Ashley');
        expect(result[1]).toBe('Hilfe Miss Finster ist verknallt');
    });

    it('parses a 1-segment dash release name', () => {
        const result = extractTitleSegmentsFromFilename(
            'HarborfolksHafentage-S06E01E02-Wenn Laternen flackern.mkv',
        );
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('Wenn Laternen flackern');
    });

    it('returns [] for a filename with no season/episode token', () => {
        const result = extractTitleSegmentsFromFilename('SomeMovie.mkv');
        expect(result).toEqual([]);
    });

    it('returns [] for an empty string', () => {
        expect(extractTitleSegmentsFromFilename('')).toEqual([]);
    });

    it('returns [] when there is no title after the SE token', () => {
        const result = extractTitleSegmentsFromFilename('Show.S01E01.German.DL.720p.mkv');
        expect(result).toEqual([]);
    });

    it('handles a dotted release with a single title segment (no separator)', () => {
        const result = extractTitleSegmentsFromFilename(
            'Show.S02E03.Der.Einbruch.German.DL.1080p.WEB-DL.mkv',
        );
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('Der Einbruch');
    });

    it('handles a dash release with two ` - ` separated segments', () => {
        const result = extractTitleSegmentsFromFilename(
            'ShowName-S01E03E04-Title One - Title Two.mkv',
        );
        expect(result).toHaveLength(2);
        expect(result[0]).toBe('Title One');
        expect(result[1]).toBe('Title Two');
    });

    it('strips extension before parsing', () => {
        const result = extractTitleSegmentsFromFilename('Show-S01E01-Episode Title.mp4');
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('Episode Title');
    });
});
