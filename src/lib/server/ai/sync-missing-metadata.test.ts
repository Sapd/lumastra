// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for the structured-cast forward fix in `syncMissingMetadata`.
 *
 * Root cause under test: `parseActorsForDetail` only emits tmdbId +
 * profileUrl for cast members when `provider_metadata.metadata.cast`
 * (structured) exists. Before this fix, `syncMissingMetadata` only ever
 * wrote the FLAT `actors` name list from a provider detail — even though
 * the detail response (`detail.cast`) carries `personId`/`character` per
 * member — so structured cast was never persisted here.
 *
 * These tests assert the OUTCOME: whenever a provider detail with cast is
 * obtained (provider-only branch, and the Jellyfin branch's supplemental
 * provider call), `upsertProviderMetadataUnlessLocked` is called with the
 * reduced structured cast + a `cast_synced_at` marker, targeting the PRIMARY
 * PROVIDER's row (not 'aggregated' — a direct write to 'aggregated' would be
 * silently dropped by the next `batchAggregateMetadata` re-aggregation pass,
 * which sources fields from the provider rows, not from 'aggregated'
 * itself).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type * as MediaUpsert from '../database/queries/media-upsert.js';
import type * as MetadataAggregationQueries from '../database/queries/metadata-aggregation.queries.js';
import type { ProviderDetailResult } from '@sapd/lumastra-plugin-sdk';

vi.mock('../config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../config.js')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get(target, key, receiver) {
                if (key === 'JELLYFINURL') return 'http://jf';
                if (key === 'JELLYFINAPIKEY') return 'metadata-key';
                return Reflect.get(target, key, receiver);
            },
        }),
    };
});

// ---------------------------------------------------------------------------
// media-upsert mock — spy on the writes the forward fix must perform.
// vi.hoisted per this repo's verified convention (vi.mock is hoisted above
// imports, so hoisted state can't reference an imported value).
// ---------------------------------------------------------------------------

const mediaUpsert = vi.hoisted(() => ({
    upsertProviderMetadataUnlessLocked:
        vi.fn<typeof MediaUpsert.upsertProviderMetadataUnlessLocked>(),
}));
vi.mock('../database/queries/media-upsert.js', () => mediaUpsert);

const metadataAggregationQueries = vi.hoisted(() => ({
    keywordNamesToSlugs: vi.fn<typeof MetadataAggregationQueries.keywordNamesToSlugs>(() => []),
    batchAggregateMetadata: vi
        .fn<typeof MetadataAggregationQueries.batchAggregateMetadata>()
        .mockResolvedValue({ updated: 1, skipped: 0, errors: 0 }),
}));
vi.mock('../database/queries/metadata-aggregation.queries.js', () => metadataAggregationQueries);

const pluginContext = vi.hoisted(() => ({
    invokeProviderDetail: vi.fn<() => Promise<ProviderDetailResult | null>>(),
}));
vi.mock('../tasks/plugin-context.js', () => pluginContext);

// The Jellyfin leg's gate and transport. Default: Jellyfin out of the picture,
// which is what every test above this file's Jellyfin block assumes.
const jellyfinGate = vi.hoisted(() => ({
    callable: false,
    recordJellyfinTransportFailure: vi.fn(),
    recordJellyfinTransportSuccess: vi.fn(),
}));
vi.mock('../jellyfin/runtime-gate.js', () => ({
    JELLYFIN_DIRECT_FETCH_TIMEOUT_MS: 2_500,
    canCallJellyfin: () => jellyfinGate.callable,
    recordJellyfinTransportFailure: jellyfinGate.recordJellyfinTransportFailure,
    recordJellyfinTransportSuccess: jellyfinGate.recordJellyfinTransportSuccess,
}));
const fetchUtils = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }));
vi.mock('../utils/fetch-utils.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/fetch-utils.js')>()),
    fetchWithTimeout: fetchUtils.fetchWithTimeout,
}));

