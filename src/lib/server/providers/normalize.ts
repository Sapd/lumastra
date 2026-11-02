// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider-dispatched normalization helpers.
 *
 * Dispatches raw provider items (as returned by the native ProviderDefinition
 * search() and detail() methods) to the correct per-provider normalize module.
 *
 * Provider IDs must match the exact `id:` declared in each native provider:
 *   - 'tmdb-metadata-provider'
 *   - 'jellyfin-metadata-provider'
 *   - 'anidb-metadata-provider'
 *   - 'mdblist-metadata-provider'
 *   - 'musicbrainz-metadata-provider'
 *
 * External plugins may register additional normalizers via
 * `registerProviderNormalizer()`. The external registry takes precedence over
 * the builtin table, allowing operators to override a builtin if needed.
 *
 * Escape hatch: external plugin code may also call `registerProviderNormalizer`
 * directly as a side-effect import rather than exporting a `normalizer` named
 * export — both patterns are supported.
 */

import type { MetadataCandidate, MediaMetadata } from '$lib/server/providers/types.js';
import { Logger } from '$lib/server/utils/logger.js';
import * as tmdbNormalize from './implementations/tmdb/normalize.js';
import * as jellyfinNormalize from './implementations/jellyfin/normalize.js';
import * as anidbNormalize from './implementations/anidb/normalize.js';
import * as mdblistNormalize from './implementations/mdblist/normalize.js';
import * as musicbrainzNormalize from './implementations/musicbrainz/normalize.js';

const log = Logger.for('ProviderNormalize');

/**
 * Shape that an external plugin's `normalizer` named export must satisfy.
 * Both methods are optional — a plugin that only provides search results but
 * not detail pages (or vice-versa) only needs to implement the relevant half.
 */
export type NormalizerModule = {
    searchResultToCandidate?(
        raw: unknown,
        type: 'movie' | 'tv',
        queryYear?: number,
    ): MetadataCandidate | null;
    detailToMetadata?(raw: unknown, type: 'movie' | 'tv'): MediaMetadata | null;
};

const BUILTIN_NORMALIZERS: Record<string, NormalizerModule> = {
    'tmdb-metadata-provider': tmdbNormalize,
    'jellyfin-metadata-provider': jellyfinNormalize,
    'anidb-metadata-provider': anidbNormalize,
    'mdblist-metadata-provider': mdblistNormalize,
    'musicbrainz-metadata-provider': musicbrainzNormalize,
};

const externalNormalizers = new Map<string, NormalizerModule>();

/**
 * Register a normalizer module for an external provider.
 *
 * External takes precedence over the builtin table, so an operator can
 * override a builtin normalizer by registering under the same provider ID.
 *
 * Called automatically by the external plugin loader when the plugin module
 * exports a `normalizer` named export. Plugin authors who prefer the
 * side-effect pattern may also call this directly at module load time.
 */
/** Providers we've already logged an "overrides builtin" warning for. */
const warnedOverrides = new Set<string>();

export function registerProviderNormalizer(providerId: string, mod: NormalizerModule): void {
    // Warn once per (providerId, process) to avoid log noise on hot-reload —
    // operators intentionally overriding a builtin only need to see this
    // surface in their logs once.
    if (BUILTIN_NORMALIZERS[providerId] && !warnedOverrides.has(providerId)) {
        log.warn('external normalizer overrides builtin', { providerId });
        warnedOverrides.add(providerId);
    }
    externalNormalizers.set(providerId, mod);
}

/**
 * Remove a previously registered external normalizer.
 * Restores fallback to the builtin table (or unknown-provider warning if none).
 *
 * @public — exported for external plugins; do not remove.
 */
export function unregisterProviderNormalizer(providerId: string): void {
    externalNormalizers.delete(providerId);
}

/**
 * Track providerIds we've already warned about so external plugins don't
 * spam the log on every search call. The Set lives module-wide; that's fine
 * because the warning is per-process, not per-request.
 */
const warnedUnknownProviders = new Set<string>();

function warnOnce(providerId: string): void {
    if (warnedUnknownProviders.has(providerId)) return;
    warnedUnknownProviders.add(providerId);
    log.warn('no normalizer registered for provider — returning null', {
        providerId,
        hint: 'register a normalize module under providers/<id>/normalize.ts and add it to NORMALIZERS',
    });
}

export function normalizeSearchResult(
    providerId: string,
    raw: unknown,
    type: 'movie' | 'tv',
    queryYear?: number,
): MetadataCandidate | null {
    const mod = externalNormalizers.get(providerId) ?? BUILTIN_NORMALIZERS[providerId];
    if (!mod) {
        warnOnce(providerId);
        return null;
    }
    return mod.searchResultToCandidate?.(raw, type, queryYear) ?? null;
}

export function normalizeDetail(
    providerId: string,
    raw: unknown,
    type: 'movie' | 'tv',
): MediaMetadata | null {
    const mod = externalNormalizers.get(providerId) ?? BUILTIN_NORMALIZERS[providerId];
    if (!mod) {
        warnOnce(providerId);
        return null;
    }
    return mod.detailToMetadata?.(raw, type) ?? null;
}
