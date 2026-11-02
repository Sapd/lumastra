// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Shared catalog links and compatibility redirects; paths have no base prefix. */

/** Path segment → route predicate, anchored so `/browse/azores` cannot match. */
function matchesRoute(pathname: string, segment: string): boolean {
    // `(^|/)` rather than a bare prefix so the app still works mounted under a
    // base path (`/lumastra/browse/az`); `/?$` because trailingSlash config can
    // produce either form.
    return new RegExp(`(^|/)browse/${segment}/?$`).test(pathname);
}

/** Whether a pathname IS the A-Z route, which implies A-Z mode on its own. */
export function isAzRoutePath(pathname: string): boolean {
    return matchesRoute(pathname, 'az');
}

/** Whether a pathname IS the filter results route. */
export function isFilterRoutePath(pathname: string): boolean {
    return matchesRoute(pathname, 'filter');
}

/**
 * `?view=recent` — the full "Recently Added" grid: the whole scope, newest
 * first, reached from the Recently Added chip and row. It is the one
 * unfiltered destination this route renders; its sort is owned by the URL and
 * never written to the remembered A-Z view preference.
 */
export const RECENT_VIEW = 'recent';

/** Whether this URL asks for the Recently Added grid rather than a filter. */
export function isRecentView(params: URLSearchParams): boolean {
    return params.get('view') === RECENT_VIEW;
}

/** Catalog destinations preserve the selected content type. */

/** The browse tabs a destination link can carry; anything else means 'all'. */
type DestinationTab = 'all' | 'movies' | 'series' | 'channels';

function typeParams(tab: DestinationTab): URLSearchParams {
    const params = new URLSearchParams();
    if (tab === 'movies' || tab === 'series') params.set('type', tab);
    return params;
}

/**
 * The full grid for one genre, keeping the active media tab. What a genre chip
 * and a genre row's "Show more" link point at. `channels` has no genre grid, so
 * it degrades to 'all' rather than emitting a type the results view rejects.
 */
export function genreBrowseHref(genre: string, tab: DestinationTab = 'all'): string {
    const params = typeParams(tab);
    params.set('genre', genre);
    params.set('mode', 'az');
    return `/browse?${params.toString()}`;
}

/** The full Recently Added grid (newest first), keeping the active media tab. */
export function recentBrowseHref(tab: DestinationTab = 'all'): string {
    const params = typeParams(tab);
    params.set('sort', 'added_desc');
    params.set('mode', 'az');
    return `/browse?${params.toString()}`;
}

/** Preserve bookmarked A–Z/filter URLs in the unified library catalog. */
export function filterRedirectTarget(url: URL): string | null {
    if (!isAzRoutePath(url.pathname) && !isFilterRoutePath(url.pathname)) return null;
    const params = new URLSearchParams(url.searchParams);
    params.set('mode', 'az');
    if (isRecentView(params)) {
        params.set('sort', 'added_desc');
        params.delete('view');
    }
    return '/browse?' + params.toString();
}
