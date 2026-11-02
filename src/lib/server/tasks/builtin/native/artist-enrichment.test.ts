// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * artist-enrichment task — unit tests.
 *
 * Covers execute() logic (Discogs-token guard, abort guard, drain delegation),
 * abort-before-start guard, and backlog.stages() producing correct BacklogStage[].
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import type * as DrainBacklogModule from '$lib/server/plugins/runtime/drain-backlog.js';

// ─── hoist all mocks ─────────────────────────────────────────────────────────
const {
    mockGetArtistEnrichmentBacklog,
    mockGetTaskSettings,
    mockDrainBacklog,
    mockReEnrollGapArtists,
    mockClearArtistMarker,
    mockUpsertTaskSettings,
    mockDeferArtist,
    mockAuthoritativeStages,
    mockFindCoverageBacklog,
} = vi.hoisted(() => ({
    mockGetArtistEnrichmentBacklog: vi.fn(),
    mockGetTaskSettings: vi.fn(),
    mockDrainBacklog: vi.fn(),
    // Chain-change re-enroll spies — execute() consults these on every run now.
    mockReEnrollGapArtists: vi.fn(),
    mockClearArtistMarker: vi.fn(),
    mockUpsertTaskSettings: vi.fn(),
    mockDeferArtist: vi.fn(),
    mockFindCoverageBacklog: vi.fn().mockResolvedValue([]),
    // null → the real config value (artist-enrichment is authoritative by default).
    mockAuthoritativeStages: { value: null as Set<string> | null },
}));

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        getAuthoritativeStageIds: () =>
            mockAuthoritativeStages.value ?? actual.getAuthoritativeStageIds(),
    };
});

// ─── mock the backlog query ──────────────────────────────────────────────────
// The task reads the shared Discogs token through PluginSecrets, which uses
// `sql` as a tagged template. These tests pass an identity-marker object as
// ctx.sql (asserted by reference), so stub at the module boundary — token
// plumbing has its own coverage; these specs are about drain/backlog wiring.
vi.mock('$lib/server/services/discogs-token.js', () => ({
    DISCOGS_PLUGIN_ID: 'discogs',
    DISCOGS_TOKEN_KEY: 'DISCOGS_TOKEN',
    readDiscogsToken: vi.fn().mockResolvedValue(''),
    hasDiscogsToken: vi.fn().mockResolvedValue(false),
}));

vi.mock('$lib/server/database/queries/artist-enrichment.queries.js', () => ({
    getArtistEnrichmentBacklog: mockGetArtistEnrichmentBacklog,
    countUnenrichedArtists: vi.fn().mockResolvedValue(0),
    getArtistEnrichmentWipeBatch: vi.fn().mockResolvedValue([]),
    atomicallyWipeArtistEnrichment: vi.fn().mockResolvedValue(0),
    getUnenrichedArtists: vi.fn().mockResolvedValue([]),
    getArtistMusicBrainzId: vi.fn().mockResolvedValue(null),
    markArtistProcessed: vi.fn().mockResolvedValue(true),
    mergeArtistEnrichmentMetadata: vi.fn().mockResolvedValue(undefined),
    updateArtistPosterUrls: vi.fn().mockResolvedValue(undefined),
    reEnrollGapArtistsForRepoll: mockReEnrollGapArtists,
    clearArtistMarkerForGapRepoll: mockClearArtistMarker,
    deferArtistAfterSourceOutage: mockDeferArtist,
    findCoverageTableBacklog: mockFindCoverageBacklog,
}));

