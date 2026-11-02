// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The renditions POST is a SHIPPED, playback-adjacent endpoint. The primary
 * assertion here is a negative one: a request WITHOUT `pool` behaves exactly as
 * it did before this change. `renditions.ts` had no test file at all before
 * this one, so nothing else establishes that.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockCheckMediaAccess = vi.fn();
const mockGetDb = vi.fn();
const mockResolvePlaybackSelection = vi.fn();
const mockResolveMediaPath = vi.fn();
const mockProbeMediaFile = vi.fn();
const mockRequestRendition = vi.fn();
const mockPrepareQueueDepth = vi.fn();
const mockPendingPrepareSlots = vi.fn();
const mockAdmitAndHoldPrepareSlot = vi.fn();
const mockReleasePrepareSlot = vi.fn();

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => mockCheckMediaAccess(...a),
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => mockGetDb() }));
vi.mock('$lib/server/database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: (...a: unknown[]) => mockResolvePlaybackSelection(...a),
}));
vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: (...a: unknown[]) => mockResolveMediaPath(...a),
}));
vi.mock('$lib/server/utils/ffprobe.js', () => ({
    probeMediaFile: (...a: unknown[]) => mockProbeMediaFile(...a),
}));
vi.mock('$lib/server/services/download-rendition/service.js', () => ({
    requestRendition: (...a: unknown[]) => mockRequestRendition(...a),
}));
vi.mock('$lib/server/database/queries/download-renditions.queries.js', () => ({
    listRenditionsForFile: vi.fn().mockResolvedValue([]),
    prepareQueueDepth: (...a: unknown[]) => mockPrepareQueueDepth(...a),
}));
vi.mock('$lib/server/services/download-rendition/prepare-cap.js', async () => {
    const actual = await vi.importActual<
        typeof import('$lib/server/services/download-rendition/prepare-cap.js')
    >('$lib/server/services/download-rendition/prepare-cap.js');
    return {
        ...actual,
        pendingPrepareSlots: (...a: unknown[]) => mockPendingPrepareSlots(...a),
        admitAndHoldPrepareSlot: (...a: unknown[]) => mockAdmitAndHoldPrepareSlot(...a),
        releasePrepareSlot: (...a: unknown[]) => mockReleasePrepareSlot(...a),
    };
});
vi.mock('$lib/server/config.js', () => ({
    config: {
        FEATURE_DOWNLOAD_RENDITIONS: true,
        DOWNLOAD_RENDITION_MAX_CONCURRENT: 1,
        DOWNLOAD_RENDITION_STALE_SECONDS: 180,
        SERIES_DOWNLOAD_MAX_PREPARATIONS_PER_USER: 1,
        SERIES_DOWNLOAD_QUEUE_BACKPRESSURE_FACTOR: 8,
    },
}));

const { def } = await import('./renditions.js');

function makeEvent(): RequestEvent {
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        params: { id: 'media-1' },
        url: new URL('http://localhost/api/v1/media/media-1/renditions'),
        request: new Request('http://localhost/api/v1/media/media-1/renditions', {
            method: 'POST',
            body: '{}',
        }),
    } as unknown as RequestEvent;
}

function makeCtx(body: Record<string, unknown>) {
    return { surface: 'v1', input: { body, query: undefined, params: undefined } };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockCheckMediaAccess.mockResolvedValue(true);
    mockResolvePlaybackSelection.mockResolvedValue({
        fileId: 'file-1',
        files: [{ id: 'file-1', file_path: '/data/x.mkv' }],
    });
    mockResolveMediaPath.mockResolvedValue({ isAccessible: true, containerPath: '/data/x.mkv' });
    mockProbeMediaFile.mockResolvedValue({
        success: true,
        duration: 2700,
        video: { height: 1080, hdr: 'sdr' },
        audioStreams: [{ isDefault: true, absoluteIndex: 1 }],
    });
    mockRequestRendition.mockResolvedValue({
        id: 'r1',
        status: 'queued',
        file_id: 'file-1',
        media_item_id: 'media-1',
        rung_id: '720p',
        audio_index: 1,
        progress_pct: 0,
        size_bytes: null,
        artifact_name: null,
        error_code: null,
        owner_pod: null,
        heartbeat_at: null,
        created_at: new Date(),
        updated_at: new Date(),
        last_accessed_at: new Date(),
    });
    mockPrepareQueueDepth.mockResolvedValue(0);
    mockPendingPrepareSlots.mockResolvedValue([]);
    mockAdmitAndHoldPrepareSlot.mockResolvedValue(true);
});

