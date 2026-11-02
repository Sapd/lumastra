// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Resolution Utilities
 *
 * Utilities for resolving external provider IDs to internal UUIDs.
 * Use these before calling services that require media_id (UUID).
 */

import type postgres from 'postgres';
import type { ExternalIdProvider } from '../utils/provider-config.js';
import { getPrimaryExternalIdProvider } from '../utils/provider-config.js';
import { CatalogService } from '../services/catalog.service.js';
import { Logger } from '../utils/logger.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import {
    getExternalIdFor,
    getLegacyJellyfinId,
    withoutLegacyJellyfinId,
} from '$lib/utils/external-ids.js';
import { UUID_RE as UUID_REGEX } from '$lib/utils/id-patterns.js';
import { resolveJellyfinIdToMediaId } from '../database/queries/resolvers/media-id.resolver.js';

const logger = Logger.for('MediaResolution');

/**
 * Provider priority order for external ID resolution.
 * TMDB is first because it's the most complete source.
 * Extend this list when new providers are added.
 */
const PROVIDER_PRIORITY = ['tmdb', 'imdb', 'tvdb', 'mal', 'trakt'] as const;

/**
 * Resolve an external provider ID to an internal UUID.
 * If the media item does not exist in the catalog, creates a minimal stub record.
 *
 * Use this before calling addUserRating() or any service that requires media_id.
 *
 * @param sql - Postgres SQL instance
 * @param extId - External ID string (e.g., "12345" for TMDB, "tt0137523" for IMDB)
 * @param mediaType - Media type ('movie', 'tv', or 'audiobook')
 * @param provider - Provider for the external ID (defaults to primary configured provider)
 * @param title - Optional title for stub creation when item does not exist
 * @returns Internal UUID (media_items.id)
 */
export async function resolveOrCreateMediaId(
    sql: postgres.Sql,
    extId: string,
    mediaType: 'movie' | 'tv' | 'audiobook',
    provider?: ExternalIdProvider,
    title?: string,
): Promise<string> {
    const resolvedProvider = provider ?? getPrimaryExternalIdProvider();

    // Use advisory-locked getOrCreateMinimal to prevent race conditions
    // (check-then-insert without a lock would create duplicate media_items rows
    //  under concurrent rating requests for the same new media item)
    const catalogService = new CatalogService(sql);
    const result = await catalogService.getOrCreateMinimal(
        extId,
        resolvedProvider,
        mediaType,
        title,
    );

    if (result.isNew) {
        logger.info('Created stub media entry', {
            mediaId: result.id,
            extId,
            provider: resolvedProvider,
            mediaType,
        });
    }

    return result.id;
}

/** A Jellyfin item id: 32 hex digits, dashed or not. */
const JELLYFIN_ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Upper bound on canonical_id hops (same as the id resolver). */
const MAX_CANONICAL_HOPS = 5;

/**
 * Map a legacy Jellyfin item id (sent by an older client) to the internal id of
 * the ACTIVE item that owns it, following merges. Lookup only: it never creates
 * a row and never calls Jellyfin. Returns null when the id is not mapped (always
 * the case on a standalone install) or the item is gone.
 */
export async function lookupLegacyJellyfinMediaId(
    sql: postgres.Sql,
    jellyfinId: string,
): Promise<string | null> {
    const trimmed = jellyfinId.trim();
    if (!JELLYFIN_ID_RE.test(trimmed)) return null;

    let currentId = await resolveJellyfinIdToMediaId(sql, trimmed);
    for (let hop = 0; currentId && hop <= MAX_CANONICAL_HOPS; hop++) {
        const rows = await sql<{ status: string; canonical_id: string | null }[]>`
            SELECT status, canonical_id FROM media_items WHERE id = ${currentId} LIMIT 1
        `;
        const row = rows[0];
        if (!row) return null;
        if (row.status === 'active') return currentId;
        if (!row.canonical_id) return null;
        currentId = row.canonical_id;
    }
    return null;
}

/**
 * Normalise an incoming external-ids dict from a client: a legacy `jellyfin`
 * key is removed, and when the dict has no `internal` id the Jellyfin id is
 * mapped (lookup only) to the internal id of the item that owns it. The result
 * never carries `jellyfin`, so it is safe to echo back in a response.
 */
export async function mapLegacyJellyfinExternalIds<
    T extends { internal?: string; jellyfin?: string },
>(sql: postgres.Sql, externalIds: T): Promise<T> {
    if (!externalIds) return externalIds;
    const jellyfinId = getLegacyJellyfinId(externalIds);
    const rest = withoutLegacyJellyfinId(externalIds);
    if (jellyfinId && !rest.internal) {
        const mapped = await lookupLegacyJellyfinMediaId(sql, jellyfinId);
        if (mapped) return { ...rest, internal: mapped };
    }
    return rest;
}

/**
 * Resolve an ExternalIds dict to an internal UUID.
 *
 * Fast path: if `externalIds.internal` is a valid UUID, return it directly
 * (no database lookup needed — item is already in the catalog).
 *
 * Otherwise, picks the best available provider using PROVIDER_PRIORITY order,
 * then calls resolveOrCreateMediaId directly — no TMDB intermediate step.
 *
 * Returns null if externalIds is empty or undefined (caller should return 400).
 *
 * @param sql - Postgres SQL instance
 * @param externalIds - Dict of provider → id (e.g. { tmdb: '12345', imdb: 'tt0137523' })
 * @param mediaType - Media type
 * @param title - Optional title for stub creation
 */
export async function resolveExternalIdsToMediaId(
    sql: postgres.Sql,
    externalIds: ExternalIds | undefined,
    mediaType: 'movie' | 'tv' | 'audiobook',
    title?: string,
): Promise<string | null> {
    if (!externalIds) return null;

    // Fast path: internal UUID already available — use directly, skip DB lookup
    const internalUuid = getExternalIdFor(externalIds, 'internal');
    if (internalUuid && UUID_REGEX.test(internalUuid)) {
        return internalUuid;
    }

    // Try providers in priority order
    for (const provider of PROVIDER_PRIORITY) {
        const id = externalIds[provider];
        if (id && id.trim()) {
            return resolveOrCreateMediaId(
                sql,
                id.trim(),
                mediaType,
                provider as ExternalIdProvider,
                title,
            );
        }
    }

    // Fall through: try any remaining provider not in the priority list
    for (const [provider, id] of Object.entries(externalIds)) {
        if (provider === 'jellyfin') {
            // A legacy Jellyfin id from an older client: map it through the
            // rows Jellyfin sync keeps, never create a stub keyed by it.
            if (typeof id === 'string') {
                const mapped = await lookupLegacyJellyfinMediaId(sql, id);
                if (mapped) return mapped;
            }
            continue;
        }
        if (provider !== 'internal' && id && id.trim()) {
            return resolveOrCreateMediaId(
                sql,
                id.trim(),
                mediaType,
                provider as ExternalIdProvider,
                title,
            );
        }
    }

    return null;
}