vi.mock('../../../database/queries/music-enrichment-provenance.queries.js', () => ({
    mergeMusicProvenance: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../database/with-tx.js', () => ({
    withTx: async (sql: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(sql),
}));
// ─── mock task-settings queries ──────────────────────────────────────────────
vi.mock('$lib/server/database/queries/task-settings.queries.js', () => ({
    getTaskSettings: mockGetTaskSettings,
    upsertTaskSettings: mockUpsertTaskSettings,
}));

// ─── mock enrichment sources ──────────────────────────────────────────────────
vi.mock('$lib/server/services/artist-enrichment-sources.js', () => ({
    enrichArtistFromChain: vi.fn().mockResolvedValue(null),
    ALL_SOURCES: [
        { value: 'theaudiodb', label: 'TheAudioDB (free, no key)' },
        { value: 'discogs', label: 'Discogs (requires token)' },
        { value: 'deezer', label: 'Deezer (free, no key)' },
    ],
    DEFAULT_PRIMARY: 'theaudiodb',
    DEFAULT_FALLBACK: 'discogs',
}));

// ─── mock CatalogService ──────────────────────────────────────────────────────
vi.mock('$lib/server/services/catalog.service.js', () => ({
    CatalogService: vi.fn().mockImplementation(() => ({
        upsertExternalIdDetailed: vi.fn().mockResolvedValue({ written: true, changed: true }),
    })),
}));

// ─── mock plugin-failure-events ───────────────────────────────────────────────
vi.mock('$lib/server/database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));

// ─── mock drainBacklog so execute() doesn't need real drain logic ────────────
vi.mock('$lib/server/plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return { ...actual, drainBacklog: mockDrainBacklog };
});

import { artistEnrichmentTask, enrichOneArtist } from './artist-enrichment.js';
import { enrichArtistFromChain } from '../../../services/artist-enrichment-sources.js';
import {
    markArtistProcessed,
    updateArtistPosterUrls,
} from '../../../database/queries/artist-enrichment.queries.js';
import { ArtistEnrichmentIncompleteError } from '../../../services/artist-enrichment.types.js';
import { mergeMusicProvenance } from '../../../database/queries/music-enrichment-provenance.queries.js';

type ArtistEnrichmentInput = Record<string, unknown>;

function makeContext(
    overrides: Partial<TaskContext<ArtistEnrichmentInput>> = {},
): TaskContext<ArtistEnrichmentInput> {
    const ac = new AbortController();
    return {
        runId: 'test-run-1',
        attemptNumber: 1,
        input: {},
        scope: {},
        mode: 'scheduled',
        sql: { tag: 'ctx-sql' } as never,
        logger: {
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        reportProgress: vi.fn(),
        dep: vi.fn(),
        settings: vi.fn(),
        secrets: { get: vi.fn(), getOptional: vi.fn(), getUser: vi.fn() },
        reportFailure: vi.fn(),
        spend: vi.fn(),
        drain: vi.fn(),
        ...overrides,
    } as unknown as TaskContext<ArtistEnrichmentInput>;
}

describe('artist-enrichment task', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockReEnrollGapArtists.mockResolvedValue(0);
        mockClearArtistMarker.mockResolvedValue(0);
        mockUpsertTaskSettings.mockResolvedValue(undefined);
        // Default: theaudiodb-only chain, no discogs token needed
        mockGetTaskSettings.mockResolvedValue({
            primary_source: 'theaudiodb',
            fallback_source: 'none',
            // Pin the third slot off so these specs keep asserting the
            // single-source chain they were written for; the shipped default
            // (deezer) has its own specs below.
            tertiary_source: 'none',
            discogs_token: '',
        });
        mockDrainBacklog.mockResolvedValue({
            stopReason: 'empty',
            processedCount: 0,
        });
    });

    it('does nothing when DISABLE_MUSIC_ARTWORK_ENRICHMENT is on, however it was enqueued', async () => {
        // A music scan enqueues this task directly; pausing the schedule did not
        // stop it sending artist names to TheAudioDB and Deezer (egress audit 2026-10-01).
        process.env.DISABLE_MUSIC_ARTWORK_ENRICHMENT = 'true';
        try {
            const result = await artistEnrichmentTask.execute(makeContext());

            expect(mockDrainBacklog).not.toHaveBeenCalled();
            expect(mockGetTaskSettings).not.toHaveBeenCalled();
            expect(result).toMatchObject({ success: true, itemsProcessed: 0 });

            const guard = [artistEnrichmentTask.coversStages?.[0]?.terminalDisposition ?? []]
                .flat()
                .find((d) => d.kind === 'global-guard');
            expect(guard && 'guard' in guard).toBe(true);
            await expect(
                (guard as { guard: (c: unknown) => Promise<boolean> }).guard(makeContext()),
            ).resolves.toBe(false);
        } finally {
            delete process.env.DISABLE_MUSIC_ARTWORK_ENRICHMENT;
        }
    });

    it('returns aborted stopReason when signal is already aborted before execute', async () => {
        const ac = new AbortController();
        ac.abort();
        const ctx = makeContext({ signal: ac.signal, abortSignal: ac.signal });

        const result = await artistEnrichmentTask.execute(ctx);

        expect(mockDrainBacklog).not.toHaveBeenCalled();
        expect(result.stopReason).toBe('aborted');
        expect(result.itemsProcessed).toBe(0);
    });

    it('skips cleanly (success, 0 processed) when Discogs is in chain but token is missing', async () => {
        // Unconfigured optional integration → graceful skip, not a failed run.
        mockGetTaskSettings.mockResolvedValue({
            primary_source: 'discogs',
            fallback_source: 'none',
            tertiary_source: 'none',
            discogs_token: '',
        });

        const ctx = makeContext();
        const result = await artistEnrichmentTask.execute(ctx);

        expect(mockDrainBacklog).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(result.result?.message).toContain('Discogs');
        expect(result.result?.message).toContain('no token');
    });

    it('calls drainBacklog and returns itemsProcessed from enriched count', async () => {
        mockDrainBacklog.mockResolvedValue({
            stopReason: 'empty',
            processedCount: 0,
        });

        const ctx = makeContext();
        const result = await artistEnrichmentTask.execute(ctx);

        expect(mockDrainBacklog).toHaveBeenCalledOnce();
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
    });

    it('passes mode from ctx.input to resolveDrainMode via drainBacklog call', async () => {
        mockDrainBacklog.mockResolvedValue({
            stopReason: 'empty',
            processedCount: 0,
        });

        const ctx = makeContext({ input: { mode: 'manual' } });
        await artistEnrichmentTask.execute(ctx);

        expect(mockDrainBacklog).toHaveBeenCalledWith(
            expect.objectContaining({ abortSignal: ctx.signal }),
            expect.objectContaining({ mode: expect.any(String) }),
        );
    });

    it('returns "All artists are already enriched" message when 0 processed', async () => {
        mockDrainBacklog.mockResolvedValue({
            stopReason: 'empty',
            processedCount: 0,
        });

        const ctx = makeContext();
        const result = await artistEnrichmentTask.execute(ctx);

        expect(result.result?.message).toBe('All artists are already enriched');
    });

    it('backlog.stages translates PluginBacklogStatus to BacklogStage[]', async () => {
        mockGetArtistEnrichmentBacklog.mockResolvedValue({
            analyzed: 200,
            remaining: 50,
            ineligible: 20,
            failed: 8,
        });

        const ctx = makeContext();
        const stages = await artistEnrichmentTask.backlog!.stages(ctx);

        expect(stages).toEqual([
            { id: 'remaining', label: 'Remaining', count: 50 },
            { id: 'failed', label: 'Failed', count: 8 },
            { id: 'ineligible', label: 'Ineligible', count: 20 },
        ]);
        expect(mockGetArtistEnrichmentBacklog).toHaveBeenCalledWith(ctx.sql, 5);
    });

    it('backlog.stages omits zero-count buckets', async () => {
        mockGetArtistEnrichmentBacklog.mockResolvedValue({
            analyzed: 100,
            remaining: 0,
            ineligible: 0,
            failed: 0,
        });

        const ctx = makeContext();
        const stages = await artistEnrichmentTask.backlog!.stages(ctx);

        expect(stages).toHaveLength(0);
    });
    // ─── source chain + gap re-enroll ────────────────────────────────────────
    //
    // `reEnrollGapArtistsForRepoll` is the ONLY thing that re-opens an artist
    // sitting at `skipped_permanent`, and every artist a provider has given up
    // on is sitting there. `detectVersionBumps` — what a processingVersion bump
    // goes through — touches only `status='completed'` rows, so shipping a new
    // provider without this would re-poll exactly zero of the artists it was
    // added for. These specs pin that wiring.
    describe('source chain and gap re-enroll', () => {
        // 'artist-enrichment' is in DEFAULT_AUTHORITATIVE_STAGES and nothing
        // here overrides PIPELINE_COVERAGE_AUTHORITATIVE_STAGES, so the
        // COVERAGE-TABLE branch is the one that runs — assert that branch by
        // name. Summing both spies would have let a flipped ternary silently
        // fall back to the legacy marker path, which cannot re-open a
        // `skipped_permanent` row at all and is the exact bug this feature
        // exists to avoid.

        function appliedChain(): string | undefined {
            // The chain is written by its own upsert.
            const call = [...mockUpsertTaskSettings.mock.calls]
                .reverse()
                .find((c) => '_applied_source_chain' in (c[2] as Record<string, unknown>));
            return (call?.[2] as Record<string, string> | undefined)?.['_applied_source_chain'];
        }

        it('defaults deezer into the chain for an install that never saved the key', async () => {
            // plugin_settings has no row for a key the operator never touched,
            // so an EXISTING install picks up the shipped default too.
            mockGetTaskSettings.mockResolvedValue({
                primary_source: 'theaudiodb',
                fallback_source: 'none',
                discogs_token: '',
            });

            await artistEnrichmentTask.execute(makeContext());

            expect(appliedChain()).toBe('theaudiodb>deezer');
        });

        it('re-enrolls gap artists the first time a chain is seen', async () => {
            mockGetTaskSettings.mockResolvedValue({
                primary_source: 'theaudiodb',
                fallback_source: 'none',
                discogs_token: '',
            });

            await artistEnrichmentTask.execute(makeContext());

            expect(mockReEnrollGapArtists).toHaveBeenCalledOnce();
            expect(mockReEnrollGapArtists).toHaveBeenCalledWith(
                expect.anything(),
                'artist-enrichment',
            );
        });

        it('also clears the legacy marker so the admin backlog card agrees', async () => {
            // reEnrollGapArtistsForRepoll only writes media_item_stage_state.
            // getArtistEnrichmentBacklog — what the card counts — reads
            // media_items.processing_state. Leave that behind and "Remaining"
            // shows 0 while thousands of artists are actually being re-polled.
            mockGetTaskSettings.mockResolvedValue({
                primary_source: 'theaudiodb',
                fallback_source: 'none',
                discogs_token: '',
            });

            await artistEnrichmentTask.execute(makeContext());

            expect(mockClearArtistMarker).toHaveBeenCalledOnce();
        });

        it('does not re-enroll again when the recorded chain is unchanged', async () => {
            mockGetTaskSettings.mockResolvedValue({
                primary_source: 'theaudiodb',
                fallback_source: 'none',
                discogs_token: '',
                _applied_source_chain: 'theaudiodb>deezer',
            });

            await artistEnrichmentTask.execute(makeContext());

            expect(mockReEnrollGapArtists).not.toHaveBeenCalled();
            expect(mockClearArtistMarker).not.toHaveBeenCalled();
            expect(mockUpsertTaskSettings).not.toHaveBeenCalled();
        });

        it('ignores a stored legacy epoch: an unchanged chain never re-opens gap artists', async () => {
            // Installs that ran the retired epoch replay still have the key stored.
            mockGetTaskSettings.mockResolvedValue({
                primary_source: 'theaudiodb',
                fallback_source: 'none',
                discogs_token: '',
                _applied_source_chain: 'theaudiodb>deezer',
                _gap_repoll_epoch: 1,
            });

            await artistEnrichmentTask.execute(makeContext());

            expect(mockReEnrollGapArtists).not.toHaveBeenCalled();
            expect(mockClearArtistMarker).not.toHaveBeenCalled();
            expect(mockUpsertTaskSettings).not.toHaveBeenCalled();
        });

        it('re-enrolls when the operator adds a source to a recorded chain', async () => {
            mockGetTaskSettings.mockResolvedValue({
                primary_source: 'theaudiodb',
                fallback_source: 'none',
                discogs_token: '',
                _applied_source_chain: 'theaudiodb',
            });

            await artistEnrichmentTask.execute(makeContext());

            expect(mockReEnrollGapArtists).toHaveBeenCalledOnce();
            expect(appliedChain()).toBe('theaudiodb>deezer');
        });

        it('leaves an unusable Discogs out of the fingerprint', async () => {
            // No token → discogs cannot run, so it must not appear in the
            // chain identity. Otherwise pasting a token later would look like
            // no change at all and the gap would never be re-polled.
            mockGetTaskSettings.mockResolvedValue({
                primary_source: 'discogs',
                fallback_source: 'none',
                discogs_token: '',
            });

            await artistEnrichmentTask.execute(makeContext());

            expect(appliedChain()).toBe('deezer');
        });

        it('survives a re-enroll failure — the drain is the job, re-polling is not', async () => {
            mockGetTaskSettings.mockResolvedValue({
                primary_source: 'theaudiodb',
                fallback_source: 'none',
                discogs_token: '',
            });
            mockReEnrollGapArtists.mockRejectedValue(new Error('db down'));
            mockClearArtistMarker.mockRejectedValue(new Error('db down'));

            const result = await artistEnrichmentTask.execute(makeContext());

            expect(result.success).toBe(true);
            expect(mockDrainBacklog).toHaveBeenCalledOnce();
            // Recorded BEFORE the re-enroll, so the next tick doesn't retry
            // the whole library on a chain that is already current.
            expect(appliedChain()).toBe('theaudiodb>deezer');
        });
    });
});

