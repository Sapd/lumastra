// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { deriveFileSegments, type DeriveFileSegmentsInput } from './file-segments.js';
import { isGenericChapterName } from './string-similarity.js';

// Real prod shape: Harborfolk.Grosse.Pause.S02E24E25 — one 1354.602s file backing
// episodes 24 ("The Break-Up") and 25 ("The Hypnotist").
const RECESS_DURATION_MS = 1_354_602;
const RECESS_EPISODES = [
    { mediaItemId: 'ep24', episodeNumber: 24, runtimeMs: 660_000 },
    { mediaItemId: 'ep25', episodeNumber: 25, runtimeMs: 660_000 },
];
const RECESS_CHAPTERS = [
    { name: 'Opening', startMs: 0 },
    { name: 'T.J. in Nöten', startMs: 61_603 },
    { name: 'Petey, der Schulschreck', startMs: 692_275 },
    { name: 'Credits', startMs: 1_323_072 },
];

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Defaults `declaredEpisodeCount` to the number of linked episodes — i.e. the
 * filename declares exactly what is linked, which is true of every genuine
 * combined release. Tests that probe provenance pass it explicitly.
 */
function derive(
    input: Omit<DeriveFileSegmentsInput, 'declaredEpisodeCount'> &
        Partial<Pick<DeriveFileSegmentsInput, 'declaredEpisodeCount'>>,
) {
    const { declaredEpisodeCount, ...rest } = input;
    return deriveFileSegments({
        ...rest,
        declaredEpisodeCount:
            declaredEpisodeCount === undefined ? rest.episodes.length : declaredEpisodeCount,
    });
}

