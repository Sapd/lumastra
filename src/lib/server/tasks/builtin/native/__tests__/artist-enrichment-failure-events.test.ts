// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * artist-enrichment Phase G failure-events wiring — unit tests.
 *
 * Verifies that:
 *   1. enrichOneArtist's catch block calls recordFailure with pluginId='artist-enrichment'
 *      after markArtistProcessed returns true.
 *   2. recordFailure is NOT called when markArtistProcessed returns false.
 *   3. failures.list calls getFailureAggregates and merges the result.
 *   4. failures.list tolerates missing aggregates (fields absent when no events recorded).
 *   5. Regression (durable-failure-writes-terminal-row): the catch block also
 *      records a bounded-attempt `media_item_stage_state` coverage failure via
 *      `recordStageAttemptFailure` so the row leaves `pending` instead of being
 *      re-fetched by every drain slice forever. Not called when the
 *      processing_state mark-write itself failed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as DrainBacklogModule from '$lib/server/plugins/runtime/drain-backlog.js';

// ─── hoist all mocks ─────────────────────────────────────────────────────────
const {
    mockRecordFailure,
    mockGetFailureAggregates,
    mockEnrichArtistFromChain,
    mockGetTaskSettings,
    mockMarkArtistProcessed,
    mockUpsertCompletedRow,
    mockUpsertSkippedPermanentRow,
    mockRecordStageAttemptFailure,
} = vi.hoisted(() => ({
    mockRecordFailure: vi.fn().mockResolvedValue(undefined),
    mockGetFailureAggregates: vi.fn().mockResolvedValue(new Map()),
    mockEnrichArtistFromChain: vi.fn(),
    mockGetTaskSettings: vi.fn(),
    mockMarkArtistProcessed: vi.fn().mockResolvedValue(true),
    mockUpsertCompletedRow: vi.fn().mockResolvedValue(undefined),
    mockUpsertSkippedPermanentRow: vi.fn().mockResolvedValue(undefined),
    mockRecordStageAttemptFailure: vi.fn().mockResolvedValue(1),
}));

// ─── plugin-failure-events mock ───────────────────────────────────────────────
vi.mock('$lib/server/database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: mockRecordFailure,
    getFailureAggregates: mockGetFailureAggregates,
}));

// ─── stage-state.queries mock ─────────────────────────────────────────────────
vi.mock('$lib/server/database/queries/stage-state.queries.js', () => ({
    upsertCompletedRow: mockUpsertCompletedRow,
    upsertSkippedPermanentRow: mockUpsertSkippedPermanentRow,
    recordStageAttemptFailure: mockRecordStageAttemptFailure,
}));

// ─── enrichArtistFromChain mock ───────────────────────────────────────────────
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
vi.mock('$lib/server/database/queries/task-settings.queries.js', () => ({
    getTaskSettings: mockGetTaskSettings,
    upsertTaskSettings: vi.fn().mockResolvedValue(undefined),
}));

// ─── CatalogService mock ──────────────────────────────────────────────────────
vi.mock('$lib/server/services/catalog.service.js', () => ({
    CatalogService: vi.fn().mockImplementation(() => ({
        upsertExternalIdDetailed: vi.fn().mockResolvedValue({ written: true, changed: true }),
    })),
}));

// ─── artist-enrichment queries mock ──────────────────────────────────────────
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
    markArtistProcessed: mockMarkArtistProcessed,
    mergeArtistEnrichmentMetadata: vi.fn().mockResolvedValue(undefined),
    updateArtistPosterUrls: vi.fn().mockResolvedValue(undefined),
}));

// ─── drain-backlog mock ───────────────────────────────────────────────────────
vi.mock('$lib/server/plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return {
        ...actual,
        drainBacklog: vi.fn().mockResolvedValue({ stopReason: 'empty' }),
    };
});

