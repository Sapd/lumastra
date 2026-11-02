// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { config, readConfig } = vi.hoisted(() => ({
    config: {
        TMDB_API_KEY: '',
        MDBLIST_API_KEY: '',
        OMDB_API_KEY: '',
        DISABLE_FRIBB_ANIME_SYNC: true,
        MAL_CLIENT_ID: '',
        MAL_CLIENT_SECRET: '',
        TRAKT_CLIENT_ID: '',
        TRAKT_CLIENT_SECRET: '',
        FEATURE_MUSIC_LYRICS_FETCH: false,
        DISABLE_MUSIC_ARTWORK_ENRICHMENT: false,
    },
    readConfig: vi.fn(),
}));
vi.mock('$lib/server/config', () => ({ config }));
vi.mock('../database/queries/metadata-attributions.queries.js', () => ({
    getMusicAttributionConfig: readConfig,
}));
import { getConfiguredMetadataAttributions } from './metadata-attributions.service';

beforeEach(() => {
    config.TMDB_API_KEY = '';
    config.MDBLIST_API_KEY = '';
    config.OMDB_API_KEY = '';
    config.DISABLE_FRIBB_ANIME_SYNC = true;
    config.MAL_CLIENT_ID = '';
    config.MAL_CLIENT_SECRET = '';
    config.TRAKT_CLIENT_ID = '';
    config.TRAKT_CLIENT_SECRET = '';
    config.FEATURE_MUSIC_LYRICS_FETCH = false;
    config.DISABLE_MUSIC_ARTWORK_ENRICHMENT = false;
    vi.stubEnv('ACOUSTID_API_KEY', '');
    readConfig.mockReset().mockResolvedValue({ settings: [], secrets: [], retainedProviders: [] });
});

describe('configured metadata credits', () => {
    it('never credits OMDb: nothing fetches from it, so a leftover key earns no credit', async () => {
        config.OMDB_API_KEY = 'leftover-key';
        expect(await getConfiguredMetadataAttributions(null, false)).toEqual([]);
    });
    it.each(['', '  '])('omits TMDB for an absent/blank key (%s)', async (key) => {
        config.TMDB_API_KEY = key;
        expect(await getConfiguredMetadataAttributions(null, false)).toEqual([]);
    });
    it.each(['v3-key', 'eyJ.read-token'])(
        'credits either TMDB credential form without exposing it',
        async (key) => {
            config.TMDB_API_KEY = key;
            expect(await getConfiguredMetadataAttributions(null, false)).toEqual(['tmdb']);
            expect(readConfig).not.toHaveBeenCalled();
        },
    );
    it('retains known credits if the optional music configuration lookup fails', async () => {
        config.TMDB_API_KEY = 'key';
        readConfig.mockRejectedValue(new Error('database unavailable'));
        expect(await getConfiguredMetadataAttributions({} as never, true)).toEqual([
            'tmdb',
            'musicbrainz',
            'coverartarchive',
        ]);
    });
    it('uses the keyless default chains and omits unconfigured secrets', async () => {
        expect(await getConfiguredMetadataAttributions({} as never, true)).toEqual([
            'musicbrainz',
            'coverartarchive',
            'theaudiodb',
            'deezer',
        ]);
    });
    it('honors disabled sources and includes credentialed services only when selected', async () => {
        readConfig.mockResolvedValue({
            retainedProviders: [],
            settings: [
                { plugin_id: 'artist-enrichment', key: 'primary_source', value: 'discogs' },
                { plugin_id: 'artist-enrichment', key: 'fallback_source', value: 'none' },
                { plugin_id: 'artist-enrichment', key: 'tertiary_source', value: 'none' },
                { plugin_id: 'album-enrichment', key: 'primary_source', value: 'discogs' },
                { plugin_id: 'album-enrichment', key: 'fallback_source', value: 'none' },
            ],
            secrets: [
                { plugin_id: 'discogs', key: 'DISCOGS_TOKEN' },
                { plugin_id: 'music-popularity', key: 'LASTFM_API_KEY' },
            ],
        });
        expect(await getConfiguredMetadataAttributions({} as never, true)).toEqual([
            'musicbrainz',
            'coverartarchive',
            'lastfm',
            'discogs',
        ]);
    });
    it('recognizes MusicBrainz plugin fingerprinting credentials', async () => {
        readConfig.mockResolvedValue({
            retainedProviders: [],
            settings: [],
            secrets: [{ plugin_id: 'musicbrainz-metadata-provider', key: 'ACOUSTID_API_KEY' }],
        });
        expect(await getConfiguredMetadataAttributions({} as never, true)).toContain('acoustid');
    });
    it('omits artwork sources when enrichment is disabled', async () => {
        config.DISABLE_MUSIC_ARTWORK_ENRICHMENT = true;
        expect(await getConfiguredMetadataAttributions({} as never, true)).toEqual([
            'musicbrainz',
            'coverartarchive',
        ]);
    });
    it('credits optional lyrics and fingerprinting services when enabled', async () => {
        config.FEATURE_MUSIC_LYRICS_FETCH = true;
        vi.stubEnv('ACOUSTID_API_KEY', 'private-key');
        expect(await getConfiguredMetadataAttributions(null, true)).toEqual([
            'musicbrainz',
            'coverartarchive',
            'lrclib',
            'acoustid',
        ]);
    });
});

afterEach(() => vi.unstubAllEnvs());

it('keeps credit for retained provider data after enrichment is disabled', async () => {
    config.DISABLE_MUSIC_ARTWORK_ENRICHMENT = true;
    readConfig.mockResolvedValue({
        settings: [],
        secrets: [],
        retainedProviders: ['discogs', 'theaudiodb', 'deezer'],
    });
    expect(await getConfiguredMetadataAttributions({} as never, true)).toEqual([
        'musicbrainz',
        'coverartarchive',
        'discogs',
        'theaudiodb',
        'deezer',
    ]);
});
it('coalesces layout lookups on the same database connection', async () => {
    const sql = {} as never;
    await Promise.all([
        getConfiguredMetadataAttributions(sql, true),
        getConfiguredMetadataAttributions(sql, true),
    ]);
    expect(readConfig).toHaveBeenCalledOnce();
});

it('credits enabled anime and watch-sync integrations without requiring a music library', async () => {
    config.DISABLE_FRIBB_ANIME_SYNC = false;
    config.MAL_CLIENT_ID = 'client';
    config.MAL_CLIENT_SECRET = 'secret';
    config.TRAKT_CLIENT_ID = 'client';
    config.TRAKT_CLIENT_SECRET = 'secret';
    expect(await getConfiguredMetadataAttributions(null, false)).toEqual(['fribb', 'myanimelist', 'trakt']);
});
it('omits incompletely configured account integrations', async () => {
    config.MAL_CLIENT_ID = 'client';
    config.TRAKT_CLIENT_SECRET = 'secret';
    expect(await getConfiguredMetadataAttributions(null, false)).toEqual([]);
});