describe('deriveFileSegments — chapter path', () => {
    it('keeps Folge labels as playback boundaries in an uneven combined file', () => {
        expect(isGenericChapterName('Folge 1')).toBe(true);
        expect(isGenericChapterName('Folge 2')).toBe(true);
        expect(
            derive({
                durationMs: 1_800_000,
                episodes: [
                    { mediaItemId: 'ep1', episodeNumber: 1, runtimeMs: null },
                    { mediaItemId: 'ep2', episodeNumber: 2, runtimeMs: null },
                ],
                chapters: [
                    { name: 'Folge 1', startMs: 0 },
                    { name: 'Folge 2', startMs: 600_000 },
                ],
            }),
        ).toEqual([
            { mediaItemId: 'ep1', startMs: 0, endMs: 600_000, source: 'chapter' },
            { mediaItemId: 'ep2', startMs: 600_000, endMs: 1_800_000, source: 'chapter' },
        ]);
    });

    it.each([
        ['Main', 'Start'],
        ['Episode', 'Intro / Outro'],
    ])('preserves historical boundary eligibility for %s and %s', (first, second) => {
        const segments = derive({
            durationMs: 1_800_000,
            episodes: [
                { mediaItemId: 'ep1', episodeNumber: 1, runtimeMs: null },
                { mediaItemId: 'ep2', episodeNumber: 2, runtimeMs: null },
            ],
            chapters: [
                { name: first, startMs: 0 },
                { name: second, startMs: 600_000 },
            ],
        });
        expect(segments?.[0].source).toBe('chapter');
        expect(segments?.[1].startMs).toBe(600_000);
    });

    it.each(['Episode', 'Chapter', 'Kapitel', 'Teil', 'Part', 'Szene', 'Scene'])(
        'continues to exclude numbered %s labels from playback boundaries',
        (label) => {
            expect(
                derive({
                    durationMs: 1_800_000,
                    episodes: [
                        { mediaItemId: 'ep1', episodeNumber: 1, runtimeMs: null },
                        { mediaItemId: 'ep2', episodeNumber: 2, runtimeMs: null },
                    ],
                    chapters: [
                        { name: `${label} 1`, startMs: 0 },
                        { name: `${label} 2`, startMs: 600_000 },
                    ],
                }),
            ).toEqual([
                { mediaItemId: 'ep1', startMs: 0, endMs: 900_000, source: 'even-split' },
                { mediaItemId: 'ep2', startMs: 900_000, endMs: 1_800_000, source: 'even-split' },
            ]);
        },
    );

    it('derives exact segments for the Hafentage S02E24E25 file', () => {
        expect(
            derive({
                durationMs: RECESS_DURATION_MS,
                episodes: RECESS_EPISODES,
                chapters: RECESS_CHAPTERS,
            }),
        ).toEqual([
            { mediaItemId: 'ep24', startMs: 0, endMs: 692_275, source: 'chapter' },
            { mediaItemId: 'ep25', startMs: 692_275, endMs: RECESS_DURATION_MS, source: 'chapter' },
        ]);
    });

    it('absorbs the Opening into episode 1 and the Credits into the last episode', () => {
        const segments = derive({
            durationMs: RECESS_DURATION_MS,
            episodes: RECESS_EPISODES,
            chapters: RECESS_CHAPTERS,
        });

        // First segment starts at 0, not at the first content chapter (61.6s),
        // so the Opening plays as part of episode 24.
        expect(segments?.[0].startMs).toBe(0);
        // Last segment runs to EOF, not to the Credits marker (1323s).
        expect(segments?.[1].endMs).toBe(RECESS_DURATION_MS);
    });

    it('covers the whole file with no gaps and no overlaps', () => {
        const segments = derive({
            durationMs: RECESS_DURATION_MS,
            episodes: RECESS_EPISODES,
            chapters: RECESS_CHAPTERS,
        });

        expect(segments?.[0].startMs).toBe(0);
        expect(segments?.at(-1)?.endMs).toBe(RECESS_DURATION_MS);
        for (let i = 1; i < (segments?.length ?? 0); i++) {
            expect(segments?.[i].startMs).toBe(segments?.[i - 1].endMs);
        }
    });

    it('orders segments by episode number regardless of input order', () => {
        const segments = derive({
            durationMs: RECESS_DURATION_MS,
            episodes: [RECESS_EPISODES[1], RECESS_EPISODES[0]],
            chapters: RECESS_CHAPTERS,
        });

        expect(segments?.map((s) => s.mediaItemId)).toEqual(['ep24', 'ep25']);
        expect(segments?.[0].startMs).toBe(0);
    });

    it('falls through when content chapters do not match the episode count', () => {
        // Three content chapters, two episodes — ambiguous, cannot bind positionally.
        const segments = derive({
            durationMs: RECESS_DURATION_MS,
            episodes: RECESS_EPISODES,
            chapters: [
                { name: 'Opening', startMs: 0 },
                { name: 'Scene A', startMs: 61_603 },
                { name: 'Scene B', startMs: 400_000 },
                { name: 'Scene C', startMs: 692_275 },
            ],
        });

        expect(segments?.[0].source).toBe('runtime-split');
    });

    it('ignores generic chapter names when counting content chapters', () => {
        const segments = derive({
            durationMs: RECESS_DURATION_MS,
            episodes: RECESS_EPISODES,
            chapters: [
                { name: 'Intro', startMs: 0 },
                { name: 'T.J. in Nöten', startMs: 61_603 },
                { name: 'Petey, der Schulschreck', startMs: 692_275 },
                { name: 'Abspann', startMs: 1_323_072 },
            ],
        });

        expect(segments?.[0].source).toBe('chapter');
        expect(segments?.[1].startMs).toBe(692_275);
    });

    it('rejects chapter binding when content chapters are not strictly increasing', () => {
        const segments = derive({
            durationMs: RECESS_DURATION_MS,
            episodes: RECESS_EPISODES,
            chapters: [
                { name: 'Part One', startMs: 500_000 },
                { name: 'Part Two', startMs: 500_000 },
            ],
        });

        // Degenerate zero-length segment must not be produced.
        expect(segments?.[0].source).toBe('runtime-split');
    });

    it('rejects chapter binding when a chapter starts beyond the file duration', () => {
        const segments = derive({
            durationMs: RECESS_DURATION_MS,
            episodes: RECESS_EPISODES,
            chapters: [
                { name: 'Part One', startMs: 61_603 },
                { name: 'Part Two', startMs: 9_999_999 },
            ],
        });

        expect(segments?.[0].source).toBe('runtime-split');
    });
});

