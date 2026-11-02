// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildProviderIndex, buildRegistryIndex } from './provider-search-index';
import type { AdminProviderEntry } from '$lib/server/plugins/runtime/admin-providers-listing';

function entry(over: Partial<AdminProviderEntry>): AdminProviderEntry {
    return {
        provider: 'x',
        label: 'X',
        priority: 0,
        enabled: true,
        capabilities: {},
        configured: true,
        category: 'metadata',
        source: 'builtin',
        hasSettings: true,
        version: '1',
        ...over,
    };
}

describe('buildProviderIndex', () => {
    it('maps a provider to a search entry with a providers-page deep-link', () => {
        const idx = buildProviderIndex([
            entry({ provider: 'tmdb-metadata-provider', label: 'TMDB', category: 'metadata' }),
        ]);
        const tmdb = idx.find((e) => e.id === 'tmdb-metadata-provider');
        expect(tmdb?.href).toBe('/admin/settings/providers');
        expect(tmdb?.settingsParam).toBe('tmdb-metadata-provider');
    });

    it('labels rows for humans by what they are', () => {
        const idx = buildProviderIndex([
            entry({ provider: 'tmdb-metadata-provider', label: 'TMDB', category: 'metadata' }),
            entry({ provider: 'discogs', label: 'Discogs', category: 'integration' }),
        ]);
        expect(idx.map((e) => e.category)).toEqual(['Metadata provider', 'Integration']);
        expect(idx[1]?.href).toBe('/admin/settings/plugins');
    });

    it('sends a playback provider to the playback settings page, without a modal param', () => {
        const idx = buildProviderIndex([
            entry({ provider: 'local-trickplay', label: 'local-trickplay', category: 'playback' }),
        ]);
        expect(idx[0]).toMatchObject({
            category: 'Playback provider',
            href: '/admin/settings/playback',
            settingsParam: undefined,
        });
    });

    it('injects the AcoustID alias onto the MusicBrainz entry', () => {
        const idx = buildProviderIndex([
            entry({
                provider: 'musicbrainz-metadata-provider',
                label: 'MusicBrainz',
                category: 'metadata',
            }),
        ]);
        const mb = idx.find((e) => e.id === 'musicbrainz-metadata-provider');
        expect(mb?.keywords.map((k) => k.toLowerCase())).toContain('acoustid');
    });
});

describe('buildRegistryIndex', () => {
    it('labels a background task as one and deep-links its settings tab', () => {
        const idx = buildRegistryIndex(
            [{ id: 'music-transcode-cache-reaper', label: 'Cache Reaper', hasSettings: true }],
            [],
        );
        expect(idx[0]?.category).toBe('Background task');
        expect(idx[0]?.href).toBe('/admin/tasks/music-transcode-cache-reaper?tab=settings');
        // A task is not an integration, and must not be findable as one.
        expect(idx[0]?.keywords).not.toContain('integration');
    });

    it('routes a feature plugin to the plugins-page settings modal', () => {
        const idx = buildRegistryIndex(
            [],
            [{ id: 'holiday', label: 'holiday', hasSettings: true }],
        );
        expect(idx[0]).toMatchObject({
            category: 'Feature plugin',
            href: '/admin/settings/plugins',
            settingsParam: 'holiday',
        });
    });

    it('skips ids already indexed as a provider row', () => {
        const idx = buildRegistryIndex(
            [{ id: 'dupe', label: 'Dupe', hasSettings: false }],
            [],
            new Set(['dupe']),
        );
        expect(idx).toEqual([]);
    });
});
