// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Homepage server load function.
 *
 * - Redirects age-restricted profiles to /browse for a restricted,
 *   age-appropriate experience.
 * - Loads "What's On Now" LiveTV section for permitted users.
 */

import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { Logger } from '$lib/server/utils/logger.js';
import type { PageSection } from '$lib/types/server-driven-ui.js';
import { getLiveTvProvider } from '$lib/server/services/livetv/index.js';
import { getLiveTvAvailability } from '$lib/server/services/livetv/availability.service.js';
import { isPromotedLiveTvChannel } from '$lib/shared/livetv-availability.js';
import { liveTvChannelToWhatsOnItem, orderFavoritesFirst } from '$lib/shared/livetv-transforms.js';
import { stationIdOfFeed } from '$lib/server/services/livetv/station.service.js';
import {
    getFavoriteChannelIds,
    stationIdsOfFeeds,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import {
    determineHeroState,
    type HeroStateResult,
} from '$lib/server/database/queries/onboarding.queries.js';
import { getDb } from '$lib/server/database/connection.js';
import { effectiveWatchingFor } from '$lib/server/services/effective-watching.service.js';
import { buildWatchingSections } from '$lib/server/utils/section-builder.js';
import type { ContinueWatchingItem } from '$lib/server/utils/section-builder.js';
import { resolveHeroFirstSlide } from '$lib/server/utils/hero-first-slide.js';
import { currentDaypartSeed, dedupeByKey, pickRotatedHeroLead } from '$lib/utils/hero-rotation.js';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import type { HeroFirstSlide } from '$lib/schemas/hero.js';
import type { SearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { config } from '$lib/server/config.js';
import { opensLiveTvOnStart } from '$lib/server/services/livetv/simple-mode-autostart.js';
import { appPath } from '$lib/shared/api-urls.js';
import { getEffectiveUser } from '$lib/server/dev-user.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import {
    resolveViewerMetadataLanguages,
    type ResolvedMetadataLanguages,
} from '$lib/server/utils/metadata-language-resolve.js';
import type { AgeRatingFilterParams } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import { getWidgetOrder } from '$lib/server/database/queries/index.js';
import { type UserId } from '$lib/shared/user-id.js';
import { getHomeActiveSessions } from '$lib/server/services/home-active-sessions.service.js';
import type { SessionsResponse } from '$lib/schemas/api-playback-responses.js';
import { isWidgetDisabled } from '$lib/server/utils/widget-guard.js';
import { isValidLandingPath } from '$lib/server/utils/landing-path';
import { listPinnedBroadcastsForUser } from '$lib/server/database/queries/user-notifications.queries.js';
import { buildNotificationPresentation } from '$lib/server/services/notification-display.service.js';
import { resolvePushLocale } from '$lib/server/services/push/push-payload.js';
import { getLocale } from '$lib/paraglide/runtime.js';
import { listPluginWidgets } from '$lib/server/plugins/runtime/widget-metadata.js';
import {
    stripAudiobookListArraysFromItem,
    stripAudiobookListArraysFromSections,
} from '$lib/server/utils/strip-audiobook-list-arrays.js';
import { truncateOverview } from '$lib/server/utils/truncate-overview.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

/**
 * Hard latency budget for the live-overlay branch when loading the
 * watching strip on the SSR path. Durable rows always render; on timeout
 * the SSE subscription patches the live position post-hydration.
 */
const WATCHING_SSR_OVERLAY_BUDGET_MS = 50;
const WATCHING_SSR_LIMIT = 10;

/**
 * How many "What's On Now" channels the SSR seed carries.
 *
 * The seed is a FIRST-PAINT placeholder only: `LiveTvWidget` calls
 * `refreshChannels()` unconditionally in `onMount` and replaces the section
 * wholesale, because the per-card "Ends in X" subtitles are built here in the
 * default locale and can only be re-localized by a client fetch. So the seed
 * never needs the full lineup — just enough to fill the carousel before
 * hydration lands.
 *
 * Unbounded, this serialized every visible channel with a current program into
 * `__data.json`: ~300-400 B per item, so a 200-channel IPTV lineup cost 60-80 KB
 * on EVERY navigation (SvelteKit hardcodes `private, no-store` on data
 * responses, so it is never cached). A backdrop-card row shows ~6-8 cards on a
 * wide viewport; 20 covers a couple of screens of horizontal scroll with room
 * to spare.
 */
const LIVE_TV_SSR_SEED_LIMIT = 20;

/**
 * Apply {@link truncateOverview} across every item of every rail section.
 *
 * The HERO is deliberately exempt from this trim: `HeroSection` renders
 * `overview` at `line-clamp-3` across `max-w-prose`, which is comfortably
 * longer than `RAIL_OVERVIEW_MAX_CHARS` (see `truncate-overview.ts`).
 *
 * Done HERE, at the homepage payload boundary, rather than in
 * `section-builder.ts` where the field originates: that module also feeds the
 * `/api/v1` music endpoints and the hero, and truncating there would silently
 * change a public API response for native clients.
 */
function trimSectionOverviews(sections: PageSection[] | null): PageSection[] | null {
    if (!sections) return null;
    return sections.map((section) => ({
        ...section,
        items: section.items.map((item) =>
            item.overview === undefined
                ? item
                : { ...item, overview: truncateOverview(item.overview) },
        ),
    }));
}

const logger = Logger.for('HomePage');

/**
 * Series/media identity key for deduping the hero watching pool. Prefers the
 * internal series UUID (shared by a CW episode and its Next-Up successor in the
 * same series), then the item's own internal id /
 * id (movies). Returns undefined only when nothing stable is available.
 */
function watchingPoolKey(item: ContinueWatchingItem): string | undefined {
    return item.seriesId ?? getExternalIdFor(item.externalIds, 'internal') ?? item.id ?? undefined;
}

/**
 * Build the hero LEAD from the combined Continue-Watching + Next-Up pool.
 *
 * Continue-Watching rows are ranked FIRST (most relevant — what the user is
 * actively mid-watching), then Next-Up rows, then deduped by series/media
 * identity (CW wins over its Next-Up counterpart). The deduped pool is rotated
 * by the current daypart seed so the lead varies through the day yet stays
 * stable within a daypart — and because the seed is deterministic, the SSR pick
 * matches the client's first render. Returns null when the pool is empty so the
 * caller falls back to the generic hero slide.
 */
function pickHeroLead(
    continueWatching: ContinueWatchingItem[],
    nextUp: ContinueWatchingItem[],
    userKey: string | undefined,
): ContinueWatchingItem | null {
    const pool = dedupeByKey<ContinueWatchingItem>(
        [...continueWatching, ...nextUp],
        watchingPoolKey,
    );
    const seed = currentDaypartSeed(userKey);
    return pickRotatedHeroLead(pool, seed) ?? null;
}

/** The viewer's favorite station ids in favorite order; [] when unreadable. */
async function loadFavoriteStationIds(userId: UserId): Promise<string[]> {
    const sql = getDb();
    if (!sql) return [];
    try {
        return await stationIdsOfFeeds(sql, await getFavoriteChannelIds(sql, userId));
    } catch (err) {
        logger.warn('Failed to load Live TV favorites', err instanceof Error ? err : undefined);
        return [];
    }
}

/**
 * Load "What's On Now" LiveTV section data with caching.
 * The viewer's favorite channels come first; the cached order is shared by
 * all users and stays favorite-neutral.
 * Returns null if no channels/programs available or on error.
 */
async function loadLiveTvSection(userId: UserId): Promise<PageSection | null> {
    const cache = cacheManager.for(CACHE_NAMESPACES.liveTvWhatsOnNow);
    const cacheKey = 'whats-on-now';
    const favoritesPromise = loadFavoriteStationIds(userId);

    const cached = await cache.get<PageSection>(cacheKey);
    const provider = await getLiveTvProvider();
    const channels = await provider.getChannels();
    const availability = await getLiveTvAvailability(channels);
    const eligible = channels.filter((ch) => ch.isVisible && ch.currentProgram);
    const byId = new Map(eligible.map((channel) => [channel.id, channel]));
    const now = Date.now();
    // Keep cached ordering, but use current programme metadata and visible membership.
    const candidates = (cached?.items ?? []).flatMap((item) => {
        const channel = byId.get(item.id);
        return channel ? [channel] : [];
    });
    const candidateIds = new Set(candidates.map((channel) => channel.id));
    for (const channel of eligible) {
        if (!candidateIds.has(channel.id)) candidates.push(channel);
    }
    const favoriteStationIds = await favoritesPromise;
    const items = orderFavoritesFirst(candidates, favoriteStationIds, stationIdOfFeed)
        .filter((channel) => isPromotedLiveTvChannel(channel.id, availability))
        .slice(0, LIVE_TV_SSR_SEED_LIMIT)
        .map((channel) => liveTvChannelToWhatsOnItem(channel, now));

    const section: PageSection = {
        id: 'live-tv-whats-on-now',
        title: 'livetv_whats_on_now',
        type: 'carousel',
        meta: { cardVariant: 'backdrop' },
        items,
    };

    // Cache for 60s
    await cache.set(cacheKey, {
        ...section,
        items: candidates
            .slice(0, LIVE_TV_SSR_SEED_LIMIT)
            .map((channel) => liveTvChannelToWhatsOnItem(channel, now)),
    });

    return items.length ? section : null;
}

interface WatchingSSRPayload {
    sections: PageSection[];
    /**
     * False when the live overlay timed out (or errored). The client
     * uses this to decide whether to schedule a follow-up fetch after
     * hydration — without it, a steady-state playback session whose SSE
     * carries no further events could leave the strip stuck on the
     * durable position indefinitely.
     */
    liveOverlayApplied: boolean;
    /**
     * Top Next Up item, reused by the hero first-slide resolver so the
     * personalized hero slide needs no extra query. Already access-vetted by
     * the watching path. Null when there is no Next Up.
     */
    topNextUp: ContinueWatchingItem | null;
}

/**
 * SSR the Continue Watching strip so the most-engaged row of the home
 * page paints with first byte instead of after a client mount + fetch.
 *
 * Live overlay runs with a hard 50ms budget; on timeout we render durable
 * state and report `liveOverlayApplied: false` so the client knows to
 * fire a catch-up fetch after hydration (SSE alone is insufficient — it
 * only carries `set_changed` and `session_changed` transitions, not
 * heartbeats, so a user who lands on / mid-playback could otherwise
 * stare at a stale durable position until they trigger a state change).
 *
 * Suspicion annotation is skipped on the hot path — the client-side
 * SSE-driven re-fetch will recompute it. New-episode alerts are NOT
 * fetched here; the client always fetches them on mount because they
 * have a different latency profile (Sonarr calendar) and are excluded
 * from the SSR budget. Failures in the primitive itself are caught and
 * treated as "no SSR data" so the client falls back to its full mount
 * fetch.
 */
async function loadWatchingSectionsForSSR(
    username: string,
    userId: UserId,
    access?: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
    langs?: ResolvedMetadataLanguages,
): Promise<WatchingSSRPayload | null> {
    try {
        const result = await effectiveWatchingFor({
            username,
            userId,
            limit: WATCHING_SSR_LIMIT,
            mergeSort: false,
            includeNewEpisodes: false, // client fetches alerts on mount
            liveOverlayBudgetMs: WATCHING_SSR_OVERLAY_BUDGET_MS,
            // Localize CW/NU titles+overviews so the SSR hero first slide AND the
            // Continue Watching strip paint in the viewer's language on first
            // byte (matches the modal). No-op when `langs` is the no-overlay
            // result (feature off / primary language).
            langs,
            // Skip the bulk-mark suspicion window-scan on the SSR path: it is the only
            // serial, uncached DB call on the one nav-blocking branch (the other four
            // load branches are all cached), so it needlessly inflates the __data.json
            // round-trip on every / navigation. The amber "suspicious bulk-mark" warning
            // is recomputed by the client's post-mount refetch/SSE (its original home) —
            // a cosmetic delay in the warning, not a data change.
            skipSuspicion: true,
            access,
        });
        return {
            sections: buildWatchingSections({
                continueWatching: result.continueWatching,
                nextUp: result.nextUp,
            }),
            liveOverlayApplied: result.liveOverlayApplied,
            // Hero LEAD: daypart-rotated pick from the deduped Continue-Watching
            // + Next-Up pool (CW ranked first/wins), reusing the already-fetched,
            // access-vetted rows — no second query. Rotates through the day and
            // includes the show the user is actually mid-watching, instead of
            // forever pinning result.nextUp[0]. Field name kept (`topNextUp`) so
            // resolveHeroFirstSlide consumes it unchanged — a CW item is the same
            // ContinueWatchingItem shape (with progress>0).
            topNextUp: pickHeroLead(result.continueWatching, result.nextUp, String(userId)),
        };
    } catch (err) {
        logger.warn(
            'SSR watching-strip load failed; client will fetch on mount',
            err instanceof Error ? err : undefined,
        );
        return null;
    }
}

export const load: PageServerLoad = async ({ locals, request, depends, url }) => {
    depends('app:watch-state');

    // NOTE: we deliberately do NOT `await parent()` here. This page load reads no
    // layout data (the previous `features` read was unused — only `void`ed), so
    // awaiting the parent would needlessly serialize this load *after* the layout
    // load. Skipping it lets the two run concurrently; SvelteKit still merges the
    // layout's data into the final page data automatically.

    // Generic, safety-validated landing redirect. INSTANCE_LANDING_PATH is set by
    // the Instance Profile presets (e.g. '/music', '/library/home_video'); empty
    // or unsafe values mean "no redirect" so '/' renders normally. Reads config
    // live at request time so it applies to anonymous visitors too.
    const landing = config.INSTANCE_LANDING_PATH;
    if (isValidLandingPath(landing)) {
        throw redirect(307, landing);
    }

    // Live TV simple mode with "open Live TV on start" (set up by a helper for
    // an older viewer): the home page is their TV.
    // `/?home` always shows the home page (the simple screen links back to it).
    if (!url.searchParams.has('home') && (await opensLiveTvOnStart(locals.user))) {
        throw redirect(307, appPath('/livetv'));
    }

    // Active streams (streaming-sessions widget): seed the section's data into
    // the page load so it renders with first-byte server HTML — no
    // client-fetch-after-mount round-trip or spinner. The DnD widget grid is now
    // SSR'd in the user's saved order (see userWidgetOrder below), so this
    // section is genuinely server-rendered, not just seeded-on-hydration.
    // Gated so we don't pay the DB cost when the widget can't/won't show:
    //   - feature disabled / admin-disabled widget → skip.
    // We deliberately do NOT gate on "can this viewer see OTHER users' sessions"
    // here: getVisibleActiveSessions now self-restricts to the viewer's OWN
    // sessions when they lack broad visibility (not public, non-admin, no watch
    // permission), so seeding it unconditionally lets a restricted user still see
    // — and stop — their own active streams. Privileged viewers are unchanged
    // (own + other non-hidden sessions).
    // Wrapped in .catch(() => null) so it NEVER throws to the page (matches the
    // liveTvSection precedent). The client component still live-refreshes via
    // its existing poll after hydration.
    // Resolve the viewer's metadata-language overlay ONCE for the whole page and
    // reuse it for both the Continue Watching strip/hero and the Active Streams
    // widget, so a viewer who selected another language sees localized titles on
    // every home surface (matching the media modal) — not just the modal. Kicked
    // off as an un-awaited promise so it runs concurrently with the other loads;
    // gated inside the resolver so feature-off installs issue zero queries.
    const viewerLangsPromise: Promise<ResolvedMetadataLanguages> = resolveViewerMetadataLanguages(
        getDb(),
        locals.user?.userId,
    );

    const sessionsPromise: Promise<SessionsResponse | null> =
        config.FEATURE_SESSIONS && !isWidgetDisabled('streaming-sessions')
            ? viewerLangsPromise
                  .then((metadataLangs) => getHomeActiveSessions(locals, metadataLangs))
                  .catch(() => null)
            : Promise.resolve(null);

    // Start LiveTV fetch (only for permitted users)
    const liveTvPromise = locals.user?.hasLiveTvPermission
        ? loadLiveTvSection(locals.user.userId).catch((err) => {
              logger.error('Failed to load LiveTV section', err instanceof Error ? err : undefined);
              return null;
          })
        : Promise.resolve(null);

    // Watching strip SSR: fans out alongside the LiveTV fetch and the
    // widget render so it adds at most max() of the three to TTFB. The
    // primitive's overlay budget caps its own contribution at 50ms.
    // Age-restricted profiles don't see CW/NU at all.
    const username = getEffectiveUser(request, locals.user?.username || config.DEFAULT_USER);
    // The watching block also resolves the SSR hero first slide so slide 0
    // paints with first byte. Age-restricted profiles never get the
    // personalized strip, but they DO get a generic (access-scoped) hero slide.
    type WatchingSSRResult = {
        watching: WatchingSSRPayload | null;
        heroFirstSlide: HeroFirstSlide | null;
    };
    const watchingSSRPromise: Promise<WatchingSSRResult | null> = locals.user?.isAgeRestricted
        ? (async (): Promise<WatchingSSRResult | null> => {
              // Age-restricted: skip CW/NU entirely, but still resolve a
              // generic access-scoped hero slide so they get an instant hero.
              try {
                  const sqlForAccess = getDb();
                  if (!sqlForAccess || !locals.user) {
                      return { watching: null, heroFirstSlide: null };
                  }
                  const accessCtx = await buildSearchAccessContext(sqlForAccess, locals.user);
                  const heroFirstSlide = await resolveHeroFirstSlide({
                      sql: sqlForAccess,
                      topNextUp: null,
                      isAgeRestricted: true,
                      // Boundary is derived from `accessCtx` inside the resolver —
                      // one source for both the cache key and the query predicate.
                      accessCtx,
                      langs: await viewerLangsPromise,
                  });
                  return { watching: null, heroFirstSlide };
              } catch (err) {
                  logger.warn(
                      'Age-restricted hero first-slide resolve failed',
                      err instanceof Error ? err : undefined,
                  );
                  return { watching: null, heroFirstSlide: null };
              }
          })()
        : (async (): Promise<WatchingSSRResult | null> => {
              const sqlForAccess = getDb();
              // Resolve the effective (possibly admin-preview) username → users.id
              // UUID so user-data keys by the stable id. When the effective user is
              // the caller, reuse their UserContext.userId; otherwise look up the
              // preview username. No match → skip SSR (client fetches on mount).
              let effectiveUserId: UserId | undefined =
                  username === locals.user?.username ? locals.user?.userId : undefined;
              if (!effectiveUserId && sqlForAccess) {
                  effectiveUserId =
                      (await getUserIdByUsername(sqlForAccess, username)) ?? undefined;
              }
              if (!effectiveUserId) return null;
              const accessCtx: SearchAccessContext | null =
                  sqlForAccess && locals.user
                      ? await buildSearchAccessContext(sqlForAccess, locals.user)
                      : null;
              const watching = await loadWatchingSectionsForSSR(
                  username,
                  effectiveUserId,
                  accessCtx
                      ? {
                            deniedGroupIds: accessCtx.deniedGroupIds,
                            ageRating: accessCtx.ageRating,
                        }
                      : undefined,
                  await viewerLangsPromise,
              );
              const heroFirstSlide = await resolveHeroFirstSlide({
                  sql: sqlForAccess,
                  topNextUp: watching?.topNextUp ?? null,
                  isAgeRestricted: false,
                  // Boundary is derived from `accessCtx` inside the resolver — a
                  // null context skips the fallback branch entirely, so there is
                  // no longer a way to reach the query with no boundary at all.
                  accessCtx,
                  langs: await viewerLangsPromise,
              });
              return { watching, heroFirstSlide };
          })();

    // Determine hero state (onboarding vs local-content vs full-metadata).
    // Result is system-global (two variants: admin vs non-admin). Cache for
    // 60 s to avoid 3 DB queries on every homepage load.
    const heroStatePromise = (async (): Promise<HeroStateResult | null> => {
        try {
            const sql = getDb();
            if (!sql) return null;
            const isAdmin = localsIsAdmin(locals);
            const cache = cacheManager.for(CACHE_NAMESPACES.heroState);
            const cacheKey = isAdmin ? 'admin' : 'user';
            const cached = await cache.get<HeroStateResult>(cacheKey);
            if (cached) return { ...cached, isAdmin };
            const result = await determineHeroState(sql, isAdmin);
            await cache.set(cacheKey, result);
            return result;
        } catch (err) {
            logger.error('Failed to determine hero state', err instanceof Error ? err : undefined);
            return null;
        }
    })();

    // Plugin-contributed widgets: each feature's declared widgets, surfaced as
    // `plugin:<featureId>:<id>` so the home page can render + order them.
    // Per-viewer access gating happens inside each plugin's own routes.
    //
    // De-duplicated once in the shared helper, because the detail modal builds
    // the same list from the layout load and the two must agree about which
    // widget won a composite-id collision.
    const pluginWidgets = listPluginWidgets();

    // Per-user widget order + hidden list, SSR'd so the DnD widget grid renders
    // server-side in the user's saved order (was previously materialized
    // client-side from localStorage, leaving the SSR grid empty). Null = "no
    // saved order, use admin default". Wrapped in .catch(() => null) so it never
    // throws to the page; anonymous/no-userId viewers get the admin default.
    const widgetOrderPromise: Promise<{
        widget_order: string[] | null;
        hidden_widgets: string[] | null;
    } | null> = (async () => {
        const userId = locals.user?.userId;
        if (!userId) return null;
        const sql = getDb();
        if (!sql) return null;
        return getWidgetOrder.one(sql, { userId }).catch(() => null);
    })();

    // Pinned admin announcements, SSR'd so the homepage banner renders with
    // first-byte HTML instead of flashing in after the notification-inbox
    // store's post-mount fetch resolves. Reuses the same presenter
    // (`buildNotificationPresentation`) the inbox API uses, so the homepage
    // banner and the drawer row can never disagree on title/body text.
    const pinnedAnnouncementsPromise: Promise<Array<{ id: string; title: string; body?: string }>> =
        (async () => {
            const userId = locals.user?.userId;
            if (!userId) return [];
            const sql = getDb();
            if (!sql) return [];
            const locale = resolvePushLocale(getLocale());
            const rows = await listPinnedBroadcastsForUser(sql, userId).catch(() => []);
            return rows.map((row) => {
                const { display } = buildNotificationPresentation(row, {
                    locale,
                    surface: 'internal',
                });
                return {
                    id: row.id,
                    title: display.title,
                    ...(display.body ? { body: display.body } : {}),
                };
            });
        })();

    // Await parallel promises
    const [
        liveTvSection,
        heroStateResult,
        watchingSSR,
        sessionsResult,
        widgetOrderResult,
        pinnedAnnouncements,
    ] = await Promise.all([
        liveTvPromise,
        heroStatePromise,
        watchingSSRPromise,
        sessionsPromise,
        widgetOrderPromise,
        pinnedAnnouncementsPromise,
    ]);

    return {
        // When this payload was built. Every live seed below (sessions, the
        // watching strip, the hero slide, LiveTV) is only as fresh as the HTML
        // it gets baked into — and `static/sw.js` caches `/` as an app shell
        // with no TTL, so a cache-served reopen can replay this payload days
        // later. Consumers gate on this via `isSeedFresh()` and fetch instead
        // of rendering a stale seed.
        ssrRenderedAt: Date.now(),
        pluginWidgets,
        liveTvSection,
        // Synopses are trimmed to what the rail cards can actually render
        // (see RAIL_OVERVIEW_MAX_CHARS). The hero slide below keeps its full
        // overview — it renders three clamped lines, not a card subtitle.
        // Audiobook chapter/file lists are stripped first (see
        // stripAudiobookListArraysFromSections) — a single in-progress
        // audiobook can carry hundreds of entries in each array and no rail
        // card renders them.
        watchingSections: trimSectionOverviews(
            watchingSSR?.watching?.sections
                ? stripAudiobookListArraysFromSections(watchingSSR.watching.sections)
                : null,
        ),
        // Surfaces "did the SSR live overlay fire?" so the client can
        // schedule a catch-up fetch when it didn't. Defaults to true on
        // the no-SSR-data path so we don't trigger a redundant catch-up
        // when there's nothing to catch up to.
        watchingLiveOverlayApplied: watchingSSR?.watching?.liveOverlayApplied ?? true,
        // SSR hero first slide (personalized Next Up reuse, or access-scoped
        // generic fallback). Null → client builds the hero on mount. Same
        // audiobook chapter/file strip as the rail sections above — the hero
        // keeps `authors`/`narrators`, which is all HeroSection reads.
        heroFirstSlide: watchingSSR?.heroFirstSlide
            ? stripAudiobookListArraysFromItem(watchingSSR.heroFirstSlide)
            : null,
        // SSR initial active-streams so the section renders instantly (no
        // post-render fetch waterfall). null → the client fetches on mount as
        // before (no SSR data available / gated off). A non-null (possibly
        // empty) array means "we already know the answer" — the component skips
        // its immediate mount fetch and only live-refreshes via the poll.
        initialSessions: sessionsResult?.sessions ?? null,
        initialSessionsCacheTimestamp: sessionsResult?.cacheTimestamp ?? null,
        heroState: heroStateResult?.heroState ?? 'full-metadata',
        // The page reads exactly one fact off the onboarding rows: whether the
        // TMDB nudge was dismissed. Shipping the full rows sent `dismissed_by`
        // and `dismissed_at` (who dismissed what, and when) to every client
        // for no rendering benefit, so resolve the boolean server-side.
        tmdbNudgeDismissed:
            heroStateResult?.onboardingSteps?.find((s) => s.step_key === 'tmdb_config')
                ?.dismissed ?? false,
        isAdmin: heroStateResult?.isAdmin ?? false,
        mediaCount: heroStateResult?.mediaCount ?? 0,
        // Whether a TMDB API key is configured (never the key itself). heroState
        // 'local-content' means the library has no TMDB external_ids yet, which can
        // also be true right after TMDB is configured but before the next metadata
        // sync attaches IDs — this separate flag lets the homepage TMDB nudge hide
        // itself once the admin has actually configured TMDB.
        tmdbConfigured: !!config.TMDB_API_KEY,
        // Per-user widget layout, SSR'd from the DB so the grid renders
        // server-side in the saved order/visibility. Null on either key =
        // "no saved value, use admin default" (the client computes the same
        // result from these keys, so SSR and first client render are identical).
        userWidgetOrder: widgetOrderResult?.widget_order ?? null,
        userHiddenWidgets: widgetOrderResult?.hidden_widgets ?? null,
        // Currently-pinned admin broadcasts, homepage-only per product decision
        // (unlike the notification drawer, which shows them on every page).
        // Empty array (never null) — the banner component renders nothing on
        // empty, so callers don't need to distinguish "no data" from "no pins".
        pinnedAnnouncements,
    };
};
