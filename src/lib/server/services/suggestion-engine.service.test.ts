// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SuggestionEngineService Unit Tests
 *
 * Tests the core suggestion generation pipeline methods extracted from Database class.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseEpisodeQuery, calculateCosineSimilarity } from '../utils/suggestion-utils.js';
import { SuggestionEngineService, type SuggestionEngineDeps } from './suggestion-engine.service.js';
import type { CatalogService } from './catalog.service.js';
import type { UserId } from '$lib/shared/user-id';
import type { UserProfile, MediaEmbedding } from '../database/connection.js';
import type { UserSuggestionRow } from '../database/queries/suggestion-management.queries.js';
import type { SimilarMediaDualRow } from '../database/queries/suggestion-search.queries.js';

describe('SuggestionUtils', () => {
    describe('parseEpisodeQuery', () => {
        it('should parse standard episode notation', () => {
            const result = parseEpisodeQuery('Drifting Clouds S5E14');
            expect(result).toEqual({
                seriesName: 'Drifting Clouds',
                season: 5,
                episode: 14,
            });
        });

        it('should parse lowercase notation', () => {
            const result = parseEpisodeQuery('marshalls s37e13');
            expect(result).toEqual({
                seriesName: 'marshalls',
                season: 37,
                episode: 13,
            });
        });

        it('should parse zero-padded notation', () => {
            const result = parseEpisodeQuery('Lanterns of Winter S01E04');
            expect(result).toEqual({
                seriesName: 'Lanterns of Winter',
                season: 1,
                episode: 4,
            });
        });

        it('should handle series names with spaces', () => {
            const result = parseEpisodeQuery('The Wandering Stars S11E24');
            expect(result).toEqual({
                seriesName: 'The Wandering Stars',
                season: 11,
                episode: 24,
            });
        });

        it('should return null for queries without episode notation', () => {
            expect(parseEpisodeQuery('Drifting Clouds')).toBeNull();
            expect(parseEpisodeQuery('Season 5')).toBeNull();
            expect(parseEpisodeQuery('Episode 14')).toBeNull();
        });

        it('should return null for invalid season/episode numbers', () => {
            expect(parseEpisodeQuery('Show S0E5')).toBeNull();
            expect(parseEpisodeQuery('Show S5E0')).toBeNull();
            expect(parseEpisodeQuery('S5E14')).toBeNull(); // Missing series name
        });

        it('should handle extra whitespace', () => {
            const result = parseEpisodeQuery('  Drifting Clouds   S5E14  ');
            expect(result).toEqual({
                seriesName: 'Drifting Clouds',
                season: 5,
                episode: 14,
            });
        });
    });

    describe('calculateCosineSimilarity', () => {
        it('should calculate similarity for identical vectors', () => {
            const vec = [0.1, 0.2, 0.3, 0.4];
            const similarity = calculateCosineSimilarity(vec, vec);
            expect(similarity).toBeCloseTo(1.0, 5);
        });

        it('should calculate similarity for similar vectors', () => {
            const vecA = [0.1, 0.2, 0.3];
            const vecB = [0.15, 0.25, 0.35];
            const similarity = calculateCosineSimilarity(vecA, vecB);
            expect(similarity).toBeGreaterThan(0.99);
            expect(similarity).toBeLessThanOrEqual(1.0);
        });

        it('should calculate similarity for orthogonal vectors', () => {
            const vecA = [1, 0, 0];
            const vecB = [0, 1, 0];
            const similarity = calculateCosineSimilarity(vecA, vecB);
            expect(similarity).toBeCloseTo(0, 5);
        });

        it('should calculate similarity for opposite vectors', () => {
            const vecA = [1, 2, 3];
            const vecB = [-1, -2, -3];
            const similarity = calculateCosineSimilarity(vecA, vecB);
            expect(similarity).toBeCloseTo(-1.0, 5);
        });

        it('should handle normalized embeddings (OpenAI style)', () => {
            // OpenAI embeddings are normalized to length 1
            const vecA = [0.577, 0.577, 0.577]; // Approximately normalized [1,1,1]
            const vecB = [0.707, 0.707, 0]; // Approximately normalized [1,1,0]
            const similarity = calculateCosineSimilarity(vecA, vecB);
            expect(similarity).toBeGreaterThan(0.8);
            expect(similarity).toBeLessThan(1.0);
        });

        it('should return 0 for mismatched dimensions', () => {
            const vecA = [0.1, 0.2, 0.3];
            const vecB = [0.1, 0.2];
            const similarity = calculateCosineSimilarity(vecA, vecB);
            expect(similarity).toBe(0);
        });

        it('should return 0 for empty vectors', () => {
            const similarity = calculateCosineSimilarity([], []);
            expect(similarity).toBe(0);
        });

        it('should return 0 for zero magnitude vectors', () => {
            const vecA = [0, 0, 0];
            const vecB = [1, 2, 3];
            const similarity = calculateCosineSimilarity(vecA, vecB);
            expect(similarity).toBe(0);
        });

        it('should handle JSONB string input', () => {
            const vecA = '[0.1, 0.2, 0.3]';
            const vecB = '[0.15, 0.25, 0.35]';
            const similarity = calculateCosineSimilarity(vecA, vecB);
            expect(similarity).toBeGreaterThan(0.99);
        });

        it('should handle mixed array and string input', () => {
            const vecA = [0.1, 0.2, 0.3];
            const vecB = '[0.1, 0.2, 0.3]';
            const similarity = calculateCosineSimilarity(vecA, vecB);
            expect(similarity).toBeCloseTo(1.0, 5);
        });

        it('should clamp results to [-1, 1] range', () => {
            // Even with floating point errors, should stay in valid range
            const vecA = [1e10, 1e10, 1e10];
            const vecB = [1e10, 1e10, 1e10];
            const similarity = calculateCosineSimilarity(vecA, vecB);
            expect(similarity).toBeGreaterThanOrEqual(-1);
            expect(similarity).toBeLessThanOrEqual(1);
        });

        it('should return 0 for invalid input', () => {
            expect(calculateCosineSimilarity('invalid', [1, 2, 3])).toBe(0);
            expect(calculateCosineSimilarity([1, 2, 3], 'invalid')).toBe(0);
            expect(calculateCosineSimilarity(null as never, [1, 2, 3])).toBe(0);
            expect(calculateCosineSimilarity([1, 2, 3], undefined as never)).toBe(0);
        });
    });
});

