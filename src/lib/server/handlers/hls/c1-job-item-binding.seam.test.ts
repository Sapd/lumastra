// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seam test for fix plan 6, C1: bind an HLS transcode job to the item its
 * segment URL names, on every mount.
 *
 * This drives the REAL `/api/v1/playback/{id}/hls/{...path}` route (and its
 * `/api/playback/{itemId}/hls/{...path}` cookie-mirror re-export), the REAL
 * `requireAuth` -> `withIdResolution` -> `withMediaAccess`
 * (`withLibraryAccess` + `withAgeGate`) middleware chain, and the REAL
 * `lumastra-segment-handler.ts` (including `resolveJobPlaySessionId` and the
 * `checkJobItemBinding` predicate). Only leaves are mocked: the DB driver
 * (`getDb`), `media-id-resolver.js` (faithful fake mirroring
 * `resolveUuid`'s "unknown UUID -> internalId: null" behavior, never a
 * throw), the FFmpeg transcode-job registry, job persistence, preview
 * sessions, preview-cache store, bandwidth/telemetry, and segment-delivery
 * failure recording.
 *
 * The `/j` and private-module (`showcase`) mounts are covered in
 * their own tree-local seam files — see Global Constraint 8 (a test of
 * module code must live in that tree):
 *   - src/routes/(modules)/j/Videos/[itemId]/hls/[...path]/c1-job-item-binding.seam.test.ts
 *   - src/routes/(private)/showcase/hls/[id]/[...path]/c1-job-item-binding.seam.test.ts
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { writeOutputMarker } from '$lib/server/services/hls/output-marker.js';

// Wraps (never replaces) 'fs/promises' readFile so the persisted-only test
// below can assert "never called" — a plain `vi.spyOn` on a real ESM module's
// export is not redefinable, hence this partial-mock wrapper. Every OTHER
// test in this file still gets the REAL readFile (delegated to actual), so
// this is transparent everywhere except that one assertion.
const { readFileSpy } = vi.hoisted(() => ({ readFileSpy: vi.fn() }));
vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs/promises')>();
    return {
        ...actual,
        readFile: (...args: Parameters<typeof actual.readFile>) => {
            readFileSpy(...args);
            return actual.readFile(...args);
        },
    };
});

// ── DB leaf: a generic empty-row responder, plus explicit handling for the
//    ONE query this seam actually needs a real-looking answer for (none —
//    every gate here runs as an admin, which short-circuits before touching
//    sql; ownership/restore DB reads default to "row absent", which is the
//    documented fail-open warm-up-window behavior). ──────────────────────────
const mockSql = vi.fn(async () => [] as unknown[]);
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => mockSql }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => mockSql }));
vi.mock('$lib/server/database', () => ({ getDb: () => mockSql }));

// ── media-id-resolver leaf: faithful fake mirroring resolveUuid's real
//    contract — an unknown-but-valid UUID resolves with internalId: null,
//    it does NOT throw (media-id-resolver.ts:397-404). CANONICAL_MAP lets a
//    test simulate a canonical merge (raw id resolves to a DIFFERENT
//    internalId), which the identity-only fake could never exercise — see
//    fix round 1, Important #3(a): the raw-URL-id arm of the bound set (B)
//    was previously never distinguished from the internalId arm. ──────────
const KNOWN_ITEM_IDS = new Set<string>();
const CANONICAL_MAP = new Map<string, string>(); // rawId -> internalId
vi.mock('$lib/server/services/media-id-resolver.js', () => ({
    mediaIdResolver: {
        resolveAnyMediaId: vi.fn(async (rawId: string) => {
            const canonical = CANONICAL_MAP.get(rawId);
            if (canonical) {
                return {
                    internalId: canonical,
                    source: 'uuid' as const,
                    inputId: rawId,
                };
            }
            return {
                internalId: KNOWN_ITEM_IDS.has(rawId) ? rawId : null,
                source: 'uuid' as const,
                inputId: rawId,
            };
        }),
    },
}));

const { getPreviewSessionMock } = vi.hoisted(() => ({ getPreviewSessionMock: vi.fn() }));
vi.mock('$lib/server/services/preview-session.service.js', () => ({
    getPreviewSession: getPreviewSessionMock,
}));

const { previewCacheStoreMock } = vi.hoisted(() => ({
    previewCacheStoreMock: { dirFor: vi.fn((k: string) => k) },
}));
vi.mock('$lib/server/services/preview-cache.store.js', () => ({
    getPreviewCacheStore: () => previewCacheStoreMock,
}));

