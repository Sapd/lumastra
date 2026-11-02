// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TasteDamperService — "Show less like this" soft negative steering.
 *
 * A damper is a SOFT, DECAYING, NON-JUDGMENTAL neighborhood signal. Unlike a
 * Dislike (a permanent 1★ rating folded into the durable taste vector), a
 * damper:
 *   - writes NO rating,
 *   - is NEVER folded into user_profiles.catalog_embedding (so it cannot
 *     permanently corrupt genres the user actually likes),
 *   - decays over time (half-life {@link HALF_LIFE_DAYS}, hard expiry
 *     {@link EXPIRY_DAYS}) and is applied only as a ranking-time penalty.
 *
 * At ranking time For-You attenuates each candidate's combined score by
 * `DAMPER_LAMBDA · pen`, where `pen = max_i [ weight_i · max(0, cos_centered(
 * item, damper_i)) ]` is a per-candidate MAX-pool over the user's active
 * dampers. Dampers are kept SEPARATE (not collapsed to one centroid) so a
 * multi-modal set steers away from each neighborhood independently, and cosines
 * are mean-centered against the global content mean so the penalty reflects what
 * is distinctive rather than the shared embedding cone.
 *
 * The durable signal lives in the `user_taste_dampers` table. This service
 * memoizes the per-user damper context in a short-TTL cache (so a single
 * For-You page load ≈10 endpoint calls does not recompute it) and the global
 * content mean in a long-TTL cache (it changes slowly and is costly to derive).
 */

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import {
    parseEmbedding,
    vectorMagnitude,
    normalizeVector,
    cosineSimilarityOrDefault,
} from '$lib/server/utils/embedding-utils';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source';

const logger = Logger.for('TasteDamperService');

const damperCache = cacheManager.for(CACHE_NAMESPACES.tasteDampers);
const meanCache = cacheManager.for(CACHE_NAMESPACES.globalEmbeddingMean);

/** Exponential decay half-life, in days. */
export const HALF_LIFE_DAYS = 3;
/** Hard expiry after which a damper is gone regardless of decay, in days. */
export const EXPIRY_DAYS = 7;
/**
 * Ranking attenuation strength, applied MULTIPLICATIVELY to the candidate's
 * (positive) combined score: `score → score − max(score,0)·DAMPER_LAMBDA·pen`,
 * where `pen = max_i [ weight_i · max(0, cos_centered(item, damper_i)) ] ∈ [0,1]`.
 * So an item identical to a damped item loses ~`DAMPER_LAMBDA` of its score,
 * scaling smoothly to 0 for unrelated items. Multiplicative (not a flat
 * subtraction off the AI term) so the effect is scale-invariant across the
 * heterogeneous For-You scoring paths and isn't drowned out by mdblist/imdb.
 */
export const DAMPER_LAMBDA = 0.6;

/** Upper bound on active dampers stored/considered per user (newest win). */
export const MAX_ACTIVE_DAMPERS = 25;
/**
 * Upper bound on dampers fed into the per-candidate MAX-pool at ranking time.
 * Each adds one cosine op per scored row, so this bounds the query cost for
 * damper users (non-damper users pay nothing — the penalty is gated to null).
 */
export const MAX_POOL_DAMPERS = 10;
/**
 * Deterministic sample size for the global content-mean estimate. A full
 * `avg(embedding)` over every row is an expensive aggregate; a stable sample is
 * plenty for a centering reference and is cached for hours.
 */
export const MEAN_SAMPLE_SIZE = 20000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** One active damper as a ranking-time signal: its (mean-centered) vector + decayed weight. */
export interface DamperVector {
    /** Mean-centered embedding (raw embedding − global mean), or raw if no mean. */
    vec: number[];
    /** Decayed weight in (0, 1]. */
    weight: number;
}

