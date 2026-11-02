// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for resolveCatalogInternalId (catalog/resolve-id.ts).
 *
 * Covers the resolution forms in priority order:
 *   1. locals.resolvedIds.internalId  — middleware pre-resolved
 *   2. ?externalId=provider:id:type   — inline resolver call
 *   3. any non-empty params.id (dashed UUID, composite key, or a bare
 *      dashless Jellyfin UUID) — always routed through the resolver. A
 *      dashed UUID is NOT returned as-is: it may be a Jellyfin external id
 *      rather than the internal id, so it must go through the same
 *      internal-PK-first, Jellyfin-fallback check as every other form.
 *
 * The mediaIdResolver is mocked so tests are fast and dependency-free.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ---------------------------------------------------------------------------
// Mock the media-id-resolver BEFORE the module under test is imported.
// resolveCatalogInternalId lazily imports it, so vi.mock() here is enough.
// ---------------------------------------------------------------------------

const mockResolveAnyMediaId = vi.fn();

vi.mock('$lib/server/services/media-id-resolver.js', () => ({
    mediaIdResolver: {
        resolveAnyMediaId: mockResolveAnyMediaId,
    },
}));

// Import after mocking
import { resolveCatalogInternalId, isUuid } from './resolve-id.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_UUID = '12345678-1234-1234-1234-123456789012';
const ANOTHER_UUID = 'aaaabbbb-cccc-dddd-eeee-ffffffffffff';

function fakeEvent(opts: {
    params?: Record<string, string>;
    searchParams?: Record<string, string>;
    resolvedId?: string;
}): RequestEvent {
    const url = new URL('http://localhost/api/v1/series/x');
    for (const [k, v] of Object.entries(opts.searchParams ?? {})) {
        url.searchParams.set(k, v);
    }
    return {
        url,
        params: opts.params ?? {},
        locals: {
            resolvedIds: opts.resolvedId ? { internalId: opts.resolvedId } : undefined,
        },
    } as unknown as RequestEvent;
}

// ---------------------------------------------------------------------------
// isUuid
// ---------------------------------------------------------------------------

