// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect } from 'vitest';
import {
    extractEssentia,
    extractBpm,
    extractMoodTags,
    computeSeedCentroid,
    scoreCandidate,
    rankBrewCandidates,
    buildMoodIslandAnchors,
    parsePgVectorText,
    computeEmbeddingCentroid,
    blendSonicWithKnobs,
    rankBrewCandidatesBySonic,
    type BrewCandidateRow,
    type BrewSeedAcoustics,
} from './music-alchemy.queries.js';

// =============================================================================
// Helpers
// =============================================================================

function makeRow(
    id: string,
    essentia: Record<string, unknown>,
    overrides: Partial<BrewCandidateRow> = {},
): BrewCandidateRow {
    return {
        id,
        title: `Track ${id}`,
        custom_metadata: { essentia },
        custom_poster_url: null,
        parent_id: null,
        runtime_seconds: 180,
        play_count: 0,
        popularity_listeners: null,
        ...overrides,
    };
}

function makeCentroid(overrides: Partial<BrewSeedAcoustics> = {}): BrewSeedAcoustics {
    return {
        bpm: 128,
        energy: 0.7,
        danceability: 1.2,
        moodTags: ['energetic', 'happy'],
        ...overrides,
    };
}

// =============================================================================
// extractEssentia
// =============================================================================

describe('extractEssentia', () => {
    test('returns sub-object when present', () => {
        const meta = { essentia: { bpm: 120, energy: 0.5 } };
        expect(extractEssentia(meta)).toEqual({ bpm: 120, energy: 0.5 });
    });

    test('returns empty object when essentia is absent', () => {
        expect(extractEssentia({})).toEqual({});
    });

    test('returns empty object when essentia is a non-object value', () => {
        expect(extractEssentia({ essentia: 'bad' })).toEqual({});
        expect(extractEssentia({ essentia: 42 })).toEqual({});
        expect(extractEssentia({ essentia: null })).toEqual({});
        expect(extractEssentia({ essentia: [] })).toEqual({});
    });
});

// =============================================================================
// extractBpm
// =============================================================================

describe('extractBpm', () => {
    test('extracts numeric bpm', () => {
        expect(extractBpm({ bpm: 140 })).toBe(140);
    });

    test('parses string bpm', () => {
        expect(extractBpm({ bpm: '128.5' })).toBe(128.5);
    });

    test('returns undefined for missing bpm', () => {
        expect(extractBpm({})).toBeUndefined();
    });

    test('returns undefined for non-numeric string', () => {
        expect(extractBpm({ bpm: 'fast' })).toBeUndefined();
    });
});

// =============================================================================
// extractMoodTags
// =============================================================================

describe('extractMoodTags', () => {
    test('returns string array', () => {
        expect(extractMoodTags({ mood_tags: ['happy', 'energetic'] })).toEqual([
            'happy',
            'energetic',
        ]);
    });

    test('returns empty array when absent', () => {
        expect(extractMoodTags({})).toEqual([]);
    });

    test('filters non-string entries', () => {
        expect(extractMoodTags({ mood_tags: ['happy', 42, null, 'calm'] })).toEqual([
            'happy',
            'calm',
        ]);
    });
});

// =============================================================================
// computeSeedCentroid
// =============================================================================

