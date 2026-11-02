// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * album-enrichment failures.list — unit tests.
 *
 * The implementation queries media_items.processing_state for rows
 * with 'album-enrichment' status = 'failed'. We mock ctx.sql.
 *
 * Covers:
 *   - Returns empty result when no albums have failed enrichment.
 *   - Returns failed albums with correct shape (id, label, reason, detectedAt,
 *     taskRunId, firstSeen, failureCount, lastSeen).
 *   - Falls back reason to 'Enrichment failed' when reason is missing.
 *   - Stale-version failures (version < PROCESSING_VERSION) are excluded.
 *   - Albums with status='success' or 'no-match' are excluded.
 *   - Pagination: limit and offset are forwarded to the query.
 *   - taskRunId is populated from task_history JOIN when present.
 *   - taskRunId is undefined when no matching task_history row.
 *   - Aggregate fields (firstSeen, failureCount, lastSeen) populated when
 *     getFailureAggregates returns a matching entry.
 *   - Aggregate fields absent when getFailureAggregates returns empty Map.
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

// ─── plugin-failure-events mock ───────────────────────────────────────────────
vi.mock('../../../../database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));

// ─── enrichAlbumFromChain mock ────────────────────────────────────────────────
vi.mock('../../../../services/album-enrichment-sources.js', () => ({
    enrichAlbumFromChain: vi.fn().mockResolvedValue(null),
    ALL_SOURCES: [
        { value: 'theaudiodb', label: 'TheAudioDB (free, no key)' },
        { value: 'discogs', label: 'Discogs (requires token)' },
    ],
    DEFAULT_PRIMARY: 'theaudiodb',
    DEFAULT_FALLBACK: 'discogs',
}));

// ─── task-settings mock ───────────────────────────────────────────────────────
vi.mock('../../../../database/queries/task-settings.queries.js', () => ({
    getTaskSettings: vi.fn().mockResolvedValue({
        primary_source: 'theaudiodb',
        fallback_source: 'none',
        discogs_token: '',
    }),
    upsertTaskSettings: vi.fn().mockResolvedValue(undefined),
}));

// ─── CatalogService mock ──────────────────────────────────────────────────────
vi.mock('../../../../services/catalog.service.js', () => ({
    CatalogService: vi.fn().mockImplementation(() => ({
        upsertExternalId: vi.fn().mockResolvedValue(undefined),
    })),
}));

// ─── drain-backlog mock ───────────────────────────────────────────────────────
import type * as DrainBacklogModule from '../../../../plugins/runtime/drain-backlog.js';
vi.mock('../../../../plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return { ...actual, drainBacklog: vi.fn() };
});

// ─── album-enrichment.queries mock ───────────────────────────────────────────
vi.mock('../../../../database/queries/album-enrichment.queries.js', () => ({
    atomicallyWipeAlbumEnrichment: vi.fn().mockResolvedValue(undefined),
    countUnenrichedAlbums: vi.fn().mockResolvedValue(0),
    getAlbumEnrichmentBacklog: vi.fn().mockResolvedValue({
        analyzed: 0,
        remaining: 0,
        ineligible: 0,
        failed: 0,
    }),
    getAlbumEnrichmentWipeBatch: vi.fn().mockResolvedValue([]),
    getUnenrichedAlbums: vi.fn().mockResolvedValue([]),
    markAlbumProcessed: vi.fn().mockResolvedValue(true),
    setAlbumCoverArtUrlIfNull: vi.fn().mockResolvedValue(true),
    recordFailure: vi.fn().mockResolvedValue(undefined),
}));

// ─── Other heavy deps ─────────────────────────────────────────────────────────
vi.mock('../../../../database/queries/media-artwork.queries.js', () => ({
    upsertLocalArtwork: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../database/queries/album-art.queries.js', () => ({
    findTrackFileForAlbum: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../services/metadata-storage.service.js', () => ({
    resolveWritePath: vi.fn().mockResolvedValue({ filePath: '/tmp/test/poster.jpg' }),
}));
vi.mock('$lib/server/providers/implementations/musicbrainz/cover-art.js', () => ({
    getAlbumArt: vi.fn().mockResolvedValue(null),
    getAlbumArtUrl: vi.fn((mbid: string) => `https://coverartarchive.org/release/${mbid}/front`),
}));
vi.mock('../../../../utils/fetch-utils.js', () => ({
    fetchWithTimeout: vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'test' }),
}));
vi.mock('$lib/server/config.js', () => ({
    config: { BASE_PATH: '/data' },
    // registry.ts (imported transitively) reads this at module load.
    FEATURE_PER_TASK_QUEUES: false,
}));

import { albumEnrichmentTask } from '../album-enrichment.js';
import { getFailureAggregates } from '../../../../database/queries/plugin-failure-events.queries.js';
import type { FailureAggregateRow } from '../../../../database/queries/plugin-failure-events.queries.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PROCESSING_VERSION = 1;