const { transcodeServiceMock, getJobByPlaySessionSpy, getJobSpy, restoreJobSpy } = vi.hoisted(
    () => {
        const getJobByPlaySessionSpy = vi.fn();
        const getJobSpy = vi.fn();
        const restoreJobSpy = vi.fn();
        const transcodeServiceMock: Record<string, unknown> = { restoreJob: restoreJobSpy };
        return { transcodeServiceMock, getJobByPlaySessionSpy, getJobSpy, restoreJobSpy };
    },
);
vi.mock('$lib/server/services/ffmpeg-transcode.service.js', () => ({
    getFFmpegTranscodeService: () => transcodeServiceMock,
    getKeyframeSegmentIndexForTime: () => 0,
    getKeyframeSegmentStartTime: () => 0,
}));
// Hoisted + mutable so a specific test can make getJob return a persisted
// row (fix round 1, Important #3(b): the persisted-only restore path,
// routed through the REAL handler->job-restoration.ts wiring, was never
// exercised at the route level — every case here previously forced getJob
// to null).
const { jobPersistenceMock } = vi.hoisted(() => ({
    jobPersistenceMock: {
        getJob: vi.fn(async () => null as unknown),
        updateStatus: vi.fn(async () => undefined),
        updateLastAccessed: vi.fn(async () => undefined),
        claimJobForRestoration: vi.fn(async () => false),
        takeOverStaleJob: vi.fn(async () => false),
    },
}));
vi.mock('$lib/server/services/transcode-job-persistence.service.js', () => ({
    getCurrentPodName: () => process.env.HOSTNAME || 'unknown',
    getTranscodeJobPersistenceService: () => jobPersistenceMock,
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackHlsSegmentForSession: vi.fn() },
}));
vi.mock('$lib/server/services/playback-telemetry.service.js', () => ({
    playbackTelemetryService: { record: vi.fn(async () => {}) },
}));
vi.mock('$lib/server/services/segment-delivery-failure.service.js', () => ({
    recordFailure: vi.fn(),
}));

// Subtitle segment scoping leaf (fix plan 6, Task 2 fix round 1 — see
// `describe('subtitle segment fileId scoping', ...)` below). `resolveSubtitle`
// isn't reached by these cases (only exercised on a disk-cache MISS), so it
// isn't mocked — its own real import chain is safe here already (this file
// already loads the real route -> lumastra-segment-handler.ts ->
// subtitle-handler.ts chain for the existing subtitle-playlist test above).
const { subtitleFileCacheGetSpy } = vi.hoisted(() => ({ subtitleFileCacheGetSpy: vi.fn() }));
vi.mock('$lib/server/services/cache/subtitle-file-cache.service.js', () => ({
    SubtitleFileCacheService: {
        get: subtitleFileCacheGetSpy,
        set: vi.fn(async () => undefined),
    },
}));

// Both mounts under test import from these two module specifiers, which
// resolve to the same real GET handler.
const v1Module = await import('../../../../routes/api/v1/playback/[id]/hls/[...path]/+server.js');
const mirrorModule =
    await import('../../../../routes/api/playback/[itemId]/hls/[...path]/+server.js');

const { features } = await import('$lib/server/config.js');
const { invalidateLibraryGroupPermissionsCache } =
    await import('$lib/server/cache/library-group-permissions-cache.js');

const callGet = (handler: typeof v1Module.GET, event: RequestEvent): Promise<Response> =>
    (handler as unknown as (e: RequestEvent) => Promise<Response>)(event);

const ADMIN_USER = { userId: 'u-admin', username: 'admin', isAdmin: true, isAgeRestricted: false };
const NON_ADMIN_USER = {
    userId: 'u-plain',
    username: 'plain',
    isAdmin: false,
    isAgeRestricted: false,
    userGroups: [] as string[],
};

const ITEM_X = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const ITEM_Y = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';

function makeEvent(opts: {
    itemId: string;
    path: string;
    playSessionId: string;
    user?: typeof ADMIN_USER | typeof NON_ADMIN_USER;
    mirror?: boolean;
}): RequestEvent {
    const qs = new URLSearchParams({ PlaySessionId: opts.playSessionId });
    const base = opts.mirror ? '/api/playback' : '/api/v1/playback';
    const url = new URL(
        `https://example.test${base}/${opts.itemId}/hls/${opts.path}?${qs.toString()}`,
    );
    const params = opts.mirror
        ? { itemId: opts.itemId, path: opts.path }
        : { id: opts.itemId, path: opts.path };
    return {
        params,
        url,
        request: new Request(url),
        locals: { user: opts.user },
    } as unknown as RequestEvent;
}

// `username` defaults to ADMIN_USER's spelling — the caller in most cases
// here — since the segment-route ownership check (I1 follow-up,
// lumastra-segment-handler.ts) now compares `job.config.username` to the
// requester before any resident-job seek/serve. A case that drives the
// request as NON_ADMIN_USER passes 'plain' explicitly.
function makeJob(dir: string, itemId: string, username = 'admin'): Record<string, unknown> {
    return {
        id: 'job-1',
        outputDir: dir,
        config: {
            itemId,
            username,
            hlsOutput: { hlsAudioMode: 'demux' },
            audioTracks: [{ index: 0, codec: 'aac' }],
            totalDurationSeconds: undefined,
            deviceId: 'test-device',
        },
        transcodeDecisionResult: { videoAction: 'transcode', audioAction: 'transcode' },
        segmentDurationSeconds: 6,
        segmentsReady: 10,
        segmentOffset: 0,
        status: 'running',
        isSeeking: false,
        generationRole: 'current',
        generationIndex: 0,
        seekCount: 0,
        lastServedSegment: new Map<string, number>(),
        endSegmentCache: new Map<string, Buffer>(),
        streamTargetDurations: new Map<string, number>(),
        deletedUpTo: new Map<string, number>(),
        syncTraceLoggedStreams: new Set<string>(),
        lastAccessedAt: new Date(),
    };
}

