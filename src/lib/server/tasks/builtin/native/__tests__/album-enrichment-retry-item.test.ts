// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * album-enrichment failures.retry — unit tests.
 *
 * Covers the retryOneAlbum path via the native task's failures.retry hook:
 *   - UUID validation (no DB hit) — throws with "Invalid album id"
 *   - Album not found — throws with "Album not found"
 *   - Missing Discogs token when Discogs is in chain — throws
 *   - enrichOneAlbum returns 'enriched' → resolves (no throw)
 *   - enrichOneAlbum returns 'no-match' → throws "No image found"
 *   - enrichOneAlbum returns 'failed' → throws with reason read back
 *   - enrichOneAlbum outer catch fires → throws with error message
 *
 * Mock strategy: vi.mock enrichAlbumFromChain (the HTTP layer) and
 * getTaskSettings so enrichOneAlbum runs for real. This exercises the full
 * retryOneAlbum → enrichOneAlbum path.
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

// ─── enrichAlbumFromChain mock ────────────────────────────────────────────────
const { mockEnrichAlbumFromChain } = vi.hoisted(() => ({
    mockEnrichAlbumFromChain: vi.fn(),
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

vi.mock('../../../../services/album-enrichment-sources.js', () => ({
    enrichAlbumFromChain: mockEnrichAlbumFromChain,
    ALL_SOURCES: [
        { value: 'theaudiodb', label: 'TheAudioDB (free, no key)' },
        { value: 'discogs', label: 'Discogs (requires token)' },
    ],
    DEFAULT_PRIMARY: 'theaudiodb',
    DEFAULT_FALLBACK: 'discogs',
}));

// ─── getTaskSettings mock ─────────────────────────────────────────────────────
const { mockGetTaskSettings } = vi.hoisted(() => ({
    mockGetTaskSettings: vi.fn(),
}));

vi.mock('../../../../database/queries/task-settings.queries.js', () => ({
    getTaskSettings: mockGetTaskSettings,
    upsertTaskSettings: vi.fn().mockResolvedValue(undefined),
}));

// ─── drain-backlog mock ───────────────────────────────────────────────────────
import type * as DrainBacklogModule from '../../../../plugins/runtime/drain-backlog.js';
vi.mock('../../../../plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return { ...actual, drainBacklog: vi.fn() };
});

// ─── CatalogService mock ──────────────────────────────────────────────────────
vi.mock('../../../../services/catalog.service.js', () => ({
    CatalogService: class {
        upsertExternalId = vi.fn().mockResolvedValue(undefined);
    },
}));

// ─── plugin-failure-events mock ───────────────────────────────────────────────
vi.mock('../../../../database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));

// ─── stage-state.queries mock ─────────────────────────────────────────────────
// Mocked (not left to run for real) so these coverage-row writes don't consume
// slots from the `rows` array the sql mock replays in order — they're
// orthogonal to processing_state and covered by their own dedicated tests.
vi.mock('../../../../database/queries/stage-state.queries.js', () => ({
    upsertCompletedRow: vi.fn().mockResolvedValue(undefined),
    upsertSkippedPermanentRow: vi.fn().mockResolvedValue(undefined),
    recordStageAttemptFailure: vi.fn().mockResolvedValue(1),
}));

vi.mock('../../../../database/queries/music-enrichment-provenance.queries.js', () => ({
    persistAlbumCoverArtFallback: vi.fn(async (sql, id, value) => {
        const { setAlbumCoverArtUrlIfNull } =
            await import('../../../../database/queries/album-enrichment.queries.js');
        return setAlbumCoverArtUrlIfNull(sql, id, value);
    }),
    writableAlbumArtwork: vi.fn().mockResolvedValue({ poster: true, backdrop: true }),
    getAlbumEnrichmentArtworkPaths: vi.fn().mockResolvedValue([]),
    mergeMusicProvenance: vi.fn().mockResolvedValue(undefined),
}));
// ─── album-enrichment.queries mock ────────────────────────────────────────────
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
    updateAlbumPosterUrls: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined),
}));

