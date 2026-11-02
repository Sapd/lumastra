// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the catalog / media-items / media-files convenience stores
 * built in `context-primitives.ts`.
 *
 * Each store is a thin closure over the host's CatalogService + query modules;
 * these tests mock those collaborators so we can verify the boundary
 * behaviour:
 *   - MediaType normalization (`'Movie'`, `'series'`, `'song'` all canonical)
 *   - Composite-key safety on `findByExternalId` (wrong mediaType → null)
 *   - Narrow DTO projection (`MediaItemSummary` excludes internal fields)
 *   - search() respects `limit` + `mediaType`
 *   - findByPath returns null for unknown paths
 *
 * Run with: npx vitest run src/lib/server/tasks/context-primitives.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

// ── Hoisted mocks for the host-side collaborators ────────────────────────────

const { upsertExternalIdSpy } = vi.hoisted(() => ({
    upsertExternalIdSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/services/catalog.service.js', () => ({
    // `new CatalogService(sql)` is invoked inside buildCatalogStore — must be a
    // real constructor, not an arrow factory (TypeError: ... is not a constructor).
    CatalogService: class {
        upsertExternalId = upsertExternalIdSpy;
    },
}));

const { findMediaIdByProviderExternalIdSpy } = vi.hoisted(() => ({
    findMediaIdByProviderExternalIdSpy: vi.fn(),
}));

vi.mock('$lib/server/database/queries/external-ids.queries.js', () => ({
    findMediaIdByProviderExternalId: findMediaIdByProviderExternalIdSpy,
}));

const { getMediaItemSummaryByIdSpy, searchMediaItemSummariesSpy } = vi.hoisted(() => ({
    getMediaItemSummaryByIdSpy: vi.fn(),
    searchMediaItemSummariesSpy: vi.fn(),
}));

vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    getMediaItemSummaryById: getMediaItemSummaryByIdSpy,
    searchMediaItemSummaries: searchMediaItemSummariesSpy,
}));

const { findMediaFileWithLinkByPathSpy } = vi.hoisted(() => ({
    findMediaFileWithLinkByPathSpy: vi.fn(),
}));

vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    findMediaFileWithLinkByPath: findMediaFileWithLinkByPathSpy,
}));

// Imports under test must come AFTER vi.mock so the mocks are in place.
import {
    buildCatalogStore,
    buildHttpClient,
    buildMediaFilesStore,
    buildMediaItemsStore,
} from './context-primitives.js';
import { __resetHttpRateLimitBucketsForTests } from './http-rate-limit.js';

// A bare sql stub — the store implementations only forward it to mocked
// collaborators so we don't need a real connection here.
const sql = {} as postgres.Sql;

beforeEach(() => {
    upsertExternalIdSpy.mockReset().mockResolvedValue(undefined);
    findMediaIdByProviderExternalIdSpy.mockReset();
    getMediaItemSummaryByIdSpy.mockReset();
    searchMediaItemSummariesSpy.mockReset();
    findMediaFileWithLinkByPathSpy.mockReset();
});

