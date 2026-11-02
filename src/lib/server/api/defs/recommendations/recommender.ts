// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * recommender.ts — Recommender strategy interface.
 *
 * A single shared abstraction that both Tier-2 resource endpoints and the
 * /feed SDUI composition consume.  Every strategy goes through the same
 * pipeline:
 *
 *   fetch raw candidates
 *   → access-filter  (library group + age gate)
 *   → watched-exclude (opt-in)
 *   → cursor/offset paging
 *   → cache
 *
 * Build new recommendation flavours by implementing `RecommenderStrategy`
 * rather than adding another one-off route with its own fetch+filter stack.
 *
 * - Tier-2 endpoints call `runRecommender(strategy, opts)` directly.
 * - /feed calls `runRecommender` for each section and wraps the result in the
 *   SDUI carousel envelope — NO separate fetch path.
 * - The item envelope is shared: `{ media, score?, reason? }`.
 * - Access filtering is ALWAYS applied; watched-exclude is opt-in per call.
 */

import type { RequestEvent } from '@sveltejs/kit';
import type { UserId } from '$lib/shared/user-id.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    DependencyUnavailableError,
    isDependencyUnavailable,
    AISuggestionRateLimitError,
} from '$lib/server/api/problem.js';
import { isGenuineDbFault } from './db-fault.js';
import { z } from 'zod';
import { PlaybackProgressSchema, type PlaybackProgress } from '$lib/schemas/playback-progress.js';
import type { ResolvedMetadataLanguages } from '$lib/server/utils/metadata-language-resolve.js';
import type { Locale } from '$lib/paraglide/runtime.js';
import { type ApiSurface } from '$lib/shared/api-urls.js';
import { type PublicMediaType, publicMediaTypeSchema } from '$lib/schemas/common.js';
import type { Badge } from '$lib/types/server-driven-ui.js';

const logger = Logger.for('runRecommender');

// ---------------------------------------------------------------------------
// Zod schemas for the canonical RecommendationItem shape
// ---------------------------------------------------------------------------

/**
 * Canonical images{} href map embedded in every media preview.
 * Keys are roles (poster | backdrop | logo | thumb | banner | still).
 * Values carry a size-template href the client substitutes {width} into.
 */
