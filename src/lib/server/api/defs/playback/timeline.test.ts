// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Selected-file timeline handler and resilient analysis/availability contracts. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/config.js', () => ({ config: { TRICKPLAY_SERVE_LOCAL: true } }));

const mockGetDb = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockResolveAnyMediaId = vi.fn();
const mockCreateMediaSegmentsService = vi.fn();
const mockGetChaptersForFile = vi.fn();
const mockGetChaptersForEpisode = vi.fn();
const mockResolvePlaybackSelection = vi.fn();
const mockGetTrickplayParams = vi.fn();
const mockGetTrickplayAvailability = vi.fn();
const mockGetSegmentAnalysisStatus = vi.fn();
const mockGetMediaItemById = vi.fn();
const mockGetTaskSettings = vi.fn();
const mockGetChapterImageRevision = vi.fn();
vi.mock('$lib/server/services/playback-image-revision.js', () => ({
    computeChapterImageRevision: (...args: unknown[]) => mockGetChapterImageRevision(...args),
}));

const mockRepairLocalParams = vi.fn().mockResolvedValue([]);
const mockBuildManifest = vi.fn();
vi.mock('$lib/server/services/playback-trickplay.service.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/services/playback-trickplay.service.js')
    >()),
    buildTrickplayManifest: (...args: unknown[]) => mockBuildManifest(...args),
    repairLocalTrickplayParams: (...args: unknown[]) => mockRepairLocalParams(...args),
}));
const readyManifest = (_sql: unknown, _item: string, fileId: string, width: number) => ({
    source: 'local',
    revision: 'base-revision',
    manifest: {
        fileId,
        width,
        height: 180,
        tileColumns: 10,
        tileRows: 10,
        intervalMs: 1000,
        thumbnailCount: 100,
        sheets: [{ index: 0 }],
    },
});
beforeEach(() => mockBuildManifest.mockReset().mockImplementation(readyManifest));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));
vi.mock('$lib/server/services/media-id-resolver.js', () => ({
    mediaIdResolver: { resolveAnyMediaId: (...args: unknown[]) => mockResolveAnyMediaId(...args) },
}));
vi.mock('$lib/server/services/media-segments.service.js', () => ({
    createMediaSegmentsService: (...args: unknown[]) => mockCreateMediaSegmentsService(...args),
}));
vi.mock('$lib/server/database/queries/episode-chapters.queries.js', () => ({
    getChaptersForFile: (...args: unknown[]) => mockGetChaptersForFile(...args),
    getChaptersForEpisode: (...args: unknown[]) => mockGetChaptersForEpisode(...args),
}));
vi.mock('$lib/server/database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: (...args: unknown[]) => mockResolvePlaybackSelection(...args),
}));
vi.mock('$lib/server/database/queries/trickplay-params.queries.js', () => ({
    getTrickplayParams: (...args: unknown[]) => mockGetTrickplayParams(...args),
    getTrickplayAvailability: (...args: unknown[]) => mockGetTrickplayAvailability(...args),
}));
vi.mock('$lib/server/database/queries/media-segments.queries.js', () => ({
    getSegmentAnalysisStatus: (...args: unknown[]) => mockGetSegmentAnalysisStatus(...args),
}));
vi.mock('$lib/server/database/queries/catalog-operations.queries.js', () => ({
    getMediaItemById: (...args: unknown[]) => mockGetMediaItemById(...args),
}));
vi.mock('$lib/server/database/queries/task-settings.queries.js', () => ({
    getTaskSettings: (...args: unknown[]) => mockGetTaskSettings(...args),
}));

const { def, resolveSegmentAnalysis, resolveTrickplayAvailability } = await import('./timeline.js');

function makeEvent(): RequestEvent {
    const url = 'http://localhost/api/playback/item-1/timeline';
    return {
        locals: { user: { userId: 'u1', username: 'alice' }, resolvedIds: undefined },
        url: new URL(url),
        params: { itemId: 'item-1' },
        request: new Request(url),
    } as unknown as RequestEvent;
}

const ctx = { surface: 'internal', input: { query: {} } } as never;