describe('a request WITHOUT `pool` is unaffected', () => {
    it('accepts the rendition without consulting any cap', async () => {
        const res = await def.handlers.POST!(makeEvent(), makeCtx({ rung: '720p' }) as never);

        expect(res.status).toBe(202);
        expect(mockRequestRendition).toHaveBeenCalledTimes(1);
        // The whole point of the optional field: existing clients never send
        // it, so they are never throttled and this stays additive.
        expect(mockPendingPrepareSlots).not.toHaveBeenCalled();
        expect(mockPrepareQueueDepth).not.toHaveBeenCalled();
    });

    it('is admitted even when the user is over the pool cap', async () => {
        mockPendingPrepareSlots.mockResolvedValue(['someone-elses-slot']);
        const res = await def.handlers.POST!(makeEvent(), makeCtx({ rung: '720p' }) as never);
        expect(res.status).toBe(202);
    });

    it('is admitted even when the server-wide queue is deep', async () => {
        // A human tapping Download is never refused for pool pressure.
        mockPrepareQueueDepth.mockResolvedValue(1000);
        const res = await def.handlers.POST!(makeEvent(), makeCtx({ rung: '720p' }) as never);
        expect(res.status).toBe(202);
    });

    it('holds no prepare slot, so an unattended pool cannot inherit its budget', async () => {
        await def.handlers.POST!(makeEvent(), makeCtx({ rung: '720p' }) as never);
        expect(mockAdmitAndHoldPrepareSlot).not.toHaveBeenCalled();
    });
});

describe('a request WITH `pool`', () => {
    it('is admitted and holds a slot while the rendition is not ready', async () => {
        const res = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ rung: '720p', pool: 'series-next-up' }) as never,
        );

        expect(res.status).toBe(202);
        // Admission and the hold are ONE atomic call now, made BEFORE
        // requestRendition — not a separate hold after the fact.
        expect(mockAdmitAndHoldPrepareSlot).toHaveBeenCalledWith(
            'u1',
            expect.stringContaining('720p'),
            1,
        );
        expect(mockAdmitAndHoldPrepareSlot.mock.invocationCallOrder[0]).toBeLessThan(
            mockRequestRendition.mock.invocationCallOrder[0],
        );
    });

    it('releases the slot immediately when the artifact is already ready', async () => {
        mockRequestRendition.mockResolvedValue({
            id: 'r1',
            status: 'ready',
            file_id: 'file-1',
            media_item_id: 'media-1',
            rung_id: '720p',
            audio_index: 1,
            progress_pct: 100,
            size_bytes: '123',
            artifact_name: 'a.mp4',
            error_code: null,
            owner_pod: null,
            heartbeat_at: null,
            created_at: new Date(),
            updated_at: new Date(),
            last_accessed_at: new Date(),
        });

        const res = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ rung: '720p', pool: 'series-next-up' }) as never,
        );

        expect(res.status).toBe(200);
        // Admission still happens up front (it doesn't know the row will
        // turn out terminal yet); the terminal row then releases what it
        // just held.
        expect(mockAdmitAndHoldPrepareSlot).toHaveBeenCalled();
        expect(mockReleasePrepareSlot).toHaveBeenCalled();
    });

    it('refuses with 503 and never calls requestRendition when admission is refused', async () => {
        // Simulates the atomic admission losing the race under concurrent
        // pool POSTs — the case the old check-then-SADD pair could not
        // enforce. mayAttemptPrepare's pre-check can't catch this: the user
        // holds nothing yet (pendingPrepareSlots is []), so only the atomic
        // call itself refuses.
        mockAdmitAndHoldPrepareSlot.mockResolvedValue(false);

        const res = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ rung: '720p', pool: 'series-next-up' }) as never,
        );

        expect(res.status).toBe(503);
        expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect(mockRequestRendition).not.toHaveBeenCalled();
    });

    it('refuses with 503 + Retry-After at the per-user cap', async () => {
        // 503, not 429: this is a CAPACITY constraint, not a request-rate
        // violation, and it matches the convention the byte path already uses
        // and the client already has durable state for.
        mockPendingPrepareSlots.mockResolvedValue(['file-9:1080p:1']);

        const res = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ rung: '720p', pool: 'series-next-up' }) as never,
        );

        expect(res.status).toBe(503);
        expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect(mockRequestRendition).not.toHaveBeenCalled();
    });

    it('ADMITS a re-POST of a slot the user already holds, even at the cap', async () => {
        // Without this a pool at its cap can never advance a deferred
        // rendition, because a re-POST is the only thing that ever does.
        mockPendingPrepareSlots.mockResolvedValue(['file-1:720p:1']);

        const res = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ rung: '720p', pool: 'series-next-up' }) as never,
        );

        expect(res.status).toBe(202);
        expect(mockRequestRendition).toHaveBeenCalledTimes(1);
    });

    it('refuses with 503 when the server-wide queue is saturated, before any ffprobe', async () => {
        // The global check runs FIRST: resolveSource runs a live ffprobe, and
        // spending one per refused request is exactly the load this protects
        // the box from.
        mockPrepareQueueDepth.mockResolvedValue(8);

        const res = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ rung: '720p', pool: 'series-next-up' }) as never,
        );

        expect(res.status).toBe(503);
        expect(mockProbeMediaFile).not.toHaveBeenCalled();
    });
});