// ---------------------------------------------------------------------------
// Fake `postgres.Sql` handle — recognizes the two candidate queries by a
// literal marker in their SQL text (each query's `'jellyfin' as source` /
// `'provider' as source` column alias) and returns queued rows. Every other
// call (condition fragments, the lateral-join builder's `sql.unsafe`, the
// no-op stage-gate fragment) is never awaited on its own — it is only
// embedded as a template value inside the two candidate queries — so an
// unused resolved Promise is a safe stand-in.
// ---------------------------------------------------------------------------

interface FakeSqlRows {
    withJellyfin: unknown[];
    withoutJellyfin: unknown[];
}

function makeFakeSql(rows: FakeSqlRows): postgres.Sql {
    const tag = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
        const text = strings.join('|');
        if (text.includes("'jellyfin' as source")) {
            return Promise.resolve(rows.withJellyfin);
        }
        if (text.includes("'provider' as source")) {
            return Promise.resolve(rows.withoutJellyfin);
        }
        return Promise.resolve([]);
    }) as unknown as postgres.Sql & {
        unsafe: (text: string) => unknown;
        json: (v: unknown) => unknown;
    };
    (tag as unknown as { unsafe: unknown }).unsafe = () => Promise.resolve([]);
    (tag as unknown as { json: unknown }).json = (v: unknown) => v;
    return tag;
}

function makeDetail(overrides: Partial<ProviderDetailResult> = {}): ProviderDetailResult {
    return {
        cast: [{ name: 'Jules Fenwick', character: 'Arthur Fleck', personId: '1234', order: 0 }],
        directors: [],
        producers: [],
        writers: [],
        keywordNames: [],
        keywordSlugs: [],
        rawKeywordIds: [],
        networks: [],
        imdbId: undefined,
        ...overrides,
    } as unknown as ProviderDetailResult;
}

describe('syncMissingMetadata — structured cast forward fix', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        metadataAggregationQueries.batchAggregateMetadata.mockResolvedValue({
            updated: 1,
            skipped: 0,
            errors: 0,
        });
    });

    it('persists structured cast to the PRIMARY PROVIDER row for a provider-sourced item', async () => {
        pluginContext.invokeProviderDetail.mockResolvedValue(makeDetail());

        const mediaId = 'aaaaaaaa-0000-0000-0000-000000000001';
        const sql = makeFakeSql({
            withJellyfin: [],
            withoutJellyfin: [
                {
                    media_id: mediaId,
                    external_id: '620',
                    imdb_id: null,
                    title: 'Jasper',
                    media_type: 'movie',
                    jellyfin_id: null,
                    source: 'provider',
                },
            ],
        });

        const { syncMissingMetadata } = await import('./sync-missing-metadata.js');
        const result = await syncMissingMetadata({ sql });

        expect(result.success).toBe(true);
        // The same shared writer also carries the (unrelated) keywords_synced_at
        // marker write to the 'aggregated' row later in this pass — filter to the
        // non-'aggregated' call to isolate the structured-cast write under test.
        const castCalls = mediaUpsert.upsertProviderMetadataUnlessLocked.mock.calls.filter(
            ([, , provider]) => provider !== 'aggregated',
        );
        expect(castCalls).toHaveLength(1);
        const [, calledMediaId, calledProvider, calledMetadata] = castCalls[0];
        expect(calledMediaId).toBe(mediaId);
        // Must NOT be 'aggregated' — that row is rebuilt from provider rows by
        // batchAggregateMetadata and would silently drop a direct write.
        expect(calledProvider).not.toBe('aggregated');
        expect(calledMetadata).toMatchObject({
            cast: [{ name: 'Jules Fenwick', character: 'Arthur Fleck', person_id: '1234' }],
        });
        expect(typeof (calledMetadata as { cast_synced_at?: unknown }).cast_synced_at).toBe(
            'string',
        );

        // The touched item must feed post-sync re-aggregation, or the write
        // stays invisible behind the stale 'aggregated' row.
        expect(metadataAggregationQueries.batchAggregateMetadata).toHaveBeenCalledWith(sql, [
            mediaId,
        ]);
    });

    it('does not call upsertProviderMetadataUnlessLocked when the provider detail has no cast', async () => {
        pluginContext.invokeProviderDetail.mockResolvedValue(makeDetail({ cast: [] }));

        const mediaId = 'aaaaaaaa-0000-0000-0000-000000000002';
        const sql = makeFakeSql({
            withJellyfin: [],
            withoutJellyfin: [
                {
                    media_id: mediaId,
                    external_id: '99999',
                    imdb_id: null,
                    title: 'No Cast Movie',
                    media_type: 'movie',
                    jellyfin_id: null,
                    source: 'provider',
                },
            ],
        });

        const { syncMissingMetadata } = await import('./sync-missing-metadata.js');
        await syncMissingMetadata({ sql });

        // No structured-cast write — but the keywords_synced_at marker write to
        // 'aggregated' still fires independently (see the test above), so assert
        // on the non-'aggregated' calls specifically rather than "never called".
        const castCalls = mediaUpsert.upsertProviderMetadataUnlessLocked.mock.calls.filter(
            ([, , provider]) => provider !== 'aggregated',
        );
        expect(castCalls).toHaveLength(0);
    });
});