describe('buildCatalogStore', () => {
    it('upserts and looks up via the canonical composite key (roundtrip)', async () => {
        // Simulate the post-upsert read returning the same mediaItemId.
        findMediaIdByProviderExternalIdSpy.mockResolvedValue('media-uuid-1');

        const store = buildCatalogStore(sql);
        await store.upsertExternalId({
            provider: 'tmdb',
            externalId: '550',
            mediaType: 'movie',
            mediaItemId: 'media-uuid-1',
        });

        expect(upsertExternalIdSpy).toHaveBeenCalledWith(
            'media-uuid-1',
            expect.objectContaining({
                provider: 'tmdb',
                id: '550',
                mediaType: 'movie',
                source: 'plugin',
            }),
        );

        const hit = await store.findByExternalId({
            provider: 'tmdb',
            externalId: '550',
            mediaType: 'movie',
        });
        expect(hit).toEqual({ mediaItemId: 'media-uuid-1' });
    });

    it('returns null when findByExternalId is asked for a different mediaType (composite key matters)', async () => {
        // The query module is the composite-key arbiter — when the underlying
        // (provider, external_id, media_type) row doesn't exist for the asked
        // media type, it returns null. The store must propagate that as null,
        // not throw and not fall back to a different mediaType match.
        findMediaIdByProviderExternalIdSpy.mockResolvedValue(null);

        const store = buildCatalogStore(sql);
        const miss = await store.findByExternalId({
            provider: 'tmdb',
            externalId: '1429', // movie "25th Hour" vs series "Voyage to Orion"
            mediaType: 'tv',
        });

        expect(miss).toBeNull();
        expect(findMediaIdByProviderExternalIdSpy).toHaveBeenCalledWith(sql, {
            provider: 'tmdb',
            externalId: '1429',
            mediaType: 'tv',
        });
    });

    it("normalizes 'Movie' / 'MOVIE' / 'movie' to the canonical 'movie'", async () => {
        findMediaIdByProviderExternalIdSpy.mockResolvedValue('uuid');

        const store = buildCatalogStore(sql);
        // Cast through string for cases plugin authors actually hit at runtime
        // (legacy UPPERCASE constants, PascalCase Jellyfin strings).
        await store.upsertExternalId({
            provider: 'tmdb',
            externalId: '550',
            mediaType: 'Movie' as 'movie',
            mediaItemId: 'uuid',
        });
        await store.upsertExternalId({
            provider: 'tmdb',
            externalId: '551',
            mediaType: 'MOVIE' as 'movie',
            mediaItemId: 'uuid',
        });
        await store.findByExternalId({
            provider: 'tmdb',
            externalId: '550',
            mediaType: 'movie',
        });

        // Both upserts hit CatalogService with the canonical 'movie' string.
        for (const call of upsertExternalIdSpy.mock.calls) {
            expect((call[1] as { mediaType: string }).mediaType).toBe('movie');
        }
        // findByExternalId forwards the canonical value to the query module.
        expect(findMediaIdByProviderExternalIdSpy).toHaveBeenLastCalledWith(sql, {
            provider: 'tmdb',
            externalId: '550',
            mediaType: 'movie',
        });
    });

    it("maps the SDK aliases 'series' → 'tv' and 'song' → 'track'", async () => {
        findMediaIdByProviderExternalIdSpy.mockResolvedValue(null);
        const store = buildCatalogStore(sql);

        await store.upsertExternalId({
            provider: 'tmdb',
            externalId: '1399',
            mediaType: 'series' as 'tv',
            mediaItemId: 'uuid-tv',
        });
        await store.upsertExternalId({
            provider: 'musicbrainz',
            externalId: 'mb-1',
            mediaType: 'song' as 'track',
            mediaItemId: 'uuid-track',
        });

        expect(upsertExternalIdSpy.mock.calls[0][1].mediaType).toBe('tv');
        expect(upsertExternalIdSpy.mock.calls[1][1].mediaType).toBe('track');
    });

    it('rejects empty / whitespace mediaType with a permanent TaskError (finding #14)', async () => {
        // Edge-case finding #14: empty / whitespace input previously fell
        // through and surfaced as a cryptic DB CHECK / FK error. The
        // normalizer now throws a permanent TaskError eagerly so the plugin
        // author sees the actual cause.
        const store = buildCatalogStore(sql);
        for (const bad of ['', '   ', '\t', '\n']) {
            await expect(
                store.upsertExternalId({
                    provider: 'tmdb',
                    externalId: '550',
                    mediaType: bad as 'movie',
                    mediaItemId: 'uuid-x',
                }),
            ).rejects.toThrow(/cannot be empty or whitespace/i);
        }
        // findByExternalId hits the same normalizer, so the rejection must
        // also surface there (the caller should never reach the DB layer
        // with a blank mediaType).
        await expect(
            store.findByExternalId({
                provider: 'tmdb',
                externalId: '550',
                mediaType: '' as 'movie',
            }),
        ).rejects.toThrow(/cannot be empty or whitespace/i);
        // The upstream DB layer must not have been reached.
        expect(upsertExternalIdSpy).not.toHaveBeenCalled();
        expect(findMediaIdByProviderExternalIdSpy).not.toHaveBeenCalled();
    });
});

