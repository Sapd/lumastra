// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure transform from the playlist-detail SSR loader's hand-built response
 * shape (`ServerPlaylist`, as returned by `[id]/+page.server.ts`) into the
 * `Playlist` type components like `PlaylistHeader` expect.
 *
 * Extracted out of `+page.svelte` (rather than left as a local function
 * inside the component's `<script>`) so this conversion is unit-testable on
 * its own: a Svelte component's instance-script functions aren't reachable
 * from a plain `import` in a test the way a function in an ordinary module
 * is. This is the seam Task 8's review found missing — `PlaylistHeader`'s
 * own tests pass a hand-built `Playlist` prop straight in, which proves the
 * component reacts to `isSystem` but does NOT prove the loader's output
 * actually reaches that prop. See `playlist-detail-transform.test.ts` and
 * `page.server.test.ts` (loader shape) for the two ends of that wiring.
 */

import type { Playlist } from '$lib/types/api-playlists';

// The server returns data with a narrower role type ('owner' | 'editor' | 'readonly' | 'public')
// but Playlist type expects 'owner' | 'editor' | 'readonly', so we need to handle 'public' case
export type ServerPlaylist = Playlist;

export function buildTypedPlaylist(sp: ServerPlaylist, itemCount: number): Playlist {
    return { ...sp, itemCount };
}

/**
 * `depends()` key of this page's load. The page invalidates it when the
 * watchlist changes from outside the list (a detail modal's Watchlist button),
 * so the watchlist playlist shows the change without a reload. Lives here, not
 * in +page.server.ts, because a route module may only export reserved names.
 */
export const PLAYLIST_DETAIL_DEPENDENCY = 'app:playlist-detail';