// =============================================================================
// SuggestionEngineService — engine-speed fixes (Task 2)
// =============================================================================

const USER = 'user-1' as unknown as UserId;

/**
 * Minimal typed stub for SuggestionEngineDeps. Individual tests override the
 * methods they exercise with vi.fn() spies.
 */
function makeDeps(overrides: Partial<SuggestionEngineDeps> = {}): SuggestionEngineDeps {
    return {
        getUserProfile: vi.fn().mockResolvedValue(null),
        getUserRatingsWithUuid: vi.fn().mockResolvedValue([]),
        getUserRatings: vi.fn().mockResolvedValue([]),
        getMediaEmbeddingByUuid: vi.fn().mockResolvedValue(null),
        getMediaEmbeddingsByUuids: vi.fn().mockResolvedValue(new Map<string, MediaEmbedding>()),
        getMediaEmbedding: vi.fn().mockResolvedValue(null),
        ...overrides,
    };
}

/** Build a SuggestionEngineRow-ish stored suggestion for a given ext id / type. */
function storedRow(primaryExtId: string, mediaType: 'movie' | 'tv' = 'movie'): UserSuggestionRow {
    return {
        id: Number(primaryExtId),
        user_id: String(USER),
        media_id: `uuid-${primaryExtId}`,
        primary_ext_id: primaryExtId,
        media_type: mediaType,
        cache_context: 'general',
        library_similarity_score: 0.9,
        discovery_similarity_score: null,
        combined_score: 0.9,
        suggestion_reason: 'stored',
        reason_data: null,
        is_available: true,
        can_request: false,
        created_at: new Date(),
        expires_at: new Date(Date.now() + 86_400_000),
    };
}

