// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BecauseYouWatchedStrategy — seed-based "because you watched/listened" recommendations.
 *
 * Collapses (§rename-map):
 *   for-you/music-because → recommendations?type=because-you-watched&domain=music
 *
 * When `opts.extra.domain === 'music'` the strategy sources similar music tracks
 * from the user's most recently played audio track using embedding cosine
 * similarity (`getMusicBecauseYouListened`).
 *
 * When `opts.extra.domain` is omitted or equals `'video'`, it seeds from the user's most
 * recently-watched LIBRARY video (movie/series) and expands it via
 * `fetchSimilarMedia` (pgvector similarity).  A video Home surface passes
 * `?domain=video` so music seeds/results can never bleed into the rail.
 *
 * The `seed` option carries the internal UUID of the anchor item when the caller
 * supplies one explicitly (e.g. client-side "more like this" button).  Both
 * domains currently derive the seed from recent activity, so `opts.seed` is
 * forwarded but unused — the service/seed-selection handles it.
 */

import type {
    RecommenderStrategy,
    AccessContext,
    RecommenderOptions,
    RecommenderResult,
    RecommendationItem,
} from '../recommender.js';
import type { SimilarMediaAccess } from '$lib/server/services/for-you.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { DependencyUnavailableError, isDependencyUnavailable } from '$lib/server/api/problem.js';
import { overlaySeedTitles } from '../seed-title-overlay.js';
import { buildImageRefs } from '$lib/shared/api-urls.js';

const logger = Logger.for('BecauseYouWatchedStrategy');

export class BecauseYouWatchedStrategy implements RecommenderStrategy {
    readonly id = 'because-you-watched';
    // Never rendered: /feed builds BYW titles from the seed (feed-byw-sections.ts).
    // Present only to satisfy the interface; deliberately not a message key.
    readonly label = (): string => 'Because You Listened To…';

    async fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        // The public recommendations endpoint is video-first. Music callers
        // pass domain=music explicitly; defaulting here to music made an
        // unqualified because-you-watched request emit tracks to video clients.
        const domain = (opts.extra?.domain as string | undefined) ?? 'video';

        if (domain === 'music') {
            return this.#fetchMusic(ctx, opts);
        }

        if (domain === 'video') {
            return this.#fetchVideo(ctx, opts);
        }

