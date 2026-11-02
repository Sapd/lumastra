// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the discovery-catalog gate in storeDualEmbedding: a missing
 * catalog row is only created while isDiscoveryCatalogEnabled() is true.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Database } from '../database/connection';

const mocks = vi.hoisted(() => ({
    isDiscoveryCatalogEnabled: vi.fn(),
    resolveExternalIdToUuid: vi.fn(),
    getOrCreateByExternalId: vi.fn(),
    upsertMediaEmbedding: vi.fn(),
}));

vi.mock('../config.js', () => ({ isDiscoveryCatalogEnabled: mocks.isDiscoveryCatalogEnabled }));
vi.mock('../database/queries/media-lookup.queries.js', () => ({
    resolveExternalIdToUuid: mocks.resolveExternalIdToUuid,
}));
vi.mock('../services/catalog.service', () => ({
    createCatalogService: () => ({ getOrCreateByExternalId: mocks.getOrCreateByExternalId }),
}));
vi.mock('../database/queries/ai-sync.queries.js', () => ({
    upsertMediaEmbedding: mocks.upsertMediaEmbedding,
}));
vi.mock('../database/queries/media-upsert.js', () => ({
    upsertProviderMetadataUnlessLocked: vi.fn(),
}));
vi.mock('./openai', () => ({ generateMediaEmbedding: vi.fn() }));

import { storeDualEmbedding } from './dual-embedding-generator';

const db = { sqlClient: {} } as unknown as Database;
const embeddings = { discovery_embedding: [0.1, 0.2] };
const metadata = { title: 'Gate Movie', media_type: 'movie' as const };

describe('storeDualEmbedding discovery gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('creates the catalog row when the discovery catalog is enabled', async () => {
        mocks.isDiscoveryCatalogEnabled.mockReturnValue(true);
        mocks.getOrCreateByExternalId.mockResolvedValue({ id: 'new-id' });

        await storeDualEmbedding(db, 4242, embeddings, metadata);

        expect(mocks.getOrCreateByExternalId).toHaveBeenCalledTimes(1);
        expect(mocks.upsertMediaEmbedding).toHaveBeenCalledWith(
            expect.anything(),
            'new-id',
            expect.anything(),
            embeddings.discovery_embedding,
        );
    });

    it('skips entirely (no row, no embedding) when disabled and no row exists', async () => {
        mocks.isDiscoveryCatalogEnabled.mockReturnValue(false);
        mocks.resolveExternalIdToUuid.mockResolvedValue(null);

        await storeDualEmbedding(db, 4242, embeddings, metadata);

        expect(mocks.getOrCreateByExternalId).not.toHaveBeenCalled();
        expect(mocks.upsertMediaEmbedding).not.toHaveBeenCalled();
    });

    it('stores onto an existing row without creating one when disabled', async () => {
        mocks.isDiscoveryCatalogEnabled.mockReturnValue(false);
        mocks.resolveExternalIdToUuid.mockResolvedValue('existing-id');

        await storeDualEmbedding(db, 4242, embeddings, metadata);

        expect(mocks.getOrCreateByExternalId).not.toHaveBeenCalled();
        expect(mocks.upsertMediaEmbedding).toHaveBeenCalledWith(
            expect.anything(),
            'existing-id',
            expect.anything(),
            embeddings.discovery_embedding,
        );
    });
});