function makeCtx(sqlCalls: unknown[][]): TaskContext<Record<string, unknown>> {
    let callIndex = 0;
    const sql = vi.fn((..._args: unknown[]) => {
        const result = sqlCalls[callIndex] ?? [];
        callIndex++;
        return Promise.resolve(result);
    });

    const ac = new AbortController();
    return {
        sql,
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run',
        input: {},
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn().mockReturnThis(),
        },
        reportProgress: vi.fn(),
        dep: vi.fn(),
        settings: vi.fn(),
        secrets: { get: vi.fn(), getOptional: vi.fn(), getUser: vi.fn() },
        reportFailure: vi.fn(),
        spend: vi.fn(),
        drain: vi.fn(),
    } as unknown as TaskContext<Record<string, unknown>>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('album-enrichment failures.list', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getFailureAggregates).mockResolvedValue(new Map());
    });

    // ── Structural check ──────────────────────────────────────────────────────

    it('is defined on the task', () => {
        expect(typeof albumEnrichmentTask.failures?.list).toBe('function');
    });

    // ── Empty case ────────────────────────────────────────────────────────────

    it('returns empty result when no albums have failed enrichment', async () => {
        const ctx = makeCtx([[{ count: 0 }], []]);
        const result = await albumEnrichmentTask.failures!.list!(ctx, {
            limit: 10,
            offset: 0,
        });
        expect(result.total).toBe(0);
        expect(result.items).toHaveLength(0);
    });

    // ── Correct shape ─────────────────────────────────────────────────────────

    it('returns failed albums with correct shape', async () => {
        const failedAlbum = {
            id: 'album-001',
            title: 'Kind of Dawn',
            processing_state: {
                'album-enrichment': {
                    version: PROCESSING_VERSION,
                    status: 'failed',
                    reason: 'HTTP 404 from TheAudioDB',
                    audit_run_job_id: 'job-1',
                },
            },
            task_history_id: null,
        };

        const ctx = makeCtx([[{ count: 1 }], [failedAlbum]]);
        const result = await albumEnrichmentTask.failures!.list!(ctx, {
            limit: 10,
            offset: 0,
        });

        expect(result.total).toBe(1);
        expect(result.items).toHaveLength(1);

        const item = result.items[0];
        expect(item.id).toBe('album-001');
        expect(item.label).toBe('Kind of Dawn');
        expect(item.reason).toBe('HTTP 404 from TheAudioDB');
        expect(item.detectedAt).toBeNull();
    });

    // ── Reason fallback ───────────────────────────────────────────────────────

    it('falls back reason to "Enrichment failed" when reason is missing', async () => {
        const failedAlbum = {
            id: 'album-002',
            title: 'Unknown Album',
            processing_state: {
                'album-enrichment': {
                    version: PROCESSING_VERSION,
                    status: 'failed',
                },
            },
            task_history_id: null,
        };

        const ctx = makeCtx([[{ count: 1 }], [failedAlbum]]);
        const result = await albumEnrichmentTask.failures!.list!(ctx, {
            limit: 10,
            offset: 0,
        });
        expect(result.items[0].reason).toBe('Enrichment failed');
    });

    // ── Stale version excluded ────────────────────────────────────────────────

    it('excludes albums with stale-version failed marker — count and rows both return 0', async () => {
        // The SQL predicate requires version >= PROCESSING_VERSION.
        // A stale row at version 0 would be re-admitted to `remaining` and
        // should never appear in the failed drilldown.
        const ctx = makeCtx([[{ count: 0 }], []]);
        const result = await albumEnrichmentTask.failures!.list!(ctx, {
            limit: 10,
            offset: 0,
        });
        expect(result.total).toBe(0);
        expect(result.items).toHaveLength(0);
    });

    // ── success / no-match excluded ───────────────────────────────────────────

    it('excludes albums with success status (DB filters on status=failed)', async () => {
        const ctx = makeCtx([[{ count: 0 }], []]);
        const result = await albumEnrichmentTask.failures!.list!(ctx, {
            limit: 10,
            offset: 0,
        });
        expect(result.total).toBe(0);
    });

    it('excludes albums with no-match status (DB filters on status=failed)', async () => {
        const ctx = makeCtx([[{ count: 0 }], []]);
        const result = await albumEnrichmentTask.failures!.list!(ctx, {
            limit: 10,
            offset: 0,
        });
        expect(result.total).toBe(0);
    });

    // ── Pagination ────────────────────────────────────────────────────────────

    it('forwards limit and offset to the query (pagination)', async () => {
        const albums = Array.from({ length: 3 }, (_, i) => ({
            id: `album-pag-${i}`,
            title: `Album ${i}`,
            processing_state: {
                'album-enrichment': {
                    version: PROCESSING_VERSION,
                    status: 'failed',
                    reason: 'test',
                },
            },
            task_history_id: null,
        }));

        // count=10, but only 3 rows in this page — simulating limit=3, offset=7
        const ctx = makeCtx([[{ count: 10 }], albums]);
        const result = await albumEnrichmentTask.failures!.list!(ctx, {
            limit: 3,
            offset: 7,
        });
        expect(result.total).toBe(10);
        expect(result.items).toHaveLength(3);
    });

    it('clamps limit to 100', async () => {
        const ctx = makeCtx([[{ count: 0 }], []]);
        await expect(
            albumEnrichmentTask.failures!.list!(ctx, { limit: 500, offset: 0 }),
        ).resolves.not.toThrow();
    });

    // ── taskRunId ─────────────────────────────────────────────────────────────

    it('populates taskRunId from task_history JOIN', async () => {
        const failedAlbum = {
            id: 'album-003',
            title: 'A Lantern Supreme',
            processing_state: {
                'album-enrichment': {
                    version: PROCESSING_VERSION,
                    status: 'failed',
                    reason: 'HTTP 503',
                    audit_run_job_id: 'job-9999',
                },
            },
            task_history_id: 9999,
        };

        const ctx = makeCtx([[{ count: 1 }], [failedAlbum]]);
        const result = await albumEnrichmentTask.failures!.list!(ctx, {
            limit: 10,
            offset: 0,
        });
        expect(result.items[0].taskRunId).toBe(9999);
    });

    it('returns undefined taskRunId when no matching task_history row', async () => {
        const failedAlbum = {
            id: 'album-004',
            title: 'Lantern Brew',
            processing_state: {
                'album-enrichment': {
                    version: PROCESSING_VERSION,
                    status: 'failed',
                    reason: 'HTTP 503',
                },
            },
            task_history_id: null,
        };

        const ctx = makeCtx([[{ count: 1 }], [failedAlbum]]);
        const result = await albumEnrichmentTask.failures!.list!(ctx, {
            limit: 10,
            offset: 0,
        });
        expect(result.items[0].taskRunId).toBeUndefined();
    });

    // ── Aggregate fields ──────────────────────────────────────────────────────

    it('populates firstSeen, failureCount, lastSeen when aggregate exists', async () => {
        const firstSeen = new Date('2026-01-01T00:00:00Z');
        const lastSeen = new Date('2026-04-25T00:00:00Z');
        const agg: FailureAggregateRow = {
            plugin_id: 'album-enrichment',
            item_id: 'album-agg-1',
            failure_count: 5,
            first_seen: firstSeen,
            last_seen: lastSeen,
        };
        vi.mocked(getFailureAggregates).mockResolvedValueOnce(new Map([['album-agg-1', agg]]));

        const failedAlbum = {
            id: 'album-agg-1',
            title: 'Sketches of Harbors',
            processing_state: {
                'album-enrichment': {
                    version: PROCESSING_VERSION,
                    status: 'failed',
                    reason: 'fetch_failed: timeout',
                },
            },
            task_history_id: null,
        };

        const ctx = makeCtx([[{ count: 1 }], [failedAlbum]]);
        const result = await albumEnrichmentTask.failures!.list!(ctx, {
            limit: 10,
            offset: 0,
        });

        const item = result.items[0];
        expect(item.firstSeen).toBe(firstSeen.toISOString());
        expect(item.failureCount).toBe(5);
        expect(item.lastSeen).toBe(lastSeen.toISOString());
    });

    it('leaves firstSeen/failureCount/lastSeen undefined when no aggregate exists', async () => {
        vi.mocked(getFailureAggregates).mockResolvedValueOnce(new Map());

        const failedAlbum = {
            id: 'album-agg-2',
            title: 'Rowan and Tess',
            processing_state: {
                'album-enrichment': {
                    version: PROCESSING_VERSION,
                    status: 'failed',
                    reason: 'HTTP 404',
                },
            },
            task_history_id: null,
        };

        const ctx = makeCtx([[{ count: 1 }], [failedAlbum]]);
        const result = await albumEnrichmentTask.failures!.list!(ctx, {
            limit: 10,
            offset: 0,
        });

        const item = result.items[0];
        expect(item.firstSeen).toBeUndefined();
        expect(item.failureCount).toBeUndefined();
        expect(item.lastSeen).toBeUndefined();
    });

    // ── Multiple items ordering ───────────────────────────────────────────────

    it('returns multiple items preserving the order from the DB query', async () => {
        const rows = [
            {
                id: 'album-A',
                title: 'Album A',
                processing_state: {
                    'album-enrichment': {
                        version: PROCESSING_VERSION,
                        status: 'failed',
                        reason: 'err-A',
                    },
                },
                task_history_id: null,
            },
            {
                id: 'album-B',
                title: 'Album B',
                processing_state: {
                    'album-enrichment': {
                        version: PROCESSING_VERSION,
                        status: 'failed',
                        reason: 'err-B',
                    },
                },
                task_history_id: null,
            },
        ];

        const ctx = makeCtx([[{ count: 2 }], rows]);
        const result = await albumEnrichmentTask.failures!.list!(ctx, {
            limit: 10,
            offset: 0,
        });

        expect(result.total).toBe(2);
        expect(result.items[0].id).toBe('album-A');
        expect(result.items[1].id).toBe('album-B');
    });
});
