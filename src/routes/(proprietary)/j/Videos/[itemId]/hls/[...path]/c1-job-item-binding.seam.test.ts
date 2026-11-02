// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Seam test for fix plan 6, C1 on the `/j/Videos/[itemId]/hls/[...path]`
 * mount: bind an HLS transcode job to the item its segment URL names.
 *
 * Drives the REAL route handler, the REAL `checkMediaAccess` gate (NOT
 * mocked — `server.test.ts` in this directory mocks it away, which is why
 * this is a separate file per Global Constraint 2), and the REAL
 * `lumastra-segment-handler.ts` (`checkJobItemBinding`). `withJellyfinAuth`
 * is mocked to an identity passthrough (research §8's documented
 * alternative to driving the full Valkey-session leaf set — see
 * `age-gate-c9.test.ts` in the sibling `master.m3u8` directory for that
 * heavier precedent). `mediaItemExistsById` (the route's existence check,
 * fix round 1 — was an inlined query, now calls the shared query-module
 * helper) is mocked as a LEAF, same as `checkMediaAccess`'s own DB reads.
 * Only DB/service leaves are mocked.
 *
 * The `/api/v1` (+ cookie mirror) and showcase mounts are covered in
 * `src/lib/server/handlers/hls/c1-job-item-binding.seam.test.ts` (public
 * tree) and the showcase route's own tree-local seam file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

// DB leaf: every gate here runs as admin, so checkMediaAccess never touches
// sql — this only needs to be non-null so the route's `if (!sql)` guard
// passes.
const mockSql = vi.fn();
vi.mock('$lib/server/database', () => ({ getDb: () => mockSql }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => mockSql }));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => mockSql }));

// Existence-check leaf (fix round 1: the route now calls the shared helper
// instead of an inlined query).
const EXISTING_ITEM_IDS = new Set<string>();
const mediaItemExistsByIdMock = vi.fn(async (_sql: unknown, id: string) =>
    EXISTING_ITEM_IDS.has(id),
);
vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    mediaItemExistsById: (...args: [unknown, string]) => mediaItemExistsByIdMock(...args),
}));

const { transcodeServiceMock, getJobByPlaySessionSpy } = vi.hoisted(() => {
    const getJobByPlaySessionSpy = vi.fn();
    const transcodeServiceMock: Record<string, unknown> = {};
    return { transcodeServiceMock, getJobByPlaySessionSpy };
});
vi.mock('$lib/server/services/ffmpeg-transcode.service.js', () => ({
    getFFmpegTranscodeService: () => transcodeServiceMock,
    getKeyframeSegmentIndexForTime: () => 0,
    getKeyframeSegmentStartTime: () => 0,
}));
vi.mock('$lib/server/services/transcode-job-persistence.service.js', () => ({
    getCurrentPodName: () => process.env.HOSTNAME || 'unknown',
    getTranscodeJobPersistenceService: () => ({
        getJob: async () => null,
        updateStatus: async () => undefined,
        updateLastAccessed: async () => undefined,
        claimJobForRestoration: async () => false,
        takeOverStaleJob: async () => false,
    }),
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackHlsSegmentForSession: vi.fn(), trackTrickplay: vi.fn() },
}));
vi.mock('$lib/server/services/playback-telemetry.service.js', () => ({
    playbackTelemetryService: { record: vi.fn(async () => {}) },
}));
vi.mock('$lib/server/services/preview-session.service.js', () => ({
    getPreviewSession: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/services/segment-delivery-failure.service.js', () => ({
    recordFailure: vi.fn(),
}));
vi.mock('$lib/server/jellyfin.js', () => ({
    jellyfinMediaService: { getItemInfo: vi.fn() },
}));

const { GET } = await import('./+server.js');
const callGet = (event: RequestEvent) =>
    (GET as unknown as (event: RequestEvent) => Promise<Response>)(event);

const ADMIN_USER = {
    userId: 'u-admin',
    username: 'admin',
    ownerIsAdmin: true,
    isAgeRestricted: false,
};

const ITEM_X_DASHED = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const ITEM_X_DASHLESS = ITEM_X_DASHED.replace(/-/g, ''); // same UUID, Jellyfin's dashless spelling
const ITEM_Y = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';

