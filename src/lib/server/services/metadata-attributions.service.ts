// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { config } from '$lib/server/config';
import { getMusicAttributionConfig } from '../database/queries/metadata-attributions.queries.js';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('MetadataAttributions');
const attributionConfigCache = new WeakMap<
    postgres.Sql,
    {
        expiresAt: number;
        value: ReturnType<typeof getMusicAttributionConfig>;
    }
>();

function readAttributionConfig(sql: postgres.Sql): ReturnType<typeof getMusicAttributionConfig> {
    const cached = attributionConfigCache.get(sql);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = getMusicAttributionConfig(sql);
    attributionConfigCache.set(sql, { expiresAt: Date.now() + 15_000, value });
    void value.catch(() => {
        if (attributionConfigCache.get(sql)?.value === value) attributionConfigCache.delete(sql);
    });
    return value;
}

/** Only provider identifiers leave the server; credentials stay server-side. */
export async function getConfiguredMetadataAttributions(
    sql: postgres.Sql | null,
    hasMusicLibrary: boolean,
): Promise<string[]> {
    const credits = new Set<string>();
    if (config.TMDB_API_KEY?.trim()) credits.add('tmdb');
    if (config.MDBLIST_API_KEY?.trim()) credits.add('mdblist');
    if (!config.DISABLE_FRIBB_ANIME_SYNC) credits.add('fribb');
    if (config.MAL_CLIENT_ID?.trim() && config.MAL_CLIENT_SECRET?.trim()) credits.add('myanimelist');
    if (config.TRAKT_CLIENT_ID?.trim() && config.TRAKT_CLIENT_SECRET?.trim()) credits.add('trakt');
    if (!hasMusicLibrary) return [...credits];

    // These keyless services support music identification and album artwork.
    credits.add('musicbrainz');
    credits.add('coverartarchive');
    if (config.FEATURE_MUSIC_LYRICS_FETCH) credits.add('lrclib');
    if (process.env.ACOUSTID_API_KEY?.trim()) credits.add('acoustid');
    if (!sql) return [...credits];

    try {
        const { settings, secrets, retainedProviders } = await readAttributionConfig(sql);
        for (const provider of retainedProviders)
            if (['theaudiodb', 'discogs', 'deezer'].includes(provider)) credits.add(provider);
        const hasSecret = (pluginId: string, key: string): boolean =>
            secrets.some((row) => row.plugin_id === pluginId && row.key === key);
        if (hasSecret('music-popularity', 'LASTFM_API_KEY')) credits.add('lastfm');
        if (hasSecret('musicbrainz-metadata-provider', 'ACOUSTID_API_KEY')) credits.add('acoustid');

        if (!config.DISABLE_MUSIC_ARTWORK_ENRICHMENT) {
            for (const taskId of ['artist-enrichment', 'album-enrichment']) {
                const defaults: Record<string, string> = {
                    primary_source: 'theaudiodb',
                    fallback_source: 'discogs',
                    ...(taskId === 'artist-enrichment' ? { tertiary_source: 'deezer' } : {}),
                };
                const allowed =
                    taskId === 'artist-enrichment'
                        ? ['theaudiodb', 'discogs', 'deezer']
                        : ['theaudiodb', 'discogs'];
                for (const [key, fallback] of Object.entries(defaults)) {
                    const raw = settings.find(
                        (row) => row.plugin_id === taskId && row.key === key,
                    )?.value;
                    const valid =
                        typeof raw === 'string' &&
                        (allowed.includes(raw) || (key !== 'primary_source' && raw === 'none'));
                    const source = valid ? raw : fallback;
                    if (source === 'none') continue;
                    if (
                        source === 'discogs' &&
                        !hasSecret('discogs', 'DISCOGS_TOKEN') &&
                        !hasSecret(taskId, 'DISCOGS_TOKEN')
                    )
                        continue;
                    credits.add(source);
                }
            }
        }
    } catch (error) {
        logger.warn(
            'Could not load music provider attribution configuration',
            error instanceof Error ? error : { message: String(error) },
        );
    }
    return [...credits];
}