/**
 * The full "show less like this" ranking context for a user (or null when there
 * are no usable dampers). Per-damper vectors are kept SEPARATE (not collapsed to
 * one centroid) so a multi-modal damper set — e.g. horror AND romcom — steers
 * away from BOTH neighborhoods independently via a per-candidate max-pool,
 * rather than penalizing a meaningless midpoint between them.
 */
export interface DamperContext {
    /** Mean-centered, decayed dampers for the per-candidate max-pool (≤ MAX_POOL_DAMPERS). */
    dampers: DamperVector[];
    /** Global content mean used to center the candidate item, or null when unavailable. */
    mean: number[] | null;
    /** Stable hash of the active set membership + mean fingerprint, for cache-key gating. */
    hash: string;
}

/** A single active damper, for the settings management UI. */
export interface ActiveDamper {
    mediaId: string;
    mediaType: 'movie' | 'tv';
    title: string;
    createdAt: string;
    expiresAt: string;
}

/**
 * Per-candidate "show less like this" penalty ∈ [0,1] for one item embedding,
 * given a damper context: `max_i [ weight_i · max(0, cos_centered(item, damper_i)) ]`.
 * Mean-centered when the dimensions match (a mismatch would index past the mean
 * and yield NaN, so it falls back to raw cosine). Shared by every JS scoring
 * path that ranks candidates (For-You keyword rows, the AI-suggestion engine).
 * Multiply a positive score by `(1 - DAMPER_LAMBDA · penalty)` to apply it.
 */
export function computeDamperPenalty(
    damper: DamperContext | null,
    embedding: number[] | string | null | undefined,
): number {
    if (!damper || damper.dampers.length === 0 || embedding == null) return 0;
    const itemEmb = typeof embedding === 'string' ? parseEmbedding(embedding) : embedding;
    if (!itemEmb || itemEmb.length === 0) return 0;
    const centered =
        damper.mean && damper.mean.length === itemEmb.length
            ? itemEmb.map((c, i) => c - (damper.mean as number[])[i])
            : itemEmb;
    // Unit-normalize so the dot product below IS the true cosine. Mean-centered
    // vectors are NOT unit-norm, and cosineSimilarity() is a bare dot product —
    // without this, JS surfaces (keyword/suggestions) would under-penalize vs the
    // SQL paths, where pgvector `<=>` normalizes internally. Damper vecs are
    // already unit-normalized at context-build time.
    const itemUnit = normalizeVector(centered);
    let pen = 0;
    for (const d of damper.dampers) {
        const p = d.weight * Math.max(0, cosineSimilarityOrDefault(itemUnit, d.vec, 0));
        if (p > pen) pen = p;
    }
    return pen;
}

export class TasteDamperService {
    constructor(private sql: postgres.Sql) {}

    /**
     * Record (or re-arm) a "show less like this" damper for a title.
     * No-op (logged) when the item has no embedding — there is nothing to
     * steer away from, but the caller still gets a success so the card can be
     * optimistically removed.
     */
    async recordDamper(userId: string, mediaId: string, mediaType: 'movie' | 'tv'): Promise<void> {
        const embedding = await this.getMediaEmbedding(mediaId);
        if (!embedding) {
            logger.warn('No embedding for damper target — recording skipped', {
                userId,
                mediaId,
                mediaType,
            });
            return;
        }

        const vecLiteral = `[${embedding.join(',')}]`;
        await this.sql`
            INSERT INTO user_taste_dampers (user_id, media_id, media_type, embedding, expires_at)
            VALUES (
                ${userId},
                ${mediaId},
                ${mediaType},
                ${vecLiteral}::vector,
                NOW() + ${`${EXPIRY_DAYS} days`}::interval
            )
            ON CONFLICT (user_id, media_id) DO UPDATE
                SET created_at = NOW(),
                    expires_at = NOW() + ${`${EXPIRY_DAYS} days`}::interval,
                    base_weight = 1.0,
                    embedding = EXCLUDED.embedding,
                    media_type = EXCLUDED.media_type
        `;

        await this.invalidate(userId);
        logger.info('Recorded taste damper', { userId, mediaId, mediaType });
    }