import { enrichOneArtist, artistEnrichmentTask } from '../artist-enrichment.js';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_UUID = '00000000-0000-0000-0000-000000000001';
const VALID_UUID_2 = '00000000-0000-0000-0000-000000000002';

type Input = Record<string, unknown>;

function makePluginCtx(): TaskContext<Input> {
    const sql = vi.fn((..._args: unknown[]) => {
        return Promise.resolve([]);
    }) as unknown as TaskContext<Input>['sql'];
    (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

    const ac = new AbortController();
    return {
        runId: 'test-run-1',
        attemptNumber: 1,
        input: {},
        scope: {},
        mode: 'scheduled',
        sql,
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('artist-enrichment Phase G failure-events wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(mockGetFailureAggregates).mockResolvedValue(new Map());
        vi.mocked(mockMarkArtistProcessed).mockResolvedValue(true);
        vi.mocked(mockUpsertCompletedRow).mockResolvedValue(undefined);
        vi.mocked(mockUpsertSkippedPermanentRow).mockResolvedValue(undefined);
        vi.mocked(mockRecordStageAttemptFailure).mockResolvedValue(1);
        // Use theaudiodb-only chain so we don't hit the Discogs-no-token guard.
        mockGetTaskSettings.mockResolvedValue({
            primary_source: 'theaudiodb',
            fallback_source: 'none',
            discogs_token: '',
        });
    });

    // ── Case 1: recordFailure called after markArtistProcessed returns true ────

    describe('enrichOneArtist catch block: markArtistProcessed returns true', () => {
        it('calls recordFailure with pluginId artist-enrichment and the correct artist.id', async () => {
            // enrichArtistFromChain throws → drives the catch block
            mockEnrichArtistFromChain.mockRejectedValueOnce(new Error('HTTP 503 from TheAudioDB'));
            // markArtistProcessed returns true (default)

            const ctx = makePluginCtx();
            await enrichOneArtist(
                ctx.sql as never,
                ctx.logger as never,
                { id: VALID_UUID, title: 'Milo Fenwick' },
                ['theaudiodb'],
                '',
                ctx.signal,
                'test-job-retry',
            );

            expect(vi.mocked(mockRecordFailure)).toHaveBeenCalledOnce();
            const [, pluginId, itemKey, reason] = vi.mocked(mockRecordFailure).mock.calls[0];
            expect(pluginId).toBe('artist-enrichment');
            expect(itemKey).toBe(VALID_UUID);
            expect(reason).toContain('503');

            // Regression: the durable stage_state row must also leave
            // `pending` — otherwise a coverage-table drain re-fetches this
            // artist forever even though processing_state already recorded
            // the failure. recordStageAttemptFailure is the bounded-attempt
            // writer (backoff + eventual failed_permanent promotion).
            expect(vi.mocked(mockRecordStageAttemptFailure)).toHaveBeenCalledOnce();
            const [, attemptInput] = vi.mocked(mockRecordStageAttemptFailure).mock.calls[0];
            expect(attemptInput).toMatchObject({
                mediaItemId: VALID_UUID,
                stageId: 'artist-enrichment',
                error: { code: 'enrich_threw', retryable: true },
            });
            expect(attemptInput.error.message).toContain('503');
            expect(attemptInput.backoffMs).toBeGreaterThan(0);
            expect(attemptInput.maxAttempts).toBeGreaterThan(0);
        });
    });

    // ── Case 2: recordFailure NOT called when markArtistProcessed returns false ─

    describe('enrichOneArtist catch block: markArtistProcessed returns false', () => {
        it('does not call recordFailure when markArtistProcessed throws (ok=false)', async () => {
            mockEnrichArtistFromChain.mockRejectedValueOnce(new Error('HTTP 503 from TheAudioDB'));
            // Make markArtistProcessed throw so the catch block propagates the error
            // (ok=false path — mark-write fails means the exception from markArtistProcessed
            // bubbles up; recordFailure must NOT be called in this case).
            vi.mocked(mockMarkArtistProcessed).mockRejectedValueOnce(new Error('DB write failed'));

            const ctx = makePluginCtx();
            // enrichOneArtist throws when markArtistProcessed throws from inside the catch block
            await enrichOneArtist(
                ctx.sql as never,
                ctx.logger as never,
                { id: VALID_UUID, title: 'Milo Fenwick' },
                ['theaudiodb'],
                '',
                ctx.signal,
                'test-job-retry',
            ).catch(() => undefined); // swallow the propagated exception

            expect(vi.mocked(mockRecordFailure)).not.toHaveBeenCalled();
            // Mirrors recordFailure: when the mark-write itself failed we
            // don't know the row's true state, so we must not write a
            // coverage row either (same DB is likely down anyway).
            expect(vi.mocked(mockRecordStageAttemptFailure)).not.toHaveBeenCalled();
        });
    });

    // ── Case 3: failures.list merges aggregates into response ────────────────

    describe('failures.list: merges aggregates into response items', () => {
        it('populates firstSeen, failureCount, lastSeen when aggregate exists for a row', async () => {
            const firstSeen = new Date('2026-01-01T00:00:00Z');
            const lastSeen = new Date('2026-01-10T00:00:00Z');
            const agg = {
                plugin_id: 'artist-enrichment',
                item_id: VALID_UUID,
                failure_count: 3,
                first_seen: firstSeen,
                last_seen: lastSeen,
            };
            vi.mocked(mockGetFailureAggregates).mockResolvedValueOnce(new Map([[VALID_UUID, agg]]));

            const row = {
                id: VALID_UUID,
                title: 'Milo Fenwick',
                processing_state: {
                    'artist-enrichment': {
                        version: 3,
                        status: 'failed',
                        reason: 'HTTP 404 from TheAudioDB',
                    },
                },
                task_history_id: null,
            };

            const ctx = makePluginCtx();
            let sqlCallIndex = 0;
            vi.mocked(ctx.sql as unknown as ReturnType<typeof vi.fn>).mockImplementation(
                (..._args: unknown[]) => {
                    sqlCallIndex++;
                    if (sqlCallIndex === 1) return Promise.resolve([{ count: 1 }]);
                    return Promise.resolve([row]);
                },
            );

            const result = await artistEnrichmentTask.failures!.list(ctx, {
                limit: 10,
                offset: 0,
            });

            const item = result.items[0];
            expect(item.firstSeen).toBe(firstSeen.toISOString());
            expect(item.failureCount).toBe(3);
            expect(item.lastSeen).toBe(lastSeen.toISOString());
        });
    });

    // ── Case 4: failures.list tolerates missing aggregates ─────────────────

    describe('failures.list: tolerates missing aggregates', () => {
        it('leaves firstSeen/failureCount/lastSeen undefined when no aggregate exists for a row', async () => {
            const row = {
                id: VALID_UUID_2,
                title: 'Jon Fenwick',
                processing_state: {
                    'artist-enrichment': {
                        version: 3,
                        status: 'failed',
                        reason: 'HTTP 404 from TheAudioDB',
                    },
                },
                task_history_id: null,
            };

            const ctx = makePluginCtx();
            let sqlCallIndex = 0;
            vi.mocked(ctx.sql as unknown as ReturnType<typeof vi.fn>).mockImplementation(
                (..._args: unknown[]) => {
                    sqlCallIndex++;
                    if (sqlCallIndex === 1) return Promise.resolve([{ count: 1 }]);
                    return Promise.resolve([row]);
                },
            );

            const result = await artistEnrichmentTask.failures!.list(ctx, {
                limit: 10,
                offset: 0,
            });

            const item = result.items[0];
            expect(item.firstSeen).toBeUndefined();
            expect(item.failureCount).toBeUndefined();
            expect(item.lastSeen).toBeUndefined();
        });
    });
});
