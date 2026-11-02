// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { recommendationPreviews } from '$lib/server/services/media-preview.service.js';
import { getDb } from '$lib/server/database/connection.js';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview.js';
import {
    AudiobookActivityItemSchema,
    AudiobookActivitySectionSchema,
    type AudiobookActivityItem,
} from '$lib/schemas/api-feed-responses.js';

/**
 * Tier-1 endpoint: GET /api/v1/feed
 *
 * Server-Driven UI (SDUI) composition over the same Recommender strategies
 * that back the Tier-2 data-plane endpoints.
 *
 * Each section links back to the Tier-2 endpoint that backs it so power
 * clients can "see all" from the section's `source.href`.
 *
 * - Server owns section selection, order, and titles.
 * - Each section carries the SAME item envelope as the Tier-2 endpoints.
 * - A section is skipped (not included) when its strategy returns 0 items.
 * - FAULT ISOLATION: a strategy whose dependency is DOWN
 *   (DependencyUnavailableError) just drops its own section — the aggregate
 *   /feed response still returns 200. This is the deliberate divergence from the
 *   Tier-2 data-plane endpoints (/recommendations, /trending), which surface the
 *   SAME signal as 503 dependency_unavailable. A down dependency must never
 *   take down the whole home page.
 * - Section shapes are stable; the section list/order/presence is server-owned
 *   and deliberately NOT stable — varies per user and per request.
 *
 * Query params:
 *   limit   — items per section (1–50, default 10)
 *   sections — comma-separated section ids to include (default: all)
 *   types — CSV allow-list of public media types for the watching section
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import type { RouteMetadata } from '$lib/server/openapi.js';
import { ApiProblem, isDependencyUnavailable } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import type { MediaPreview } from '$lib/schemas/api-media-preview.js';
interface FeedSection {
    id: string;
    type: string;
    title: string;
    icon?: string;
    items: Array<MediaPreview | AudiobookActivityItem>;
    source: { href: string };
}
import { buildAccessContext, getRailItems } from './recommender.js';
import { getStrategy } from './strategies/index.js';
import { resolveUiLocale } from '$lib/server/utils/ui-locale.js';
import type { Locale } from '$lib/paraglide/runtime.js';
import { apiBase } from '$lib/shared/api-urls.js';
import { parseMediaTypeFilter, PUBLIC_MEDIA_TYPE_VALUES } from './continue-watching.js';

const FeedQuerySchemaFromDocs = z.strictObject({
    limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .meta({ description: 'Items per section (1–50, default 10)' }),
    sections: z
        .string()
        .optional()
        .meta({
            description:
                'Comma-separated section ids to include (default: all offered). Lets a client ' +
                'pick exactly which rows it wants and omit ones it composes itself from the flat ' +
                'Tier-2 resources. Known ids today: watching, for-you, ai, trending, ' +
                'audiobook-activity, fulfilled-requests, popular-shows, fresh-releases, binge-worthy, ' +
                'anime, short-movies, recently-added, and ' +
                'byw (all "Because you watched" rails) or byw:<mediaUuid> (that specific rail, ' +
                'but only when the server actually offers it — i.e. mediaUuid is among the ' +
                "user's current top-N recent-watched seeds; the server never builds an " +
                'arbitrary rail for a uuid outside that offered set). Unknown ids, including a ' +
                'byw:<mediaUuid> not currently offered, are ignored, so requesting a section ' +
                'this server build does not offer simply yields fewer sections rather than an ' +
                'error.',
        }),
    types: z
        .string()
        .optional()
        .meta({
            description:
                'Comma-separated public media-type allow-list for the watching section. ' +
                'Filtering happens before arbitration; omitted or empty means no filtering.',
        }),
});

const FlatFeedSectionSchema = z.object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    icon: z.string().optional(),
    items: z.array(MediaPreviewSchema),
    source: z.object({ href: z.string() }),
});
const FeedResponseSchema = z.object({ sections: z.array(FlatFeedSectionSchema) });
const InternalFeedResponseSchema = z.object({
    sections: z.array(
        z.union([
            AudiobookActivitySectionSchema.extend({ source: z.object({ href: z.string() }) }),
            FlatFeedSectionSchema.extend({
                type: z.string().refine((type) => type !== 'audiobook-activity'),
            }),
        ]),
    ),
});

const logger = Logger.for('FeedDef');

/**
 * Per-rail time budget. A rail whose cold computation is slow (binge-worthy
 * took 46–122 s uncached on prod, 2026-09-23) used to hold the WHOLE feed —
 * the iOS Home screen gave up and showed its offline state. Past the budget
 * the rail is left out of THIS response; its computation keeps running and
 * fills the rail's cache, so the next request serves it.
 */