// ─── Other heavy deps ─────────────────────────────────────────────────────────
vi.mock('../../../../database/queries/media-artwork.queries.js', () => ({
    upsertLocalArtwork: vi.fn().mockResolvedValue(undefined),
    lockArtworkOwners: vi.fn().mockResolvedValue(undefined),
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

function makeCtx(
    rows: Array<Array<Record<string, unknown>>>,
): TaskContext<Record<string, unknown>> {
    const ac = new AbortController();
    return {
        sql: makeSqlFn(rows) as never,
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-job-retry',
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
        // Album-enrichment.failures.retry walks the same code paths as the
        // task's main execute, which gate external lookups behind `ctx.http`.
        // Without a stub these tests trip the capability check before they
        // reach the assertion they intend to exercise.
        http: {
            get: vi.fn(async () => new Response('{}', { status: 200 })),
            post: vi.fn(async () => new Response('{}', { status: 200 })),
        },
    } as unknown as TaskContext<Record<string, unknown>>;
}

const VALID_UUID = '00000000-0000-0000-0000-000000000001';

function settingsAudiodbOnly(): Record<string, unknown> {
    return {
        primary_source: 'theaudiodb',
        fallback_source: 'none',
        discogs_token: '',
    };
}

function settingsDiscogsNoToken(): Record<string, unknown> {
    return {
        primary_source: 'discogs',
        fallback_source: 'none',
        discogs_token: '',
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('album-enrichment failures.retry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetTaskSettings.mockResolvedValue(settingsAudiodbOnly());
    });

    // 1. retry is defined
    it('is defined on the task', () => {
        expect(typeof albumEnrichmentTask.failures?.retry).toBe('function');
    });

    // 2. Invalid UUID → throws without hitting the DB
    it('throws with invalid-uuid error without hitting the DB', async () => {
        const ctx = makeCtx([]);
        await expect(albumEnrichmentTask.failures!.retry!(ctx, 'not-a-uuid')).rejects.toThrow(
            /invalid/i,
        );
        expect(ctx.sql as unknown as SqlMock).not.toHaveBeenCalled();
    });

    // 3. Album not found → throws
    it('throws not-found when the DB row is missing', async () => {
        const ctx = makeCtx([[]]); // empty SELECT result
        await expect(albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /not found/i,
        );
    });

    // 4. Missing Discogs token when Discogs is in chain → throws
    it('throws Discogs-token error when Discogs is configured but token is absent', async () => {
        mockGetTaskSettings.mockResolvedValue(settingsDiscogsNoToken());
        const ctx = makeCtx([
            [
                {
                    id: VALID_UUID,
                    title: 'Kind of Dawn',
                    parent_id: null,
                    parent_title: 'Milo Fenwick',
                    prior_audit_job_id: null,
                },
            ],
        ]);
        await expect(albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /discogs/i,
        );
    });

    // 5. enrichOneAlbum returns 'enriched' → resolves without throwing
    it('resolves when enrichment finds image and metadata', async () => {
        mockEnrichAlbumFromChain.mockResolvedValue({
            posterUrl: 'https://example.com/cover.jpg',
            backdropUrl: null,
            releaseMbid: null,
            releaseGroupMbid: 'mbid-rg-test',
        });

        const { upsertLocalArtwork } =
            await import('../../../../database/queries/media-artwork.queries.js');
        vi.mocked(upsertLocalArtwork).mockResolvedValue(true);

        const ctx = makeCtx([
            [
                {
                    id: VALID_UUID,
                    title: 'Kind of Dawn',
                    parent_id: 'artist-001',
                    parent_title: 'Milo Fenwick',
                    prior_audit_job_id: null,
                },
            ],
            [],
        ]);

        // The image-bytes fetch goes through `ctx.http.get`. Return a
        // valid JPEG response so `fetchImageBytes` can record success.
        (ctx.http!.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
            new Response(new ArrayBuffer(100), {
                status: 200,
                headers: { 'content-type': 'image/jpeg' },
            }),
        );

        // enrichAlbumFromChain was called with the artist name
        // The key assertion: retry does not throw.
        await expect(
            albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID),
        ).resolves.toBeUndefined();

        expect(mockEnrichAlbumFromChain).toHaveBeenCalledWith(
            'Milo Fenwick',
            'Kind of Dawn',
            ['theaudiodb', 'deezer'],
            expect.objectContaining({ signal: expect.anything() }),
        );
    });

    // 6. enrichOneAlbum returns 'no-match' → throws with "No image found"
    it('throws "No image found" when no image was found', async () => {
        mockEnrichAlbumFromChain.mockResolvedValue(null);

        const ctx = makeCtx([
            [
                {
                    id: VALID_UUID,
                    title: 'Unknown Album',
                    parent_id: 'artist-001',
                    parent_title: 'Test Artist',
                    prior_audit_job_id: null,
                },
            ],
            [],
        ]);

        await expect(albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /no image/i,
        );
    });

    // 7. enrichOneAlbum throws → throws with reason
    it('throws when enrichAlbumFromChain throws', async () => {
        mockEnrichAlbumFromChain.mockRejectedValueOnce(new Error('HTTP 503 from TheAudioDB'));

        const ctx = makeCtx([
            [
                {
                    id: VALID_UUID,
                    title: 'Kind of Dawn',
                    parent_id: 'artist-001',
                    parent_title: 'Milo Fenwick',
                    prior_audit_job_id: null,
                },
            ],
            [{ reason: 'HTTP 503 from TheAudioDB' }],
        ]);

        await expect(albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /HTTP 503/,
        );
    });

    // 8. Outer catch fires when getTaskSettings throws
    it('throws when outer catch fires (e.g. getTaskSettings throws)', async () => {
        const ctx = makeCtx([
            [
                {
                    id: VALID_UUID,
                    title: 'Kind of Dawn',
                    parent_id: null,
                    parent_title: null,
                    prior_audit_job_id: null,
                },
            ],
        ]);
        mockGetTaskSettings.mockRejectedValueOnce(new Error('DB pool exhausted'));

        await expect(albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /DB pool exhausted/,
        );
    });

    // 9. Album with no parent_title → no_parent_artist failure → throws
    it('throws no_parent_artist failure for orphan albums', async () => {
        mockGetTaskSettings.mockResolvedValue(settingsAudiodbOnly());
        mockEnrichAlbumFromChain.mockResolvedValue(null);

        const ctx = makeCtx([
            [
                {
                    id: VALID_UUID,
                    title: 'Orphan Album',
                    parent_id: null,
                    parent_title: null,
                    prior_audit_job_id: null,
                },
            ],
            [{ reason: 'no_parent_artist' }],
        ]);

        await expect(albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /no_parent_artist/,
        );
    });
});
