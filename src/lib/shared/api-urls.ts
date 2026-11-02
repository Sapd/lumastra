// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * api-urls.ts — the ONLY place an API response may derive a URL prefix.
 *
 * Every path a def emits (image hrefs, entity links, stream URLs) must be built
 * here from `ctx.surface`. Nothing else is a valid source of a prefix.
 *
 * ## Why this module exists
 *
 * Prefixes used to be produced two ways, and both were wrong in practice:
 *
 *  1. **Hardcoded literals in defs.** `/api/image/catalog/{id}/poster` (via the
 *     client-side `getCatalogPosterUrl` helper) and `/api/v1/series/{id}` were
 *     written directly into response bodies. A def is mounted on BOTH surfaces,
 *     so a fixed literal is wrong on one of them by construction: the catalog
 *     form has no `/api/v1` route at all (v1 clients got a 404 they had to
 *     special-case), and the `/api/v1/series` form leaked v1 links into
 *     internal responses.
 *
 *  2. **A hand-written `imageBase` string per mount() call.** It was passed at
 *     ~825 route files with no invariant tying it to `surface`, and drifted into
 *     three different values for the SAME surface — including 39 v1 mounts
 *     carrying the internal `/api/image`, which rendered `/api/media/...` links
 *     from a v1 endpoint. That is why the emitted shape appeared to depend on
 *     which playlist row you looked at rather than on the endpoint: it tracked
 *     the mount file, not the data.
 *
 * `surface` is the one input that cannot drift, because `mount()` is called from
 * the route file that physically defines the prefix. Deriving from it makes the
 * defect unrepresentable rather than merely fixed — there is no base left to
 * write incorrectly. An ESLint rule enforces that defs never hardcode `/api/`.
 *
 * ## Subpath installations
 *
 * Every prefix here is built on SvelteKit's configured `base` (`kit.paths.base`,
 * fed by `BASE_PATH`). An install served from `https://host/lumastra/` therefore
 * emits `/lumastra/api/v1/...` without any def knowing about it. `base` is `''`
 * for root installs, so this is a no-op for existing deployments.
 *
 * `base` is read inside each function on purpose: `$app/paths` exports a live
 * binding that SvelteKit assigns during server start-up, so hoisting it into a
 * module-level const would capture `''` before initialisation.
 */

import { base } from '$app/paths';

/** Which URL prefix a handler is mounted under. */
export type ApiSurface = 'internal' | 'v1';

/** Image roles the entity-image route serves. */
export type ImageRole = 'poster' | 'backdrop' | 'logo' | 'thumb' | 'still' | 'primary' | 'banner' | 'avatar';

/**
 * Named size presets accepted by `{base}/media/{id}/images/{role}`.
 * Bounded presets are served immutable; `full` is the unresized original.
 */
export type ImageSizePreset = 'thumb' | 'medium' | 'card' | 'hd' | 'wide' | 'full';

/**
 * The API prefix for a surface, including the install's base path.
 * The ONLY source of a prefix in a response.
 */
export function apiBase(surface: ApiSurface): string {
    return surface === 'v1' ? `${base}/api/v1` : `${base}/api`;
}

/** Which API surface a request arrived on, from its pathname (for handlers shared by both mounts). */
export function surfaceOfRequest(url: URL): ApiSurface {
    return url.pathname.startsWith('/api/v1/') ? 'v1' : 'internal';
}

/**
 * Build a path under the surface's API prefix.
 *
 * @param surface - from `ctx.surface`
 * @param path    - absolute-style path WITHOUT the prefix, e.g. `/series/${id}/seasons`
 */