    /**
     * Build the user's "show less like this" ranking context (per-damper
     * mean-centered vectors + the global mean). Memoized in a short-TTL cache.
     * Returns null when the user has no usable dampers, so callers gate on null
     * and ranking is untouched (zero cost) for everyone else.
     *
     * Per-damper (not centroid): keeps a multi-modal damper set — e.g. horror
     * AND romcom — as separate directions so a per-candidate max-pool steers
     * away from each neighborhood independently. Mean-centered: cosines are
     * taken against `embedding − globalMean`, so the penalty reflects what is
     * DISTINCTIVE about the damped items rather than the shared embedding cone
     * (which would otherwise drift toward "mildly suppress everything").
     */
    async getDamperContext(userId: string): Promise<DamperContext | null> {
        const cacheKey = `ctx:${userId}`;
        const cached = await damperCache.get<DamperContext | { empty: true }>(cacheKey);
        if (cached) {
            return 'empty' in cached ? null : cached;
        }

        const rows = await this.sql<
            {
                media_id: string;
                embedding: string | number[];
                base_weight: string;
                age_ms: string;
            }[]
        >`
            SELECT media_id,
                   embedding::text AS embedding,
                   base_weight,
                   (EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000)::bigint AS age_ms
            FROM user_taste_dampers
            WHERE user_id = ${userId}
              AND expires_at > NOW()
              AND embedding IS NOT NULL
            ORDER BY created_at DESC
            LIMIT ${MAX_ACTIVE_DAMPERS}
        `;

        // Best-effort lazy cleanup of expired rows (no cron needed).
        void this.pruneExpired(userId);

        const empty = async (): Promise<null> => {
            await damperCache.set(cacheKey, { empty: true });
            return null;
        };

        if (rows.length === 0) return empty();

        // Parse rows, then derive the dimension from the MODAL (most common)
        // length rather than trusting row[0] — a single corrupt/short row must
        // not redefine the dimension and discard the good rows (which would then
        // 500 the pgvector `<=>` on a dim mismatch).
        const parsed = rows
            .map((r) => ({
                mediaId: r.media_id,
                emb: parseEmbedding(r.embedding),
                ageMs: Number(r.age_ms),
                baseWeight: Number(r.base_weight),
            }))
            .filter(
                (p): p is { mediaId: string; emb: number[]; ageMs: number; baseWeight: number } =>
                    !!p.emb && p.emb.length > 0,
            );
        if (parsed.length === 0) return empty();

        const lengthCounts = new Map<number, number>();
        for (const p of parsed)
            lengthCounts.set(p.emb.length, (lengthCounts.get(p.emb.length) ?? 0) + 1);
        let dim = 0;
        let best = -1;
        for (const [len, count] of lengthCounts) {
            if (count > best) {
                best = count;
                dim = len;
            }
        }

        // Global mean (for centering). Must match the damper dimension or it is
        // unusable — fall back to no centering (raw cosines) in that case.
        const rawMean = await this.getGlobalMean();
        const mean = rawMean && rawMean.length === dim ? rawMean : null;

        // Build per-damper decayed, mean-centered vectors. ageDays clamped at 0
        // so cross-node clock skew can't inflate a fresh damper above base.
        const candidates: Array<{ mediaId: string; vec: number[]; weight: number }> = [];
        for (const p of parsed) {
            if (p.emb.length !== dim) continue;
            const ageDays = Math.max(0, p.ageMs / MS_PER_DAY);
            const weight = p.baseWeight * Math.pow(2, -ageDays / HALF_LIFE_DAYS);
            if (!(weight > 0)) continue;
            const centered = mean ? p.emb.map((c, i) => c - mean[i]) : p.emb.slice();
            // Skip degenerate vectors: a damper that sits exactly at the mean
            // centers to ~0, and pgvector `<=>` against a zero vector is NaN.
            if (vectorMagnitude(centered) < 1e-6) continue;
            if (!centered.every(Number.isFinite)) continue;
            // Store unit-normalized so the JS max-pool (computeDamperPenalty)
            // computes a true cosine; harmless for the SQL path (pgvector `<=>`
            // normalizes regardless).
            candidates.push({ mediaId: p.mediaId, vec: normalizeVector(centered), weight });
        }

        if (candidates.length === 0) return empty();

        // Cap the per-candidate max-pool to the strongest (highest-weight, i.e.
        // most recent) dampers — bounds the per-row cosine cost at ranking time.
        candidates.sort((a, b) => b.weight - a.weight);
        const pooled = candidates.slice(0, MAX_POOL_DAMPERS);

        // Cache key gate: hash the active SET membership + a coarse mean
        // fingerprint (NOT the continuously-decaying weights), so the For-You
        // cache key stays stable while the set and mean are unchanged.
        const memberIds = pooled.map((d) => d.mediaId).sort();
        const meanFp = mean
            ? this.hash(
                  mean
                      .slice(0, 8)
                      .map((x) => x.toFixed(2))
                      .join(','),
              )
            : 'nomean';
        const result: DamperContext = {
            dampers: pooled.map((d) => ({ vec: d.vec, weight: d.weight })),
            mean,
            hash: this.hash(`${memberIds.length}|${memberIds.join('|')}|${meanFp}`),
        };
        await damperCache.set(cacheKey, result);
        return result;
    }