describe('deriveFileSegments — runtime split path', () => {
    it('splits proportionally by per-episode runtime, normalized to real duration', () => {
        // 660 + 660 = 1320 vs 1354.602 actual -> 2.6% off, describes this file.
        const segments = derive({
            durationMs: RECESS_DURATION_MS,
            episodes: RECESS_EPISODES,
            chapters: [],
        });

        expect(segments?.[0].source).toBe('runtime-split');
        expect(segments?.[0].startMs).toBe(0);
        expect(segments?.[0].endMs).toBe(Math.round(RECESS_DURATION_MS / 2));
        expect(segments?.[1].endMs).toBe(RECESS_DURATION_MS);
    });

    it('respects uneven runtimes (two-part episode)', () => {
        // Real prod row: 2700 + 2640 vs 5383.689s duration.
        const durationMs = 5_383_689;
        const segments = derive({
            durationMs,
            episodes: [
                { mediaItemId: 'p1', episodeNumber: 1, runtimeMs: 2_700_000 },
                { mediaItemId: 'p2', episodeNumber: 2, runtimeMs: 2_640_000 },
            ],
            chapters: [],
        });

        const boundary = Math.round(durationMs * (2_700_000 / 5_340_000));
        expect(segments?.[0].endMs).toBe(boundary);
        expect(segments?.[1].startMs).toBe(boundary);
        expect(segments?.[1].endMs).toBe(durationMs);
        expect(segments![0].endMs - segments![0].startMs).toBeGreaterThan(
            segments![1].endMs - segments![1].startMs,
        );
    });

    it('covers the whole file with no gaps under the runtime split', () => {
        const segments = derive({
            durationMs: RECESS_DURATION_MS,
            episodes: RECESS_EPISODES,
            chapters: [],
        });

        expect(segments?.[0].startMs).toBe(0);
        expect(segments?.at(-1)?.endMs).toBe(RECESS_DURATION_MS);
        for (let i = 1; i < (segments?.length ?? 0); i++) {
            expect(segments?.[i].startMs).toBe(segments?.[i - 1].endMs);
        }
    });
});

