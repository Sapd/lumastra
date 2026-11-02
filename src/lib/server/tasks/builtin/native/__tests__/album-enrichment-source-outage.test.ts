// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * album-enrichment — a failed provider must not become a permanent no-match.
 *
 * TheAudioDB answered every album lookup with HTTP 404 from about 2026-09-24
 * (its free key "2" was retired), and the chain read each failure as "no
 * match": the albums were marked `no-match` and tombstoned `skipped_permanent`.
 * An incomplete chain (a source failed, or the run stopped mid-chain) must now
 * leave no terminal mark.
 */

vi.mock('$lib/server/services/album-local-art.js', () => ({
    recoverLocalAlbumArt: vi.fn().mockResolvedValue(false),
    backfillLocalAlbumArt: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/album-local-art.queries.js', () => ({
    getAlbumReleaseIdentifiers: vi.fn().mockResolvedValue({}),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

const {
    mockEnrichAlbumFromChain,
    mockGetTaskSettings,
    mockUpsertTaskSettings,
    mockDeferAlbum,
    mockReEnrollGapAlbums,
    mockClearAlbumMarker,
    mockMarkAlbumProcessed,
    mockUpsertSkippedPermanentRow,
    mockGetStoredAlbumMbids,
    mockDrainBacklog,
    mockAuthoritativeStages,
    mockFindCoverageBacklog,
} = vi.hoisted(() => ({
    mockEnrichAlbumFromChain: vi.fn(),
    mockGetTaskSettings: vi.fn(),
    mockUpsertTaskSettings: vi.fn(),
    mockDeferAlbum: vi.fn(),
    mockReEnrollGapAlbums: vi.fn(),
    mockClearAlbumMarker: vi.fn(),
    mockMarkAlbumProcessed: vi.fn(),
    mockUpsertSkippedPermanentRow: vi.fn(),
    mockGetStoredAlbumMbids: vi.fn(),
    mockDrainBacklog: vi.fn(),
    mockFindCoverageBacklog: vi.fn(),
    mockAuthoritativeStages: { value: new Set<string>(['album-enrichment']) },
}));

vi.mock('../../../../services/discogs-token.js', () => ({
    readDiscogsToken: vi.fn().mockResolvedValue(''),
    hasDiscogsToken: vi.fn().mockResolvedValue(false),
    DISCOGS_PLUGIN_ID: 'discogs',
    DISCOGS_TOKEN_KEY: 'DISCOGS_TOKEN',
}));
vi.mock('../../../../services/album-enrichment-sources.js', () => ({
    enrichAlbumFromChain: mockEnrichAlbumFromChain,
    ALL_SOURCES: [
        { value: 'theaudiodb', label: 'TheAudioDB (free, no key)' },
        { value: 'discogs', label: 'Discogs (requires token)' },
    ],
    DEFAULT_PRIMARY: 'theaudiodb',
    DEFAULT_FALLBACK: 'discogs',
}));
vi.mock('../../../../database/queries/task-settings.queries.js', () => ({
    getTaskSettings: mockGetTaskSettings,
    upsertTaskSettings: mockUpsertTaskSettings,
}));
vi.mock('../../../../database/queries/album-enrichment.queries.js', () => ({
    atomicallyWipeAlbumEnrichment: vi.fn().mockResolvedValue(undefined),
    clearAlbumMarkerForGapRepoll: mockClearAlbumMarker,
    countUnenrichedAlbums: vi.fn().mockResolvedValue(0),
    deferAlbumAfterSourceOutage: mockDeferAlbum,
    findCoverageTableBacklog: mockFindCoverageBacklog,
    getAlbumEnrichmentBacklog: vi.fn(),
    getAlbumEnrichmentWipeBatch: vi.fn().mockResolvedValue([]),
    getUnenrichedAlbums: vi.fn().mockResolvedValue([]),
    markAlbumProcessed: mockMarkAlbumProcessed,
    reEnrollGapAlbumsForRepoll: mockReEnrollGapAlbums,
    updateAlbumPosterUrls: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../database/queries/acoustid-fingerprint.queries.js', () => ({
    getStoredAlbumMbids: mockGetStoredAlbumMbids,
}));
vi.mock('../../../../database/queries/music-enrichment-provenance.queries.js', () => ({
    persistAlbumCoverArtFallback: vi.fn().mockResolvedValue(undefined),
    writableAlbumArtwork: vi.fn().mockResolvedValue({ poster: true, backdrop: true }),
    getAlbumEnrichmentArtworkPaths: vi.fn().mockResolvedValue([]),
    mergeMusicProvenance: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/providers/implementations/musicbrainz/cover-art.js', () => ({
    getAlbumArt: vi.fn().mockResolvedValue(null),
    getAlbumArtUrl: vi.fn((mbid: string) => `https://coverartarchive.org/release/${mbid}/front`),
}));
import type * as DrainBacklogModule from '../../../../plugins/runtime/drain-backlog.js';
vi.mock('../../../../plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return { ...actual, drainBacklog: mockDrainBacklog };
});
vi.mock('../../../../services/catalog.service.js', () => ({
    CatalogService: class {
        upsertExternalId = vi.fn().mockResolvedValue(undefined);
    },
}));
vi.mock('../../../../database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('../../../../database/queries/media-artwork.queries.js', () => ({
    upsertLocalArtwork: vi.fn().mockResolvedValue(true),
    lockArtworkOwners: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../database/queries/album-art.queries.js', () => ({
    findTrackFileForAlbum: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../services/metadata-storage.service.js', () => ({
    resolveWritePath: vi.fn().mockResolvedValue({ filePath: '/tmp/test-outage/poster.jpg' }),
}));
vi.mock('../../../../database/queries/stage-state.queries.js', () => ({
    upsertCompletedRow: vi.fn().mockResolvedValue(undefined),
    upsertSkippedPermanentRow: mockUpsertSkippedPermanentRow,
    recordStageAttemptFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/config.js', () => ({
    config: { BASE_PATH: '/data' },
    getAuthoritativeStageIds: vi.fn(() => mockAuthoritativeStages.value),
    FEATURE_PER_TASK_QUEUES: false,
}));

