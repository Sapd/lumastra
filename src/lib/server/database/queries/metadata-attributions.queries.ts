// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

export interface AttributionSetting {
    plugin_id: string;
    key: string;
    value: unknown;
}

export interface AttributionSecretPresence {
    plugin_id: string;
    key: string;
}

/** Read source selection and credential presence, never secret values. */
export async function getMusicAttributionConfig(sql: postgres.Sql): Promise<{
    settings: AttributionSetting[];
    secrets: AttributionSecretPresence[];
    retainedProviders: string[];
}> {
    const [settings, secrets, retained] = await Promise.all([
        sql<AttributionSetting[]>`
            SELECT plugin_id, key, value FROM plugin_settings
            WHERE plugin_id IN ('artist-enrichment', 'album-enrichment')
              AND key IN ('primary_source', 'fallback_source', 'tertiary_source')
        `,
        sql<AttributionSecretPresence[]>`
            SELECT plugin_id, key FROM plugin_secrets
            WHERE (plugin_id IN ('discogs', 'artist-enrichment', 'album-enrichment')
                   AND key = 'DISCOGS_TOKEN')
               OR (plugin_id = 'music-popularity' AND key = 'LASTFM_API_KEY')
               OR (plugin_id = 'musicbrainz-metadata-provider' AND key = 'ACOUSTID_API_KEY')
        `,
        // Global credit presence only; no catalogue rows or metadata leave this query.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        sql<{ provider: string }[]>`
            SELECT provider FROM unnest(ARRAY['theaudiodb', 'discogs', 'deezer']) AS providers(provider)
            WHERE EXISTS (
                SELECT 1 FROM media_items mi
                WHERE mi.media_type IN ('artist', 'album')
                  AND (jsonb_path_exists(mi.custom_metadata, '$.artist_enrichment.provenance.* ? (@.provider == $provider)', jsonb_build_object('provider', provider))
                    OR jsonb_path_exists(mi.custom_metadata, '$.album_enrichment.provenance.* ? (@.provider == $provider)', jsonb_build_object('provider', provider)))
            )
        `,
    ]);
    return { settings, secrets, retainedProviders: retained.map((row) => row.provider) };
}
