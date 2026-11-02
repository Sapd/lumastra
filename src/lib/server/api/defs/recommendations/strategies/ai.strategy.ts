// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AiStrategy — wraps the existing AI suggestion engine.
 *
 * Collapses (§rename-map):
 *   ai/suggestions           → recommendations?type=ai
 *   ai/suggestions/by-genre  → recommendations?type=ai&genre=
 *   ai/suggestions/more-series → recommendations?type=ai&type=series
 *   mood-recommendations     → recommendations?type=mood
 *   mood-recommendations/suggestions → same (+ P0 auth fix applied by mount)
 */

import type {
    RecommenderStrategy,
    AccessContext,
    RecommenderOptions,
    RecommenderResult,
    RecommendationItem,
    RecommendedMediaRef,
} from '../recommender.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { createExternalIds } from '$lib/utils/external-ids.js';
import {
    DependencyUnavailableError,
    isDependencyUnavailable,
    AISuggestionRateLimitError,
} from '$lib/server/api/problem.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import type { UserSuggestionRow } from '$lib/server/database/queries/suggestion-management.queries.js';
import type { SuggestionReasonData } from '$lib/server/database/utils/recommendation-helpers.js';
import type { MediaRailMetadata } from '$lib/server/database/queries/media-rail-metadata.queries.js';
import { pickDisplayRating } from '$lib/server/utils/rating-utils.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { Sql } from 'postgres';
import { m } from '$lib/paraglide/messages.js';
import {
    checkRateLimit,
    RateLimitPresets,
    aiSuggestionRateLimitKey,
} from '$lib/server/middleware/valkey-rate-limit.js';
import { isGenuineDbFault } from '../db-fault.js';

const logger = Logger.for('AiStrategy');

/**
 * Resolve the rail's media access boundary from the request's `AccessContext`.
 *
 * Replaces the inline `{ deniedGroupIds, ageRating: maxAgeRating != null ? … : null }`
 * pair this strategy used to hand to `filterAccessibleMediaIds`. That ternary was
 * lossy in one direction that mattered: "no age policy configured" and "age policy
 * is unrestricted" both collapsed to `null`. Under `AgeScope` the unrestricted case
 * is the explicit `{ kind: 'any' }` variant instead.
 *
 * Mapping is byte-identical to what the legacy pair produced, so which rows a
 * restricted user sees does not change:
 * - `deniedGroupIds` null (no DB during context build) or empty -> `{ kind: 'all' }`
 * - `deniedGroupIds` non-empty -> `{ kind: 'denyGroups' }`
 * - `maxAgeRating` null -> `{ kind: 'any' }`; numeric -> `{ kind: 'limit' }`
 *
 * KNOWN LIMIT: `AccessContext` cannot express `denyAll` on either axis, so this
 * derivation can never produce one. `filterSuggestionsByAccess` accepts a full
 * boundary — including `denyAll` — so the enforcement path is complete even
 * though today's only caller cannot reach that state. Closing the gap requires
 * resolving the boundary once in `buildAccessContext`, which is a separate change.
 */
export function aiAccessBoundary(ctx: AccessContext): MediaAccessBoundary {
    return restrictedAccess({
        deniedGroupIds: ctx.deniedGroupIds ?? [],
        maxAgeRating: ctx.maxAgeRating,
        allowUnrated: ctx.allowUnrated,
    });
}

/**
 * Apply a REQUIRED media access boundary to a batch of persisted suggestion rows.
 *
 * Extracted from `AiStrategy.fetch` so the boundary is enforced by a function
 * that cannot be called without one — and so the differential tests can drive
 * every scope variant (including `denyAll`, which `AccessContext` cannot encode).
 *
 * ORDERING CONTRACT: this only filters. It must NOT be turned into a
 * short-circuit that skips the fetch for a `denyAll` boundary — `fetch` derives
 * its `generating` / `exhausted` status from the RAW pre-filter row count, and a
 * `denyAll` caller must land on `exhausted` (nothing eligible), never on
 * `generating` (which makes the client retry forever).
 */