        logger.warn(`BecauseYouWatchedStrategy: unsupported domain '${domain}' — returning empty`);
        return { items: [], hasMore: false };
    }

    async #fetchVideo(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        // AI-powered similarity is not offered to age-restricted profiles — the
        // same policy `/api/for-you/similar` enforces. Return empty (section
        // dropped) rather than throwing, so the /feed compositor is unaffected.
        if (ctx.isAgeRestricted) {
            return { items: [], hasMore: false };
        }

        try {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) {
                throw new DependencyUnavailableError('Database unavailable', 'postgres');
            }

            const { getRecentWatchedMoviesWithEmbeddings, getRecentWatchedTvWithEmbeddings } =
                await import('$lib/server/database/queries/index.js');
            const { restrictedAccess } =
                await import('$lib/server/database/queries/builders/media-access-boundary.js');
            const { fetchSimilarMedia } = await import('$lib/server/services/for-you.service.js');
            const { getUserWatchedItems } = await import('$lib/server/utils/user-watch-history.js');
            const { createExternalIds, getExternalIdFor } =
                await import('$lib/utils/external-ids.js');
            const { getPrimaryExternalIdProvider } =
                await import('$lib/server/utils/provider-config.js');
            const { mapBatch, hydrateRailMetadata } = await import('../../for-you/item-mapper.js');

            // Access boundary from the recommender's already-resolved context —
            // NOT re-derived. Applied by the seed queries AND fetchSimilarMedia.
            const boundary = restrictedAccess({
                deniedGroupIds: ctx.deniedGroupIds ?? [],
                maxAgeRating: ctx.maxAgeRating,
                allowUnrated: ctx.allowUnrated,
            });

            // Seed pool: the most-recently-watched library video. Both queries
            // INNER JOIN media_embeddings, so every candidate already has an
            // embedding for the similarity expansion. Merge and pick the single
            // most-recent as the "Because you watched X" anchor (mirrors the
            // music path's recentTracks[0]).
            const SEED_POOL = 5;
            const [movies, tv] = await Promise.all([
                getRecentWatchedMoviesWithEmbeddings.all(sql, {
                    userId: ctx.userId,
                    limit: SEED_POOL,
                    access: boundary,
                }),
                getRecentWatchedTvWithEmbeddings.all(sql, {
                    userId: ctx.userId,
                    limit: SEED_POOL,
                    access: boundary,
                }),
            ]);
            const pool = [...movies, ...tv].sort(
                (a, b) => new Date(b.watched_at).getTime() - new Date(a.watched_at).getTime(),
            );

            // Resolve the anchor seed. An explicit opts.seed (BYW fan-out /
            // "more like this") wins: prefer a matching pooled row (already
            // access-scoped by the seed query + carries title/tmdb_id), else
            // resolve the UUID via the DB — but ONLY after (m4) validating the
            // UUID shape and (M2) vetting it against this caller's access
            // boundary, since resolveUuidToProvider applies no boundary of its
            // own. A denied / unresolvable / non-UUID seed is indistinguishable
            // from a nonexistent one: silently fall back to pool[0].
            let seed: {
                media_id: string;
                tmdb_id: string;
                media_type: string;
                title: string;
            } | null = null;
            if (opts.seed) {
                const pooled = pool.find((r) => r.media_id === opts.seed);
                if (pooled) {
                    seed = pooled;
                } else {
                    const { UUID_RE } = await import('$lib/utils/id-patterns.js');
                    if (UUID_RE.test(opts.seed)) {
                        const { resolveUuidToProvider } =
                            await import('$lib/server/database/queries/embedding-similarity.queries.js');
                        const { filterAccessibleRows } =
                            await import('$lib/server/utils/media-access-batch.js');
                        const resolved = await resolveUuidToProvider(sql, opts.seed);
                        if (
                            resolved &&
                            (resolved.media_type === 'movie' || resolved.media_type === 'tv')
                        ) {
                            // M2: the caller must actually be allowed to see this
                            // item, else `?seed=` is an existence oracle + a way
                            // to anchor a rail on denied content.
                            const allowed = await filterAccessibleRows(
                                sql,
                                [{ id: opts.seed }],
                                boundary,
                            );
                            if (allowed.length > 0) {
                                seed = {
                                    media_id: opts.seed,
                                    tmdb_id: resolved.tmdb_id,
                                    media_type: resolved.media_type,
                                    title: resolved.title, // M1: the seed's OWN title
                                };
                            }
                        }
                    }
                }
            }
            if (!seed) {
                if (pool.length === 0) {
                    return { items: [], hasMore: false };
                }
                seed = pool[0];
            }
            // The seed queries emit `media_type` as 'movie' | 'tv'.
            // constrained: the seed queries select only movie/tv rows (see the
            // note above); episodes and seasons never enter this pool.
            // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
            const seedMediaType = seed.media_type as 'movie' | 'tv';
            const seedExternalIds = createExternalIds({
                internal: seed.media_id,
                [getPrimaryExternalIdProvider()]: seed.tmdb_id,
            }) as Record<string, string>;

            // Server-side watched history → in-query composite (id, mediaType)
            // exclusion so already-watched titles never resurface in the rail
            // (same source /api/for-you/similar uses).
            const watchedItems = (await getUserWatchedItems(ctx.username, 500)).map((w) => ({
                externalIds: createExternalIds({
                    [getPrimaryExternalIdProvider()]: w.primary_ext_id,
                }),
                mediaType: w.media_type,
            }));

            const access: SimilarMediaAccess = {
                boundary,
                // Cache-partitioning only; a video "because you watched" rail
                // never returns live TV. Constant keeps the key stable.
                liveTvAllowed: true,
                showUnavailableMedia: ctx.showUnavailableMedia,
            };

            // File-less candidates are excluded inside the similarity query (not
            // dropped afterwards) so `limit` counts available titles only.
            const availableOnly = opts.availableOnly === true || !ctx.showUnavailableMedia;
            const rows = await fetchSimilarMedia(
                sql,
                seedExternalIds,
                seedMediaType,
                opts.limit + 1,
                ctx.userId,
                watchedItems,
                access,
                {},
                { availableOnly },
            );

            const { items, hasMore } = mapBatch(
                rows as Array<{
                    externalIds: (typeof rows)[number]['externalIds'];
                    mediaType: string;
                    title: string;
                    rating?: number | null;
                    year?: number | null;
                    isAvailable?: boolean;
                    canRequest?: boolean;
                }>,
                opts.limit,
                'because-you-watched',
                opts.surface,
                (r) => {
                    const sim = (r as { similarity?: number | null }).similarity;
                    return sim != null ? Math.min(sim / 100, 1) : undefined;
                },
            );
            await hydrateRailMetadata(sql, items);

            // reason.label carries the SEED's title — media metadata, so it follows the
            // viewer's metadata language. Without this a German rail is captioned with
            // an English seed title. Same helper the /feed section header uses, so the
            // header and the items always agree.
            const seedOverlay = { id: seed.media_id, title: seed.title };
            await overlaySeedTitles(sql, [seedOverlay], ctx.langs);
            seed.title = seedOverlay.title;

            // Anchor every item to the shared seed so the client can render a
            // "Because you watched <label>" header.
            const seedId = String(getExternalIdFor(seedExternalIds, 'internal') ?? seed.media_id);
            for (const item of items) {
                item.reason = {
                    kind: 'because-you-watched',
                    seed: seedId,
                    label: seed.title,
                };
            }

            return { items, hasMore };
        } catch (err) {
            if (isDependencyUnavailable(err)) throw err;
            logger.error('BecauseYouWatchedStrategy(video) fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }

    async #fetchMusic(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult> {
        try {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) {
                // DB DOWN — signal dependency-down (NOT genuine-empty).
                throw new DependencyUnavailableError('Database unavailable', 'postgres');
            }

            const { getRecentlyPlayed } =
                await import('$lib/server/database/queries/music.queries.js');
            const { getMusicBecauseYouListened } =
                await import('$lib/server/database/queries/music-recommendations.queries.js');
            const { getDislikedTrackIds } =
                await import('$lib/server/database/queries/music-quick-picks.queries.js');

            // Pull a recent-play pool: the first entry seeds the recommendation;
            // all are excluded from results so recently-heard tracks don't resurface.
            const recentTracks = await getRecentlyPlayed(sql, ctx.userId, 20);
            if (recentTracks.length === 0) {
                return { items: [], hasMore: false };
            }

            const sourceTrack = recentTracks[0];
            const recentExcludeIds = recentTracks.map((t) => t.id);

            const dislikedIds = await getDislikedTrackIds(sql, ctx.userId).catch((err) => {
                logger.warn(
                    'BecauseYouWatchedStrategy(music): disliked track lookup failed',
                    err as Error,
                );
                return [] as string[];
            });

            const fetchLimit = opts.limit + 1;

            const rows = await getMusicBecauseYouListened(
                sql,
                sourceTrack.id,
                recentExcludeIds,
                fetchLimit,
                {
                    // Real, request-scoped access facts (`ctx.deniedGroupIds` etc,
                    // resolved once in `buildAccessContext`) — not re-derived from a
                    // reconstructed partial user object, which would silently
                    // collapse to "member of zero groups" and over-restrict.
                    deniedGroupIds: ctx.deniedGroupIds,
                    ageRating:
                        ctx.maxAgeRating != null
                            ? { maxAgeRating: ctx.maxAgeRating, allowUnrated: ctx.allowUnrated }
                            : null,
                },
                dislikedIds,
            );

            if (rows.length === 0) {
                return { items: [], hasMore: false };
            }

            const hasMore = rows.length > opts.limit;
            const page = rows.slice(0, opts.limit);

            const items: RecommendationItem[] = page.map((row): RecommendationItem => ({
                media: {
                    id: row.id,
                    // Music tracks are their own media type; the shared envelope uses
                    // a string discriminator so 'track' is valid per the open string union.
                    type: 'track',
                    title: row.title,
                    ids: { internal: row.id },
                    // NOT gated on `custom_poster_url`: a track without a
                    // cover of its own inherits through the byte route
                    // (track -> album -> artist), which is 22,411 of the
                    // 29,980 tracks on the production library. Gating hid
                    // every one of them behind a blank card.
                    images: buildImageRefs(row.id, opts.surface),
                },
                score: row.similarity != null ? Math.min(row.similarity, 1) : undefined,
                reason: {
                    kind: 'because-you-watched',
                    seed: sourceTrack.id,
                    label: sourceTrack.artist_title ?? sourceTrack.title,
                },
            }));

            return { items, hasMore };
        } catch (err) {
            // Propagate dependency-down so the caller can return 503 / drop the section.
            if (isDependencyUnavailable(err)) throw err;
            logger.error('BecauseYouWatchedStrategy(music) fetch error', err as Error);
            return { items: [], hasMore: false };
        }
    }
}

export const becauseYouWatchedStrategy = new BecauseYouWatchedStrategy();
