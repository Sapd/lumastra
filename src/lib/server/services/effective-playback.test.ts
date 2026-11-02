// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for effective-playback.ts resolvers.
 *
 * All external dependencies are injected via the `deps` parameter, so
 * no module mocking is needed — tests operate in pure-function style.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    resolveEffectiveResume,
    resolveEffectivePlayback,
    type EffectivePlaybackDeps,
} from './effective-playback.js';
import type { ActiveSessionView } from './session-read-model.service.js';
import { toUserId } from '$lib/shared/user-id.js';

// Fixed valid users.id UUID for branded-UserId params (mig 16.46.0).
const TEST_USER_ID = toUserId('11111111-1111-4111-8111-111111111111');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<ActiveSessionView> = {}): ActiveSessionView {
    return {
        sessionId: 'sess-1',
        source: 'lumastra',
        sourceSessionId: null,
        userId: TEST_USER_ID,
        username: 'alice',
        displayName: null,
        mediaId: 'media-uuid-1',
        hasFiles: true,
        seriesId: null,
        mediaType: 'movie',
        positionMs: 60_000,
        runtimeMs: 7_200_000,
        status: 'ACTIVE',
        isPlaying: true,
        isBuffering: false,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        lastSeenAt: new Date(),
        heartbeatAgeMs: 5_000,
        isFresh: true,
        ...overrides,
    };
}

function makeDeps(overrides: Partial<EffectivePlaybackDeps> = {}): EffectivePlaybackDeps {
    return {
        getSessionForMedia: vi.fn().mockResolvedValue(null),
        getSessionsForSeries: vi.fn().mockResolvedValue([]),
        getDurableResumeMs: vi.fn().mockResolvedValue(null),
        getDurableLastEventAt: vi.fn().mockResolvedValue(null),
        getDurableIsWatched: vi.fn().mockResolvedValue(false),
        ...overrides,
    };
}

// ─── resolveEffectiveResume ───────────────────────────────────────────────────

