// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Route-seam regression for the C27 fix (fix round 1): this /j/Videos route
 * never runs `withIdResolution`, so it did not populate `internalId` when
 * calling `handleHlsSegment` — the fix landed for /api/v1 but left every
 * tvOS/AVPlayer client (which requests synthetic I-frame trickplay via this
 * exact route — see playback.service.ts's `syntheticIframes` flag) with
 * every `iframe_XXXXX.ts?synthetic=true` request unconditionally 404ing,
 * since `resolveTrickplayFile` in iframe-handler.ts treats a missing
 * `internalId` as unresolvable.
 *
 * This route already calls `checkMediaAccess(sql, params.itemId, user)`
 * directly (no id-resolution middleware — every other /j route does the
 * same), which only works because `params.itemId` IS the internal
 * `media_items.id` on this compat surface. `internalId: params.itemId` makes
 * that same assumption available to the synthetic I-frame handlers, so a
 * trickplay `fileId` is scoped to THIS item exactly as it is on /api/v1.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

const mockCheckMediaAccess = vi.fn();
const mockGetDb = vi.fn();
const mockResolvePlaybackSelection = vi.fn();
const mockGetSpriteSheet = vi.fn();
const mockGetJellyfinDiskSpriteSheet = vi.fn();
const mockGenerateSyntheticIFrame = vi.fn();

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));
vi.mock('$lib/server/database/index.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

// C1 (fix plan 6) existence check leaf — mocked wholesale so this file
// doesn't need the real module's unrelated transitive dependencies. ITEM_A
// below is not a UUID, so isUuid() skips calling this in every case here;
// still mocked so the module resolves.
vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    mediaItemExistsById: vi.fn(async () => true),
}));

vi.mock('$lib/server/database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: (...args: unknown[]) => mockResolvePlaybackSelection(...args),
}));

vi.mock('$lib/server/services/trickplay-storage.service.js', () => ({
    getSpriteSheet: (...args: unknown[]) => mockGetSpriteSheet(...args),
}));

vi.mock('$lib/server/tasks/builtin/native/trickplay-providers/jellyfin-disk.js', () => ({
    getJellyfinDiskSpriteSheet: (...args: unknown[]) => mockGetJellyfinDiskSpriteSheet(...args),
}));

vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    getMediaItemRuntime: vi.fn(),
}));

vi.mock('$lib/server/services/ffmpeg-transcode.service.js', () => ({
    getFFmpegTranscodeService: () => ({
        getJob: vi.fn(() => undefined),
        // C1 (fix plan 6): the job->item binding check looks up the resident
        // job with getJobByPlaySession (never getJob, which would refresh
        // lastAccessedAt for a request this check might reject).
        getJobByPlaySession: vi.fn(() => undefined),
    }),
    getKeyframeSegmentIndexForTime: () => 0,
    getKeyframeSegmentStartTime: () => 0,
}));
vi.mock('$lib/server/services/transcode-job-persistence.service.js', () => ({
    getCurrentPodName: () => process.env.HOSTNAME || 'unknown',
    getTranscodeJobPersistenceService: () => ({}),
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackHlsSegmentForSession: vi.fn(), trackTrickplay: vi.fn() },
}));
vi.mock('$lib/server/services/playback-telemetry.service.js', () => ({
    playbackTelemetryService: { record: vi.fn(async () => {}) },
}));
vi.mock('$lib/server/services/preview-session.service.js', () => ({
    getPreviewSession: vi.fn(),
}));
vi.mock('$lib/server/services/segment-delivery-failure.service.js', () => ({
    recordFailure: vi.fn(),
}));

vi.mock('$lib/server/jellyfin.js', () => ({
    jellyfinMediaService: { getItemInfo: vi.fn() },
}));

// calculateSpritePosition is pure — kept real; generateSyntheticIFrame spawns
// ffmpeg, so it's stubbed.
vi.mock('$lib/server/utils/synthetic-iframe.js', async () => {
    const actual = await vi.importActual<typeof import('$lib/server/utils/synthetic-iframe.js')>(
        '$lib/server/utils/synthetic-iframe.js',
    );
    return {
        ...actual,
        generateSyntheticIFrame: (...args: unknown[]) => mockGenerateSyntheticIFrame(...args),
    };
});

const { GET } = await import('./+server.js');
const callGet = (event: RequestEvent) =>
    (GET as unknown as (event: RequestEvent) => Promise<Response>)(event);

const ITEM_A = 'item-a-internal-id';
const FILE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FILE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // belongs to a different item

function makeEvent(fileId: string): RequestEvent {
    const qs = new URLSearchParams({
        PlaySessionId: 'session-1',
        synthetic: 'true',
        trickplay_width: '320',
        trickplay_interval: '10000',
        trickplay_count: '100',
        trickplay_tile_width: '10',
        trickplay_tile_height: '10',
        fileId,
    });
    const url = new URL(
        `https://example.test/j/Videos/${ITEM_A}/hls/iframe_00000.ts?${qs.toString()}`,
    );
    return {
        params: { itemId: ITEM_A, path: 'iframe_00000.ts' },
        url,
        request: new Request(url),
        locals: { user: { userId: 'u1', username: 'aleks' } },
    } as unknown as RequestEvent;
}

describe('/j/Videos/[itemId]/hls/[...path] synthetic I-frame fileId scoping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockCheckMediaAccess.mockResolvedValue(true);
        mockGetJellyfinDiskSpriteSheet.mockResolvedValue(null);
        mockGenerateSyntheticIFrame.mockResolvedValue(Buffer.from('ts-segment'));
    });

    it('serves the synthetic I-frame segment (200) when fileId belongs to this item', async () => {
        mockResolvePlaybackSelection.mockResolvedValue({
            files: [{ id: FILE_A, file_path: '/data/media/a.mkv' }],
            fileId: FILE_A,
        });
        mockGetSpriteSheet.mockResolvedValue(Buffer.from('sprite-sheet-bytes'));

        const res = await callGet(makeEvent(FILE_A));

        expect(res.status).toBe(200);
        // internalId reached iframe-handler's resolution call as params.itemId.
        expect(mockResolvePlaybackSelection).toHaveBeenCalledWith(expect.anything(), ITEM_A, {
            fileId: FILE_A,
        });
    });

    it('404s (not a silent pass-through) when fileId belongs to a different item', async () => {
        mockResolvePlaybackSelection.mockResolvedValue({ files: [], fileId: null });

        const res = await callGet(makeEvent(FILE_B));

        expect(res.status).toBe(404);
        expect(mockGetSpriteSheet).not.toHaveBeenCalled();
    });
});
