// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * artist-enrichment retryItem — unit tests.
 *
 * Covers the retryOneArtist path via failures.retry:
 *   - UUID validation (no DB hit)
 *   - Artist not found
 *   - Missing Discogs token when Discogs is in chain
 *   - enrichOneArtist returns 'enriched' → success
 *   - enrichOneArtist returns 'no-match' → success
 *   - enrichOneArtist returns 'error' + marker contains reason → failure
 *   - enrichOneArtist throws → failure
 *
 * Mock strategy: vi.mock enrichArtistFromChain (the HTTP layer) and
 * getTaskSettings so enrichOneArtist runs for real. This exercises the
 * full retryOneArtist → enrichOneArtist path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as DrainBacklogModule from '$lib/server/plugins/runtime/drain-backlog.js';

// ─── enrichArtistFromChain mock ───────────────────────────────────────────────
const { mockEnrichArtistFromChain } = vi.hoisted(() => ({
    mockEnrichArtistFromChain: vi.fn(),
}));

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

vi.mock('$lib/server/services/artist-enrichment-sources.js', () => ({
    enrichArtistFromChain: mockEnrichArtistFromChain,
    ALL_SOURCES: [
        { value: 'theaudiodb', label: 'TheAudioDB' },
        { value: 'discogs', label: 'Discogs' },
    ],
    DEFAULT_PRIMARY: 'theaudiodb',
    DEFAULT_FALLBACK: 'discogs',
}));

// ─── getTaskSettings mock ─────────────────────────────────────────────────────
const { mockGetTaskSettings } = vi.hoisted(() => ({
    mockGetTaskSettings: vi.fn(),
}));

vi.mock('$lib/server/database/queries/task-settings.queries.js', () => ({
    getTaskSettings: mockGetTaskSettings,
    upsertTaskSettings: vi.fn().mockResolvedValue(undefined),
}));

// ─── artist-enrichment queries mock ──────────────────────────────────────────
const { mockDeferArtist } = vi.hoisted(() => ({ mockDeferArtist: vi.fn() }));
vi.mock('$lib/server/database/queries/artist-enrichment.queries.js', () => ({
    getArtistEnrichmentBacklog: vi.fn().mockResolvedValue({
        analyzed: 0,
        remaining: 0,
        ineligible: 0,
        failed: 0,
    }),
    countUnenrichedArtists: vi.fn().mockResolvedValue(0),
    getArtistEnrichmentWipeBatch: vi.fn().mockResolvedValue([]),
    atomicallyWipeArtistEnrichment: vi.fn().mockResolvedValue(0),
    getUnenrichedArtists: vi.fn().mockResolvedValue([]),
    getArtistMusicBrainzId: vi.fn().mockResolvedValue(null),
    markArtistProcessed: vi.fn().mockResolvedValue(true),
    mergeArtistEnrichmentMetadata: vi.fn().mockResolvedValue(undefined),
    updateArtistPosterUrls: vi.fn().mockResolvedValue(undefined),
    deferArtistAfterSourceOutage: mockDeferArtist,
}));

// ─── drain-backlog mock (plugin uses it at module load in execute()) ──────────
vi.mock('$lib/server/plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return {
        ...actual,
        drainBacklog: vi.fn().mockResolvedValue({ stopReason: 'empty' }),
    };
});

// ─── CatalogService mock (used inside enrichOneArtist tx) ─────────────────────
vi.mock('$lib/server/services/catalog.service.js', () => ({
    CatalogService: vi.fn().mockImplementation(() => ({
        upsertExternalIdDetailed: vi.fn().mockResolvedValue({ written: true, changed: true }),
    })),
}));