describe('resolveEffectiveResume', () => {
    it('uses fresh ACTIVE session position', async () => {
        const session = makeSession({
            positionMs: 120_000,
            isPlaying: true,
            isFresh: true,
        });
        const deps = makeDeps({
            getSessionForMedia: vi.fn().mockResolvedValue(session),
        });

        const result = await resolveEffectiveResume(TEST_USER_ID, 'media-1', deps);

        expect(result).toEqual({
            positionMs: 120_000,
            source: 'live-session',
            fromLive: true,
            anchorMs: expect.any(Number),
            isWatched: false,
        });
    });

    it('uses fresh PAUSED session position (user intent)', async () => {
        const session = makeSession({
            positionMs: 90_000,
            isPlaying: false,
            status: 'PAUSED',
            isFresh: true,
        });
        const deps = makeDeps({
            getSessionForMedia: vi.fn().mockResolvedValue(session),
        });

        const result = await resolveEffectiveResume(TEST_USER_ID, 'media-1', deps);

        expect(result).toEqual({
            positionMs: 90_000,
            source: 'live-session',
            fromLive: true,
            anchorMs: expect.any(Number),
            isWatched: false,
        });
    });

    it('falls through to durable when session is stale', async () => {
        const staleSession = makeSession({
            isFresh: false,
            heartbeatAgeMs: 600_000,
        });
        const deps = makeDeps({
            getSessionForMedia: vi.fn().mockResolvedValue(staleSession),
            getDurableResumeMs: vi.fn().mockResolvedValue(45_000),
        });

        const result = await resolveEffectiveResume(TEST_USER_ID, 'media-1', deps);

        expect(result).toEqual({
            positionMs: 45_000,
            source: 'durable',
            fromLive: false,
            anchorMs: null,
            isWatched: false,
        });
    });

    it('returns none when no session and no durable row', async () => {
        const deps = makeDeps({
            getSessionForMedia: vi.fn().mockResolvedValue(null),
            getDurableResumeMs: vi.fn().mockResolvedValue(null),
        });

        const result = await resolveEffectiveResume(TEST_USER_ID, 'media-1', deps);

        expect(result).toEqual({
            positionMs: 0,
            source: 'none',
            fromLive: false,
            anchorMs: null,
            isWatched: false,
        });
    });

    it('returns durable with positionMs=0 when durable row exists with resume=0', async () => {
        const deps = makeDeps({
            getSessionForMedia: vi.fn().mockResolvedValue(null),
            getDurableResumeMs: vi.fn().mockResolvedValue(0),
        });

        const result = await resolveEffectiveResume(TEST_USER_ID, 'media-1', deps);

        expect(result).toEqual({
            positionMs: 0,
            source: 'durable',
            fromLive: false,
            anchorMs: null,
            isWatched: false,
        });
    });

    it('falls back to durable when SessionReadModel throws', async () => {
        const deps = makeDeps({
            getSessionForMedia: vi.fn().mockRejectedValue(new Error('DB down')),
            getDurableResumeMs: vi.fn().mockResolvedValue(30_000),
        });

        const result = await resolveEffectiveResume(TEST_USER_ID, 'media-1', deps);

        expect(result).toEqual({
            positionMs: 30_000,
            source: 'durable',
            fromLive: false,
            anchorMs: null,
            isWatched: false,
        });
    });

    it('returns none when both sources throw', async () => {
        const deps = makeDeps({
            getSessionForMedia: vi.fn().mockRejectedValue(new Error('DB down')),
            getDurableResumeMs: vi.fn().mockRejectedValue(new Error('also down')),
        });

        const result = await resolveEffectiveResume(TEST_USER_ID, 'media-1', deps);

        expect(result).toEqual({
            positionMs: 0,
            source: 'none',
            fromLive: false,
            anchorMs: null,
            isWatched: false,
        });
    });

    // ─── anchorMs ────────────────────────────────────────────────────────────

    describe('anchorMs', () => {
        it('uses the eligible live session heartbeat as part of the anchor when a fresh session exists', async () => {
            const heartbeatAt = new Date('2026-05-04T10:00:00Z');
            const result = await resolveEffectiveResume(
                TEST_USER_ID,
                'media-1',
                makeDeps({
                    getSessionForMedia: async () =>
                        makeSession({
                            positionMs: 30_000,
                            isFresh: true,
                            lastHeartbeatAt: heartbeatAt,
                        }),
                    getDurableLastEventAt: async () => heartbeatAt.getTime() - 60_000,
                }),
            );
            expect(result.anchorMs).toBe(heartbeatAt.getTime());
        });

        it('falls back to durable last_event_at when no eligible live session exists', async () => {
            const eventAt = new Date('2026-05-04T09:00:00Z').getTime();
            const result = await resolveEffectiveResume(
                TEST_USER_ID,
                'media-1',
                makeDeps({
                    getDurableResumeMs: async () => 12_000,
                    getDurableLastEventAt: async () => eventAt,
                }),
            );
            expect(result.anchorMs).toBe(eventAt);
            expect(result.source).toBe('durable');
        });

        it('returns null anchor when neither source has data', async () => {
            const result = await resolveEffectiveResume(TEST_USER_ID, 'media-1', makeDeps());
            expect(result.anchorMs).toBeNull();
            expect(result.source).toBe('none');
        });

        it('takes the max when both durable and live have timestamps', async () => {
            const liveTs = new Date('2026-05-04T10:00:00Z').getTime();
            const durableTs = new Date('2026-05-04T11:00:00Z').getTime();
            const result = await resolveEffectiveResume(
                TEST_USER_ID,
                'media-1',
                makeDeps({
                    getSessionForMedia: async () =>
                        makeSession({
                            positionMs: 30_000,
                            isFresh: true,
                            lastHeartbeatAt: new Date(liveTs),
                        }),
                    getDurableLastEventAt: async () => durableTs,
                }),
            );
            expect(result.anchorMs).toBe(durableTs);
        });
    });

    // ─── isWatched ───────────────────────────────────────────────────────────

    describe('isWatched', () => {
        it('returns isWatched from the durable row', async () => {
            const result = await resolveEffectiveResume(
                TEST_USER_ID,
                'media-1',
                makeDeps({
                    getDurableIsWatched: async () => true,
                    getDurableResumeMs: async () => 12_000,
                }),
            );
            expect(result.isWatched).toBe(true);
        });

        it('returns isWatched=false when no durable row exists', async () => {
            const result = await resolveEffectiveResume(TEST_USER_ID, 'media-1', makeDeps());
            expect(result.isWatched).toBe(false);
        });
    });
});

// ─── resolveEffectivePlayback ─────────────────────────────────────────────────