export const RecommendedMediaImagesSchema = z.record(
    z.string(),
    z.object({
        href: z.string(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
    }),
);

/**
 * Zod schema for the canonical media preview embedded in every recommendation.
 * Mirrors the TypeScript `RecommendedMediaRef` interface above.
 *
 * `type` is the canonical PUBLIC discriminator ({@link publicMediaTypeSchema}) —
 * a real enum, never 'tv'/'show' and never a raw internal `media_type`. A row
 * whose stored type has no public representation must be DROPPED by the
 * producer, not relabelled.
 */
export const RecommendedMediaRefSchema = z.object({
    id: z.string().describe('Opaque resolvable handle; catalogId identifies the library row'),
    type: publicMediaTypeSchema,
    title: z.string(),
    year: z.number().int().nullable().optional(),
    // `jellyfin` is OPTIONAL BY DESIGN — availability is `media_items.has_files`,
    // decoupled from Jellyfin presence. Clients resolve via `internal`.
    ids: z
        .record(z.string(), z.string())
        .describe(
            'Provider ID map. Always carries `internal` (the catalogue UUID) — resolve ' +
                'playback and watched-state with it. `jellyfin` is optional and absent for ' +
                'non-Jellyfin libraries; it is not an availability signal.',
        ),
    images: RecommendedMediaImagesSchema.optional().describe('Self-describing image hrefs'),
    // Episode context (present only when `type` === 'episode'). Mirrors the
    // fields the search endpoint and `?include=details` already expose so a
    // client can resolve the parent series and label "S1 · E1 · Pilot" instead
    // of falling back to a movie-style detail. Absent for movies/series.
    seriesId: z.string().optional().describe('Internal UUID of the owning series (episodes only)'),
    seriesName: z.string().optional().describe('Parent series name (episodes only)'),
    seasonNumber: z.number().int().optional().describe('Season number (episodes only)'),
    episodeNumber: z.number().int().optional().describe('Episode number (episodes only)'),
    // Rail/hero display metadata, hydrated via getMediaRailMetadataBatch. This
    // schema is defined TWICE — here and in
    // src/lib/schemas/api-for-you-responses.ts (RecommendedMediaRefSchema) —
    // and BOTH must stay in sync.
    overview: z.string().optional().describe('Synopsis/overview text'),
    seasonCount: z.number().int().nonnegative().optional().describe('Known season count'),
    episodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Known total episodes, including provider metadata'),
    availableEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Active playable episodes in permitted libraries'),
    watchedEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Watched playable episodes for the current user'),
    unwatchedEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Unwatched playable episodes for the current user'),

    rating: z.number().optional().describe('IMDb rating, 0-10'),
    criticRating: z.number().optional().describe('Rotten Tomatoes critic score, 0-100'),
    durationMs: z.number().int().optional().describe('Duration in milliseconds'),
    genres: z.array(z.string()).optional().describe('Genre names'),
    certification: z.string().optional().describe('Age/content rating, e.g. "PG-13"'),
    resolutionTier: z.string().optional().describe("Quality tier: '4K' | '1080p' | '720p' | 'SD'"),
    hdrTier: z.string().optional().describe("HDR tier: 'dolby_vision' | 'hdr' | 'sdr'"),
    hasAtmos: z.boolean().optional().describe('Dolby Atmos audio available'),
    hasCc: z.boolean().optional().describe('Closed captions available'),
    hasSdh: z.boolean().optional().describe('SDH subtitles available'),
    hasAd: z.boolean().optional().describe('Audio description track available'),
});

/**
 * Zod schema for the reason block carried by a recommendation item.
 * The `kind` field is the discriminator; the full union of valid kinds is
 * documented on the TypeScript interface — the Zod schema stays open so new
 * strategy kinds don't require a schema migration.
 */
export const RecommendationReasonSchema = z.object({
    kind: z.string(),
    seed: z.string().optional(),
    label: z.string().optional(),
    airDate: z.string().optional().describe('ISO air-date string (for `upcoming`)'),
    episodeTitle: z.string().optional().describe('Episode title (for `upcoming`)'),
    overview: z.string().optional().describe('Episode overview/description (for `upcoming`)'),
});

/**
 * Zod schema for a single recommendation item.
 *
 * This is the CANONICAL response shape for every Tier-2 for-you rail.
 * Collections return `paginate(items, page)` where `items` is `RecommendationItemSchema[]`.
 */
export const RecommendationItemSchema = z.object({
    progress: PlaybackProgressSchema.optional(),
    media: RecommendedMediaRefSchema,
    score: z.number().min(0).max(1).optional().describe('Normalised relevance score [0, 1]'),
    isAvailable: z
        .boolean()
        .optional()
        .describe('Item is in the library (has_files). Populated by discovery-sourced rails.'),
    canRequest: z
        .boolean()
        .optional()
        .describe('Item is not available and is eligible to be requested.'),
    reason: RecommendationReasonSchema.optional(),
});

export type RecommendationItemZod = z.infer<typeof RecommendationItemSchema>;

// ---------------------------------------------------------------------------
// Shared item shape
// ---------------------------------------------------------------------------

/** Provider-neutral media reference embedded in a recommendation item. */
export interface RecommendedMediaRef {
    /** Internal UUID (stable, canonical). */
    id: string;
    /**
     * Canonical PUBLIC discriminator. A real union, NOT `string`: the client
     * routes playback off this value, so an internal-only `media_type`
     * ('tvchannel', 'home_video', 'music', …) must never reach it. Producers map
     * through `toPublicMediaType()` and DROP the item when that returns null —
     * relabelling a tvchannel as a movie sends the client down the movie
     * playback path, which is worse than not offering the card at all.
     */
    type: PublicMediaType;
    /** Display title. */
    title: string;
    /** Release year. */
    year?: number | null;
    /**
     * Provider ID map (provider → id string).
     *
     * Always carries `internal` (the catalogue UUID) — the identifier clients
     * resolve, play and track watched-state with. `jellyfin` is OPTIONAL BY
     * DESIGN and absent for non-Jellyfin libraries: availability is
     * `media_items.has_files`, deliberately decoupled from Jellyfin presence.
     */
    ids: Record<string, string>;
    /** Image hrefs keyed by role (poster | backdrop | …). */
    images?: Record<string, { href: string; width?: number; height?: number }>;
    /**
     * Internal UUID of the owning series. Present only for `type === 'episode'`
     * so the client can open the parent series detail. Absent for movies/series.
     */
    seriesId?: string;
    /** Parent series display name (episodes only). */
    seriesName?: string;
    /** Season number (episodes only). */
    seasonNumber?: number;
    /** Episode number (episodes only). */
    episodeNumber?: number;
    // Rail/hero display metadata, hydrated via getMediaRailMetadataBatch. This
    // interface is defined TWICE — here and in
    // src/lib/schemas/api-for-you-responses.ts (RecommendedMediaRefSchema) —
    // and BOTH must stay in sync.
    /** Synopsis/overview text. */
    seasonCount?: number;
    episodeCount?: number;
    availableEpisodeCount?: number;
    watchedEpisodeCount?: number;
    unwatchedEpisodeCount?: number;
    overview?: string;
    /** IMDb rating, 0-10. */
    rating?: number;
    /** Rotten Tomatoes critic score, 0-100. */
    criticRating?: number;
    /** Duration in milliseconds. */
    durationMs?: number;
    /** Genre names. */
    genres?: string[];
    /** Age/content rating, e.g. "PG-13". */
    certification?: string;
    /** Quality tier: '4K' | '1080p' | '720p' | 'SD'. */
    resolutionTier?: string;
    /** HDR tier: 'dolby_vision' | 'hdr' | 'sdr'. */
    hdrTier?: string;
    /** Dolby Atmos audio available. */
    hasAtmos?: boolean;
    /** Closed captions available. */
    hasCc?: boolean;
    /** SDH subtitles available. */
    hasSdh?: boolean;
    /** Audio description track available. */
    hasAd?: boolean;
}

/** One item in a recommendation response. */
export interface RecommendationItem {
    progress?: PlaybackProgress;
    media: RecommendedMediaRef;
    /**
     * Badges contributed by plugins, merged in `runRecommender` (see
     * card-badges.ts). Carried at the ITEM level, like availability: the
     * response conformance strip drops any key not on the wire schema, so a
     * field declared in the wrong place is silently deleted in production.
     */
    badges?: Badge[];
    /** Normalised relevance score in [0, 1]. Omitted when not meaningful. */
    score?: number;
    /**
     * Whether the item is present in the library (`media_items.has_files`).
     * Populated by discovery-sourced strategies (e.g. trending) where the client
     * cannot otherwise derive availability — a trending TMDB item may already be
     * in the library. Omitted by library-sourced strategies whose items are
     * available by construction.
     */
    isAvailable?: boolean;
    /** Whether the item is requestable (not available and eligible to request). */
    canRequest?: boolean;
    /**
     * ISO-8601 timestamp of the last playback activity for this item (the
     * `last_event_at` behind the watch-state row). Emitted only by the
     * continue-watching rail so a client can sort most-recent-activity-first
     * (matching web Home) and render relative "Paused 21h ago"-style labels.
     * Absent when the row carries no event timestamp (e.g. legacy backfill).
     */
    lastPlayedAt?: string;
    /** Machine-readable explanation. */
    reason?: {
        kind:
            | 'for-you'
            | 'because-you-watched'
            | 'mood'
            | 'ai'
            | 'editorial'
            | 'trending'
            | 'similar'
            | 'upcoming'
            | 'continue-watching'
            | 'keywords'
            | string;
        /** Seed item id (for `because-you-watched`, `similar`). */
        seed?: string;
        /** Human-readable label (e.g. genre, theme). */
        label?: string;
        /** ISO air-date string (for `upcoming`). */
        airDate?: string;
        /** Episode title (for `upcoming`). */
        episodeTitle?: string;
        /** Episode overview/description (for `upcoming`). Mirrors the Zod source. */
        overview?: string;
    };
}

// ---------------------------------------------------------------------------
// Access context passed to every strategy
// ---------------------------------------------------------------------------

/**
 * Caller access boundaries extracted once per request.
 * Strategies use this for library / age filtering — never re-derive it.
 */
export interface AccessContext {
    userId: UserId;
    username: string;
    /** Library group IDs the caller is denied access to. */
    deniedGroupIds: string[] | null;
    /** Max age rating; null = unrestricted. */
    maxAgeRating: number | null;
    /** Whether UNRATED_CONTENT_VISIBLE is set. */
    allowUnrated: boolean;
    /** Whether SHOW_UNAVAILABLE_MEDIA is set. */
    showUnavailableMedia: boolean;
    /** Whether the user has a restricted age profile. */
    isAgeRestricted: boolean;
    /**
     * Resolved per-user metadata overlay languages (multilingual-media-metadata
     * spec §2/§5) — resolved ONCE per request in `buildAccessContext` so
     * `runRecommender` never re-fetches playback prefs per section/strategy.
     * Optional (not `?? {...}`-defaulted here) so existing test fixtures that
     * hand-build an `AccessContext` without this field keep compiling; treated
     * as "no overlay" when absent.
     */
    langs?: ResolvedMetadataLanguages;
}

// ---------------------------------------------------------------------------
// Strategy options
// ---------------------------------------------------------------------------

/**
 * Runtime options passed to `runRecommender` per call.
 * Each option is opt-in; strategies ignore options they don't support.
 */
export interface RecommenderOptions {
    /**
     * The API surface the caller is serving. Every URL a strategy emits (image
     * hrefs, deep links) is derived from it. REQUIRED and un-defaulted on
     * purpose — a default here is exactly how the old `imageBase` drifted.
     */
    surface: ApiSurface;
    /** Max items to return. */
    limit: number;
    /** Offset for paging (offset-based). */
    offset?: number;
    /** Opaque cursor string for cursor-based paging. */
    cursor?: string;
    /** Exclude already-watched items when true. */
    hideWatched?: boolean;
    /** Seed item id (for `similar` / `because-you-watched`). */
    seed?: string;
    /** Single video type pushed down to strategies when possible. */
    mediaType?: 'movie' | 'series';
    /**
     * Public media types allowed in the final recommendation envelope.
     * Applied by `runRecommender` before offset pagination. This option is
     * offset-only and cannot be combined with `cursor`.
     */
    mediaTypes?: ReadonlySet<PublicMediaType> | null;
    /** Genre filter (for mood / keyword strategies). */
    genre?: string;
    /** Mood name (for mood strategy). */
    mood?: string;
    /** Force-bypass the strategy cache. */
    refresh?: boolean;
    /**
     * Per-request availability override — client-driven "available only" filter.
     * When true, only items with `isAvailable === true` are returned.
     * This is the request-level opt-in (the tvOS "available only" toggle),
     * distinct from the always-on `ctx.showUnavailableMedia` server-config gate.
     */
    availableOnly?: boolean;
    /** Additional domain-specific params (per-strategy extension point). */
    extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Strategy result
// ---------------------------------------------------------------------------

/** What every strategy must return. */
export interface RecommenderResult {
    items: RecommendationItem[];
    /**
     * True when additional items are available beyond this page.
     * Strategies MUST over-fetch by 1 and slice to compute this cheaply.
     */
    hasMore: boolean;
    /** Next cursor (cursor-based paging only). */
    nextCursor?: string;
    /** Total count — only include when cheap (bounded queries). */
    total?: number;
    /**
     * Explicit page state for strategies whose "empty" result is ambiguous
     * between "genuinely nothing to show" and "still being computed".
     *  - `'ready'`: a normal page (possibly empty because access-filtered).
     *  - `'generating'`: the underlying data (e.g. an AI profile/suggestion
     *    set) hasn't been produced yet — client should retry later.
     *  - `'exhausted'`: a cursor page ran past the end of the result set.
     * Optional — strategies that don't need the distinction omit it.
     */
    status?: 'ready' | 'generating' | 'exhausted';
}

// ---------------------------------------------------------------------------
// Strategy interface
// ---------------------------------------------------------------------------

/**
 * All recommendation flavours implement this interface.
 *
 * The `id` property is used as the section id in `/feed` responses and as
 * the `kind` value in `reason` when no more specific kind exists.
 *
 * Guidelines for implementors:
 * - Always apply `opts.limit + 1` over-fetch, then slice + set `hasMore`.
 * - Apply access filtering (library group + age) — use `ctx.deniedGroupIds`
 *   and `ctx.maxAgeRating`.
 * - Respect `opts.showUnavailableMedia = ctx.showUnavailableMedia`.
 * - Cache hot results; invalidate on `opts.refresh`.
 * - SIGNAL dependency-down — when a required dependency is DOWN (`!getDb()`, a
 *   Valkey/AI-store/external-API failure), `throw new DependencyUnavailableError()`.
 *   Do NOT swallow it to an empty result: an empty array means "genuinely no
 *   matches", a throw means "dependency unavailable". `runRecommender` lets the
 *   signal propagate; Tier-2 endpoints map it to 503, the /feed compositor drops
 *   only that section.
 * - A genuine-empty result (no embeddings yet, no recent plays, unknown
 *   theme/domain, missing required opt) is `{ items: [], hasMore: false }` —
 *   that is a 200, never a 503.
 *
 * INVARIANT (multilingual-media-metadata spec §5): strategies must never
 * cache post-map `RecommendationItem[]` — the translation overlay in
 * `runRecommender` (below) mutates them per-request, and `UnifiedCache`'s L1
 * tier returns/stores the LIVE object reference, so an in-place overlay on a
 * cached array would drift the cached entry permanently localized (or leak
 * one user's language to every user sharing that cache key). Cache pre-map
 * service rows only, and re-map to `RecommendationItem[]` fresh on every
 * cache hit — see `for-you/watching-sources.ts` (clones a cache-resident
 * payload before overlaying) and `for-you/fulfilled-requests.ts` /
 * `recommendations/upcoming.ts` (cache pre-map rows, always re-`.map()` into
 * fresh item objects) for the two sanctioned patterns.
 *
 * Language is NO LONGER stable per user: Accept-Language negotiation means
 * one userId can resolve different languages on different devices. Any
 * cache that stores POST-OVERLAY text must therefore key on a language
 * token (see heroLangCacheToken in routes/api/recommendations/+server.ts).
 * Caching pre-overlay rows and overlaying per request — what every site does
 * today — needs no token. Callbacks fired from globally-registered emitters
 * (SSE endpoints) run outside the request ALS and fall back to the legacy
 * locale path.
 */
export interface RecommenderStrategy {
    /** Stable identifier for this strategy. */
    readonly id: string;
    /**
     * Section title for /feed, as a Paraglide message function.
     *
     * A function, not a string, so the title resolves per request against the
     * caller's negotiated locale. Signature matches Paraglide's compiled
     * messages — `inputs` FIRST, then options — so a strategy can assign
     * `readonly label = m.section_trending_today;` directly.
     *
     * ALWAYS call with an explicit `{ locale }`. Calling bare resolves through
     * ambient state, which for a cookie-less bearer client is always English —
     * the exact bug this replaced.
     */
    readonly label: (inputs?: object, opts?: { locale?: Locale }) => string;

    /**
     * Declares that `fetch` applies `opts.mediaTypes` before its own pagination.
     * Use this for strategies whose order is intentionally unstable (for
     * example random picks), where prefix expansion cannot reconstruct an
     * exact filtered page.
     */
    readonly mediaTypeFiltering?: 'native';

    /**
     * Fetch recommendations for the given user + options.
     * Implementations are responsible for access filtering and caching.
     */
    fetch(ctx: AccessContext, opts: RecommenderOptions): Promise<RecommenderResult>;
}

// ---------------------------------------------------------------------------
// runRecommender — the shared entry point
// ---------------------------------------------------------------------------

/**
 * Run a recommender strategy and return a typed result.
 *
 * This is the ONLY entry-point for both Tier-2 endpoints and /feed sections.
 * It applies watched-exclusion post-strategy (strategies may also do it
 * internally for efficiency, but runRecommender is the authoritative gate).
 *
 * Error handling:
 * - A `DependencyUnavailableError` (DB/AI/Valkey/external API DOWN) is
 *   PROPAGATED unchanged. Callers decide how to surface it: Tier-2 endpoints
 *   map it to `503 dependency_unavailable`; the /feed compositor catches it
 *   per-section and drops only that section.
 * - A genuine Postgres fault that escapes a strategy uncaught (see
 *   `isGenuineDbFault` in `./db-fault.js`) is likewise NOT downgraded — it is
 *   logged and re-thrown as `DependencyUnavailableError` so it takes the same
 *   503 / dropped-section path. This is the last line of defense: most
 *   strategies classify their own DB faults (see `ai.strategy.ts`), but a
 *   strategy that doesn't must not have its DB failure laundered into a
 *   status-less "ready, nothing here" result — see `getTasteRailPage`
 *   (for-you/taste.ts), which defaults a missing `status` to `'ready'`.
 * - Any *other* uncaught throw (a genuine programming error — a `TypeError`,
 *   a bug in a strategy's own mapping/filtering code, and so on) is NOT a
 *   database fault: it is logged and downgraded to an empty result so a
 *   single buggy strategy can't take down the request. Dependency-down is
 *   NEVER downgraded to an empty result.
 */
/**
 * Coerce a strategy-supplied score into the RecommendationItem contract.
 * Finite scores are clamped to [0, 1]; non-finite scores (NaN/±Infinity) are
 * dropped to `undefined` (score omitted, not zeroed — an absent score is
 * semantically "no meaningful score" rather than "lowest score").
 */
function withNormalizedScore(item: RecommendationItem): RecommendationItem {
    if (item.score === undefined) return item;
    if (!Number.isFinite(item.score)) return { ...item, score: undefined };
    const clamped = Math.min(1, Math.max(0, item.score));
    return clamped === item.score ? item : { ...item, score: clamped };
}

/**
 * Ask a strategy for increasingly large prefixes until the filtered offset
 * page plus one hasMore sentinel is known. Strategies receive offset zero:
 * `opts.offset` belongs to the filtered public collection, not the raw one.
 */
async function fetchMediaTypeFilteredPage(
    strategy: RecommenderStrategy,
    ctx: AccessContext,
    opts: RecommenderOptions,
    allow: ReadonlySet<PublicMediaType>,
): Promise<RecommenderResult> {
    const offset = opts.offset ?? 0;
    const targetSize = offset + opts.limit + 1;
    if (!Number.isSafeInteger(targetSize)) {
        throw new RangeError('Recommendation pagination exceeded the safe prefix limit');
    }

    let prefixLimit = Math.max(1, targetSize);
    let firstFetch = true;
    let previousItemCount = -1;

    for (;;) {
        const result = await strategy.fetch(ctx, {
            ...opts,
            limit: prefixLimit,
            offset: 0,
            mediaTypes: null,
            // A refresh may regenerate the underlying set. Expansion must read
            // the same set rather than regenerate on every larger prefix.
            refresh: firstFetch ? opts.refresh : false,
        });
        firstFetch = false;

        const filtered = result.items.filter((item) => allow.has(item.media.type));
        const exhausted = !result.hasMore;
        if (filtered.length >= targetSize || exhausted) {
            const pageEnd = offset + opts.limit;
            return {
                ...result,
                items: filtered.slice(offset, pageEnd),
                hasMore: filtered.length > pageEnd,
                nextCursor: undefined,
                // A raw total describes a different collection. Once the
                // strategy is exhausted, the filtered total is exact.
                total: exhausted ? filtered.length : undefined,
            };
        }

        if (result.items.length <= previousItemCount) {
            throw new Error(
                `Recommendation strategy '${strategy.id}' reported more items without growing its prefix`,
            );
        }
        previousItemCount = result.items.length;

        const nextPrefixLimit = prefixLimit * 2;
        if (!Number.isSafeInteger(nextPrefixLimit) || nextPrefixLimit <= prefixLimit) {
            throw new RangeError('Recommendation pagination exceeded the safe prefix limit');
        }
        prefixLimit = nextPrefixLimit;
    }
}

export async function runRecommender(
    strategy: RecommenderStrategy,
    ctx: AccessContext,
    opts: RecommenderOptions,
): Promise<RecommenderResult> {
    if (opts.mediaTypes && opts.cursor) {
        throw new TypeError('mediaTypes filtering cannot be combined with cursor pagination');
    }

    try {
        const strategyResult =
            opts.mediaTypes && strategy.mediaTypeFiltering !== 'native'
                ? await fetchMediaTypeFilteredPage(strategy, ctx, opts, opts.mediaTypes)
                : await strategy.fetch(ctx, opts);

        const raw = structuredClone(strategyResult);

        // Per-user metadata-language overlay (multilingual-media-metadata spec
        // §5): `runRecommender` is the SINGLE shared entry point every
        // strategy (Tier-2 endpoints AND /feed sections) funnels through, so
        // wiring it HERE — once — covers all of them instead of duplicating
        // this block into every strategy file. `strategy.fetch()` has already
        // returned (its own internal cache, if any, was already read/written),
        // so this always runs post-cache; the cached payloads that strategies
        // persist themselves stay language-neutral.
        if (raw.items.length > 0 && (ctx.langs?.titleLang || ctx.langs?.textLang)) {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (sql) {
                const { applyTranslationOverlay } =
                    await import('$lib/server/utils/translation-overlay.js');
                await applyTranslationOverlay(sql, raw.items, ctx.langs, {
                    id: (it) =>
                        it.media.id && !it.media.id.startsWith('ext:') ? it.media.id : null,
                    setTitle: (it, v) => {
                        it.media.title = v;
                    },
                    // `media.overview` is hydrated by getMediaRailMetadataBatch
                    // straight off provider_metadata, i.e. always the PRIMARY
                    // language. Without this setter a German viewer got a
                    // translated title over an English synopsis on the rails
                    // and the AI-suggestion hero slide.
                    setOverview: (it, v) => {
                        it.media.overview = v;
                    },
                });
            }
        }

        if (raw.items.length) {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (sql) {
                const { enrichSeriesEpisodeCounts } =
                    await import('$lib/server/services/series-episode-counts.service.js');
                const { restrictedAccess } =
                    await import('$lib/server/database/queries/builders/media-access-boundary.js');
                await enrichSeriesEpisodeCounts(
                    sql,
                    raw.items.map((it) => it.media),
                    ctx.userId,
                    restrictedAccess({
                        deniedGroupIds: ctx.deniedGroupIds ?? [],
                        maxAgeRating: ctx.maxAgeRating,
                        allowUnrated: ctx.allowUnrated,
                    }),
                );
            }
        }

        // Plugin-contributed card badges. Wired HERE for the same reason the
        // translation overlay above is: `runRecommender` is the single entry
        // point every strategy funnels through, so one insertion covers /feed,
        // every Tier-2 rail, and therefore every client — including the mobile
        // and TV apps, which a browser-side decoration could never reach.
        //
        // Post-`strategy.fetch()`, so it is post-cache by construction: what
        // strategies persist stays plugin-neutral, exactly like the language
        // overlay. Bounded and fault-isolated inside collectPluginBadges — the
        // worst a plugin can do here is contribute nothing.
        if (raw.items.length > 0) {
            const { collectPluginBadges } =
                await import('$lib/server/plugins/runtime/card-badges.js');
            const refs = raw.items
                .filter((it) => it.media.id && !it.media.id.startsWith('ext:'))
                .map((it) => ({ mediaItemId: it.media.id, mediaType: it.media.type }));
            const badges = await collectPluginBadges(refs);
            if (badges.size > 0) {
                for (const it of raw.items) {
                    const found = badges.get(it.media.id);
                    if (found) it.badges = [...(it.badges ?? []), ...found];
                }
            }
        }

        // Watched-exclusion is opt-in and already handled inside strategies
        // that support it natively (e.g. similar, ai).  For strategies that
        // don't exclude internally, it could be applied here in a future pass
        // once the watch-state service is available on the context.
        //
        // Enforce the `score ∈ [0, 1]` contract centrally. Strategies derive
        // scores from heterogeneous sources — 0–10 ratings (`rating/10`),
        // cosine similarity — and can overflow the range (a
        // 0–100 `rt_rating` yields `score = rating/10 > 1`) or produce NaN.
        // RecommendationItemSchema pins score to `number().min(0).max(1)`, so
        // an unclamped value surfaces client-side as `score: Invalid input`.
        // This is the single authoritative clamp; individual strategies need
        // not repeat it.
        return { ...raw, items: raw.items.map(withNormalizedScore) };
    } catch (err) {
        // Dependency-down is a signal, not a programming error — let it through
        // so the caller can return 503 (Tier-2) or drop the section (/feed).
        if (isDependencyUnavailable(err) || err instanceof AISuggestionRateLimitError) throw err;

        // A genuine Postgres fault (query or connection) that a strategy
        // didn't classify itself must not masquerade as a legitimately-empty
        // result either. Every strategy's SUCCESS path returns an explicit
        // `status` ('ready' | 'exhausted' | 'generating') — falling through
        // to `{ items: [], hasMore: false }` here leaves `status` undefined,
        // and `getTasteRailPage` (for-you/taste.ts) defaults a missing
        // status to `'ready'`. Reclassify it as dependency-down instead, so
        // it takes the SAME 503 (Tier-2) / dropped-section (/feed) path a
        // strategy's own `DependencyUnavailableError` would. This is a
        // backstop — `ai.strategy.ts` already classifies its own DB faults
        // before they reach here — for any strategy that doesn't.
        if (isGenuineDbFault(err)) {
            logger.error(
                `runRecommender: strategy '${strategy.id}' hit a database fault, reporting dependency-down`,
                err as Error,
            );
            throw new DependencyUnavailableError(
                `Recommendation strategy '${strategy.id}' query failed`,
                'postgres',
            );
        }

        // Any other uncaught throw is a genuine programming error (e.g. a
        // TypeError, a bug in a strategy's own mapping/filtering code) — NOT
        // a database fault. Log and downgrade to an empty result so one
        // buggy strategy can't fail the whole request. This is the exact
        // distinction `isGenuineDbFault` exists to draw: only real
        // infrastructure faults escalate to 503, never a plain bug.
        logger.warn(`runRecommender: strategy '${strategy.id}' threw uncaught error`, err as Error);
        return { items: [], hasMore: false };
    }
}

// ---------------------------------------------------------------------------
// getRailItems — single shared dispatch over the strategy registry
// ---------------------------------------------------------------------------

/**
 * Thrown when a caller asks for a rail/strategy `type` that isn't registered.
 * Callers map this to a `validation_failed` problem (it's bad client input,
 * NOT a dependency failure — never a 503).
 */
export class UnknownRailError extends Error {
    readonly railType: string;
    constructor(railType: string) {
        super(`Unknown recommendation type: '${railType}'`);
        this.name = 'UnknownRailError';
        this.railType = railType;
    }
}

/**
 * Resolve a rail `type` to its strategy and run it through the shared
 * `runRecommender` pipeline.
 *
 * This is the SINGLE dispatch both `/recommendations?type=` and `/feed` use to
 * turn a type string into items, so every rail — the legacy strategies
 * (for-you / ai / trending / fulfilled-requests / …) and the folded curated
 * rails (popular-shows / fresh-releases / binge-worthy / anime / short-movies /
 * recently-added / random-picks) — shares one fetch+filter+cache path.
 *
 * Error contract:
 * - Unknown `type` → `UnknownRailError` (caller maps to validation_failed).
 * - Dependency DOWN → `DependencyUnavailableError` propagates unchanged
 *   (caller maps to 503; the /feed compositor drops just that section). A
 *   down dependency is NEVER swallowed into an empty 200.
 */
export async function getRailItems(
    type: string,
    ctx: AccessContext,
    opts: RecommenderOptions,
): Promise<RecommenderResult> {
    // Import lazily to avoid a static import cycle (strategies/index.ts → … → recommender.ts).
    const { getStrategy } = await import('./strategies/index.js');
    const strategy = getStrategy(type);
    if (!strategy) throw new UnknownRailError(type);
    return runRecommender(strategy, ctx, opts);
}

// ---------------------------------------------------------------------------
// buildAccessContext — extract access boundaries from a request event
// ---------------------------------------------------------------------------

/**
 * Build an `AccessContext` from a SvelteKit `RequestEvent`.
 *
 * Uses `locals.principal` (Bearer JWT / PAT / svc_ token clients) falling back
 * to `locals.user` (forward-auth / native session).  Call once per request
 * and pass the result to every `runRecommender` call on that request.
 */
export async function buildAccessContext(event: RequestEvent): Promise<AccessContext | null> {
    // `principal` and `user` are populated TOGETHER by `resolveAuth()` for every
    // credential kind (forward-auth, native session, device JWT, PAT, svc_ token,
    // OIDC). Principal carries identity/scopes; UserContext carries the live
    // media-access profile. They identify the same user but are not substitutes.
    const principal = event.locals.principal;
    const profile = event.locals.user;
    const user = principal ?? profile;
    if (!user?.userId) return null;
    // Principal proves identity and credential capability; it does not carry
    // the live age profile. Treat a missing/mismatched profile as
    // unavailable instead of silently making this an unrestricted viewer.
    if (principal && (!profile || profile.userId !== principal.userId)) {
        return null;
    }

    // Import lazily to avoid circular deps at module-load time
    const { getDb } = await import('$lib/server/database/connection.js');
    const { config, isUnavailableMediaVisible } = await import('$lib/server/config.js');
    const sql = getDb();

    let deniedGroupIds: string[] | null = null;
    if (sql) {
        const { getDeniedLibraryGroups, toLibraryAccessUser } =
            await import('$lib/server/cache/library-group-permissions-cache.js');
        const accessUser = profile
            ? toLibraryAccessUser(profile)
            : principal
              ? { isAdmin: principal.isAdmin, userGroups: principal.userGroups }
              : undefined;
        deniedGroupIds = await getDeniedLibraryGroups(
            sql,
            accessUser && principal
                ? { ...accessUser, isAdmin: principal.isAdmin && accessUser.isAdmin === true }
                : accessUser,
        );
    }

    // Resolve the metadata-language overlay ONCE per request here (rather than
    // per-strategy in runRecommender) so a /feed call fanning out to N
    // sections issues exactly one getPlaybackPreferences query, not N.
    let langs: ResolvedMetadataLanguages = { titleLang: null, textLang: null };
    if (sql && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
        const { resolveMetadataLanguage } =
            await import('$lib/server/utils/metadata-language-resolve.js');
        const { getPlaybackPreferences } =
            await import('$lib/server/database/queries/user-preferences.queries.js');
        // The metadata-language overlay is COSMETIC — it picks which localized
        // title/overview to prefer. It must never be able to fail the request.
        //
        // This read runs in buildAccessContext, which is BEFORE /feed's
        // per-section try/catch, so an unguarded rejection here escaped section
        // isolation and 500'd the whole aggregate response — contradicting
        // /feed's documented fault-isolation invariant. Degrade to the no-overlay
        // default instead: the caller then sees original-language metadata,
        // exactly as it did before this feature existed.
        //
        // Deliberately NOT applied to the `getDeniedLibraryGroups` read above:
        // that one is an ACCESS BOUNDARY, and failing it open would leak titles
        // from denied library groups. A 500 there is the correct outcome.
        try {
            langs = resolveMetadataLanguage(
                await getPlaybackPreferences.one(sql, { userId: user.userId }),
            );
        } catch (err) {
            logger.warn(
                'buildAccessContext: metadata-language preferences read failed; ' +
                    'serving without the localized-metadata overlay',
                err as Error,
            );
        }
    }

    return {
        userId: user.userId,
        username: user.username,
        deniedGroupIds,
        maxAgeRating: profile?.maxAgeRating ?? null,
        allowUnrated: config.UNRATED_CONTENT_VISIBLE ?? false,
        // Effective gate: SHOW_UNAVAILABLE_MEDIA AND a configured request path
        // (un-requestable catalog ghosts are dead ends — see config.ts).
        showUnavailableMedia: isUnavailableMediaVisible(),
        isAgeRestricted: profile?.maxAgeRating != null,
        langs,
    };
}