describe('syncMissingMetadata — provider id not found (404)', () => {
    const mediaId = 'aaaaaaaa-0000-0000-0000-000000000003';
    const row = {
        media_id: mediaId,
        external_id: '1754069',
        imdb_id: null,
        title: 'Deleted Upstream',
        media_type: 'movie',
        jellyfin_id: null,
        source: 'provider',
    };
    const sqlWithRow = (): postgres.Sql =>
        makeFakeSql({ withJellyfin: [], withoutJellyfin: [row] });

    beforeEach(() => {
        vi.clearAllMocks();
        metadataAggregationQueries.batchAggregateMetadata.mockResolvedValue({
            updated: 0,
            skipped: 0,
            errors: 0,
        });
    });

    it('404 → onItemNotFound fires, no error recorded, item not completed', async () => {
        pluginContext.invokeProviderDetail.mockRejectedValue(
            new Error('TMDB API request failed: 404 Not Found — /movie/1754069'),
        );
        const onItemSuccess = vi.fn().mockResolvedValue(undefined);
        const onItemNotFound = vi.fn().mockResolvedValue(undefined);

        const { syncMissingMetadata } = await import('./sync-missing-metadata.js');
        const result = await syncMissingMetadata({
            sql: sqlWithRow(),
            onItemSuccess,
            onItemNotFound,
        });

        expect(onItemNotFound).toHaveBeenCalledExactlyOnceWith(mediaId);
        expect(onItemSuccess).not.toHaveBeenCalled();
        expect(result.errors).toEqual([]);
    });

    it('500 → unchanged: error recorded, neither callback fires', async () => {
        pluginContext.invokeProviderDetail.mockRejectedValue(
            new Error('TMDB API request failed: 500 Internal Server Error — /movie/1754069'),
        );
        const onItemSuccess = vi.fn().mockResolvedValue(undefined);
        const onItemNotFound = vi.fn().mockResolvedValue(undefined);

        const { syncMissingMetadata } = await import('./sync-missing-metadata.js');
        const result = await syncMissingMetadata({
            sql: sqlWithRow(),
            onItemSuccess,
            onItemNotFound,
        });

        expect(onItemNotFound).not.toHaveBeenCalled();
        expect(onItemSuccess).not.toHaveBeenCalled();
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('Provider recovery failed for Deleted Upstream');
    });

    it('404 with a failing onItemNotFound falls back to the recorded error', async () => {
        pluginContext.invokeProviderDetail.mockRejectedValue(
            new Error('TMDB API request failed: 404 Not Found — /movie/1754069'),
        );
        const onItemNotFound = vi.fn().mockRejectedValue(new Error('db down'));

        const { syncMissingMetadata } = await import('./sync-missing-metadata.js');
        const result = await syncMissingMetadata({
            sql: sqlWithRow(),
            onItemSuccess: vi.fn().mockResolvedValue(undefined),
            onItemNotFound,
        });

        expect(result.errors).toHaveLength(1);
    });
});

