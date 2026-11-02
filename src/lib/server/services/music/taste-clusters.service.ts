// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Taste Clusters Service
 *
 * Computes per-user k-means clusters over the embeddings of their top-played
 * tracks. Each cluster represents one "mode" of the user's taste (e.g.
 * hands-up vs. rock vs. ambient) so Quick Picks `taste-similar` can sample
 * proportionally from each mode instead of collapsing everything into a
 * single centroid.
 *
 * Cached in Valkey for 6h — clustering is O(n*k*iter*dim), expensive enough
 * to not recompute on every Quick Picks request.
 *
 * @module services/music/taste-clusters
 */

import { warmMusicCollages } from './collage-warmup.js';
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { Logger } from '$lib/server/utils/logger.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import {
    parseEmbedding,
    averageVectors,
    subtractVectors,
    normalizeVector,
} from '$lib/server/utils/embedding-utils.js';
import {
    getTopPlayedEmbeddings,
    getDislikedEmbeddings,
} from '$lib/server/database/queries/music-quick-picks.queries.js';
import { getClusterCentroid } from '$lib/server/database/queries/audio-clusters.queries.js';
import { MSCLAP_MODEL_ID } from '$lib/server/database/queries/sonic-constants.js';
import { features } from '$lib/server/config.js';

const logger = Logger.for('TasteClustersService');

/** Minimum played tracks needed to attempt clustering. */
export const MIN_PLAYS_FOR_CLUSTERING = 10;
/** How many top-played tracks to fetch as the clustering input. */
export const TOP_N_TRACKS = 50;
/** Default cluster count. Adaptive — capped by floor(playedCount / 4). */
export const DEFAULT_K = 3;

/**
 * Fix D — liked tracks (rating >= 8) contribute this many times to the
 * k-means input. A like pulls harder than a neutral play.
 */
export const LIKE_WEIGHT = 3;

/**
 * Fix C — Rocchio subtraction strength. Each cluster centroid is shifted
 * by -LAMBDA * negative_centroid, pushing the taste vector away from the
 * region that user dislikes occupy.
 */
export const DISLIKE_LAMBDA = 0.3;

/**
 * Fix C — minimum explicit-dislike count before Rocchio kicks in. Below
 * this, the negative centroid is too noisy to trust.
 */
export const MIN_DISLIKES_FOR_ROCCHIO = 10;

export interface TasteCluster {
    /** Centroid vector — same dimension as input embeddings. */
    centroid: number[];
    /** Number of input tracks assigned to this cluster. */
    size: number;
    /** Sample track IDs from the cluster (up to 5) for debugging. */
    sampleTrackIds: string[];
}

// =============================================================================
// Pure k-means (exported for unit testing)
// =============================================================================

/**
 * Squared Euclidean distance — equivalent to (1 - cosine) ranking for
 * normalized vectors but cheaper than acos and stable for k-means update.
 */
function distance(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < len; i++) {
        const d = a[i] - b[i];
        sum += d * d;
    }
    return sum;
}

function meanVector(vectors: number[][]): number[] {
    if (vectors.length === 0) return [];
    const dim = vectors[0].length;
    const out = new Array<number>(dim).fill(0);
    for (const v of vectors) {
        for (let i = 0; i < dim; i++) out[i] += v[i];
    }
    for (let i = 0; i < dim; i++) out[i] /= vectors.length;
    return out;
}

/**
 * k-means++ initialization: pick first centroid uniformly at random, then
 * each subsequent centroid weighted by squared distance to nearest existing
 * centroid. Spreads seeds out so clustering is more stable than naive random.
 */