describe('artist selected-field provenance', () => {
    it('credits written metadata but excludes a rejected poster and curated backdrop', async () => {
        const source = { provider: 'discogs' as const, url: 'https://www.discogs.com/artist/42' };
        vi.mocked(enrichArtistFromChain).mockResolvedValueOnce({
            thumbUrl: 'http://127.0.0.1/photo.jpg',
            fanartUrl: 'https://cdn.example/fanart.jpg',
            bannerUrl: null,
            musicBrainzId: null,
            biography: 'bio',
            genre: null,
            countryCode: null,
            provenance: { thumbUrl: source, fanartUrl: source, biography: source },
        });
        vi.mocked(updateArtistPosterUrls).mockResolvedValueOnce({ poster: false, backdrop: false });
        const ctx = makeContext({ sql: vi.fn().mockResolvedValue([]) as never });
        await enrichOneArtist(
            ctx.sql as never,
            ctx.logger as never,
            { id: 'artist', title: 'Artist' },
            ['discogs'],
            'token',
        );
        expect(updateArtistPosterUrls).toHaveBeenCalledWith(
            expect.anything(),
            'artist',
            null,
            'https://cdn.example/fanart.jpg',
        );
        expect(mergeMusicProvenance).toHaveBeenCalledWith(
            expect.anything(),
            'artist',
            'artist_enrichment',
            ['biography'],
            { biography: { ...source, value: 'bio' } },
        );
    });
});

