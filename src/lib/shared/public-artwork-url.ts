// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Build a PUBLIC artwork URL — one that Discord's servers can fetch directly.
 *
 * The Discord Rich Presence `assets.large_image` field accepts an external URL,
 * which Discord fetches and proxies from its own infrastructure. A Lumastra
 * reachable only on a LAN or over Tailscale therefore cannot serve artwork to
 * Discord at all, no matter what the client does.
 *
 * TMDB's CDN is public by definition, so a TMDB-relative `poster_path` is the
 * one artwork source guaranteed to work for every deployment. This helper turns
 * such a path into an absolute URL and otherwise refuses to guess.
 *
 * @module shared/public-artwork-url
 */

/** TMDB CDN base — mirrors `provider-config.ts`. */
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

/**
 * Poster size. w500 is the smallest size that still looks sharp in Discord's
 * large-image slot (which renders at roughly 300x300 on desktop).
 */
const POSTER_SIZE = 'w500';

/**
 * Resolve a stored artwork path into a public https URL.
 *
 * @param path - A TMDB-relative path (`/abc.jpg`) or an absolute https URL.
 * @returns The public URL, or `undefined` when none can be derived.
 */
export function buildPublicArtworkUrl(path: string | null | undefined): string | undefined {
    const trimmed = path?.trim();
    if (!trimmed) return undefined;

    // Already absolute. Require https: Discord will not fetch plaintext http,
    // so returning one would render an empty image slot rather than an error.
    if (trimmed.startsWith('https://')) return trimmed;
    if (trimmed.startsWith('http://')) return undefined;

    // TMDB-relative paths always begin with a slash. Anything else is a storage
    // key of unknown provenance, not something Discord could fetch.
    if (trimmed.startsWith('/')) return `${TMDB_IMAGE_BASE}/${POSTER_SIZE}${trimmed}`;

    return undefined;
}
