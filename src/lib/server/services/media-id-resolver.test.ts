// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the MediaIdResolver DB-backed resolution branches.
 *
 * The existing `media-id-resolver.integration.test.ts` only exercises
 * `parseMediaId`. These tests mock the database layer (media-queries,
 * getDb, valkey) so the resolver's own branching logic — cache-key
 * scoping, canonical chain following, internal-vs-legacy-Jellyfin-id
 * resolution, and "unknown id is not found" — is covered without a live
 * database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveMediaIdByProvider, mockResolveJellyfinIdToMediaId, mockGetMediaExternalIds } =
    vi.hoisted(() => ({
        mockResolveMediaIdByProvider: vi.fn(),
        mockResolveJellyfinIdToMediaId: vi.fn(),
        mockGetMediaExternalIds: vi.fn(),
    }));

vi.mock('$lib/server/database/queries/media-queries.js', () => ({
    resolveMediaIdByProvider: mockResolveMediaIdByProvider,
    resolveJellyfinIdToMediaId: mockResolveJellyfinIdToMediaId,
    getMediaExternalIds: mockGetMediaExternalIds,
}));

// `sql` is only invoked directly (as a tagged template) by `followCanonicalChain`
// — every other DB access goes through the mocked media-queries functions above.
// A vi.fn() responds correctly to a tagged-template call since it's just a
// function invocation under the hood.
const mockSql = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockSql,
}));

// No Valkey (L2) in these tests — forces every resolution through the mocked
// DB layer so cache-slot behavior is driven purely by the L1 cache.
vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: () => undefined,
    subscribeToChannel: vi.fn(async () => undefined),
}));

import { mediaIdResolver } from './media-id-resolver.js';

// Each test below uses a UUID unique to itself — the resolver's L1 cache is a
// module-level singleton that persists across tests in this file, so reusing
// a UUID between tests would let an earlier test's cached result leak into a
// later one.
const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const _UUID_C = '33333333-3333-3333-3333-333333333333';
const UUID_D = '44444444-4444-4444-4444-444444444444';
const UUID_E = '55555555-5555-5555-5555-555555555555';
const UUID_F = '66666666-6666-6666-6666-666666666666';
const UUID_G = '77777777-7777-7777-7777-777777777777';
const UUID_H = '88888888-8888-8888-8888-888888888888';

function externalIdsRow(overrides: {
    internalId: string;
    mediaType?: 'movie' | 'tv';
    canonicalId?: string | null;
    externalIds?: Record<string, string>;
}): {
    internalId: string;
    status: string;
    mediaType: 'movie' | 'tv';
    canonicalId: string | null;
    externalIds: Record<string, string>;
} {
    return {
        internalId: overrides.internalId,
        status: 'active',
        mediaType: overrides.mediaType ?? 'movie',
        canonicalId: overrides.canonicalId ?? null,
        externalIds: overrides.externalIds ?? {},
    };
}

