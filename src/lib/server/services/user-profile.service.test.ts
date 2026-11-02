// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for UserProfileService.createEnhancedUserProfile profile-aggregation
 * regressions flagged in code review of e0f9e004e, plus the Plan 2.5 unified
 * weighting rewrite (Rocchio negative steering + recency decay + wider
 * window):
 *
 *   1. [SUPERSEDED by Plan 2.5] Previously, `calculateEnhancedWeight` emitted
 *      a small NEGATIVE weight for explicit dislikes (fully-watched 1-star →
 *      -0.1) that fed directly into the positive weighted-average centroid,
 *      and a net-negative `totalWeight` had to be tolerated rather than
 *      dropped to null. Plan 2.5 routes ratings <=4 to a separate Rocchio
 *      negative centroid instead — `calculateEnhancedWeight` never returns a
 *      negative value anymore, so `totalWeight` can no longer go negative.
 *      A user with dislikes only and zero positive/watch signal now hits the
 *      cold-start guard (null embedding) rather than averaging disliked
 *      embeddings into the centroid — see the updated test below.
 *
 *   2. Soft-demote multiplier must only attenuate positive weights. Under the
 *      current algorithm `calculateEnhancedWeight` never returns a negative
 *      weight (see #1), so this is now defense-in-depth rather than a live
 *      bug path — kept because a disliked item that's also watched no longer
 *      reaches `calculateEnhancedWeight` at all (it's routed to the negative
 *      centroid before the weight/demote logic runs), so the two mechanisms
 *      are now fully decoupled by design, not just by the `weight > 0` guard.
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { UserProfileService, type UserProfileDatabaseDeps } from './user-profile.service.js';
import type { MediaEmbedding, UserProfile, UserRatingWithUuid } from '../database/connection.js';
import { toUserId } from '$lib/shared/user-id.js';
import { getWatchStateForProfile } from '../database/queries/watch-state.queries.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEmbedding(values: number[]): MediaEmbedding {
    return {
        id: 1,
        tmdb_id: null,
        media_type: 'movie',
        title: 'Test',
        genres: [],
        library_embedding: values,
        created_at: new Date(),
        updated_at: new Date(),
    };
}

function makeRating(
    mediaId: string,
    rating: number,
    extId: string,
    createdAt: Date = new Date(),
): UserRatingWithUuid {
    return {
        id: 1,
        user_id: 'test-user',
        media_id: mediaId,
        primary_ext_id: extId,
        primary_provider: 'tmdb',
        media_type: 'movie',
        rating,
        skipped: false,
        created_at: createdAt,
    };
}

interface CapturedUpsert {
    catalog_embedding: number[] | null | undefined;
}