describe('isUuid()', () => {
    it('returns true for a standard dashed UUID', () => {
        expect(isUuid(VALID_UUID)).toBe(true);
    });

    it('is case-insensitive for UUID hex chars', () => {
        expect(isUuid(VALID_UUID.toUpperCase())).toBe(true);
    });

    it('returns false for a dashless (32-char hex) string', () => {
        expect(isUuid('12345678123412341234123456789012')).toBe(false);
    });

    it('returns false for a composite key', () => {
        expect(isUuid('tmdb:603:movie')).toBe(false);
    });

    it('returns false for an empty string', () => {
        expect(isUuid('')).toBe(false);
    });

    it('returns false for a random word', () => {
        expect(isUuid('invalid-id')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// resolveCatalogInternalId — form 1: middleware pre-resolved id
// ---------------------------------------------------------------------------

describe('resolveCatalogInternalId() — form 1: middleware resolvedIds.internalId', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns the middleware-provided id without calling the resolver', async () => {
        const event = fakeEvent({ resolvedId: VALID_UUID, params: { id: 'anything' } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBe(VALID_UUID);
        expect(mockResolveAnyMediaId).not.toHaveBeenCalled();
    });

    it('prefers middleware id over a UUID in params', async () => {
        const event = fakeEvent({ resolvedId: ANOTHER_UUID, params: { id: VALID_UUID } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBe(ANOTHER_UUID);
    });

    it('prefers middleware id over a ?externalId= param', async () => {
        const event = fakeEvent({
            resolvedId: ANOTHER_UUID,
            searchParams: { externalId: 'tmdb:603:movie' },
        });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBe(ANOTHER_UUID);
        expect(mockResolveAnyMediaId).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// resolveCatalogInternalId — form 2: ?externalId= inline resolution
// ---------------------------------------------------------------------------

describe('resolveCatalogInternalId() — form 2: ?externalId= inline resolution', () => {
    beforeEach(() => vi.clearAllMocks());

    it('resolves via ?externalId= when no middleware id is set', async () => {
        mockResolveAnyMediaId.mockResolvedValue({ internalId: VALID_UUID });
        const event = fakeEvent({ searchParams: { externalId: 'tmdb:603:movie' } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBe(VALID_UUID);
        expect(mockResolveAnyMediaId).toHaveBeenCalledWith('tmdb:603:movie');
    });

    it('returns null when the resolver returns no internalId for ?externalId=', async () => {
        mockResolveAnyMediaId.mockResolvedValue({ internalId: null });
        const event = fakeEvent({ searchParams: { externalId: 'tmdb:9999999:movie' } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBeNull();
    });

    it('returns null when the resolver throws for ?externalId=', async () => {
        mockResolveAnyMediaId.mockRejectedValue(new Error('DB error'));
        const event = fakeEvent({ searchParams: { externalId: 'tmdb:603:movie' } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// resolveCatalogInternalId — form 3: dashed UUID in params.id is routed
// through the resolver (NOT returned as-is — it may be a Jellyfin external
// id rather than the internal id).
// ---------------------------------------------------------------------------

describe('resolveCatalogInternalId() — form 3: dashed UUID in params.id', () => {
    beforeEach(() => vi.clearAllMocks());

    it('consults the resolver for a dashed UUID and returns its internalId', async () => {
        mockResolveAnyMediaId.mockResolvedValue({ internalId: VALID_UUID });
        const event = fakeEvent({ params: { id: VALID_UUID } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBe(VALID_UUID);
        expect(mockResolveAnyMediaId).toHaveBeenCalledWith(VALID_UUID);
    });

    it('accepts an upper-cased UUID and still consults the resolver', async () => {
        const upperUuid = VALID_UUID.toUpperCase();
        mockResolveAnyMediaId.mockResolvedValue({ internalId: VALID_UUID });
        const event = fakeEvent({ params: { id: upperUuid } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBe(VALID_UUID);
        expect(mockResolveAnyMediaId).toHaveBeenCalledWith(upperUuid);
    });

    it('regression: a dashed UUID that is a Jellyfin external id resolves to a DIFFERENT internal id (H1)', async () => {
        // VALID_UUID here plays the role of a Jellyfin external id — the
        // resolver looks it up, finds no internal-PK match, falls back to a
        // Jellyfin external_id lookup, and maps it to a distinct internal id.
        mockResolveAnyMediaId.mockResolvedValue({ internalId: ANOTHER_UUID, source: 'jellyfin' });
        const event = fakeEvent({ params: { id: VALID_UUID } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBe(ANOTHER_UUID);
        expect(result).not.toBe(VALID_UUID);
        expect(mockResolveAnyMediaId).toHaveBeenCalledWith(VALID_UUID);
    });

    it('returns null when the resolver finds no match for a dashed UUID', async () => {
        mockResolveAnyMediaId.mockResolvedValue({ internalId: null });
        const event = fakeEvent({ params: { id: VALID_UUID } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// resolveCatalogInternalId — form 4: composite key in params.id
// ---------------------------------------------------------------------------

describe('resolveCatalogInternalId() — form 4: composite key in params.id', () => {
    beforeEach(() => vi.clearAllMocks());

    it('calls the resolver for a composite key and returns the internalId', async () => {
        mockResolveAnyMediaId.mockResolvedValue({ internalId: VALID_UUID });
        const event = fakeEvent({ params: { id: 'tmdb:603:movie' } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBe(VALID_UUID);
        expect(mockResolveAnyMediaId).toHaveBeenCalledWith('tmdb:603:movie');
    });

    it('returns null when resolver finds nothing for the composite key', async () => {
        mockResolveAnyMediaId.mockResolvedValue({ internalId: null });
        const event = fakeEvent({ params: { id: 'tmdb:9999999:movie' } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBeNull();
    });

    it('returns null when resolver throws for the composite key', async () => {
        mockResolveAnyMediaId.mockRejectedValue(new Error('DB error'));
        const event = fakeEvent({ params: { id: 'tmdb:603:movie' } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBeNull();
    });

    it('returns null for an empty id with no middleware id or externalId', async () => {
        const event = fakeEvent({ params: { id: '' } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBeNull();
        expect(mockResolveAnyMediaId).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// resolveCatalogInternalId — form 5: any other non-empty id (fall-through)
// ---------------------------------------------------------------------------

describe('resolveCatalogInternalId() — form 5: fall-through for any other id', () => {
    beforeEach(() => vi.clearAllMocks());

    it('calls the resolver for a non-UUID, non-colon id (e.g. a bare Jellyfin id)', async () => {
        const bareJellyfinId = '003829b45cdb1f1b4d48b32f0601245c';
        mockResolveAnyMediaId.mockResolvedValue({ internalId: VALID_UUID });
        const event = fakeEvent({ params: { id: bareJellyfinId } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBe(VALID_UUID);
        expect(mockResolveAnyMediaId).toHaveBeenCalledWith(bareJellyfinId);
    });

    it('returns null when the resolver finds nothing for the fall-through id', async () => {
        mockResolveAnyMediaId.mockResolvedValue({ internalId: null });
        const event = fakeEvent({ params: { id: 'invalid-id' } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBeNull();
        expect(mockResolveAnyMediaId).toHaveBeenCalledWith('invalid-id');
    });

    it('returns null when the resolver throws for the fall-through id', async () => {
        mockResolveAnyMediaId.mockRejectedValue(new Error('DB error'));
        const event = fakeEvent({ params: { id: 'invalid-id' } });
        const result = await resolveCatalogInternalId(event);
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// resolveCatalogInternalId vs withIdResolution — convergence
//
// Both `resolveCatalogInternalId`'s inline fall-through and the
// `withIdResolution` middleware ultimately call the SAME
// `mediaIdResolver.resolveAnyMediaId(rawId)` with the SAME raw `params.id`,
// so for identical path-param input they must agree on the resolved
// `internalId`. This is a light, mock-based table check — a live-DB
// end-to-end convergence test is out of scope here (no local test DB).
//
// Note: `?externalId=provider:id:type` (resolve-id.ts form 2) has no
// `withIdResolution` equivalent — the middleware only reads `params.id` /
// `mediaId` / `itemId` / `seriesId`, never the query string. Recommendation:
// if a route needs `?externalId=` support behind `withIdResolution`, that
// support belongs in the middleware itself so both paths stay convergent by
// construction rather than by convention.
// ---------------------------------------------------------------------------

describe('resolveCatalogInternalId() vs withIdResolution() — agree on internalId for identical params.id', () => {
    beforeEach(() => vi.clearAllMocks());

    const TABLE: { label: string; rawId: string }[] = [
        { label: 'dashed UUID', rawId: VALID_UUID },
        { label: 'composite key', rawId: 'tmdb:603:movie' },
    ];

    it.each(TABLE)('agrees for a $label path param', async ({ rawId }) => {
        mockResolveAnyMediaId.mockResolvedValue({ internalId: ANOTHER_UUID });

        const defEvent = fakeEvent({ params: { id: rawId } });
        const defResult = await resolveCatalogInternalId(defEvent);

        const { withIdResolution } = await import('../../../middleware/id-resolution.js');
        const middlewareEvent = {
            url: new URL('http://localhost/api/test'),
            params: { id: rawId },
            locals: {},
        } as unknown as RequestEvent;
        const handler = vi.fn(async () => new Response('ok', { status: 200 }));
        await withIdResolution(handler)(middlewareEvent);
        const middlewareResult = middlewareEvent.locals.resolvedIds?.internalId;

        expect(defResult).toBe(middlewareResult);
        expect(mockResolveAnyMediaId).toHaveBeenCalledWith(rawId);
    });
});