describe('resolveSegmentAnalysis', () => {
    beforeEach(() => {
        mockGetTaskSettings.mockReset().mockResolvedValue({});
    });

    it('returns the underlying query result when it resolves', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);
        mockGetSegmentAnalysisStatus.mockResolvedValueOnce('analyzed');

        const result = await resolveSegmentAnalysis(mockSql as never, 'item-1', 'movie');

        expect(result).toBe('analyzed');
    });

    it('degrades to unavailable, not a throw, when the underlying query fails', async () => {
        const mockSql = vi.fn();
        mockGetSegmentAnalysisStatus.mockRejectedValueOnce(new Error('connection reset'));

        const result = await resolveSegmentAnalysis(mockSql as never, 'item-1', 'movie');

        expect(result).toBe('unavailable');
    });

    it('requires only the visual stage for a movie — finding #5: the acoustic stage never runs for movies', async () => {
        // lumastra-intro-analyzer.ts's season drain only ever marks the
        // acoustic stage for episode ids (acousticEpisodeIds), never a movie
        // id — requiring it for a movie makes segmentAnalysis unsatisfiable.
        const mockSql = vi.fn().mockResolvedValue([]);
        mockGetSegmentAnalysisStatus.mockResolvedValueOnce('analyzed');

        await resolveSegmentAnalysis(mockSql as never, 'item-1', 'movie');

        expect(mockGetSegmentAnalysisStatus).toHaveBeenCalledWith(mockSql, 'item-1', [
            { stageId: 'lumastra-intro-analyzer:visual', minVersion: 5 },
        ]);
        // No need to consult the analyzer's settings at all for a movie.
        expect(mockGetTaskSettings).not.toHaveBeenCalled();
    });

    it('requires both stages for an episode when chromaprint detection is enabled', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);
        mockGetTaskSettings.mockResolvedValueOnce({ chromaprintDetection: true });
        mockGetSegmentAnalysisStatus.mockResolvedValueOnce('analyzed');

        await resolveSegmentAnalysis(mockSql as never, 'item-1', 'episode');

        expect(mockGetSegmentAnalysisStatus).toHaveBeenCalledWith(mockSql, 'item-1', [
            { stageId: 'lumastra-intro-analyzer:visual', minVersion: 5 },
            { stageId: 'lumastra-intro-analyzer:acoustic', minVersion: 4 },
        ]);
    });

    it('drops the acoustic requirement for an episode when chromaprint detection is disabled — finding #5', async () => {
        // The old combined completion flag recorded the fingerprint pass even
        // when it was disabled; markAnalyzed(acoustic) now only fires when
        // chromaRan is true, so requiring the stage unconditionally traps a
        // disabled-fingerprinting episode in 'pending' forever too.
        const mockSql = vi.fn().mockResolvedValue([]);
        mockGetTaskSettings.mockResolvedValueOnce({ chromaprintDetection: false });
        mockGetSegmentAnalysisStatus.mockResolvedValueOnce('analyzed');

        await resolveSegmentAnalysis(mockSql as never, 'item-1', 'episode');

        expect(mockGetSegmentAnalysisStatus).toHaveBeenCalledWith(mockSql, 'item-1', [
            { stageId: 'lumastra-intro-analyzer:visual', minVersion: 5 },
        ]);
    });
});