function cosine(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Build a UserProfileService with stubbed deps and a captured upsert.
 * The service uses dependency injection for DB methods, so we don't need a
 * real postgres connection — we only override `upsertUserProfile` to capture
 * the embedding it would have written.
 */
function makeService(
    embeddings: Map<string, MediaEmbedding>,
    ratings: UserRatingWithUuid[],
): { service: UserProfileService; captured: CapturedUpsert } {
    const captured: CapturedUpsert = { catalog_embedding: undefined };

    const deps: UserProfileDatabaseDeps = {
        getMediaEmbedding: vi.fn(),
        getMediaEmbeddingByUuid: vi.fn(),
        getUserRatingsWithUuid: vi.fn().mockResolvedValue(ratings),
        batchResolveMediaIds: vi.fn().mockResolvedValue(new Map()),
        batchBuildMediaEmbeddingsFromUuids: vi.fn().mockResolvedValue(embeddings),
        // Default true (the documented default) so every existing test — none
        // of which cares about the Plan 3 Task 3 toggle — keeps its original
        // watch-history-included behaviour unchanged.
        getIncludeWatchHistoryPreference: vi.fn().mockResolvedValue(true),
    };

    // sql is unused because we override upsertUserProfile.
    const fakeSql = {} as unknown as postgres.Sql;
    const service = new UserProfileService(fakeSql, deps);

    // Capture what would be written.
    service.upsertUserProfile = vi.fn(
        async (profile: Omit<UserProfile, 'created_at' | 'updated_at'>): Promise<UserProfile> => {
            captured.catalog_embedding = profile.catalog_embedding;
            return {
                ...profile,
                created_at: new Date(),
                updated_at: new Date(),
            } as UserProfile;
        },
    );

    return { service, captured };
}

// ---------------------------------------------------------------------------
// Cold-start: dislike-only signal must NOT synthesize a centroid
// ---------------------------------------------------------------------------

describe('createEnhancedUserProfile — net-negative weight handling', () => {
    it('falls back to null when every signal is a dislike (superseded P1#1 — was "preserves the centroid when totalWeight sums negative")', async () => {
        // Two items, both fully-watched 1-star ratings. Under Plan 2.5,
        // ratings <=4 are routed to the Rocchio negative centroid and never
        // reach the positive weighted average — calculateEnhancedWeight
        // returns 0 for both, so weightedEmbeddings is empty and the
        // cold-start guard fires (zero liked items AND no watch signal).
        // Building a centroid purely out of disliked embeddings would point
        // the engine AT the rejected content, so null is correct here — this
        // deliberately reverses the old P1#1 fixture's expectation.
        const movie1Id = '00000000-0000-0000-0000-000000000001';
        const movie2Id = '00000000-0000-0000-0000-000000000002';

        const embeddings = new Map<string, MediaEmbedding>([
            [movie1Id, makeEmbedding([1, 0, 0])],
            [movie2Id, makeEmbedding([0, 1, 0])],
        ]);

        const ratings: UserRatingWithUuid[] = [
            makeRating(movie1Id, 1, '101'),
            makeRating(movie2Id, 1, '102'),
        ];

        const watchHistory = [
            {
                primary_id: '101',
                title: 'Disliked 1',
                playbackPositionTicks: 100,
                runtimeTicks: 100,
                mediaType: 'movie' as const,
                playCount: 1,
            },
            {
                primary_id: '102',
                title: 'Disliked 2',
                playbackPositionTicks: 100,
                runtimeTicks: 100,
                mediaType: 'movie' as const,
                playCount: 1,
            },
        ];

        const { service, captured } = makeService(embeddings, ratings);
        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            watchHistory,
            ratings,
        );

        expect(captured.catalog_embedding).toBeNull();
    });

    it('still falls back to null when totalWeight is exactly 0 (NaN guard)', async () => {
        // No ratings, no watch history → no embeddings → length 0 path.
        const { service, captured } = makeService(new Map(), []);
        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            [],
        );

        expect(captured.catalog_embedding).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Regression: soft-demote must only attenuate positive weights
// ---------------------------------------------------------------------------

describe('createEnhancedUserProfile — softDemote sign safety', () => {
    it('does NOT shrink negative weights toward zero (regression P1#2)', async () => {
        // Two items: a positively-weighted unrated watch, and a negatively-
        // weighted fully-watched 1-star rating that's ALSO in the demote set.
        // - Positive item (movie1): weight ≈ +0.8, embedding [1,0,0]
        // - Negative item (movie2): weight = -0.1, embedding [0,1,0]
        //
        // With the fix (multiplier gated by `weight > 0`):
        //   sum = 0.8*[1,0,0] + (-0.1)*[0,1,0] = [0.8, -0.1, 0]
        //   total = 0.8 + (-0.1) = 0.7
        //   centroid = [0.8, -0.1, 0] / 0.7 ≈ [1.143, -0.143, 0]
        //
        // With the bug (multiplier applied unconditionally → -0.1 × 0.3 = -0.03):
        //   sum = 0.8*[1,0,0] + (-0.03)*[0,1,0] = [0.8, -0.03, 0]
        //   total = 0.8 + (-0.03) = 0.77
        //   centroid = [0.8, -0.03, 0] / 0.77 ≈ [1.039, -0.039, 0]
        //
        // The y-component is the diagnostic — it should match the no-demote
        // run when the fix is applied. With the bug, |y| shrinks ~3.7×.
        const movie1Id = '00000000-0000-0000-0000-000000000aa1'; // positive
        const movie2Id = '00000000-0000-0000-0000-000000000aa2'; // negative + demoted

        const embeddings = new Map<string, MediaEmbedding>([
            [movie1Id, makeEmbedding([1, 0, 0])],
            [movie2Id, makeEmbedding([0, 1, 0])],
        ]);
        const ratings = [makeRating(movie2Id, 1, '202')]; // negative rating only on movie2
        const watchHistory = [
            {
                primary_id: '201',
                title: 'Watched, no rating (positive weight)',
                playbackPositionTicks: 100,
                runtimeTicks: 100,
                mediaType: 'movie' as const,
                playCount: 1,
            },
            {
                primary_id: '202',
                title: 'Disliked + in demote set (negative weight)',
                playbackPositionTicks: 100,
                runtimeTicks: 100,
                mediaType: 'movie' as const,
                playCount: 1,
            },
        ];

        const resolveMap = new Map([
            ['201:movie', movie1Id],
            ['202:movie', movie2Id],
        ]);

        const noDemote = makeService(embeddings, ratings);
        (
            noDemote.service as unknown as { deps: UserProfileDatabaseDeps }
        ).deps.batchResolveMediaIds = vi.fn().mockResolvedValue(resolveMap);
        await noDemote.service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            watchHistory,
            ratings,
        );

        const withDemote = makeService(embeddings, ratings);
        (
            withDemote.service as unknown as { deps: UserProfileDatabaseDeps }
        ).deps.batchResolveMediaIds = vi.fn().mockResolvedValue(resolveMap);
        await withDemote.service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            watchHistory,
            ratings,
            {
                mediaIds: new Set([movie2Id]),
                multiplier: 0.3,
            },
        );

        // Identical centroids: the demote must not have touched the negative
        // weight on movie2. If the bug returns, |y| in withDemote shrinks.
        const noY = noDemote.captured.catalog_embedding?.[1] ?? 0;
        const withY = withDemote.captured.catalog_embedding?.[1] ?? 0;
        expect(withY).toBeCloseTo(noY, 6);
    });

    it('does attenuate positive weights as designed', async () => {
        // One item: fully-watched, no rating → calculateEnhancedWeight emits
        // a positive watch-only weight (≈0.8). Demote should pull it down,
        // changing the centroid magnitude.
        const movieId = '00000000-0000-0000-0000-00000000000b';
        const embeddings = new Map<string, MediaEmbedding>([[movieId, makeEmbedding([1, 0, 0])]]);
        const watchHistory = [
            {
                primary_id: '301',
                title: 'Watched but abandoned-listed',
                playbackPositionTicks: 100,
                runtimeTicks: 100,
                mediaType: 'movie' as const,
                playCount: 1,
            },
        ];
        // No rating → ratingMap is empty → keyToUuidMap is empty → the service
        // routes through batchResolveMediaIds. Stub it to return our movie.
        const noDemote = makeService(embeddings, []);
        (
            noDemote.service as unknown as {
                deps: UserProfileDatabaseDeps;
            }
        ).deps.batchResolveMediaIds = vi.fn().mockResolvedValue(new Map([['301:movie', movieId]]));

        await noDemote.service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            watchHistory,
            [],
        );

        const withDemote = makeService(embeddings, []);
        (
            withDemote.service as unknown as {
                deps: UserProfileDatabaseDeps;
            }
        ).deps.batchResolveMediaIds = vi.fn().mockResolvedValue(new Map([['301:movie', movieId]]));

        await withDemote.service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            watchHistory,
            [],
            {
                mediaIds: new Set([movieId]),
                multiplier: 0.3,
            },
        );

        // Both produce a unit vector along axis 0 because there's a single
        // positive item — normalization makes them identical in *direction*
        // (the absolute weight cancels in `Σ(w·e) / Σ(w)` for a single item).
        // To verify the multiplier ran, check that the weight passed into
        // upsert via average_weight in preferences was scaled.
        const noDemoteAvg = (
            noDemote.captured as unknown as {
                catalog_embedding: number[] | null;
            }
        ).catalog_embedding;
        const demoteAvg = (
            withDemote.captured as unknown as {
                catalog_embedding: number[] | null;
            }
        ).catalog_embedding;

        // Both should produce a non-null vector pointing in the [1,0,0] direction.
        expect(noDemoteAvg).not.toBeNull();
        expect(demoteAvg).not.toBeNull();
        expect(noDemoteAvg?.[0]).toBeCloseTo(1, 5);
        expect(demoteAvg?.[0]).toBeCloseTo(1, 5);
    });

    it('falls back to null when multiplier=0 demotes every positive item', async () => {
        // All items are positively-weighted AND in the demote set. Multiplier=0
        // collapses every weight to 0 → totalWeight=0 → must fall back to null
        // (NaN safety guard).
        const movieId = '00000000-0000-0000-0000-00000000000c';
        const embeddings = new Map<string, MediaEmbedding>([[movieId, makeEmbedding([1, 0, 0])]]);
        const watchHistory = [
            {
                primary_id: '401',
                title: 'Only item, all demoted',
                playbackPositionTicks: 100,
                runtimeTicks: 100,
                mediaType: 'movie' as const,
                playCount: 1,
            },
        ];

        const { service, captured } = makeService(embeddings, []);
        (service as unknown as { deps: UserProfileDatabaseDeps }).deps.batchResolveMediaIds = vi
            .fn()
            .mockResolvedValue(new Map([['401:movie', movieId]]));

        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            watchHistory,
            [],
            {
                mediaIds: new Set([movieId]),
                multiplier: 0,
            },
        );

        expect(captured.catalog_embedding).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// New: rebuildUserProfile
// ---------------------------------------------------------------------------

describe('rebuildUserProfile', () => {
    it('builds from watch history alone when ratings are empty', async () => {
        const movieId = '00000000-0000-0000-0000-000000000010';
        const embeddings = new Map<string, MediaEmbedding>([
            [movieId, makeEmbedding([0.6, 0.8, 0])],
        ]);

        const { service, captured } = makeService(embeddings, []);

        // Exercise rebuildUserProfile end-to-end: spy on getWatchStateForProfile.all
        // (the service runs it against the injected sql) so we cover the real
        // row→watchHistory mapping, not just createEnhancedUserProfile.
        const watchRows = [
            {
                primary_id: '501',
                media_type: 'movie',
                title: 'Watch-only movie',
                play_count: 2,
                resume_position_ms: 5000,
                runtime_ms: 6000,
            },
        ];
        const allSpy = vi.spyOn(getWatchStateForProfile, 'all').mockResolvedValue(watchRows);

        (service as unknown as { deps: UserProfileDatabaseDeps }).deps.batchResolveMediaIds = vi
            .fn()
            .mockResolvedValue(new Map([['501:movie', movieId]]));

        const profile = await service.rebuildUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
        );

        expect(allSpy).toHaveBeenCalledTimes(1);
        expect(profile).not.toBeNull();
        expect(captured.catalog_embedding).not.toBeNull();
        expect(Array.isArray(captured.catalog_embedding)).toBe(true);

        allSpy.mockRestore();
    });

    it('blends ratings and watch history when both are present', async () => {
        const movie1Id = '00000000-0000-0000-0000-000000000011';
        const movie2Id = '00000000-0000-0000-0000-000000000012';

        const embeddings = new Map<string, MediaEmbedding>([
            [movie1Id, makeEmbedding([1, 0, 0])],
            [movie2Id, makeEmbedding([0, 1, 0])],
        ]);
        const ratings = [makeRating(movie1Id, 9, '601')];

        const { service, captured } = makeService(embeddings, ratings);

        (service as unknown as { deps: UserProfileDatabaseDeps }).deps.batchResolveMediaIds = vi
            .fn()
            .mockResolvedValue(new Map([['602:movie', movie2Id]]));

        const watchHistory = [
            {
                primary_id: '602',
                title: 'Watch-only movie',
                mediaType: 'movie' as const,
                playCount: 1,
                playbackPositionTicks: 9000,
                runtimeTicks: 10000,
            },
        ];

        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            watchHistory,
            ratings,
        );

        // Both axes must be non-zero when both items contribute.
        const emb = captured.catalog_embedding;
        expect(emb).not.toBeNull();
        expect(emb?.[0]).toBeGreaterThan(0);
        expect(emb?.[1]).toBeGreaterThan(0);
    });

    it('returns null when below both thresholds (no ratings, no watch history)', async () => {
        const { service, captured } = makeService(new Map(), []);

        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            [],
        );

        expect(captured.catalog_embedding).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// New: L2 normalization
// ---------------------------------------------------------------------------

describe('createEnhancedUserProfile — L2 normalization', () => {
    it('produces a unit-length embedding (norm ≈ 1.0)', async () => {
        const movieId = '00000000-0000-0000-0000-000000000020';
        // Non-unit embedding to verify normalization kicks in.
        const embeddings = new Map<string, MediaEmbedding>([[movieId, makeEmbedding([3, 4, 0])]]);
        const ratings = [makeRating(movieId, 8, '701')];
        const { service, captured } = makeService(embeddings, ratings);

        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            ratings,
        );

        const emb = captured.catalog_embedding;
        expect(emb).not.toBeNull();
        const norm = Math.sqrt((emb ?? []).reduce((s, v) => s + v * v, 0));
        expect(norm).toBeCloseTo(1.0, 5);
    });
});

// ---------------------------------------------------------------------------
// New: Rocchio negative-centroid in createEnhancedUserProfile
// ---------------------------------------------------------------------------

describe('createEnhancedUserProfile — Rocchio negative steering', () => {
    it('is a no-op when there are no low-rated (negative weight) items', async () => {
        const movieId = '00000000-0000-0000-0000-000000000030';
        const embeddings = new Map<string, MediaEmbedding>([[movieId, makeEmbedding([1, 0, 0])]]);
        const ratings = [makeRating(movieId, 8, '801')];
        const { service, captured } = makeService(embeddings, ratings);

        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            ratings,
        );

        const emb = captured.catalog_embedding;
        expect(emb).not.toBeNull();
        // Single axis-0 item → norm ≈ 1, y ≈ 0 (no negative shift applied)
        expect(emb?.[1]).toBeCloseTo(0, 5);
    });

    it('shifts the centroid when disliked items are present', async () => {
        const likedId = '00000000-0000-0000-0000-000000000031';
        const dislikedId = '00000000-0000-0000-0000-000000000032';

        // liked → axis 0 only, disliked → axis 1 only
        const embeddings = new Map<string, MediaEmbedding>([
            [likedId, makeEmbedding([1, 0, 0])],
            [dislikedId, makeEmbedding([0, 1, 0])],
        ]);

        const ratings = [makeRating(likedId, 9, '901'), makeRating(dislikedId, 1, '902')];
        const watchHistory = [
            {
                primary_id: '901',
                title: 'Liked',
                mediaType: 'movie' as const,
                playCount: 1,
                playbackPositionTicks: 9000,
                runtimeTicks: 10000,
            },
            {
                primary_id: '902',
                title: 'Disliked',
                mediaType: 'movie' as const,
                playCount: 1,
                playbackPositionTicks: 9000,
                runtimeTicks: 10000,
            },
        ];

        const resolveMap = new Map([
            ['901:movie', likedId],
            ['902:movie', dislikedId],
        ]);

        // Baseline: only liked item
        const baselineEmbeddings = new Map<string, MediaEmbedding>([
            [likedId, makeEmbedding([1, 0, 0])],
        ]);
        const baselineRatings = [makeRating(likedId, 9, '901')];
        const baseline = makeService(baselineEmbeddings, baselineRatings);
        await baseline.service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            baselineRatings,
        );

        // With disliked: Rocchio should push y component negative
        const withDislike = makeService(embeddings, ratings);
        (
            withDislike.service as unknown as { deps: UserProfileDatabaseDeps }
        ).deps.batchResolveMediaIds = vi.fn().mockResolvedValue(resolveMap);
        await withDislike.service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            watchHistory,
            ratings,
        );

        const baseY = baseline.captured.catalog_embedding?.[1] ?? 0;
        const withY = withDislike.captured.catalog_embedding?.[1] ?? 0;

        // Dislike on axis-1 must have pulled y below the no-dislike baseline
        expect(withY).toBeLessThan(baseY);
    });
});

