// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client-side mirror of the server's watchlist media-type allowlist
 * (`allowedMediaTypes` on `WATCHLIST_POLICY` in
 * `$lib/server/services/playlist-kind-policy.ts`, which is server-only and
 * cannot be imported from a `.svelte` component).
 *
 * Used by both add-to-playlist entry points (`AddToPlaylistModal.svelte` and
 * `AddToPlaylistSubmenu.svelte`) to hide the watchlist as a target for a
 * media type the server would reject with a 400 — this is a UX filter, not
 * the enforcement point; the server still gates the actual write.
 *
 * Kept as ONE shared constant rather than two copies so the two entry points
 * can't drift out of sync with each other, even though they can still drift
 * from the server's own policy if that ever changes (there is no way to share
 * a literal across the server/client boundary here — see the file header
 * above).
 */
export const WATCHLIST_MEDIA_TYPES: ReadonlySet<string> = new Set([
    'movie',
    'tv',
    'series',
    'audiobook',
]);