describe('resolveTrickplayAvailability', () => {
    it('never probes artifacts when pending does not authorize repair', async () => {
        mockRepairLocalParams.mockClear();
        mockGetTrickplayAvailability.mockResolvedValueOnce({
            state: 'pending',
            widths: [],
            needsRepair: false,
        });
        await resolveTrickplayAvailability(vi.fn() as never, 'item', 'movie', 'never-generated');
        expect(mockRepairLocalParams).not.toHaveBeenCalled();
    });

    it('repairs completed generation with missing params from the selected file artifacts', async () => {
        const sql = vi.fn();
        mockGetTrickplayAvailability
            .mockResolvedValueOnce({ state: 'pending', widths: [], needsRepair: true })
            .mockResolvedValueOnce({ state: 'ready', widths: [480] });
        mockRepairLocalParams.mockResolvedValueOnce([480]);
        expect(
            await resolveTrickplayAvailability(sql as never, 'item-1', 'movie', 'file-b'),
        ).toEqual({ trickplayState: 'ready', trickplayWidths: [480] });
        expect(mockRepairLocalParams).toHaveBeenCalledWith(sql, 'item-1', 'file-b');
    });

    beforeEach(() => {
        mockGetTrickplayAvailability.mockReset();
    });

    it('returns the underlying query result when it resolves', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);
        mockGetTrickplayAvailability.mockResolvedValueOnce({ state: 'ready', widths: [320] });

        const result = await resolveTrickplayAvailability(mockSql as never, 'item-1', 'movie');

        expect(result).toEqual({ trickplayState: 'ready', trickplayWidths: [320] });
    });

    it('degrades to unavailable with an empty widths array, not a throw, when the underlying query fails', async () => {
        const mockSql = vi.fn();
        mockGetTrickplayAvailability.mockRejectedValueOnce(new Error('connection reset'));

        const result = await resolveTrickplayAvailability(mockSql as never, 'item-1', 'movie');

        expect(result).toEqual({ trickplayState: 'unavailable', trickplayWidths: [] });
    });

    it('reports unsupported WITHOUT calling the underlying query when the media type never applies', async () => {
        // The canonical case finding #16 covers: an audio item never gets a
        // trickplay-generation stage row seeded at all (outside the stage's
        // appliesTo), so the row-driven logic in getTrickplayAvailability can
        // never distinguish "not yet processed" from "will never apply" on
        // its own — the gate here must short-circuit before that query runs.
        const mockSql = vi.fn();

        const result = await resolveTrickplayAvailability(mockSql as never, 'item-1', 'track');

        expect(result).toEqual({ trickplayState: 'unsupported', trickplayWidths: [] });
        expect(mockGetTrickplayAvailability).not.toHaveBeenCalled();
    });

    it('falls through to the underlying query when the media type is unknown', async () => {
        const mockSql = vi.fn().mockResolvedValue([]);
        mockGetTrickplayAvailability.mockResolvedValueOnce({ state: 'pending', widths: [] });

        const result = await resolveTrickplayAvailability(mockSql as never, 'item-1', null);

        expect(result).toEqual({ trickplayState: 'pending', trickplayWidths: [] });
        expect(mockGetTrickplayAvailability).toHaveBeenCalled();
    });
});