// An incomplete chain (a source failed, or the run stopped mid-chain) must
// never leave a terminal mark: no `no-match` marker, no `skipped_permanent`
// row. That is what made a failed lookup a permanent "no image".
describe('enrichOneArtist with an incomplete chain', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockDeferArtist.mockResolvedValue(true);
    });

    it('parks the artist for a retry when a source did not answer', async () => {
        vi.mocked(enrichArtistFromChain).mockRejectedValueOnce(
            new ArtistEnrichmentIncompleteError('source-unavailable', ['deezer']),
        );
        const sql = vi.fn().mockResolvedValue([]);

        const outcome = await enrichOneArtist(
            sql as never,
            makeContext().logger as never,
            { id: 'artist-1', title: 'Some Act' },
            ['theaudiodb', 'deezer'],
            '',
        );

        expect(outcome).toEqual({
            status: 'deferred',
            advanced: true,
            detail: 'Enrichment source unavailable: deezer',
        });
        expect(mockDeferArtist).toHaveBeenCalledWith(sql, {
            artistId: 'artist-1',
            stageId: 'artist-enrichment',
            retryAfterMs: 12 * 60 * 60 * 1000,
            maxRetryAfterMs: 90 * 24 * 60 * 60 * 1000,
            detail: 'Enrichment source unavailable: deezer',
        });
        expect(markArtistProcessed).not.toHaveBeenCalled();
        // No other write (upsertSkippedPermanentRow, failure markers) ran.
        expect(sql).not.toHaveBeenCalled();
    });

    it('on the legacy (non-coverage) path, writes nothing and credits no progress', async () => {
        // No coverage row drives selection there, so parking one would credit
        // progress the drain never makes and disarm its no-progress detector.
        mockAuthoritativeStages.value = new Set();
        try {
            vi.mocked(enrichArtistFromChain).mockRejectedValueOnce(
                new ArtistEnrichmentIncompleteError('source-unavailable', ['deezer']),
            );
            const sql = vi.fn().mockResolvedValue([]);

            const outcome = await enrichOneArtist(
                sql as never,
                makeContext().logger as never,
                { id: 'artist-1', title: 'Some Act' },
                ['theaudiodb', 'deezer'],
                '',
            );

            expect(outcome).toMatchObject({ status: 'deferred', advanced: false });
            expect(mockDeferArtist).not.toHaveBeenCalled();
            expect(markArtistProcessed).not.toHaveBeenCalled();
            expect(sql).not.toHaveBeenCalled();
        } finally {
            mockAuthoritativeStages.value = null;
        }
    });

    it('does not credit progress when the deferral did not land', async () => {
        vi.mocked(enrichArtistFromChain).mockRejectedValueOnce(
            new ArtistEnrichmentIncompleteError('source-unavailable', ['theaudiodb']),
        );
        mockDeferArtist.mockResolvedValueOnce(false);

        const outcome = await enrichOneArtist(
            vi.fn() as never,
            makeContext().logger as never,
            { id: 'artist-1', title: 'Some Act' },
            ['theaudiodb'],
            '',
        );

        expect(outcome).toMatchObject({ status: 'deferred', advanced: false });
    });

    it('writes nothing when the run stopped mid-chain', async () => {
        vi.mocked(enrichArtistFromChain).mockRejectedValueOnce(
            new ArtistEnrichmentIncompleteError('aborted', []),
        );
        const sql = vi.fn().mockResolvedValue([]);

        const outcome = await enrichOneArtist(
            sql as never,
            makeContext().logger as never,
            { id: 'artist-1', title: 'Some Act' },
            ['theaudiodb', 'deezer'],
            '',
        );

        // Left selectable for the next run, exactly as before it was picked.
        expect(outcome).toMatchObject({ status: 'deferred', advanced: false });
        expect(mockDeferArtist).not.toHaveBeenCalled();
        expect(markArtistProcessed).not.toHaveBeenCalled();
        expect(sql).not.toHaveBeenCalled();
    });

    it('still records a no-match when every source answered', async () => {
        vi.mocked(enrichArtistFromChain).mockResolvedValueOnce(null);

        const outcome = await enrichOneArtist(
            vi.fn().mockResolvedValue([]) as never,
            makeContext().logger as never,
            { id: 'artist-1', title: 'Some Act' },
            ['theaudiodb', 'deezer'],
            '',
        );

        expect(outcome.status).toBe('no-match');
        expect(markArtistProcessed).toHaveBeenCalledWith(
            expect.anything(),
            'artist-1',
            5,
            'no-match',
        );
    });
});

