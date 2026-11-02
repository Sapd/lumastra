// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * metadata-cast-backfill: a candidate whose provider id was deleted upstream
 * (404) is stamped with the exclusion marker instead of erroring forever.
 *
 * Before: every per-candidate throw only did `failed++`, so a library whose
 * only remaining candidates were 404s ended EVERY daily run with
 * "all N candidates errored" (transient TaskError) and re-fetched them forever.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));
vi.mock('$lib/server/tasks/api-call-spend.js', () => ({
    withApiCallSpend: async (_ctx: unknown, body: () => Promise<unknown>) => body(),
}));

const queries = vi.hoisted(() => ({
    findCastBackfillCandidates: vi.fn(),
    findCastAggregationGaps: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/server/database/queries/ai-sync.queries.js', () => queries);

const upsert = vi.hoisted(() => ({
    upsertProviderMetadataUnlessLocked: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/database/queries/media-upsert.js', () => upsert);

vi.mock('$lib/server/database/queries/metadata-aggregation.queries.js', () => ({
    batchAggregateMetadata: vi.fn().mockResolvedValue({ updated: 0, skipped: 0, errors: 0 }),
}));
vi.mock('$lib/server/ai/tmdb-metadata-sync.js', () => ({
    buildStructuredCast: vi.fn(() => []),
}));
const pluginContext = vi.hoisted(() => ({ invokeProviderDetail: vi.fn() }));
vi.mock('$lib/server/tasks/plugin-context.js', () => pluginContext);
vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: vi.fn(() => 'tmdb'),
}));

import { metadataCastBackfillTask } from '../metadata-cast-backfill.js';

type Ctx = Parameters<typeof metadataCastBackfillTask.execute>[0];

function makeCtx(): Ctx {
    return {
        input: {},
        sql: {},
        signal: new AbortController().signal,
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
        reportProgress: vi.fn(),
        spend: vi.fn(),
    } as unknown as Ctx;
}

const candidate = (n: number) => ({
    media_id: `00000000-0000-0000-0000-00000000000${n}`,
    external_id: String(1000 + n),
    media_type: 'movie',
});

const notFoundError = () => new Error('TMDB API request failed: 404 Not Found — /movie/1430191');

describe('metadata-cast-backfill: provider 404', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        queries.findCastAggregationGaps.mockResolvedValue([]);
    });

    it('all candidates 404 → run succeeds, markers stamped, none counted as failed', async () => {
        queries.findCastBackfillCandidates.mockResolvedValue([
            candidate(1),
            candidate(2),
            candidate(3),
        ]);
        pluginContext.invokeProviderDetail.mockRejectedValue(notFoundError());

        const out = await metadataCastBackfillTask.execute(makeCtx());

        expect(out).toMatchObject({
            success: true,
            result: { candidates: 3, notFound: 3, failed: 0, written: 0, noCast: 0 },
        });
        expect(upsert.upsertProviderMetadataUnlessLocked).toHaveBeenCalledTimes(3);
        const [, mediaId, provider, metadata] =
            upsert.upsertProviderMetadataUnlessLocked.mock.calls[0];
        expect(mediaId).toBe(candidate(1).media_id);
        expect(provider).toBe('tmdb');
        expect(metadata).toMatchObject({ cast_sync_error: 'not_found' });
        expect(typeof (metadata as { cast_synced_at?: unknown }).cast_synced_at).toBe('string');
    });

    it('all candidates fail with 500 → still throws transient, no marker written', async () => {
        queries.findCastBackfillCandidates.mockResolvedValue([candidate(1), candidate(2)]);
        pluginContext.invokeProviderDetail.mockRejectedValue(
            new Error('TMDB API request failed: 500 Internal Server Error — /movie/1'),
        );

        await expect(metadataCastBackfillTask.execute(makeCtx())).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
        });
        expect(upsert.upsertProviderMetadataUnlessLocked).not.toHaveBeenCalled();
    });

    it('timeout (abort) is not a not-found: counted failed, no marker', async () => {
        queries.findCastBackfillCandidates.mockResolvedValue([candidate(1)]);
        pluginContext.invokeProviderDetail.mockRejectedValue(
            new Error('This operation was aborted'),
        );

        await expect(metadataCastBackfillTask.execute(makeCtx())).rejects.toMatchObject({
            kind: 'transient',
        });
        expect(upsert.upsertProviderMetadataUnlessLocked).not.toHaveBeenCalled();
    });

    it('mixed 404 + 500 → succeeds with notFound=1, failed=1', async () => {
        queries.findCastBackfillCandidates.mockResolvedValue([candidate(1), candidate(2)]);
        pluginContext.invokeProviderDetail
            .mockRejectedValueOnce(notFoundError())
            .mockRejectedValueOnce(new Error('TMDB API request failed: 500 — /movie/2'));

        const out = await metadataCastBackfillTask.execute(makeCtx());
        expect(out).toMatchObject({ success: true, result: { notFound: 1, failed: 1 } });
    });

    it('marker write failure on a 404 falls back to failed', async () => {
        queries.findCastBackfillCandidates.mockResolvedValue([candidate(1)]);
        pluginContext.invokeProviderDetail.mockRejectedValue(notFoundError());
        upsert.upsertProviderMetadataUnlessLocked.mockRejectedValueOnce(new Error('db down'));

        await expect(metadataCastBackfillTask.execute(makeCtx())).rejects.toMatchObject({
            kind: 'transient',
        });
    });
});
