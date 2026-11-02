// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure route-scoping + active-tab logic for the mobile music bottom tab bar.
 * Framework-agnostic: consumers pass `page.route.id` and `page.url.searchParams`
 * so this is unit-testable without mounting Svelte. Matches on `route.id`
 * (base-independent, unlike a base-prefixed pathname).
 */

export type MusicTab = 'home' | 'explore' | 'library' | 'search';
export type LibrarySegment = 'playlists' | 'albums' | 'artists';

export const DEFAULT_LIBRARY_SEGMENT: LibrarySegment = 'albums';

/** True only for an explicitly music-scoped playlist route. */
export function isMusicPlaylistRoute(
    routeId: string | null,
    searchParams: URLSearchParams,
    playlistType?: unknown,
): boolean {
    if (routeId === '/playlists') return searchParams.get('type') === 'music';
    return routeId === '/playlists/[id]' && playlistType === 'music';
}

/** True when the bottom nav should render for this route (mobile gating is CSS). */
export function isMusicBottomNavRoute(
    routeId: string | null,
    searchParams: URLSearchParams,
    playlistType?: unknown,
): boolean {
    if (!routeId) return false;
    if (routeId === '/music' || routeId.startsWith('/music/')) return true;
    // A list needs the explicit type filter; a detail uses its loaded playlist
    // type, never a query parameter that could mislabel a video playlist.
    return isMusicPlaylistRoute(routeId, searchParams, playlistType);
}

/** Which tab (if any) is active. Null on music routes that no tab owns. */
export function activeMusicTab(
    routeId: string | null,
    searchParams: URLSearchParams,
    playlistType?: unknown,
): MusicTab | null {
    if (!routeId) return null;
    if (routeId === '/music') return 'home';
    if (
        [
            '/music/explore',
            '/music/map',
            '/music/path',
            '/music/collections',
            '/music/alchemy',
            '/music/radio',
        ].some((route) => routeId === route || routeId.startsWith(`${route}/`)) ||
        routeId.startsWith('/music/genres/')
    )
        return 'explore';
    if (routeId === '/music/search') return 'search';
    if (
        routeId === '/music/albums' ||
        routeId === '/music/artists' ||
        routeId.startsWith('/music/albums/') ||
        routeId.startsWith('/music/artists/')
    )
        return 'library';
    if (isMusicPlaylistRoute(routeId, searchParams, playlistType)) return 'library';
    return null;
}

/**
 * Library segment implied by the current route, or null when the route isn't
 * a library list or detail surface. Mirrors MusicLibraryTabs' active-segment
 * logic so the bottom nav's Library tab href can track segment changes made
 * via MusicLibraryTabs without waiting for a remount.
 */
export function segmentFromRoute(
    routeId: string | null,
    searchParams: URLSearchParams,
    playlistType?: unknown,
): LibrarySegment | null {
    if (routeId === '/music/albums' || routeId?.startsWith('/music/albums/')) return 'albums';
    if (routeId === '/music/artists' || routeId?.startsWith('/music/artists/')) return 'artists';
    if (isMusicPlaylistRoute(routeId, searchParams, playlistType)) return 'playlists';
    return null;
}

/** Canonical href for a Library segment (used by the Library tab + segmented header). */
export function libraryHref(segment: LibrarySegment): string {
    switch (segment) {
        case 'playlists':
            return '/playlists?type=music';
        case 'albums':
            return '/music/albums';
        case 'artists':
            return '/music/artists';
    }
}

/** username-scoped localStorage key for the last-used Library segment. */
export function librarySegmentStorageKey(username: string): string {
    return `lumastra:music:last-library-segment:${username}`;
}
