// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the discovery-catalog gate in
 * EmbeddingOperationsService.upsertMediaEmbedding: a missing catalog row is
 * only created while isDiscoveryCatalogEnabled() is true.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const mocks = vi.hoisted(() => ({
    isDiscoveryCatalogEnabled: vi.fn(),
    resolveExternalIdToUuid: vi.fn(),
    getOrCreateMinimalByTmdb: vi.fn(),
    withTx: vi.fn(),
}));

vi.mock('../config.js', () => ({ isDiscoveryCatalogEnabled: mocks.isDiscoveryCatalogEnabled }));
vi.mock('../database/queries/media-lookup.queries.js', () => ({
    resolveExternalIdToUuid: mocks.resolveExternalIdToUuid,
}));
vi.mock('$lib/server/database/with-tx.js', () => ({ withTx: mocks.withTx }));
vi.mock('./catalog.service.js', () => ({ CatalogService: vi.fn() }));
vi.mock('./media-lifecycle.service.js', () => ({ MediaLifecycleService: {} }));
vi.mock('../database/queries/embedding-operations.queries.js', () => ({}));
vi.mock('../database/queries/media-upsert.js', () => ({
    upsertProviderMetadataUnlessLocked: vi.fn(),
}));

import {
    EmbeddingOperationsService,
    DiscoveryCatalogDisabledError,
} from './embedding-operations.service.js';
import type { CatalogService } from './catalog.service.js';

const STOP = new Error('stop after the gate');

function makeService() {
    const catalog = {
        getOrCreateMinimalByTmdb: mocks.getOrCreateMinimalByTmdb,
    } as unknown as CatalogService;
    return new EmbeddingOperationsService({} as postgres.Sql, catalog, {
        skipLifecycleHooks: true,
    });
}

const input = { tmdb_id: 4242, title: 'Gate Movie', genres: [], overview: '' } as never;

describe('EmbeddingOperationsService.upsertMediaEmbedding discovery gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // The write transaction is out of scope: stop right after the gate.
        mocks.withTx.mockRejectedValue(STOP);
    });

    it('creates a minimal row when the discovery catalog is enabled', async () => {
        mocks.isDiscoveryCatalogEnabled.mockReturnValue(true);
        mocks.getOrCreateMinimalByTmdb.mockResolvedValue({ id: 'new-id', isNew: true });

        await expect(makeService().upsertMediaEmbedding(input, 'movie')).rejects.toBe(STOP);

        expect(mocks.getOrCreateMinimalByTmdb).toHaveBeenCalledTimes(1);
        expect(mocks.resolveExternalIdToUuid).not.toHaveBeenCalled();
    });

    it('creates nothing and throws DiscoveryCatalogDisabledError when disabled and no row exists', async () => {
        mocks.isDiscoveryCatalogEnabled.mockReturnValue(false);
        mocks.resolveExternalIdToUuid.mockResolvedValue(null);

        await expect(makeService().upsertMediaEmbedding(input, 'movie')).rejects.toBeInstanceOf(
            DiscoveryCatalogDisabledError,
        );

        expect(mocks.getOrCreateMinimalByTmdb).not.toHaveBeenCalled();
        expect(mocks.withTx).not.toHaveBeenCalled();
    });

    it('reuses an existing row without creating one when disabled', async () => {
        mocks.isDiscoveryCatalogEnabled.mockReturnValue(false);
        mocks.resolveExternalIdToUuid.mockResolvedValue('existing-id');

        await expect(makeService().upsertMediaEmbedding(input, 'movie')).rejects.toBe(STOP);

        expect(mocks.resolveExternalIdToUuid).toHaveBeenCalledWith(
            expect.anything(),
            '4242',
            'movie',
            'tmdb',
        );
        expect(mocks.getOrCreateMinimalByTmdb).not.toHaveBeenCalled();
        expect(mocks.withTx).toHaveBeenCalledTimes(1);
    });
});