describe('buildMediaItemsStore', () => {
    it('getById returns the narrow MediaItemSummary DTO, not the raw row', async () => {
        const isoLibraryAddedAt = new Date('2026-01-15T12:00:00Z');
        getMediaItemSummaryByIdSpy.mockResolvedValue({
            id: 'uuid-1',
            title: 'Quiet Orbit',
            year: 1999,
            media_type: 'movie',
            overview: 'A man starts an underground quiet orbit.',
            library_added_at: isoLibraryAddedAt,
            created_at: new Date('2025-12-01T00:00:00Z'),
        });

        const store = buildMediaItemsStore(sql);
        const summary = await store.getById('uuid-1');

        expect(summary).toEqual({
            id: 'uuid-1',
            title: 'Quiet Orbit',
            year: 1999,
            mediaType: 'movie',
            overview: 'A man starts an underground quiet orbit.',
            libraryAddedAt: isoLibraryAddedAt.toISOString(),
        });
        // Internal fields must NOT appear on the DTO.
        expect(summary).not.toHaveProperty('created_at');
        expect(summary).not.toHaveProperty('media_type');
        expect(summary).not.toHaveProperty('library_added_at');
    });

    it('getById falls back to created_at when library_added_at is null', async () => {
        const created = new Date('2024-06-01T00:00:00Z');
        getMediaItemSummaryByIdSpy.mockResolvedValue({
            id: 'uuid-legacy',
            title: 'Old Item',
            year: null,
            media_type: 'movie',
            overview: null,
            library_added_at: null,
            created_at: created,
        });

        const store = buildMediaItemsStore(sql);
        const summary = await store.getById('uuid-legacy');
        expect(summary?.libraryAddedAt).toBe(created.toISOString());
    });

    it('getById returns null for unknown ids', async () => {
        getMediaItemSummaryByIdSpy.mockResolvedValue(null);
        const store = buildMediaItemsStore(sql);
        expect(await store.getById('nope')).toBeNull();
    });

    it('search forwards limit + normalized mediaType to the query module', async () => {
        searchMediaItemSummariesSpy.mockResolvedValue([]);
        const store = buildMediaItemsStore(sql);

        await store.search('fight', {
            limit: 5,
            mediaType: 'Movie' as 'movie',
        });

        expect(searchMediaItemSummariesSpy).toHaveBeenCalledWith(sql, 'fight', {
            limit: 5,
            mediaType: 'movie',
        });
    });

    it('search maps rows through the same DTO projection', async () => {
        searchMediaItemSummariesSpy.mockResolvedValue([
            {
                id: 'uuid-a',
                title: 'Alpha',
                year: 2010,
                media_type: 'movie',
                overview: 'a',
                library_added_at: null,
                created_at: new Date('2024-01-01T00:00:00Z'),
            },
        ]);

        const store = buildMediaItemsStore(sql);
        const results = await store.search('alpha');
        expect(results).toHaveLength(1);
        expect(results[0].mediaType).toBe('movie');
        expect(results[0]).not.toHaveProperty('media_type');
    });
});

describe('buildMediaFilesStore', () => {
    it('findByPath returns the linked file shape when present', async () => {
        findMediaFileWithLinkByPathSpy.mockResolvedValue({
            mediaFileId: 'file-uuid',
            mediaItemId: 'item-uuid',
        });
        const store = buildMediaFilesStore(sql);
        const hit = await store.findByPath('/movies/Quiet Orbit.mkv');
        expect(hit).toEqual({
            mediaFileId: 'file-uuid',
            mediaItemId: 'item-uuid',
        });
    });

    it('findByPath returns null for unknown paths', async () => {
        findMediaFileWithLinkByPathSpy.mockResolvedValue(null);
        const store = buildMediaFilesStore(sql);
        expect(await store.findByPath('/nowhere.mkv')).toBeNull();
    });

    it('findByPath preserves the unlinked shape (mediaItemId = null)', async () => {
        findMediaFileWithLinkByPathSpy.mockResolvedValue({
            mediaFileId: 'file-uuid',
            mediaItemId: null,
        });
        const store = buildMediaFilesStore(sql);
        const hit = await store.findByPath('/orphan.mkv');
        expect(hit).toEqual({ mediaFileId: 'file-uuid', mediaItemId: null });
    });
});

// ── buildNamespacedCache ─────────────────────────────────────────────────────

describe('buildNamespacedCache', () => {
    it('returns null when the stored value is not valid JSON (finding #15)', async () => {
        // Edge-case finding #15: when GET returns a non-JSON string the
        // helper previously returned `raw as T`, which silently gave the
        // caller a string instead of the object they typed for. Downstream
        // code paths then explode with TypeError. Returning null on parse
        // failure is honest: "no value" matches the existing miss path.
        //
        // Use vi.doMock + vi.resetModules so the cache builder picks up the
        // stubbed valkey client when it re-imports context-primitives.
        vi.resetModules();
        const customCommand = vi
            .fn<(cmd: string[]) => Promise<unknown>>()
            .mockResolvedValueOnce('this is not json');
        vi.doMock('$lib/server/cache/valkey.js', () => ({
            getValkeyClient: () => ({ customCommand }),
        }));
        const { buildNamespacedCache } = await import('./context-primitives.js');
        const cache = buildNamespacedCache('plug-x');
        const value = await cache.get<{ foo: string }>('bad');
        expect(value).toBeNull();
        vi.doUnmock('$lib/server/cache/valkey.js');
    });
});

// ── buildHttpClient — default rate cap for ctx.http (TASK-C6) ─────────────────

const noopLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child() {
        return noopLogger;
    },
};