export const FEED_SECTION_BUDGET_MS = 6_000;
const SECTION_TIMED_OUT = Symbol('feed-section-timed-out');

async function withinSectionBudget<T>(work: Promise<T>): Promise<T | typeof SECTION_TIMED_OUT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<typeof SECTION_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(SECTION_TIMED_OUT), FEED_SECTION_BUDGET_MS);
    });
    try {
        return await Promise.race([work, budget]);
    } finally {
        clearTimeout(timer);
    }
}

const FeedQuerySchema = z.strictObject({
    limit: z.coerce.number().int().min(1).max(50).optional().default(10),
    sections: z.string().optional(),
    types: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------
//
// Public sections retain flat MediaPreview items. Internal audiobook activity
// uses the shared rich activity schema so social fields survive composition,
// serialization, and mount() response conformance.

/**
 * Default section plan — rail ids resolved through the SAME shared dispatch
 * (`getRailItems`) and strategy registry that back `/recommendations?type=`.
 * Both endpoints now share one fetch+filter+cache path, so adding a curated
 * rail to the home feed is just adding its id here.
 *
 * Rails, in render order:
 *   - Personalised / signal rails: for-you, ai, trending, fulfilled-requests.
 *   - Curated rails (folded from the former GET /api/for-you/*): popular-shows,
 *     fresh-releases, binge-worthy, anime, short-movies, recently-added. These
 *     are backed by the same strategy registry entries the data-plane serves,
 *     so the home feed and `/recommendations?type=` can never drift.
 *
 * The `anime` rail's strategy defensively returns an empty result for
 * age-restricted profiles, so the empty-section drop below keeps it from
 * leaking into a restricted user's feed (matching the Tier-2 403 gate).
 *
 * `trending` keeps its dedicated Tier-1 alias href (`/trending`); every other
 * section links back to its `/recommendations?type=<id>` Tier-2 resource.
 */
const SECTION_IDS: string[] = [
    // `ai` ("Recommended for You") is the embedding-personalised rail, so it
    // leads. `for-you` is a quality-ranked library pick, not personalised —
    // it sits among the curated rails under its own title so the two never
    // read as the same rail twice (iOS review, 2026-09-23).
    'ai',
    'trending',
    'fulfilled-requests',
    // Curated rails (folded from GET /api/for-you/*), served via the shared dispatch.
    'popular-shows',
    'fresh-releases',
    'for-you',
    'binge-worthy',
    'anime',
    'short-movies',
    'recently-added',
];

/**
 * Heroicon name per rail — the same vocabulary as `SectionMeta.icon`. Sent so
 * clients can give each rail its own header icon instead of a shared default.
 * The Apple clients map these names to SF Symbols (`sfSymbol(forHeroicon:)`
 * in the Apple apps' API client) — a NEW name needs a line there too, or it falls
 * back to the sparkle.
 */
const SECTION_ICONS: Record<string, string> = {
    ai: 'sparkles',
    trending: 'fire',
    'fulfilled-requests': 'check-circle',
    'popular-shows': 'tv',
    'fresh-releases': 'calendar',
    'for-you': 'star',
    'binge-worthy': 'play',
    anime: 'globe-asia-australia',
    'short-movies': 'bolt',
    'recently-added': 'clock',
};

const SECTION_PLAN: Array<{
    id: string;
    label: (inputs?: object, opts?: { locale?: Locale }) => string;
    hrefTemplate: (base: string) => string;
}> = SECTION_IDS.map((id) => {
    // Resolve once at module load to validate the id and capture the section
    // title; request-time item fetching goes through the shared getRailItems
    // dispatch so /feed and /recommendations stay on one code path.
    const strategy = getStrategy(id);
    if (!strategy) throw new Error(`feed: unknown strategy id in SECTION_IDS: '${id}'`);
    return {
        id,
        label: strategy.label,
        hrefTemplate: (base: string) =>
            id === 'trending' ? `${base}/trending` : `${base}/recommendations?type=${id}`,
    };
});

const feedDocs = {
    GET: {
        tags: ['For You'],
        summary: 'Get the home feed',
        stability: 'stable',
        auth: 'bearer',
        description:
            'Returns composited server-driven UI (SDUI) feed sections for the authenticated user. ' +
            'Each section is a carousel of flat MediaPreview items with catalog identity and ImageSet ' +
            '`{ id, catalogId, type, title, ids, images, progress?, score?, reason? }` and links back to the Tier-2 endpoint that backs it via ' +
            '`source.href`. A section is omitted when its strategy returns no items or its ' +
            'dependency is unavailable (fault isolation — the aggregate response stays 200). ' +
            'Optionally filter with `?sections=for-you,trending`. ' +
            'Section shapes are stable; the section list/order is server-owned and ' +
            'varies per request. Clients must ignore unknown section types and fields.',
        query: FeedQuerySchemaFromDocs,
        responses: {
            200: {
                schema: FeedResponseSchema,
                description: 'Feed sections',
            },
            401: 'Authentication required',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
} satisfies RouteMetadata;

export const def = defineEndpoint({
    docs: feedDocs,

    // mount() uses normalized OpenAPI route paths, without the install base.
    // This comparison selects metadata; it does not emit an API link.
    docsByPath: (path) =>
        // eslint-disable-next-line callback-safety/no-hardcoded-api-path -- normalized route identity, not an emitted URL
        path === '/api/feed'
            ? {
                  ...feedDocs,
                  GET: {
                      ...feedDocs.GET,
                      summary: 'Get the internal home feed',
                      description:
                          'Returns composited server-driven UI (SDUI) feed sections for the authenticated user. ' +
                          'Ordinary sections contain flat MediaPreview items; audiobook-activity sections preserve ' +
                          'author, media, kind, listenedMinutes, occurredOn, and approximate. Each section links ' +
                          'to its backing resource through `source.href`. A section is omitted when its strategy ' +
                          'returns no items or its dependency is unavailable (fault isolation — the aggregate ' +
                          'response stays 200). Optionally filter with `?sections=for-you,trending`. Section ' +
                          'shapes are stable; the section list/order is server-owned and varies per request. ' +
                          'Clients must ignore unknown section types and fields.',
                      responses: {
                          ...feedDocs.GET.responses,
                          200: { schema: InternalFeedResponseSchema, description: 'Feed sections' },
                      },
                  },
              }
            : feedDocs,
    auth: { kind: 'user' },
    request: {
        query: FeedQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            // mount() has already validated the query against FeedQuerySchema
            // and attached the parsed result to ctx.input.query — use it directly
            // and skip the redundant re-parse.
            if (!ctx.input?.query) {
                return ApiProblem.validationFailed([{ field: 'query', message: 'Invalid query' }]);
            }
            const q = ctx.input.query;

            const typeFilter = parseMediaTypeFilter(q.types);
            if (typeFilter.invalid.length > 0) {
                return ApiProblem.validationFailed([
                    {
                        field: 'types',
                        message:
                            `Unknown media type(s): ${typeFilter.invalid.join(', ')}. ` +
                            `Allowed: ${PUBLIC_MEDIA_TYPE_VALUES.join(', ')}.`,
                    },
                ]);
            }

            const accessCtx = await buildAccessContext(event);
            if (!accessCtx) return ApiProblem.unauthorized();

            const uiLocale = resolveUiLocale(event);

            // Optionally restrict which sections are returned.
            // Filter empty strings so `sections=` (empty param) doesn't suppress all sections.
            const requestedSections = q.sections
                ? new Set(
                      q.sections
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                  )
                : null;

            // Base URL for Tier-2 hrefs (surface-aware: use ctx.surface prefix sibling)
            const surfaceBase = apiBase(ctx.surface);

            // The `?sections=` gate must accept BOTH the `byw` pseudo-id (all
            // "Because you watched" rails) and a specific `byw:<uuid>` (one
            // rail) via prefix-match — else `?sections=byw:m1` returns nothing.
            const wantsByw =
                !requestedSections ||
                [...requestedSections].some((s) => s === 'byw' || s.startsWith('byw:'));

            const sections: FeedSection[] = [];

            // Kick off all three composition phases concurrently — none of
            // them need to wait on each other to START. The BYW dedup needs
            // the resolved `watching` result, and BYW renders after the
            // carousels in the response, but that's an ordering constraint on
            // the `sections` array, not on when each fetch begins.
            const watchingPromise =
                !requestedSections || requestedSections.has('watching')
                    ? import('./feed-watching-section.js')
                          .then((m) =>
                              m.buildWatchingSection(
                                  accessCtx,
                                  q.limit,
                                  surfaceBase,
                                  ctx.surface,
                                  uiLocale,
                                  typeFilter.allow,
                              ),
                          )
                          .catch((err) => {
                              logger.warn('Feed: dropping watching section', err as Error);
                              return null;
                          })
                    : Promise.resolve(null);

            const audiobookActivityPromise =
                !requestedSections || requestedSections.has('audiobook-activity')
                    ? import('./feed-audiobook-activity-section.js')
                          .then((module) =>
                              module.buildAudiobookActivitySection(
                                  accessCtx,
                                  ctx.surface,
                                  uiLocale,
                                  q.limit,
                                  // /feed is the general home feed. The rail has
                                  // to earn its slot here; the audiobooks
                                  // destination builds its own ungated section,
                                  // because navigating there already establishes
                                  // the context this gate is standing in for.
                                  { requireViewerListening: true },
                              ),
                          )
                          .catch((err) => {
                              logger.warn(
                                  'Feed: dropping audiobook activity section',
                                  err as Error,
                              );
                              return null;
                          })
                    : Promise.resolve(null);

            // Run all strategies in parallel for minimal latency.
            //
            // FAULT ISOLATION: each section catches its OWN failure so a single
            // strategy can never fail the aggregate /feed (which must stay 200):
            //  - A DependencyUnavailableError (dependency DOWN) drops just that
            //    section. Tier-2 endpoints surface the same signal as 503; /feed
            //    deliberately degrades instead.
            //  - Any other throw (programming error past runRecommender's own
            //    catch) is also isolated to its section.
            // Returns `null` for a dropped section; non-null results are kept.
            const sectionResultsPromise = Promise.all(
                SECTION_PLAN.filter(
                    ({ id }) => !requestedSections || requestedSections.has(id),
                ).map(
                    async ({
                        id,
                        label,
                        hrefTemplate,
                    }): Promise<{
                        id: string;
                        label: (inputs?: object, opts?: { locale?: Locale }) => string;
                        result: { items: MediaPreview[]; hasMore: boolean };
                        href: string;
                    } | null> => {
                        try {
                            // Shared dispatch — identical fetch+filter+cache path as
                            // /recommendations?type=<id>. SECTION_IDS are pre-validated
                            // at module load, so getRailItems won't throw UnknownRailError.
                            const work = getRailItems(id, accessCtx, {
                                surface: ctx.surface,
                                limit: q.limit,
                            }).then(async (result) => ({
                                ...result,
                                items: await recommendationPreviews(
                                    getDb()!,
                                    ctx.surface,
                                    result.items,
                                ),
                            }));
                            const result = await withinSectionBudget(work);
                            if (result === SECTION_TIMED_OUT) {
                                // Still running; it warms the cache. Its late
                                // failure has no one to report to but the log.
                                work.catch((err: unknown) =>
                                    logger.warn(`Feed: late failure of timed-out section '${id}'`, {
                                        error: err instanceof Error ? err.message : String(err),
                                    }),
                                );
                                logger.warn(
                                    `Feed: section '${id}' exceeded its time budget — dropped from this response, still warming its cache`,
                                    { budgetMs: FEED_SECTION_BUDGET_MS },
                                );
                                return null;
                            }
                            return { id, label, result, href: hrefTemplate(surfaceBase) };
                        } catch (err) {
                            if (isDependencyUnavailable(err)) {
                                logger.warn(
                                    `Feed: dropping section '${id}' — dependency unavailable`,
                                    err as Error,
                                );
                            } else {
                                logger.error(
                                    `Feed: dropping section '${id}' — unexpected error`,
                                    err as Error,
                                );
                            }
                            return null;
                        }
                    },
                ),
            );

            // Watching first: unshift (not push) keeps it at index 0 even
            // though it resolves alongside the carousels below.
            const watching = await watchingPromise;
            if (watching) sections.unshift(watching);

            // The social activity rail belongs directly after Watching and is
            // absent (rather than empty) when nobody opted in or nothing
            // happened in the seven-day window.
            const audiobookActivity = await audiobookActivityPromise;
            if (audiobookActivity) {
                try {
                    sections.push({
                        ...audiobookActivity,
                        source: { href: `${surfaceBase}/feed?sections=audiobook-activity` },
                        items:
                            ctx.surface === 'internal'
                                ? audiobookActivity.items
                                : await recommendationPreviews(
                                      getDb()!,
                                      ctx.surface,
                                      audiobookActivity.items.map((item) => ({
                                          media: { ...item.media, ids: {} },
                                          reason: {
                                              kind: item.kind,
                                              label: item.author.displayName ?? undefined,
                                          },
                                      })),
                                  ),
                    });
                } catch (err) {
                    logger.warn('Feed: dropping audiobook activity previews', err as Error);
                }
            }

            const sectionResults = await sectionResultsPromise;
            for (const entry of sectionResults) {
                if (!entry) continue; // dropped section (dependency-down or error)
                const { id, label, result, href } = entry;
                // Skip empty sections — don't waste the client rendering empty carousels
                if (result.items.length === 0) continue;

                sections.push({
                    id,
                    type: 'carousel',
                    title: label({}, { locale: uiLocale }),
                    ...(SECTION_ICONS[id] ? { icon: SECTION_ICONS[id] } : {}),
                    items: result.items,
                    source: { href },
                });
            }

            // BYW last — needs the watching section's shown series ids for
            // dedup. When `?sections=` excludes 'watching', there's no
            // watching section to dedup against — BYW may then repeat a
            // series the client is showing elsewhere; that's acceptable for
            // an explicit narrow request.
            if (wantsByw) {
                try {
                    const { buildBywSections } = await import('./feed-byw-sections.js');
                    const shownSeriesIds = new Set<string>();
                    for (const s of sections) {
                        if (s.type === 'watching') {
                            for (const it of s.items) {
                                if ('context' in it && it.context?.series?.id) {
                                    shownSeriesIds.add(it.context.series.id);
                                }
                                if ('id' in it && it.id) shownSeriesIds.add(it.id);
                            }
                        }
                    }
                    const byw = await buildBywSections(
                        accessCtx,
                        3,
                        q.limit,
                        surfaceBase,
                        ctx.surface,
                        shownSeriesIds,
                        uiLocale,
                    );

                    // Bounded selection: the server always OFFERS the top-N
                    // recent-seed rails (built above); a client may narrow to
                    // specific `byw:<uuid>` ids among those offered, but we
                    // never build a rail for a uuid outside the recent-seed
                    // set. A requested id not among the offered top-N simply
                    // yields no section — consistent with unknown-id
                    // tolerance elsewhere in `?sections=`.
                    const wantsAllByw = !requestedSections || requestedSections.has('byw');
                    if (wantsAllByw) {
                        sections.push(...byw);
                    } else {
                        const specificBywIds = [...requestedSections].filter((s) =>
                            s.startsWith('byw:'),
                        );
                        sections.push(...byw.filter((s) => specificBywIds.includes(s.id)));
                    }
                } catch (err) {
                    logger.warn('Feed: BYW fan-out failed', err as Error);
                }
            }

            const response = {
                sections: sections.map((section) => {
                    if (ctx.surface === 'internal' && section.type === 'audiobook-activity') {
                        return {
                            type: 'audiobook-activity' as const,
                            id: 'audiobook-activity' as const,
                            title: section.title,
                            source: section.source,
                            items: section.items.flatMap((item) => {
                                const parsed = AudiobookActivityItemSchema.safeParse(item);
                                if (parsed.success) return [parsed.data];
                                logger.warn('Feed: dropping invalid audiobook activity item', {
                                    issues: parsed.error.issues.slice(0, 3).map((i) => i.message),
                                });
                                return [];
                            }),
                        };
                    }
                    return {
                        id: section.id,
                        type: section.type,
                        title: section.title,
                        ...('icon' in section && section.icon ? { icon: section.icon } : {}),
                        items: section.items.flatMap((item) => {
                            const parsed = MediaPreviewSchema.safeParse(item);
                            if (parsed.success) return [parsed.data];
                            logger.warn(`Feed: dropping invalid item in section '${section.id}'`, {
                                issues: parsed.error.issues.slice(0, 3).map((i) => i.message),
                            });
                            return [];
                        }),
                        source: section.source,
                    };
                }),
            };
            return typedJson(
                ctx.surface === 'internal' ? InternalFeedResponseSchema : FeedResponseSchema,
                response,
            );
        },
    },
});

export { resolveUiLocale as _resolveUiLocale };