function initCentroids(vectors: number[][], k: number, seed = 0): number[][] {
    const n = vectors.length;
    let rng = mulberry32(seed || 1);
    const centroids: number[][] = [];

    centroids.push([...vectors[Math.floor(rng() * n)]]);

    while (centroids.length < k) {
        const dists = vectors.map((v) => {
            let min = Infinity;
            for (const c of centroids) {
                const d = distance(v, c);
                if (d < min) min = d;
            }
            return min;
        });
        const total = dists.reduce((s, d) => s + d, 0);
        if (total <= 0) {
            centroids.push([...vectors[Math.floor(rng() * n)]]);
            continue;
        }
        const r = rng() * total;
        let cumulative = 0;
        let pickedIdx = 0;
        for (let i = 0; i < dists.length; i++) {
            cumulative += dists[i];
            if (cumulative >= r) {
                pickedIdx = i;
                break;
            }
        }
        centroids.push([...vectors[pickedIdx]]);
    }

    return centroids;
}

// Tiny deterministic PRNG so tests are reproducible without pulling in a dep.
function mulberry32(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
        t = (t + 0x6d2b79f5) >>> 0;
        let r = t;
        r = Math.imul(r ^ (r >>> 15), r | 1);
        r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

export interface KmeansResult {
    centroid: number[];
    indices: number[];
}

/**
 * Run Lloyd's algorithm with k-means++ init.
 * Returns one entry per cluster with the centroid + indices into `vectors`.
 * Empty clusters are dropped.
 */
export function kmeans(
    vectors: number[][],
    k: number,
    opts: { maxIter?: number; seed?: number } = {},
): KmeansResult[] {
    const maxIter = opts.maxIter ?? 25;
    if (vectors.length === 0 || k <= 0) return [];
    const effectiveK = Math.min(k, vectors.length);

    let centroids = initCentroids(vectors, effectiveK, opts.seed);
    let assignments = new Array<number>(vectors.length).fill(0);

    for (let iter = 0; iter < maxIter; iter++) {
        let changed = false;
        for (let i = 0; i < vectors.length; i++) {
            let bestC = 0;
            let bestD = Infinity;
            for (let c = 0; c < centroids.length; c++) {
                const d = distance(vectors[i], centroids[c]);
                if (d < bestD) {
                    bestD = d;
                    bestC = c;
                }
            }
            if (assignments[i] !== bestC) {
                assignments[i] = bestC;
                changed = true;
            }
        }
        if (!changed) break;

        // Rebuild centroids as the mean of their members. Empty clusters are
        // reseeded from the single vector farthest from any other centroid —
        // keeps k stable instead of silently collapsing to a smaller k when
        // input is clumpy.
        const newCentroids: number[][] = [];
        const emptyCentroids: number[] = [];
        for (let c = 0; c < centroids.length; c++) {
            const members = vectors.filter((_, i) => assignments[i] === c);
            if (members.length > 0) {
                newCentroids.push(meanVector(members));
            } else {
                emptyCentroids.push(c);
                // Placeholder — replaced below if we can reseed.
                newCentroids.push(centroids[c]);
            }
        }
        for (const c of emptyCentroids) {
            let farthestIdx = -1;
            let farthestD = -Infinity;
            for (let i = 0; i < vectors.length; i++) {
                // Pick the vector whose nearest active centroid is furthest —
                // guarantees the new centroid isn't redundant.
                let nearest = Infinity;
                for (let j = 0; j < newCentroids.length; j++) {
                    if (emptyCentroids.includes(j) && j !== c) continue;
                    const d = distance(vectors[i], newCentroids[j]);
                    if (d < nearest) nearest = d;
                }
                if (nearest > farthestD) {
                    farthestD = nearest;
                    farthestIdx = i;
                }
            }
            if (farthestIdx >= 0 && farthestD > 0) {
                // Reseeding shifts the centroid; the next iteration's
                // assignment pass will naturally pick it up and rebalance.
                newCentroids[c] = [...vectors[farthestIdx]];
            }
        }
        centroids = newCentroids;
    }

    const buckets: KmeansResult[] = centroids.map((centroid) => ({
        centroid,
        indices: [],
    }));
    for (let i = 0; i < vectors.length; i++) {
        buckets[assignments[i]].indices.push(i);
    }
    return buckets.filter((b) => b.indices.length > 0);
}

// =============================================================================
// Cached service entry point
// =============================================================================

/**
 * Cache key derivation: bucketize played count by tens so a user growing
 * from 11 → 50 plays re-clusters as soon as they cross a boundary instead
 * of waiting up to 6h for the TTL. Keeps the clusters fresh without
 * per-play invalidation overhead.
 *
 * The dislike count is folded in as a coarse bucket so that accumulating new
 * dislikes (which shift the Rocchio negative centroid) re-clusters once a
 * boundary is crossed, instead of waiting up to 6h for the TTL to expire.
 */
function cacheKeyForPlayCount(playedCount: number, dislikeCount: number): string {
    return `clusters:p${Math.floor(playedCount / 10)}:d${Math.floor(dislikeCount / 5)}`;
}

/**
 * Returns the user's taste clusters, computing + caching on miss.
 *
 * Returns `null` when the user has too few played tracks to cluster
 * meaningfully — callers should fall back to the legacy single-centroid
 * taste-similar path in that case.
 */
export async function getUserTasteClusters(
    sql: postgres.Sql,
    userId: UserId,
    opts: { k?: number } = {},
): Promise<TasteCluster[] | null> {
    if (!userId || userId.trim().length === 0) return null;

    const cache = cacheManager.for(CACHE_NAMESPACES.musicTasteClusters);

    // Look up current play count + explicit-dislike count so we can key the
    // cache by both buckets. Cheap: both COUNT(*)s hit indexed columns. The
    // dislike predicate mirrors getDislikedEmbeddings (rating <= 3 OR skipped)
    // so the bucket tracks the same signal that shifts the Rocchio centroid.
    const [[{ played_count: playedCount }], [{ dislike_count: dislikeCount }]] = await Promise.all([
        sql<[{ played_count: number }]>`
            SELECT COUNT(*)::int AS played_count
            FROM user_music_state
            WHERE user_id = ${userId} AND play_count > 0
        `,
        // Per-user dislike COUNT for the cluster cache key — not a content
        // listing. The media_items join only narrows the user's own ratings to
        // tracks; library/age access is irrelevant to a private count, so the
        // unscoped-media-items gate does not apply here.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        sql<[{ dislike_count: number }]>`
            SELECT COUNT(DISTINCT ur.media_id)::int AS dislike_count
            FROM user_ratings ur
            JOIN media_items m ON m.id = ur.media_id AND m.media_type = 'track'
            WHERE ur.user_id = ${userId}
              AND (ur.rating <= 3 OR ur.skipped = TRUE)
        `,
    ]);

    if (playedCount < MIN_PLAYS_FOR_CLUSTERING) {
        logger.debug('taste-clusters fallback (insufficient plays)', {
            userId,
            playedCount,
        });
        return null;
    }

    const cacheKey = cacheKeyForPlayCount(playedCount, dislikeCount);

    try {
        const cached = await cache.get<TasteCluster[]>(cacheKey, userId);
        if (cached !== null) {
            logger.debug('taste-clusters cache hit', {
                userId,
                clusters: cached.length,
                cacheKey,
            });
            return cached;
        }
    } catch (err) {
        logger.warn('taste-clusters cache read failed', {
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // Fetch positive embeddings + dislike embeddings in parallel.
    // Rocchio's negative side only runs when we have enough explicit
    // dislikes to form a stable centroid.
    const [rows, dislikeRows] = await Promise.all([
        getTopPlayedEmbeddings(sql, userId, TOP_N_TRACKS),
        getDislikedEmbeddings(sql, userId),
    ]);

    if (rows.length < MIN_PLAYS_FOR_CLUSTERING) {
        logger.debug('taste-clusters fallback (thin embeddings)', {
            userId,
            playedCount,
            withEmbeddings: rows.length,
        });
        return null;
    }

    const parsed = rows
        .map((r) => ({
            id: r.track_id,
            vec: parseEmbedding(r.embedding),
            liked: Boolean(r.is_liked),
        }))
        .filter(
            (r): r is { id: string; vec: number[]; liked: boolean } =>
                r.vec !== null && r.vec.length > 0 && r.vec.every(Number.isFinite),
        );

    if (parsed.length < MIN_PLAYS_FOR_CLUSTERING) return null;

    // Fix D — up-weight liked tracks by duplicating them in the k-means
    // input set. A liked track contributes LIKE_WEIGHT vectors to the
    // pool so k-means centroids drift more strongly toward the user's
    // explicit favorites.
    const kmeansInput: { vec: number[]; idx: number }[] = [];
    for (let i = 0; i < parsed.length; i++) {
        const weight = parsed[i].liked ? LIKE_WEIGHT : 1;
        for (let w = 0; w < weight; w++) {
            kmeansInput.push({ vec: parsed[i].vec, idx: i });
        }
    }

    const k = Math.min(opts.k ?? DEFAULT_K, Math.floor(parsed.length / 4));
    if (k < 1) return null;

    const buckets = kmeans(
        kmeansInput.map((p) => p.vec),
        k,
        { seed: hashUserId(userId) },
    );

    // Fix C — compute negative centroid from explicit dislikes only, then
    // shift each cluster centroid by -λ × neg_centroid. Behavioral skips
    // do NOT feed this — per option (iii), they're soft-demoted in
    // ordering (Fix E) but don't move taste.
    const negativeVectors = dislikeRows
        .map((r) => parseEmbedding(r.embedding))
        .filter((v): v is number[] => v !== null && v.length > 0 && v.every(Number.isFinite));
    const applyRocchio = negativeVectors.length >= MIN_DISLIKES_FOR_ROCCHIO;
    const negCentroid = applyRocchio ? averageVectors(negativeVectors) : null;

    // Sample track IDs: indices in kmeansInput map back to positions in
    // `parsed` via the `idx` field (since duplicated entries share an idx).
    // Dedupe when collecting samples so we don't show the same liked track
    // 3 times in the admin inspector — but `size` must reflect the TOTAL
    // unique tracks in the cluster, not just the first 5 samples.
    const clusters: TasteCluster[] = buckets.map((b) => {
        // Count all unique tracks in this cluster first (by their parsed
        // index, which collapses the 3x like duplication).
        const uniqueTrackIndices = new Set<number>();
        for (const ki of b.indices) {
            uniqueTrackIndices.add(kmeansInput[ki].idx);
        }

        // Then collect up to 5 sample track IDs, deduped.
        const sampleIds: string[] = [];
        const seenForSamples = new Set<string>();
        for (const ki of b.indices) {
            const id = parsed[kmeansInput[ki].idx].id;
            if (seenForSamples.has(id)) continue;
            seenForSamples.add(id);
            sampleIds.push(id);
            if (sampleIds.length >= 5) break;
        }

        let centroid = b.centroid;
        if (negCentroid && negCentroid.length === centroid.length) {
            centroid = normalizeVector(subtractVectors(centroid, negCentroid, DISLIKE_LAMBDA));
        }
        return {
            centroid,
            size: uniqueTrackIndices.size,
            sampleTrackIds: sampleIds,
        };
    });

    try {
        await cache.set(cacheKey, clusters, undefined, userId);
    } catch (err) {
        logger.warn('taste-clusters cache write failed', {
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    warmMusicCollages(
        sql,
        clusters.map((cluster) => cluster.sampleTrackIds),
    );

    logger.info('taste-clusters computed', {
        userId,
        playedCount: parsed.length,
        likedCount: parsed.filter((p) => p.liked).length,
        dislikeCount: negativeVectors.length,
        rocchioApplied: applyRocchio,
        k,
        sizes: clusters.map((c) => c.size),
    });

    return clusters;
}

/** Stable seed per username so the same user gets reproducible clusters. */
function hashUserId(userId: UserId): number {
    let h = 2166136261;
    for (let i = 0; i < userId.length; i++) {
        h ^= userId.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// =============================================================================
// Sonic taste clusters (media_audio_clusters / MSCLAP, 1024-dim)
// =============================================================================

/**
 * Row returned by the inline cluster-assignment lookup query.
 * @internal
 */
interface TrackClusterRow {
    track_id: string;
    cluster_id: number;
}

/**
 * Fetch the user's top-played tracks and their pre-computed sonic cluster
 * assignments from `media_audio_clusters`.
 *
 * Returns only tracks that have both a play entry in `user_music_state` AND a
 * cluster assignment — i.e. tracks for which MSCLAP has already run. Tracks
 * without audio embeddings / cluster assignments are simply absent from the
 * result; the caller handles low-coverage fallback.
 *
 * @internal
 */
async function getTopPlayedClusterAssignments(
    sql: postgres.Sql,
    userId: UserId,
    limit: number,
): Promise<TrackClusterRow[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return sql<TrackClusterRow[]>`
        SELECT
            ums.track_id::text AS track_id,
            mac.cluster_id
        FROM user_music_state ums
        JOIN media_items track
          ON track.id = ums.track_id
         AND track.media_type = 'track'
         AND track.has_files = true
        JOIN media_audio_clusters mac
          ON mac.media_id = ums.track_id
         AND mac.model_id = ${MSCLAP_MODEL_ID}
        LEFT JOIN user_ratings ur
          ON ur.media_id = ums.track_id AND ur.user_id = ums.user_id
        WHERE ums.user_id = ${userId}
          AND ums.play_count > 0
          -- Mirror getTopPlayedEmbeddings: exclude explicit dislikes so they
          -- don't anchor a centroid in the wrong region.
          AND (ur.rating IS NULL OR ur.rating >= 4)
          AND (ur.skipped IS NULL OR ur.skipped = FALSE)
        ORDER BY ums.play_count DESC, ums.last_played_at DESC NULLS LAST
        LIMIT ${limit}
    `;
}

/**
 * Returns the user's sonic taste clusters, using pre-computed
 * `media_audio_clusters` assignments as the grouping signal and
 * `media_audio_embeddings` (MSCLAP, 1024-dim) to derive cluster centroids.
 *
 * This is the sonic parallel of {@link getUserTasteClusters}. It is gated on
 * `features.musicClusters` (FEATURE_MUSIC_CLUSTERS + sonicEmbeddings). When
 * sonic coverage is below {@link MIN_PLAYS_FOR_CLUSTERING} played tracks with
 * cluster assignments, it returns null — the caller falls back to the metadata
 * path automatically.
 *
 * Cached for 6 hours in Valkey under `CACHE_NAMESPACES.musicSonicTasteClusters`
 * using the same play-count + dislike-count bucket key as the metadata variant,
 * so fresh sonic re-clustering is reflected as soon as the user crosses a play
 * boundary (same cache invalidation semantics).
 *
 * @param sql    - postgres.Sql instance.
 * @param userId - The user whose taste to cluster.
 * @param opts   - Optional { k } override; adaptive default as in metadata path.
 * @returns Sonic taste clusters, or null when coverage is insufficient.
 */
export async function getUserSonicTasteClusters(
    sql: postgres.Sql,
    userId: UserId,
    opts: { k?: number } = {},
): Promise<TasteCluster[] | null> {
    if (!features.musicClusters) return null;
    if (!userId || userId.trim().length === 0) return null;

    const cache = cacheManager.for(CACHE_NAMESPACES.musicSonicTasteClusters);

    // Use the same cache-key shape as getUserTasteClusters so both variants
    // invalidate when the user crosses a play or dislike boundary.
    const [[{ played_count: playedCount }], [{ dislike_count: dislikeCount }]] = await Promise.all([
        sql<[{ played_count: number }]>`
            SELECT COUNT(*)::int AS played_count
            FROM user_music_state
            WHERE user_id = ${userId} AND play_count > 0
        `,
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        sql<[{ dislike_count: number }]>`
            SELECT COUNT(DISTINCT ur.media_id)::int AS dislike_count
            FROM user_ratings ur
            JOIN media_items m ON m.id = ur.media_id AND m.media_type = 'track'
            WHERE ur.user_id = ${userId}
              AND (ur.rating <= 3 OR ur.skipped = TRUE)
        `,
    ]);

    if (playedCount < MIN_PLAYS_FOR_CLUSTERING) {
        logger.debug('sonic-taste-clusters fallback (insufficient plays)', {
            userId,
            playedCount,
        });
        return null;
    }

    const cacheKey = cacheKeyForPlayCount(playedCount, dislikeCount);

    try {
        const cached = await cache.get<TasteCluster[]>(cacheKey, userId);
        if (cached !== null) {
            logger.debug('sonic-taste-clusters cache hit', {
                userId,
                clusters: cached.length,
                cacheKey,
            });
            return cached;
        }
    } catch (err) {
        logger.warn('sonic-taste-clusters cache read failed', {
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // Fetch top-played tracks with their pre-computed sonic cluster assignments.
    const assignments = await getTopPlayedClusterAssignments(sql, userId, TOP_N_TRACKS);

    if (assignments.length < MIN_PLAYS_FOR_CLUSTERING) {
        logger.debug('sonic-taste-clusters fallback (low sonic coverage)', {
            userId,
            playedCount,
            withClusterAssignment: assignments.length,
        });
        return null;
    }

    // Group track IDs by their pre-assigned cluster label.
    const byCluster = new Map<number, string[]>();
    for (const row of assignments) {
        const existing = byCluster.get(row.cluster_id);
        if (existing) {
            existing.push(row.track_id);
        } else {
            byCluster.set(row.cluster_id, [row.track_id]);
        }
    }

    // Compute one centroid per cluster group using the audio embeddings.
    // Clusters with no embeddings (getClusterCentroid returns null) are skipped.
    const clusterEntries = [...byCluster.entries()];
    const centroidResults = await Promise.all(
        clusterEntries.map(([, memberIds]) => getClusterCentroid(sql, MSCLAP_MODEL_ID, memberIds)),
    );

    const sonicClusters: TasteCluster[] = [];
    for (let i = 0; i < clusterEntries.length; i++) {
        const centroid = centroidResults[i];
        if (!centroid || centroid.length === 0 || !centroid.every(Number.isFinite)) continue;

        const memberIds = clusterEntries[i][1];
        sonicClusters.push({
            centroid,
            size: memberIds.length,
            sampleTrackIds: memberIds.slice(0, 5),
        });
    }

    if (sonicClusters.length === 0) {
        logger.debug('sonic-taste-clusters fallback (no valid centroids)', {
            userId,
            clusterGroups: byCluster.size,
        });
        return null;
    }

    // Optionally cap to k clusters (mirrors metadata path adaptive-k logic).
    const k = Math.min(opts.k ?? DEFAULT_K, sonicClusters.length);
    const result = sonicClusters.slice(0, k);

    try {
        await cache.set(cacheKey, result, undefined, userId);
    } catch (err) {
        logger.warn('sonic-taste-clusters cache write failed', {
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    warmMusicCollages(
        sql,
        result.map((cluster) => cluster.sampleTrackIds),
    );

    logger.info('sonic-taste-clusters computed', {
        userId,
        playedWithAssignment: assignments.length,
        clusterGroups: byCluster.size,
        resultCount: result.length,
    });

    return result;
}