describe('POST refuses a rung the listing never offered', () => {
    /**
     * GET filters the ladder with `rungsForSourceHeight(source.height)` —
     * "never upscale". POST validated only that the rung id EXISTS in the
     * catalogue, so a 480p source happily accepted 720p and 1080p and encoded
     * them: measured on preprod, a 480p film reached 43% of a 720p encode
     * before this check existed. That spends CPU-minutes and gigabytes to hand
     * the caller a file worse than the original, and it means the listing is
     * only advisory — a client that asks for anything else is silently obeyed.
     *
     * Mirrors the audioIndex guard directly above it in the handler, which
     * exists for the same reason: reject at the boundary rather than let it
     * fail (or here, succeed pointlessly) deep inside ffmpeg.
     */
    it('rejects a rung taller than the source with 422, and encodes nothing', async () => {
        mockProbeMediaFile.mockResolvedValue({
            success: true,
            duration: 5600,
            video: { height: 480, hdr: 'sdr' },
            audioStreams: [{ isDefault: true, absoluteIndex: 1 }],
        });

        const res = await def.handlers.POST!(makeEvent(), makeCtx({ rung: '720p' }) as never);

        expect(res.status).toBe(422);
        expect(mockRequestRendition).not.toHaveBeenCalled();
        const body = (await res.json()) as { details?: { field: string; message: string }[] };
        expect(body.details?.[0].field).toBe('rung');
        // The message has to name the source height — the client shows this
        // string, and "not available" alone reads as a claim about the title.
        expect(body.details?.[0].message).toContain('480p');
    });

    it('still accepts a rung at or below the source height', async () => {
        mockProbeMediaFile.mockResolvedValue({
            success: true,
            duration: 5600,
            video: { height: 480, hdr: 'sdr' },
            audioStreams: [{ isDefault: true, absoluteIndex: 1 }],
        });

        const res = await def.handlers.POST!(makeEvent(), makeCtx({ rung: '360p' }) as never);

        expect(res.status).toBe(202);
        expect(mockRequestRendition).toHaveBeenCalled();
    });

    it('leaves a tall source able to request a tall rung', async () => {
        // Default probe in beforeEach is 1080p; 720p must remain accepted.
        const res = await def.handlers.POST!(makeEvent(), makeCtx({ rung: '720p' }) as never);

        expect(res.status).toBe(202);
    });
});

