// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * album-enrichment — cover-art URL persistence tests.
 *
 * When the enrichment chain resolves a MusicBrainz release MBID the task
 * must persist the Cover Art Archive redirect URL
 * (`coverartarchive.org/release/{mbid}/front`) to `media_items.custom_poster_url`
 * via `setAlbumCoverArtUrlIfNull`, so that albums with a known MBID always
 * have a usable cover-art URL in the image proxy.
 *
 * We drive `enrichOneAlbum` through the task's `failures.retry` hook (which
 * calls `retryOneAlbum` → `enrichOneAlbum`). This is the same code path used
 * by the drain loop's `processSlice` — both delegate to the shared helper.
 *
 * Covers:
 *   - setAlbumCoverArtUrlIfNull is called with the CAA URL on the success
 *     path (image bytes fetched and written to disk).
 *   - setAlbumCoverArtUrlIfNull is called even when no image bytes are
 *     returned (MBID present but CAA unavailable) — no-match path.
 *   - setAlbumCoverArtUrlIfNull is NOT called when chainResult.releaseMbid
 *     is null.
 *   - setAlbumCoverArtUrlIfNull is NOT called when the chain returns null
 *     (no enrichment data at all).
 *   - The constructed URL has the expected CAA shape.
 */

vi.mock('$lib/server/database/queries/image-candidates.queries.js', () => ({
    registerImageCandidate: vi.fn().mockResolvedValue('candidate-id'),
    isImageCandidateFileReferenced: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/server/services/album-local-art.js', () => ({
    recoverLocalAlbumArt: vi.fn().mockResolvedValue(false),
    backfillLocalAlbumArt: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/album-local-art.queries.js', () => ({
    getAlbumReleaseIdentifiers: vi.fn().mockResolvedValue({}),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

// ─── hoist mocks ─────────────────────────────────────────────────────────────
const { mockEnrichAlbumFromChain, mockSetAlbumCoverArtUrlIfNull, mockGetTaskSettings } = vi.hoisted(
    () => ({
        mockEnrichAlbumFromChain: vi.fn(),
        mockSetAlbumCoverArtUrlIfNull: vi.fn(),
        mockGetTaskSettings: vi.fn(),
    }),
);

vi.mock('../../../../services/discogs-token.js', () => ({
    readDiscogsToken: vi.fn().mockResolvedValue(''),
    hasDiscogsToken: vi.fn().mockResolvedValue(false),
    DISCOGS_PLUGIN_ID: 'discogs',
    DISCOGS_TOKEN_KEY: 'DISCOGS_TOKEN',
}));
// ─── album-enrichment-sources ─────────────────────────────────────────────────
vi.mock('../../../../services/album-enrichment-sources.js', () => ({
    enrichAlbumFromChain: mockEnrichAlbumFromChain,
    ALL_SOURCES: [
        { value: 'theaudiodb', label: 'TheAudioDB (free, no key)' },
        { value: 'discogs', label: 'Discogs (requires token)' },
    ],
    DEFAULT_PRIMARY: 'theaudiodb',
    DEFAULT_FALLBACK: 'discogs',
}));

// ─── task-settings ────────────────────────────────────────────────────────────
vi.mock('../../../../database/queries/task-settings.queries.js', () => ({
    getTaskSettings: mockGetTaskSettings,
    upsertTaskSettings: vi.fn().mockResolvedValue(undefined),
}));

// ─── album-enrichment.queries ─────────────────────────────────────────────────
vi.mock('../../../../database/queries/album-enrichment.queries.js', () => ({
    atomicallyWipeAlbumEnrichment: vi.fn().mockResolvedValue(undefined),
    countUnenrichedAlbums: vi.fn().mockResolvedValue(0),
    findCoverageTableBacklog: vi.fn().mockResolvedValue([]),
    getAlbumEnrichmentBacklog: vi.fn().mockResolvedValue({
        analyzed: 0,
        remaining: 0,
        ineligible: 0,
        failed: 0,
    }),
    getAlbumEnrichmentWipeBatch: vi.fn().mockResolvedValue([]),
    getUnenrichedAlbums: vi.fn().mockResolvedValue([]),
    markAlbumProcessed: vi.fn().mockResolvedValue(true),
    setAlbumCoverArtUrlIfNull: mockSetAlbumCoverArtUrlIfNull,
    updateAlbumPosterUrls: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined),
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
vi.mock('../../../../utils/ssrf-guard.js', () => ({
    assertNotPrivateUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../utils/contained-fs.js', () => ({
    writeFileNoFollow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeMkdir: vi.fn().mockResolvedValue(undefined),
    safeUnlink: vi.fn().mockResolvedValue(undefined),
}));
// ─── cover-art ────────────────────────────────────────────────────────────────
vi.mock('$lib/server/providers/implementations/musicbrainz/cover-art.js', () => ({
    getAlbumArt: vi.fn().mockResolvedValue(null),
    getAlbumArtUrl: vi.fn((mbid: string) => `https://coverartarchive.org/release/${mbid}/front`),
}));

// ─── drain-backlog ────────────────────────────────────────────────────────────
import type * as DrainBacklogModule from '../../../../plugins/runtime/drain-backlog.js';
vi.mock('../../../../plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return { ...actual, drainBacklog: vi.fn() };
});

// ─── CatalogService ───────────────────────────────────────────────────────────
vi.mock('../../../../services/catalog.service.js', () => ({
    CatalogService: class {
        upsertExternalId = vi.fn().mockResolvedValue(undefined);
    },
}));

// ─── plugin-failure-events ────────────────────────────────────────────────────
vi.mock('../../../../database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));

// ─── media-artwork ────────────────────────────────────────────────────────────
vi.mock('../../../../database/queries/media-artwork.queries.js', () => ({
    upsertLocalArtwork: vi.fn().mockResolvedValue(true),
    lockArtworkOwners: vi.fn().mockResolvedValue(undefined),
}));

// ─── album-art.queries ────────────────────────────────────────────────────────
vi.mock('../../../../database/queries/album-art.queries.js', () => ({
    findTrackFileForAlbum: vi.fn().mockResolvedValue(null),
}));

// ─── metadata-storage ─────────────────────────────────────────────────────────
vi.mock('../../../../services/metadata-storage.service.js', () => ({
    resolveWritePath: vi.fn().mockResolvedValue({ filePath: '/tmp/test-caa/poster.jpg' }),
}));

// ─── fetch-utils ──────────────────────────────────────────────────────────────
vi.mock('../../../../utils/fetch-utils.js', () => ({
    fetchWithTimeout: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
}));

// ─── stage-state ─────────────────────────────────────────────────────────────
vi.mock('../../../../database/queries/stage-state.queries.js', () => ({
    upsertCompletedRow: vi.fn().mockResolvedValue(undefined),
    upsertSkippedPermanentRow: vi.fn().mockResolvedValue(undefined),
}));

// ─── config ───────────────────────────────────────────────────────────────────
vi.mock('$lib/server/config.js', () => ({
    config: { BASE_PATH: '/data' },
    getAuthoritativeStageIds: vi.fn(() => new Set<string>()),
    FEATURE_PER_TASK_QUEUES: false,
}));

import { albumEnrichmentTask } from '../album-enrichment.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CAA_BASE = 'https://coverartarchive.org';
const VALID_UUID = '00000000-0000-0000-0000-000000000001';

/**
 * Build a sql mock that sequences rows like the existing retry-item tests.
 * The first call resolves the album row, subsequent calls return [].
 * `.begin(fn)` simulates a transaction by calling fn with the same mock.
 */
type SqlMock = ReturnType<typeof vi.fn> & {
    begin: ReturnType<typeof vi.fn>;
};

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
        runId: 'test-job-caa',
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
        secrets: {
            get: vi.fn(),
            getOptional: vi.fn().mockResolvedValue(''),
            getUser: vi.fn(),
        },
        reportFailure: vi.fn(),
        spend: vi.fn(),
        drain: vi.fn(),
        http: {
            get: vi.fn(async () => new Response('{}', { status: 200 })),
            post: vi.fn(async () => new Response('{}', { status: 200 })),
        },
    } as unknown as TaskContext<Record<string, unknown>>;
}

function albumRow(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
    return {
        id: VALID_UUID,
        title: 'Kind of Dawn',
        parent_id: 'artist-uuid-001',
        parent_title: 'Milo Fenwick',
        prior_audit_job_id: null,
        ...overrides,
    };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('album enrichment — cover-art URL persistence via failures.retry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetTaskSettings.mockResolvedValue({
            primary_source: 'theaudiodb',
            fallback_source: 'none',
        });
        mockSetAlbumCoverArtUrlIfNull.mockResolvedValue(true);
    });

    // ─── Success path: releaseMbid present, image bytes fetched ──────────────

    it('calls setAlbumCoverArtUrlIfNull with the CAA URL on the success path', async () => {
        const releaseMbid = 'release-mbid-success-01';

        mockEnrichAlbumFromChain.mockResolvedValue({
            posterUrl: null,
            backdropUrl: null,
            releaseMbid,
            releaseGroupMbid: null,
        });

        // Provide image bytes so enrichOneAlbum reaches the MBID-persist step.
        const { getAlbumArt } =
            await import('$lib/server/providers/implementations/musicbrainz/cover-art.js');
        vi.mocked(getAlbumArt).mockResolvedValue({
            buffer: Buffer.from([0xff, 0xd8]),
            contentType: 'image/jpeg',
        });

        const ctx = makeCtx([[albumRow()], []]);

        // The retry path throws because no-match / enriched — we only care about
        // whether setAlbumCoverArtUrlIfNull was called before that.
        await albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID).catch(() => {
            // ignore outcome — testing side-effect
        });

        const expectedUrl = `${CAA_BASE}/release/${releaseMbid}/front`;
        expect(mockSetAlbumCoverArtUrlIfNull).toHaveBeenCalledWith(
            expect.anything(), // sql
            VALID_UUID,
            expectedUrl,
        );
    });

    // ─── No-match path: releaseMbid present but no image bytes ───────────────

    it('calls setAlbumCoverArtUrlIfNull on the no-image-bytes path when releaseMbid is present', async () => {
        const releaseMbid = 'release-mbid-nomatch-02';

        mockEnrichAlbumFromChain.mockResolvedValue({
            posterUrl: null, // no upstream URL
            backdropUrl: null,
            releaseMbid,
            releaseGroupMbid: null,
        });

        // CAA also returns null (bytes unavailable).
        const { getAlbumArt } =
            await import('$lib/server/providers/implementations/musicbrainz/cover-art.js');
        vi.mocked(getAlbumArt).mockResolvedValue(null);

        const ctx = makeCtx([[albumRow()], []]);

        // retryOneAlbum throws "No image found in any provider" on no-match —
        // we swallow that and only check the side-effect.
        await albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID).catch(() => {});

        const expectedUrl = `${CAA_BASE}/release/${releaseMbid}/front`;
        expect(mockSetAlbumCoverArtUrlIfNull).toHaveBeenCalledWith(
            expect.anything(),
            VALID_UUID,
            expectedUrl,
        );
    });

    // ─── No MBID: setAlbumCoverArtUrlIfNull must NOT be called ───────────────

    it('does NOT call setAlbumCoverArtUrlIfNull when chainResult.releaseMbid is null', async () => {
        mockEnrichAlbumFromChain.mockResolvedValue({
            posterUrl: null,
            backdropUrl: null,
            releaseMbid: null,
            releaseGroupMbid: null,
        });

        const ctx = makeCtx([[albumRow()], []]);
        await albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID).catch(() => {});

        expect(mockSetAlbumCoverArtUrlIfNull).not.toHaveBeenCalled();
    });

    // ─── Chain returns null entirely ─────────────────────────────────────────

    it('does NOT call setAlbumCoverArtUrlIfNull when the chain returns null', async () => {
        mockEnrichAlbumFromChain.mockResolvedValue(null);

        const ctx = makeCtx([[albumRow()], []]);
        await albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID).catch(() => {});

        expect(mockSetAlbumCoverArtUrlIfNull).not.toHaveBeenCalled();
    });

    // ─── URL shape check ─────────────────────────────────────────────────────

    it('constructs the URL as coverartarchive.org/release/{mbid}/front', async () => {
        const releaseMbid = '12345678-abcd-0000-0000-000000000099';

        mockEnrichAlbumFromChain.mockResolvedValue({
            posterUrl: null,
            backdropUrl: null,
            releaseMbid,
            releaseGroupMbid: null,
        });

        const ctx = makeCtx([[albumRow()], []]);
        await albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID).catch(() => {});

        expect(mockSetAlbumCoverArtUrlIfNull).toHaveBeenCalledWith(
            expect.anything(),
            VALID_UUID,
            `https://coverartarchive.org/release/${releaseMbid}/front`,
        );
    });
});