describe('GET /playback/{itemId}/timeline — analysis and selected-file delivery', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockResolveAnyMediaId.mockResolvedValue({ internalId: 'item-1' });
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetMediaItemById.mockResolvedValue({ runtime_seconds: 1200 });
        mockResolvePlaybackSelection.mockResolvedValue({
            fileId: 'file-1',
            files: [{ id: 'file-1', is_default: true }],
        });
        mockGetTrickplayParams.mockResolvedValue([]);
        mockGetChapterImageRevision.mockReturnValue('revision-1');
        mockGetTrickplayAvailability.mockResolvedValue({ state: 'pending', widths: [] });
        mockGetChaptersForFile.mockResolvedValue([]);
        mockGetChaptersForEpisode.mockResolvedValue([]);
        mockCreateMediaSegmentsService.mockReturnValue({
            getSegments: vi.fn().mockResolvedValue([
                { type: 'Intro', startTime: 0, endTime: 30 },
                { type: 'Outro', startTime: 1100, endTime: 1200 },
            ]),
        });
    });

    it('returns ready variants on the first request that repairs missing params', async () => {
        mockGetSegmentAnalysisStatus.mockResolvedValue('pending');
        mockGetMediaItemById.mockResolvedValue({ media_type: 'movie', runtime_seconds: 1200 });
        mockGetTrickplayAvailability
            .mockResolvedValueOnce({ state: 'pending', widths: [], needsRepair: true })
            .mockResolvedValueOnce({ state: 'ready', widths: [480] });
        mockRepairLocalParams.mockImplementationOnce(async () => {
            mockGetTrickplayParams.mockResolvedValue([{ width: 480 }]);
            return [480];
        });
        const response = await def.handlers.GET!(makeEvent(), ctx);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.trickplay.state).toBe('ready');
        expect(body.trickplay.variants.map((v: { width: number }) => v.width)).toEqual([480]);
        expect(mockRepairLocalParams.mock.invocationCallOrder[0]).toBeLessThan(
            mockGetTrickplayParams.mock.invocationCallOrder[0]!,
        );
    });

    it('keeps hasIntro/hasOutro true (from mediaSegments) when analysis is analyzed', async () => {
        mockGetSegmentAnalysisStatus.mockResolvedValue('analyzed');

        const res = await def.handlers.GET!(makeEvent(), ctx);
        const body = await res.json();

        expect(body.hasIntro).toBe(true);
        expect(body.hasOutro).toBe(true);
        expect(body.segmentAnalysis).toBe('analyzed');
        // Regression guard: pre-existing fields are unaffected by the
        // trickplay addition living alongside segmentAnalysis.
        expect(body.durationMs).toBe(1_200_000);
        expect(body.chapters).toEqual([]);
        expect(body.segments).toHaveLength(2);
        expect(body.trickplay.state).toBe('pending');
        expect(body.trickplay.variants.map((variant: { width: number }) => variant.width)).toEqual(
            [],
        );
    });

    it('keeps hasIntro/hasOutro true even when segmentAnalysis is pending', async () => {
        // Regression guard: segmentAnalysis must never gate hasIntro/hasOutro —
        // they stay derived purely from mediaSegments, exactly as before this
        // change. A pending analysis alongside already-materialized segments
        // (e.g. from an older run before the stage-state coverage rows existed)
        // must still surface the segments that DO exist.
        mockGetSegmentAnalysisStatus.mockResolvedValue('pending');

        const res = await def.handlers.GET!(makeEvent(), ctx);
        const body = await res.json();

        expect(body.hasIntro).toBe(true);
        expect(body.hasOutro).toBe(true);
        expect(body.segmentAnalysis).toBe('pending');
    });

    it('reports pending segmentAnalysis with false hasIntro/hasOutro for a truly unanalysed item', async () => {
        mockCreateMediaSegmentsService.mockReturnValue({
            getSegments: vi.fn().mockResolvedValue([]),
        });
        mockGetSegmentAnalysisStatus.mockResolvedValue('pending');

        const res = await def.handlers.GET!(makeEvent(), ctx);
        const body = await res.json();

        expect(body.hasIntro).toBe(false);
        expect(body.hasOutro).toBe(false);
        expect(body.segmentAnalysis).toBe('pending');
    });

    it('reports unavailable, and still returns 200 with the rest of the payload, when the status query throws', async () => {
        mockGetSegmentAnalysisStatus.mockRejectedValue(new Error('db exploded'));

        const res = await def.handlers.GET!(makeEvent(), ctx);
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.segmentAnalysis).toBe('unavailable');
        expect(body.hasIntro).toBe(true);
        expect(body.hasOutro).toBe(true);
        // trickplayState is resolved independently — a throw in the
        // segment-analysis query must not affect it.
        expect(body.trickplay.state).toBe('pending');
        expect(body.trickplay.variants.map((variant: { width: number }) => variant.width)).toEqual(
            [],
        );
    });

    it('reports trickplayState ready with the actual widths when trickplay is available', async () => {
        mockGetSegmentAnalysisStatus.mockResolvedValue('analyzed');
        mockGetTrickplayAvailability.mockResolvedValue({ state: 'ready', widths: [320] });

        const res = await def.handlers.GET!(makeEvent(), ctx);
        const body = await res.json();

        expect(body.trickplay.state).toBe('ready');
        expect(body.trickplay.variants.map((variant: { width: number }) => variant.width)).toEqual([
            320,
        ]);
        // Regression: unrelated fields unaffected.
        expect(body.hasIntro).toBe(true);
        expect(body.hasOutro).toBe(true);
        expect(body.segmentAnalysis).toBe('analyzed');
    });

    it('reports every available width verbatim, not just the first, when trickplay is ready', async () => {
        mockGetTrickplayAvailability.mockResolvedValue({ state: 'ready', widths: [160, 320, 640] });

        const res = await def.handlers.GET!(makeEvent(), ctx);
        const body = await res.json();

        expect(body.trickplay.state).toBe('ready');
        expect(body.trickplay.variants.map((variant: { width: number }) => variant.width)).toEqual([
            160, 320, 640,
        ]);
    });

    it('reports trickplayState unsupported with empty widths for a permanently-ineligible item (e.g. audio)', async () => {
        mockGetTrickplayAvailability.mockResolvedValue({ state: 'unsupported', widths: [] });

        const res = await def.handlers.GET!(makeEvent(), ctx);
        const body = await res.json();

        expect(body.trickplay.state).toBe('unsupported');
        expect(body.trickplay.variants.map((variant: { width: number }) => variant.width)).toEqual(
            [],
        );
    });

    it('reports trickplayState pending with empty widths for a not-yet-processed item', async () => {
        mockGetTrickplayAvailability.mockResolvedValue({ state: 'pending', widths: [] });

        const res = await def.handlers.GET!(makeEvent(), ctx);
        const body = await res.json();

        expect(body.trickplay.state).toBe('pending');
        expect(body.trickplay.variants.map((variant: { width: number }) => variant.width)).toEqual(
            [],
        );
    });

    it('reports trickplayState unavailable, and still returns 200 with the rest of the payload, when the availability query throws', async () => {
        mockGetSegmentAnalysisStatus.mockResolvedValue('pending');
        mockGetTrickplayAvailability.mockRejectedValue(new Error('db exploded'));

        const res = await def.handlers.GET!(makeEvent(), ctx);
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.trickplay.state).toBe('unavailable');
        expect(body.trickplay.variants.map((variant: { width: number }) => variant.width)).toEqual(
            [],
        );
        // segmentAnalysis is resolved independently — a throw in the
        // trickplay-availability query must not affect it.
        expect(body.segmentAnalysis).toBe('pending');
        expect(body.hasIntro).toBe(true);
        expect(body.hasOutro).toBe(true);
    });
});

