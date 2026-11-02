// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { previewCoverage } from './ordering-preview-coverage';

const ep = (originalSeason: number, originalEpisode: number) => ({
    originalSeason,
    originalEpisode,
});

describe('previewCoverage', () => {
    it('counts episodes of touched seasons the group leaves out', () => {
        // A "double episodes as one" group: S1 has 4 episodes, the group lists 2.
        const result = previewCoverage(
            [ep(1, 1), ep(1, 3), ep(2, 1)],
            [
                { seasonNumber: 0, episodeCount: 5 },
                { seasonNumber: 1, episodeCount: 4 },
                { seasonNumber: 2, episodeCount: 2 },
            ],
        );
        expect(result.seasons).toEqual([
            { seasonNumber: 1, inGroup: 2, total: 4 },
            { seasonNumber: 2, inGroup: 1, total: 2 },
        ]);
        expect(result.notInOrdering).toBe(3);
        // Specials have nothing in the group, so they keep their numbering.
        expect(result.untouchedSeasons).toEqual([0]);
    });

    it('reports an unknown left-out count without season totals', () => {
        const result = previewCoverage([ep(1, 1), ep(1, 2)], undefined);
        expect(result.seasons).toEqual([{ seasonNumber: 1, inGroup: 2, total: null }]);
        expect(result.notInOrdering).toBeNull();
        expect(result.untouchedSeasons).toEqual([]);
    });

    it('counts an episode listed twice once and never goes negative', () => {
        const result = previewCoverage(
            [ep(1, 1), ep(1, 1), ep(1, 2), ep(1, 3)],
            [{ seasonNumber: 1, episodeCount: 2 }],
        );
        expect(result.seasons[0]).toEqual({ seasonNumber: 1, inGroup: 3, total: 2 });
        expect(result.notInOrdering).toBe(0);
    });

    it('ignores empty seasons when listing untouched ones', () => {
        const result = previewCoverage(
            [ep(1, 1)],
            [
                { seasonNumber: 1, episodeCount: 1 },
                { seasonNumber: 2, episodeCount: 0 },
            ],
        );
        expect(result.untouchedSeasons).toEqual([]);
        expect(result.notInOrdering).toBe(0);
    });
});
