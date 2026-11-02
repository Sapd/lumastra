// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Path utilities for subfolder deployment support
 *
 * This module provides helpers for working with the app's base path.
 * When deployed under a subfolder (e.g., /dashboard), all internal URLs
 * need to be prefixed with the base path.
 *
 * Usage:
 *   import { base, url, navigateTo } from '$lib/paths';
 *
 *   // For API endpoints, prefer apiUrl(surface, path) from
 *   // $lib/shared/api-urls — it also picks the /api vs /api/v1 prefix.
 *
 *   // For navigation
 *   navigateTo('/watch/123')
 *
 *   // For href attributes in Svelte templates
 *   <a href="{url('/browse')}">Browse</a>
 */

import { base, resolve } from '$app/paths';
import { goto } from '$app/navigation';
import { browser } from '$app/environment';

// Re-export base for direct use
export { base };

/**
 * `resolve()` from `$app/paths` is generic over
 * `RouteIdWithSearchOrHash | PathnameWithSearchOrHash` — every route id AND every
 * pathname in the app, each ×3 for the `?search`/`#hash` variants. At ~1450 routes
 * that constraint is a ~9k-member union of template-literal types, and inferring it
 * for a *dynamic* string is astronomically expensive: this one call site alone
 * accounted for 71k of the 88k "excessive complexity" (TS2859) errors once the app
 * crossed tsgo's global type-relation budget, and it kept the whole gate ~3x slower.
 *
 * Calling through a narrowed signature is the identical function at runtime but skips
 * the giant instantiation, which is what actually keeps the typecheck gate under
 * budget as the route count grows. Do NOT "simplify" this back to `resolve(path as any)`
 * — `as any` does not avoid the constraint check; it only silences the argument type.
 * See scripts/typecheck/README.md.
 */
const resolveDynamic = resolve as unknown as (path: string) => string;

/**
 * Resolve a route path with base path prefix.
 * This is a wrapper around SvelteKit's resolve() with looser typing
 * to allow dynamic route strings.
 *
 * @param path - The path to resolve (e.g., '/watch/123' or '/browse')
 * @returns The resolved URL with base path prefix
 */
export function resolveRoute(path: string): string {
    if (
        !path.startsWith('/') ||
        path.startsWith('//') ||
        path.startsWith('http://') ||
        path.startsWith('https://') ||
        path.startsWith('mailto:') ||
        path.startsWith('tel:') ||
        path.startsWith('#')
    ) {
        return path;
    }

    return resolveDynamic(path);
}

// Re-export resolveRoute as 'resolve' for eslint compatibility
// (eslint-plugin-svelte's no-navigation-without-resolve rule checks for 'resolve' function name)
export { resolveRoute as resolve };

/**
 * Prefix a path with the base path.
 *
 * Re-exported from `$lib/shared/api-urls` rather than reimplemented: this was a
 * second, line-for-line copy of `appPath()`, and two copies of a prefixing rule
 * is exactly how the URL shapes drifted apart in the first place. `appPath` is
 * the one implementation; it lives in `$lib/shared` so server code can use it
 * without pulling in this module's `$app/navigation` dependency.
 *
 * NOTE this is NOT interchangeable with `resolve()` below. `resolve()` is
 * SvelteKit's, and because `kit.paths.relative` defaults to `true` it emits a
 * *relative* URL during SSR (`../../browse`) rather than `base + path`. That is
 * strictly more robust for links rendered into HTML, so markup and client
 * navigation should keep using `resolve()`. Use `url()`/`appPath()` where an
 * unambiguous root-absolute path is required — e.g. a redirect `Location`.
 *
 * @param path - The path to prefix (e.g., '/api/sessions' or '/browse')
 * @returns The full URL with base path prefix
 */
export { appPath as url } from '$lib/shared/api-urls.js';

/**
 * Navigate to a path with base path prefix
 * Wrapper around goto() that automatically adds base path
 *
 * @param path - The path to navigate to
 * @param options - SvelteKit goto options
 */
export async function navigateTo(
    path: string,
    options?: Parameters<typeof goto>[1],
): Promise<void> {
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolveRoute wraps resolve()
    await goto(resolveRoute(path), options);
}

/**
 * Get the current path without the base prefix
 * Useful for route matching and comparisons
 *
 * @param fullPath - The full path including base (e.g., '/dashboard/browse')
 * @returns The path without base prefix (e.g., '/browse')
 */
export function stripBase(fullPath: string): string {
    if (!base) return fullPath;

    if (
        fullPath === base ||
        fullPath.startsWith(base + '/') ||
        fullPath.startsWith(base + '?') ||
        fullPath.startsWith(base + '#')
    ) {
        const stripped = fullPath.slice(base.length);
        return !stripped || stripped.startsWith('?') || stripped.startsWith('#')
            ? '/' + stripped
            : stripped;
    }

    return fullPath;
}

/**
 * Check if a path matches (ignoring base prefix)
 *
 * @param currentPath - The current full path
 * @param targetPath - The path to match against (without base)
 * @returns True if paths match
 */
export function pathMatches(currentPath: string, targetPath: string): boolean {
    const stripped = stripBase(currentPath);
    return stripped === targetPath || stripped.startsWith(targetPath + '/');
}

/**
 * Get base path for use in non-module contexts (service worker, static scripts)
 * Returns the base path or empty string
 */
export function getBasePath(): string {
    return base;
}

/**
 * For client-side use: get base path from a global or data attribute
 * This is useful for static scripts that can't import from $app/paths
 */
export function getClientBasePath(): string {
    if (!browser) return base;

    // Try to get from data attribute on html element (set in app.html)
    const htmlBase = document.documentElement.dataset.base;
    if (htmlBase !== undefined) return htmlBase;

    // Fall back to module base
    return base;
}