describe('computeSeedCentroid', () => {
    test('averages acoustic fields across seeds', () => {
        const seeds = [
            { custom_metadata: { essentia: { bpm: 100, energy: 0.4, danceability: 0.8 } } },
            { custom_metadata: { essentia: { bpm: 120, energy: 0.6, danceability: 1.2 } } },
        ];
        const result = computeSeedCentroid(seeds);
        expect(result.bpm).toBe(110);
        expect(result.energy).toBe(0.5);
        expect(result.danceability).toBe(1.0);
    });

    test('unions mood tags from all seeds', () => {
        const seeds = [
            { custom_metadata: { essentia: { mood_tags: ['happy', 'calm'] } } },
            { custom_metadata: { essentia: { mood_tags: ['calm', 'dark'] } } },
        ];
        const result = computeSeedCentroid(seeds);
        expect(result.moodTags.sort()).toEqual(['calm', 'dark', 'happy']);
    });

    test('returns undefined for missing dimensions', () => {
        const seeds = [{ custom_metadata: {} }];
        const result = computeSeedCentroid(seeds);
        expect(result.bpm).toBeUndefined();
        expect(result.energy).toBeUndefined();
        expect(result.danceability).toBeUndefined();
    });

    test('handles empty seed list gracefully', () => {
        const result = computeSeedCentroid([]);
        expect(result.bpm).toBeUndefined();
        expect(result.moodTags).toEqual([]);
    });
});

// =============================================================================
// scoreCandidate
// =============================================================================

describe('scoreCandidate', () => {
    test('returns value in [0, 1]', () => {
        const row = makeRow('t1', { bpm: 128, energy: 0.7, danceability: 1.2 });
        const centroid = makeCentroid();
        const score = scoreCandidate(row, centroid, { energy: 0.7, tempo: 0.5, obscurity: 0.5 });
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
    });

    test('perfect match scores higher than mismatch', () => {
        const perfect = makeRow('t1', {
            bpm: 128,
            energy: 0.7,
            danceability: 1.2,
            mood_tags: ['energetic', 'happy'],
        });
        const mismatch = makeRow('t2', {
            bpm: 80,
            energy: 0.1,
            danceability: 0.2,
            mood_tags: ['sad', 'dark'],
        });
        const centroid = makeCentroid();
        const knobs = { energy: 0.7, tempo: 0.5, obscurity: 0.5 };
        const perfectScore = scoreCandidate(perfect, centroid, knobs);
        const mismatchScore = scoreCandidate(mismatch, centroid, knobs);
        expect(perfectScore).toBeGreaterThan(mismatchScore);
    });

    test('obscurity=1 boosts unpopular tracks over popular ones', () => {
        const unpopular = makeRow(
            't1',
            { bpm: 128, energy: 0.7 },
            { play_count: 0, popularity_listeners: null },
        );
        const popular = makeRow(
            't2',
            { bpm: 128, energy: 0.7 },
            { play_count: 100, popularity_listeners: 500_000 },
        );
        const centroid = makeCentroid({ moodTags: [] });
        const knobs = { energy: 0.5, tempo: 0.5, obscurity: 1.0 };
        const unpopularScore = scoreCandidate(unpopular, centroid, knobs);
        const popularScore = scoreCandidate(popular, centroid, knobs);
        expect(unpopularScore).toBeGreaterThan(popularScore);
    });

    test('obscurity=0 boosts popular tracks over obscure ones', () => {
        const unpopular = makeRow(
            't1',
            { bpm: 128, energy: 0.7 },
            { play_count: 0, popularity_listeners: null },
        );
        const popular = makeRow(
            't2',
            { bpm: 128, energy: 0.7 },
            { play_count: 100, popularity_listeners: 500_000 },
        );
        const centroid = makeCentroid({ moodTags: [] });
        const knobs = { energy: 0.5, tempo: 0.5, obscurity: 0.0 };
        const unpopularScore = scoreCandidate(unpopular, centroid, knobs);
        const popularScore = scoreCandidate(popular, centroid, knobs);
        expect(popularScore).toBeGreaterThan(unpopularScore);
    });

    test('returns neutral score for row with no acoustic data', () => {
        const row = makeRow('t1', {});
        const centroid = makeCentroid({
            bpm: undefined,
            energy: undefined,
            danceability: undefined,
            moodTags: [],
        });
        const score = scoreCandidate(row, centroid, { energy: 0.5, tempo: 0.5, obscurity: 0.5 });
        // All dimensions neutral (0.5) → score should be close to 0.5
        expect(score).toBeGreaterThanOrEqual(0.4);
        expect(score).toBeLessThanOrEqual(0.6);
    });
});