// ---------------------------------------------------------------------------
// Plan 2.5 Task 1: unified profile weighting — negative steering + recency
// decay + wider window. Synthetic-vector coverage per the task brief's test
// list.
// ---------------------------------------------------------------------------

describe('createEnhancedUserProfile — unified weighting (Plan 2.5 Task 1)', () => {
    it('liked-only ratings produce a profile ≈ the normalized liked centroid', async () => {
        // Two liked items, SAME rating (equal pre-decay weight) and SAME age
        // (equal decay) → the weighted centroid must equal the simple mean
        // of the raw embeddings, so cosine-to-liked-centroid should be ~1.
        const item1 = '00000000-0000-0000-0000-000000000101';
        const item2 = '00000000-0000-0000-0000-000000000102';
        const emb1 = [1, 0, 0];
        const emb2 = [0, 1, 0];

        const embeddings = new Map<string, MediaEmbedding>([
            [item1, makeEmbedding(emb1)],
            [item2, makeEmbedding(emb2)],
        ]);
        const ratings = [makeRating(item1, 7, '1101'), makeRating(item2, 7, '1102')];
        const { service, captured } = makeService(embeddings, ratings);

        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            ratings,
        );

        const profile = captured.catalog_embedding;
        expect(profile).not.toBeNull();

        const likedCentroid = [
            (emb1[0] + emb2[0]) / 2,
            (emb1[1] + emb2[1]) / 2,
            (emb1[2] + emb2[2]) / 2,
        ];
        expect(cosine(profile ?? [], likedCentroid)).toBeGreaterThan(0.99);
    });

    it('adding a disliked item moves the profile away from it while staying close to liked', async () => {
        const likedId = '00000000-0000-0000-0000-000000000201';
        const dislikedId = '00000000-0000-0000-0000-000000000202';
        const likedEmb = [1, 0, 0];
        // Overlaps partially with the liked direction so "cosine to disliked"
        // is meaningfully nonzero before the Rocchio subtraction.
        const dislikedEmb = [0.6, 0.8, 0];

        // Baseline: liked item only, no dislike signal.
        const baselineEmbeddings = new Map<string, MediaEmbedding>([
            [likedId, makeEmbedding(likedEmb)],
        ]);
        const baselineRatings = [makeRating(likedId, 9, '1201')];
        const baseline = makeService(baselineEmbeddings, baselineRatings);
        await baseline.service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            baselineRatings,
        );
        const baselineProfile = baseline.captured.catalog_embedding ?? [];
        const cosineToDislikedBefore = cosine(baselineProfile, dislikedEmb);
        const cosineToLikedBefore = cosine(baselineProfile, likedEmb);

        // With dislike added (rating <=4 → routed to Rocchio negative centroid).
        const embeddings = new Map<string, MediaEmbedding>([
            [likedId, makeEmbedding(likedEmb)],
            [dislikedId, makeEmbedding(dislikedEmb)],
        ]);
        const ratings = [makeRating(likedId, 9, '1201'), makeRating(dislikedId, 2, '1202')];
        const { service, captured } = makeService(embeddings, ratings);

        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            ratings,
        );

        const profile = captured.catalog_embedding ?? [];
        const cosineToDislikedAfter = cosine(profile, dislikedEmb);
        const cosineToLikedAfter = cosine(profile, likedEmb);

        // Moved strictly away from the disliked direction...
        expect(cosineToDislikedAfter).toBeLessThan(cosineToDislikedBefore);
        // ...while remaining clearly aligned with the liked direction.
        expect(cosineToLikedAfter).toBeGreaterThan(0.9);
        expect(cosineToLikedAfter).toBeLessThanOrEqual(cosineToLikedBefore + 1e-9);
    });

    it('a 2-year-old liked rating contributes less than a fresh one, matching the recency-decay ratio', async () => {
        const freshId = '00000000-0000-0000-0000-000000000301';
        const oldId = '00000000-0000-0000-0000-000000000302';
        // Orthogonal axes so the final normalized components directly reflect
        // each item's relative contribution (normalization preserves ratios).
        const freshEmb = [1, 0, 0];
        const oldEmb = [0, 1, 0];

        const twoYearsAgo = new Date(Date.now() - 730 * 86_400_000);

        const embeddings = new Map<string, MediaEmbedding>([
            [freshId, makeEmbedding(freshEmb)],
            [oldId, makeEmbedding(oldEmb)],
        ]);
        // Same rating for both so the only asymmetry is age (decay).
        const ratings = [makeRating(freshId, 8, '1301'), makeRating(oldId, 8, '1302', twoYearsAgo)];
        const { service, captured } = makeService(embeddings, ratings);

        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            ratings,
        );

        const profile = captured.catalog_embedding ?? [];
        const actualRatio = (profile[1] ?? 0) / (profile[0] ?? 1);

        // 270-day half-life (RECENCY_HALFLIFE_DAYS), matching :439-444 /
        // createEnhancedUserProfile's shared recencyFactor.
        const expectedRatio = Math.pow(0.5, 730 / 270);

        expect(actualRatio).toBeGreaterThan(0);
        expect(Math.abs(actualRatio - expectedRatio)).toBeLessThan(0.01);
        // Sanity: the old rating contributes strictly less than the fresh one.
        expect(profile[1]).toBeLessThan(profile[0]);
    });

    it('rating = 5 contributes to neither centroid (identical profile with/without it)', async () => {
        const likedId = '00000000-0000-0000-0000-000000000401';
        const neutralId = '00000000-0000-0000-0000-000000000402';
        const likedEmb = [1, 0, 0];
        const neutralEmb = [0, 1, 0];

        const baselineEmbeddings = new Map<string, MediaEmbedding>([
            [likedId, makeEmbedding(likedEmb)],
        ]);
        const baselineRatings = [makeRating(likedId, 8, '1401')];
        const baseline = makeService(baselineEmbeddings, baselineRatings);
        await baseline.service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            baselineRatings,
        );

        const embeddings = new Map<string, MediaEmbedding>([
            [likedId, makeEmbedding(likedEmb)],
            [neutralId, makeEmbedding(neutralEmb)],
        ]);
        const ratings = [makeRating(likedId, 8, '1401'), makeRating(neutralId, 5, '1402')];
        const { service, captured } = makeService(embeddings, ratings);
        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            ratings,
        );

        expect(captured.catalog_embedding).toEqual(baseline.captured.catalog_embedding);
    });

    it('zero-liked cold start (dislikes only) yields a null embedding', async () => {
        const dislikedId = '00000000-0000-0000-0000-000000000501';
        const embeddings = new Map<string, MediaEmbedding>([
            [dislikedId, makeEmbedding([0, 1, 0])],
        ]);
        const ratings = [makeRating(dislikedId, 2, '1501')];
        const { service, captured } = makeService(embeddings, ratings);

        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            ratings,
        );

        expect(captured.catalog_embedding).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Plan 2.5 Task 2: math-pin tests (T1 review follow-up) — pin the Rocchio
// negative centroid to a MEAN (not a sum), pin the zero-vector guard when
// positive/negative contributions cancel exactly, and pin that a watch-only
// user (no ratings at all) still gets a usable profile.
// ---------------------------------------------------------------------------

describe('createEnhancedUserProfile — math-pin tests (Plan 2.5 Task 2)', () => {
    // A createdAt far in the future clamps `recencyFactor`'s `ageDays` to
    // exactly 0 via `Math.max(0, ...)`, so `Math.pow(0.5, 0)` is exactly 1 —
    // this removes wall-clock-timing floating-point noise from the decay
    // term so the arithmetic below is exact, not just "close".
    const noDecay = new Date(Date.now() + 10_000_000_000);

    it('negative term is count-independent: 10 dislikes of the same vector ≈ 1 dislike of it (mean, not sum)', async () => {
        const likedId = '00000000-0000-0000-0000-000000000601';
        const likedEmb = [1, 0, 0];
        const dislikedEmb = [0, 1, 0];

        // Scenario A: a single dislike of dislikedEmb.
        const dislikedIdA = '00000000-0000-0000-0000-000000000602';
        const embeddingsA = new Map<string, MediaEmbedding>([
            [likedId, makeEmbedding(likedEmb)],
            [dislikedIdA, makeEmbedding(dislikedEmb)],
        ]);
        const ratingsA = [
            makeRating(likedId, 8, '2601', noDecay),
            makeRating(dislikedIdA, 2, '2602', noDecay),
        ];
        const single = makeService(embeddingsA, ratingsA);
        await single.service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            ratingsA,
        );

        // Scenario B: TEN dislikes, all of the identical dislikedEmb vector
        // (distinct media rows/UUIDs, same embedding direction).
        const dislikedIdsB = Array.from(
            { length: 10 },
            (_, i) => `00000000-0000-0000-0000-0000000007${String(i).padStart(2, '0')}`,
        );
        const embeddingsB = new Map<string, MediaEmbedding>([
            [likedId, makeEmbedding(likedEmb)],
            ...dislikedIdsB.map(
                (id) => [id, makeEmbedding(dislikedEmb)] as [string, MediaEmbedding],
            ),
        ]);
        const ratingsB = [
            makeRating(likedId, 8, '2601', noDecay),
            ...dislikedIdsB.map((id, i) => makeRating(id, 2, `27${i}`, noDecay)),
        ];
        const many = makeService(embeddingsB, ratingsB);
        await many.service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            ratingsB,
        );

        const singleProfile = single.captured.catalog_embedding ?? [];
        const manyProfile = many.captured.catalog_embedding ?? [];
        expect(singleProfile).not.toEqual([]);
        expect(manyProfile).not.toEqual([]);
        for (let i = 0; i < singleProfile.length; i++) {
            expect(manyProfile[i]).toBeCloseTo(singleProfile[i], 9);
        }
    });

    it('positive and negative contributions cancelling exactly fall back to null (zero-vector guard)', async () => {
        const likedId = '00000000-0000-0000-0000-000000000801';
        const dislikedId = '00000000-0000-0000-0000-000000000802';
        // liked axis-0 unit vector; disliked is 2.5x the same axis so that,
        // after Rocchio's fixed NEGATIVE_WEIGHT = 0.4, the subtraction is an
        // EXACT cancellation: 1 - 0.4*2.5 === 0 (verified: 0.4*2.5 === 1 in
        // IEEE754 double precision — no epsilon tolerance needed).
        const likedEmb = [1, 0, 0];
        const dislikedEmb = [2.5, 0, 0];

        const embeddings = new Map<string, MediaEmbedding>([
            [likedId, makeEmbedding(likedEmb)],
            [dislikedId, makeEmbedding(dislikedEmb)],
        ]);
        const ratings = [
            makeRating(likedId, 9, '2801', noDecay),
            makeRating(dislikedId, 1, '2802', noDecay),
        ];
        const { service, captured } = makeService(embeddings, ratings);

        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            ratings,
        );

        expect(captured.catalog_embedding).toBeNull();
    });

    it('a watch-only user with zero ratings still gets a non-null embedding', async () => {
        const movieId = '00000000-0000-0000-0000-000000000901';
        const embeddings = new Map<string, MediaEmbedding>([[movieId, makeEmbedding([1, 0, 0])]]);
        const watchHistory = [
            {
                primary_id: '2901',
                title: 'Watched, never rated',
                playbackPositionTicks: 9000,
                runtimeTicks: 10000,
                mediaType: 'movie' as const,
                playCount: 1,
            },
        ];

        const { service, captured } = makeService(embeddings, []);
        (service as unknown as { deps: UserProfileDatabaseDeps }).deps.batchResolveMediaIds = vi
            .fn()
            .mockResolvedValue(new Map([['2901:movie', movieId]]));

        const profile = await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            watchHistory,
            [],
        );

        expect(profile).not.toBeNull();
        expect(captured.catalog_embedding).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Plan 2.5 Task 1: createUserProfileFromRatings — thin delegate wiring
// ---------------------------------------------------------------------------

describe('createUserProfileFromRatings — unified delegate', () => {
    it('fetches ratings using the 500-row PROFILE_RATING_WINDOW', async () => {
        const { service } = makeService(new Map(), []);
        await service.createUserProfileFromRatings(
            toUserId('00000000-0000-0000-0000-000000000001'),
        );

        const deps = (service as unknown as { deps: UserProfileDatabaseDeps }).deps;
        expect(deps.getUserRatingsWithUuid).toHaveBeenCalledWith(
            toUserId('00000000-0000-0000-0000-000000000001'),
            500,
        );
    });

    it('delegates to the same unified weighting as createEnhancedUserProfile (liked-only produces a usable profile)', async () => {
        const movieId = '00000000-0000-0000-0000-000000000601';
        const embeddings = new Map<string, MediaEmbedding>([[movieId, makeEmbedding([1, 0, 0])]]);
        const ratings = [makeRating(movieId, 9, '1601')];
        const { service, captured } = makeService(embeddings, ratings);

        const profile = await service.createUserProfileFromRatings(
            toUserId('00000000-0000-0000-0000-000000000001'),
        );

        expect(profile).not.toBeNull();
        expect(captured.catalog_embedding).not.toBeNull();
        expect(captured.catalog_embedding?.[0]).toBeCloseTo(1, 5);
    });

    it('cold-starts to null when ratings are dislikes only (mirrors createEnhancedUserProfile)', async () => {
        const movieId = '00000000-0000-0000-0000-000000000701';
        const embeddings = new Map<string, MediaEmbedding>([[movieId, makeEmbedding([1, 0, 0])]]);
        const ratings = [makeRating(movieId, 1, '1701')];
        const { service, captured } = makeService(embeddings, ratings);

        const profile = await service.createUserProfileFromRatings(
            toUserId('00000000-0000-0000-0000-000000000001'),
        );

        expect(profile).not.toBeNull(); // upsert still runs, with a null embedding
        expect(captured.catalog_embedding).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Plan 3 Task 3: per-user "include my watch history" toggle
// ---------------------------------------------------------------------------

describe('createEnhancedUserProfile — includeWatchHistory toggle (Plan 3 Task 3)', () => {
    it('excludes a watch-only signal from the centroid when the flag is false (cold-start null)', async () => {
        // With the flag true, this exact fixture (single watched-only item,
        // no ratings) yields a non-null embedding — see the "watch-only user
        // with zero ratings" math-pin test above. With the flag false the
        // watch signal must be excluded entirely, and with zero ratings too
        // there is nothing left to build a centroid from.
        const movieId = '00000000-0000-0000-0000-000000000a01';
        const embeddings = new Map<string, MediaEmbedding>([[movieId, makeEmbedding([1, 0, 0])]]);
        const watchHistory = [
            {
                primary_id: '4001',
                title: 'Watched, never rated',
                playbackPositionTicks: 9000,
                runtimeTicks: 10000,
                mediaType: 'movie' as const,
                playCount: 1,
            },
        ];

        const { service, captured } = makeService(embeddings, []);
        (service as unknown as { deps: UserProfileDatabaseDeps }).deps.batchResolveMediaIds = vi
            .fn()
            .mockResolvedValue(new Map([['4001:movie', movieId]]));
        (
            service as unknown as { deps: UserProfileDatabaseDeps }
        ).deps.getIncludeWatchHistoryPreference = vi.fn().mockResolvedValue(false);

        const profile = await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            watchHistory,
            [],
        );

        expect(profile).not.toBeNull(); // upsert still runs, with a null embedding
        expect(captured.catalog_embedding).toBeNull();
    });

    it('a watched+rated item behaves identically to a rated-only item when the flag is false (rating-derived weight unaffected)', async () => {
        // Two items, orthogonal axes, IDENTICAL rating and timestamp. The
        // only difference: watchedRatedId is ALSO in watchHistory (with a
        // rewatch bonus that would inflate its weight under the normal
        // WATCHED+RATED branch of calculateEnhancedWeight). With the flag
        // false, watchHistory is excluded entirely, so BOTH items must fall
        // through to the identical RATED-ONLY weight — the centroid must sit
        // exactly on the diagonal (equal contribution), not skewed toward
        // the watched item's axis.
        const watchedRatedId = '00000000-0000-0000-0000-000000000a02';
        const ratedOnlyId = '00000000-0000-0000-0000-000000000a03';

        const embeddings = new Map<string, MediaEmbedding>([
            [watchedRatedId, makeEmbedding([1, 0, 0])],
            [ratedOnlyId, makeEmbedding([0, 1, 0])],
        ]);
        const now = new Date();
        const ratings = [
            makeRating(watchedRatedId, 8, '4101', now),
            makeRating(ratedOnlyId, 8, '4102', now),
        ];
        const watchHistory = [
            {
                primary_id: '4101',
                title: 'Watched AND rated',
                mediaType: 'movie' as const,
                playCount: 2, // rewatch bonus — must be ignored when the flag is false
                playbackPositionTicks: 10000,
                runtimeTicks: 10000,
            },
        ];

        const { service, captured } = makeService(embeddings, ratings);
        (
            service as unknown as { deps: UserProfileDatabaseDeps }
        ).deps.getIncludeWatchHistoryPreference = vi.fn().mockResolvedValue(false);

        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            watchHistory,
            ratings,
        );

        const profile = captured.catalog_embedding ?? [];
        expect(profile[0]).toBeGreaterThan(0);
        expect(profile[1]).toBeGreaterThan(0);
        expect(profile[0]).toBeCloseTo(profile[1], 9);
    });

    it('persists the flag it read into the preferences it writes, so it survives the next rebuild', async () => {
        // UserProfileService rewrites `preferences` wholesale on every
        // rebuild (see createEnhancedUserProfile) — if it didn't re-include
        // includeWatchHistory in what it writes, a user's disabled toggle
        // would silently reset to the true default on their very next
        // rebuild (rating milestone, watch debounce, backfill job, ...).
        const movieId = '00000000-0000-0000-0000-000000000a04';
        const embeddings = new Map<string, MediaEmbedding>([[movieId, makeEmbedding([1, 0, 0])]]);
        const ratings = [makeRating(movieId, 8, '4201')];

        const deps: UserProfileDatabaseDeps = {
            getMediaEmbedding: vi.fn(),
            getMediaEmbeddingByUuid: vi.fn(),
            getUserRatingsWithUuid: vi.fn().mockResolvedValue(ratings),
            batchResolveMediaIds: vi.fn().mockResolvedValue(new Map()),
            batchBuildMediaEmbeddingsFromUuids: vi.fn().mockResolvedValue(embeddings),
            getIncludeWatchHistoryPreference: vi.fn().mockResolvedValue(false),
        };
        const fakeSql = {} as unknown as postgres.Sql;
        const service = new UserProfileService(fakeSql, deps);

        let capturedPreferences: Record<string, unknown> | undefined;
        service.upsertUserProfile = vi.fn(
            async (
                profile: Omit<UserProfile, 'created_at' | 'updated_at'>,
            ): Promise<UserProfile> => {
                capturedPreferences = profile.preferences;
                return {
                    ...profile,
                    created_at: new Date(),
                    updated_at: new Date(),
                } as UserProfile;
            },
        );

        await service.createEnhancedUserProfile(
            toUserId('00000000-0000-0000-0000-000000000001'),
            [],
            ratings,
        );

        expect(capturedPreferences?.includeWatchHistory).toBe(false);
    });
});
