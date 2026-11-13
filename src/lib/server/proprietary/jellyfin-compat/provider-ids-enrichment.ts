// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ProviderIds Enrichment for Jellyfin Compat Item Responses
 *
 * Real Jellyfin populates `ProviderIds: { Tmdb, Imdb, Tvdb, ... }` on every
 * item so downstream consumers (Seerr, Jellyseerr, request managers) can
 * match library items to their TMDB-keyed databases.
 *
 * Lumastra's serializer used to emit `ProviderIds: {}` always — items appeared
 * but Seerr rejected every one with "Unable to find TMDb ID". This helper
 * batch-fetches `external_ids` rows for every Jellyfin item ID in one query
 * and mutates each item's ProviderIds in place.
 *
 * Provider name mapping (Lumastra → Jellyfin):
 *   tmdb     -> Tmdb
 *   imdb     -> Imdb
 *   tvdb     -> Tvdb
 *   anidb    -> AniDB (Seerr uses this for anime fallback)
 *   musicbrainz             -> MusicBrainzArtist | MusicBrainzAlbum |
 *                              MusicBrainzTrack (per item Type)
 *   musicbrainz_releasegroup -> MusicBrainzReleaseGroup
 *
 * Duplicate (media_id, provider) rows in `external_ids` are deduplicated in
 * SQL via DISTINCT ON ordered by `is_primary DESC, created_at ASC, id ASC`,
 * so the chosen external_id is deterministic across runs (primary wins;
 * oldest non-primary wins as tiebreaker).
 *
 * Lumastra-internal provider rows (`jellyfin`, `jellyseerr`, etc.) are
 * deliberately NOT exposed — they're internal correlation IDs, not the
 * canonical metadata sources Seerr cares about.
 */
import type postgres from 'postgres';
import type { JellyfinBaseItemDto } from './types';
import { isUuid } from '$lib/server/utils/media-key-parser.js';

interface ExternalIdRow {
    media_id: string;
    provider: string;
    external_id: string;
}

/**
 * Map Lumastra provider names to Jellyfin's ProviderIds keys.
 * Returns null for providers we deliberately don't expose externally.
 */
function mapProviderKey(provider: string, itemType: string | undefined): string | null {
    switch (provider) {
        case 'tmdb':
            return 'Tmdb';
        case 'imdb':
            return 'Imdb';
        case 'tvdb':
            return 'Tvdb';
        case 'anidb':
            return 'AniDB';
        case 'musicbrainz':
            // Jellyfin uses distinct ProviderIds keys per music level:
            //   MusicArtist -> MusicBrainzArtist
            //   MusicAlbum  -> MusicBrainzAlbum
            //   Audio       -> MusicBrainzTrack (recording-level MBID)
            // Misclassifying a track id under MusicBrainzAlbum would point
            // downstream consumers at the wrong MB entity entirely.
            if (itemType === 'MusicArtist') return 'MusicBrainzArtist';
            if (itemType === 'Audio') return 'MusicBrainzTrack';
            return 'MusicBrainzAlbum';
        case 'musicbrainz_releasegroup':
            return 'MusicBrainzReleaseGroup';
        default:
            // jellyfin, jellyseerr, and any unknown provider stay internal
            return null;
    }
}

/**
 * Mutates each item to populate `ProviderIds` from external_ids rows.
 * Items without any external_ids are left with `ProviderIds: {}` (the
 * default the serializer emits).
 */
export async function enrichItemsWithProviderIds(
    sql: postgres.Sql,
    items: JellyfinBaseItemDto[],
): Promise<void> {
    const ids = [...new Set(items.map((i) => i.Id).filter((id) => isUuid(id)))];
    if (ids.length === 0) return;

    // DISTINCT ON guarantees one row per (media_id, provider) so duplicate
    // rows (e.g. legacy + reconciled TMDB ids) don't lead to non-deterministic
    // last-write-wins in the JS loop below. Primary rows win; oldest
    // created_at is the tiebreaker; id breaks any final ties.
    const rows = (await sql`
        SELECT DISTINCT ON (media_id, provider)
               media_id, provider, external_id
        FROM external_ids
        WHERE media_id = ANY(${ids}::uuid[])
          AND provider IN ('tmdb', 'imdb', 'tvdb', 'anidb',
                           'musicbrainz', 'musicbrainz_releasegroup')
        ORDER BY media_id, provider, is_primary DESC, created_at ASC, id ASC
    `) as unknown as ExternalIdRow[];

    if (rows.length === 0) return;

    const itemsById = new Map<string, JellyfinBaseItemDto>();
    for (const item of items) {
        // Replace whatever the serializer set (almost certainly {}) with a
        // fresh object so multiple call sites don't share references.
        item.ProviderIds = {};
        itemsById.set(item.Id, item);
    }

    for (const row of rows) {
        const item = itemsById.get(row.media_id);
        if (!item) continue;
        const key = mapProviderKey(row.provider, item.Type);
        if (key) (item.ProviderIds as Record<string, string>)[key] = row.external_id;
    }
}
