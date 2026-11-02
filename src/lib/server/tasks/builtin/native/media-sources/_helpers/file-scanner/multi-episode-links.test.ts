// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for multi-episode link arbitration.
 *
 * The layout under test is the one that broke Hafentage season 6: an anthology
 * episode split into segment files named `S06E01E01/E02/E03`, sitting next to
 * dedicated `S06E02` / `S06E03` files. Read as ranges, the segment files also
 * claim episodes 2 and 3.
 */

import { describe, it, expect } from 'vitest';
import {
    isDedicatedEpisodeFile,
    isRangeFileCovering,
    evictRangeLinksSupersededByDedicatedFile,
} from './multi-episode-links.js';
import { parseMediaFilename } from '../../../../../../utils/filename-parser.js';

const HAFENTAGE = '/kids/Hafentage (1997)/Season 06';

describe('isDedicatedEpisodeFile', () => {
    it('accepts a plain single-episode file', () => {
        expect(
            isDedicatedEpisodeFile(
                `${HAFENTAGE}/HarborfolksHafentage-S06E02-Mikey und Kurst.mkv`,
                2,
            ),
        ).toBe(true);
    });

    it('rejects a self-referential range (S06E01E01)', () => {
        // It names exactly one episode, but it is written in range form like its
        // siblings — in a split-anthology set it is part 1, not proof that
        // episode 1 owns a standalone file. Accepting it would let part 1 evict
        // parts 2 and 3 and leave episode 1 holding a third of itself.
        expect(
            isDedicatedEpisodeFile(
                `${HAFENTAGE}/HarborfolksHafentage-S06E01E01-Immer wenn sie Chips aß.mkv`,
                1,
            ),
        ).toBe(false);
    });

    it('rejects a range file even for the episode it starts at', () => {
        expect(
            isDedicatedEpisodeFile(
                `${HAFENTAGE}/HarborfolksHafentage-S06E01E03-Die Nacht der lebenden Finsters.mkv`,
                1,
            ),
        ).toBe(false);
    });

    it('rejects a file for a different episode number', () => {
        expect(
            isDedicatedEpisodeFile(
                `${HAFENTAGE}/HarborfolksHafentage-S06E02-Mikey und Kurst.mkv`,
                3,
            ),
        ).toBe(false);
    });

    it('rejects a path with no episode number at all', () => {
        expect(isDedicatedEpisodeFile(`${HAFENTAGE}/folder.jpg`, 1)).toBe(false);
    });
});

describe('isRangeFileCovering', () => {
    it('covers every episode inside the span', () => {
        const combined = `${HAFENTAGE}/HarborfolksHafentage-S06E01E03-Die Nacht der lebenden Finsters.mkv`;
        expect(isRangeFileCovering(combined, 1)).toBe(true);
        expect(isRangeFileCovering(combined, 2)).toBe(true);
        expect(isRangeFileCovering(combined, 3)).toBe(true);
    });

    it('does not cover episodes outside the span', () => {
        const combined = `${HAFENTAGE}/HarborfolksHafentage-S06E01E03-Die Nacht der lebenden Finsters.mkv`;
        expect(isRangeFileCovering(combined, 4)).toBe(false);
    });

    it('is false for a dedicated file — nothing to evict', () => {
        expect(
            isRangeFileCovering(`${HAFENTAGE}/HarborfolksHafentage-S06E02-Mikey und Kurst.mkv`, 2),
        ).toBe(false);
    });

    it('is false for a self-referential range (start === end)', () => {
        expect(
            isRangeFileCovering(
                `${HAFENTAGE}/HarborfolksHafentage-S06E01E01-Immer wenn sie Chips aß.mkv`,
                1,
            ),
        ).toBe(false);
    });

    it('handles the x-form multi-episode variant', () => {
        // The parser has a second multi-episode form (1x02-03 / 1x02x03) that
        // feeds the same range-expansion loop, so arbitration must see it too.
        expect(isRangeFileCovering('/tv/Show/Show - 1x02-03 - Two Parter.mkv', 3)).toBe(true);
        expect(isRangeFileCovering('/tv/Show/Show - 1x02x03 - Two Parter.mkv', 2)).toBe(true);
    });

    it('handles the dash-separated E-form variant', () => {
        expect(isRangeFileCovering('/tv/Show/Show - S01E01-E03 - Trilogy.mkv', 2)).toBe(true);
    });
});