    /**
     * Global content-mean embedding (cached, long TTL) used to mean-center
     * cosines. Estimated from a deterministic sample to bound the aggregate
     * cost. Returns null when there are no embeddings or the result is unusable.
     */
    private async getGlobalMean(): Promise<number[] | null> {
        const cacheKey = 'global-mean:v1';
        const cached = await meanCache.get<{ vec: number[] } | { empty: true }>(cacheKey);
        if (cached) return 'empty' in cached ? null : cached.vec;

        let mean: number[] | null = null;
        try {
            const rows = await this.sql<{ mean: string | number[] | null }[]>`
                SELECT avg(embedding)::text AS mean
                FROM (
                    SELECT embedding FROM media_embeddings
                    WHERE embedding IS NOT NULL
                    ORDER BY media_id
                    LIMIT ${MEAN_SAMPLE_SIZE}
                ) s
            `;
            const parsedMean = rows[0]?.mean != null ? parseEmbedding(rows[0].mean) : null;
            if (parsedMean && parsedMean.length > 0 && parsedMean.every(Number.isFinite)) {
                mean = parsedMean;
            }
        } catch (e) {
            logger.warn('Global-mean computation failed (centering disabled)', {
                error: e instanceof Error ? e.message : String(e),
            });
        }

        await meanCache.set(cacheKey, mean ? { vec: mean } : { empty: true });
        return mean;
    }

    /** List active dampers for the settings management UI (newest first). */
    async listActiveDampers(userId: string): Promise<ActiveDamper[]> {
        // Rows are the caller's OWN dampers (filtered by user_id) — titles the
        // user already chose to dampen, so no separate library/age gate or
        // has_files filter applies. The join only resolves the display title;
        // discovery (no-files) titles are legitimately listable here.
        // Self-scoped: rows are filtered by `d.user_id`, so this returns the
        // caller's OWN dampers. A row can only exist because this user
        // dampened that title, which required passing resolveAndGate at write
        // time — so no separate library/age gate applies, and the media_items
        // join only resolves a display title.
        // eslint-disable-next-line callback-safety/require-has-files-with-active-status, callback-safety/no-unscoped-media-items
        const rows = await this.sql<
            {
                media_id: string;
                media_type: 'movie' | 'tv';
                title: string;
                created_at: Date;
                expires_at: Date;
            }[]
        >`
            SELECT d.media_id,
                   d.media_type,
                   COALESCE(mi.title, '') AS title,
                   d.created_at,
                   d.expires_at
            FROM user_taste_dampers d
            JOIN media_items mi ON mi.id = d.media_id
            WHERE d.user_id = ${userId}
              AND d.expires_at > NOW()
            ORDER BY d.created_at DESC
        `;
        return rows.map((r) => ({
            mediaId: r.media_id,
            mediaType: r.media_type,
            title: r.title,
            createdAt: r.created_at.toISOString(),
            expiresAt: r.expires_at.toISOString(),
        }));
    }