export function apiUrl(surface: ApiSurface, path: string): string {
    return `${apiBase(surface)}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * URL of an audiobook byte-proxy route (`/audiobooks/{mediaId}/files|remux/...`
 * or `/audiobook/{mediaId}/hls/...`).
 *
 * These routes exist ONLY under `/api/v1` (`src/routes/api/v1/audiobooks` and
 * `src/routes/api/v1/audiobook`), and the
 * hooks' stream-token exemption (`audiobook-stream-paths.ts`) only knows that
 * prefix. A start through the internal mount (`POST /api/play-sessions`, which the
 * web player uses) used to build them from `ctx.surface`, handing the browser
 * `/api/audiobook/...`: a 404 no server log records, shown to the listener as
 * "Playback failed - couldn't play this audiobook". The delivery URL therefore
 * never follows the mount.
 */
export function audiobookDeliveryUrl(path: string): string {
    return apiUrl('v1', path);
}

/**
 * Prefix an in-app PAGE path with the install's base path.
 *
 * For routes rather than API endpoints: `redirect(302, appPath('/'))`,
 * `href={appPath('/browse')}`. Without this, a root-absolute literal sends the
 * user to the HOST root on a subpath install rather than to the app — which is
 * what `redirect(302, '/')` did at 47 call sites.
 *
 * Server- and client-safe: it reads only `$app/paths`, unlike `$lib/paths`
 * (which pulls in `$app/navigation` for its `goto` wrapper and has never been
 * exercised server-side). In a `.svelte` template prefer `$lib/paths`'s
 * `resolveRoute()` where the SvelteKit lint rule expects `resolve()`.
 *
 * Absolute URLs, protocol-relative URLs, and fragments pass through untouched
 * so callers can hand it a mixed set of destinations.
 */
export function appPath(path: string): string {
    if (
        !path.startsWith('/') ||
        path.startsWith('//') ||
        (base && (path === base || path.startsWith(`${base}/`)))
    ) {
        return path;
    }
    return `${base}${path}`;
}

/**
 * Canonical entity-image URL: `{prefix}/media/{id}/images/{role}`.
 *
 * This is the endpoint documented in-tree as "the canonical media image
 * endpoint". It exists on BOTH surfaces and resolves through the same
 * `ImageProxyService.getImageByCatalogId()` as the older
 * `/api/image/catalog/{id}/{type}` family — including the track → album → artist
 * parent-walk and fallback that music cover art depends on. Swapping the URL
 * form therefore preserves music behaviour; only the prefix changes.
 *
 * Prefer this over the legacy catalog form everywhere: `/api/image/*` has no
 * versioned counterpart, so a v1 client cannot resolve it.
 */
export function entityImageUrl(
    mediaId: string,
    role: ImageRole,
    surface: ApiSurface,
    options?: { size?: ImageSizePreset; path?: string },
): string {
    const params = new URLSearchParams();
    if (options?.size) params.set('size', options.size);
    // `path` is a provider-path hint that lets the image service skip its
    // provider API lookup. Only meaningful for composite-key ids whose path the
    // caller already holds (e.g. a TMDB episode listing's still_path).
    if (options?.path) params.set('path', options.path);
    const query = params.size > 0 ? `?${params}` : '';
    // `mediaId` is emitted raw: it is either a UUID or a composite key
    // (`tmdb:603:movie`), and a colon is legal in a path segment (RFC 3986).
    // Percent-encoding it would change every existing URL for no benefit.
    return `${apiBase(surface)}/media/${mediaId}/images/${role}${query}`;
}

/** Max ids a cover-collage URL carries (4 tiles + spares for dedupe/denied). */
export const COVER_COLLAGE_MAX_IDS = 8;

/**
 * Cover-collage href set: `{prefix}/music/images/collage?ids=a,b,c,d&size=…`.
 *
 * The server renders a square 2x2 from the ids' poster art (a single cover
 * when fewer than four distinct covers resolve). Pass candidates in priority
 * order and a few spares: the renderer drops ids the viewer cannot access and
 * tiles whose artwork is byte-identical (several tracks of one album).
 *
 * Returns undefined when there is nothing to render, so callers can spread it
 * straight into an optional field.
 */
export function buildCollageRefs(
    ids: readonly (string | null | undefined)[],
    surface: ApiSurface,
): { href: string; thumb: string; card: string; full: string } | undefined {
    const unique = [...new Set(ids.filter((id): id is string => !!id))].slice(
        0,
        COVER_COLLAGE_MAX_IDS,
    );
    if (unique.length === 0) return undefined;
    const b = `${apiBase(surface)}/music/images/collage?ids=${unique.join(',')}`;
    return {
        href: b,
        thumb: `${b}&size=thumb`,
        card: `${b}&size=card`,
        full: `${b}&size=full`,
    };
}

/**
 * Self-describing image href map for a media item.
 *
 * Each role emits the canonical preset variants so clients consume
 * bounded-preset URLs by default (cache-friendly, served immutable). The bare
 * `href` is the sizeless fallback (resolves to full); prefer `thumb` / `card` /
 * `full` for display.
 */
export function buildImageRefs(mediaId: string, surface: ApiSurface) {
    const b = `${apiBase(surface)}/media/${mediaId}/images`;
    return {
        poster: {
            href: `${b}/poster`,
            thumb: `${b}/poster?size=thumb`,
            card: `${b}/poster?size=card`,
            full: `${b}/poster?size=full`,
        },
        backdrop: {
            href: `${b}/backdrop`,
            thumb: `${b}/backdrop?size=thumb`,
            card: `${b}/backdrop?size=card`,
            // Full-bleed hero variant (1080p-class, bounded/immutable).
            wide: `${b}/backdrop?size=wide`,
            full: `${b}/backdrop?size=full`,
        },
    };
}