// ─── plugin-failure-events mock ───────────────────────────────────────────────
vi.mock('$lib/server/database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));

// ─── stage-state.queries mock ─────────────────────────────────────────────────
// Mocked (not left to run for real) so these coverage-row writes don't consume
// slots from the `rows` array the sql mock replays in order — they're
// orthogonal to processing_state and covered by their own dedicated tests.
vi.mock('$lib/server/database/queries/stage-state.queries.js', () => ({
    upsertCompletedRow: vi.fn().mockResolvedValue(undefined),
    upsertSkippedPermanentRow: vi.fn().mockResolvedValue(undefined),
    recordStageAttemptFailure: vi.fn().mockResolvedValue(1),
}));

import { artistEnrichmentTask } from '../artist-enrichment.js';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type SqlMock = ReturnType<typeof vi.fn> & {
    begin: ReturnType<typeof vi.fn>;
};

/**
 * Build a tagged-template sql mock that resolves calls in order from `rows`.
 * `.begin(fn)` calls fn with the same mock (simulates a transaction).
 * `.json(v)` is a passthrough so sql.json() inside tagged templates doesn't throw.
 */
function makeSqlFn(rows: Array<Array<Record<string, unknown>>>): SqlMock {
    let i = 0;
    const fn = vi.fn((..._args: unknown[]) => Promise.resolve(rows[i++] ?? []));
    const beginFn = vi.fn((txFn: (sql: unknown) => Promise<unknown>) => txFn(fn));
    return Object.assign(fn, { begin: beginFn, json: (v: unknown) => v });
}

type Input = Record<string, unknown>;

function makeCtx(rows: Array<Array<Record<string, unknown>>>): TaskContext<Input> {
    const ac = new AbortController();
    return {
        runId: 'test-job-retry',
        attemptNumber: 1,
        input: {},
        scope: {},
        mode: 'scheduled',
        sql: makeSqlFn(rows) as never,
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
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
    } as unknown as TaskContext<Input>;
}

const VALID_UUID = '00000000-0000-0000-0000-000000000001';

/** Settings with no Discogs in chain. */
function settingsAudiodbOnly(): Record<string, unknown> {
    return {
        primary_source: 'theaudiodb',
        fallback_source: 'none',
        tertiary_source: 'none',
        discogs_token: '',
    };
}

/** Settings where Discogs is in chain but token is missing. */
function settingsDiscogsNoToken(): Record<string, unknown> {
    return {
        primary_source: 'discogs',
        fallback_source: 'none',
        tertiary_source: 'none',
        discogs_token: '',
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('artist-enrichment failures.retry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: valid settings, no Discogs
        mockGetTaskSettings.mockResolvedValue(settingsAudiodbOnly());
    });

    // 1. failures.retry is defined
    it('failures.retry is accessible on the task', () => {
        expect(typeof artistEnrichmentTask.failures?.retry).toBe('function');
    });

    // 2. Invalid UUID → no DB call, throws with invalid UUID reason
    it('throws with invalid UUID message without hitting the DB', async () => {
        const ctx = makeCtx([]);
        await expect(artistEnrichmentTask.failures!.retry!(ctx, 'not-a-uuid')).rejects.toThrow(
            /invalid/i,
        );
        expect(ctx.sql as unknown as SqlMock).not.toHaveBeenCalled();
    });

    // 3. Artist not found → throws with not-found reason
    it('throws not-found when the DB row is missing', async () => {
        const ctx = makeCtx([[]]);
        await expect(artistEnrichmentTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /not found/i,
        );
    });

    // 4. Missing Discogs token when Discogs is in chain → throws
    it('throws with Discogs-token error when Discogs is configured but token is absent', async () => {
        mockGetTaskSettings.mockResolvedValue(settingsDiscogsNoToken());
        // Artist row returned by SELECT
        const ctx = makeCtx([
            [{ id: VALID_UUID, title: 'Milo Fenwick', prior_audit_job_id: null }],
        ]);
        await expect(artistEnrichmentTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /discogs/i,
        );
    });

    // 5. enrichOneArtist returns 'enriched' → resolves (no throw)
    it('resolves when enrichment finds image and metadata', async () => {
        mockEnrichArtistFromChain.mockResolvedValue({
            thumbUrl: 'https://example.com/thumb.jpg',
            biography: 'Jazz legend',
            genre: 'Jazz',
            countryCode: 'US',
            musicBrainzId: null,
            fanartUrl: null,
        });

        // Calls (shared fn, begin re-uses it):
        //   0: SELECT artist
        //   1: updateArtistPosterUrls UPDATE (inside tx)
        //   2: mergeArtistEnrichmentMetadata UPDATE (inside tx, because biography/genre/countryCode set)
        //   3: markArtistProcessed UPDATE (inside tx) — returns true as long as it doesn't throw
        const ctx = makeCtx([
            [
                {
                    id: VALID_UUID,
                    title: 'Milo Fenwick',
                    prior_audit_job_id: null,
                },
            ], // SELECT artist
            [], // updateArtistPosterUrls (inside tx)
            [], // mergeArtistEnrichmentMetadata (inside tx)
            [], // markArtistProcessed (inside tx) → no throw = true
        ]);

        await expect(
            artistEnrichmentTask.failures!.retry!(ctx, VALID_UUID),
        ).resolves.toBeUndefined();

        expect(mockEnrichArtistFromChain).toHaveBeenCalledWith(
            'Milo Fenwick',
            ['theaudiodb'],
            expect.objectContaining({ signal: expect.anything() }),
        );
    });

    // 6. enrichOneArtist returns 'no-match' → resolves (no throw)
    it('resolves when no image was found (no-match is a terminal non-failed state)', async () => {
        // null result → no-match path
        mockEnrichArtistFromChain.mockResolvedValue(null);

        // Calls: [SELECT artist], [markArtistProcessed no-match]
        const ctx = makeCtx([
            [
                {
                    id: VALID_UUID,
                    title: 'Unknown Artist',
                    prior_audit_job_id: null,
                },
            ],
            [{ ok: true }], // markArtistProcessed returns truthy row
        ]);

        await expect(
            artistEnrichmentTask.failures!.retry!(ctx, VALID_UUID),
        ).resolves.toBeUndefined();
    });

    // 7. enrichOneArtist returns 'error' + marker reason read back → throws
    it('throws with reason from processing_state marker when enrichment errors', async () => {
        // Simulate a failure inside enrichArtistFromChain — enrichOneArtist catches it
        // and marks the row as failed (via mocked markArtistProcessed returning true),
        // then retryOneArtist reads back the reason via a raw SELECT.
        //
        // Raw sql call sequence (markArtistProcessed is mocked at the queries layer):
        //   0: SELECT artist (prior_audit_job_id)
        //   1: SELECT processing_state reason (after enrichOneArtist returns 'error')
        mockEnrichArtistFromChain.mockRejectedValue(new Error('HTTP 503 from TheAudioDB'));

        const ctx = makeCtx([
            [
                {
                    id: VALID_UUID,
                    title: 'Milo Fenwick',
                    prior_audit_job_id: null,
                },
            ], // SELECT artist
            [{ reason: 'HTTP 503 from TheAudioDB' }], // SELECT processing_state reason
        ]);

        await expect(artistEnrichmentTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /HTTP 503/,
        );
    });

    // 7b. a source did not answer → failure that names it, no marker read-back
    it.each([
        [true, /unavailable: deezer; the artist will be retried later/],
        [false, /unavailable: deezer; try again later/],
    ])('reports a deferral (parked=%s) as a failure naming the source', async (parked, reason) => {
        const { ArtistEnrichmentIncompleteError } =
            await import('../../../../services/artist-enrichment.types.js');
        mockEnrichArtistFromChain.mockRejectedValue(
            new ArtistEnrichmentIncompleteError('source-unavailable', ['deezer']),
        );
        mockDeferArtist.mockResolvedValue(parked);
        // Only the artist SELECT: the deferral is mocked at the queries
        // layer and no failed-marker reason is read back.
        const ctx = makeCtx([
            [{ id: VALID_UUID, title: 'Milo Fenwick', prior_audit_job_id: null }],
        ]);

        await expect(artistEnrichmentTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            reason,
        );
        expect(ctx.sql).toHaveBeenCalledTimes(1);
    });

    // 8. getTaskSettings throws → outer catch in retryOneArtist → throws
    it('throws with error message when retryOneArtist outer catch fires', async () => {
        // Make getTaskSettings throw to simulate an unexpected error after artist SELECT
        const ctx = makeCtx([
            [{ id: VALID_UUID, title: 'Milo Fenwick', prior_audit_job_id: null }],
        ]);
        mockGetTaskSettings.mockRejectedValue(new Error('DB pool exhausted'));

        await expect(artistEnrichmentTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /DB pool exhausted/,
        );
    });
});
