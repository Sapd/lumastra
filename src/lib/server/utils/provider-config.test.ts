// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    config: {
        METADATA_PROVIDERS: 'tmdb',
        PRIMARY_IMAGE_PROVIDER: '',
        PRIMARY_SEARCH_PROVIDER: '',
    } as Record<string, string>,
}));

vi.mock('../config.js', () => ({ config: h.config }));

import { getProviderConfig } from './provider-config.js';

describe('getProviderConfig — PRIMARY_IMAGE_PROVIDER / PRIMARY_SEARCH_PROVIDER', () => {
    beforeEach(() => {
        h.config.METADATA_PROVIDERS = 'tmdb';
        h.config.PRIMARY_IMAGE_PROVIDER = '';
        h.config.PRIMARY_SEARCH_PROVIDER = '';
    });

    it('accepts an API id provider', () => {
        h.config.PRIMARY_IMAGE_PROVIDER = 'tvdb';
        h.config.PRIMARY_SEARCH_PROVIDER = 'IMDB';
        const cfg = getProviderConfig();
        expect(cfg.primaryImageProvider).toBe('tvdb');
        expect(cfg.primarySearchProvider).toBe('imdb');
    });

    it('falls back to the primary external id for jellyfin or an unknown value', () => {
        h.config.PRIMARY_IMAGE_PROVIDER = 'jellyfin';
        h.config.PRIMARY_SEARCH_PROVIDER = 'tmbd';
        const cfg = getProviderConfig();
        expect(cfg.primaryImageProvider).toBe('tmdb');
        expect(cfg.primarySearchProvider).toBe('tmdb');
    });

    it('falls back to the primary external id when unset', () => {
        h.config.METADATA_PROVIDERS = 'imdb,tmdb';
        const cfg = getProviderConfig();
        expect(cfg.primaryImageProvider).toBe('imdb');
        expect(cfg.primarySearchProvider).toBe('imdb');
    });
});
