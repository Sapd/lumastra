// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /playback/previews — the media-access gate.
 *
 * The gate used `isMediaAccessible` only (library-group axis), so an
 * age-restricted user could start a preview of an item above their rating, and
 * it was skipped outright when the DB handle or the library-access user was
 * missing. These tests pin the same contract as POST /playback/previews:
 * 401 first, 503 on a null DB, then `checkMediaAccess` (library + age), with
 * extras gated on their parent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockFindReusablePreview = vi.fn();
const mockCreatePreview = vi.fn();
const mockGetUserPreviewSessions = vi.fn();
const mockCheckPreviewAdmission = vi.fn();
const mockRelease = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockResolveStart = vi.fn();
const mockGetMediaTypeAndParent = vi.fn();
const mockFindLocalTrailerForItem = vi.fn();
const mockIsMediaAccessible = vi.fn();

// Mutated per-test to simulate the DB being down.
const dbState: { sql: unknown } = { sql: {} };

vi.mock('$lib/server/services/preview-session.service.js', () => ({
    getPreviewSession: vi.fn(),
    getUserPreviewSessions: (...a: unknown[]) => mockGetUserPreviewSessions(...a),
    getUserLiveTvSessionId: vi.fn(),
    cleanupPreviewSession: vi.fn(),
    updateSessionHeartbeat: vi.fn(),
    getLiveTvSessionCount: vi.fn(),
    getLiveTvWatcherCount: vi.fn(),
    createPreview: (...a: unknown[]) => mockCreatePreview(...a),
    deletePreview: vi.fn(),
    findReusablePreview: (...a: unknown[]) => mockFindReusablePreview(...a),
}));

vi.mock('$lib/server/config.js', () => ({ config: { PREVIEW_MAX_PER_USER: 6 } }));

vi.mock('$lib/server/services/preview-eviction.js', () => ({
    pickEvictionVictim: vi.fn(),
}));

vi.mock('$lib/server/services/preview-admission.service.js', () => ({
    checkPreviewAdmission: (...a: unknown[]) => mockCheckPreviewAdmission(...a),
}));

vi.mock('$lib/server/config/config.service.js', () => ({
    get: (key: string) => (key === 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW' ? true : 0),
}));

vi.mock('$lib/server/database/index.js', () => ({
    getDb: () => dbState.sql,
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => mockCheckMediaAccess(...a),
}));

// Library-group axis only: reports "accessible" so a regression to the old
// gate lets an age-restricted user through.
vi.mock('$lib/server/cache/library-group-permissions-cache.js', () => ({
    isMediaAccessible: (...a: unknown[]) => mockIsMediaAccessible(...a),
    toLibraryAccessUser: (u: unknown) => u,
}));

vi.mock('$lib/server/database/queries/media-extras.queries.js', () => ({
    getMediaTypeAndParent: (...a: unknown[]) => mockGetMediaTypeAndParent(...a),
    findLocalTrailerForItem: (...a: unknown[]) => mockFindLocalTrailerForItem(...a),
}));

vi.mock('$lib/server/utils/preview-start-position.js', () => ({
    resolvePreviewStartPosition: (...a: unknown[]) => mockResolveStart(...a),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const { def } = await import('./index.js');

const MEDIA_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const PARENT_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const CTX = { surface: 'internal' as const };

const ALICE = { userId: 'u1', username: 'alice', isAdmin: false, isAgeRestricted: true };

function outcome(over: Record<string, unknown> = {}) {
    return {
        playSessionId: 'preview-1',
        sessionItemId: MEDIA_ID,
        streamUrl: '/api/playback/x/hls/master.m3u8',
        playMethod: 'full_transcode',
        transcodeMode: 'hls',
        hlsStartPosition: 90,
        ...over,
    };
}

function makeEvent(user: unknown = ALICE): RequestEvent {
    const url = new URL('http://localhost/api/playback/previews');
    return {
        url,
        params: { itemId: MEDIA_ID },
        request: new Request(url.toString(), { method: 'POST' }),
        locals: { user, authMethod: 'session' },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

async function call(user: unknown = ALICE): Promise<Response> {
    return await def.handlers.POST!(makeEvent(user), {
        ...CTX,
        input: { body: { mediaId: MEDIA_ID, isLiveTv: false } },
    } as never);
}

beforeEach(() => {
    vi.clearAllMocks();
    dbState.sql = {};
    mockCheckMediaAccess.mockResolvedValue(true);
    mockIsMediaAccessible.mockResolvedValue(true);
    mockGetMediaTypeAndParent.mockResolvedValue({ media_type: 'movie', parent_id: null });
    mockFindLocalTrailerForItem.mockResolvedValue(null);
    mockResolveStart.mockResolvedValue(90);
    mockFindReusablePreview.mockResolvedValue(null);
    mockGetUserPreviewSessions.mockResolvedValue([]);
    mockCheckPreviewAdmission.mockResolvedValue({ admit: true, release: mockRelease });
    mockCreatePreview.mockResolvedValue(outcome());
});

describe('POST /playback/previews — media access gate', () => {
    it('(a) hides an item above an age-limited user rating as not_found and never creates a preview', async () => {
        // The library-group axis says yes; only the age axis says no.
        mockIsMediaAccessible.mockResolvedValue(true);
        mockCheckMediaAccess.mockResolvedValue(false);

        const res = await call();

        expect(res.status).toBe(404);
        expect(mockCreatePreview).not.toHaveBeenCalled();
        expect(mockFindReusablePreview).not.toHaveBeenCalled();
    });

    it('(b) answers 503 dependency_unavailable on a null DB before any preview work', async () => {
        dbState.sql = null;

        const res = await call();

        expect(res.status).toBe(503);
        expect(mockCheckMediaAccess).not.toHaveBeenCalled();
        expect(mockFindReusablePreview).not.toHaveBeenCalled();
        expect(mockCreatePreview).not.toHaveBeenCalled();
    });

    it('(c) answers 401 for a missing user without consulting checkMediaAccess', async () => {
        // checkMediaAccess returns true for an undefined user, so the user check
        // has to come first.
        const res = await call(null);

        expect(res.status).toBe(401);
        expect(mockCheckMediaAccess).not.toHaveBeenCalled();
        expect(mockCreatePreview).not.toHaveBeenCalled();
    });

    it('(d) lets an allowed user through the gate to createPreview', async () => {
        const res = await call();

        expect(mockCheckMediaAccess).toHaveBeenCalledWith({}, MEDIA_ID, ALICE);
        expect(mockCreatePreview).toHaveBeenCalledTimes(1);
        expect(res.status).toBe(201);
        expect(await res.json()).toMatchObject({ id: 'preview-1' });
    });

    it('(e) gates an extra on its parent item', async () => {
        mockGetMediaTypeAndParent.mockResolvedValue({ media_type: 'extra', parent_id: PARENT_ID });
        mockCheckMediaAccess.mockResolvedValue(false);

        const res = await call();

        expect(mockCheckMediaAccess).toHaveBeenCalledWith({}, PARENT_ID, ALICE);
        expect(res.status).toBe(404);
        expect(mockCreatePreview).not.toHaveBeenCalled();
    });

    it('(e2) fails closed on an orphaned extra', async () => {
        mockGetMediaTypeAndParent.mockResolvedValue({ media_type: 'extra', parent_id: null });

        const res = await call();

        expect(res.status).toBe(404);
        expect(mockCheckMediaAccess).not.toHaveBeenCalled();
        expect(mockCreatePreview).not.toHaveBeenCalled();
    });
});