describe('timeline selected-file contract', () => {
    const files = [
        { id: 'cut-a', is_default: false, duration_seconds: 1500, file_path: '/a.mkv' },
        { id: 'cut-b', is_default: true, duration_seconds: 1800.123, file_path: '/b.mkv' },
    ];
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockCheckMediaAccess.mockResolvedValue(true);
        mockResolveAnyMediaId.mockResolvedValue({ internalId: 'item-1' });
        mockGetMediaItemById.mockResolvedValue({ runtime_seconds: 1200, media_type: 'movie' });
        mockGetTrickplayParams.mockResolvedValue([]);
        mockGetChapterImageRevision.mockReturnValue('revision-1');
        mockGetSegmentAnalysisStatus.mockResolvedValue('analyzed');
        mockGetTrickplayAvailability.mockResolvedValue({ state: 'ready', widths: [320] });
        mockGetChaptersForEpisode.mockResolvedValue([]);
        mockResolvePlaybackSelection.mockImplementation((_sql, _id, options) => ({
            files: options.fileId ? files.filter((f) => f.id === options.fileId) : files,
            fileId: options.fileId ?? 'cut-b',
        }));
        mockGetChaptersForFile.mockImplementation((_sql, fileId) =>
            Promise.resolve([
                {
                    chapter_index: 0,
                    chapter_name: fileId,
                    start_ticks: fileId === 'cut-a' ? 10_000_000 : 20_000_000,
                    end_ticks: null,
                },
            ]),
        );
        mockCreateMediaSegmentsService.mockReturnValue({
            getSegments: vi
                .fn()
                .mockImplementation((_id, fileId) =>
                    Promise.resolve([
                        { type: 'Intro', startTime: fileId === 'cut-a' ? 1.111 : 5, endTime: 30 },
                    ]),
                ),
        });
    });

    it('uses the resolved default even when it is not the first file returned', async () => {
        const response = await def.handlers.GET!(makeEvent(), ctx);
        const body = await response.json();
        expect(body).toEqual({
            fileId: 'cut-b',
            durationMs: 1800123,
            chapters: [{ index: 0, name: 'cut-b', startMs: 2000, endMs: 1800123, image: null }],
            segments: [{ type: 'intro', startMs: 5000, endMs: 30000 }],
            segmentAnalysis: 'analyzed',
            hasIntro: true,
            hasOutro: false,
            trickplay: {
                state: 'ready',
                variants: [
                    {
                        width: 320,
                        manifestHref: '/api/playback/item-1/trickplay/320/manifest?fileId=cut-b',
                    },
                ],
            },
        });
        expect(mockGetTrickplayAvailability).toHaveBeenCalledWith(
            {},
            'item-1',
            'trickplay-generation',
            1,
            'cut-b',
        );
    });

    it('returns different chapters and markers for an explicit alternate cut', async () => {
        const response = await def.handlers.GET!(makeEvent(), {
            input: { query: { fileId: 'cut-a' } },
        } as never);
        const body = await response.json();
        expect(body.fileId).toBe('cut-a');
        expect(body.durationMs).toBe(1500000);
        expect(body.chapters[0]).toEqual({
            index: 0,
            name: 'cut-a',
            startMs: 1000,
            endMs: 1500000,
            image: null,
        });
        expect(body.segments).toEqual([{ type: 'intro', startMs: 1111, endMs: 30000 }]);
    });

    it('never borrows default chapters when the selected alternate has none', async () => {
        mockGetChaptersForFile.mockResolvedValue([]);
        await def.handlers.GET!(makeEvent(), { input: { query: { fileId: 'cut-a' } } } as never);
        expect(mockGetChaptersForEpisode).not.toHaveBeenCalled();
    });

    it('permits the default chapter fallback only for the default file', async () => {
        mockGetChaptersForFile.mockResolvedValue([]);
        await def.handlers.GET!(makeEvent(), ctx);
        expect(mockGetChaptersForEpisode).toHaveBeenCalledWith({}, 'item-1');
    });

    it('emits a ready image href with selected file and revision', async () => {
        mockGetTrickplayParams.mockResolvedValue([
            {
                width: 320,
                height: 180,
                interval_ms: 1000,
                tile_width: 10,
                tile_height: 10,
                thumbnail_count: 100,
            },
        ]);
        const response = await def.handlers.GET!(makeEvent(), ctx);
        const body = await response.json();
        expect(body.chapters[0].image).toEqual({
            href: '/api/playback/item-1/chapter-image/0?fileId=cut-b&rev=revision-1',
            revision: 'revision-1',
            source: 'self',
            mediaType: 'image/webp',
        });
        expect(mockGetChapterImageRevision).toHaveBeenCalledWith(
            'cut-b',
            20000000,
            320,
            'base-revision',
        );
    });

    it('clamps chapter/segment ranges, filters unknown types, and falls back from zero file duration', async () => {
        mockResolvePlaybackSelection.mockResolvedValue({
            fileId: 'cut-b',
            files: [{ ...files[1], duration_seconds: 0 }],
        });
        mockGetChaptersForFile.mockResolvedValue([
            { chapter_index: 0, start_ticks: -10000, end_ticks: -20000 },
            { chapter_index: 1, start_ticks: 99_000_000_000, end_ticks: 10_000 },
        ]);
        mockCreateMediaSegmentsService.mockReturnValue({
            getSegments: async () => [
                { type: 'Intro', startTime: -10, endTime: 2000 },
                { type: 'Outro', startTime: 20, endTime: 1 },
                { type: 'Unknown', startTime: 1, endTime: 2 },
            ],
        });
        const body = await (await def.handlers.GET!(makeEvent(), ctx)).json();
        expect(body.durationMs).toBe(1_200_000);
        expect(
            body.chapters.map((ch: { startMs: number; endMs: number }) => [ch.startMs, ch.endMs]),
        ).toEqual([
            [0, 0],
            [1_200_000, 1_200_000],
        ]);
        expect(body.segments).toEqual([
            { type: 'intro', startMs: 0, endMs: 1_200_000 },
            { type: 'outro', startMs: 20_000, endMs: 20_000 },
        ]);
    });

    it('omits unservable widths and chapter images even if params claim readiness', async () => {
        mockGetTrickplayParams.mockResolvedValue([{ width: 320 }]);
        mockBuildManifest.mockResolvedValue(null);
        const body = await (await def.handlers.GET!(makeEvent(), ctx)).json();
        expect(body.trickplay).toEqual({ state: 'unavailable', variants: [] });
        expect(body.chapters[0].image).toBeNull();
    });

    it('resolves a manifest revision once per width regardless of chapter count', async () => {
        mockGetTrickplayParams.mockResolvedValue([{ width: 320 }]);
        mockGetChaptersForFile.mockResolvedValue(
            Array.from({ length: 50 }, (_, index) => ({
                chapter_index: index,
                chapter_name: 'Chapter',
                start_ticks: index * 10_000_000,
                end_ticks: null,
            })),
        );
        await def.handlers.GET!(makeEvent(), ctx);
        expect(mockBuildManifest).toHaveBeenCalledTimes(1);
        expect(mockGetChapterImageRevision).toHaveBeenCalledTimes(50);
    });

    it('rejects an unknown file rather than falling back to another cut', async () => {
        const response = await def.handlers.GET!(makeEvent(), {
            input: { query: { fileId: 'missing' } },
        } as never);
        expect(response.status).toBe(404);
    });
});