describe('artist-enrichment per-run circuit breaker', () => {
    it('stops the drain once every source keeps failing', async () => {
        // Real drain loop, so fetchSlice / processSlice run.
        const actual = await vi.importActual<typeof DrainBacklogModule>(
            '$lib/server/plugins/runtime/drain-backlog.js',
        );
        mockDrainBacklog.mockImplementation(actual.drainBacklog);
        mockGetTaskSettings.mockResolvedValue({
            primary_source: 'theaudiodb',
            fallback_source: 'none',
            tertiary_source: 'none',
            _applied_source_chain: 'theaudiodb',
        });
        mockDeferArtist.mockResolvedValue(true);
        const artists = Array.from({ length: 10 }, (_, i) => ({
            id: `00000000-0000-0000-0000-00000000000${i}`,
            title: `Artist ${i}`,
        }));
        mockFindCoverageBacklog.mockResolvedValueOnce(artists).mockResolvedValue(artists.slice(3));
        // The chain reports every TheAudioDB call as failed through the breaker.
        vi.mocked(enrichArtistFromChain).mockImplementation(async (_name, sources, config) => {
            for (const s of sources) config.breaker?.recordFailure(s);
            throw new ArtistEnrichmentIncompleteError('source-unavailable', sources);
        });

        const result = await artistEnrichmentTask.execute(makeContext());

        // Three failures open the only source; the other seven are not asked.
        expect(enrichArtistFromChain).toHaveBeenCalledTimes(3);
        expect(mockDeferArtist).toHaveBeenCalledTimes(3);
        expect(mockFindCoverageBacklog).toHaveBeenCalledTimes(1);
        expect(result.result?.message).toContain('stopped early: theaudiodb kept failing');
    });
});