describe('deriveFileSegments — even split when the runtimes describe something else', () => {
    // Provider runtime metadata is routinely wrong for combined releases: TMDB
    // records the COMBINED length against each part. These are all real prod
    // files that an earlier runtime-based guard refused to split.

    it('splits a two-part finale whose parts each claim the combined runtime', () => {
        // Luma - S06E17-18 - The End: 6283s file, 6300s recorded on BOTH halves.
        const durationMs = 6_283_000;
        const segments = derive({
            durationMs,
            episodes: [
                { mediaItemId: 'e17', episodeNumber: 17, runtimeMs: 6_300_000 },
                { mediaItemId: 'e18', episodeNumber: 18, runtimeMs: 6_300_000 },
            ],
            chapters: [],
        });

        expect(segments?.[0]).toEqual({
            mediaItemId: 'e17',
            startMs: 0,
            endMs: 3_141_500,
            source: 'even-split',
        });
        expect(segments?.[1].endMs).toBe(durationMs);
    });

    it('splits a mixed pair where only one part has the right runtime', () => {
        // Harborfolk.Grosse.Pause.S02E20E21: E20 660s (correct), E21 1320s (combined).
        const durationMs = 1_355_000;
        const segments = derive({
            durationMs,
            episodes: [
                { mediaItemId: 'e20', episodeNumber: 20, runtimeMs: 660_000 },
                { mediaItemId: 'e21', episodeNumber: 21, runtimeMs: 1_320_000 },
            ],
            chapters: [],
        });

        expect(segments?.[0].source).toBe('even-split');
        expect(segments?.[0].endMs).toBe(677_500);
    });

    it('splits a 12-segment shorts compilation', () => {
        // Kodomo no Jikan S01E01-02-...-12: 5167s of ~7min shorts, 1500s claimed each.
        const durationMs = 5_167_000;
        const segments = derive({
            durationMs,
            episodes: Array.from({ length: 12 }, (_, i) => ({
                mediaItemId: `e${i + 1}`,
                episodeNumber: i + 1,
                runtimeMs: 1_500_000,
            })),
            chapters: [],
        });

        expect(segments).toHaveLength(12);
        expect(segments?.every((s) => s.source === 'even-split')).toBe(true);
        expect(segments?.[0].startMs).toBe(0);
        expect(segments?.at(-1)?.endMs).toBe(durationMs);
        // Gapless across all twelve.
        for (let i = 1; i < 12; i++) {
            expect(segments?.[i].startMs).toBe(segments?.[i - 1].endMs);
        }
    });

    it('splits when runtimes are missing entirely', () => {
        const segments = derive({
            durationMs: RECESS_DURATION_MS,
            episodes: [
                { mediaItemId: 'a', episodeNumber: 1, runtimeMs: null },
                { mediaItemId: 'b', episodeNumber: 2, runtimeMs: null },
            ],
            chapters: [],
        });

        expect(segments?.[0].source).toBe('even-split');
        expect(segments?.[0].endMs).toBe(Math.round(RECESS_DURATION_MS / 2));
    });

    it('still prefers chapters over an even split when runtimes are wrong', () => {
        // Tomo.chan.Is.a.Girl.S01E07E08E09: 1420s of three ~8min shorts, each
        // claiming 1440s. Real chapter marks must win over equal shares.
        const durationMs = 1_420_000;
        const segments = derive({
            durationMs,
            episodes: [
                { mediaItemId: 'e7', episodeNumber: 7, runtimeMs: 1_440_000 },
                { mediaItemId: 'e8', episodeNumber: 8, runtimeMs: 1_440_000 },
                { mediaItemId: 'e9', episodeNumber: 9, runtimeMs: 1_440_000 },
            ],
            chapters: [
                { name: 'First Story', startMs: 0 },
                { name: 'Second Story', startMs: 500_000 },
                { name: 'Third Story', startMs: 950_000 },
            ],
        });

        expect(segments?.[0].source).toBe('chapter');
        expect(segments?.[1].startMs).toBe(500_000);
        expect(segments?.[2].startMs).toBe(950_000);
    });
});

describe('deriveFileSegments — provenance', () => {
    it('refuses when the filename declares no episode range', () => {
        // Rows linked from somewhere other than a combined release name: nothing
        // here knows the file holds several episodes, so do not guess.
        expect(
            derive({
                durationMs: RECESS_DURATION_MS,
                episodes: RECESS_EPISODES,
                chapters: RECESS_CHAPTERS,
                declaredEpisodeCount: null,
            }),
        ).toBeNull();
    });

    it('refuses when the filename declares a different number of episodes', () => {
        // S02E24 (one episode) but two rows attached — the link did not come from
        // the release name, so its provenance is unknown.
        expect(
            derive({
                durationMs: RECESS_DURATION_MS,
                episodes: RECESS_EPISODES,
                chapters: RECESS_CHAPTERS,
                declaredEpisodeCount: 1,
            }),
        ).toBeNull();
    });

    it('refuses when the filename declares more episodes than are linked', () => {
        expect(
            derive({
                durationMs: RECESS_DURATION_MS,
                episodes: RECESS_EPISODES,
                chapters: [],
                declaredEpisodeCount: 3,
            }),
        ).toBeNull();
    });
});