/** Build a diversity-filter candidate (SimilarMediaDualRow + randomized_score). */
function candidate(
    extId: string,
    genre: string,
): SimilarMediaDualRow & { randomized_score: number } {
    return {
        media_uuid: `uuid-${extId}`,
        primary_ext_id: extId,
        media_type: 'movie',
        combined_score: 0.8,
        library_similarity: 0.8,
        discovery_similarity: null,
        quality_score: 0.5,
        popularity_score: 0.5,
        has_library_embedding: true,
        has_discovery_embedding: false,
        is_available: true,
        genres: [genre],
        randomized_score: 0.8,
    } as unknown as SimilarMediaDualRow & { randomized_score: number };
}

function makeEngine(deps: SuggestionEngineDeps): SuggestionEngineService {
    // sql + catalogService are not exercised by the private methods under test.
    return new SuggestionEngineService({} as never, deps, {} as unknown as CatalogService);
}

/** Access a private method in a typed-enough way for the tests. */
type PrivateEngine = {
    getUserSuggestions: ReturnType<typeof vi.fn>;
    _loadStoredIfFresh(
        userId: UserId,
        limit: number,
        excludeItems: Array<{ primary_ext_id: string; media_type: 'movie' | 'tv' }>,
        mediaTypeFilter: 'movie' | 'tv' | undefined,
        refresh: boolean,
    ): Promise<UserSuggestionRow[] | null>;
    _applyDiversityFilters(
        candidates: Array<SimilarMediaDualRow & { randomized_score: number }>,
        userProfile: UserProfile,
        userId: UserId,
        limit: number,
    ): Promise<unknown[]>;
    _scoreAndRankCandidates(
        candidates: SimilarMediaDualRow[],
        userProfile: UserProfile,
    ): Array<SimilarMediaDualRow & { randomized_score: number }>;
    _diversifyAndInterleave(
        rows: SimilarMediaDualRow[],
        userId: UserId,
        limit: number,
        availabilityPreference: number,
        scoreOf: (r: SimilarMediaDualRow) => number,
    ): SimilarMediaDualRow[];
};

/** Build a scored candidate row with control over availability + genre + score. */
function scoredRow(
    extId: string,
    opts: {
        genre?: string;
        combinedScore?: number;
        qualityScore?: number;
        available?: boolean;
    } = {},
): SimilarMediaDualRow {
    const available = opts.available ?? true;
    return {
        media_uuid: `uuid-${extId}`,
        primary_ext_id: extId,
        media_type: 'movie',
        combined_score: opts.combinedScore ?? 0.8,
        library_similarity: available ? 0.8 : null,
        discovery_similarity: available ? null : 0.8,
        quality_score: opts.qualityScore ?? 0.5,
        popularity_score: 0.5,
        has_library_embedding: available,
        has_discovery_embedding: !available,
        is_available: available,
        genres: [opts.genre ?? 'Action'],
    } as unknown as SimilarMediaDualRow;
}