/**
 * The bug this fixes: `resolveSource` invented audio index 0 for a source with
 * no audio stream, then validated the invention against an empty track list — a
 * check that can never pass. GET offered a download rung POST refused forever
 * with a 422, and the user only found out after choosing a quality. 32 of the
 * 90 films on preprod are silent cinema.
 *
 * GET and POST agreeing about what the title has IS the fix, so that agreement
 * is what these assert.
 */
function makeGetEvent(search = ''): RequestEvent {
    const url = new URL(`http://localhost/api/v1/media/media-1/renditions${search}`);
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        params: { id: 'media-1' },
        url,
        request: new Request(url, { method: 'GET' }),
    } as unknown as RequestEvent;
}

const SILENT_PROBE = {
    success: true,
    duration: 2700,
    video: { height: 1080, hdr: 'sdr' },
    audioStreams: [],
};

describe('a source with no audio stream', () => {
    it('GET offers rungs with a null audio index and no audio budget', async () => {
        mockProbeMediaFile.mockResolvedValue(SILENT_PROBE);

        const res = await def.handlers.GET!(makeGetEvent(), makeCtx({}) as never);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.audioIndex).toBeNull();
        expect(body.rungs.length).toBeGreaterThan(0);
        expect(body.rungs[0].audioBitrate).toBe(0);
        // The estimate must match the encode, not quote audio that never exists.
        expect(body.rungs[0].estimatedSizeBytes).toBeGreaterThan(0);
    });

    it('POST accepts the rung GET offered', async () => {
        mockProbeMediaFile.mockResolvedValue(SILENT_PROBE);
        mockRequestRendition.mockResolvedValue({
            id: 'r1',
            status: 'queued',
            file_id: 'file-1',
            media_item_id: 'media-1',
            rung_id: '720p',
            audio_index: null,
            progress_pct: 0,
            size_bytes: null,
            artifact_name: null,
            error_code: null,
            owner_pod: null,
            heartbeat_at: null,
            created_at: new Date(),
            updated_at: new Date(),
            last_accessed_at: new Date(),
        });

        const res = await def.handlers.POST!(makeEvent(), makeCtx({ rung: '720p' }) as never);

        // 202 queued (200 if the artifact already existed). Never 201 — this
        // endpoint does not emit it.
        expect(res.status).toBe(202);
        expect(mockRequestRendition).toHaveBeenCalledWith(
            expect.objectContaining({ audioIndex: null }),
        );
    });

    it('POST still rejects an audio index the source does not have', async () => {
        mockProbeMediaFile.mockResolvedValue(SILENT_PROBE);

        const res = await def.handlers.POST!(
            makeEvent(),
            makeCtx({ rung: '720p', audioIndex: 0 }) as never,
        );

        // Asking for a track that does not exist is a real request error, and
        // stays one. Only an OMITTED index means "whatever this source has".
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.details[0].field).toBe('audioIndex');
        expect(mockRequestRendition).not.toHaveBeenCalled();
    });

    it('GET still rejects an explicit index on an audioless source', async () => {
        mockProbeMediaFile.mockResolvedValue(SILENT_PROBE);

        const res = await def.handlers.GET!(makeGetEvent('?audioIndex=0'), makeCtx({}) as never);

        expect(res.status).toBe(422);
    });
});

describe('a source that has audio is unchanged', () => {
    it('GET resolves and reports the default track', async () => {
        const res = await def.handlers.GET!(makeGetEvent(), makeCtx({}) as never);

        const body = await res.json();
        expect(body.audioIndex).toBe(1);
        expect(body.rungs[0].audioBitrate).toBeGreaterThan(0);
    });

    it('GET rejects an index the source does not have', async () => {
        const res = await def.handlers.GET!(makeGetEvent('?audioIndex=7'), makeCtx({}) as never);
        expect(res.status).toBe(422);
    });
});