import { albumEnrichmentTask, enrichOneAlbum } from '../album-enrichment.js';
import { AlbumEnrichmentIncompleteError } from '../../../../services/album-enrichment.types.js';

const ALBUM = {
    id: '00000000-0000-0000-0000-0000000000a1',
    title: 'Kind of Dawn',
    parent_id: '00000000-0000-0000-0000-0000000000b1',
    parent_title: 'Milo Fenwick',
};

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const http = { get: vi.fn(), post: vi.fn() };

function run(sql: unknown, signal?: AbortSignal) {
    return enrichOneAlbum(
        sql as never,
        logger as never,
        ALBUM,
        ['theaudiodb', 'discogs'],
        'tok',
        signal,
        'job-1',
        http as never,
    );
}

function unavailable(partial: ConstructorParameters<typeof AlbumEnrichmentIncompleteError>[2]) {
    return new AlbumEnrichmentIncompleteError('source-unavailable', ['theaudiodb'], partial);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockAuthoritativeStages.value = new Set(['album-enrichment']);
    mockDeferAlbum.mockResolvedValue(true);
    mockMarkAlbumProcessed.mockResolvedValue(true);
    mockGetStoredAlbumMbids.mockResolvedValue({ releaseMbid: null, releaseGroupMbid: null });
    mockFindCoverageBacklog.mockResolvedValue([]);
});

