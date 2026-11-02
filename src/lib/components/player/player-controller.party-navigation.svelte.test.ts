// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerController } from './player-controller.svelte';
import { goto } from '$app/navigation';
import { playerStore } from './playerStore.svelte';
import { watchTogether } from '$lib/stores/watchTogether.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/stores/watchTogether.svelte', () => ({
    watchTogether: {
        isInWatchParty: true,
        session: null,
        getSessionState: vi.fn(),
        isWatchPartySyncing: false,
        setNavigatingWithinSession: vi.fn(),
        broadcastNavigate: vi.fn(),
        captureNavigationOwnership: vi.fn(() => () => true),
    },
}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(watchTogether.captureNavigationOwnership).mockReturnValue(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe('party navigation acceptance at the browser player', () => {
    it.each([false, true])('only stops and routes after acceptance=%s', async (accepted) => {
        vi.mocked(watchTogether.broadcastNavigate).mockResolvedValue(accepted);
        const stop = vi.fn().mockResolvedValue(undefined);
        const fullscreen = vi.fn();
        const target = Object.create(PlayerController.prototype) as PlayerController;
        Object.defineProperties(target, {
            navigationRequestRevision: { value: 0, writable: true },
            showEpisodeBrowser: { value: true, writable: true },
            stopAndCleanup: { value: stop },
            transferFullscreenToWrapper: { value: fullscreen },
        });
        await target.handleSelectEpisode({
            episodeId: 'next',
            seasonNumber: 1,
            episodeNumber: 2,
            title: 'Next',
        });
        expect(watchTogether.broadcastNavigate).toHaveBeenCalledWith(
            'next',
            'S01E02 - Next',
            'episode',
        );
        expect(stop).toHaveBeenCalledTimes(accepted ? 1 : 0);
        expect(fullscreen).toHaveBeenCalledTimes(accepted ? 1 : 0);
        expect(goto).toHaveBeenCalledTimes(accepted ? 1 : 0);
    });
});

describe('party navigation continuation ownership', () => {
    it.each(['newer-item', 'next'])(
        'does not reset or route an obsolete cleanup after %s wins',
        async (nextId) => {
            let owner = 0;
            vi.mocked(watchTogether.broadcastNavigate).mockImplementation(async () => {
                owner++;
                return true;
            });
            vi.mocked(watchTogether.captureNavigationOwnership).mockImplementation(() => {
                const accepted = owner;
                return () => accepted === owner;
            });
            let finish!: () => void;
            const held = new Promise<void>((resolve) => {
                finish = resolve;
            });
            const end = vi
                .fn()
                .mockImplementationOnce(() => held)
                .mockResolvedValue(undefined);
            const reset = vi.spyOn(playerStore, 'reset').mockImplementation(() => {});
            vi.spyOn(PlayerController.prototype, 'initEffects').mockImplementation(() => {});
            const target = new PlayerController({
                playbackInfo: { itemId: 'current' } as never,
                username: 'Viewer',
                userId: 'viewer',
            });
            const properties = {
                navigationRequestRevision: 0,
                playbackGeneration: 0,
                showEpisodeBrowser: true,
                transferFullscreenToWrapper: vi.fn(),
                disposeAllSubtitleRenderers: vi.fn(),
                watchTogetherCtrl: { clearStallTimer: vi.fn() },
                isInitialized: true,
                videoElement: null,
                liveTvHeartbeat: null,
                progressReporter: null,
                endCurrentSession: end,
                reconnectDiagnosticEpoch: 0,
                restartQueue: { reset: vi.fn() },
            };
            for (const [key, value] of Object.entries(properties))
                Object.defineProperty(target, key, { value, writable: true, configurable: true });
            const select = (episodeId: string) =>
                target.handleSelectEpisode({
                    episodeId,
                    seasonNumber: 1,
                    episodeNumber: 2,
                    title: episodeId,
                });
            const obsolete = select('next');
            for (let i = 0; i < 20 && !end.mock.calls.length; i++) await Promise.resolve();
            expect(end).toHaveBeenCalledOnce();
            await select(nextId);
            expect(goto).toHaveBeenCalledOnce();
            expect(reset).toHaveBeenCalledOnce();
            finish();
            await obsolete;
            expect(goto).toHaveBeenCalledOnce();
            expect(reset).toHaveBeenCalledOnce();
            expect(goto).toHaveBeenCalledWith(`/watch/${nextId}`, { replaceState: true });
        },
    );
});

it('leaves canonical recovery in charge after a rejected superseding request', async () => {
    let revision = 0;
    vi.mocked(watchTogether.broadcastNavigate)
        .mockReset()
        .mockImplementation(async () => ++revision === 1);
    vi.mocked(watchTogether.captureNavigationOwnership).mockImplementation(() => {
        const mine = revision;
        return () => mine === revision;
    });
    vi.spyOn(PlayerController.prototype, 'initEffects').mockImplementation(() => {});
    const target = new PlayerController({
        playbackInfo: { itemId: 'old' } as never,
        username: 'Viewer',
        userId: 'viewer',
    });
    let finish!: () => void;
    const end = vi.fn().mockImplementationOnce(
        () =>
            new Promise<void>((resolve) => {
                finish = resolve;
            }),
    );
    Object.defineProperties(target, {
        isInitialized: { value: true, writable: true },
        endCurrentSession: { value: end },
        transferFullscreenToWrapper: { value: vi.fn() },
        disposeAllSubtitleRenderers: { value: vi.fn() },
    });
    const select = (episodeId: string) =>
        target.handleSelectEpisode({
            episodeId,
            seasonNumber: 1,
            episodeNumber: 2,
            title: episodeId,
        });
    const accepted = select('accepted');
    for (let i = 0; i < 20 && !end.mock.calls.length; i++) await Promise.resolve();
    expect(end).toHaveBeenCalledOnce();
    await select('rejected');
    finish();
    await accepted;
    expect(goto).not.toHaveBeenCalled();
});

describe('direct-file startup after a party rejoins', () => {
    function directPlayer(): { target: PlayerController; video: HTMLVideoElement } {
        const target = Object.create(PlayerController.prototype) as PlayerController;
        const video = document.createElement('video');
        vi.spyOn(video, 'pause').mockImplementation(() => {});
        for (const [key, value] of Object.entries({
            videoElement: video,
            playbackGeneration: 1,
            props: { playbackInfo: { itemId: 'current-title' } },
            ensurePlaybackManager: () => ({ load: vi.fn().mockResolvedValue(undefined) }),
            streamBitrateMeter: { reset: vi.fn() },
        }))
            Object.defineProperty(target, key, { value, writable: true, configurable: true });
        Object.assign(watchTogether, { session: null, isWatchPartySyncing: false });
        return { target, video };
    }

    it.each([
        { currentTime: 0, isPlaying: false, syncing: false },
        { currentTime: 120, isPlaying: true, syncing: false },
        { currentTime: 45, isPlaying: true, syncing: true },
    ])('late metadata uses the rejoined party clock: %j', ({ syncing, ...state }) => {
        const { target, video } = directPlayer();
        target.initializeDirectPlay('/file', 181);
        // Rejoin and canonical alignment complete before the source metadata.
        Object.assign(watchTogether, {
            session: { itemId: 'current-title' },
            isWatchPartySyncing: syncing,
        });
        vi.mocked(watchTogether.getSessionState).mockReturnValue(state);
        video.currentTime = state.currentTime;
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(state.currentTime);
        expect(video.pause).toHaveBeenCalledTimes(!state.isPlaying || syncing ? 1 : 0);
    });

    it('preserves personal resume when no party has joined', () => {
        const { target, video } = directPlayer();
        target.initializeDirectPlay('/file', 181);
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(181);
    });

    it('ignores metadata from an obsolete playback generation', () => {
        const { target, video } = directPlayer();
        target.initializeDirectPlay('/old-file', 181);
        Object.defineProperty(target, 'playbackGeneration', { value: 2 });
        video.currentTime = 25;
        video.dispatchEvent(new Event('loadedmetadata'));
        expect(video.currentTime).toBe(25);
    });
});