describe('resolveEffectivePlayback', () => {
    it('returns all-null with isPlaying=false when no session and no seriesId', async () => {
        const deps = makeDeps({
            getSessionForMedia: vi.fn().mockResolvedValue(null),
        });

        const result = await resolveEffectivePlayback(TEST_USER_ID, 'media-1', undefined, deps);

        expect(result.livePositionMs).toBeNull();
        expect(result.isPlaying).toBe(false);
        expect(result.source).toBeNull();
        expect(result.freshness).toBeNull();
        expect(result.session).toBeNull();
    });

    it('returns all-null when session exists but is stale', async () => {
        const stale = makeSession({ isFresh: false });
        const deps = makeDeps({
            getSessionForMedia: vi.fn().mockResolvedValue(stale),
        });

        const result = await resolveEffectivePlayback(TEST_USER_ID, 'media-1', undefined, deps);

        expect(result.livePositionMs).toBeNull();
        expect(result.isPlaying).toBe(false);
    });

    it('returns live data when fresh session exists', async () => {
        const session = makeSession({
            positionMs: 200_000,
            isPlaying: true,
            isFresh: true,
        });
        const deps = makeDeps({
            getSessionForMedia: vi.fn().mockResolvedValue(session),
        });

        const result = await resolveEffectivePlayback(TEST_USER_ID, 'media-1', undefined, deps);

        expect(result.livePositionMs).toBe(200_000);
        expect(result.isPlaying).toBe(true);
        expect(result.source).toBe('lumastra');
        expect(result.freshness?.isFresh).toBe(true);
        expect(result.session).toBe(session);
    });

    it('with seriesId: picks freshest ACTIVE session when multiple fresh sessions exist', async () => {
        const older = makeSession({
            sessionId: 'sess-old',
            positionMs: 10_000,
            isPlaying: true,
            isFresh: true,
            heartbeatAgeMs: 20_000,
        });
        const newer = makeSession({
            sessionId: 'sess-new',
            positionMs: 50_000,
            isPlaying: true,
            isFresh: true,
            heartbeatAgeMs: 3_000,
        });
        const deps = makeDeps({
            getSessionsForSeries: vi.fn().mockResolvedValue([older, newer]),
        });

        const result = await resolveEffectivePlayback(TEST_USER_ID, 'any-ep', 'series-1', deps);

        expect(result.session?.sessionId).toBe('sess-new');
        expect(result.livePositionMs).toBe(50_000);
    });

    it('with seriesId: falls back to freshest PAUSED when no ACTIVE sessions', async () => {
        const pausedOld = makeSession({
            sessionId: 'paused-old',
            positionMs: 5_000,
            isPlaying: false,
            status: 'PAUSED',
            isFresh: true,
            heartbeatAgeMs: 60_000,
        });
        const pausedNew = makeSession({
            sessionId: 'paused-new',
            positionMs: 15_000,
            isPlaying: false,
            status: 'PAUSED',
            isFresh: true,
            heartbeatAgeMs: 10_000,
        });
        const deps = makeDeps({
            getSessionsForSeries: vi.fn().mockResolvedValue([pausedOld, pausedNew]),
        });

        const result = await resolveEffectivePlayback(TEST_USER_ID, 'any-ep', 'series-1', deps);

        expect(result.session?.sessionId).toBe('paused-new');
        expect(result.isPlaying).toBe(false);
    });

    it('with seriesId: returns empty when all sessions are stale', async () => {
        const stale = makeSession({ isFresh: false, heartbeatAgeMs: 999_000 });
        const deps = makeDeps({
            getSessionsForSeries: vi.fn().mockResolvedValue([stale]),
        });

        const result = await resolveEffectivePlayback(TEST_USER_ID, 'any-ep', 'series-1', deps);

        expect(result.livePositionMs).toBeNull();
        expect(result.isPlaying).toBe(false);
    });

    it('returns empty cleanly when SessionReadModel throws', async () => {
        const deps = makeDeps({
            getSessionForMedia: vi.fn().mockRejectedValue(new Error('DB down')),
        });

        const result = await resolveEffectivePlayback(TEST_USER_ID, 'media-1', undefined, deps);

        expect(result.livePositionMs).toBeNull();
        expect(result.isPlaying).toBe(false);
        expect(result.session).toBeNull();
    });
});