describe('enrichOneAlbum with an incomplete chain', () => {
    it('parks the album for a retry instead of recording a no-match', async () => {
        mockEnrichAlbumFromChain.mockRejectedValueOnce(unavailable(null));
        const sql = vi.fn().mockResolvedValue([]);

        const outcome = await run(sql);

        expect(outcome).toEqual({
            status: 'deferred',
            advanced: true,
            detail: 'Enrichment source unavailable: theaudiodb',
        });
        expect(mockDeferAlbum).toHaveBeenCalledWith(sql, {
            albumId: ALBUM.id,
            stageId: 'album-enrichment',
            retryAfterMs: 12 * 60 * 60 * 1000,
            maxRetryAfterMs: 90 * 24 * 60 * 60 * 1000,
            detail: 'Enrichment source unavailable: theaudiodb',
        });
        expect(mockMarkAlbumProcessed).not.toHaveBeenCalled();
        expect(mockUpsertSkippedPermanentRow).not.toHaveBeenCalled();
    });

    it('still defers when the answering source had an MBID but Cover Art Archive had nothing', async () => {
        // The partial result goes through the CAA attempt; with no image at the
        // end, the failed source might still have one, so no tombstone.
        mockEnrichAlbumFromChain.mockRejectedValueOnce(
            unavailable({
                posterUrl: null,
                backdropUrl: null,
                releaseMbid: null,
                releaseGroupMbid: 'rg-1',
            }),
        );

        const outcome = await run(vi.fn().mockResolvedValue([]));

        expect(outcome).toMatchObject({ status: 'deferred', advanced: true });
        const { getAlbumArt } =
            await import('$lib/server/providers/implementations/musicbrainz/cover-art.js');
        expect(getAlbumArt).toHaveBeenCalledWith(null, 'rg-1');
        expect(mockMarkAlbumProcessed).not.toHaveBeenCalled();
        expect(mockUpsertSkippedPermanentRow).not.toHaveBeenCalled();
    });

    it('on the legacy (non-coverage) path, writes nothing and credits no progress', async () => {
        mockAuthoritativeStages.value = new Set();
        mockEnrichAlbumFromChain.mockRejectedValueOnce(unavailable(null));

        const outcome = await run(vi.fn().mockResolvedValue([]));

        expect(outcome).toMatchObject({ status: 'deferred', advanced: false });
        expect(mockDeferAlbum).not.toHaveBeenCalled();
        expect(mockMarkAlbumProcessed).not.toHaveBeenCalled();
    });

    it('does not credit progress when the deferral did not land', async () => {
        mockEnrichAlbumFromChain.mockRejectedValueOnce(unavailable(null));
        mockDeferAlbum.mockResolvedValueOnce(false);

        expect(await run(vi.fn().mockResolvedValue([]))).toMatchObject({
            status: 'deferred',
            advanced: false,
        });
    });

    it('writes nothing when the run stopped mid-chain', async () => {
        mockEnrichAlbumFromChain.mockRejectedValueOnce(
            new AlbumEnrichmentIncompleteError('aborted', [], null),
        );
        const sql = vi.fn().mockResolvedValue([]);

        const outcome = await run(sql);

        expect(outcome).toMatchObject({ status: 'deferred', advanced: false });
        expect(mockDeferAlbum).not.toHaveBeenCalled();
        expect(mockMarkAlbumProcessed).not.toHaveBeenCalled();
        expect(sql).not.toHaveBeenCalled();
    });

    it('still records a no-match when every source answered', async () => {
        mockEnrichAlbumFromChain.mockResolvedValueOnce(null);

        const outcome = await run(vi.fn().mockResolvedValue([]));

        expect(outcome).toMatchObject({ status: 'no-match', advanced: true });
        expect(mockMarkAlbumProcessed).toHaveBeenCalledWith(
            expect.anything(),
            ALBUM.id,
            2,
            'no-match',
        );
        expect(mockUpsertSkippedPermanentRow).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ skippedReason: 'no-match-upstream' }),
        );
        expect(mockDeferAlbum).not.toHaveBeenCalled();
    });
});

