// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { UserContext } from '$lib/server/types';
import type { JellyfinItemsResponse } from './types';

export const EMPTY_ITEMS_RESPONSE: JellyfinItemsResponse = {
    Items: [],
    TotalRecordCount: 0,
    StartIndex: 0,
};

/**
 * Case-insensitive URL search params wrapper.
 * Jellyfin clients send params in varying cases (PascalCase, camelCase, lowercase).
 * This wrapper tries all common casings.
 */
export function getParam(url: URL, name: string): string | null {
    return (
        url.searchParams.get(name) ??
        url.searchParams.get(name.toLowerCase()) ??
        url.searchParams.get(name.charAt(0).toLowerCase() + name.slice(1)) ??
        null
    );
}

/**
 * Returns the Jellyfin compat token associated with the current request.
 *
 * For session-authenticated requests (via AuthenticateByName + Valkey-cached session
 * token), returns the session token, replayable against `jfcompat:session:<token>`.
 *
 * For PAT-authenticated requests (`authMethod === 'jellyfin_compat_pat'`), returns
 * the empty string `''` because PATs cannot be replayed against `jfcompat:session:*`.
 * Consumers that embed this value as `&api_key=...` in returned URLs (e.g.,
 * MediaSources stream URLs) get an empty api_key, which is harmless because all
 * stream-fetch routes are marked `pat: 'deny'` and reject PAT auth.
 *
 * Routes that fundamentally require a replayable session token are marked
 * `pat: 'deny'` (see middleware.ts options).
 */
export function getJfToken(locals: Record<string, unknown>): string {
    return (locals.jfToken as string) ?? '';
}

/** Longest search term honoured; clients send what the user typed, so cut rather than 400. */
export const MAX_SEARCH_TERM_LENGTH = 200;

/** The `SearchTerm` parameter, cut to {@link MAX_SEARCH_TERM_LENGTH}. */
export function getSearchTermParam(url: URL): string | null {
    const term = getParam(url, 'SearchTerm');
    return term === null ? null : term.slice(0, MAX_SEARCH_TERM_LENGTH);
}

export function getParamAll(url: URL, name: string): string[] {
    const values = url.searchParams.getAll(name);
    if (values.length > 0) return values;
    const lower = url.searchParams.getAll(name.toLowerCase());
    if (lower.length > 0) return lower;
    const camel = url.searchParams.getAll(name.charAt(0).toLowerCase() + name.slice(1));
    if (camel.length > 0) return camel;
    return [];
}

/**
 * Shared Live TV permission check for `/j` handlers that serve channel or
 * program metadata (channel detail, program detail, PlaybackInfo's Live TV
 * branches). `hasLiveTvPermission` is the ONLY control over a `tvchannel` /
 * program row — the generic library-access predicate cannot bind to one (no
 * `library_group_id` exists anywhere in the Live TV data model; see
 * `library-access.builder.ts`'s header comment).
 *
 * Authentication narrows this flag with the admin's per-user Live TV switch
 * on every request. Callers hide denied metadata and playback with 404 or an
 * empty list, as for an unconfigured source.
 */
export function hasLiveTvPermission(user: UserContext | undefined): boolean {
    return user?.hasLiveTvPermission === true;
}
