// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The default (first) page of mood-ranked tracks, cached per mood + limit +
 * access scope.
 *
 * Two readers share it: GET music/mood-recommendations (the page itself) and
 * GET music/moods (each mood's cover collage is built from the albums on this
 * page, so the chip art matches what tapping it plays — and listing the moods
 * pre-warms the entry the tap is about to read).
 */

import { warmMusicCollages } from './collage-warmup.js';
import type postgres from 'postgres';
import {
    getMusicMoodRecommendations,
    type MoodRecommendationRow,
    type MoodRecommendationsCursor,
} from '$lib/server/database/queries/music-recommendations.queries.js';
import {
    encodeKeysetCursor,
    decodeKeysetCursor,
} from '$lib/server/database/queries/builders/keyset-cursor.builder.js';
import {
    scopedCacheKey,
    type SearchAccessContext,
} from '$lib/server/utils/search-access-context.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';
import { musicMoodVectorKey } from '$lib/server/database/queries/sonic-queue.queries.js';

/** Default page size of mood-recommendations; also the page music/moods reads. */
export const DEFAULT_MOOD_PAGE_LIMIT = 20;

const MOOD_CURSOR_TAG = 'mr:';
const MOOD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MOOD_FLOAT_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function encodeMoodCursor(cursor: MoodRecommendationsCursor): string {
    return MOOD_CURSOR_TAG + encodeKeysetCursor({ ts: cursor.distance, id: cursor.id });
}

export function decodeMoodCursor(raw: string): MoodRecommendationsCursor | null {
    if (!raw.startsWith(MOOD_CURSOR_TAG)) return null; // untagged / other feed
    const core = decodeKeysetCursor(raw.slice(MOOD_CURSOR_TAG.length));
    if (!core) return null;
    // Validate both halves before they reach Postgres (a bogus value would 500
    // as 22P02 instead of a clean 422).
    if (!MOOD_UUID_RE.test(core.id)) return null;
    if (!MOOD_FLOAT_RE.test(core.ts)) return null;
    return { distance: core.ts, id: core.id };
}

/**
 * Cached payload holds raw DB rows, NOT rendered tracks — mood-recommendations
 * is mounted on two surfaces with different `surface` values (internal
 * `/api/image`, v1 `/api/v1/media`), and those hrefs differ. Baking hrefs into
 * the shared cache entry would let whichever surface warms the entry first
 * poison the other surface's response until TTL expiry, so `images{}` is
 * built from `rows` at request time.
 */
export interface MoodPageCache {
    rows: MoodRecommendationRow[];
    nextCursor: string | null;
}

/**
 * Slice the limit+1 fetch down to a page and mint the next keyset cursor from
 * the last surviving row (Gate I1/J1). `rows` MUST be the raw query rows (they
 * carry `distance_cursor`), not already-mapped tracks.
 */
export function buildMoodPage(
    rows: MoodRecommendationRow[],
    limit: number,
): { rows: MoodRecommendationRow[]; nextCursor?: string } {
    const hasMore = rows.length > limit;
    const sliced = rows.slice(0, limit);
    let nextCursor: string | undefined;
    if (hasMore && sliced.length > 0) {
        const last = sliced[sliced.length - 1];
        if (last.distance_cursor != null) {
            nextCursor = encodeMoodCursor({ distance: last.distance_cursor, id: last.id });
        }
    }
    return { rows: sliced, nextCursor };
}

/**
 * Read (or compute and cache) the first page for a bare mood key.
 *
 * The query depends only on (mood, limit, library/age access scope) — NOT on
 * the user — so an access-scoped key partitioned by mood + limit is the correct
 * and sufficient scope. Errors propagate (no swallow-to-empty): an empty page
 * means the mood matched nothing, never that the query failed.
 */
export async function getCachedMoodPage(
    sql: postgres.Sql,
    moodParam: string,
    limit: number,
    accessCtx: SearchAccessContext,
): Promise<MoodPageCache> {
    const moodCache = cacheManager.for(CACHE_NAMESPACES.musicMoodRecommendations);
    const cacheKey = scopedCacheKey('music-mood-recs-v3', accessCtx, [moodParam, limit]);

    const hit = await moodCache.get<MoodPageCache>(cacheKey);
    if (hit) return hit;

    // Single-flight the cosine vector query so a burst of concurrent
    // cold-cache misses runs it once instead of stampeding the DB.
    // Raw Valkey key mirrors UnifiedCache.buildL2Key(cacheKey) for
    // this non-user-scoped namespace: `${ns.name}:${cacheKey}`.
    const ns = CACHE_NAMESPACES.musicMoodRecommendations;
    const rawKey = `${ns.name}:${cacheKey}`;
    const ttlSeconds = Math.floor(ns.l2TTL / 1000);
    const moodKey = musicMoodVectorKey(moodParam);
    const access = { deniedGroupIds: accessCtx.deniedGroupIds, ageRating: accessCtx.ageRating };
    const jsonStr = await getOrComputeSingleFlight({
        cacheKey: rawKey,
        ttlSeconds,
        compute: async () => {
            // Fetch limit+1 so the default response can carry a
            // bootstrap nextCursor (Gate J1) when more tracks exist.
            const rows = await getMusicMoodRecommendations(sql, moodKey, limit + 1, access);
            const page = buildMoodPage(rows, limit);
            return JSON.stringify({ rows: page.rows, nextCursor: page.nextCursor ?? null });
        },
    });
    const page = JSON.parse(jsonStr) as MoodPageCache;
    // Populate L1 so subsequent in-process reads skip Valkey.
    void moodCache.set(cacheKey, page);
    if (limit === DEFAULT_MOOD_PAGE_LIMIT) {
        warmMusicCollages(sql, [page.rows.map((row) => row.album_id ?? row.id)]);
    }
    return page;
}
