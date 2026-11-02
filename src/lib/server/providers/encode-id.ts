// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Encode an external ID into the native provider's detail() parameter format.
 *
 * Per each native provider's docblock and ID parsing code:
 *
 *   tmdb-metadata-provider:
 *     'movie:550'     → movie detail (TMDB ID 550)
 *     'tv:1399'       → TV series detail (TMDB ID 1399)
 *     'tv:1399:s1'    → season 1 (not used here — top-level only)
 *
 *   jellyfin-metadata-provider:
 *     Bare Jellyfin UUID — passed through unchanged.
 *
 *   anidb-metadata-provider:
 *     Bare AniDB aid — passed through unchanged.
 *
 *   mdblist-metadata-provider:
 *     'tt1234567'           → IMDB ID (passed through)
 *     'tmdb:12345:movie'    → TMDB composite (movie)
 *     'tmdb:12345:show'     → TMDB composite (TV/series)
 *     Note: mdblist uses 'show' not 'tv'; the native provider accepts 'tv'
 *     as an alias and normalises it to 'show' internally.
 *
 *   musicbrainz-metadata-provider:
 *     Movie/TV not applicable — raw ID passed through as-is.
 *
 * External plugins may register a custom encoder via `registerProviderEncoder()`.
 * Registered encoders take precedence over the builtin switch. Plugin authors
 * who prefer the side-effect pattern may also call `registerProviderEncoder`
 * directly at module load time rather than exporting an `encoder` named export.
 */

import { isSeries } from '$lib/server/utils/media-types.js';

/**
 * Function signature that an external plugin's `encoder` named export must satisfy.
 *
 * Receives the media type and raw external ID; returns the encoded string that
 * the provider's `detail()` method accepts as its `id` parameter.
 */
export type EncodeFn = (mediaType: 'movie' | 'tv' | 'series', rawExternalId: string) => string;

const externalEncoders = new Map<string, EncodeFn>();

/**
 * Register a detail-ID encoder for an external provider.
 *
 * External encoders take precedence over the builtin switch, so an operator can
 * override a builtin encoder by registering under the same provider ID.
 *
 * Called automatically by the external plugin loader when the plugin module
 * exports an `encoder` named export. Plugin authors who prefer the side-effect
 * pattern may also call this directly at module load time.
 */
export function registerProviderEncoder(providerId: string, fn: EncodeFn): void {
    externalEncoders.set(providerId, fn);
}

/**
 * Remove a previously registered external encoder.
 * Restores fallback to the builtin switch (pass-through for unknown providers).
 *
 * @public — exported for external plugins; do not remove.
 */
export function unregisterProviderEncoder(providerId: string): void {
    externalEncoders.delete(providerId);
}

export function encodeDetailId(
    providerId: string,
    mediaType: 'movie' | 'tv' | 'series',
    rawExternalId: string,
): string {
    const ext = externalEncoders.get(providerId);
    if (ext) {
        // Defensive: a misbehaving external encoder shouldn't break the
        // detail path. Falling back to the builtin switch (or pass-through)
        // preserves liveness; the warn log surfaces the bad plugin to ops.
        try {
            return ext(mediaType, rawExternalId);
        } catch (err) {
            // Late import to avoid a top-level Logger dep cycle.
            console.warn(
                `[providers/encode-id] external encoder for "${providerId}" threw — falling back`,
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    switch (providerId) {
        case 'tmdb-metadata-provider': {
            // Pass through if the caller already encoded the id (defensive — keeps
            // 'movie:550' / 'tv:1399:s2' / 'person:1234' from getting double-prefixed).
            if (/^(movie|tv|person):/.test(rawExternalId)) return rawExternalId;
            const t = isSeries(mediaType) ? 'tv' : mediaType;
            return `${t}:${rawExternalId}`;
        }
        case 'jellyfin-metadata-provider':
        case 'anidb-metadata-provider':
            return rawExternalId;
        case 'mdblist-metadata-provider':
            // Match the IMDB id format strictly ('tt' followed by digits only) so
            // arbitrary 'tt...' strings don't slip through as IMDB ids; everything
            // else encodes as TMDB composite.
            return /^tt\d+$/.test(rawExternalId)
                ? rawExternalId
                : `tmdb:${rawExternalId}:${isSeries(mediaType) ? 'tv' : mediaType}`;
        case 'musicbrainz-metadata-provider':
            // Movie/TV not applicable — caller shouldn't reach here.
            return rawExternalId;
        default:
            return rawExternalId;
    }
}