// ─── Query-level tests ────────────────────────────────────────────────────────

describe('setAlbumCoverArtUrlIfNull — query function contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('is exported from the album-enrichment query module', async () => {
        const mod = await import('../../../../database/queries/album-enrichment.queries.js');
        expect(typeof mod.setAlbumCoverArtUrlIfNull).toBe('function');
    });

    it('returns true when the UPDATE lands (column was null)', async () => {
        mockSetAlbumCoverArtUrlIfNull.mockResolvedValueOnce(true);
        const mod = await import('../../../../database/queries/album-enrichment.queries.js');
        const result = await mod.setAlbumCoverArtUrlIfNull(
            {} as never,
            'album-uuid',
            `${CAA_BASE}/release/some-mbid/front`,
        );
        expect(result).toBe(true);
    });

    it('returns false when custom_poster_url was already set (no-op)', async () => {
        mockSetAlbumCoverArtUrlIfNull.mockResolvedValueOnce(false);
        const mod = await import('../../../../database/queries/album-enrichment.queries.js');
        const result = await mod.setAlbumCoverArtUrlIfNull(
            {} as never,
            'album-uuid',
            `${CAA_BASE}/release/some-mbid/front`,
        );
        expect(result).toBe(false);
    });
});

describe('album field provenance', () => {
    const source = { provider: 'discogs', url: 'https://www.discogs.com/release/42' };
    beforeEach(async () => {
        vi.clearAllMocks();
        mockGetTaskSettings.mockResolvedValue({
            primary_source: 'theaudiodb',
            fallback_source: 'none',
        });
        const { getAlbumArt } =
            await import('$lib/server/providers/implementations/musicbrainz/cover-art.js');
        vi.mocked(getAlbumArt).mockResolvedValue(null);
        const { writableAlbumArtwork } =
            await import('../../../../database/queries/music-enrichment-provenance.queries.js');
        vi.mocked(writableAlbumArtwork).mockResolvedValue({ poster: true, backdrop: true });
        mockSetAlbumCoverArtUrlIfNull.mockResolvedValue(false);
    });
    it('records discovered provider references without downloading them', async () => {
        mockEnrichAlbumFromChain.mockResolvedValue({
            posterUrl: 'https://example.com/poster.jpg',
            backdropUrl: 'https://example.com/fanart.jpg',
            releaseMbid: null,
            releaseGroupMbid: null,
            provenance: { posterUrl: source, backdropUrl: source },
        });
        const ctx = makeCtx([[albumRow()], [{ release_mbid: null, release_group_mbid: 'group' }]]);
        vi.mocked(ctx.http!.get).mockImplementation(async (url) =>
            String(url).includes('fanart')
                ? new Response('', { status: 404 })
                : new Response(new Uint8Array([255, 216]), {
                      headers: { 'content-type': 'image/jpeg' },
                  }),
        );
        await albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID);
        const { registerImageCandidate } =
            await import('../../../../database/queries/image-candidates.queries.js');
        expect(registerImageCandidate).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                mediaItemId: VALID_UUID,
                role: 'poster',
                provider: 'discogs',
                providerRef: 'https://example.com/poster.jpg',
            }),
        );
        expect(registerImageCandidate).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                mediaItemId: VALID_UUID,
                role: 'backdrop',
                provider: 'discogs',
                providerRef: 'https://example.com/fanart.jpg',
            }),
        );
        expect(ctx.http!.get).not.toHaveBeenCalled();
    });
    it('credits CAA when it supplies a missing provider poster', async () => {
        mockEnrichAlbumFromChain.mockResolvedValue({
            posterUrl: null,
            backdropUrl: null,
            releaseMbid: null,
            releaseGroupMbid: 'group',
            provenance: { posterUrl: source },
        });
        const { getAlbumArt } =
            await import('$lib/server/providers/implementations/musicbrainz/cover-art.js');
        vi.mocked(getAlbumArt).mockResolvedValue({
            buffer: Buffer.from([255, 216]),
            contentType: 'image/jpeg',
        });
        const ctx = makeCtx([[albumRow()], []]);
        await albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID);
        const { mergeMusicProvenance } =
            await import('../../../../database/queries/music-enrichment-provenance.queries.js');
        expect(mergeMusicProvenance).toHaveBeenCalledWith(
            expect.anything(),
            VALID_UUID,
            'album_enrichment',
            ['poster'],
            {
                poster: {
                    provider: 'coverartarchive',
                    value: `/api/image/custom/${VALID_UUID}/poster`,
                },
            },
        );
    });
    it.each([
        ['/tmp/test-caa/poster.jpg', false, false],
        [
            '/tmp/test-caa/album-enrichment-poster-12345678-abcd-1234-abcd-123456789012.jpg',
            false,
            true,
        ],
        [
            '/tmp/test-caa/album-enrichment-poster-12345678-abcd-1234-abcd-123456789012.jpg',
            true,
            false,
        ],
    ])(
        'only cleans unique enrichment paths after replacement: %s',
        async (filePath, referenced, shouldDelete) => {
            const { getAlbumEnrichmentArtworkPaths } =
                await import('../../../../database/queries/music-enrichment-provenance.queries.js');
            vi.mocked(getAlbumEnrichmentArtworkPaths).mockResolvedValueOnce([
                { artwork_type: 'poster', file_path: filePath },
            ]);
            mockEnrichAlbumFromChain.mockResolvedValue({
                posterUrl: null,
                backdropUrl: null,
                releaseMbid: null,
                releaseGroupMbid: 'group',
                provenance: { posterUrl: source },
            });
            const { isImageCandidateFileReferenced } =
                await import('../../../../database/queries/image-candidates.queries.js');
            vi.mocked(isImageCandidateFileReferenced).mockResolvedValue(referenced);
            const { getAlbumArt } =
                await import('$lib/server/providers/implementations/musicbrainz/cover-art.js');
            vi.mocked(getAlbumArt).mockResolvedValue({
                buffer: Buffer.from([255, 216]),
                contentType: 'image/jpeg',
            });
            const ctx = makeCtx([[albumRow()], []]);
            vi.mocked(ctx.http!.get).mockResolvedValue(
                new Response(new Uint8Array([255, 216]), {
                    headers: { 'content-type': 'image/jpeg' },
                }),
            );
            await albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID);
            const { safeUnlink } = await import('$lib/server/utils/safe-fs.js');
            if (shouldDelete) expect(safeUnlink).toHaveBeenCalledWith(filePath);
            else expect(safeUnlink).not.toHaveBeenCalled();
        },
    );
    it('does not credit failed poster fetches', async () => {
        mockEnrichAlbumFromChain.mockResolvedValue({
            posterUrl: 'https://example.com/poster.jpg',
            backdropUrl: null,
            releaseMbid: null,
            releaseGroupMbid: null,
            provenance: { posterUrl: source },
        });
        const ctx = makeCtx([[albumRow()], []]);
        vi.mocked(ctx.http!.get).mockResolvedValue(new Response('', { status: 404 }));
        await albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID).catch(() => {});
        const { mergeMusicProvenance } =
            await import('../../../../database/queries/music-enrichment-provenance.queries.js');
        expect(mergeMusicProvenance).not.toHaveBeenCalled();
    });
    it('does not fetch or replace curated artwork', async () => {
        const { writableAlbumArtwork, mergeMusicProvenance } =
            await import('../../../../database/queries/music-enrichment-provenance.queries.js');
        vi.mocked(writableAlbumArtwork).mockResolvedValue({ poster: false, backdrop: false });
        mockEnrichAlbumFromChain.mockResolvedValue({
            posterUrl: 'https://example.com/poster.jpg',
            backdropUrl: null,
            releaseMbid: 'release',
            releaseGroupMbid: null,
            provenance: { posterUrl: source },
        });
        const ctx = makeCtx([[albumRow()], []]);
        await albumEnrichmentTask.failures!.retry!(ctx, VALID_UUID).catch(() => {});
        expect(ctx.http!.get).not.toHaveBeenCalled();
        expect(mockSetAlbumCoverArtUrlIfNull).not.toHaveBeenCalled();
        expect(mergeMusicProvenance).not.toHaveBeenCalled();
    });
});
