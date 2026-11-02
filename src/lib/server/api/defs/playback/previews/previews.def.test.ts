// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /playback/previews — coalescing, admission, and the 201-only contract.
 *
 * This is the endpoint every NATIVE client uses, and it was the only preview
 * creator that neither coalesced onto a running preview nor passed admission
 * control; the legacy SPA route (`/playback/{itemId}/preview-session`) had both.
 * Prod context: an iOS home screen cycling five hero items issued 8,181 preview
 * creations in one day, a flat ~450/hour for eighteen hours.
 *
 * Be precise about what that cost, because the obvious reading is wrong: those
 * were NOT 8,181 FFmpeg jobs. `store.acquire()` returns the existing artifact on
 * a hit and `cleanupPreviewSession` deliberately leaves a cache-backed job
 * running, so repeat passes over the same item re-used the transcode and paid
 * only session bookkeeping. Nor does coalescing fix that pattern — the client
 * DELETEs on rotate-away, so there is no live session left to find. What these
 * tests pin is the narrower, real guarantee: a client that re-requests an item
 * it is STILL holding gets its own session back instead of a duplicate, and
 * every genuinely new preview passes admission control.
 *
 * The 201-on-reuse assertion is not pedantry. The declared contract has exactly
 * one success code and the shipped iOS client accepts `.created` and silently
 * returns nil on anything else — a "more correct" 200 for a reused session
 * would read as a failure to the very clients this path exists for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockFindReusablePreview = vi.fn();
const mockCreatePreview = vi.fn();
const mockGetUserPreviewSessions = vi.fn();
const mockCleanupPreviewSession = vi.fn();
const mockCheckPreviewAdmission = vi.fn();
const mockRelease = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockResolveStart = vi.fn();

// Mutated per-test (default 6, matching config.ts's real default) to exercise
// the eviction-convergence loop without needing real env/ConfigService plumbing.
const mockTrailer = vi.fn();
const mockMediaType = vi.fn();
vi.mock('$lib/server/database/queries/media-extras.queries.js', () => ({
    findLocalTrailerForItem: (...a: unknown[]) => mockTrailer(...a),
    getMediaTypeAndParent: (...a: unknown[]) => mockMediaType(...a),
}));

const mockConfig: { PREVIEW_MAX_PER_USER: number } = { PREVIEW_MAX_PER_USER: 6 };

vi.mock('$lib/server/services/preview-session.service.js', () => ({
    getPreviewSession: vi.fn(),
    getUserPreviewSessions: (...a: unknown[]) => mockGetUserPreviewSessions(...a),
    getUserLiveTvSessionId: vi.fn(),
    cleanupPreviewSession: (...a: unknown[]) => mockCleanupPreviewSession(...a),
    getLiveTvSessionCount: vi.fn(),
    getLiveTvWatcherCount: vi.fn(),
    createPreview: (...a: unknown[]) => mockCreatePreview(...a),
    findReusablePreview: (...a: unknown[]) => mockFindReusablePreview(...a),
}));

vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));

// Real pickEvictionVictim by default (imported lazily below); individual tests
// override it via mockPickEvictionVictim to force the guard-rail branch.
const mockPickEvictionVictim = vi.fn();
vi.mock('$lib/server/services/preview-eviction.js', async () => {
    const actual = await vi.importActual<typeof import('$lib/server/services/preview-eviction.js')>(
        '$lib/server/services/preview-eviction.js',
    );
    mockPickEvictionVictim.mockImplementation(actual.pickEvictionVictim);
    return { pickEvictionVictim: (...a: unknown[]) => mockPickEvictionVictim(...a) };
});

vi.mock('$lib/server/services/preview-admission.service.js', () => ({
    checkPreviewAdmission: (...a: unknown[]) => mockCheckPreviewAdmission(...a),
}));

