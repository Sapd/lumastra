// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browse page server load — SSR the Continue-Watching / Next-Up strip AND the
 * default tab's genre carousels + Recently Added.
 *
 * Previously /browse fetched CW purely on the client: onMount fired
 * `/api/for-you/watching`, and the two SSE-revision effects fired it again on
 * the connection's initial sync — a three-request chain that didn't settle
 * until ~2.5s. We now run the same `effectiveWatchingFor` primitive the home
 * page uses and AWAIT it, so the CW row is server-rendered into the first-paint
 * HTML — exactly like home. (A streamed/unawaited promise was tried first, but
 * it leaves the row empty until the client seed-effect runs post-hydration,
 * producing a visible skeleton→content flash that reads as "slow" next to
 * home's all-at-once render. Blocking here only adds the CW query to /browse's
 * TTFB — the genre carousels still client-load in parallel — and matches home's
 * feel, which users read as instant.)
 *
 * The shape mirrors `/api/for-you/watching`'s `{ sections }` so the client can
 * consume the canonical section directly. `watchingSuppressed` distinguishes an
 * intentional policy decision from a transient SSR failure that should fall
 * back to the client endpoint.
 *
 * Genre carousels + Recently Added are SSR'd the same way: `loadBrowseIndexData`
 * (the extracted core of `/api/browse`'s handler — see browse-index.service.ts)
 * is called directly, in-process, for the tab the request URL selects — the
 * SAME cache entries `/api/browse` itself reads/writes. A null payload means
 * "SSR failed or the viewer isn't eligible" and the client falls back to its
 * existing `browseApi.getBrowse()` mount fetch, exactly like the CW fallback.
 *
 * Both branches are independent of each other (different queries, no shared
 * input) and are kicked off CONCURRENTLY so /browse's TTFB pays max(CW, genre),
 * not their sum.
 */

import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/database/connection.js';
import { effectiveWatchingFor } from '$lib/server/services/effective-watching.service.js';
import { buildWatchingSections } from '$lib/server/utils/section-builder.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { resolveViewerMetadataLanguages } from '$lib/server/utils/metadata-language-resolve.js';
import { getEffectiveUser } from '$lib/server/dev-user.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { type UserId } from '$lib/shared/user-id.js';
import { shouldSuppressBrowseWatching } from './watching-policy.js';
import { stripAudiobookListArraysFromSections } from '$lib/server/utils/strip-audiobook-list-arrays.js';
import {
    loadBrowseIndexData,
    type BrowseIndexMediaType,
} from '$lib/server/services/browse-index.service.js';
import { trimItemOverview, trimRowItemOverviews } from '$lib/server/utils/truncate-overview.js';
import type { BrowseItem, BrowseGenreRow } from '$lib/schemas/api-browse-responses.js';

const logger = Logger.for('BrowsePageSSR');

const WATCHING_SSR_LIMIT = 10;
// Match the home page: cap the live-overlay's contribution so a slow session
// read can never stall the strip; durable state renders and the client's
// SSE-driven refresh reconciles the live position after hydration.
const WATCHING_SSR_OVERLAY_BUDGET_MS = 50;

export type BrowseWatchingSSR = {
    sections: ReturnType<typeof buildWatchingSections>;
} | null;

export type BrowseIndexSSR = {
    recentlyAdded: BrowseItem[];
    genres: BrowseGenreRow[];
} | null;

/**
 * Resolve the tab `/browse` renders with no query/URL state.
 *
 * Mirrors `+page.svelte`'s own onMount URL parse EXACTLY (only `'movies'` /
 * `'series'` are recognized; anything else, including `'movie'` or
 * `'channels'`, falls back to the default `'all'` tab) so the SSR payload
 * always matches the tab the client will land on — never call the client's
 * `getBrowse()` for a different tab than the one this load just rendered.
 */
function resolveBrowseSsrMediaType(url: URL): BrowseIndexMediaType {
    const raw = url.searchParams.get('type');
    if (raw === 'movies') return 'movie';
    if (raw === 'series') return 'series';
    return 'all';
}

export const load: PageServerLoad = async ({ locals, request, url }) => {
    const user = locals.user;
    const mediaType = resolveBrowseSsrMediaType(url);

    // Independent of the watching branch below (different queries, no shared
    // input) — kicked off here, awaited together at the bottom via
    // Promise.all, so the two run concurrently rather than one adding its
    // full latency on top of the other.
    const browsePromise: Promise<BrowseIndexSSR> = (async () => {
        // The /api/browse endpoint this reuses requires auth (`kind: 'user'`);
        // an anonymous viewer would get the same 401 from the client fetch, so
        // skip SSR rather than pay a doomed query. Age-restricted viewers DO
        // get genre/recently-added SSR — only the CW/NU strip is suppressed
        // for them (see shouldSuppressBrowseWatching below).
        if (!user) return null;
        try {
            const sql = getDb();
            if (!sql) return null;
            const data = await loadBrowseIndexData(sql, { mediaType, user });
            return {
                // Genre rows and Recently Added are movie/tv only — never
                // audiobooks — so they don't need stripAudiobookListArrays*.
                recentlyAdded: data.recentlyAdded.map(trimItemOverview),
                genres: data.genres.map(trimRowItemOverviews),
            };
        } catch (err) {
            logger.warn(
                'Browse genre/recently-added SSR failed; client will fetch on mount',
                err instanceof Error ? err : undefined,
            );
            return null;
        }
    })();

    // Anonymous or age-restricted profiles never get the CW/NU strip — resolve
    // null cheaply and explicitly suppress every client refresh path.
    const watchingPromise: Promise<{
        watching: BrowseWatchingSSR;
        watchingSuppressed: boolean;
    }> = shouldSuppressBrowseWatching(user)
        ? Promise.resolve({ watching: null, watchingSuppressed: true })
        : // AWAITED: the CW row is server-rendered into the first-paint HTML (no
          // post-hydration flash). Only the CW query is added to /browse's TTFB.
          (async () => {
              try {
                  const sql = getDb();
                  if (!sql) return { watching: null, watchingSuppressed: false };

                  const username = getEffectiveUser(request, user.username || config.DEFAULT_USER);
                  // Prefer the caller's resolved id; only look up when previewing
                  // another (admin-preview) username.
                  let userId: UserId | undefined =
                      username === user.username ? user.userId : undefined;
                  if (!userId) userId = (await getUserIdByUsername(sql, username)) ?? undefined;
                  if (!userId) return { watching: null, watchingSuppressed: false };

                  // buildSearchAccessContext and resolveViewerMetadataLanguages are
                  // independent reads off the same sql/user — run them concurrently
                  // instead of serially.
                  const [accessCtx, langs] = await Promise.all([
                      buildSearchAccessContext(sql, user),
                      resolveViewerMetadataLanguages(sql, user.userId),
                  ]);

                  const result = await effectiveWatchingFor({
                      username,
                      userId,
                      limit: WATCHING_SSR_LIMIT,
                      mergeSort: false,
                      includeNewEpisodes: false, // client fetches new-episode alerts on mount
                      liveOverlayBudgetMs: WATCHING_SSR_OVERLAY_BUDGET_MS,
                      skipSuspicion: true, // amber bulk-mark warning is recomputed by the client refresh
                      access: {
                          deniedGroupIds: accessCtx.deniedGroupIds,
                          ageRating: accessCtx.ageRating,
                      },
                      // Localize CW/NU titles+overviews to the viewer's language (same
                      // overlay the modal applies). Keyed on the VIEWER (user.userId),
                      // not the admin-previewed `userId` whose DATA we render, so the
                      // language matches the home page. No-op when the feature is off.
                      langs,
                  });

                  return {
                      watching: {
                          // Audiobook chapter/file lists are stripped here — a single
                          // in-progress audiobook can carry hundreds of entries in each
                          // array and no rail card renders them (see
                          // stripAudiobookListArraysFromSections).
                          sections: stripAudiobookListArraysFromSections(
                              buildWatchingSections({
                                  continueWatching: result.continueWatching,
                                  nextUp: result.nextUp,
                              }),
                          ),
                      },
                      watchingSuppressed: false,
                  };
              } catch (err) {
                  logger.warn(
                      'Browse Continue-Watching SSR failed; client will fetch on mount',
                      err instanceof Error ? err : undefined,
                  );
                  return { watching: null, watchingSuppressed: false };
              }
          })();

    const [{ watching, watchingSuppressed }, browseSsr] = await Promise.all([
        watchingPromise,
        browsePromise,
    ]);

    // NOTE: named `browseSsr`, NOT `browse` — the root layout load
    // (`+layout.server.ts`) already returns a `browse: { searchDebounceMs,
    // azPageSize, … }` config object that `+page.svelte` reads via
    // `$page.data.browse`. SvelteKit merges layout + page load data into one
    // object, with the page's own keys winning on collision — a `browse` key
    // here would have silently clobbered that config object.
    return { watching, watchingSuppressed, browseSsr };
};