describe('deriveFileSegments — evidence preconditions', () => {
    it('rejects a NaN runtime instead of persisting NaN offsets', () => {
        // NaN fails every comparison, so a `<= 0` filter lets it through and it
        // poisons the split arithmetic into NaN bounds. It must fall to an even
        // split, whose bounds are finite by construction.
        const segments = derive({
            durationMs: 660_000,
            episodes: [
                { mediaItemId: 'a', episodeNumber: 1, runtimeMs: 330_000 },
                { mediaItemId: 'b', episodeNumber: 2, runtimeMs: Number.NaN },
            ],
            chapters: [],
        });

        expect(segments?.[0].source).toBe('even-split');
        for (const seg of segments ?? []) {
            expect(Number.isFinite(seg.startMs)).toBe(true);
            expect(Number.isFinite(seg.endMs)).toBe(true);
        }
    });

    it('never lets a NaN chapter offset reach the output', () => {
        const segments = derive({
            durationMs: 660_000,
            episodes: [
                { mediaItemId: 'a', episodeNumber: 1, runtimeMs: 330_000 },
                { mediaItemId: 'b', episodeNumber: 2, runtimeMs: 330_000 },
            ],
            chapters: [
                { name: 'First Half', startMs: 0 },
                { name: 'Second Half', startMs: Number.NaN },
            ],
        });

        expect(segments?.[0].source).toBe('runtime-split');
        for (const seg of segments ?? []) {
            expect(Number.isFinite(seg.startMs)).toBe(true);
            expect(Number.isFinite(seg.endMs)).toBe(true);
        }
    });

    it('refuses when an episode number is missing (order is unknowable)', () => {
        // Would otherwise sort the numbered episode first and hand it the OTHER
        // episode's window — each episode plays the other, with valid-looking bounds.
        expect(
            derive({
                durationMs: RECESS_DURATION_MS,
                episodes: [
                    { mediaItemId: 'really-ep23', episodeNumber: null, runtimeMs: 660_000 },
                    { mediaItemId: 'ep24', episodeNumber: 24, runtimeMs: 660_000 },
                ],
                chapters: RECESS_CHAPTERS,
            }),
        ).toBeNull();
    });

    it('refuses when episode numbers are duplicated', () => {
        expect(
            derive({
                durationMs: RECESS_DURATION_MS,
                episodes: [
                    { mediaItemId: 'a', episodeNumber: 24, runtimeMs: 660_000 },
                    { mediaItemId: 'b', episodeNumber: 24, runtimeMs: 660_000 },
                ],
                chapters: RECESS_CHAPTERS,
            }),
        ).toBeNull();
    });
});

describe('deriveFileSegments — chapters must corroborate when runtimes are usable', () => {
    it('rejects chapter marks that imply implausible lengths', () => {
        // Two late scene markers on a genuine double whose runtimes DO describe
        // the file: binding them would give episode 25 the last 64s of episode 24.
        const segments = derive({
            durationMs: RECESS_DURATION_MS,
            episodes: RECESS_EPISODES,
            chapters: [
                { name: 'Die Falle', startMs: 1_200_000 },
                { name: 'Finale', startMs: 1_290_000 },
            ],
        });

        expect(segments?.[0].source).toBe('runtime-split');
        expect(segments?.[0].endMs).toBe(Math.round(RECESS_DURATION_MS / 2));
    });
});

describe('deriveFileSegments — guards', () => {
    it('returns null for a single-episode file (nothing to segment)', () => {
        expect(
            derive({
                durationMs: 660_000,
                episodes: [{ mediaItemId: 'solo', episodeNumber: 1, runtimeMs: 660_000 }],
                chapters: [{ name: 'Opening', startMs: 0 }],
            }),
        ).toBeNull();
    });

    it('returns null when the file duration is unknown', () => {
        expect(
            derive({ durationMs: null, episodes: RECESS_EPISODES, chapters: RECESS_CHAPTERS }),
        ).toBeNull();
    });

    it('returns null when the file duration is zero', () => {
        expect(derive({ durationMs: 0, episodes: RECESS_EPISODES, chapters: [] })).toBeNull();
    });

    it('returns null for an empty episode list', () => {
        expect(
            derive({ durationMs: RECESS_DURATION_MS, episodes: [], chapters: RECESS_CHAPTERS }),
        ).toBeNull();
    });

    it('never produces a segment shorter than the sanity floor', () => {
        // A file too short to hold the episodes it claims: equal shares would be
        // under a minute each, which is no episode.
        expect(
            derive({
                durationMs: 100_000,
                episodes: [
                    { mediaItemId: 'a', episodeNumber: 1, runtimeMs: null },
                    { mediaItemId: 'b', episodeNumber: 2, runtimeMs: null },
                ],
                chapters: [],
            }),
        ).toBeNull();
    });
});