export async function filterSuggestionsByAccess(
    sql: Sql,
    rows: readonly UserSuggestionRow[],
    boundary: MediaAccessBoundary,
): Promise<UserSuggestionRow[]> {
    if (rows.length === 0) return [];
    const { filterAccessibleMediaIds } = await import('$lib/server/utils/media-access-batch.js');
    const allowed = await filterAccessibleMediaIds(
        sql,
        rows.map((r) => r.media_id),
        boundary,
    );
    return rows.filter((r) => allowed.has(r.media_id));
}

/** Decoded cursor payload — see `decodeCursor`. */
interface DecodedCursor {
    offset: number;
    /**
     * Generation token: epoch-ms `created_at` of the first (highest-ranked)
     * row in the persisted suggestion batch this cursor was issued against.
     * 0 when the cursor predates the gen token or carries none.
     */
    gen: number;
}

/**
 * Decode an opaque `"o:<offset>:<gen>"` cursor. Malformed/absent/legacy
 * (pre-gen-token `"o:<offset>"`) cursors → `{ offset: 0, gen: 0 }`, matching
 * the historic offset-0 fallback behavior.
 *
 * `offset` is additionally rejected (→ 0) unless it's a safe integer clamped
 * to `[0, 100_000]` — defends against a corrupted/adversarial cursor driving
 * an absurd fetchCount downstream.
 */
function decodeCursor(cursor?: string): DecodedCursor {
    if (!cursor) return { offset: 0, gen: 0 };
    try {
        const raw = Buffer.from(cursor, 'base64url').toString('utf8');
        const m = /^o:(\d+):(\d+)$/.exec(raw);
        if (!m) return { offset: 0, gen: 0 };

        const rawOffset = Number.parseInt(m[1], 10);
        const offset = Number.isSafeInteger(rawOffset)
            ? Math.min(Math.max(rawOffset, 0), 100_000)
            : 0;

        const rawGen = Number.parseInt(m[2], 10);
        const gen = Number.isSafeInteger(rawGen) ? rawGen : 0;

        return { offset, gen };
    } catch {
        return { offset: 0, gen: 0 };
    }
}

/** Encode an offset+gen into the opaque cursor format `decodeCursor` reads back. */
function encodeCursor(offset: number, gen: number): string {
    return Buffer.from(`o:${offset}:${gen}`, 'utf8').toString('base64url');
}

/**
 * Map a persisted `reason_data` row to the client-facing structured reason.
 * Never surfaces the English `explanation`/`suggestion_reason` text as `label`.
 */
function mapReason(reasonData: SuggestionReasonData | null): RecommendationItem['reason'] {
    if (!reasonData) return { kind: 'ai' };
    // reasonData is read back from a jsonb column — the TS union shape is a
    // compile-time contract, not a runtime guarantee (older/foreign rows can
    // carry a partial or malformed payload). Validate per-kind before
    // trusting it so a bad row renders `{ kind: 'ai' }` instead of
    // "undefined" leaking into the client-facing reason.
    switch (reasonData.kind) {
        case 'rated-similar':
            if (typeof reasonData.title === 'string' && typeof reasonData.rating === 'number') {
                return {
                    kind: 'rated-similar',
                    seed: reasonData.title,
                    label: String(reasonData.rating),
                };
            }
            return { kind: 'ai' };
        case 'genre-affinity':
            if (typeof reasonData.genre === 'string') {
                return { kind: 'genre-affinity', seed: reasonData.genre };
            }
            return { kind: 'ai' };
        case 'ai':
        default:
            return { kind: 'ai' };
    }
}

export class AiStrategy implements RecommenderStrategy {
    readonly id = 'ai';
    readonly label = m.section_recommended_for_you;

    async fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        if (!opts.cursor && opts.refresh) {
            const budget = RateLimitPresets.AI_SUGGESTIONS;
            const result = await checkRateLimit(
                aiSuggestionRateLimitKey(ctx.userId),
                budget.limit,
                budget.windowSeconds,
            );
            if (!result.allowed) {
                throw new AISuggestionRateLimitError(
                    Math.max(1, Math.ceil(result.resetAt - Date.now() / 1000)),
                );
            }
        }
        try {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) {
                // DB DOWN — signal dependency-down (NOT genuine-empty).
                throw new DependencyUnavailableError('Database unavailable', 'postgres');
            }