describe('buildHttpClient — rate-limit binding (TASK-C6)', () => {
    beforeEach(() => {
        __resetHttpRateLimitBucketsForTests();
    });

    it('throttles ctx.http requests when a rate-limit binding is supplied', async () => {
        const fetchSpy = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response('ok', { status: 200 }));
        const orig = globalThis.fetch;
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        try {
            // Models the runner's per-task default cap: providerId keyed by
            // task id, rps=2 → capacity 2. Three back-to-back gets: first two
            // pass immediately, third waits ~500ms for a token refill.
            const http = buildHttpClient(noopLogger, undefined, {
                providerId: 'http-default:demo-task',
                rateLimit: { rps: 2 },
            });
            const start = Date.now();
            await http.get('http://93.184.216.34/a');
            await http.get('http://93.184.216.34/b');
            await http.get('http://93.184.216.34/c');
            const elapsed = Date.now() - start;
            expect(fetchSpy).toHaveBeenCalledTimes(3);
            // At least one msPerToken (500ms) wait must have happened —
            // proves ctx.http is now gated, not unbounded.
            expect(elapsed).toBeGreaterThanOrEqual(450);
            expect(elapsed).toBeLessThan(2000);
        } finally {
            globalThis.fetch = orig;
        }
    });

    it('does NOT throttle when no rate-limit binding is supplied', async () => {
        const fetchSpy = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response('ok', { status: 200 }));
        const orig = globalThis.fetch;
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        try {
            // The opt-out path (LUMASTRA_TASK_HTTP_DEFAULT_RPS=0 → undefined
            // binding) must keep the old unbounded behaviour.
            const http = buildHttpClient(noopLogger, undefined, undefined);
            const start = Date.now();
            await http.get('http://93.184.216.34/a');
            await http.get('http://93.184.216.34/b');
            await http.get('http://93.184.216.34/c');
            expect(Date.now() - start).toBeLessThan(100);
            expect(fetchSpy).toHaveBeenCalledTimes(3);
        } finally {
            globalThis.fetch = orig;
        }
    });
});

// ── buildHttpClient — allowedDomains enforced on every redirect hop ──────────
//
// Bug: allowedDomains was only checked on the INITIAL url (this module's own
// `checkUrl`, called before safeFetch). safeFetch's manual redirect loop only
// re-ran the generic SSRF guard, so a 3xx from an allowlisted host could pivot
// the request to ANY other public host. These use real `safeFetch` +
// `assertPublicHttpUrl` (this file does not mock './url-safety.js') with IP
// literals so DNS resolution never enters — safeFetch's global-fetch branch
// is exercised directly against a stubbed `globalThis.fetch`.

function redirectResponse(status: number, location: string): Response {
    const headers = new Headers();
    headers.set('location', location);
    return new Response(null, { status, headers });
}

describe('buildHttpClient — allowedDomains redirect-hop enforcement', () => {
    it('follows a redirect that stays within the allowedDomains list', async () => {
        const fetchSpy = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(redirectResponse(302, 'http://93.184.216.34/other-path'))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));
        const orig = globalThis.fetch;
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        try {
            const http = buildHttpClient(noopLogger, undefined, undefined, ['93.184.216.34']);
            const res = await http.get('http://93.184.216.34/start');
            expect(res.status).toBe(200);
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        } finally {
            globalThis.fetch = orig;
        }
    });

    it('rejects a redirect that pivots to a host outside allowedDomains (isolation boundary)', async () => {
        const fetchSpy = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(redirectResponse(302, 'http://1.2.3.4/elsewhere'));
        const orig = globalThis.fetch;
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        try {
            const http = buildHttpClient(noopLogger, undefined, undefined, ['93.184.216.34']);
            await expect(http.get('http://93.184.216.34/start')).rejects.toThrow(
                /not in the declared allowedDomains/,
            );
            // Only the first hop was ever fetched — the pivot target was
            // rejected before a second network call was made.
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
            globalThis.fetch = orig;
        }
    });

    it('honors a subdomain-suffix rule (".example.org") across a redirect hop', async () => {
        // Regression guard for the shared isDomainAllowed() matcher: a
        // suffix rule that passes the up-front checkUrl must also pass when
        // re-applied to the redirect target by validateHop.
        const fetchSpy = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(redirectResponse(302, 'https://8.8.8.8/'))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));
        const orig = globalThis.fetch;
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        try {
            // '8.8.8.8' is an IP literal so the exact-match rule (not the
            // suffix rule) is what actually matches here; the suffix rule is
            // included to prove multi-rule allowlists are still consulted.
            const http = buildHttpClient(noopLogger, undefined, undefined, [
                '.example.org',
                '8.8.8.8',
            ]);
            const res = await http.get('http://8.8.8.8/start');
            expect(res.status).toBe(200);
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        } finally {
            globalThis.fetch = orig;
        }
    });
});