describe('SuggestionEngineService — F3 stored-fresh short-circuit', () => {
    it('serves stored suggestions without regenerating when fresh rows suffice', async () => {
        const deps = makeDeps();
        const engine = makeEngine(deps) as unknown as PrivateEngine;
        const getUserSuggestions = vi
            .fn()
            .mockResolvedValue([storedRow('1'), storedRow('2'), storedRow('3')]);
        engine.getUserSuggestions = getUserSuggestions;

        const result = await engine._loadStoredIfFresh(USER, 3, [], undefined, false);

        expect(result).not.toBeNull();
        expect(result).toHaveLength(3);
        // getUserProfile / vector search must never be consulted on this path.
        expect(deps.getUserProfile).not.toHaveBeenCalled();
    });

    it('bypasses stored suggestions when refresh=true (falls through to generation)', async () => {
        const deps = makeDeps();
        const engine = makeEngine(deps) as unknown as PrivateEngine;
        const getUserSuggestions = vi.fn().mockResolvedValue([storedRow('1'), storedRow('2')]);
        engine.getUserSuggestions = getUserSuggestions;

        const result = await engine._loadStoredIfFresh(USER, 2, [], undefined, true);

        expect(result).toBeNull();
        expect(getUserSuggestions).not.toHaveBeenCalled();
    });

    it('returns null when stored rows are insufficient (must regenerate)', async () => {
        const deps = makeDeps();
        const engine = makeEngine(deps) as unknown as PrivateEngine;
        engine.getUserSuggestions = vi.fn().mockResolvedValue([storedRow('1')]);

        const result = await engine._loadStoredIfFresh(USER, 3, [], undefined, false);

        expect(result).toBeNull();
    });

    it('honors excludeItems: excluded rows do not count toward the limit', async () => {
        const deps = makeDeps();
        const engine = makeEngine(deps) as unknown as PrivateEngine;
        // 3 stored rows, but one (ext id 2) is excluded → only 2 usable < limit 3.
        engine.getUserSuggestions = vi
            .fn()
            .mockResolvedValue([storedRow('1'), storedRow('2'), storedRow('3')]);

        const result = await engine._loadStoredIfFresh(
            USER,
            3,
            [{ primary_ext_id: '2', media_type: 'movie' }],
            undefined,
            false,
        );

        expect(result).toBeNull();
    });

    it('honors excludeItems: served set never contains an excluded key', async () => {
        const deps = makeDeps();
        const engine = makeEngine(deps) as unknown as PrivateEngine;
        engine.getUserSuggestions = vi
            .fn()
            .mockResolvedValue([storedRow('1'), storedRow('2'), storedRow('3'), storedRow('4')]);

        const result = await engine._loadStoredIfFresh(
            USER,
            3,
            [{ primary_ext_id: '2', media_type: 'movie' }],
            undefined,
            false,
        );

        expect(result).not.toBeNull();
        expect(result).toHaveLength(3);
        expect(result?.some((r) => r.primary_ext_id === '2')).toBe(false);
    });
});

describe('SuggestionEngineService — Q12b no double-quality', () => {
    it('ranking score equals combined_score (quality is NOT re-blended in JS)', () => {
        const engine = makeEngine(makeDeps()) as unknown as PrivateEngine;
        const rows = [
            scoredRow('1', { combinedScore: 0.5, qualityScore: 0.9 }),
            scoredRow('2', { combinedScore: 0.5, qualityScore: 0.1 }),
        ];
        const ranked = engine._scoreAndRankCandidates(rows, {} as unknown as UserProfile);
        // combined_score carried straight through; quality does not perturb it.
        expect(ranked.every((r) => r.randomized_score === (r.combined_score || 0))).toBe(true);
        // Two items with identical combined_score but different quality tie exactly
        // (would differ if quality were re-applied a second time).
        expect(ranked[0].randomized_score).toBe(ranked[1].randomized_score);
    });
});

describe('SuggestionEngineService — Q4 seeded selection (no jitter)', () => {
    it('is deterministic for the same user within a day, and varies by user', () => {
        const engine = makeEngine(makeDeps()) as unknown as PrivateEngine;
        // Equal scores + same genre → order is decided purely by the seeded PRNG
        // tie-break, so it must be stable per-seed and differ across users.
        const build = (): SimilarMediaDualRow[] =>
            ['1', '2', '3', '4', '5', '6'].map((id) =>
                scoredRow(id, { genre: 'Action', combinedScore: 0.5 }),
            );

        const orderFor = (user: string): string[] =>
            engine
                ._diversifyAndInterleave(
                    build(),
                    user as unknown as UserId,
                    6,
                    0.7,
                    (r) => r.combined_score ?? 0,
                )
                .map((r) => r.media_uuid);

        const a1 = orderFor('user-a');
        const a2 = orderFor('user-a');
        const b = orderFor('user-b');

        // Same user + same day → identical order.
        expect(a1).toEqual(a2);
        // Different user → different order (seed differs).
        expect(a1).not.toEqual(b);
        // All six items are still present (no drops).
        expect(new Set(a1)).toEqual(
            new Set(['uuid-1', 'uuid-2', 'uuid-3', 'uuid-4', 'uuid-5', 'uuid-6']),
        );
    });

    it('encodes the final order into a strictly-decreasing combined_score', () => {
        const engine = makeEngine(makeDeps()) as unknown as PrivateEngine;
        const rows = ['1', '2', '3', '4'].map((id) =>
            scoredRow(id, { genre: `G${id}`, combinedScore: 0.5 + Number(id) / 100 }),
        );
        const out = engine._diversifyAndInterleave(
            rows,
            'user-a' as unknown as UserId,
            4,
            0.7,
            (r) => r.combined_score ?? 0,
        );
        for (let i = 0; i < out.length - 1; i++) {
            // Serve path is ORDER BY combined_score DESC — must match array order.
            expect(out[i].combined_score).toBeGreaterThan(out[i + 1].combined_score);
        }
    });
});