            // Map new canonical type to old media_type value ('series' → 'tv')
            const mediaTypeForGen: 'movie' | 'tv' | undefined =
                opts.mediaType === 'movie'
                    ? 'movie'
                    : opts.mediaType === 'series'
                      ? 'tv'
                      : undefined;

            const { offset, gen: cursorGen } = decodeCursor(opts.cursor);
            // Headroom because access filtering happens post-fetch: fetch
            // offset + limit*2 + 1 rows ordered by combined_score DESC, then
            // access-filter, THEN slice [offset, offset + limit].
            const fetchCount = offset + opts.limit * 2 + 1;

            let rows: UserSuggestionRow[];

            if (!opts.cursor && opts.refresh) {
                // Explicit refresh on the first page: force regeneration
                // through the AI engine. Cursor pages NEVER take this branch —
                // pagination must never trigger regeneration mid-scroll.
                const { aiDbService } = await import('$lib/server/services/database.service.js');
                const userProfile = await aiDbService.getUserProfileOrCreate(ctx.userId);
                if (!userProfile?.catalog_embedding && !userProfile?.request_embedding) {
                    return { items: [], hasMore: false, status: 'generating' };
                }
                const engine = await aiDbService.getSuggestionEngine();
                if (!engine) {
                    return { items: [], hasMore: false, status: 'generating' };
                }
                rows = await engine.generateSuggestionsFromProfile(
                    ctx.userId,
                    fetchCount,
                    [],
                    mediaTypeForGen,
                    true,
                );
            } else {
                // Default path (first page without an explicit refresh, and
                // EVERY cursor page): read PERSISTED suggestions.
                const { getUserSuggestions } =
                    await import('$lib/server/database/queries/suggestion-management.queries.js');
                rows = await getUserSuggestions(sql, ctx.userId, fetchCount, {
                    mediaType: mediaTypeForGen,
                });

                // INVARIANT: cursor pages never regenerate; the first page
                // self-heals expired rows. When the read-only load yields
                // zero RAW rows on the FIRST page, fall through ONCE to the
                // engine (refresh=false — its stored-if-fresh short-circuit
                // still applies) so an idle user's expired suggestions
                // (expires_at ≈ 2 days) regenerate instead of the rail going
                // empty forever. Cursor pages stay strictly read-only so the
                // ordered set can never shift underneath mid-pagination.
                if (rows.length === 0 && !opts.cursor) {
                    const { aiDbService } =
                        await import('$lib/server/services/database.service.js');
                    const userProfile = await aiDbService.getUserProfileOrCreate(ctx.userId);
                    if (userProfile?.catalog_embedding || userProfile?.request_embedding) {
                        const engine = await aiDbService.getSuggestionEngine();
                        if (engine) {
                            rows = await engine.generateSuggestionsFromProfile(
                                ctx.userId,
                                fetchCount,
                                [],
                                mediaTypeForGen,
                                false,
                            );
                        }
                    }
                }
            }

            // Generation token for THIS fetched batch — see `DecodedCursor.gen`.
            // Rows are ordered by combined_score DESC, created_at DESC, so the
            // first row is the batch's own generation timestamp whenever the
            // batch was written in one shot (regeneration always is).
            const currentGen = rows.length > 0 ? rows[0].created_at.getTime() : 0;

            // A cursor page's gen must match the batch it was issued against.
            // A mismatch means `user_suggestions` was deleted+reinserted (the
            // every-5th-rating regen cadence) between this page's fetch and
            // the previous one — the stored offset would mis-slice the NEW
            // ordering (duplicates/gaps), so signal exhausted and let the
            // client restart pagination from page 1 instead of returning a
            // wrong page. Cursor pages never regenerate themselves (see the
            // read-only branch above), so this can only be triggered by a
            // regen that happened out-of-band (e.g. a rating submitted while
            // the user was mid-scroll).
            if (opts.cursor && currentGen !== cursorGen) {
                return { items: [], hasMore: false, status: 'exhausted' };
            }