// Case-folded lookup, matching the real registry's sessionKey()
// (ffmpeg-transcode.service.ts: `playSessionId?.toLowerCase() ?? ''`) — every
// job/getJob(ByPlaySession) Map lookup in production folds case, so a fake
// that doesn't fold would let a case-sensitive reject check look safe by
// accident (falling through to a lookup that ALSO happens to miss, instead of
// the lookup that would actually find the artifact in production).
function foldedLookup(
    jobs: Record<string, Record<string, unknown>>,
    id: string,
): Record<string, unknown> | undefined {
    return jobs[id.toLowerCase()];
}

function installRegistry(jobs: Record<string, Record<string, unknown>>): void {
    getJobByPlaySessionSpy.mockReset();
    getJobByPlaySessionSpy.mockImplementation((id: string) => foldedLookup(jobs, id));
    // `getJob` refreshes lastAccessedAt and writes the DB in production; a
    // spy so a rejected request can be shown never to reach it.
    getJobSpy.mockReset();
    getJobSpy.mockImplementation((id: string) => foldedLookup(jobs, id));
    Object.assign(transcodeServiceMock, {
        getJob: getJobSpy,
        getJobByPlaySession: getJobByPlaySessionSpy,
        resolveSegmentRoute: async () => undefined,
        getSegmentOffsetForJob: () => 0,
        getStreamSegmentOffsetForJob: () => 0,
        getStreamTargetDurationForJob: () => undefined,
        canStreamTriggerSeekForJob: () => false,
        isSegmentDeletedForJob: () => false,
        getSegmentOffset: () => 0,
        getStreamSegmentOffset: () => 0,
        recordSegmentAccessForJob: () => {},
        recordSegmentRequestForJob: () => {},
        getRetainedJobsByPlaySession: () => [],
        getVodManifestInfo: () => undefined,
        getStreamTargetDuration: () => undefined,
        setStreamTargetDuration: () => {},
    });
}

