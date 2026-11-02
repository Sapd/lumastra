// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildCombinedEpisodeTitle } from './episode-title.js';

describe('buildCombinedEpisodeTitle', () => {
    it('returns single episode format unchanged', () => {
        const result = buildCombinedEpisodeTitle(
            [{ episode_number: 5, title: 'Vorname Ashley' }],
            1,
        );
        expect(result.rangeCode).toBe('S01E05');
        expect(result.title).toBe('Vorname Ashley');
        expect(result.episodeStart).toBe(5);
        expect(result.episodeEnd).toBe(5);
    });

    it('builds combined range and title for two siblings', () => {
        const result = buildCombinedEpisodeTitle(
            [
                { episode_number: 5, title: 'Vorname Ashley' },
                {
                    episode_number: 6,
                    title: 'Hilfe, Miss Finster ist verknallt',
                },
            ],
            1,
        );
        expect(result.rangeCode).toBe('S01E05-E06');
        expect(result.title).toBe('Vorname Ashley / Hilfe, Miss Finster ist verknallt');
        expect(result.episodeStart).toBe(5);
        expect(result.episodeEnd).toBe(6);
    });

    it('de-duplicates identical adjacent titles', () => {
        const result = buildCombinedEpisodeTitle(
            [
                { episode_number: 3, title: 'Same Title' },
                { episode_number: 4, title: 'Same Title' },
            ],
            2,
        );
        expect(result.title).toBe('Same Title');
        expect(result.rangeCode).toBe('S02E03-E04');
    });

    it('pads season and episode numbers to two digits', () => {
        const result = buildCombinedEpisodeTitle(
            [
                { episode_number: 1, title: 'Part One' },
                { episode_number: 2, title: 'Part Two' },
            ],
            3,
        );
        expect(result.rangeCode).toBe('S03E01-E02');
    });

    it('handles null titles gracefully', () => {
        const result = buildCombinedEpisodeTitle(
            [
                { episode_number: 7, title: null },
                { episode_number: 8, title: 'Second Part' },
            ],
            1,
        );
        expect(result.title).toBe('Second Part');
        expect(result.rangeCode).toBe('S01E07-E08');
    });

    it('spans the whole range for files holding three or more episodes', () => {
        const triple = buildCombinedEpisodeTitle(
            [
                { episode_number: 1, title: 'One' },
                { episode_number: 2, title: 'Two' },
                { episode_number: 3, title: 'Three' },
            ],
            1,
        );
        expect(triple.rangeCode).toBe('S01E01-E03');
        expect(triple.title).toBe('One / Two / Three');
        expect(triple.episodeStart).toBe(1);
        expect(triple.episodeEnd).toBe(3);

        // S11E13-14-15-16 — a real prod shape.
        const quad = buildCombinedEpisodeTitle(
            [
                { episode_number: 13, title: 'A' },
                { episode_number: 14, title: 'B' },
                { episode_number: 15, title: 'C' },
                { episode_number: 16, title: 'D' },
            ],
            11,
        );
        expect(quad.rangeCode).toBe('S11E13-E16');
        expect(quad.title).toBe('A / B / C / D');
    });

    it('handles null episode numbers using fallback of 1', () => {
        const result = buildCombinedEpisodeTitle([{ episode_number: null, title: 'Episode' }], 1);
        expect(result.episodeStart).toBe(1);
        expect(result.episodeEnd).toBe(1);
        expect(result.rangeCode).toBe('S01E01');
    });

    it('keeps a range for a reversed pair, with titles in file order', () => {
        const result = buildCombinedEpisodeTitle(
            [
                { episode_number: 20, title: 'Squid Plus One' },
                { episode_number: 19, title: 'The Executive Treatment' },
            ],
            9,
        );
        expect(result.rangeCode).toBe('S09E19-E20');
        expect(result.title).toBe('Squid Plus One / The Executive Treatment');
    });

    it('does not invent a range for episodes that are not adjacent', () => {
        const result = buildCombinedEpisodeTitle(
            [
                { episode_number: 37, title: "Sandy's Nutmare" },
                { episode_number: 41, title: 'Bulletin Board' },
            ],
            9,
        );
        expect(result.rangeCode).toBe('S09E37+E41');
        expect(result.episodeStart).toBe(result.episodeEnd);
    });

    it('names both seasons for a file holding episodes of two seasons', () => {
        const result = buildCombinedEpisodeTitle(
            [
                { episode_number: 16, season_number: 11, title: 'The Incredible Shrinking Sponge' },
                { episode_number: 19, season_number: 10, title: 'Sportz?' },
            ],
            10,
        );
        expect(result.rangeCode).toBe('S11E16+S10E19');
        expect(result.episodeStart).toBe(result.episodeEnd);
    });
});