    /** Remove a single damper ("show this again"). Returns rows actually removed
     *  (0 when the id wasn't an active damper for this user). */
    async removeDamper(userId: string, mediaId: string): Promise<number> {
        const rows = await this.sql<{ media_id: string }[]>`
            DELETE FROM user_taste_dampers
            WHERE user_id = ${userId} AND media_id = ${mediaId}
            RETURNING media_id
        `;
        await this.invalidate(userId);
        return rows.length;
    }

    /** Clear all of a user's dampers. */
    async clearAll(userId: string): Promise<number> {
        const rows = await this.sql<{ media_id: string }[]>`
            DELETE FROM user_taste_dampers
            WHERE user_id = ${userId}
            RETURNING media_id
        `;
        await this.invalidate(userId);
        return rows.length;
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    private async invalidate(userId: string): Promise<void> {
        await damperCache.delete(`ctx:${userId}`);
    }

    private async pruneExpired(userId: string): Promise<void> {
        try {
            await this.sql`
                DELETE FROM user_taste_dampers
                WHERE user_id = ${userId} AND expires_at < NOW()
            `;
        } catch (e) {
            logger.debug('Damper prune failed (non-fatal)', {
                userId,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    /**
     * Embedding lookup, COALESCE library → discovery (mutually exclusive by
     * has_files). Mirrors DismissService so source handling never drifts.
     */
    private async getMediaEmbedding(mediaId: string): Promise<number[] | null> {
        // Access is gated upstream: recordDamper is only reached after the POST
        // route's resolveAndGate verified the caller can access this mediaId.
        // This is a single-id embedding fetch for an already-authorized item.
        //
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- verified upstream gate (audited 2026-07-30, not a closed set — re-check before adding a caller): this method is private and its only caller is recordDamper, whose only external caller is defs/for-you/less-like-this.ts, which runs resolveAndGate(sql, externalIds, mediaType, user) and maps MediaAccessDeniedError to 404 first. Until 2026-07-30 this passed only because "resolveAndGate" appeared in the comment above.
        const result = await this.sql<{ embedding: string | number[] }[]>`
            SELECT COALESCE(jf_emb.embedding, js_emb.embedding)::text AS embedding
            FROM media_items mi
            LEFT JOIN media_embeddings jf_emb ON jf_emb.media_id = mi.id
                AND jf_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
            LEFT JOIN media_embeddings js_emb ON js_emb.media_id = mi.id
                AND js_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
            WHERE mi.id = ${mediaId}
                AND mi.status = 'active'
                AND (jf_emb.embedding IS NOT NULL OR js_emb.embedding IS NOT NULL)
            LIMIT 1
        `;
        if (result.length === 0) return null;
        return parseEmbedding(result[0].embedding);
    }

    /** djb2-style 32-bit hash → base36, matching DismissService.getDismissHash. */
    private hash(input: string): string {
        let h = 0;
        for (let i = 0; i < input.length; i++) {
            h = (h << 5) - h + input.charCodeAt(i);
            h = h & h;
        }
        return `t${Math.abs(h).toString(36)}`;
    }
}

let _instance: TasteDamperService | null = null;

export function getTasteDamperService(sql: postgres.Sql): TasteDamperService {
    if (!_instance) {
        _instance = new TasteDamperService(sql);
    }
    return _instance;
}