describe('Hafentage season 6 arbitration', () => {
    const segment3 = `${HAFENTAGE}/HarborfolksHafentage-S06E01E03-Die Nacht der lebenden Finsters.mkv`;
    const episode2 = `${HAFENTAGE}/HarborfolksHafentage-S06E02-Mikey und Kurst.mkv`;
    const episode3 = `${HAFENTAGE}/HarborfolksHafentage-S06E03-Randalls Geheimdienst.mkv`;

    it('lets episodes 2 and 3 claim their own files over the segment range', () => {
        expect(isDedicatedEpisodeFile(episode2, 2)).toBe(true);
        expect(isRangeFileCovering(segment3, 2)).toBe(true);

        expect(isDedicatedEpisodeFile(episode3, 3)).toBe(true);
        expect(isRangeFileCovering(segment3, 3)).toBe(true);
    });

    it('leaves episode 1 holding all three segments — it has no dedicated file', () => {
        const segments = [
            `${HAFENTAGE}/HarborfolksHafentage-S06E01E01-Immer wenn sie Chips aß.mkv`,
            `${HAFENTAGE}/HarborfolksHafentage-S06E01E02-Wenn Laternen flackern.mkv`,
            segment3,
        ];
        // No segment counts as dedicated to episode 1 — every one of them is
        // written in range form — so nothing is entitled to evict the others
        // and episode 1 keeps all three.
        expect(segments.filter((p) => isDedicatedEpisodeFile(p, 1))).toEqual([]);
    });

    it('never evicts anything from an episode whose only files are range-form', () => {
        // The eviction path requires a dedicated file to trigger it. With none
        // present, isRangeFileCovering hits are inert — they are only consulted
        // once a dedicated file has been found.
        const segments = [
            `${HAFENTAGE}/HarborfolksHafentage-S06E01E01-Immer wenn sie Chips aß.mkv`,
            `${HAFENTAGE}/HarborfolksHafentage-S06E01E02-Wenn Laternen flackern.mkv`,
            segment3,
        ];
        const dedicated = segments.filter((p) => isDedicatedEpisodeFile(p, 1));
        expect(dedicated).toHaveLength(0);
    });

    it('does not evict when both linked files are ranges (Harborfolk S09E01-02 / s09e02e03)', () => {
        // Prod case: episode 2 links a `S09E01-02` file and a `s09e02e03` file.
        // Both are ranges covering it, neither is dedicated — so nothing wins
        // and both links stay. A looser rule would have deleted one at random.
        const a = '/tv/Harborfolk/S09/Harborfolk Adventures - S09E01-02 - A Friendly Game.mp4';
        const b = '/tv/Harborfolk/S09/spongebob.s09e02e03-Schmutz.wo.ist.dein.Stachel..mp4';
        expect(isDedicatedEpisodeFile(a, 2)).toBe(false);
        expect(isDedicatedEpisodeFile(b, 2)).toBe(false);
    });
});

describe('evictRangeLinksSupersededByDedicatedFile — dedicated-file guard', () => {
    /**
     * The caller gates the eviction branch on `episodeCount === 1`, derived
     * from the parser. That is NOT the same question isDedicatedEpisodeFile
     * answers: a self-referential range spans exactly one episode and passes
     * the gate. Regression — the callee must re-check, or part 1 of a split
     * anthology deletes parts 2 and 3.
     */
    const SEGMENT_1 = `${HAFENTAGE}/HarborfolksHafentage-S06E01E01-Immer wenn sie Chips aß.mkv`;

    it("the caller's episodeCount gate does admit S06E01E01", () => {
        const parsed = parseMediaFilename(SEGMENT_1);
        const start = parsed.episodeStart ?? parsed.episode;
        const end = parsed.episodeEnd ?? start;
        expect(end! - start! + 1).toBe(1); // gate passes...
        expect(isDedicatedEpisodeFile(SEGMENT_1, 1)).toBe(false); // ...but it is not dedicated
    });

    it('returns early without touching the database for a self-referential range', async () => {
        let queried = false;
        const sqlSpy = new Proxy(() => {}, {
            apply() {
                queried = true;
                throw new Error('database must not be touched for a non-dedicated file');
            },
            get() {
                queried = true;
                throw new Error('database must not be touched for a non-dedicated file');
            },
        }) as unknown as Parameters<typeof evictRangeLinksSupersededByDedicatedFile>[0];

        const evicted = await evictRangeLinksSupersededByDedicatedFile(
            sqlSpy,
            'episode-1-uuid',
            1,
            'file-uuid',
            SEGMENT_1,
        );

        expect(evicted).toEqual([]);
        expect(queried).toBe(false);
    });

    it('proceeds to query for a genuinely dedicated file', async () => {
        let queried = false;
        const sqlSpy = new Proxy(() => {}, {
            apply() {
                queried = true;
                throw new Error('stop after the first query');
            },
        }) as unknown as Parameters<typeof evictRangeLinksSupersededByDedicatedFile>[0];

        await expect(
            evictRangeLinksSupersededByDedicatedFile(
                sqlSpy,
                'episode-2-uuid',
                2,
                'file-uuid',
                `${HAFENTAGE}/HarborfolksHafentage-S06E02-Mikey und Kurst.mkv`,
            ),
        ).rejects.toThrow('stop after the first query');
        expect(queried).toBe(true);
    });
});