describe('C1 job->item binding — /api/v1 + /api cookie mirror', () => {
    let outputDir: string;

    beforeEach(async () => {
        vi.clearAllMocks();
        getPreviewSessionMock.mockReset();
        getPreviewSessionMock.mockResolvedValue(undefined);
        mockSql.mockReset();
        mockSql.mockResolvedValue([]);
        KNOWN_ITEM_IDS.clear();
        KNOWN_ITEM_IDS.add(ITEM_X);
        KNOWN_ITEM_IDS.add(ITEM_Y);
        CANONICAL_MAP.clear();
        jobPersistenceMock.getJob.mockReset();
        jobPersistenceMock.getJob.mockResolvedValue(null);
        jobPersistenceMock.updateStatus.mockReset();
        jobPersistenceMock.updateStatus.mockResolvedValue(undefined);
        jobPersistenceMock.updateLastAccessed.mockReset();
        jobPersistenceMock.updateLastAccessed.mockResolvedValue(undefined);
        jobPersistenceMock.claimJobForRestoration.mockReset();
        jobPersistenceMock.claimJobForRestoration.mockResolvedValue(false);
        jobPersistenceMock.takeOverStaleJob.mockReset();
        jobPersistenceMock.takeOverStaleJob.mockResolvedValue(false);
        restoreJobSpy.mockReset();
        readFileSpy.mockClear();
        subtitleFileCacheGetSpy.mockReset();
        subtitleFileCacheGetSpy.mockResolvedValue(null);
        outputDir = await mkdtemp(nodePath.join(tmpdir(), 'lumastra-c1-seam-'));
        await mkdir(nodePath.join(outputDir, 'stream_0'), { recursive: true });
        await writeFile(
            nodePath.join(outputDir, 'stream_0', 'segment_00000.m4s'),
            Buffer.from('fake-m4s-bytes'),
        );
    });

    afterEach(async () => {
        if (outputDir) await rm(outputDir, { recursive: true, force: true });
    });

    it('cookie mirror and /api/v1 dispatch to the SAME real handler', () => {
        expect(mirrorModule.GET).toBe(v1Module.GET);
    });

    it('rejects a resident job for a DIFFERENT item (404), and does not refresh its lastAccessedAt', async () => {
        const jobY = makeJob(outputDir, ITEM_Y);
        installRegistry({ 'session-1': jobY });

        const res = await callGet(
            v1Module.GET,
            makeEvent({
                itemId: ITEM_X,
                path: 'stream_0/segment_00000.m4s',
                playSessionId: 'session-1',
                user: ADMIN_USER,
            }),
        );

        expect(res.status).toBe(404);
        // getJobByPlaySession (not getJob) is the lookup the binding check
        // uses — it never refreshes lastAccessedAt for a rejected request.
        expect(getJobByPlaySessionSpy).toHaveBeenCalledWith('session-1');
        expect(getJobSpy).not.toHaveBeenCalled();
    });

    it('control: the SAME job/session through its OWN item serves 200', async () => {
        const jobY = makeJob(outputDir, ITEM_Y);
        installRegistry({ 'session-1': jobY });

        const res = await callGet(
            v1Module.GET,
            makeEvent({
                itemId: ITEM_Y,
                path: 'stream_0/segment_00000.m4s',
                playSessionId: 'session-1',
                user: ADMIN_USER,
            }),
        );

        expect(res.status).toBe(200);
        // The serving path does call getJob, so the reject case's
        // "never called" above is not vacuous.
        expect(getJobSpy).toHaveBeenCalled();
    });

    it('never serves the output marker, even through the job’s own item', async () => {
        const jobY = makeJob(outputDir, ITEM_Y);
        installRegistry({ 'session-1': jobY });
        await writeOutputMarker(outputDir, { itemId: ITEM_Y, podName: 'pod-a', jobId: 'job-y' });

        const res = await callGet(
            v1Module.GET,
            makeEvent({
                itemId: ITEM_Y,
                path: '.lumastra-output.json',
                playSessionId: 'session-1',
                user: ADMIN_USER,
            }),
        );

        expect(res.status).toBe(400);
    });

    it('rejects the same cross-item request through the /api cookie mirror', async () => {
        const jobY = makeJob(outputDir, ITEM_Y);
        installRegistry({ 'session-1': jobY });

        const res = await callGet(
            mirrorModule.GET,
            makeEvent({
                itemId: ITEM_X,
                path: 'stream_0/segment_00000.m4s',
                playSessionId: 'session-1',
                user: ADMIN_USER,
                mirror: true,
            }),
        );

        expect(res.status).toBe(404);
    });

    it('rejects a raw preview-cache-* PlaySessionId sent directly by a client (404)', async () => {
        const artifactJob = makeJob(outputDir, ITEM_X);
        installRegistry({ 'preview-cache-deadbeef': artifactJob });
        // No PreviewSession is ever registered under the RAW artifact id —
        // getPreviewSessionMock stays "no record" for it.

        const res = await callGet(
            v1Module.GET,
            makeEvent({
                itemId: ITEM_X,
                path: 'stream_0/segment_00000.m4s',
                playSessionId: 'preview-cache-deadbeef',
                user: ADMIN_USER,
            }),
        );

        expect(res.status).toBe(404);
    });

    // Fix round 1 minor: sessionKey() (ffmpeg-transcode.service.ts) lowercases
    // every PlaySessionId before it keys the job registry Map, so a
    // case-sensitive prefix check would miss an UPPERCASE raw artifact id and
    // fall through to the resident-job lookup, which WOULD find the artifact.
    it('rejects a raw preview-cache-* id sent with different CASE (404)', async () => {
        const artifactJob = makeJob(outputDir, ITEM_X);
        installRegistry({ 'preview-cache-deadbeef': artifactJob });

        const res = await callGet(
            v1Module.GET,
            makeEvent({
                itemId: ITEM_X,
                path: 'stream_0/segment_00000.m4s',
                playSessionId: 'PREVIEW-CACHE-deadbeef',
                user: ADMIN_USER,
            }),
        );

        expect(res.status).toBe(404);
    });

    it('control: the legitimate viewer id for that same artifact serves 200', async () => {
        const artifactJob = makeJob(outputDir, ITEM_X);
        installRegistry({ 'preview-cache-deadbeef': artifactJob });
        getPreviewSessionMock.mockResolvedValue({
            playSessionId: 'preview-item-x-1700000000000',
            itemId: ITEM_X,
            cacheKey: 'deadbeef',
        });

        const res = await callGet(
            v1Module.GET,
            makeEvent({
                itemId: ITEM_X,
                path: 'stream_0/segment_00000.m4s',
                playSessionId: 'preview-item-x-1700000000000',
                user: ADMIN_USER,
            }),
        );

        expect(res.status).toBe(200);
    });

    it('cache-backed preview M:N: a viewer of item E2 over an artifact warmed for E1 serves 200 (legit — compares the VIEWER session, not the artifact job)', async () => {
        const artifactJob = makeJob(outputDir, 'item-e1'); // warmed by the E1 viewer
        installRegistry({ 'preview-cache-sharedfile': artifactJob });
        getPreviewSessionMock.mockResolvedValue({
            playSessionId: 'preview-item-e2-1700000000000',
            itemId: 'item-e2', // THIS viewer's own item — differs from the artifact job's
            cacheKey: 'sharedfile',
        });
        KNOWN_ITEM_IDS.add('item-e2');

        const res = await callGet(
            v1Module.GET,
            makeEvent({
                itemId: 'item-e2',
                path: 'stream_0/segment_00000.m4s',
                playSessionId: 'preview-item-e2-1700000000000',
                user: ADMIN_USER,
            }),
        );

        expect(res.status).toBe(200);
    });

    it('cache-backed preview cross-item: a viewer of item X requesting through a preview session bound to item Y gets 404', async () => {
        const artifactJob = makeJob(outputDir, ITEM_Y);
        installRegistry({ 'preview-cache-yfile': artifactJob });
        getPreviewSessionMock.mockResolvedValue({
            playSessionId: 'preview-item-y-1700000000000',
            itemId: ITEM_Y,
            cacheKey: 'yfile',
        });

        const res = await callGet(
            v1Module.GET,
            makeEvent({
                itemId: ITEM_X,
                path: 'stream_0/segment_00000.m4s',
                playSessionId: 'preview-item-y-1700000000000',
                user: ADMIN_USER,
            }),
        );

        expect(res.status).toBe(404);
    });

    it('a syntactically valid but unknown UUID gets 404 (internalId resolves to null, both gates would otherwise skip)', async () => {
        const unknownId = 'cccccccc-0000-0000-0000-cccccccccccc';
        const jobUnderUnknown = makeJob(outputDir, unknownId);
        installRegistry({ 'session-unknown': jobUnderUnknown });
        // unknownId is deliberately NOT in KNOWN_ITEM_IDS — resolveAnyMediaId
        // returns internalId: null, mirroring resolveUuid's real contract.

        const res = await callGet(
            v1Module.GET,
            makeEvent({
                itemId: unknownId,
                path: 'stream_0/segment_00000.m4s',
                playSessionId: 'session-unknown',
                user: ADMIN_USER,
            }),
        );

        expect(res.status).toBe(404);
    });

    it('rejects a foreign-item resident job on the SUBTITLE playlist path too — the binding sits above sub-resource dispatch', async () => {
        const jobY = makeJob(outputDir, ITEM_Y);
        installRegistry({ 'session-1': jobY });

        const url = new URL(
            `https://example.test/api/v1/playback/${ITEM_X}/hls/subs_0/index.m3u8?PlaySessionId=session-1&SubtitleIndex=0&fileId=some-file`,
        );
        const event = {
            params: { id: ITEM_X, path: 'subs_0/index.m3u8' },
            url,
            request: new Request(url),
            locals: { user: ADMIN_USER },
        } as unknown as RequestEvent;

        const res = await callGet(v1Module.GET, event);

        expect(res.status).toBe(404);
    });

    // ── Fix round 1, Important #2: subtitle segment `fileId` scoping, at ROUTE
    // level (research §10.3 / task-2-report.md). The C1 job->item binding above
    // only verifies the PlaySessionId's job/session belongs to the gated item —
    // it never inspects the `fileId` query param, and a disk-cache HIT needs no
    // job comparison at all. These two cases drive the REAL
    // `resolvePlaybackSelection` (unmocked in this file) against `mockSql`, so
    // the "file belongs to item" predicate itself runs for real, not just the
    // mocked stand-in `subtitle-handler.test.ts` uses. ─────────────────────────
    describe('subtitle segment fileId scoping', () => {
        const FILE_ID_X = 'aaaaaaaa-1111-2222-3333-444444444444'; // belongs to ITEM_X
        const FOREIGN_FILE_ID = 'bbbbbbbb-1111-2222-3333-444444444444'; // does NOT

        // The real `getFilesForMediaItem` query (media-files.queries.ts) — the
        // ONLY sql call this predicate makes — has exactly one interpolation,
        // `mfi.media_item_id`. Only ITEM_X "has" a file, and it is FILE_ID_X.
        function installMediaFilesSql(): void {
            // `mockSql` is declared as `vi.fn(async () => [] as unknown[])`
            // (a no-arg tag), so a dispatching implementation needs a cast —
            // JS ignores declared arity at runtime; only the static type
            // needs help here.
            const dispatch = async (
                strings: TemplateStringsArray,
                ...values: unknown[]
            ): Promise<unknown[]> => {
                const text = strings.join('');
                if (text.includes('FROM media_files')) {
                    const mediaItemId = values[0];
                    if (mediaItemId === ITEM_X) {
                        return [
                            {
                                id: FILE_ID_X,
                                file_path: '/media/x.mkv',
                                is_default: true,
                                sort_order: 0,
                                label: null,
                                part_number: null,
                            },
                        ];
                    }
                    return [];
                }
                return [];
            };
            mockSql.mockImplementation(dispatch as unknown as () => Promise<unknown[]>);
        }

        it('rejects a fileId that belongs to a DIFFERENT item — 404, disk cache never read', async () => {
            // Session/job legitimately bound to ITEM_X: the C1 binding above
            // passes trivially, isolating this test to the fileId predicate.
            const jobX = makeJob(outputDir, ITEM_X);
            installRegistry({ 'session-1': jobX });
            installMediaFilesSql();
            // Proves a hit WOULD serve real bytes if reached — the assertion
            // below (never called) is meaningful, not vacuous.
            subtitleFileCacheGetSpy.mockResolvedValue(
                'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nForeign item text\n',
            );

            const url = new URL(
                `https://example.test/api/v1/playback/${ITEM_X}/hls/subs_0/seg_00000.vtt` +
                    `?PlaySessionId=session-1&SubtitleIndex=0&fileId=${FOREIGN_FILE_ID}`,
            );
            const event = {
                params: { id: ITEM_X, path: 'subs_0/seg_00000.vtt' },
                url,
                request: new Request(url),
                locals: { user: ADMIN_USER },
            } as unknown as RequestEvent;

            const res = await callGet(v1Module.GET, event);

            expect(res.status).toBe(404);
            expect(subtitleFileCacheGetSpy).not.toHaveBeenCalled();
        });

        it('control: the item’s own fileId still serves 200 with the cached cue text', async () => {
            const jobX = makeJob(outputDir, ITEM_X);
            installRegistry({ 'session-1': jobX });
            installMediaFilesSql();
            subtitleFileCacheGetSpy.mockResolvedValue(
                'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nOwn item text\n',
            );

            const url = new URL(
                `https://example.test/api/v1/playback/${ITEM_X}/hls/subs_0/seg_00000.vtt` +
                    `?PlaySessionId=session-1&SubtitleIndex=0&fileId=${FILE_ID_X}`,
            );
            const event = {
                params: { id: ITEM_X, path: 'subs_0/seg_00000.vtt' },
                url,
                request: new Request(url),
                locals: { user: ADMIN_USER },
            } as unknown as RequestEvent;

            const res = await callGet(v1Module.GET, event);

            expect(res.status).toBe(200);
            expect(subtitleFileCacheGetSpy).toHaveBeenCalledWith(FILE_ID_X, 0, null);
            expect(await res.text()).toContain('Own item text');
        });
    });

    it('a non-admin authenticated user: the library/age gate runs for real and still passes for X, while the binding check rejects job Y', async () => {
        const jobY = makeJob(outputDir, ITEM_Y);
        installRegistry({ 'session-1': jobY });

        const res = await callGet(
            v1Module.GET,
            makeEvent({
                itemId: ITEM_X,
                path: 'stream_0/segment_00000.m4s',
                playSessionId: 'session-1',
                user: NON_ADMIN_USER,
            }),
        );

        expect(res.status).toBe(404);
    });

    it('control: the same non-admin user through job Y-s own item serves 200', async () => {
        const jobY = makeJob(outputDir, ITEM_Y, 'plain');
        installRegistry({ 'session-1': jobY });

        const res = await callGet(
            v1Module.GET,
            makeEvent({
                itemId: ITEM_Y,
                path: 'stream_0/segment_00000.m4s',
                playSessionId: 'session-1',
                user: NON_ADMIN_USER,
            }),
        );

        expect(res.status).toBe(200);
    });

    // ── Fix round 1, Important #3(a): raw-id parity (research §10.5) ────────
    // The bound set B admits BOTH the resolved internalId and the raw URL id
    // because the raw id resolved to that internalId — never a third,
    // unrelated id. Requires the resolver fake to actually return raw !=
    // internalId (CANONICAL_MAP), which every other case in this file never
    // exercises (identity-only KNOWN_ITEM_IDS).
    describe('raw-id parity (canonical merge)', () => {
        const ITEM_X_OLD = 'dddddddd-0000-0000-0000-dddddddddddd';
        const ITEM_X_NEW = 'eeeeeeee-0000-0000-0000-eeeeeeeeeeee';

        it('admits a canonical-duplicate raw id whose merge target the job itemId still names', async () => {
            CANONICAL_MAP.set(ITEM_X_OLD, ITEM_X_NEW);
            KNOWN_ITEM_IDS.add(ITEM_X_NEW);
            // Job created before the merge still holds the OLD (pre-merge) id —
            // e.g. a client's segment request racing a canonical merge.
            const jobOld = makeJob(outputDir, ITEM_X_OLD);
            installRegistry({ 'session-1': jobOld });

            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_X_OLD, // client still using the pre-merge URL
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: 'session-1',
                    user: ADMIN_USER,
                }),
            );

            expect(res.status).toBe(200);
        });

        it('does not let the raw id admit a THIRD, unrelated item (raw != internalId; job itemId is neither)', async () => {
            CANONICAL_MAP.set(ITEM_X_OLD, ITEM_X_NEW);
            KNOWN_ITEM_IDS.add(ITEM_X_NEW);
            const ITEM_Z = 'ffffffff-0000-0000-0000-ffffffffffff';
            KNOWN_ITEM_IDS.add(ITEM_Z);
            const jobZ = makeJob(outputDir, ITEM_Z);
            installRegistry({ 'session-1': jobZ });

            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_X_OLD,
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: 'session-1',
                    user: ADMIN_USER,
                }),
            );

            expect(res.status).toBe(404);
        });
    });

    // ── Fix round 1, Important #3(b): persisted-only restore, at ROUTE level
    // (not just the job-restoration.test.ts unit) — proves internalId/itemId
    // actually reach job-restoration.ts through the real handler wiring
    // (lumastra-segment-handler.ts's restoreHlsJobIfMissing call). ──────────
    describe('persisted-only (cross-pod DB restore)', () => {
        let persistedDir: string;

        // Fix round 2: status:'stopped'/pod_name:null (the round-1 shape) makes
        // the stale-owner/takeover block unreachable regardless of where the
        // binding check sits, so the "takeover/claim not called" assertions
        // below could not fail either way — same defect the job-restoration.ts
        // unit test had (round 1, Important #2). status:'running' + a
        // DIFFERENT, stale-owner pod_name makes that branch reachable, so
        // these assertions are only true because the binding check runs
        // before it.
        function makePersistedMetadata(
            itemId: string,
            username = ADMIN_USER.username,
        ): Record<string, unknown> {
            return {
                play_session_id: 'session-persisted-only',
                job_id: 'job-persisted',
                item_id: itemId,
                user_id: null,
                status: 'running',
                mode: 'full',
                output_dir: persistedDir,
                segment_offset: 0,
                config: { itemId, fileId: 'file-1', username },
                transcode_decision: null,
                pod_name: 'pod-b', // a DIFFERENT, stale pod (currentPodName is process.env.HOSTNAME)
                can_restore: true,
                error_message: null,
                created_at: new Date(),
                updated_at: new Date(),
                last_accessed_at: new Date(0), // hasn't served in ages -> takeover branch reachable
                expires_at: new Date(Date.now() + 60_000),
            };
        }

        beforeEach(async () => {
            // No resident job under this PlaySessionId — forces the
            // job === undefined path into restoreHlsJobIfMissing.
            installRegistry({});
            persistedDir = await mkdtemp(nodePath.join(tmpdir(), 'lumastra-c1-persisted-'));
            await mkdir(nodePath.join(persistedDir, 'stream_0'), { recursive: true });
            await writeFile(
                nodePath.join(persistedDir, 'stream_0', 'segment_00000.m4s'),
                Buffer.from('persisted-segment-bytes'),
            );
        });

        afterEach(async () => {
            if (persistedDir) await rm(persistedDir, { recursive: true, force: true });
        });

        it('rejects a persisted row for a DIFFERENT item — zero readFile/takeover/claim/restore', async () => {
            jobPersistenceMock.getJob.mockResolvedValue(makePersistedMetadata(ITEM_Y));
            readFileSpy.mockClear();

            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_X,
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: 'session-persisted-only',
                    user: ADMIN_USER,
                }),
            );

            expect(res.status).toBe(404);
            expect(jobPersistenceMock.takeOverStaleJob).not.toHaveBeenCalled();
            expect(jobPersistenceMock.claimJobForRestoration).not.toHaveBeenCalled();
            expect(restoreJobSpy).not.toHaveBeenCalled();
            expect(readFileSpy).not.toHaveBeenCalled();
        });

        // A /j PlaySessionId has no play_sessions row, so verifyPlaySessionOwnership
        // passes it as "row absent"; the transcode row's own owner must refuse it.
        it("rejects another user's persisted row for the SAME item — zero readFile/takeover/claim/restore", async () => {
            jobPersistenceMock.getJob.mockResolvedValue(
                makePersistedMetadata(ITEM_Y, 'someone-else'),
            );
            readFileSpy.mockClear();

            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_Y,
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: 'session-persisted-only',
                    user: ADMIN_USER,
                }),
            );

            expect(res.status).toBe(404);
            expect(jobPersistenceMock.takeOverStaleJob).not.toHaveBeenCalled();
            expect(jobPersistenceMock.claimJobForRestoration).not.toHaveBeenCalled();
            expect(restoreJobSpy).not.toHaveBeenCalled();
            expect(readFileSpy).not.toHaveBeenCalled();
        });

        it('control: the same "stale owner" shape with a MATCHING item takes over, serves 200, and reads the segment from disk', async () => {
            jobPersistenceMock.getJob.mockResolvedValue(makePersistedMetadata(ITEM_Y));
            // The spawn that wrote the persisted output stamped it for ITEM_Y
            // (unstamped output is never disk-served — HLS re-measure §6.3).
            await writeOutputMarker(persistedDir, {
                itemId: ITEM_Y,
                podName: 'pod-b',
                jobId: 'job-persisted',
            });

            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_Y,
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: 'session-persisted-only',
                    user: ADMIN_USER,
                }),
            );

            expect(res.status).toBe(200);
            expect(await res.text()).toBe('persisted-segment-bytes');
            // Proves the "stale owner" shape genuinely fires when the binding
            // allows it through — the reject test's "not called" assertions
            // are meaningful, not vacuous (fix round 2 test-fidelity minor).
            expect(jobPersistenceMock.takeOverStaleJob).toHaveBeenCalled();
            expect(readFileSpy).toHaveBeenCalled();
        });
    });

    // ── Deferred Task 1 seam gaps ────────────────────────────────────────────

    // A NON-cache preview (trailer child / Next-Up episode) has a
    // PreviewSession record but no cacheKey: its job runs under the viewer's
    // own id with `config.itemId === session.itemId`, so the final re-check
    // on the served job stays live for it (only the cache-backed M:N case is
    // exempt from that re-check).
    describe('non-cache preview (trailer / Next-Up)', () => {
        const VIEWER = 'preview-item-x-1700000000000-trailer';

        it('control: the viewer’s own item serves 200', async () => {
            installRegistry({ [VIEWER]: makeJob(outputDir, ITEM_X) });
            getPreviewSessionMock.mockResolvedValue({ playSessionId: VIEWER, itemId: ITEM_X });

            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_X,
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: VIEWER,
                    user: ADMIN_USER,
                }),
            );

            expect(res.status).toBe(200);
        });

        it('a session recorded for item Y, requested through item X, gets 404 before any job lookup', async () => {
            installRegistry({ [VIEWER]: makeJob(outputDir, ITEM_Y) });
            getPreviewSessionMock.mockResolvedValue({ playSessionId: VIEWER, itemId: ITEM_Y });

            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_X,
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: VIEWER,
                    user: ADMIN_USER,
                }),
            );

            expect(res.status).toBe(404);
            expect(getJobSpy).not.toHaveBeenCalled();
        });

        it('a session recorded for item X whose job serves item Y gets 404 from the final re-check', async () => {
            installRegistry({ [VIEWER]: makeJob(outputDir, ITEM_Y) });
            getPreviewSessionMock.mockResolvedValue({ playSessionId: VIEWER, itemId: ITEM_X });

            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_X,
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: VIEWER,
                    user: ADMIN_USER,
                }),
            );

            expect(res.status).toBe(404);
        });
    });

    // A cache-backed preview whose artifact job was reaped is served straight
    // from the complete artifact on disk — that path must still be bound to
    // the viewer's own item.
    describe('cache-backed preview, no resident job, complete artifact on disk', () => {
        const VIEWER = 'preview-item-y-1700000000000';

        beforeEach(async () => {
            installRegistry({});
            await writeFile(nodePath.join(outputDir, '.ready'), '');
            previewCacheStoreMock.dirFor.mockImplementation(() => outputDir);
            getPreviewSessionMock.mockResolvedValue({
                playSessionId: VIEWER,
                itemId: ITEM_Y,
                cacheKey: 'donefile',
            });
        });

        afterEach(() => {
            previewCacheStoreMock.dirFor.mockImplementation((k: string) => k);
        });

        it('requested through a foreign item: 404, the artifact is never read', async () => {
            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_X,
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: VIEWER,
                    user: ADMIN_USER,
                }),
            );

            expect(res.status).toBe(404);
            expect(previewCacheStoreMock.dirFor).not.toHaveBeenCalled();
            expect(readFileSpy).not.toHaveBeenCalled();
        });

        it('control: through the viewer’s own item the finished bytes are served from disk', async () => {
            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_Y,
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: VIEWER,
                    user: ADMIN_USER,
                }),
            );

            expect(res.status).toBe(200);
            expect(await res.text()).toBe('fake-m4s-bytes');
        });
    });

    // Case 7's other half: a non-admin whose library group is DENIED for the
    // item is refused by the real library gate even when the job belongs to
    // that item — the binding never admits what the gate refuses.
    describe('non-admin with a denied library group', () => {
        function installDeniedLibrary(): void {
            const dispatch = async (strings: TemplateStringsArray): Promise<unknown[]> => {
                const text = strings.join('');
                if (text.includes('library_group_permissions')) {
                    return [{ library_group_id: 'lg-x', allowed_groups: ['vip'] }];
                }
                if (text.includes('AS accessible')) return [{ accessible: false }];
                return [];
            };
            mockSql.mockImplementation(dispatch as unknown as () => Promise<unknown[]>);
        }

        beforeEach(() => {
            invalidateLibraryGroupPermissionsCache();
            installDeniedLibrary();
            installRegistry({ 'session-1': makeJob(outputDir, ITEM_X, 'plain') });
        });

        afterEach(() => {
            invalidateLibraryGroupPermissionsCache();
        });

        it('the gate refuses X (404) before the handler looks at any job', async () => {
            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_X,
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: 'session-1',
                    user: NON_ADMIN_USER,
                }),
            );

            expect(res.status).toBe(404);
            expect(getJobByPlaySessionSpy).not.toHaveBeenCalled();
        });

        it('control: a member of the allowed group gets 200 for the same job', async () => {
            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_X,
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: 'session-1',
                    user: { ...NON_ADMIN_USER, userGroups: ['VIP'] },
                }),
            );

            expect(res.status).toBe(200);
        });
    });

    // `isPreviewSession` folds case (lumastra-segment-handler.ts): an
    // uppercase `PREVIEW-` id is exempt from the ffmpegAvailable 503 like a
    // real preview id, and is still bound to the item through the
    // resident-job check — not rejected outright.
    describe('isPreviewSession case-fold', () => {
        const UPPER = 'PREVIEW-item-x-1700000000000';

        beforeEach(() => {
            vi.spyOn(features, 'ffmpegAvailable', 'get').mockReturnValue(false);
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('an uppercase PREVIEW- id skips the ffmpegAvailable 503 and serves its own item', async () => {
            installRegistry({ [UPPER.toLowerCase()]: makeJob(outputDir, ITEM_X) });

            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_X,
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: UPPER,
                    user: ADMIN_USER,
                }),
            );

            expect(res.status).toBe(200);
        });

        it('...and is still bound: its job for a DIFFERENT item gets 404', async () => {
            installRegistry({ [UPPER.toLowerCase()]: makeJob(outputDir, ITEM_Y) });

            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_X,
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: UPPER,
                    user: ADMIN_USER,
                }),
            );

            expect(res.status).toBe(404);
        });

        it('control: a real-playback id gets the 503 while ffmpeg is unavailable', async () => {
            installRegistry({ 'session-1': makeJob(outputDir, ITEM_X) });

            const res = await callGet(
                v1Module.GET,
                makeEvent({
                    itemId: ITEM_X,
                    path: 'stream_0/segment_00000.m4s',
                    playSessionId: 'session-1',
                    user: ADMIN_USER,
                }),
            );

            expect(res.status).toBe(503);
        });
    });
});