describe('MediaIdResolver — DB-backed branches', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSql.mockResolvedValue([]);
    });

    // -------------------------------------------------------------------
    // Distinct cache slots for tmdb:550:movie vs tmdb:550:tv
    // -------------------------------------------------------------------

    it('caches tmdb:550:movie and tmdb:550:tv under distinct slots (no cross-type collision)', async () => {
        mockResolveMediaIdByProvider.mockImplementation(
            async (_sql: unknown, _provider: string, _externalId: string, mediaType?: string) => {
                return mediaType === 'movie' ? UUID_A : UUID_B;
            },
        );
        mockGetMediaExternalIds.mockImplementation(async (_sql: unknown, id: string) => {
            if (id === UUID_A) return externalIdsRow({ internalId: UUID_A, mediaType: 'movie' });
            if (id === UUID_B) return externalIdsRow({ internalId: UUID_B, mediaType: 'tv' });
            return null;
        });

        const movieResult = await mediaIdResolver.resolveAnyMediaId('tmdb:550:movie');
        const tvResult = await mediaIdResolver.resolveAnyMediaId('tmdb:550:tv');

        expect(movieResult.internalId).toBe(UUID_A);
        expect(tvResult.internalId).toBe(UUID_B);
        expect(movieResult.internalId).not.toBe(tvResult.internalId);

        // Both distinct cache slots forced a DB call — the second lookup
        // was NOT served (incorrectly) from the first's cache entry.
        expect(mockResolveMediaIdByProvider).toHaveBeenCalledTimes(2);

        // Re-resolving the movie key should now hit L1 and NOT call the DB again.
        mockResolveMediaIdByProvider.mockClear();
        const movieAgain = await mediaIdResolver.resolveAnyMediaId('tmdb:550:movie');
        expect(movieAgain.internalId).toBe(UUID_A);
        expect(mockResolveMediaIdByProvider).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------
    // Canonical chain hop + re-fetch
    // -------------------------------------------------------------------

    it('follows a canonical_id hop and re-fetches external IDs for the final id', async () => {
        mockGetMediaExternalIds.mockImplementation(async (_sql: unknown, id: string) => {
            if (id === UUID_D) {
                return externalIdsRow({
                    internalId: UUID_D,
                    canonicalId: UUID_E,
                    mediaType: 'movie',
                });
            }
            if (id === UUID_E) {
                return externalIdsRow({
                    internalId: UUID_E,
                    canonicalId: null,
                    mediaType: 'movie',
                    externalIds: { tmdb: '999' },
                });
            }
            return null;
        });
        // followCanonicalChain: first hop UUID_D -> UUID_E, second hop UUID_E -> null (chain ends).
        mockSql
            .mockResolvedValueOnce([{ canonical_id: UUID_E }])
            .mockResolvedValueOnce([{ canonical_id: null }]);

        const result = await mediaIdResolver.resolveAnyMediaId(UUID_D);

        expect(result.wasCanonicalized).toBe(true);
        expect(result.internalId).toBe(UUID_E);
        expect(result.externalIds).toEqual({ tmdb: '999' });
        // Re-fetched external IDs for the canonical (final) id, not just the input.
        expect(mockGetMediaExternalIds).toHaveBeenCalledWith(mockSql, UUID_E);
    });

    // -------------------------------------------------------------------
    // resolveUuid: internal-hit vs Jellyfin-fork
    // -------------------------------------------------------------------

    it('resolves a genuine internal UUID directly (internal-hit, no Jellyfin fallback)', async () => {
        mockGetMediaExternalIds.mockImplementation(async (_sql: unknown, id: string) => {
            if (id === UUID_F) {
                return externalIdsRow({
                    internalId: UUID_F,
                    mediaType: 'movie',
                    externalIds: { jellyfin: 'abc123' },
                });
            }
            return null;
        });

        const result = await mediaIdResolver.resolveAnyMediaId(UUID_F);

        expect(result.internalId).toBe(UUID_F);
        expect(result.source).toBe('uuid');
        expect(result).not.toHaveProperty('jellyfinId');
        expect(mockResolveJellyfinIdToMediaId).not.toHaveBeenCalled();
    });

    it('falls back to a Jellyfin external-id lookup when the UUID is not an internal PK', async () => {
        // UUID_G is not in media_items directly — it's a Jellyfin external id
        // that maps to a DIFFERENT internal id (UUID_H).
        mockGetMediaExternalIds.mockImplementation(async (_sql: unknown, id: string) => {
            if (id === UUID_H) {
                return externalIdsRow({
                    internalId: UUID_H,
                    mediaType: 'movie',
                    externalIds: { jellyfin: UUID_G.replace(/-/g, '') },
                });
            }
            // Not found as an internal PK.
            return null;
        });
        mockResolveJellyfinIdToMediaId.mockResolvedValue(UUID_H);

        const result = await mediaIdResolver.resolveAnyMediaId(UUID_G);

        expect(result.source).toBe('jellyfin');
        expect(result.internalId).toBe(UUID_H);
        expect(result.internalId).not.toBe(UUID_G);
        expect(mockResolveJellyfinIdToMediaId).toHaveBeenCalled();
    });

    // -------------------------------------------------------------------
    // Unknown ids are not guessed to be Jellyfin items
    // -------------------------------------------------------------------

    it('an unknown UUID is "not found", never a best-effort Jellyfin id', async () => {
        // Neither an internal PK nor a Jellyfin external_id mapping exists
        // (a standalone install has no Jellyfin ids at all).
        mockGetMediaExternalIds.mockResolvedValue(null);
        mockResolveJellyfinIdToMediaId.mockResolvedValue(null);

        await expect(mediaIdResolver.resolveAnyMediaId(UUID_B)).rejects.toThrow(/Media not found/);
    });
});