describe('album-enrichment retired gap re-poll epoch', () => {
    function makeContext(): TaskContext<Record<string, unknown>> {
        const ac = new AbortController();
        return {
            runId: 'run-1',
            input: {},
            sql: { tag: 'ctx-sql' } as never,
            logger: { ...logger, child: vi.fn() },
            signal: ac.signal,
            abortSignal: ac.signal,
            reportProgress: vi.fn(),
            http,
        } as unknown as TaskContext<Record<string, unknown>>;
    }

    beforeEach(() => {
        mockDrainBacklog.mockResolvedValue({ stopReason: 'empty', itemsProduced: 0 });
        mockReEnrollGapAlbums.mockResolvedValue(441);
        mockClearAlbumMarker.mockResolvedValue(441);
        mockUpsertTaskSettings.mockResolvedValue(undefined);
    });

    it('a fresh install runs no gap re-poll and records nothing', async () => {
        mockGetTaskSettings.mockResolvedValue({ primary_source: 'theaudiodb' });

        await albumEnrichmentTask.execute(makeContext());

        expect(mockReEnrollGapAlbums).not.toHaveBeenCalled();
        expect(mockClearAlbumMarker).not.toHaveBeenCalled();
        expect(mockUpsertTaskSettings).not.toHaveBeenCalled();
        expect(mockDrainBacklog).toHaveBeenCalledOnce();
    });

    it('a stored legacy epoch is inert: the drain runs and nothing is re-opened', async () => {
        mockGetTaskSettings.mockResolvedValue({
            primary_source: 'theaudiodb',
            _gap_repoll_epoch: 3,
        });

        await albumEnrichmentTask.execute(makeContext());

        expect(mockReEnrollGapAlbums).not.toHaveBeenCalled();
        expect(mockClearAlbumMarker).not.toHaveBeenCalled();
        expect(mockUpsertTaskSettings).not.toHaveBeenCalled();
        expect(mockDrainBacklog).toHaveBeenCalledOnce();
    });
});

describe('album-enrichment failures.retry with an incomplete chain', () => {
    it('reports the outage instead of "no image found"', async () => {
        mockGetTaskSettings.mockResolvedValue({
            primary_source: 'theaudiodb',
            fallback_source: 'none',
        });
        mockEnrichAlbumFromChain.mockRejectedValueOnce(unavailable(null));
        const sql = vi.fn().mockResolvedValueOnce([{ ...ALBUM, prior_audit_job_id: null }]);
        const ac = new AbortController();
        const ctx = {
            sql,
            signal: ac.signal,
            logger,
            http,
        } as unknown as TaskContext<Record<string, unknown>>;

        await expect(albumEnrichmentTask.failures!.retry!(ctx, ALBUM.id)).rejects.toThrow(
            'Enrichment source unavailable: theaudiodb; the album will be retried later',
        );
    });
});

describe('album-enrichment per-run circuit breaker', () => {
    it('stops the drain once every source keeps failing', async () => {
        // Real drain loop, so fetchSlice / processSlice run.
        const actual = await vi.importActual<typeof DrainBacklogModule>(
            '../../../../plugins/runtime/drain-backlog.js',
        );
        mockDrainBacklog.mockImplementation(actual.drainBacklog);
        mockGetTaskSettings.mockResolvedValue({
            primary_source: 'theaudiodb',
            fallback_source: 'none',
        });
        const albums = Array.from({ length: 10 }, (_, i) => ({
            ...ALBUM,
            id: `00000000-0000-0000-0000-00000000000${i}`,
        }));
        mockFindCoverageBacklog.mockResolvedValueOnce(albums).mockResolvedValue(albums.slice(3));
        // The chain reports both configured sources as failed through the breaker.
        mockEnrichAlbumFromChain.mockImplementation(
            async (
                _artist: string,
                _album: string,
                sources: Array<'theaudiodb' | 'discogs' | 'deezer'>,
                config: { breaker?: { recordFailure(s: string): void } },
            ) => {
                for (const s of sources) config.breaker?.recordFailure(s);
                throw new AlbumEnrichmentIncompleteError('source-unavailable', sources, null);
            },
        );
        const ac = new AbortController();
        const ctx = {
            runId: 'run-1',
            input: {},
            sql: { tag: 'ctx-sql' } as never,
            logger: { ...logger, child: vi.fn() },
            signal: ac.signal,
            abortSignal: ac.signal,
            reportProgress: vi.fn(),
            http,
        } as unknown as TaskContext<Record<string, unknown>>;

        const result = await albumEnrichmentTask.execute(ctx);

        // Three failures open both sources; the other seven albums are not asked.
        expect(mockEnrichAlbumFromChain).toHaveBeenCalledTimes(3);
        expect(mockDeferAlbum).toHaveBeenCalledTimes(3);
        expect(mockFindCoverageBacklog).toHaveBeenCalledTimes(1);
        expect(result.result?.message).toContain('stopped early: theaudiodb, deezer kept failing');
    });
});