            // Access-filter: library group + age gate. The boundary is REQUIRED
            // by `filterSuggestionsByAccess` — there is no permissive default and
            // no path that reaches the page assembly below unfiltered.
            let filtered = await filterSuggestionsByAccess(sql, rows, aiAccessBoundary(ctx));

            // Library-only filter: always-on server-config gate
            if (!ctx.showUnavailableMedia) {
                filtered = filtered.filter((r) => r.is_available);
            }

            // Drop already-watched titles immediately — watch completion only
            // debounce-rebuilds the profile (6h) without pruning
            // `user_suggestions`, so without this a title watched tonight would
            // otherwise stay "Recommended for You" until the row's 2-day expiry.
            try {
                const { watchManager } =
                    await import('$lib/server/services/watch-manager.service.js');
                const watchedIds = new Set(await watchManager.getWatchedMediaIdsCached(ctx.userId));
                if (watchedIds.size > 0) {
                    filtered = filtered.filter((r) => !watchedIds.has(r.media_id));
                }
            } catch (e) {
                logger.warn('Failed to fetch watched UUIDs for taste-rail filtering', {
                    error: e,
                });
            }

            const hasMore = filtered.length > offset + opts.limit;
            const page = filtered.slice(offset, offset + opts.limit);
            // Issued whenever the page has items, even if hasMore is false, so
            // the client can always ask once more and receive 'exhausted'.
            const nextCursor =
                page.length > 0 ? encodeCursor(offset + page.length, currentGen) : undefined;

            if (page.length === 0) {
                // 'generating' ONLY when there were zero RAW rows even after
                // the first-page self-heal attempt (nothing persisted, nothing
                // producible yet — client should retry later). A cursor page
                // past the end, or a first page whose raw rows were all
                // access-filtered away (there IS nothing eligible; nothing is
                // pending), is 'exhausted'.
                return {
                    items: [],
                    hasMore: false,
                    status: opts.cursor || rows.length > 0 ? 'exhausted' : 'generating',
                };
            }

            // Batch-fetch embeddings for enrichment
            const { aiDbService } = await import('$lib/server/services/database.service.js');
            const embeddingsMap = await aiDbService.getMediaEmbeddingsByUuids(
                page.map((r) => r.media_id),
            );

            // Batch-fetch rail display metadata (overview/ratings/runtime/genres/
            // quality tiers) ONCE for the whole page — never per item, this is
            // the homepage critical path. A hiccup here must not fail the rail.
            let railMetadataMap: Map<string, MediaRailMetadata> = new Map();
            try {
                const { getMediaRailMetadataBatch } =
                    await import('$lib/server/database/queries/media-rail-metadata.queries.js');
                railMetadataMap = await getMediaRailMetadataBatch(
                    sql,
                    page.map((r) => r.media_id),
                );
            } catch (e) {
                logger.warn('Failed to hydrate rail metadata for AI suggestions', { error: e });
            }