// =============================================================================
// rankBrewCandidates
// =============================================================================

describe('rankBrewCandidates', () => {
    test('returns sorted list by brewScore descending', () => {
        const rows: BrewCandidateRow[] = [
            makeRow('t1', { bpm: 80, energy: 0.1 }),
            makeRow('t2', { bpm: 128, energy: 0.7, mood_tags: ['energetic', 'happy'] }),
            makeRow('t3', { bpm: 200, energy: 0.2 }),
        ];
        const centroid = makeCentroid();
        const results = rankBrewCandidates(
            rows,
            centroid,
            { energy: 0.7, tempo: 0.5, obscurity: 0.5 },
            3,
        );
        // Each result should have a brewScore
        expect(results.every((r) => typeof r.brewScore === 'number')).toBe(true);
        // Sorted descending
        for (let i = 0; i < results.length - 1; i++) {
            expect(results[i].brewScore).toBeGreaterThanOrEqual(results[i + 1].brewScore);
        }
    });

    test('limits output to `limit` rows', () => {
        const rows: BrewCandidateRow[] = Array.from({ length: 10 }, (_, i) =>
            makeRow(`t${i}`, { bpm: 128, energy: 0.5 }),
        );
        const results = rankBrewCandidates(
            rows,
            makeCentroid(),
            { energy: 0.5, tempo: 0.5, obscurity: 0.5 },
            5,
        );
        expect(results).toHaveLength(5);
    });

    test('handles empty candidate pool', () => {
        const results = rankBrewCandidates(
            [],
            makeCentroid(),
            { energy: 0.5, tempo: 0.5, obscurity: 0.5 },
            20,
        );
        expect(results).toEqual([]);
    });
});

// =============================================================================
// buildMoodIslandAnchors
// =============================================================================

describe('buildMoodIslandAnchors', () => {
    test('returns islands for mood tags with enough tracks', () => {
        const rows = [
            makeRow('t1', { mood_tags: ['happy'], energy: 0.8, danceability: 1.4 }),
            makeRow('t2', { mood_tags: ['happy'], energy: 0.6, danceability: 1.0 }),
            makeRow('t3', { mood_tags: ['sad'], energy: 0.2, danceability: 0.4 }),
            makeRow('t4', { mood_tags: ['sad'], energy: 0.3, danceability: 0.5 }),
        ];
        const anchors = buildMoodIslandAnchors(rows);
        expect(anchors.length).toBeGreaterThan(0);
        const labels = anchors.map((a) => a.label);
        expect(labels).toContain('happy');
        expect(labels).toContain('sad');
    });

    test('x and y are in [0, 1]', () => {
        const rows = Array.from({ length: 5 }, (_, i) =>
            makeRow(`t${i}`, {
                mood_tags: ['energetic'],
                energy: Math.random(),
                danceability: Math.random() * 2,
            }),
        );
        const anchors = buildMoodIslandAnchors(rows);
        for (const a of anchors) {
            expect(a.x).toBeGreaterThanOrEqual(0);
            expect(a.x).toBeLessThanOrEqual(1);
            expect(a.y).toBeGreaterThanOrEqual(0);
            expect(a.y).toBeLessThanOrEqual(1);
        }
    });

    test('excludes moods with fewer than MIN_ISLAND_SIZE (2) tracks', () => {
        const rows = [makeRow('t1', { mood_tags: ['rare'] })];
        const anchors = buildMoodIslandAnchors(rows);
        expect(anchors.find((a) => a.label === 'rare')).toBeUndefined();
    });

    test('returns empty array when no tracks have mood data', () => {
        const rows = [makeRow('t1', {}), makeRow('t2', {})];
        expect(buildMoodIslandAnchors(rows)).toEqual([]);
    });

    test('sorts anchors by size descending', () => {
        const rows = [
            makeRow('t1', { mood_tags: ['small'] }),
            makeRow('t2', { mood_tags: ['small'] }),
            ...Array.from({ length: 4 }, (_, i) => makeRow(`t${i + 10}`, { mood_tags: ['big'] })),
        ];
        const anchors = buildMoodIslandAnchors(rows);
        if (anchors.length >= 2) {
            expect(anchors[0].size).toBeGreaterThanOrEqual(anchors[1].size);
        }
    });
});

