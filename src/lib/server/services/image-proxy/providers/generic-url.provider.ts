// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generic URL Image Provider
 *
 * Serves image art paths that are already absolute http(s) URLs.
 * Used when a non-TMDB provider (e.g. faketvdb, tvdb, anidb) stores
 * absolute image URLs in the provider_metadata artwork block rather than
 * TMDB-style relative paths (e.g. "/abc.jpg").
 *
 * Delegates fetching to the service's fetchCustomUrl so that SSRF
 * protection, disk caching, format conversion, and WebP/AVIF encoding
 * all apply without duplication.
 */

/**
 * Determine whether a path string is an absolute http(s) URL.
 * TMDB-style paths start with "/" and are relative to image.tmdb.org.
 * An absolute URL from a generic provider starts with "http://" or "https://".
 */
export function isAbsoluteUrl(path: string | null | undefined): path is string {
    if (!path) return false;
    return /^https?:\/\//i.test(path);
}
