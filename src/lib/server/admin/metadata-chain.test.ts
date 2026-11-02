// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    config: {
        METADATA_PROVIDERS: 'tmdb,mdblist',
        PRIMARY_IMAGE_PROVIDER: '',
        PRIMARY_SEARCH_PROVIDER: '',
    },
    envLocked: false,
    saved: [] as Record<string, unknown>[],
}));

vi.mock('$lib/server/config.js', () => ({ config: h.config }));
vi.mock('$lib/server/config/index.js', () => ({
    isEnvOverridden: (key: string) => key === 'METADATA_PROVIDERS' && h.envLocked,
    saveConfig: vi.fn(async (updates: Record<string, string>) => {
        h.saved.push(updates);
        Object.assign(h.config, updates);
    }),
}));

import { getMetadataChainView, saveMetadataChain, MetadataChainError } from './metadata-chain';
import { getMetadataProviderChain } from '$lib/server/utils/provider-config.js';

beforeEach(() => {
    h.config.METADATA_PROVIDERS = 'tmdb,mdblist';
    h.envLocked = false;
    h.saved = [];
});

describe('metadata chain', () => {
    it('shows the runtime chain (METADATA_PROVIDERS) without the implicit aggregated entry', () => {
        expect(getMetadataChainView()).toEqual({
            chain: ['tmdb', 'mdblist'],
            addable: [],
            envLocked: false,
        });
    });

    it('saves a new order to METADATA_PROVIDERS and the runtime picks it up without a restart', async () => {
        expect(getMetadataProviderChain()).toEqual(['aggregated', 'tmdb', 'mdblist']);
        await saveMetadataChain(['mdblist', 'tmdb']);
        expect(h.saved).toEqual([{ METADATA_PROVIDERS: 'mdblist,tmdb' }]);
        expect(getMetadataProviderChain()).toEqual(['aggregated', 'mdblist', 'tmdb']);
    });

    it('offers a removed source for adding back', async () => {
        await saveMetadataChain(['tmdb']);
        expect(getMetadataChainView().addable).toEqual(['mdblist']);
    });

    it('rejects registry ids, duplicates, unknown names and an empty chain', async () => {
        for (const bad of [
            ['tmdb-metadata-provider'],
            ['tmdb', 'tmdb'],
            ['jellyfin'],
            [],
            ['aggregated'],
        ]) {
            await expect(saveMetadataChain(bad)).rejects.toBeInstanceOf(MetadataChainError);
        }
        expect(h.saved).toEqual([]);
    });

    it('keeps a non-editable source already in the chain reorderable', async () => {
        h.config.METADATA_PROVIDERS = 'tmdb,imdb,mdblist';
        await saveMetadataChain(['imdb', 'tmdb', 'mdblist']);
        expect(h.saved).toEqual([{ METADATA_PROVIDERS: 'imdb,tmdb,mdblist' }]);
    });

    it('refuses to save when the environment owns METADATA_PROVIDERS', async () => {
        h.envLocked = true;
        await expect(saveMetadataChain(['mdblist', 'tmdb'])).rejects.toMatchObject({
            kind: 'env-locked',
        });
        expect(getMetadataChainView().envLocked).toBe(true);
    });
});