vi.mock('$lib/server/config/config.service.js', () => ({
    get: (key: string) => (key === 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW' ? true : 0),
}));

vi.mock('$lib/server/database/index.js', () => ({
    getDb: () => ({ query: vi.fn() }),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => mockCheckMediaAccess(...a),
}));

vi.mock('$lib/server/utils/preview-start-position.js', () => ({
    resolvePreviewStartPosition: (...a: unknown[]) => mockResolveStart(...a),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const { def } = await import('./index.js');

const MEDIA_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const CTX = { surface: 'v1' as const };

/** What createPreview / findReusablePreview hand back on success. */
function outcome(over: Record<string, unknown> = {}) {
    return {
        playSessionId: 'preview-1',
        sessionItemId: MEDIA_ID,
        streamUrl: '/api/v1/playback/x/hls/master.m3u8',
        playMethod: 'full_transcode',
        transcodeMode: 'hls',
        hlsStartPosition: 90,
        ...over,
    };
}

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/v1/playback/previews');
    return {
        url,
        params: {},
        request: new Request(url.toString(), { method: 'POST' }),
        locals: { user: { userId: 'u1', username: 'alice' }, authMethod: 'api_key' },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

// `await` rather than a bare return: the handler map's declared type is
// `Promise<Response> | Response`, so returning it directly does not satisfy the
// Promise<Response> annotation.
async function call(body: Record<string, unknown> = {}): Promise<Response> {
    return await def.handlers.POST!(makeEvent(), {
        ...CTX,
        input: { body: { mediaId: MEDIA_ID, ...body } },
    } as never);
}

/** A minimal fake session, enough for the real pickEvictionVictim to rank. */
function fakeSession(playSessionId: string, ageMs: number) {
    return {
        playSessionId,
        createdAt: new Date(Date.now() - ageMs),
        lastHeartbeatAt: null,
        isTrailer: false,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockTrailer.mockResolvedValue(null);
    mockMediaType.mockResolvedValue(null);
    mockConfig.PREVIEW_MAX_PER_USER = 6;
    mockCheckMediaAccess.mockResolvedValue(true);
    mockResolveStart.mockResolvedValue(90);
    mockFindReusablePreview.mockResolvedValue(null);
    mockGetUserPreviewSessions.mockResolvedValue([]);
    mockCheckPreviewAdmission.mockResolvedValue({ admit: true, release: mockRelease });
    mockCreatePreview.mockResolvedValue(outcome());
});

describe('POST /playback/previews — coalescing', () => {
    it('reuses a running preview instead of spawning a second transcode', async () => {
        mockFindReusablePreview.mockResolvedValue(outcome({ playSessionId: 'preview-existing' }));

        const res = await call();

        expect(mockCreatePreview).not.toHaveBeenCalled();
        expect(await res.json()).toMatchObject({ id: 'preview-existing' });
    });

    it('answers a reused preview with 201, the only success code clients accept', async () => {
        mockFindReusablePreview.mockResolvedValue(outcome({ playSessionId: 'preview-existing' }));

        const res = await call();

        expect(res.status).toBe(201);
        expect(res.headers.get('Location')).toContain('preview-existing');
    });

    it('reports a reused preview in the same shape as a created one', async () => {
        // A contract fork visible only on the coalescing path is the failure
        // mode a second hand-written body shape would introduce.
        mockFindReusablePreview.mockResolvedValue(outcome({ playSessionId: 'preview-existing' }));
        const reused = await (await call()).json();

        mockFindReusablePreview.mockResolvedValue(null);
        const created = await (await call()).json();

        expect(Object.keys(reused).sort()).toEqual(Object.keys(created).sort());
    });

    it('keys the reuse lookup on the RESOLVED seek, not the caller-omitted one', async () => {
        // Defaulting the position after the lookup would make every request
        // look like a different preview and defeat coalescing entirely — the
        // exact shape of the prod incident.
        await call();
        expect(mockFindReusablePreview).toHaveBeenCalledWith(
            expect.objectContaining({ requestedItemId: MEDIA_ID, startPositionSeconds: 90 }),
        );
    });

    it('does not consume an admission slot for a reused preview', async () => {
        mockFindReusablePreview.mockResolvedValue(outcome());
        await call();
        expect(mockCheckPreviewAdmission).not.toHaveBeenCalled();
    });

    it('never evicts a running preview to serve a request it could have reused', async () => {
        // Eviction before coalescing is the thrash loop: the reusable session
        // is the one that gets torn down.
        mockFindReusablePreview.mockResolvedValue(outcome());
        await call();
        expect(mockCleanupPreviewSession).not.toHaveBeenCalled();
    });
});

describe('POST /playback/previews — admission control', () => {
    it('refuses a new preview when admission says no', async () => {
        mockCheckPreviewAdmission.mockResolvedValue({
            admit: false,
            reason: 'load_shed',
            message: 'Video previews are temporarily unavailable.',
        });

        const res = await call();

        expect(res.status).toBe(429);
        expect(mockCreatePreview).not.toHaveBeenCalled();
    });

    it('releases the reservation slot on success', async () => {
        await call();
        expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('releases the reservation slot when createPreview throws', async () => {
        // A leaked slot permanently shrinks the global preview budget.
        mockCreatePreview.mockRejectedValue(new Error('ffprobe died'));

        const res = await call();

        expect(res.status).toBe(500);
        expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('releases the reservation slot when createPreview returns an error result', async () => {
        mockCreatePreview.mockResolvedValue({ error: 'no local file', status: 404 });

        const res = await call();

        expect(res.status).toBe(404);
        expect(mockRelease).toHaveBeenCalledTimes(1);
    });
});

describe('POST /playback/previews — access', () => {
    it('reports a denied item as not found rather than forbidden', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);

        const res = await call();

        expect(res.status).toBe(404);
        expect(mockFindReusablePreview).not.toHaveBeenCalled();
        expect(mockCreatePreview).not.toHaveBeenCalled();
    });
});

describe('POST /playback/previews — eviction convergence', () => {
    it('evicts every session over the cap in one create, not just one', async () => {
        // Cap just dropped to 2 (or 3 piled up before this request landed) while
        // the user is sitting on 3 sessions. A single `if`-eviction would only
        // ever remove one, leaving the user permanently over the cap on every
        // subsequent create — this pins that a single create converges instead.
        mockConfig.PREVIEW_MAX_PER_USER = 2;
        mockGetUserPreviewSessions.mockResolvedValue([
            fakeSession('old-1', 30_000),
            fakeSession('old-2', 20_000),
            fakeSession('old-3', 10_000),
        ]);

        await call();

        expect(mockCleanupPreviewSession).toHaveBeenCalledTimes(2);
    });

    it('evicts nothing when already under the cap', async () => {
        mockConfig.PREVIEW_MAX_PER_USER = 6;
        mockGetUserPreviewSessions.mockResolvedValue([fakeSession('old-1', 1000)]);

        await call();

        expect(mockCleanupPreviewSession).not.toHaveBeenCalled();
    });

    it('stops evicting rather than spinning forever if the victim never leaves the list', async () => {
        // Defensive: if pickEvictionVictim (or a future refactor) ever returns
        // something that isn't actually a member of the list being filtered,
        // the loop must bail rather than spin forever re-selecting the same
        // "victim" that never gets removed.
        mockConfig.PREVIEW_MAX_PER_USER = 1;
        mockGetUserPreviewSessions.mockResolvedValue([
            fakeSession('old-1', 30_000),
            fakeSession('old-2', 20_000),
        ]);
        mockPickEvictionVictim.mockReturnValue(fakeSession('not-in-the-list', 99_999));

        const res = await Promise.race([
            call(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('did not terminate — infinite loop')), 2000),
            ),
        ]);

        expect(res.status).toBeLessThan(500);
        // It tried once, saw the list didn't shrink, and gave up rather than
        // looping — not zero attempts, not unbounded attempts.
        expect(mockCleanupPreviewSession).toHaveBeenCalledTimes(1);
    });
});

it('returns trailer absence before admission, eviction or allocation', async () => {
    const res = await call({ trailerRequired: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: 'none' });
    expect(mockCheckPreviewAdmission).not.toHaveBeenCalled();
    expect(mockCleanupPreviewSession).not.toHaveBeenCalled();
    expect(mockCreatePreview).not.toHaveBeenCalled();
});

it('passes trailer intent to both reuse and the single creator', async () => {
    mockTrailer.mockResolvedValue('trailer-id');
    await call({ trailerPreferred: true, trailerRequired: true });
    expect(mockFindReusablePreview).toHaveBeenCalledWith(
        expect.objectContaining({ trailerPreferred: true }),
    );
    expect(mockCreatePreview).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ trailerPreferred: true, trailerRequired: true }),
    );
});

it('gates an extra through its parent and rejects orphan extras', async () => {
    mockMediaType.mockResolvedValue({ media_type: 'extra', parent_id: 'parent' });
    await call();
    expect(mockCheckMediaAccess).toHaveBeenCalledWith(
        expect.anything(),
        'parent',
        expect.anything(),
    );
    mockCreatePreview.mockClear();
    mockMediaType.mockResolvedValue({ media_type: 'extra', parent_id: null });
    expect((await call()).status).toBe(404);
    expect(mockCreatePreview).not.toHaveBeenCalled();
});

it.each([{ trailerRequired: true }, { trailerPreferred: true }])(
    'reuses a full trailer at zero when position is omitted: %j',
    async (intent) => {
        mockTrailer.mockResolvedValue('trailer-id');
        await call(intent);
        expect(mockFindReusablePreview).toHaveBeenCalledWith(
            expect.objectContaining({ startPositionSeconds: 0, trailerPreferred: true }),
        );
        expect(mockResolveStart).not.toHaveBeenCalled();
    },
);

it('looks for a reusable snippet when a preferred trailer is absent', async () => {
    await call({ trailerPreferred: true });
    expect(mockFindReusablePreview).toHaveBeenCalledWith(
        expect.objectContaining({ startPositionSeconds: 90, trailerPreferred: false }),
    );
});

it('derives one trailer value for both the reuse lookup and the creator', async () => {
    // Preferred but no local trailer: reuse looks for a snippet, so creation must too.
    await call({ trailerPreferred: true });
    const reuse = mockFindReusablePreview.mock.calls[0][0].trailerPreferred;
    const create = mockCreatePreview.mock.calls[0][0].trailerPreferred;
    expect(create).toBe(reuse);
    expect(create).toBe(false);
});

it('advertises the shared keepalive cadence', async () => {
    const { PREVIEW_KEEPALIVE_INTERVAL_MS } = await import('$lib/shared/preview-heartbeat.js');
    const body = await (await call()).json();
    expect(body.reporting.intervalMs).toBe(PREVIEW_KEEPALIVE_INTERVAL_MS);
});