// =============================================================================
// parsePgVectorText
// =============================================================================

describe('parsePgVectorText', () => {
    test('parses a valid vector literal', () => {
        const result = parsePgVectorText('[0.1,0.2,0.3]');
        expect(result).toEqual([0.1, 0.2, 0.3]);
    });

    test('handles spaces inside brackets', () => {
        const result = parsePgVectorText('[ 0.5, -0.5, 1.0 ]');
        expect(result).toEqual([0.5, -0.5, 1.0]);
    });

    test('returns empty array for empty vector', () => {
        const result = parsePgVectorText('[]');
        expect(result).toEqual([]);
    });

    test('returns null when missing opening bracket', () => {
        expect(parsePgVectorText('0.1,0.2')).toBeNull();
    });

    test('returns null when missing closing bracket', () => {
        expect(parsePgVectorText('[0.1,0.2')).toBeNull();
    });

    test('returns null for non-numeric entry', () => {
        expect(parsePgVectorText('[0.1,abc,0.3]')).toBeNull();
    });

    test('parses large 1024-dim vector', () => {
        const nums = Array.from({ length: 1024 }, (_, i) => i * 0.001);
        const literal = `[${nums.join(',')}]`;
        const result = parsePgVectorText(literal);
        expect(result).toHaveLength(1024);
        expect(result?.[0]).toBeCloseTo(0);
        expect(result?.[1023]).toBeCloseTo(1.023);
    });
});

// =============================================================================
// computeEmbeddingCentroid
// =============================================================================

describe('computeEmbeddingCentroid', () => {
    test('returns null for empty list', () => {
        expect(computeEmbeddingCentroid([])).toBeNull();
    });

    test('returns the single vector unchanged', () => {
        const result = computeEmbeddingCentroid([[0.2, 0.4, 0.6]]);
        expect(result).toEqual([0.2, 0.4, 0.6]);
    });

    test('correctly averages two vectors', () => {
        const result = computeEmbeddingCentroid([
            [0.0, 1.0, 0.5],
            [1.0, 0.0, 0.5],
        ]);
        expect(result).toEqual([0.5, 0.5, 0.5]);
    });

    test('returns null on dimension mismatch', () => {
        const result = computeEmbeddingCentroid([
            [0.1, 0.2],
            [0.1, 0.2, 0.3],
        ]);
        expect(result).toBeNull();
    });

    test('handles single-element vectors', () => {
        const result = computeEmbeddingCentroid([[42.0], [100.0]]);
        expect(result).toEqual([71.0]);
    });

    test('averages three vectors element-wise', () => {
        const result = computeEmbeddingCentroid([
            [0.0, 0.0],
            [1.0, 0.0],
            [0.5, 0.9],
        ]);
        expect(result?.[0]).toBeCloseTo((0 + 1 + 0.5) / 3);
        expect(result?.[1]).toBeCloseTo((0 + 0 + 0.9) / 3);
    });
});

// =============================================================================
// blendSonicWithKnobs
// =============================================================================