describe('syncMissingMetadata — Jellyfin leg gate (stopped / removed Jellyfin)', () => {
    const mediaId = 'aaaaaaaa-0000-0000-0000-000000000009';
    const jellyfinRow = {
        media_id: mediaId,
        external_id: '620',
        imdb_id: null,
        title: 'Jasper',
        media_type: 'movie',
        jellyfin_id: 'f'.repeat(32),
        source: 'jellyfin',
    };
    const sqlWithJellyfinRow = (): postgres.Sql =>
        makeFakeSql({ withJellyfin: [jellyfinRow], withoutJellyfin: [] });

    beforeEach(() => {
        vi.clearAllMocks();
        jellyfinGate.callable = false;
        pluginContext.invokeProviderDetail.mockResolvedValue(makeDetail());
        metadataAggregationQueries.batchAggregateMetadata.mockResolvedValue({
            updated: 1,
            skipped: 0,
            errors: 0,
        });
    });

    it('sync off / Jellyfin unavailable: no Jellyfin request, the item goes through the provider, task succeeds', async () => {
        const onItemSuccess = vi.fn().mockResolvedValue(undefined);

        const { syncMissingMetadata } = await import('./sync-missing-metadata.js');
        const result = await syncMissingMetadata({ sql: sqlWithJellyfinRow(), onItemSuccess });

        expect(fetchUtils.fetchWithTimeout).not.toHaveBeenCalled();
        expect(pluginContext.invokeProviderDetail).toHaveBeenCalledTimes(1);
        expect(onItemSuccess).toHaveBeenCalledExactlyOnceWith(mediaId);
        expect(result.success).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('gate open but /Users times out: task still succeeds, failure fed to the breaker, provider fallback', async () => {
        jellyfinGate.callable = true;
        fetchUtils.fetchWithTimeout.mockRejectedValue(new Error('Request timed out after 2500ms'));
        const onItemSuccess = vi.fn().mockResolvedValue(undefined);

        const { syncMissingMetadata } = await import('./sync-missing-metadata.js');
        const result = await syncMissingMetadata({ sql: sqlWithJellyfinRow(), onItemSuccess });

        expect(result.success).toBe(true);
        expect(fetchUtils.fetchWithTimeout).toHaveBeenCalledTimes(1);
        expect(fetchUtils.fetchWithTimeout.mock.calls[0][2]).toBe(2_500);
        expect(jellyfinGate.recordJellyfinTransportFailure).toHaveBeenCalledTimes(1);
        expect(pluginContext.invokeProviderDetail).toHaveBeenCalledTimes(1);
        expect(onItemSuccess).toHaveBeenCalledExactlyOnceWith(mediaId);
    });

    it('sync on + reachable: the Jellyfin item fetch still runs', async () => {
        jellyfinGate.callable = true;
        fetchUtils.fetchWithTimeout.mockImplementation(async (url: string) =>
            url.endsWith('/Users')
                ? new Response(JSON.stringify([{ Id: 'user-1', Name: 'admin' }]), { status: 200 })
                : new Response(null, { status: 404 }),
        );

        const { syncMissingMetadata } = await import('./sync-missing-metadata.js');
        await syncMissingMetadata({ sql: sqlWithJellyfinRow() });

        const urls = fetchUtils.fetchWithTimeout.mock.calls.map((c) => String(c[0]));
        expect(urls[0]).toMatch(/\/Users$/);
        expect(urls[1]).toContain(`/Users/user-1/Items/${'f'.repeat(32)}`);
        expect(fetchUtils.fetchWithTimeout.mock.calls).toHaveLength(2);
        for (const [, init] of fetchUtils.fetchWithTimeout.mock.calls) {
            expect(init?.headers).toMatchObject({
                Authorization: expect.stringMatching(
                    /^MediaBrowser Client="Lumastra", .*Token="metadata-key"$/,
                ),
            });
            expect(init?.headers).not.toHaveProperty('X-Emby-Token');
        }
    });
});