            const items: RecommendationItem[] = [];
            for (const row of page) {
                const media = embeddingsMap.get(row.media_id);
                if (!media?.title || media.title === 'undefined' || media.title === 'null')
                    continue;

                const score =
                    row.combined_score ??
                    row.library_similarity_score ??
                    row.discovery_similarity_score ??
                    0;

                const extIds = createExternalIds({
                    [getPrimaryExternalIdProvider()]: row.primary_ext_id
                        ? parseInt(row.primary_ext_id, 10)
                        : undefined,
                    internal: row.media_id,
                });

                const idsRecord: Record<string, string> = {};
                for (const [k, v] of Object.entries(extIds ?? {})) {
                    if (v != null) idsRecord[k] = String(v);
                }

                const railMeta = railMetadataMap.get(row.media_id);
                // IMDb first, TMDB's vote_average only when its vote count
                // clears the display floor. This used to read `imdbRating`
                // alone — correct at the time, because the hydration query
                // extracted a `tmdb_rating` key nothing writes, so the fallback
                // would have been dead weight. Now that it carries a real
                // vote_average/vote_count pair, ~12% of rail items that showed
                // no rating at all can show one.
                const displayRating = pickDisplayRating({
                    imdbRating: railMeta?.imdbRating,
                    tmdbRating: railMeta?.tmdbRating,
                    voteCount: railMeta?.voteCount,
                });

                // A row whose internal media_type has no public representation is
                // SKIPPED (same as the missing-title skip above), never emitted
                // with the raw storage token in `media.type` — the client routes
                // playback off that field.
                const publicType = toPublicMediaType(row.media_type);
                if (!publicType) continue;

                const mediaRef: RecommendedMediaRef = {
                    id: row.media_id,
                    type: publicType,
                    title: media.title,
                    year:
                        media.release_year ??
                        (media.release_date ? new Date(media.release_date).getFullYear() : null),
                    ids: idsRecord,
                    ...(railMeta?.overview ? { overview: railMeta.overview } : {}),
                    ...(displayRating != null ? { rating: displayRating } : {}),
                    ...(railMeta?.rtRating != null ? { criticRating: railMeta.rtRating } : {}),
                    ...(railMeta?.runtimeMinutes != null
                        ? { durationMs: Math.round(railMeta.runtimeMinutes * 60_000) }
                        : {}),
                    ...(railMeta?.genres && railMeta.genres.length > 0
                        ? { genres: railMeta.genres }
                        : {}),
                    ...(railMeta?.certification ? { certification: railMeta.certification } : {}),
                    ...(railMeta?.resolutionTier
                        ? { resolutionTier: railMeta.resolutionTier }
                        : {}),
                    ...(railMeta?.hdrTier ? { hdrTier: railMeta.hdrTier } : {}),
                    ...(railMeta?.hasAtmos ? { hasAtmos: true } : {}),
                    ...(railMeta?.hasCc ? { hasCc: true } : {}),
                    ...(railMeta?.hasSdh ? { hasSdh: true } : {}),
                    ...(railMeta?.hasAd ? { hasAd: true } : {}),
                };

                items.push({
                    media: mediaRef,
                    score: Math.min(Math.round(score * 100) / 100, 1),
                    // AI suggestions can be discovery-sourced (has_files=false); carry
                    // availability so the client gates the Watch button.
                    isAvailable: row.is_available,
                    canRequest: row.can_request,
                    reason: mapReason(row.reason_data),
                });
            }

            // Derive status from the POST-mapping count, not the raw page:
            // every row can still be dropped in the loop above (missing/
            // invalid title) even though raw rows existed and passed
            // access-filtering — that's genuinely nothing renderable, i.e.
            // 'exhausted', not a false 'ready' with an empty items array.
            return {
                items,
                hasMore,
                nextCursor,
                status: items.length === 0 ? 'exhausted' : 'ready',
            };
        } catch (err) {
            // Propagate dependency-down so the caller can return 503 / drop the section.
            if (isDependencyUnavailable(err)) throw err;

            // A genuine Postgres fault (query or connection) must not
            // masquerade as a legitimately-empty rail. Every SUCCESS path
            // above returns an explicit `status` ('ready' | 'exhausted' |
            // 'generating') — falling through to `{ items: [], hasMore:
            // false }` here left `status` undefined, and the caller
            // (`getTasteRailPage` in for-you/taste.ts) defaults a missing
            // status to `'ready'`. Classify it as dependency-down instead so
            // it takes the SAME 503 (Tier-2 `/api/for-you/taste`) /
            // dropped-section (`/feed`) path as the `!getDb()` check above,
            // rather than a status-less "empty but fine" 200.
            if (isGenuineDbFault(err)) {
                logger.error(
                    'AiStrategy fetch error — database fault, reporting dependency-down',
                    err as Error,
                );
                throw new DependencyUnavailableError('AI suggestions query failed', 'postgres');
            }

            // Truly unexpected non-DB error (a bug in this method, not the
            // DB) — isolate it here so one buggy strategy can't fail the
            // whole request, matching `runRecommender`'s own catch-all
            // philosophy for programming errors outside known failure modes.
            logger.error('AiStrategy fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }
}

export const aiStrategy = new AiStrategy();