describe('SuggestionEngineService — Q5 availability interleave', () => {
    it('respects the availability ratio instead of a strict library-first partition', () => {
        const engine = makeEngine(makeDeps()) as unknown as PrivateEngine;
        // 10 high-score available + 10 low-score requestable. A pure score sort
        // would return all 10 available; the interleave must inject requestable.
        const rows: SimilarMediaDualRow[] = [];
        for (let i = 0; i < 10; i++) {
            rows.push(scoredRow(`a${i}`, { genre: `AV${i}`, combinedScore: 0.9, available: true }));
        }
        for (let i = 0; i < 10; i++) {
            rows.push(
                scoredRow(`r${i}`, { genre: `RQ${i}`, combinedScore: 0.1, available: false }),
            );
        }

        const out = engine._diversifyAndInterleave(
            rows,
            'user-a' as unknown as UserId,
            10,
            0.7, // ~70% available
            (r) => r.combined_score ?? 0,
        );

        expect(out).toHaveLength(10);
        const availableCount = out.filter((r) => r.has_library_embedding).length;
        const requestableCount = out.filter((r) => !r.has_library_embedding).length;
        // ceil(10 * 0.7) = 7 available, 3 requestable.
        expect(availableCount).toBe(7);
        expect(requestableCount).toBe(3);
        // A requestable item surfaces early (by the 3rd slot) — not buried after
        // every available item as the old +0.35 offset forced.
        expect(out.slice(0, 3).some((r) => !r.has_library_embedding)).toBe(true);
    });

    it('backfills to limit when one bucket is short of its ratio target', () => {
        const engine = makeEngine(makeDeps()) as unknown as PrivateEngine;
        // Only 1 requestable but ratio 0.7 reserves 3 slots for requestable at
        // limit 10 → naive interleave would emit fewer than 10; backfill fixes it.
        const rows: SimilarMediaDualRow[] = [];
        for (let i = 0; i < 12; i++) {
            rows.push(scoredRow(`a${i}`, { genre: `AV${i}`, combinedScore: 0.9, available: true }));
        }
        rows.push(scoredRow('r0', { genre: 'RQ', combinedScore: 0.1, available: false }));

        const out = engine._diversifyAndInterleave(
            rows,
            'user-a' as unknown as UserId,
            10,
            0.7,
            (r) => r.combined_score ?? 0,
        );
        expect(out).toHaveLength(10);
    });
});

describe('SuggestionEngineService — F2 reason-generation N+1', () => {
    it('fetches user ratings once and batches embeddings once for the whole set', async () => {
        const getUserRatings = vi.fn().mockResolvedValue([{ rating: 9 }, { rating: 3 }]);
        const getMediaEmbeddingsByUuids = vi
            .fn()
            .mockResolvedValue(new Map<string, MediaEmbedding>());
        const getMediaEmbeddingByUuid = vi.fn();
        const deps = makeDeps({
            getUserRatings,
            getMediaEmbeddingsByUuids,
            getMediaEmbeddingByUuid,
        });
        const engine = makeEngine(deps) as unknown as PrivateEngine;

        const userProfile = {
            preferences: { created_from: 'ratings' },
        } as unknown as UserProfile;

        // Three distinct-genre candidates so all survive diversity selection.
        const candidates = [
            candidate('10', 'Action'),
            candidate('11', 'Comedy'),
            candidate('12', 'Drama'),
        ];

        const suggestions = await engine._applyDiversityFilters(candidates, userProfile, USER, 3);

        expect(suggestions).toHaveLength(3);
        // Hoisted: called exactly once regardless of candidate count.
        expect(getUserRatings).toHaveBeenCalledTimes(1);
        // Batched: single embeddings fetch, and the per-item single fetch is unused.
        expect(getMediaEmbeddingsByUuids).toHaveBeenCalledTimes(1);
        expect(getMediaEmbeddingByUuid).not.toHaveBeenCalled();
    });
});
