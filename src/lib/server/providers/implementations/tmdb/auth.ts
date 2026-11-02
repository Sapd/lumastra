// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TMDB request authentication, shared by every call site that talks to
 * api.themoviedb.org.
 *
 * `TMDB_API_KEY` holds one of two credential shapes, both shown on
 * themoviedb.org/settings/api:
 *
 * - a v3 "API Key" (32 hex chars), sent as the `api_key` query parameter;
 * - a v4 "API Read Access Token" (a JWT, starts with `eyJ`), sent as
 *   `Authorization: Bearer`.
 *
 * TMDB rejects each shape with 401 when it is sent the other way, so a call
 * site that hardcodes one of them breaks for half of all installs. Build
 * every TMDB request through {@link tmdbAuthorizedRequest}.
 *
 * Pure (no config import) so the task tree and tests can use it directly.
 */

/** True when `apiKey` is a v4 Read Access Token (a JWT) rather than a v3 key. */
export function isTmdbBearerToken(apiKey: string): boolean {
    return apiKey.trim().startsWith('eyJ');
}

export interface TmdbAuthorizedRequest {
    url: string;
    headers: Record<string, string>;
}

/**
 * Attach TMDB credentials to `url`: a Bearer header for a v4 token, the
 * `api_key` query parameter for a v3 key. Existing query parameters are kept.
 * `extraHeaders` are merged in (the auth header wins).
 *
 * The v3 form puts the key in the URL, so callers must not log the returned
 * URL.
 */
export function tmdbAuthorizedRequest(
    url: string | URL,
    apiKey: string,
    extraHeaders: Record<string, string> = {},
): TmdbAuthorizedRequest {
    const key = apiKey.trim();
    const target = new URL(url);
    if (isTmdbBearerToken(key)) {
        return {
            url: target.toString(),
            headers: { ...extraHeaders, Authorization: `Bearer ${key}` },
        };
    }
    target.searchParams.set('api_key', key);
    return { url: target.toString(), headers: { ...extraHeaders } };
}