describe('blendSonicWithKnobs', () => {
    function makeSonicRow(
        id: string,
        sonicScore: number,
        overrides: Partial<BrewCandidateRow> = {},
    ): BrewCandidateRow & { sonic_score: number } {
        return {
            ...makeRow(id, {}),
            sonic_score: sonicScore,
            play_count: overrides.play_count ?? 0,
            popularity_listeners: overrides.popularity_listeners ?? null,
        };
    }

    test('returns value in [0, 1]', () => {
        const row = makeSonicRow('t1', 0.8);
        const score = blendSonicWithKnobs(row, { obscurity: 0.5 });
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
    });

    test('higher sonic_score produces higher blend score (neutral obscurity)', () => {
        const high = makeSonicRow('t1', 0.9);
        const low = makeSonicRow('t2', 0.1);
        const knobs = { obscurity: 0.5 };
        expect(blendSonicWithKnobs(high, knobs)).toBeGreaterThan(blendSonicWithKnobs(low, knobs));
    });

    test('obscurity=1 boosts unpopular track over popular one (same sonic score)', () => {
        const unpopular = makeSonicRow('t1', 0.7, { play_count: 0, popularity_listeners: null });
        const popular = makeSonicRow('t2', 0.7, {
            play_count: 200,
            popularity_listeners: 1_000_000,
        });
        const knobs = { obscurity: 1.0 };
        expect(blendSonicWithKnobs(unpopular, knobs)).toBeGreaterThan(
            blendSonicWithKnobs(popular, knobs),
        );
    });

    test('obscurity=0 boosts popular track over obscure one (same sonic score)', () => {
        const unpopular = makeSonicRow('t1', 0.7, { play_count: 0, popularity_listeners: null });
        const popular = makeSonicRow('t2', 0.7, {
            play_count: 200,
            popularity_listeners: 1_000_000,
        });
        const knobs = { obscurity: 0.0 };
        expect(blendSonicWithKnobs(popular, knobs)).toBeGreaterThan(
            blendSonicWithKnobs(unpopular, knobs),
        );
    });

    test('sonic weight dominates (0.80) — sonic difference of 0.5 outweighs obscurity', () => {
        // Both obscure; but one has much better sonic score
        const highSonic = makeSonicRow('t1', 0.9, { play_count: 0 });
        const lowSonic = makeSonicRow('t2', 0.4, { play_count: 0 });
        const knobs = { obscurity: 0.5 };
        expect(blendSonicWithKnobs(highSonic, knobs)).toBeGreaterThan(
            blendSonicWithKnobs(lowSonic, knobs),
        );
    });
});

// =============================================================================
// rankBrewCandidatesBySonic
// =============================================================================

describe('rankBrewCandidatesBySonic', () => {
    function makeSonicRow(
        id: string,
        sonicScore: number,
    ): BrewCandidateRow & { sonic_score: number } {
        return { ...makeRow(id, {}), sonic_score: sonicScore };
    }

    test('returns sorted list by brewScore descending', () => {
        const rows = [makeSonicRow('t1', 0.3), makeSonicRow('t2', 0.9), makeSonicRow('t3', 0.6)];
        const results = rankBrewCandidatesBySonic(rows, { obscurity: 0.5 }, 3);
        expect(results.every((r) => typeof r.brewScore === 'number')).toBe(true);
        for (let i = 0; i < results.length - 1; i++) {
            expect(results[i].brewScore).toBeGreaterThanOrEqual(results[i + 1].brewScore);
        }
    });

    test('limits output to `limit` rows', () => {
        const rows = Array.from({ length: 10 }, (_, i) => makeSonicRow(`t${i}`, Math.random()));
        const results = rankBrewCandidatesBySonic(rows, { obscurity: 0.5 }, 4);
        expect(results).toHaveLength(4);
    });

    test('handles empty pool', () => {
        expect(rankBrewCandidatesBySonic([], { obscurity: 0.5 }, 10)).toEqual([]);
    });

    test('each result has sonicScore field', () => {
        const rows = [makeSonicRow('t1', 0.7), makeSonicRow('t2', 0.4)];
        const results = rankBrewCandidatesBySonic(rows, { obscurity: 0.5 }, 2);
        for (const r of results) {
            expect(typeof r.sonicScore).toBe('number');
        }
    });
});
