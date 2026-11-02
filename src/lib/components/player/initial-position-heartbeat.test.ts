// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the one-shot initial-position heartbeat added to onTimeUpdate.
 *
 * The PlayerController cannot be instantiated in tests (Svelte 5 runes +
 * heavy DOM dependencies), so these tests exercise the reporter and flag
 * logic through a minimal inline stub that mirrors the exact code path
 * added to onTimeUpdate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockStartPlaySession = vi.fn();
vi.mock('$lib/api/playback.js', () => ({
    startPlaySession: (...args: unknown[]) => mockStartPlaySession(...args),
}));

vi.mock('$lib/services/sse/admin-event-handler.js', () => ({
    handleAdminEvent: vi.fn(),
}));

import { PlaySessionReporter } from './play-session-reporter.js';

// ---------------------------------------------------------------------------
// Minimal stub that replicates the flag logic from onTimeUpdate and the
// resetEngagementTracking reset path, without importing PlayerController.
// ---------------------------------------------------------------------------

interface FakeVideoElement {
    paused: boolean;
    currentTime: number;
}

interface FakePlayerStore {
    currentTime: number;
    setCurrentTime(t: number): void;
}

class InitialPositionHeartbeatStub {
    hasFiredInitialPositionHeartbeat = false;
    private store: FakePlayerStore;
    private reporter: PlaySessionReporter;

    constructor(store: FakePlayerStore, reporter: PlaySessionReporter) {
        this.store = store;
        this.reporter = reporter;
    }

    /** Mirrors the block added to onTimeUpdate. */
    onTimeUpdate(video: FakeVideoElement): void {
        if (!this.hasFiredInitialPositionHeartbeat && !video.paused && video.currentTime > 0) {
            this.hasFiredInitialPositionHeartbeat = true;
            this.store.setCurrentTime(video.currentTime);
            void this.reporter.report('progress', makeData(video.currentTime));
        }
    }

    /** Mirrors resetEngagementTracking. */
    resetEngagementTracking(): void {
        this.hasFiredInitialPositionHeartbeat = false;
    }
}

function makeStore(): FakePlayerStore {
    return {
        currentTime: 0,
        setCurrentTime(t: number) {
            this.currentTime = t;
        },
    };
}

function makeData(currentTime = 60) {
    return {
        itemId: 'item-1',
        mediaSourceId: 'src-1',
        currentTime,
        isPaused: false,
        isMuted: false,
        volume: 1,
        playMethod: 'direct',
        playSessionId: 'play-sess-1',
        audioStreamIndex: null,
        subtitleStreamIndex: null,
    } as const;
}

function makeReporter(): PlaySessionReporter {
    const r = new PlaySessionReporter({ mediaId: 'm', deviceId: 'd' });
    (r as unknown as { sessionId: string }).sessionId = 'sess-1';
    return r;
}

describe('initial-position heartbeat (onTimeUpdate flag)', () => {
    beforeEach(() => {
        mockFetch.mockReset();
        mockStartPlaySession.mockReset();
        mockFetch.mockResolvedValue({ ok: true, status: 204 } as Response);
    });

    it('fires a progress heartbeat with positionMs=600000 on first playing timeupdate', async () => {
        const stub = new InitialPositionHeartbeatStub(makeStore(), makeReporter());

        const video: FakeVideoElement = { paused: false, currentTime: 600 };
        stub.onTimeUpdate(video);

        // Let the async report resolve
        await new Promise((r) => setTimeout(r, 10));

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body) as {
            positionMs: number;
            status: string;
        };
        expect(body.positionMs).toBe(600_000);
        expect(body.status).toBe('ACTIVE');
    });

    it('does NOT fire additional heartbeats on subsequent timeupdates', async () => {
        const stub = new InitialPositionHeartbeatStub(makeStore(), makeReporter());
        const video: FakeVideoElement = { paused: false, currentTime: 600 };

        stub.onTimeUpdate(video);
        video.currentTime = 601;
        stub.onTimeUpdate(video);
        video.currentTime = 602;
        stub.onTimeUpdate(video);

        await new Promise((r) => setTimeout(r, 10));

        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not fire when the player is paused', async () => {
        const stub = new InitialPositionHeartbeatStub(makeStore(), makeReporter());

        const video: FakeVideoElement = { paused: true, currentTime: 600 };
        stub.onTimeUpdate(video);

        await new Promise((r) => setTimeout(r, 10));

        expect(mockFetch).not.toHaveBeenCalled();
        expect(stub.hasFiredInitialPositionHeartbeat).toBe(false);
    });

    it('does not fire when currentTime is zero', async () => {
        const stub = new InitialPositionHeartbeatStub(makeStore(), makeReporter());

        const video: FakeVideoElement = { paused: false, currentTime: 0 };
        stub.onTimeUpdate(video);

        await new Promise((r) => setTimeout(r, 10));

        expect(mockFetch).not.toHaveBeenCalled();
        expect(stub.hasFiredInitialPositionHeartbeat).toBe(false);
    });

    it('syncs the store currentTime before firing the heartbeat', async () => {
        const store = makeStore();
        const stub = new InitialPositionHeartbeatStub(store, makeReporter());

        const video: FakeVideoElement = { paused: false, currentTime: 300 };
        stub.onTimeUpdate(video);

        await new Promise((r) => setTimeout(r, 10));

        expect(store.currentTime).toBe(300);
    });

    it('re-arms the flag after resetEngagementTracking (session rollover)', async () => {
        const stub = new InitialPositionHeartbeatStub(makeStore(), makeReporter());
        const video: FakeVideoElement = { paused: false, currentTime: 600 };

        // First session — fires once
        stub.onTimeUpdate(video);
        await new Promise((r) => setTimeout(r, 10));
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Session rollover
        stub.resetEngagementTracking();
        expect(stub.hasFiredInitialPositionHeartbeat).toBe(false);
        // Re-arm the reporter's sessionId so the second progress report goes
        // through update() → fetch, not through the startSession restart path
        // (which requires a live startPlaySession mock and is not under test here).
        (stub['reporter'] as unknown as { sessionId: string }).sessionId = 'sess-2';

        // Second session — fires again
        mockFetch.mockReset();
        mockFetch.mockResolvedValue({ ok: true, status: 204 } as Response);
        video.currentTime = 900;
        stub.onTimeUpdate(video);
        await new Promise((r) => setTimeout(r, 10));

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body) as {
            positionMs: number;
        };
        expect(body.positionMs).toBe(900_000);
    });
});