function makeEvent(itemId: string, path: string, playSessionId: string): RequestEvent {
    const url = new URL(
        `https://example.test/j/Videos/${itemId}/hls/${path}?PlaySessionId=${playSessionId}`,
    );
    return {
        params: { itemId, path },
        url,
        request: new Request(url),
        locals: { user: ADMIN_USER },
    } as unknown as RequestEvent;
}

// `username` defaults to ADMIN_USER's spelling — the only requester this
// file drives — since the segment-route ownership check (I1 follow-up,
// lumastra-segment-handler.ts) now compares `job.config.username` to the
// requester before any resident-job seek/serve.
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

function installRegistry(jobs: Record<string, Record<string, unknown>>): void {
    getJobByPlaySessionSpy.mockReset();
    getJobByPlaySessionSpy.mockImplementation((id: string) => jobs[id]);
    Object.assign(transcodeServiceMock, {
        getJob: (id: string) => jobs[id],
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

describe('/j/Videos/[itemId]/hls/[...path] — C1 job->item binding', () => {
    let outputDir: string;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockSql.mockClear();
        mediaItemExistsByIdMock.mockClear();
        EXISTING_ITEM_IDS.clear();
        EXISTING_ITEM_IDS.add(ITEM_X_DASHED);
        EXISTING_ITEM_IDS.add(ITEM_X_DASHLESS);
        EXISTING_ITEM_IDS.add(ITEM_Y);
        outputDir = await mkdtemp(nodePath.join(tmpdir(), 'lumastra-j-c1-seam-'));
        await mkdir(nodePath.join(outputDir, 'stream_0'), { recursive: true });
        await writeFile(
            nodePath.join(outputDir, 'stream_0', 'segment_00000.m4s'),
            Buffer.from('fake-m4s-bytes'),
        );
    });

    afterEach(async () => {
        if (outputDir) await rm(outputDir, { recursive: true, force: true });
    });

    it('rejects a resident job for a DIFFERENT item (404)', async () => {
        installRegistry({ 'session-1': makeJob(outputDir, ITEM_Y) });

        const res = await callGet(
            makeEvent(ITEM_X_DASHED, 'stream_0/segment_00000.m4s', 'session-1'),
        );

        expect(res.status).toBe(404);
    });

    it('control: the same job/session through its OWN item serves 200', async () => {
        installRegistry({ 'session-1': makeJob(outputDir, ITEM_Y) });

        const res = await callGet(makeEvent(ITEM_Y, 'stream_0/segment_00000.m4s', 'session-1'));

        expect(res.status).toBe(200);
    });

    it('a nonexistent (but syntactically valid) UUID is rejected before checkMediaAccess (404)', async () => {
        const unknownId = 'cccccccc-0000-0000-0000-cccccccccccc';
        installRegistry({ 'session-x': makeJob(outputDir, unknownId) });
        // unknownId deliberately NOT added to EXISTING_ITEM_IDS.

        const res = await callGet(makeEvent(unknownId, 'stream_0/segment_00000.m4s', 'session-x'));

        expect(res.status).toBe(404);
    });

    it('admits a job whose config.itemId is the DASHED form when the URL uses the DASHLESS Jellyfin form', async () => {
        installRegistry({ 'session-1': makeJob(outputDir, ITEM_X_DASHED) });

        const res = await callGet(
            makeEvent(ITEM_X_DASHLESS, 'stream_0/segment_00000.m4s', 'session-1'),
        );

        expect(res.status).toBe(200);
    });

    // The reverse spelling (deferred Task 1 seam gap): a job created from a
    // Jellyfin client carries the DASHLESS id; a later request for the same
    // item through the DASHED URL is the same item and must be admitted.
    it('admits a job whose config.itemId is the DASHLESS form when the URL uses the DASHED form', async () => {
        installRegistry({ 'session-1': makeJob(outputDir, ITEM_X_DASHLESS) });

        const res = await callGet(
            makeEvent(ITEM_X_DASHED, 'stream_0/segment_00000.m4s', 'session-1'),
        );

        expect(res.status).toBe(200);
    });

    it('control: a DASHLESS job for a different item is still rejected through a DASHED URL (404)', async () => {
        installRegistry({ 'session-1': makeJob(outputDir, ITEM_Y.replace(/-/g, '')) });

        const res = await callGet(
            makeEvent(ITEM_X_DASHED, 'stream_0/segment_00000.m4s', 'session-1'),
        );

        expect(res.status).toBe(404);
    });
});
