// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { SUBTITLE, TIMING } from './timing-constants';
import type { SubtitleRendererManager } from './subtitle-renderer';
import { PlayerController, PlaybackSupersededError } from './player-controller.svelte';
import { WatchTogetherController } from './watch-together.controller';
import { WatchTogetherHandlers } from './watch-together-handlers';
import { buildPublicAuthor } from '$lib/shared/public-author';
import { playerStore } from './playerStore.svelte';
import { watchTogether } from '$lib/stores/watchTogether.svelte';
import { PlaySessionReporter } from './play-session-reporter';
import { probeTrackRecommendation, type PlayerProbe, type PlayerMethod } from './player-probe';
import type { PlayabilityResponse } from '$lib/schemas/api-playability';
import {
    PlaybackStartResponseSchema,
    type PlaybackStartResponse,
} from '$lib/schemas/playback-start';
import { playbackStartFixture } from '$lib/utils/playback-start.fixture';
import { VideoShortcuts, type KeyboardCallbacks } from './VideoShortcuts';
import { RestartQueue } from './restart-queue';
import { maintainPlaybackGrant } from '$lib/utils/playback-grant';
import { getPreferences, updatePreferences, playbackPreferences } from './preferences-sync.svelte';

const http = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), put: vi.fn(), patch: vi.fn() }));
const bitmapConstruction = vi.hoisted(() => vi.fn());
vi.mock('libbitsub', () => {
    class BitmapRenderer {
        constructor(options: { onLoaded?: () => void }) {
            bitmapConstruction(options);
            queueMicrotask(() => options.onLoaded?.());
        }
        dispose(): void {}
        setDisplaySettings(): void {}
    }
    return {
        PgsRenderer: BitmapRenderer,
        VobSubRenderer: BitmapRenderer,
        isWasmInitialized: () => true,
    };
});
vi.mock('$lib/api/client.js', () => ({
    apiPost: http.post,
    apiGet: http.get,
    apiPut: http.put,
    apiPatch: http.patch,
    apiDelete: vi.fn(),
}));
vi.mock('$lib/utils/playback-grant.js', () => ({ maintainPlaybackGrant: vi.fn(() => () => {}) }));
vi.mock('$lib/stores/server-capabilities.store', () => ({
    serverCapabilities: { fetch: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('./subtitle-renderer', () => ({
    createSubtitleRendererManager: vi.fn(() => ({ destroy: vi.fn() })),
}));
vi.mock('./browserCapabilities.svelte', async (original) => ({
    ...(await original<typeof import('./browserCapabilities.svelte')>()),
    ensurePathScopedCapabilities: vi.fn().mockResolvedValue(null),
}));

const MEDIA = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
function probe(fileId = FILE): PlayabilityResponse {
    return {
        mediaId: MEDIA,
        activeFileId: fileId,
        resumePositionMs: 25_000,
        isWatched: false,
        recommended: {
            audioStreamIndex: 4,
            subtitleId: `${fileId}:7`,
            reason: { audio: 'file-default', subtitle: 'forced-for-audio' },
        },
        versions: [FILE, OTHER].map((id) => ({
            fileId: id,
            label: id === FILE ? 'Original' : 'HD',
            isDefault: id === FILE,
            playable: true,
            blockedBy: [],
            playMethod: 'remux',
            availableMethods: [
                'direct',
                'remux',
                'audio_transcode',
                'full_transcode',
                'audio_only',
            ],
            reasons: ['Container'],
            reasonCodes: [],
            outputHdr: 'sdr',
            hlsAudioMode: 'demux',
            durationMs: 120_000,
            tracks: {
                video: { codec: 'h264', width: 1920, height: 1080, hdr: 'sdr', container: 'mkv' },
                audio: [
                    {
                        index: 0,
                        absoluteIndex: 1,
                        codec: 'aac',
                        channels: 2,
                        language: 'deu',
                        title: null,
                        default: false,
                    },
                    {
                        index: 1,
                        absoluteIndex: 4,
                        codec: 'aac',
                        channels: 2,
                        language: 'eng',
                        title: null,
                        default: true,
                    },
                ],
                subtitles: [
                    {
                        id: `${id}:7`,
                        index: 7,
                        absoluteIndex: 7,
                        codec: 'subrip',
                        language: 'eng',
                        title: null,
                        default: false,
                        forced: true,
                        format: 'text',
                        source: 'embedded',
                        method: 'external_vtt',
                    },
                    {
                        id: `${id}:8`,
                        index: 8,
                        absoluteIndex: 8,
                        codec: 'subrip',
                        language: 'eng',
                        title: null,
                        default: false,
                        forced: false,
                        format: 'text',
                        source: 'embedded',
                        method: 'external_vtt',
                    },
                    {
                        id: 'sidecar-stable',
                        index: 1000,
                        absoluteIndex: 1000,
                        codec: 'webvtt',
                        language: 'eng',
                        title: 'Sidecar',
                        default: false,
                        forced: false,
                        format: 'text',
                        source: 'sidecar',
                        method: 'external_vtt',
                    },
                ],
            },
        })),
    };
}
function started(fileId = FILE, playMethod: PlayerMethod = 'remux'): PlaybackStartResponse {
    const version = probe(fileId).versions.find((v) => v.fileId === fileId)!;
    return {
        ...playbackStartFixture(MEDIA),
        kind: 'video',
        delivery: {
            kind: 'hls',
            url: '/issued/stream?grant=opaque',
            fileId,
            playMethod,
            reasons: ['Started reason'],
            reasonCodes: [],
            applied: { audioStreamIndex: 4, subtitleId: `${fileId}:7` },
            tracks: { ...version.tracks, subtitles: [] },
            subtitles: version.tracks.subtitles.map((s) => ({
                id: s.id,
                index: s.source === 'sidecar' ? 1002 : s.index,
                kind: s.source === 'sidecar' ? 'external' : 'embedded',
                codec: s.codec,
                language: s.language,
                title: s.title ?? undefined,
                default: s.default,
                forced: s.forced,
                format: 'text',
                hrefs: { text: `/issued/subtitle/${s.id}?grant=opaque&revision=2` },
            })),
            seek: { clientShouldSeek: true, streamStartPositionMs: 15_000 },
            startPositionMs: 25_000,
            durationMs: 120_000,
            timeline: { href: '/issued/timeline?grant=opaque&file=selected' },
            trickplay: { href: '/issued/previews?grant=opaque', intervalMs: 10_000 },
        },
    };
}
interface Internals {
    setPlaybackProbe(p: PlayerProbe): void;
    syncProbeVersionsToStore(p: PlayerProbe): void;
    buildLumastraPlaybackUrl(
        p: PlayerProbe,
        method: PlayerMethod,
        position?: number,
    ): Promise<string>;
    applyPlaybackStart(start: PlaybackStartResponse): void;
    timelineRequestId: number;
    currentPlaybackInfo: unknown;
    streamToken: string;
    restartStreamWithNewQualityInner(resume: { position: number; play: boolean }): Promise<void>;
    rebuildPlaybackSession(): Promise<void>;
    updateProbedSource(probe: PlayerProbe, itemId: string): void;
    playbackStart: PlaybackStartResponse | null;
}
const reporters: PlaySessionReporter[] = [];
const controllers: PlayerController[] = [];
function controller(): { target: PlayerController; inner: Internals } {
    const target = Object.create(PlayerController.prototype) as PlayerController;
    controllers.push(target);
    const reporter = new PlaySessionReporter({
        mediaId: MEDIA,
        deviceId: 'web',
        onBeforeStart: (data) => {
            (target as unknown as { subtitleStartRevision?: number }).subtitleStartRevision =
                data.subtitleSelectionRevision;
            (target as unknown as { audioStartRevision?: number }).audioStartRevision =
                data.audioSelectionRevision;
        },
        onDelivery: (start) =>
            (
                target as unknown as { handlePlaybackDelivery(start: PlaybackStartResponse): void }
            ).handlePlaybackDelivery(start),
    });
    reporters.push(reporter);
    for (const [key, value] of Object.entries({
        playbackGeneration: 0,
        restartQueue: new RestartQueue(),
        playbackProbe: null,
        playbackStart: null,
        videoElement: undefined,
        subtitleCacheBuster: 0,
        props: { mediaDbId: MEDIA, playbackInfo: { itemId: MEDIA, mediaSources: [] } },
        currentMediaDbId: MEDIA,
        currentPlaybackInfo: { itemId: MEDIA, mediaSources: [] },
        progressReporter: reporter,
        log: vi.fn(),
        warn: vi.fn(),
        sameBrowserChannel: null,
        syncEngagementToActiveSession: vi.fn(),
        playingMsAccumulator: 0,
        pendingAudioTrackIndex: null,
        audioSwitchAttempt: 0,
        audioSwitchInFlight: false,
        failedAudioSwitch: null,
        lastAudioSwitchRevision: playerStore.audioSelectionRevision,
        timelineRequestId: 0,
        timelineItemId: null,
        timelineFileId: undefined,
        isSafari: false,
        isSwitchingVersion: false,
        lumastraFileId: FILE,
        tryStartRestart: () => true,
        finishRestart: vi.fn(),
        armPostSwitchRecovery: vi.fn(),
        initializeHls: vi.fn().mockResolvedValue(undefined),
        initializeDirectPlay: vi.fn(),
        endCurrentSession: vi.fn().mockResolvedValue(undefined),
        setVideoTime: vi.fn(),
        resetBandwidthTracking: vi.fn(),
    }))
        Object.defineProperty(target, key, { value, writable: true, configurable: true });
    playerStore.itemId = MEDIA;
    playerStore.setPlaySessionId('pending');
    return { target, inner: target as unknown as Internals };
}
async function prepare(target: PlayerController, inner: Internals): Promise<PlayerProbe> {
    const result = await target.fetchPlaybackProbe(MEDIA);
    expect(result).not.toBeNull();
    const p = result!;
    inner.setPlaybackProbe(p);
    target.lumastraPlayMethod = target.resolveAvailableLumastraMethod(p);
    inner.syncProbeVersionsToStore(p);
    playerStore.updateCurrentMediaSource(target.buildLumastraSource(p, MEDIA));
    playerStore.applyTrackRecommendation(probeTrackRecommendation(p));
    return p;
}
beforeEach(() => {
    vi.mocked(maintainPlaybackGrant).mockClear();
    http.post
        .mockReset()
        .mockImplementation(async (url: string, _schema: unknown, body: { fileId?: string }) => {
            if (url.endsWith('/playability')) {
                const result = probe(body.fileId);
                if (body.fileId)
                    result.versions = result.versions.filter((v) => v.fileId === body.fileId);
                return { data: result, status: 200, error: null };
            }
            if (url === '/api/play-sessions')
                return { data: started(body.fileId), status: 201, error: null };
            throw new Error(`Unexpected request: ${url}`);
        });
    http.get.mockReset().mockResolvedValue({ data: null, status: 200, error: null });
    http.put.mockReset().mockResolvedValue({ data: null, status: 204, error: null });
    http.patch.mockReset().mockResolvedValue({ data: {}, status: 200, error: null });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
});

describe('subtitle initialization lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    async function setup(): Promise<{
        target: PlayerController;
        renderer: {
            initRenderer: ReturnType<typeof vi.fn>;
            disposeAll: ReturnType<typeof vi.fn>;
            setContext: ReturnType<typeof vi.fn>;
            applyStyle: ReturnType<typeof vi.fn>;
        };
        cleanup: () => void;
    }> {
        const { target, inner } = controller();
        await prepare(target, inner);
        const cleanup = subtitleEffects(target);
        const renderer = {
            initRenderer: vi.fn().mockResolvedValue(true),
            disposeAll: vi.fn(),
            setContext: vi.fn(),
            setVideoElement: vi.fn(),
            hasActiveRenderer: () => true,
            hasActiveSpecialRenderer: () => true,
            applyStyle: vi.fn(),
        };
        Object.defineProperties(target, {
            subtitleRendererGeneration: { value: 0, writable: true },
            cancelSubtitleWork: { value: null, writable: true },
            subtitleRenderer: {
                value: renderer as unknown as SubtitleRendererManager,
                writable: true,
            },
            initSpecialSubtitleRenderer: {
                value: PlayerController.prototype.initSpecialSubtitleRenderer,
            },
            disposeAllSubtitleRenderers: {
                value: PlayerController.prototype.disposeAllSubtitleRenderers,
            },
            isClientRenderedSubtitle: { value: () => true },
            restartPlayback: { value: vi.fn() },
            loadSubtitles: { value: vi.fn() },
        });
        const track = playerStore.currentMediaSource!.subtitleStreams[0];
        track.codec = 'ass';
        track.hrefs = { raw: '/issued/forced.ass?grant=first' };
        flushSync();
        return { target, renderer, cleanup };
    }

    it.each(['off', 'other-track', 'off-on', 'new-file', 'new-video', 'new-playback'])(
        'does not revive a delayed track after %s',
        async (change) => {
            const { target, renderer, cleanup } = await setup();
            try {
                const pending = target.reinitializeSubtitleRendererIfNeeded();
                if (change === 'off' || change === 'off-on') {
                    playerStore.currentSubtitleTrackIndex = null;
                    flushSync();
                }
                if (change === 'other-track') {
                    playerStore.currentSubtitleTrackIndex = 8;
                    flushSync();
                }
                if (change === 'off-on') {
                    // A new user selection owns initialization, not the old delay.
                    Object.defineProperty(target, 'initSpecialSubtitleRenderer', {
                        value: vi.fn(),
                    });
                    playerStore.currentSubtitleTrackIndex = 7;
                    flushSync();
                }
                if (change === 'new-file') playerStore.currentMediaSource!.id = OTHER;
                if (change === 'new-video') target.videoElement = document.createElement('video');
                if (change === 'new-playback') {
                    (target as unknown as { playbackGeneration: number }).playbackGeneration++;
                }
                renderer.initRenderer.mockClear();
                await vi.advanceTimersByTimeAsync(TIMING.STABILIZATION_WAIT_MS);
                await pending;
                expect(renderer.initRenderer).not.toHaveBeenCalled();
            } finally {
                cleanup();
                target.disposeAllSubtitleRenderers();
            }
        },
    );

    it('automatically retries a failed load using renewed delivery without reloading video', async () => {
        const { target, renderer, cleanup } = await setup();
        renderer.initRenderer.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        try {
            const pending = target.initSpecialSubtitleRenderer(7);
            await vi.advanceTimersByTimeAsync(0);
            expect(renderer.initRenderer).toHaveBeenCalledTimes(1);
            playerStore.currentMediaSource!.subtitleStreams[0].hrefs!.raw =
                '/issued/forced.ass?grant=renewed';
            await vi.advanceTimersByTimeAsync(SUBTITLE.INIT_RETRY_DELAY_MS);
            await pending;
            expect(renderer.initRenderer).toHaveBeenCalledTimes(2);
            expect(renderer.setContext).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    subtitleStreams: expect.arrayContaining([
                        expect.objectContaining({
                            hrefs: { raw: '/issued/forced.ass?grant=renewed' },
                        }),
                    ]),
                }),
            );
            expect(renderer.applyStyle).toHaveBeenCalledOnce();
            expect(target.restartStreamWithNewQuality).not.toHaveBeenCalled();
        } finally {
            cleanup();
            target.disposeAllSubtitleRenderers();
        }
    });

    it.each(['off', 'other-track', 'dispose', 'new-file', 'new-video', 'new-playback'])(
        'cancels retries after %s',
        async (change) => {
            const { target, renderer, cleanup } = await setup();
            renderer.initRenderer.mockResolvedValue(false);
            try {
                const pending = target.initSpecialSubtitleRenderer(7);
                await vi.advanceTimersByTimeAsync(0);
                if (change === 'dispose') target.disposeAllSubtitleRenderers();
                else if (change === 'new-file') playerStore.currentMediaSource!.id = OTHER;
                else if (change === 'new-video')
                    target.videoElement = document.createElement('video');
                else if (change === 'new-playback')
                    (target as unknown as { playbackGeneration: number }).playbackGeneration++;
                else {
                    playerStore.currentSubtitleTrackIndex = change === 'off' ? null : 8;
                    flushSync();
                }
                await vi.advanceTimersByTimeAsync(10_000);
                await pending;
                expect(renderer.initRenderer).toHaveBeenCalledTimes(1);
                expect(renderer.applyStyle).not.toHaveBeenCalled();
            } finally {
                cleanup();
                target.disposeAllSubtitleRenderers();
            }
        },
    );

    it('bounds retries for persistent failures and catches rejected initializations', async () => {
        const { target, renderer, cleanup } = await setup();
        renderer.initRenderer.mockRejectedValue(new Error('Temporary subtitle fetch failure'));
        try {
            const pending = target.initSpecialSubtitleRenderer(7);
            await vi.advanceTimersByTimeAsync(10_000);
            await pending;
            expect(renderer.initRenderer).toHaveBeenCalledTimes(SUBTITLE.INIT_MAX_RETRIES + 1);
            expect(renderer.applyStyle).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(renderer.initRenderer).toHaveBeenCalledTimes(SUBTITLE.INIT_MAX_RETRIES + 1);
            expect(target.restartStreamWithNewQuality).not.toHaveBeenCalled();
        } finally {
            cleanup();
            target.disposeAllSubtitleRenderers();
        }
    });

    it('reinitializes an unchanged selection successfully after stabilization', async () => {
        const { target, renderer, cleanup } = await setup();
        try {
            const pending = target.reinitializeSubtitleRendererIfNeeded();
            await vi.advanceTimersByTimeAsync(TIMING.STABILIZATION_WAIT_MS);
            await pending;
            expect(renderer.initRenderer).toHaveBeenCalledExactlyOnceWith(7);
            expect(renderer.applyStyle).toHaveBeenCalledOnce();
        } finally {
            cleanup();
            target.disposeAllSubtitleRenderers();
        }
    });

    it.each(['off', 'other-track', 'new-file', 'new-video', 'new-playback'])(
        'rejects stale initialization completion after %s',
        async (change) => {
            const { target, renderer, cleanup } = await setup();
            let finish: (value: boolean) => void = () => {};
            renderer.initRenderer.mockReturnValueOnce(
                new Promise<boolean>((resolve) => {
                    finish = resolve;
                }),
            );
            try {
                const pending = target.initSpecialSubtitleRenderer(7);
                if (change === 'off' || change === 'other-track') {
                    playerStore.currentSubtitleTrackIndex = change === 'off' ? null : 8;
                    flushSync();
                }
                if (change === 'new-file') playerStore.currentMediaSource!.id = OTHER;
                if (change === 'new-video') target.videoElement = document.createElement('video');
                if (change === 'new-playback')
                    (target as unknown as { playbackGeneration: number }).playbackGeneration++;
                finish(true);
                await pending;
                expect(renderer.applyStyle).not.toHaveBeenCalled();
                expect(renderer.disposeAll).toHaveBeenCalled();
            } finally {
                cleanup();
                target.disposeAllSubtitleRenderers();
            }
        },
    );

    it('does not dispose a newer selection when an older initialization completes', async () => {
        const { target, renderer, cleanup } = await setup();
        let finish: (value: boolean) => void = () => {};
        renderer.initRenderer.mockReturnValueOnce(
            new Promise<boolean>((resolve) => {
                finish = resolve;
            }),
        );
        try {
            const pending = target.initSpecialSubtitleRenderer(7);
            const next = playerStore.currentMediaSource!.subtitleStreams[1];
            next.codec = 'ass';
            next.hrefs = { raw: '/issued/other.ass' };
            playerStore.currentSubtitleTrackIndex = 8;
            flushSync();
            await vi.advanceTimersByTimeAsync(0);
            expect(renderer.applyStyle).toHaveBeenCalledOnce();
            const disposals = renderer.disposeAll.mock.calls.length;
            finish(true);
            await pending;
            expect(renderer.disposeAll).toHaveBeenCalledTimes(disposals);
            expect(renderer.applyStyle).toHaveBeenCalledOnce();
        } finally {
            cleanup();
            target.disposeAllSubtitleRenderers();
        }
    });

    it('times out a hung attempt and recovers on the next attempt', async () => {
        const { target, renderer, cleanup } = await setup();
        let finish: (value: boolean) => void = () => {};
        renderer.initRenderer.mockReturnValueOnce(
            new Promise<boolean>((resolve) => {
                finish = resolve;
            }),
        );
        try {
            const pending = target.initSpecialSubtitleRenderer(7);
            await vi.advanceTimersByTimeAsync(
                SUBTITLE.INIT_TIMEOUT_MS + SUBTITLE.INIT_RETRY_DELAY_MS,
            );
            await pending;
            expect(renderer.initRenderer).toHaveBeenCalledTimes(2);
            expect(renderer.applyStyle).toHaveBeenCalledOnce();
            finish(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(renderer.applyStyle).toHaveBeenCalledOnce();
        } finally {
            cleanup();
            target.disposeAllSubtitleRenderers();
        }
    });

    it.each(['renewal', 'same-track click'])(
        'permits a fresh bounded attempt after exhausted retries on %s',
        async (trigger) => {
            const { target, renderer, cleanup } = await setup();
            renderer.initRenderer.mockResolvedValue(false);
            try {
                const pending = target.initSpecialSubtitleRenderer(7);
                await vi.advanceTimersByTimeAsync(10_000);
                await pending;
                expect(renderer.initRenderer).toHaveBeenCalledTimes(3);
                await vi.advanceTimersByTimeAsync(60_000);
                expect(renderer.initRenderer).toHaveBeenCalledTimes(3);
                renderer.initRenderer.mockResolvedValue(true);
                if (trigger === 'renewal')
                    playerStore.currentMediaSource!.subtitleStreams[0].hrefs!.raw =
                        '/issued/forced.ass?grant=renewed';
                else playerStore.setSubtitleTrack(7);
                flushSync();
                await vi.advanceTimersByTimeAsync(0);
                expect(renderer.initRenderer).toHaveBeenCalledTimes(4);
                expect(renderer.applyStyle).toHaveBeenCalledOnce();
                expect(target.restartStreamWithNewQuality).not.toHaveBeenCalled();
            } finally {
                cleanup();
                target.disposeAllSubtitleRenderers();
            }
        },
    );

    it('recovers a real subtitle-manager fetch failure through the controller retry', async () => {
        const { target, cleanup } = await setup();
        const actual =
            await vi.importActual<typeof import('./subtitle-renderer')>('./subtitle-renderer');
        const manager = new actual.SubtitleRendererManager({}, () => {});
        target.subtitleRenderer = manager;
        playerStore.currentMediaSource!.subtitleStreams[0].codec = 'hdmv_pgs_subtitle';
        bitmapConstruction.mockClear();
        vi.mocked(fetch)
            .mockResolvedValueOnce(new Response(null, { status: 503 }))
            .mockResolvedValueOnce(new Response(new Uint8Array([0x50, 0x47])));
        try {
            const pending = target.initSpecialSubtitleRenderer(7);
            // First module import can finish on a real task, outside fake timers.
            await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
            await vi.advanceTimersByTimeAsync(SUBTITLE.INIT_RETRY_DELAY_MS);
            await pending;
            expect(fetch).toHaveBeenCalledTimes(2);
            expect(bitmapConstruction).toHaveBeenCalledOnce();
            expect(manager.hasActiveSpecialRenderer()).toBe(true);
            expect(target.restartStreamWithNewQuality).not.toHaveBeenCalled();
        } finally {
            cleanup();
            target.disposeAllSubtitleRenderers();
            manager.setVideoElement(null);
        }
    });
});
afterEach(() => {
    for (const r of reporters.splice(0)) r.cleanup();
    for (const target of controllers.splice(0)) {
        (
            target as unknown as { sameBrowserChannel?: { close(): void } | null }
        ).sameBrowserChannel?.close();
    }
    playerStore.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('web player probe → start', () => {
    it('waits through a 429 and recovers the probe without marking playback unavailable', async () => {
        vi.useFakeTimers();
        try {
            const { target } = controller();
            http.post.mockResolvedValueOnce({
                data: null,
                error: 'Busy',
                code: 'rate_limited',
                status: 429,
                retryAfterMs: 3000,
            });
            const pending = target.fetchPlaybackProbe(MEDIA);
            await vi.advanceTimersByTimeAsync(2999);
            expect(http.post).toHaveBeenCalledTimes(1);
            expect(playerStore.error).toBeNull();
            await vi.advanceTimersByTimeAsync(1);
            expect(await pending).not.toBeNull();
            expect(http.post).toHaveBeenCalledTimes(2);
            expect(playerStore.error).toBeNull();
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('preselects probe tracks, starts with absolute indices, and never requests /info', async () => {
        const { target, inner } = controller();
        const p = await prepare(target, inner);
        expect(playerStore.playbackVariants.map((v) => v.id)).toEqual([FILE, OTHER]);
        expect(playerStore.currentAudioTrackIndex).toBe(1);
        expect(playerStore.currentSubtitleTrackIndex).toBe(7);
        expect(target.getSubtitleTextHref(7)).toBe('');
        // Even a stale coarse display badge cannot force a full transcode.
        playerStore.setPlayMethod('Transcode');
        const url = await inner.buildLumastraPlaybackUrl(p, 'remux', 25);
        expect(url).toBe('/issued/stream?grant=opaque');
        const body = http.post.mock.calls.find(([path]) => path === '/api/play-sessions')?.[2];
        expect(body).toMatchObject({
            fileId: FILE,
            audioStreamIndex: 4,
            subtitleId: `${FILE}:7`,
            startPositionMs: 25_000,
        });
        expect(body.requestedMethod).toBeUndefined();
        expect(target.getSubtitleTextHref(7)).toBe(
            `/issued/subtitle/${FILE}:7?grant=opaque&revision=2`,
        );
        await vi.waitFor(() =>
            expect(http.get).toHaveBeenCalledWith(
                '/issued/timeline?grant=opaque&file=selected',
                expect.anything(),
            ),
        );
        expect(playerStore.trickplayManifestHref).toBe('/issued/previews?grant=opaque');
        expect(http.post.mock.calls.map(([path]) => path)).toEqual([
            `/api/media/${MEDIA}/playability`,
            '/api/play-sessions',
        ]);
    });

    it('preserves the selected absolute audio stream when same-language delivery tracks refresh', async () => {
        const { target, inner } = controller();
        const p = await prepare(target, inner);
        const tracks = p.activeVersion.tracks.audio;
        tracks[0].language = 'eng';
        inner.updateProbedSource(p, MEDIA);
        playerStore.currentAudioTrackIndex = 1;
        const start = started();
        if (start.delivery.kind !== 'hls') throw new Error('Expected video tracks');
        // Relative indices may change as the start envelope refreshes metadata.
        start.delivery.tracks.audio = tracks.map((track, index) => ({
            ...track,
            index: 1 - index,
        }));
        inner.applyPlaybackStart(start);
        expect(
            playerStore.currentMediaSource?.audioStreams.find(
                (track) => track.index === playerStore.currentAudioTrackIndex,
            )?.absoluteIndex,
        ).toBe(4);
        inner.updateProbedSource(p, MEDIA);
        expect(playerStore.currentAudioTrackIndex).toBe(0);
    });

    it('switches versions through a file-specific probe and retains the full picker', async () => {
        const { target, inner } = controller();
        await prepare(target, inner);
        playerStore.setCurrentTime(40);
        await target.switchLumastraFile(OTHER);
        expect(http.post).toHaveBeenCalledWith(
            `/api/media/${MEDIA}/playability`,
            expect.anything(),
            expect.objectContaining({ fileId: OTHER }),
        );
        expect(http.post).toHaveBeenCalledWith(
            '/api/play-sessions',
            expect.anything(),
            expect.objectContaining({
                fileId: OTHER,
                audioStreamIndex: 4,
                startPositionMs: 40_000,
            }),
        );
        expect(playerStore.activeVariantId).toBe(OTHER);
        expect(playerStore.playbackVariants).toHaveLength(2);
        expect(target.getSubtitleTextHref(7)).toContain(`${OTHER}:7?grant=opaque`);
    });

    it('preserves episode position when switching ordinary files with different windows', async () => {
        const { target, inner } = controller();
        await prepare(target, inner);
        const source = started();
        if (source.delivery.kind !== 'hls') throw new Error('Expected HLS');
        source.delivery.seek = { clientShouldSeek: true, streamStartPositionMs: 10_000 };
        inner.playbackStart = source;
        http.post.mockImplementation(async (url: string) => {
            if (url.endsWith('/playability'))
                return { data: probe(OTHER), status: 200, error: null };
            const next = started(OTHER);
            if (next.delivery.kind !== 'hls') throw new Error('Expected HLS');
            next.delivery.seek = { clientShouldSeek: true, streamStartPositionMs: 20_000 };
            return { data: next, status: 201, error: null };
        });
        playerStore.setCurrentTime(40);
        await target.switchLumastraFile(OTHER);
        expect(http.post).toHaveBeenLastCalledWith(
            '/api/play-sessions',
            expect.anything(),
            expect.objectContaining({ fileId: OTHER, startPositionMs: 30_000 }),
        );
        expect(target.initializeHls).toHaveBeenLastCalledWith('/issued/stream?grant=opaque', 50);
        expect(playerStore.activeVariantId).toBe(OTHER);
    });

    it('uses stable subtitle ids when sidecars renumber between probe and start', async () => {
        const { target, inner } = controller();
        const p = await prepare(target, inner);
        playerStore.currentSubtitleTrackIndex = 1000;
        const sidecarStart = started();
        if (sidecarStart.delivery.kind !== 'hls') throw new Error('Expected HLS');
        sidecarStart.delivery.applied.subtitleId = 'sidecar-stable';
        http.post.mockResolvedValueOnce({ data: sidecarStart, error: null, status: 201 });
        await inner.buildLumastraPlaybackUrl(p, 'remux');
        expect(playerStore.currentSubtitleTrackIndex).toBe(1002);
        inner.updateProbedSource(p, MEDIA);
        expect(playerStore.currentSubtitleTrackIndex).toBe(1002);
        expect(target.getSubtitleTextHref(1002)).toContain(
            '/issued/subtitle/sidecar-stable?grant=opaque',
        );
        expect(http.post.mock.calls[1][2].subtitleId).toBe('sidecar-stable');
        await inner.buildLumastraPlaybackUrl(p, 'remux');
        expect(http.post.mock.calls.at(-1)?.[2].subtitleId).toBe('sidecar-stable');
    });

    it('allows audio-only only as an explicit quality choice', async () => {
        const { target, inner } = controller();
        const p = await prepare(target, inner);
        playerStore.qualityMode = 'audio-only';
        const method = target.resolveAvailableLumastraMethod(p);
        expect(method).toBe('audio_only');
        await inner.buildLumastraPlaybackUrl(p, method!);
        expect(http.post.mock.calls[1][2].requestedMethod).toBe('audio_only');
    });

    it('sends an override only after a logged real playback failure', async () => {
        const { target, inner } = controller();
        await prepare(target, inner);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await target.fallbackToHlsTranscoding('MediaError: decode failed');
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('decode failed'));
        expect(http.post.mock.calls[1][2].requestedMethod).toBe('remux');
    });

    it('renews only credentials without re-adopting the start or reloading the stream', async () => {
        const { target, inner } = controller();
        const p = await prepare(target, inner);
        await target.setupSubtitleAndProgressReporter();
        const reporter = target.progressReporter as PlaySessionReporter;
        reporters.push(reporter);
        await inner.buildLumastraPlaybackUrl(p, 'remux');
        const [start, renew] = vi.mocked(maintainPlaybackGrant).mock.calls.at(-1)!;
        expect(start).toBe(inner.playbackStart);
        const adoption = vi.spyOn(inner, 'applyPlaybackStart');
        const source = playerStore.currentMediaSource;
        const playbackInfo = inner.currentPlaybackInfo;
        const requestId = inner.timelineRequestId;
        const variants = playerStore.trickplayVariants;
        playerStore.audioSelectionReason = 'file-default';
        start.grant.token = 'renewed';
        if (start.delivery.kind !== 'hls') throw new Error('Expected HLS');
        start.delivery.trickplay!.href = '/issued/previews?grant=renewed';
        const manager = { load: vi.fn(), updateConfig: vi.fn() };
        Object.defineProperty(target, 'videoElement', {
            value: document.createElement('video'),
            configurable: true,
        });
        Object.defineProperty(target, 'ensurePlaybackManager', { value: () => manager });
        await renew!();
        expect(adoption).not.toHaveBeenCalled();
        expect(manager.load).not.toHaveBeenCalled();
        expect(inner.streamToken).toBe('renewed');
        expect(playerStore.currentMediaSource).toBe(source);
        expect(playerStore.audioSelectionReason).toBe('file-default');
        expect(inner.currentPlaybackInfo).toBe(playbackInfo);
        expect(inner.timelineRequestId).toBe(requestId);
        expect(playerStore.trickplayVariants).toBe(variants);
        expect(playerStore.trickplayManifestHref).toBe('/issued/previews?grant=renewed');
        target.sameBrowserChannel?.close();
    });

    it.each([true, false])(
        'holds quality restart for the started delivery with existing probe=%s',
        async (existing) => {
            const { target, inner } = controller();
            const p = await prepare(target, inner);
            p.activeVersion.playMethod = 'direct';
            if (!existing) inner.setPlaybackProbe(null as unknown as PlayerProbe);
            vi.spyOn(target, 'fetchPlaybackProbe').mockResolvedValue(p);
            vi.spyOn(inner, 'buildLumastraPlaybackUrl').mockImplementation(async () => {
                inner.applyPlaybackStart(started(FILE, 'audio_transcode'));
                return '/issued/hls';
            });
            Object.defineProperty(target, 'videoElement', {
                value: document.createElement('video'),
                configurable: true,
            });
            Object.defineProperty(target, 'playbackManager', { value: {} });
            const hold = vi.fn();
            Object.defineProperty(target, 'holdRestartUntilPlayable', { value: hold });
            await inner.restartStreamWithNewQualityInner({ position: 30, play: true });
            expect(hold).toHaveBeenCalledWith({ position: 30, play: true }, false);
        },
    );

    it('restores the old start and its timeline after a failed file switch', async () => {
        const { target, inner } = controller();
        await prepare(target, inner);
        const old = started();
        inner.applyPlaybackStart(old);
        vi.spyOn(target, 'initializeHls').mockRejectedValue(new Error('load failed'));
        Object.defineProperty(target, 'clearPostSwitchRecovery', { value: vi.fn() });
        await target.switchLumastraFile(OTHER);
        expect(inner.playbackStart).toBe(old);
        expect(http.get.mock.calls.at(-1)?.[0]).toBe('/issued/timeline?grant=opaque&file=selected');
        expect(playerStore.trickplayManifestHref).toBe('/issued/previews?grant=opaque');
    });

    it('an obsolete ABR restart cannot overwrite a replacement item after teardown waits', async () => {
        const { target, inner } = controller();
        await prepare(target, inner);
        Object.defineProperty(target, 'abrCtrl', { value: { clearSamples: vi.fn() } });
        const build = vi
            .spyOn(inner, 'buildLumastraPlaybackUrl')
            .mockResolvedValue('/issued/obsolete');
        let release!: () => void;
        vi.spyOn(target, 'endCurrentSession').mockImplementationOnce(
            () =>
                new Promise<void>((r) => {
                    release = r;
                }),
        );
        const pending = target.restartPlaybackAtBitrate(2_000_000);
        (target as unknown as { playbackGeneration: number }).playbackGeneration++;
        playerStore.itemId = OTHER;
        playerStore.setPlaySessionId('replacement');
        playerStore.setCurrentTime(80);
        release();
        await pending;
        expect(build).not.toHaveBeenCalled();
        expect(target.initializeHls).not.toHaveBeenCalled();
        expect(playerStore.playSessionId).toBe('replacement');
        expect(playerStore.currentTime).toBe(80);
    });

    it('ABR captures its delivered position before the element can reset to zero', async () => {
        const { target, inner } = controller();
        await prepare(target, inner);
        Object.defineProperty(target, 'abrCtrl', { value: { clearSamples: vi.fn() } });
        vi.spyOn(inner, 'buildLumastraPlaybackUrl').mockResolvedValue('/issued/bitrate');
        const video = document.createElement('video');
        video.currentTime = 60;
        Object.defineProperty(target, 'videoElement', { value: video, configurable: true });
        let release!: () => void;
        vi.spyOn(target, 'endCurrentSession').mockImplementationOnce(
            () =>
                new Promise<void>((r) => {
                    release = r;
                }),
        );
        Object.defineProperty(target, 'isRestartingPlayback', {
            value: true,
            writable: true,
            configurable: true,
        });
        const pending = target.restartPlaybackAtBitrate(2_000_000);
        video.currentTime = 0;
        expect(
            (target as unknown as { restartQueue: RestartQueue }).restartQueue.currentResume()
                ?.position,
        ).toBe(60);
        release();
        await pending;
        expect(inner.buildLumastraPlaybackUrl).toHaveBeenCalledWith(
            expect.anything(),
            'remux',
            60,
            expect.any(Function),
        );
    });

    it.each([undefined, '44444444-4444-4444-8444-444444444444'])(
        'same-item timeline cancellation reloads a fresh canonical source with file=%s',
        async (fileId) => {
            const { target, inner } = controller();
            await prepare(target, inner);
            Object.defineProperty(target, 'abrCtrl', { value: { clearSamples: vi.fn() } });
            const reload = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
            let release!: () => void;
            vi.spyOn(target, 'endCurrentSession').mockImplementationOnce(
                () =>
                    new Promise<void>((r) => {
                        release = r;
                    }),
            );
            const pending = target.restartPlaybackAtBitrate(2_000_000);
            Object.assign(watchTogether, {
                session: { code: 'new', itemId: MEDIA, currentTime: 80, timelineId: 'new', fileId },
            });
            release();
            await pending;
            expect(target.isRestartingPlayback).toBe(false);
            expect(reload).toHaveBeenCalledWith(
                fileId ? `/watch/${MEDIA}?fileId=${fileId}` : `/watch/${MEDIA}`,
            );
            watchTogether.session = null;
        },
    );

    it.each(['abr', 'rebuild'] as const)(
        'an obsolete %s builder cannot mutate a replacement party timeline during capabilities preparation',
        async (kind) => {
            const { target, inner } = controller();
            await prepare(target, inner);
            Object.defineProperty(target, 'abrCtrl', { value: { clearSamples: vi.fn() } });
            let release!: (value: undefined) => void;
            vi.spyOn(
                target as unknown as { playbackCapabilities(): Promise<undefined> },
                'playbackCapabilities',
            ).mockImplementationOnce(
                () =>
                    new Promise((r) => {
                        release = r;
                    }),
            );
            Object.assign(watchTogether, {
                session: { code: 'ABC123', itemId: MEDIA, timelineId: 'old' },
            });
            const reload = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
            const pending =
                kind === 'abr'
                    ? target.restartPlaybackAtBitrate(2_000_000)
                    : inner.rebuildPlaybackSession();
            await vi.waitFor(() => expect(release).toBeTypeOf('function'));
            watchTogether.session = { ...watchTogether.session!, timelineId: 'new' };
            playerStore.setCurrentTime(80);
            playerStore.setPlaySessionId('replacement');
            const posts = http.post.mock.calls.filter(
                ([url]) => url === '/api/play-sessions',
            ).length;
            release(undefined);
            await pending;
            expect(playerStore.currentTime).toBe(80);
            expect(playerStore.playSessionId).toBe('replacement');
            expect(
                http.post.mock.calls.filter(([url]) => url === '/api/play-sessions'),
            ).toHaveLength(posts);
            expect(target.initializeHls).not.toHaveBeenCalled();
            expect(reload).toHaveBeenCalledWith(`/watch/${MEDIA}`);
            watchTogether.disconnect();
        },
    );

    it.each([
        ['abr', true, false, false, 60],
        ['quality', true, false, false, 60],
        ['abr', false, false, false, 60],
        ['quality', false, false, false, 60],
        ['abr', true, true, false, 60],
        ['quality', true, true, false, 60],
        ['rebuild', true, false, false, 60],
        ['rebuild', false, false, false, 60],
        ['rebuild', true, true, false, 60],
        ['rebuild', false, false, true, 60],
        ['rebuild', true, false, 'solo', 60],
        ['reporter', true, false, false, 60],
        ['reporter', false, false, false, 60],
        ['reporter', true, true, false, 60],
        ['reporter', true, false, false, 0],
    ] as const)(
        'real %s restart restores playing=%s seek=%s joinParty=%s delivered=%s',
        async (kind, playing, newerSeek, joinParty, delivered) => {
            vi.useFakeTimers();
            const { target, inner } = controller();
            const preparedProbe = await prepare(target, inner);
            watchTogether.disconnect();
            watchTogether.session = {
                code: 'ABC123',
                itemId: MEDIA,
                title: 'Movie',
                mediaType: 'movie',
                host: buildPublicAuthor('11111111-1111-4111-8111-111111111111', 'Host', 'internal'),
                hostClientId: 'host',
                currentTime: delivered,
                isPlaying: true,
                playbackRate: 1,
                timelineId: 'timeline',
                createdAt: 0,
                lastSync: 0,
                visibility: 'listed',
                participants: [],
            };
            const video = document.createElement('video');
            video.currentTime = delivered;
            let ready = 4;
            let paused = false;
            vi.spyOn(video, 'paused', 'get').mockImplementation(() => paused);
            vi.spyOn(video, 'readyState', 'get').mockImplementation(() => ready);
            vi.spyOn(video, 'seeking', 'get').mockReturnValue(false);
            const play = vi.spyOn(video, 'play').mockImplementation(async () => {
                paused = false;
            });
            vi.spyOn(video, 'pause').mockImplementation(() => {
                paused = true;
            });
            vi.spyOn(video, 'load').mockImplementation(() => {
                video.currentTime = 0;
                ready = 0;
            });
            Object.defineProperty(target, 'videoElement', { value: video, configurable: true });
            Object.defineProperty(target, 'playbackManager', {
                value: { destroy: vi.fn() },
                configurable: true,
            });
            Object.defineProperty(target, 'abrCtrl', {
                value: { clearSamples: vi.fn() },
                configurable: true,
            });
            vi.spyOn(target, 'setVideoTime').mockImplementation(
                PlayerController.prototype.setVideoTime.bind(target),
            );
            vi.spyOn(target, 'reinitializeSubtitleRendererIfNeeded').mockResolvedValue();
            for (const key of ['syncWakeLockForQualityMode', 'consumePendingAudioSwitch'])
                Object.defineProperty(target, key, { value: vi.fn(), configurable: true });
            Object.defineProperty(target, 'finishRestart', {
                value: PlayerController.prototype.finishRestart,
                configurable: true,
            });
            Object.defineProperty(target, 'tryStartRestart', {
                value: PlayerController.prototype.tryStartRestart,
                configurable: true,
            });
            const stall = vi.spyOn(watchTogether, 'reportStall').mockResolvedValue(true);
            const reportReady = vi.spyOn(watchTogether, 'reportReady').mockResolvedValue(true);
            vi.spyOn(WatchTogetherHandlers.prototype, 'setupIntervals').mockReturnValue(() => {});
            vi.spyOn(watchTogether, 'tryRejoinFromStorage').mockResolvedValue(false);
            const partyController = new WatchTogetherController({
                getVideoElement: () => video,
                getItemId: () => MEDIA,
                getWatchTogetherToast: () => null,
                getPlaybackInfo: () => ({ itemId: MEDIA, title: 'Movie', mediaType: 'movie' }),
                getPlaybackProbe: () => null,
                seekTo: (time) => {
                    video.currentTime = time;
                },
                setVideoTime: (time) => {
                    video.currentTime = time;
                },
                switchLumastraFile: () => {},
                handlePlayError: vi.fn(),
                onMutedFallback: () => {},
                log: () => {},
            });
            Object.defineProperty(target, 'watchTogetherCtrl', {
                value: partyController,
                configurable: true,
            });
            const cleanup = await partyController.setupInMount('user');
            if (kind === 'reporter') {
                await target.setupSubtitleAndProgressReporter();
                reporters.push(target.progressReporter as PlaySessionReporter);
                await inner.buildLumastraPlaybackUrl(preparedProbe, 'remux', delivered);
            } else vi.spyOn(inner, 'buildLumastraPlaybackUrl').mockResolvedValue('/issued/party');
            vi.spyOn(target, 'resolveAvailableLumastraMethod').mockReturnValue('remux');
            Object.defineProperty(target, 'refreshTimeline', {
                value: vi.fn(),
                configurable: true,
            });
            Object.defineProperty(target, 'setLumastraHdrInfo', {
                value: vi.fn(),
                configurable: true,
            });
            vi.spyOn(target, 'initializeHls').mockImplementation(async (_url, position) => {
                video.pause();
                video.currentTime = 0;
                ready = 0;
                video.addEventListener(
                    'loadedmetadata',
                    () => {
                        video.currentTime = position ?? 0;
                    },
                    { once: true },
                );
            });

            const party = watchTogether.session;
            const reload = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
            if (joinParty) watchTogether.session = null;
            // Recovery must use the live delivered clock when display state lags.
            playerStore.setCurrentTime(delivered === 0 ? 60 : 0.2);
            try {
                const pending =
                    kind === 'abr'
                        ? target.restartPlaybackAtBitrate(2_000_000)
                        : kind === 'rebuild'
                          ? inner.rebuildPlaybackSession()
                          : kind === 'reporter'
                            ? (async () => {
                                  http.put.mockResolvedValueOnce({
                                      data: null,
                                      status: 410,
                                      error: 'Expired',
                                  });
                                  Object.defineProperty(target, 'hasReportedRealPosition', {
                                      value: true,
                                  });
                                  await target.reportProgress('progress');
                              })()
                            : target.restartStreamWithNewQuality();
                await vi.advanceTimersByTimeAsync(501);
                await pending;
                expect(stall).toHaveBeenCalledTimes(joinParty ? 0 : 1);
                expect(partyController.isSourceReplacing).toBe(!joinParty);
                expect(reportReady).not.toHaveBeenCalled();
                expect(play).not.toHaveBeenCalled();
                if (kind === 'reporter') {
                    expect(
                        http.post.mock.calls
                            .filter(([url]) => url === '/api/play-sessions')
                            .at(-1)?.[2],
                    ).toMatchObject({ startPositionMs: delivered * 1000 });
                }
                watchTogether.session =
                    joinParty === 'solo' ? null : { ...party!, isPlaying: playing };
                if (newerSeek) {
                    target.setVideoTime(50, 'watch_party_seek');
                    video.currentTime = 0;
                }
                ready = 4;
                video.dispatchEvent(new Event('loadedmetadata'));
                video.dispatchEvent(new Event('canplay'));
                await vi.advanceTimersByTimeAsync(0);
                expect(video.currentTime).toBe(newerSeek ? 50 : delivered);
                if (joinParty) {
                    expect(reportReady).not.toHaveBeenCalled();
                    if (joinParty === 'solo') expect(reload).not.toHaveBeenCalled();
                    else expect(reload).toHaveBeenCalledWith(`/watch/${MEDIA}`);
                } else expect(reportReady).toHaveBeenCalledWith(stall.mock.calls[0][0]);
                expect(play).toHaveBeenCalledTimes(playing ? 1 : 0);
                expect(partyController.isSourceReplacing).toBe(false);
            } finally {
                cleanup?.();
                partyController.dispose();
                target.cleanupPositionRestore?.();
                watchTogether.disconnect();
                vi.clearAllTimers();
                vi.useRealTimers();
            }
        },
    );

    it('a same-item timeline arriving after ABR installs its restore recovers the current source', async () => {
        vi.useFakeTimers();
        const { target, inner } = controller();
        await prepare(target, inner);
        Object.defineProperty(target, 'abrCtrl', { value: { clearSamples: vi.fn() } });
        const video = document.createElement('video');
        video.currentTime = 60;
        let ready = 0;
        vi.spyOn(video, 'load').mockImplementation(() => {
            video.currentTime = 0;
        });
        vi.spyOn(video, 'pause').mockImplementation(() => {});
        vi.spyOn(video, 'readyState', 'get').mockImplementation(() => ready);
        Object.defineProperty(target, 'videoElement', { value: video, configurable: true });
        vi.spyOn(inner, 'buildLumastraPlaybackUrl').mockResolvedValue('/issued/old-timeline');
        const reload = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
        try {
            const pending = target.restartPlaybackAtBitrate(2_000_000);
            await vi.advanceTimersByTimeAsync(501);
            await pending;
            Object.assign(watchTogether, {
                session: { code: 'new', itemId: MEDIA, currentTime: 80, timelineId: 'new' },
            });
            ready = 4;
            video.dispatchEvent(new Event('loadedmetadata'));
            video.dispatchEvent(new Event('canplay'));
            expect(reload).toHaveBeenCalledOnce();
            expect(reload).toHaveBeenCalledWith(`/watch/${MEDIA}`);
            expect(target.isRestartingPlayback).toBe(false);
        } finally {
            target.cleanupPositionRestore?.();
            watchTogether.disconnect();
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('builds a started HLS URL for bitrate restarts', async () => {
        const { target, inner } = controller();
        const p = await prepare(target, inner);
        Object.defineProperty(target, 'abrCtrl', { value: { clearSamples: vi.fn() } });
        vi.spyOn(inner, 'buildLumastraPlaybackUrl').mockResolvedValue('/issued/bitrate');
        await target.restartPlaybackAtBitrate(2_000_000);
        expect(inner.buildLumastraPlaybackUrl).toHaveBeenCalledWith(
            p,
            'remux',
            0,
            expect.any(Function),
        );
        expect(target.initializeHls).toHaveBeenCalledWith('/issued/bitrate', 0);
    });

    it('transcodes selected EAC3 audio when Chrome falls back to hls.js', async () => {
        const { target, inner } = controller();
        const p = await prepare(target, inner);
        p.activeVersion.tracks.audio[1].codec = 'eac3';
        vi.stubGlobal('navigator', { userAgent: 'Chrome/140.0.0.0' });
        expect(playerStore.currentAudioTrackIndex).toBe(1);
        expect(target.findAvailableLumastraFallback(p)).toBe('audio_transcode');
    });

    it('shows the started video codec conversion and HDR output when the probe chose remux', async () => {
        const { target, inner } = controller();
        const p = await prepare(target, inner);
        p.activeVersion.tracks.video!.codec = 'hevc';
        p.activeVersion.tracks.video!.hdr = 'hdr10';
        const start = started(FILE, 'full_transcode');
        if (start.delivery.kind !== 'hls') throw new Error('Expected HLS');
        start.delivery.tracks.video!.codec = 'hevc';
        start.delivery.tracks.video!.hdr = 'hdr10';
        Object.assign(start.delivery, { outputHdr: 'sdr', transcodeCodec: 'h264' });
        inner.applyPlaybackStart(start);
        target.setLumastraHdrInfo(p);
        expect(playerStore.transcodingInfo?.videoCodec).toBe('HEVC → H264');
        expect(playerStore.hdrInfo).toMatchObject({ outputFormat: 'sdr', isToneMapped: true });
    });

    it('loads all versions for a file-specific deep link', async () => {
        const { target } = controller();
        const p = await target.fetchPlaybackProbe(MEDIA, OTHER);
        expect(p?.activeFileId).toBe(OTHER);
        expect(p?.versions.map((v) => v.fileId)).toEqual([FILE, OTHER]);
        expect(http.post.mock.calls.map(([, , body]) => body.fileId)).toEqual([undefined, OTHER]);
    });

    it('adopts the start method even when it differs from the probe', async () => {
        const { target, inner } = controller();
        await prepare(target, inner);
        inner.applyPlaybackStart(started(FILE, 'audio_transcode'));
        expect(target.lumastraPlayMethod).toBe('audio_transcode');
        expect(playerStore.transcodingInfo?.transcodeReasons).toEqual(['Started reason']);
    });

    it('does not convert a planner recommendation into an override during a seek/restart', async () => {
        const { target, inner } = controller();
        const p = await prepare(target, inner);
        expect(target.resolveAvailableLumastraMethod(p)).toBe('remux');
        Object.defineProperty(target, 'videoElement', { value: document.createElement('video') });
        await target.initializePlayback(true, 30, true);
        expect(http.post.mock.calls[1][2].requestedMethod).toBeUndefined();
    });
});

// Run the real controller effects while isolating unrelated playback side effects.
function subtitleEffects(target: PlayerController): () => void {
    for (const [key, value] of Object.entries({
        storeInitialized: true,
        resizeObserver: null,
        isInitialized: true,
        previousSubtitleIndex: null,
        subtitleInitializationFailure: null,
        nativeSubtitleFailure: null,
        lastBurnInState: playerStore.forceSubtitleBurnIn,
        lastAudioTrackIndex: playerStore.currentAudioTrackIndex,
        lastMediaSourceId: playerStore.currentMediaSource?.id,
        lastAppliedPositionY: 90,
        effectiveSubtitleLineY: 90,
        lastAppliedOverlayMode: false,
        useSubtitleOverlay: false,
        subtitleStyle: null,
        subtitleCueCSS: '',
        videoElement: document.createElement('video'),
        isRestartingPlayback: false,
        updatePlaybackIntent: vi.fn(),
        buildQualityRestartKey: () => '',
        lastQualityRestartKey: '',
        updateSubtitleDisplay: vi.fn(),
        disposeAllSubtitleRenderers: vi.fn(),
        initSpecialSubtitleRenderer: vi.fn(),
        restartStreamWithNewQuality: vi.fn(),
        reportProgress: vi.fn().mockResolvedValue(undefined),
        logSub: vi.fn(),
    })) {
        Object.defineProperty(target, key, { value, writable: true, configurable: true });
    }
    // eslint-disable-next-line no-undef -- Svelte compiles runes in .svelte.test.ts modules.
    const cleanup = $effect.root(() => target.initEffects());
    flushSync();
    return cleanup;
}

describe('subtitle selection effects', () => {
    it.each(['ass', 'hdmv_pgs_subtitle', 'dvd_subtitle'])(
        'defers %s until raw delivery, initializes once, and keeps OFF/ON local',
        async (codec) => {
            const { target, inner } = controller();
            await prepare(target, inner);
            const track = playerStore.currentMediaSource!.subtitleStreams[0];
            track.codec = codec;
            track.language = 'deu';
            playerStore.currentMediaSource!.audioStreams[1].language = 'deu';
            const cleanup = subtitleEffects(target);
            try {
                expect(target.initSpecialSubtitleRenderer).not.toHaveBeenCalled();
                expect(target.disposeAllSubtitleRenderers).not.toHaveBeenCalled();
                track.hrefs = { raw: '/issued/subtitle?grant=first' };
                flushSync();
                expect(target.initSpecialSubtitleRenderer).toHaveBeenCalledExactlyOnceWith(7);
                track.hrefs.raw = '/issued/subtitle?grant=renewed';
                flushSync();
                expect(target.initSpecialSubtitleRenderer).toHaveBeenCalledTimes(1);
                const source = playerStore.currentMediaSource;
                const session = playerStore.playSessionId;
                playerStore.setCurrentTime(43);
                playerStore.setForcedSubtitlesEnabled(false);
                flushSync();
                expect(playerStore.currentSubtitleTrackIndex).toBeNull();
                playerStore.setForcedSubtitlesEnabled(true);
                flushSync();
                expect(playerStore.currentSubtitleTrackIndex).toBe(7);
                expect(target.initSpecialSubtitleRenderer).toHaveBeenCalledTimes(2);
                expect(target.disposeAllSubtitleRenderers).toHaveBeenCalledTimes(3);
                expect(target.restartStreamWithNewQuality).not.toHaveBeenCalled();
                expect(target.reportProgress).toHaveBeenCalledTimes(3);
                expect(target.reportProgress).toHaveBeenLastCalledWith('progress');
                expect(playerStore.currentMediaSource).toBe(source);
                expect(playerStore.currentTime).toBe(43);
                expect(playerStore.playSessionId).toBe(session);
            } finally {
                cleanup();
            }
        },
    );

    it('reports native text and off selections without restarting the video', async () => {
        const { target, inner } = controller();
        await prepare(target, inner);
        const cleanup = subtitleEffects(target);
        try {
            playerStore.currentSubtitleTrackIndex = null;
            flushSync();
            playerStore.currentSubtitleTrackIndex = 8;
            flushSync();
            expect(target.restartStreamWithNewQuality).not.toHaveBeenCalled();
            expect(target.reportProgress).toHaveBeenCalledTimes(3);
        } finally {
            cleanup();
        }
    });

    it('preserves restarts when switching burn-in-only tracks', async () => {
        const { target, inner } = controller();
        await prepare(target, inner);
        for (const track of playerStore.currentMediaSource!.subtitleStreams) {
            track.codec = 'dvbsub';
            track.isTextSubtitleStream = false;
            track.supportsExternalStream = false;
            track.deliveryMethod = 'Encode';
        }
        const cleanup = subtitleEffects(target);
        try {
            expect(playerStore.forceSubtitleBurnIn).toBe(true);
            expect(target.restartStreamWithNewQuality).toHaveBeenCalledTimes(1);
            playerStore.currentSubtitleTrackIndex = 8;
            flushSync();
            expect(target.restartStreamWithNewQuality).toHaveBeenCalledTimes(2);
            playerStore.currentSubtitleTrackIndex = null;
            flushSync();
            expect(playerStore.forceSubtitleBurnIn).toBe(false);
            expect(target.restartStreamWithNewQuality).toHaveBeenCalledTimes(3);
            expect(target.reportProgress).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });
});

describe('pending subtitle transitions', () => {
    it.each(['ass', 'subrip', 'dvbsub'])(
        'restores %s after selecting a pending track and then returning',
        async (codec) => {
            const { target, inner } = controller();
            await prepare(target, inner);
            const [original, pending] = playerStore.currentMediaSource!.subtitleStreams;
            original.codec = codec;
            original.hrefs = { raw: '/issued/original', text: '/issued/original.vtt' };
            if (codec === 'dvbsub') {
                original.isTextSubtitleStream = false;
                original.supportsExternalStream = false;
                original.deliveryMethod = 'Encode';
            }
            pending.codec = 'ass';
            const cleanup = subtitleEffects(target);
            try {
                vi.mocked(target.initSpecialSubtitleRenderer).mockClear();
                vi.mocked(target.updateSubtitleDisplay).mockClear();
                playerStore.currentSubtitleTrackIndex = 8;
                flushSync();
                playerStore.currentSubtitleTrackIndex = 7;
                flushSync();
                expect(playerStore.currentSubtitleTrackIndex).toBe(7);
                expect(target.updateSubtitleDisplay).toHaveBeenCalledTimes(2);
                if (codec === 'ass')
                    expect(target.initSpecialSubtitleRenderer).toHaveBeenCalledExactlyOnceWith(7);
                if (codec === 'dvbsub') {
                    expect(playerStore.forceSubtitleBurnIn).toBe(true);
                    expect(target.restartStreamWithNewQuality).toHaveBeenCalledTimes(3);
                }
            } finally {
                cleanup();
            }
        },
    );

    it('adopts raw delivery at the same index through applyPlaybackStart', async () => {
        const { target, inner } = controller();
        await prepare(target, inner);
        playerStore.currentMediaSource!.subtitleStreams[0].codec = 'ass';
        const cleanup = subtitleEffects(target);
        try {
            const start = started();
            if (start.delivery.kind !== 'hls') throw new Error('Expected HLS');
            start.delivery.subtitles![0].codec = 'ass';
            start.delivery.subtitles![0].hrefs = { raw: '/issued/forced.ass?grant=opaque' };
            inner.applyPlaybackStart(start);
            flushSync();
            expect(target.initSpecialSubtitleRenderer).toHaveBeenCalledExactlyOnceWith(7);
            flushSync();
            expect(target.initSpecialSubtitleRenderer).toHaveBeenCalledTimes(1);
        } finally {
            cleanup();
        }
    });

    it.each(['ass', 'dvbsub'])(
        'clears active %s while ASS delivery is pending and allows OFF cancellation',
        async (previousCodec) => {
            const { target, inner } = controller();
            await prepare(target, inner);
            const [previous, pending] = playerStore.currentMediaSource!.subtitleStreams;
            previous.codec = previousCodec;
            if (previousCodec === 'dvbsub') {
                previous.isTextSubtitleStream = false;
                previous.supportsExternalStream = false;
                previous.deliveryMethod = 'Encode';
            }
            previous.hrefs = { raw: '/issued/previous' };
            pending.codec = 'ass';
            const cleanup = subtitleEffects(target);
            try {
                vi.mocked(target.disposeAllSubtitleRenderers).mockClear();
                vi.mocked(target.initSpecialSubtitleRenderer).mockClear();
                vi.mocked(target.restartStreamWithNewQuality).mockClear();
                playerStore.currentSubtitleTrackIndex = 8;
                flushSync();
                expect(target.disposeAllSubtitleRenderers).toHaveBeenCalled();
                expect(target.updateSubtitleDisplay).toHaveBeenCalled();
                expect(target.initSpecialSubtitleRenderer).not.toHaveBeenCalled();
                expect(playerStore.forceSubtitleBurnIn).toBe(false);
                expect(target.restartStreamWithNewQuality).toHaveBeenCalledTimes(
                    previousCodec === 'dvbsub' ? 1 : 0,
                );
                playerStore.currentSubtitleTrackIndex = null;
                flushSync();
                pending.hrefs = { raw: '/issued/late.ass' };
                flushSync();
                expect(target.initSpecialSubtitleRenderer).not.toHaveBeenCalled();
                expect(playerStore.currentSubtitleTrackIndex).toBeNull();
            } finally {
                cleanup();
            }
        },
    );

    it('assembles selected subtitle metadata in real progress reports including OFF', async () => {
        const { target, inner } = controller();
        await prepare(target, inner);
        const track = playerStore.currentMediaSource!.subtitleStreams[0];
        track.codec = 'ass';
        track.hrefs = { raw: '/issued/forced.ass' };
        const cleanup = subtitleEffects(target);
        const report = vi.spyOn(target.progressReporter!, 'report').mockResolvedValue(true);
        Object.defineProperty(target, 'reportProgress', {
            value: PlayerController.prototype.reportProgress,
            configurable: true,
        });
        Object.defineProperty(target, 'hasReportedRealPosition', { value: true });
        try {
            playerStore.currentSubtitleTrackIndex = null;
            flushSync();
            expect(report).toHaveBeenLastCalledWith(
                'progress',
                expect.objectContaining({
                    subtitleStreamIndex: null,
                    subtitleId: 'none',
                    subtitleMethod: 'none',
                }),
            );
            playerStore.currentSubtitleTrackIndex = 7;
            flushSync();
            expect(report).toHaveBeenLastCalledWith(
                'progress',
                expect.objectContaining({
                    subtitleStreamIndex: 7,
                    subtitleId: `${FILE}:7`,
                    subtitleMethod: 'client_render',
                }),
            );
            playerStore.currentSubtitleTrackIndex = 8;
            flushSync();
            expect(report).toHaveBeenLastCalledWith(
                'progress',
                expect.objectContaining({
                    subtitleStreamIndex: 8,
                    subtitleId: `${FILE}:8`,
                    subtitleMethod: 'external_vtt',
                }),
            );
            expect(target.restartStreamWithNewQuality).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });
});

describe('late subtitle start responses B5', () => {
    it.each(['heartbeat', 'replacement'])(
        'keeps Off during implicit session recovery while the %s request is pending',
        async (phase) => {
            const { target, inner } = controller();
            const p = await prepare(target, inner);
            await target.setupSubtitleAndProgressReporter();
            reporters.push(target.progressReporter as PlaySessionReporter);
            await inner.buildLumastraPlaybackUrl(p, 'remux');
            Object.defineProperty(target, 'hasReportedRealPosition', { value: true });
            let failHeartbeat!: (value: unknown) => void;
            let finishStart!: (value: unknown) => void;
            http.put.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        failHeartbeat = resolve;
                    }),
            );
            http.post.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishStart = resolve;
                    }),
            );
            const pending = target.reportProgress('progress');
            await vi.waitFor(() => expect(failHeartbeat).toBeTypeOf('function'));
            if (phase === 'heartbeat') playerStore.setSubtitleTrack(null);
            failHeartbeat({ data: null, status: 410, error: 'Expired' });
            await vi.waitFor(() => expect(finishStart).toBeTypeOf('function'));
            if (phase === 'replacement') playerStore.setSubtitleTrack(null);
            finishStart({ data: started(), status: 201, error: null });
            await pending;
            expect(playerStore.currentSubtitleTrackIndex).toBeNull();
        },
    );
    it.each([null, 8, 1000])(
        'keeps the newer viewer choice %s and maps a moved sidecar by stable identity',
        async (choice) => {
            const { target, inner } = controller();
            const p = await prepare(target, inner);
            let release!: (value: {
                data: PlaybackStartResponse;
                status: number;
                error: null;
            }) => void;
            http.post.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        release = resolve;
                    }),
            );
            const pending = inner.buildLumastraPlaybackUrl(p, 'remux');
            await vi.waitFor(() => expect(release).toBeTypeOf('function'));
            playerStore.setSubtitleTrack(choice);
            release({ data: started(), status: 201, error: null });
            await pending;
            expect(playerStore.currentSubtitleTrackIndex).toBe(choice === 1000 ? 1002 : choice);
        },
    );
    it('a failed start cannot leave a stale selection revision on the next request', async () => {
        const { target, inner } = controller();
        const p = await prepare(target, inner);
        http.post.mockResolvedValueOnce({ data: null, error: 'Unavailable', status: 503 });
        await expect(inner.buildLumastraPlaybackUrl(p, 'remux')).rejects.toThrow(
            'Playback start failed',
        );
        playerStore.setSubtitleTrack(null);
        await inner.buildLumastraPlaybackUrl(p, 'remux');
        expect(
            http.post.mock.calls.filter(([url]) => url === '/api/play-sessions').at(-1)![2],
        ).toMatchObject({ subtitleId: 'none' });
        expect(playerStore.currentSubtitleTrackIndex).toBe(7);
    });
    it('captures intent after awaited startup preparation, so server application still applies without a later choice', async () => {
        const { target, inner } = controller();
        const p = await prepare(target, inner);
        let ready!: (value: undefined) => void;
        vi.spyOn(
            target as unknown as { playbackCapabilities(): Promise<undefined> },
            'playbackCapabilities',
        ).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    ready = resolve;
                }),
        );
        const pending = inner.buildLumastraPlaybackUrl(p, 'remux');
        playerStore.setSubtitleTrack(null);
        ready(undefined);
        await pending;
        expect(
            http.post.mock.calls.find(([url]) => url === '/api/play-sessions')?.[2],
        ).toMatchObject({ subtitleId: 'none' });
        // A server-applied result is authoritative when no choice changed after the request.
        expect(playerStore.currentSubtitleTrackIndex).toBe(7);
    });
});

it('forwards preference freshness through the real pending probe and recommendation adapter', async () => {
    const saved = getPreferences();
    const { target, inner } = controller();
    let finishProbe!: (value: unknown) => void;
    try {
        await playbackPreferences.forceSyncToServer();
        http.post.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishProbe = resolve;
                }),
        );
        const pending = target.fetchPlaybackProbe(MEDIA);
        await vi.waitFor(() => expect(finishProbe).toBeTypeOf('function'));
        updatePreferences({
            subtitlesEnabled: true,
            subtitleLanguage: 'eng',
            subtitleTrackHint: { language: 'eng', isForced: false, codec: 'subrip' },
        });
        expect(await playbackPreferences.forceSyncToServer()).toBe(true);
        finishProbe({ data: probe(), status: 200, error: null });
        const p = (await pending)!;
        inner.setPlaybackProbe(p);
        playerStore.currentMediaSource = target.buildLumastraSource(p, MEDIA);
        playerStore.applyTrackRecommendation(probeTrackRecommendation(p));
        expect(playerStore.currentSubtitleTrackIndex).toBe(8);
    } finally {
        updatePreferences(saved);
        await playbackPreferences.forceSyncToServer();
    }
});

describe('active burned subtitle ownership B10', () => {
    function burnInStart(): PlaybackStartResponse {
        const start = started();
        start.playbackSessionId = '44444444-4444-4444-8444-444444444444';
        start.reporting.playbackSessionId = start.playbackSessionId;
        if (start.delivery.kind !== 'hls') throw new Error('Expected HLS');
        const track = {
            ...probe().versions[0].tracks.subtitles[0],
            codec: 'pgs',
            method: 'burn_in' as const,
        };
        start.delivery.tracks!.subtitles = [track];
        start.delivery.subtitles![0].codec = 'pgs';
        start.delivery.subtitles![0].hrefs = { raw: '/issued/also-available.pgs' };
        // Execute the real wire validator: delivery.tracks has indices, not IDs.
        return PlaybackStartResponseSchema.parse(start);
    }
    it('a same-index change to encoded delivery disposes an existing client renderer without a redundant restart', async () => {
        const { target, inner } = controller();
        await prepare(target, inner);
        playerStore.currentMediaSource!.subtitleStreams[0].codec = 'pgs';
        playerStore.currentMediaSource!.subtitleStreams[0].hrefs = { raw: '/issued/client.pgs' };
        const cleanup = subtitleEffects(target);
        try {
            vi.mocked(target.disposeAllSubtitleRenderers).mockClear();
            vi.mocked(target.restartStreamWithNewQuality).mockClear();
            inner.applyPlaybackStart(burnInStart());
            flushSync();
            expect(target.disposeAllSubtitleRenderers).toHaveBeenCalled();
            expect(target.restartStreamWithNewQuality).not.toHaveBeenCalled();
            expect(playerStore.forceSubtitleBurnIn).toBe(false);
        } finally {
            cleanup();
        }
    });
    it.each([null, 8])(
        'rebuilds encoded PGS when selecting %s even with previousSubtitleIndex null',
        async (choice) => {
            const { target, inner } = controller();
            await prepare(target, inner);
            inner.applyPlaybackStart(burnInStart());
            const cleanup = subtitleEffects(target);
            try {
                expect(target.isClientRenderedSubtitle(7)).toBe(false);
                expect(target.initSpecialSubtitleRenderer).not.toHaveBeenCalled();
                vi.mocked(target.restartStreamWithNewQuality).mockClear();
                target.previousSubtitleIndex = null;
                playerStore.setSubtitleTrack(choice);
                flushSync();
                expect(target.restartStreamWithNewQuality).toHaveBeenCalledOnce();
            } finally {
                cleanup();
            }
        },
    );
    it.each([null, 8, 1002])(
        'clears an old forced burn-in flag before the next start for choice %s',
        async (choice) => {
            const { target, inner } = controller();
            const p = await prepare(target, inner);
            inner.applyPlaybackStart(burnInStart());
            playerStore.setForceSubtitleBurnIn(true);
            const cleanup = subtitleEffects(target);
            try {
                expect(target.restartStreamWithNewQuality).not.toHaveBeenCalled();
                playerStore.setSubtitleTrack(choice);
                flushSync();
                expect(playerStore.forceSubtitleBurnIn).toBe(false);
                expect(target.restartStreamWithNewQuality).toHaveBeenCalledOnce();
                Object.defineProperty(target, 'reportProgress', {
                    value: PlayerController.prototype.reportProgress,
                    writable: true,
                    configurable: true,
                });
                await inner.buildLumastraPlaybackUrl(p, 'remux');
                const body = http.post.mock.calls
                    .filter(([url]) => url === '/api/play-sessions')
                    .at(-1)![2];
                expect(body.subtitleId).toBe(
                    choice === null ? 'none' : choice === 1002 ? 'sidecar-stable' : `${FILE}:8`,
                );
                expect(body.requestedMethod).toBeUndefined();
            } finally {
                cleanup();
            }
        },
    );
    it('queues removal behind an existing restart, including a late burned response after Off', async () => {
        const { target, inner } = controller();
        const p = await prepare(target, inner);
        Object.defineProperties(target, {
            videoElement: {
                value: document.createElement('video'),
                writable: true,
                configurable: true,
            },
            playbackManager: { value: {}, writable: true, configurable: true },
            restartQueue: { value: new RestartQueue(), writable: true, configurable: true },
            tryStartRestart: { value: () => false, writable: true, configurable: true },
        });
        let release!: (value: { data: PlaybackStartResponse; status: number; error: null }) => void;
        http.post.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const pending = inner.buildLumastraPlaybackUrl(p, 'remux');
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        playerStore.setSubtitleTrack(null);
        release({ data: burnInStart(), status: 201, error: null });
        await pending;
        expect(playerStore.currentSubtitleTrackIndex).toBeNull();
        expect(
            (target as unknown as { restartQueue: RestartQueue }).restartQueue.takePending(),
        ).toMatchObject({ kind: 'quality' });
    });
    it('does not treat a probe burn-in suggestion or a previous file delivery as an active overlay', async () => {
        const { target, inner } = controller();
        const p = await prepare(target, inner);
        p.activeVersion.tracks.subtitles[0].method = 'burn_in';
        p.activeVersion.tracks.subtitles[0].codec = 'pgs';
        playerStore.updateCurrentMediaSource(target.buildLumastraSource(p, MEDIA));
        expect(target.isClientRenderedSubtitle(7)).toBe(true);
        inner.applyPlaybackStart(burnInStart());
        playerStore.currentMediaSource = { ...playerStore.currentMediaSource!, id: OTHER };
        playerStore.setSubtitleTrack(null);
        const cleanup = subtitleEffects(target);
        try {
            expect(target.restartStreamWithNewQuality).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });
});

// Exercise the real native display methods. Only the browser's media substrate is
// modeled: mode transitions record which VTT resources the browser would fetch.
function nativeSubtitleController(): {
    target: PlayerController;
    video: HTMLVideoElement;
    fetched: string[];
} {
    const { target } = controller();
    const video = document.createElement('video');
    // happy-dom does not expose the browser's static ready-state constants.
    if (HTMLMediaElement.HAVE_METADATA !== 1)
        Object.defineProperty(HTMLMediaElement, 'HAVE_METADATA', { value: 1, configurable: true });
    const fetched: string[] = [];
    const append = video.appendChild.bind(video);
    vi.spyOn(video, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
        const element = node as unknown as HTMLTrackElement;
        let mode: TextTrackMode = 'disabled';
        const track = {
            label: element.label,
            cues: [{ text: 'A cue' }],
            activeCues: [],
            oncuechange: null,
            get mode() {
                return mode;
            },
            set mode(value: TextTrackMode) {
                if (mode === 'disabled' && value !== 'disabled') fetched.push(element.src);
                mode = value;
            },
        } as unknown as TextTrack;
        Object.defineProperty(element, 'track', { value: track });
        return append(node);
    });
    Object.defineProperty(video, 'textTracks', {
        configurable: true,
        get: () => Array.from(video.querySelectorAll('track'), (element) => element.track),
    });
    Object.defineProperty(video, 'readyState', {
        value: HTMLMediaElement.HAVE_METADATA,
        configurable: true,
    });
    Object.defineProperty(video, 'canPlayType', { value: () => 'probably' });
    for (const [key, value] of Object.entries({
        videoElement: video,
        nativeTrackToSubtitleIndex: new SvelteMap<TextTrack, number>(),
        pendingShowTimeouts: new SvelteSet<ReturnType<typeof setTimeout>>(),
        subtitleLoadGeneration: 0,
        subtitleLoadDeferredUntilMetadata: false,
        nativeSubtitleFailure: null,
        activeSrtCue: null,
        isIOS: false,
        isSafari: false,
        useSubtitleOverlay: false,
        effectiveSubtitleLineY: 85,
        isIOSNativeFullscreen: false,
        logSub: vi.fn(),
        isRestartingPlayback: true,
        playbackManager: null,
        playbackGeneration: 0,
    })) {
        Object.defineProperty(target, key, { value, writable: true, configurable: true });
    }
    vi.stubGlobal('requestAnimationFrame', (callback: (timestamp: number) => void) => {
        callback(0);
        return 1;
    });
    playerStore.currentMediaSource = {
        id: FILE,
        name: 'Test',
        path: '/test',
        container: 'mkv',
        size: 1,
        bitrate: 1,
        supportsDirectPlay: true,
        supportsDirectStream: true,
        supportsTranscoding: true,
        videoStreams: [],
        audioStreams: [],
        subtitleStreams: [7, 8, 9].map((index) => ({
            index,
            codec: 'subrip',
            language: 'eng',
            languageCode: 'eng',
            displayTitle: `English ${index}`,
            isDefault: false,
            isForced: false,
            isExternal: true,
            isTextSubtitleStream: true,
            supportsExternalStream: true,
            hrefs: { text: `/issued/${index}.vtt` },
        })),
    };
    playerStore.currentSubtitleTrackIndex = 8;
    return { target, video, fetched };
}
describe('real native subtitle lifecycle G1/G2', () => {
    it('fetches only the selected VTT, disables every unselected mode, and handles switch and Off', () => {
        const { target, video, fetched } = nativeSubtitleController();
        target.loadSubtitles();
        expect(Array.from(video.textTracks, (track) => track.mode)).toEqual([
            'disabled',
            'showing',
            'disabled',
        ]);
        expect(fetched).toHaveLength(1);
        expect(fetched[0]).toContain('/issued/8.vtt');
        playerStore.setSubtitleTrack(9);
        target.updateSubtitleDisplay();
        expect(Array.from(video.textTracks, (track) => track.mode)).toEqual([
            'disabled',
            'disabled',
            'showing',
        ]);
        expect(fetched).toHaveLength(2);
        expect(fetched[1]).toContain('/issued/9.vtt');
        playerStore.setSubtitleTrack(null);
        target.updateSubtitleDisplay();
        expect(Array.from(video.textTracks, (track) => track.mode)).toEqual([
            'disabled',
            'disabled',
            'disabled',
        ]);
        expect(fetched).toHaveLength(2);
        for (const timeout of target.pendingShowTimeouts) clearTimeout(timeout);
    });
    it('real controller wiring detaches before iOS src replacement and defers reattachment until metadata using the latest pick', async () => {
        const { target, video } = nativeSubtitleController();
        target.loadSubtitles();
        Object.defineProperty(target, 'isIOS', { value: true });
        Object.defineProperty(target, 'isSafari', { value: true });
        Object.defineProperty(navigator, 'userActivation', {
            configurable: true,
            value: { isActive: true },
        });
        let assigned = '';
        Object.defineProperty(video, 'src', {
            configurable: true,
            get: () => assigned,
            set: (value: string) => {
                expect(video.querySelectorAll('track')).toHaveLength(0);
                assigned = value;
            },
        });
        Object.defineProperty(video, 'readyState', { value: 0, configurable: true });
        vi.spyOn(video, 'load').mockImplementation(() => {});
        const manager = target.ensurePlaybackManager();
        try {
            await manager.load('/issued/replaced.m3u8', 'hls');
            expect(assigned).toContain('/issued/replaced.m3u8');
            expect(video.querySelectorAll('track')).toHaveLength(0);
            target.loadSubtitles();
            expect(video.querySelectorAll('track')).toHaveLength(0);
            playerStore.setSubtitleTrack(9);
            Object.defineProperty(video, 'readyState', {
                value: HTMLMediaElement.HAVE_METADATA,
                configurable: true,
            });
            target.onLoadedMetadata();
            expect(video.querySelectorAll('track')).toHaveLength(3);
            expect(Array.from(video.textTracks, (track) => track.mode)).toEqual([
                'disabled',
                'disabled',
                'showing',
            ]);
        } finally {
            manager.destroy(true);
            for (const timeout of target.pendingShowTimeouts) clearTimeout(timeout);
        }
    });
});

describe('audio start intent and native consumer boundaries R01/G02', () => {
    it.each(['explicit', 'heartbeat', 'recovery'])(
        'preserves the latest audio through a delayed %s start and sends it on the queued POST',
        async (kind) => {
            const { target, inner } = controller();
            const p = await prepare(target, inner);
            playerStore.currentAudioTrackIndex = 1;
            let failHeartbeat!: (value: unknown) => void;
            if (kind !== 'explicit') {
                await inner.buildLumastraPlaybackUrl(p, 'remux');
                Object.defineProperty(target, 'hasReportedRealPosition', { value: true });
                if (kind === 'heartbeat')
                    http.put.mockImplementationOnce(
                        () =>
                            new Promise((resolve) => {
                                failHeartbeat = resolve;
                            }),
                    );
                else http.put.mockResolvedValueOnce({ data: null, status: 410, error: 'Expired' });
            }
            let release!: (value: unknown) => void;
            http.post.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        release = resolve;
                    }),
            );
            const pending =
                kind !== 'explicit'
                    ? target.reportProgress('progress')
                    : inner.buildLumastraPlaybackUrl(p, 'remux');
            if (kind === 'heartbeat') {
                await vi.waitFor(() => expect(failHeartbeat).toBeTypeOf('function'));
                playerStore.setAudioTrack(1);
                playerStore.setAudioTrack(0);
                failHeartbeat({ data: null, status: 410, error: 'Expired' });
            }
            await vi.waitFor(() => expect(release).toBeTypeOf('function'));
            if (kind !== 'heartbeat') {
                playerStore.setAudioTrack(1);
                playerStore.setAudioTrack(0);
            }
            release({ data: started(), status: 201, error: null });
            await pending;
            expect(playerStore.currentAudioTrackIndex).toBe(0);
            expect(target.pendingAudioTrackIndex).toBe(0);
            // Run the real queued restart consumer and inspect its resulting wire body.
            const restart = vi
                .spyOn(target, 'restartStreamWithNewQuality')
                .mockImplementation(async () => {
                    await inner.buildLumastraPlaybackUrl(p, 'remux');
                });
            target.lastAudioTrackIndex = 1;
            target.consumePendingAudioSwitch();
            await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
            await vi.waitFor(() =>
                expect(
                    http.post.mock.calls.filter(([url]) => url === '/api/play-sessions').at(-1)![2],
                ).toMatchObject({ audioStreamIndex: 1 }),
            );
            await restart.mock.results[0].value;
        },
    );

    it('native metadata and delayed addtrack enable exactly the latest chosen audio despite reordered and partial renditions', async () => {
        const { target, inner } = controller();
        await prepare(target, inner);
        const video = document.createElement('video');
        const events = new EventTarget();
        const tracks = [{ language: 'eng', label: 'English', enabled: true }];
        Object.defineProperties(tracks, {
            addEventListener: { value: events.addEventListener.bind(events) },
            removeEventListener: { value: events.removeEventListener.bind(events) },
        });
        Object.defineProperty(video, 'audioTracks', { value: tracks });
        for (const [key, value] of Object.entries({
            videoElement: video,
            isSafari: true,
            isRestartingPlayback: false,
            hasResumedInitialPosition: true,
            watchTogetherCtrl: {
                setMediaDuration: vi.fn(),
                beginSourceReplacement: vi.fn(),
                finishSourceReplacement: vi.fn(),
            },
        }))
            Object.defineProperty(target, key, { value, writable: true, configurable: true });
        playerStore.currentAudioTrackIndex = 0; // German not yet exposed.
        target.onLoadedMetadata();
        expect(tracks[0].enabled).toBe(true); // Do not call an English rendition German.
        playerStore.setAudioTrack(1);
        tracks.push({ language: 'deu', label: 'German', enabled: true });
        events.dispatchEvent(new Event('addtrack'));
        expect(tracks.map((track) => track.enabled)).toEqual([true, false]);
        playerStore.setAudioTrack(0);
        Object.defineProperty(target, 'progressReporter', { value: null, writable: true });
        target.handleAudioTrackChange(0);
        expect(tracks.map((track) => track.enabled)).toEqual([false, true]);
        playerStore.currentMediaSource!.audioStreams = [
            {
                ...playerStore.currentMediaSource!.audioStreams[0],
                index: 0,
                language: 'eng',
                title: 'Main mix',
            },
            {
                ...playerStore.currentMediaSource!.audioStreams[1],
                index: 1,
                language: 'eng',
                title: 'Director Commentary',
            },
        ];
        tracks[0].label = 'Director Commentary';
        tracks[1].label = 'Main mix';
        tracks[1].language = 'eng';
        target.applyDirectPlayAudioTrack(1);
        expect(tracks.map((track) => track.enabled)).toEqual([true, false]);
    });
});

it('maps appended native subtitle TextTrack identity when in-band tracks precede it R13', () => {
    const { target, video } = nativeSubtitleController();
    const inBand = {
        mode: 'showing',
        label: 'In band',
        cues: [],
        oncuechange: null,
    } as unknown as TextTrack;
    Object.defineProperty(video, 'textTracks', {
        configurable: true,
        get: () => [
            inBand,
            ...Array.from(video.querySelectorAll('track'), (element) => element.track),
        ],
    });
    target.loadSubtitles();
    expect(Array.from(video.textTracks, (track) => track.mode)).toEqual([
        'disabled',
        'disabled',
        'showing',
        'disabled',
    ]);
    playerStore.setSubtitleTrack(9);
    target.updateSubtitleDisplay();
    expect(Array.from(video.textTracks, (track) => track.mode)).toEqual([
        'disabled',
        'disabled',
        'disabled',
        'showing',
    ]);
    for (const timeout of target.pendingShowTimeouts) clearTimeout(timeout);
});

describe('browser subtitle selection after startup', () => {
    function observe(
        target: PlayerController,
        video: HTMLVideoElement,
    ): {
        events: EventTarget;
        stop: () => void;
    } {
        const events = new EventTarget();
        const tracks = Array.from(video.textTracks);
        const list = Object.assign(events, tracks, { length: tracks.length });
        Object.defineProperty(video, 'textTracks', { configurable: true, value: list });
        return { events, stop: target.observeNativeSubtitleSelection(video) };
    }

    it('disables a caption added after the initial Off selection, without a manual toggle', () => {
        const { target, video } = nativeSubtitleController();
        playerStore.setSubtitleTrack(null);
        target.loadSubtitles();
        const { events, stop } = observe(target, video);
        const late = { mode: 'showing', oncuechange: null } as unknown as TextTrack;
        Object.assign(video.textTracks, { 3: late, length: 4 });
        events.dispatchEvent(new Event('addtrack'));
        expect(late.mode).toBe('disabled');
        const sidecar = video.textTracks[0];
        sidecar.mode = 'showing'; // Safari's caption preference settles later.
        events.dispatchEvent(new Event('change'));
        expect(sidecar.mode).toBe('disabled');
        expect(playerStore.currentSubtitleTrackIndex).toBeNull();
        stop();
    });

    it('leaves the iOS native fullscreen caption menu in control until exit', () => {
        const { target, video } = nativeSubtitleController();
        playerStore.setSubtitleTrack(null);
        target.loadSubtitles();
        Object.defineProperty(target, 'isIOSNativeFullscreen', { value: true, writable: true });
        const { events, stop } = observe(target, video);
        const track = video.textTracks[0];
        track.mode = 'showing';
        events.dispatchEvent(new Event('change'));
        expect(track.mode).toBe('showing');
        target.isIOSNativeFullscreen = false;
        target.updateSubtitleDisplay();
        expect(track.mode).toBe('disabled');
        stop();
    });

    it('restores Safari overlay ownership when the browser auto-shows the selected track', () => {
        const { target, video } = nativeSubtitleController();
        Object.defineProperty(target, 'useSubtitleOverlay', { value: true });
        target.loadSubtitles();
        const { events, stop } = observe(target, video);
        const selected = video.textTracks[1];
        Object.defineProperty(selected, 'activeCues', {
            value: [{ text: 'Styled caption' }],
        });
        selected.mode = 'showing';
        events.dispatchEvent(new Event('change'));
        expect(selected.mode).toBe('hidden');
        expect(target.activeSrtCue).toBe('Styled caption');
        expect(target.effectiveSubtitleLineY).toBe(85);
        // Our own mode change emits another event; it must settle without
        // fetching other tracks or handing rendering back to Safari.
        events.dispatchEvent(new Event('change'));
        expect(selected.mode).toBe('hidden');
        playerStore.setSubtitleTrack(null);
        target.updateSubtitleDisplay();
        expect(target.activeSrtCue).toBeNull();
        expect(selected.mode).toBe('disabled');
        stop();
        selected.mode = 'showing';
        events.dispatchEvent(new Event('change'));
        expect(selected.mode).toBe('showing'); // Listener removed at teardown.
    });
});

it('implicit session recovery rotates native subtitle resources without an extra video reload R08', async () => {
    const { target, inner } = controller();
    const p = await prepare(target, inner);
    const native = nativeSubtitleController();
    Object.defineProperty(target, 'videoElement', {
        value: native.video,
        writable: true,
        configurable: true,
    });
    for (const key of [
        'nativeTrackToSubtitleIndex',
        'pendingShowTimeouts',
        'subtitleLoadGeneration',
        'subtitleLoadDeferredUntilMetadata',
        'activeSrtCue',
        'logSub',
        'useSubtitleOverlay',
        'effectiveSubtitleLineY',
    ])
        Object.defineProperty(target, key, {
            value: native.target[key as keyof PlayerController],
            writable: true,
            configurable: true,
        });
    // Restore this controller's real source after the DOM fixture prepared its own list.
    playerStore.updateCurrentMediaSource(target.buildLumastraSource(p, MEDIA));
    playerStore.currentSubtitleTrackIndex = 8;
    await target.setupSubtitleAndProgressReporter();
    reporters.push(target.progressReporter as PlaySessionReporter);
    await inner.buildLumastraPlaybackUrl(p, 'remux');
    target.loadSubtitles();
    const old = native.video.querySelectorAll('track')[1];
    const initial = old.getAttribute('src');
    const replacement = structuredClone(started());
    if (!('subtitles' in replacement.delivery)) throw new Error('file delivery required');
    for (const sub of replacement.delivery.subtitles ?? [])
        if (sub.hrefs.text) sub.hrefs.text += '&recovered=1';
    http.post.mockResolvedValueOnce({ data: replacement, status: 201, error: null });
    http.put.mockResolvedValueOnce({ data: null, status: 410, error: 'Expired' });
    Object.defineProperty(target, 'hasReportedRealPosition', { value: true });
    await target.reportProgress('progress');
    const refreshed = native.video.querySelectorAll('track')[1];
    expect(refreshed).not.toBe(old);
    expect(refreshed.getAttribute('src')).not.toBe(initial);
    expect(refreshed.getAttribute('src')).toContain('recovered=1');
    playerStore.setSubtitleTrack(8);
    target.updateSubtitleDisplay();
    expect(native.fetched.at(-1)).toContain('recovered=1');
    expect(target.initializeHls).toHaveBeenCalledOnce(); // The recovery itself still reloads video.
    const refresh = target as unknown as {
        handlePlaybackDelivery(start: PlaybackStartResponse): void;
    };
    refresh.handlePlaybackDelivery(replacement);
    expect(native.video.querySelectorAll('track')[1]).toBe(refreshed);
    expect(target.initializeHls).toHaveBeenCalledOnce();
    for (const timeout of target.pendingShowTimeouts) clearTimeout(timeout);
});

it('preserves intentional same-language native editions and waits for a missing partial-list edition', async () => {
    const { target, inner } = controller();
    await prepare(target, inner);
    playerStore.currentMediaSource!.audioStreams = [
        {
            index: 0,
            language: 'eng',
            title: 'Stereo',
            displayTitle: 'English Stereo',
            channels: 2,
            codec: 'aac',
            isDefault: true,
        },
        {
            index: 1,
            language: 'eng',
            title: 'Surround',
            displayTitle: 'English Surround',
            channels: 6,
            codec: 'aac',
            isDefault: false,
        },
    ];
    const video = document.createElement('video');
    const tracks = [{ language: 'eng', label: 'Stereo', enabled: true }];
    Object.defineProperty(video, 'audioTracks', { value: tracks });
    Object.defineProperty(target, 'videoElement', { value: video, writable: true });
    expect(target.applyDirectPlayAudioTrack(1)).toBe(false);
    tracks.unshift({ language: 'eng', label: 'Surround', enabled: false });
    expect(target.applyDirectPlayAudioTrack(1)).toBe(true);
    expect(tracks.map((track) => track.enabled)).toEqual([true, false]);
});

it('retains inference on unchanged applied audio but invalidates it when server application changes identity R11', async () => {
    const { target, inner } = controller();
    await prepare(target, inner);
    playerStore.currentAudioTrackIndex = 1;
    playerStore.audioSelectionLanguage = 'en';
    playerStore.audioSelectionReason = 'explicit-default-untagged';
    inner.applyPlaybackStart(started());
    expect(playerStore.audioSelectionLanguage).toBe('en');
    expect(playerStore.audioSelectionReason).toBe('explicit-default-untagged');
    const changed = structuredClone(started());
    if (!('applied' in changed.delivery) || !changed.delivery.applied)
        throw new Error('Applied file delivery required');
    changed.delivery.applied.audioStreamIndex = 1;
    inner.applyPlaybackStart(changed);
    expect(playerStore.currentAudioTrackIndex).toBe(0);
    expect(playerStore.audioSelectionLanguage).toBeNull();
    expect(playerStore.audioSelectionReason).toBeNull();
});

it('an unsupported bitmap sidecar is excluded by the real probe adapter and cannot prevent start R09', async () => {
    const { target, inner } = controller();
    const p = await prepare(target, inner);
    const unsupported = p.activeVersion.tracks.subtitles[2];
    unsupported.codec = 'pgs';
    unsupported.format = 'bitmap';
    unsupported.method = 'none';
    p.activeVersion.tracks.subtitles = [unsupported];
    playerStore.updateCurrentMediaSource(target.buildLumastraSource(p, MEDIA));
    playerStore.applyTrackRecommendation({
        audio_track_index: 1,
        subtitle_track_index: unsupported.index,
        reason: { audio: 'file-default', subtitle: 'saved-language' },
    });
    expect(playerStore.currentSubtitleTrackIndex).toBeNull();
    expect(playerStore.subtitleTracks).toHaveLength(0);
    playerStore.setSubtitleTrack(unsupported.index);
    await inner.buildLumastraPlaybackUrl(p, 'remux');
    expect(
        http.post.mock.calls.filter(([url]) => url === '/api/play-sessions').at(-1)![2],
    ).toMatchObject({ subtitleId: 'none' });
});

it('a current post-loaded renderer failure enters the explicit-retry state, and stale manager failures do not', async () => {
    const { target, inner } = controller();
    await prepare(target, inner);
    Object.defineProperty(target, 'subtitleInitializationFailure', { value: null, writable: true });
    const module = await import('./subtitle-renderer');
    await target.setupSubtitleAndProgressReporter();
    reporters.push(target.progressReporter as PlaySessionReporter);
    const config = vi.mocked(module.createSubtitleRendererManager).mock.calls.at(-1)![0]!;
    playerStore.currentSubtitleTrackIndex = 7;
    config.onRendererError!(7);
    expect(
        (target as unknown as { subtitleInitializationFailure: unknown })
            .subtitleInitializationFailure,
    ).toMatchObject({ index: 7, sourceId: FILE, revision: playerStore.subtitleSelectionRevision });
    (
        target as unknown as { subtitleInitializationFailure: unknown }
    ).subtitleInitializationFailure = null;
    target.subtitleRenderer = null;
    playerStore.currentSubtitleTrackIndex = 7;
    config.onRendererError!(7);
    expect(
        (target as unknown as { subtitleInitializationFailure: unknown })
            .subtitleInitializationFailure,
    ).toBeNull();
});

it('real first-play bootstrap drains audio picked during the initial POST into the next POST', async () => {
    const { target, inner } = controller();
    const p = await prepare(target, inner);
    playerStore.currentAudioTrackIndex = 1;
    let release!: (value: unknown) => void;
    http.post.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    );
    const initial = inner.buildLumastraPlaybackUrl(p, 'remux');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    playerStore.setAudioTrack(0);
    release({ data: started(), status: 201, error: null });
    await initial;
    for (const [key, value] of Object.entries({
        isInitialized: false,
        isRestartingPlayback: false,
        resetEngagementTracking: vi.fn(),
        startEngagementTicker: vi.fn(),
        buildQualityRestartKey: () => '',
        abrCtrl: { onPlaybackStart: vi.fn() },
    }))
        Object.defineProperty(target, key, { value, writable: true, configurable: true });
    vi.spyOn(playerStore, 'startProgressReporting').mockImplementation(() => {});
    const restart = vi.spyOn(target, 'restartStreamWithNewQuality').mockImplementation(async () => {
        await inner.buildLumastraPlaybackUrl(p, 'remux');
    });
    (target as unknown as { bootstrapFirstPlay(): void }).bootstrapFirstPlay();
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
    await restart.mock.results[0].value;
    expect(
        http.post.mock.calls
            .filter(([url]) => url === '/api/play-sessions')
            .map(([, , body]) => body.audioStreamIndex),
    ).toEqual([4, 1]);
});

it('native text errors support explicit same-track retry and ignore detached element callbacks', () => {
    const { target, video } = nativeSubtitleController();
    const cleanup = subtitleEffects(target);
    Object.defineProperty(target, 'videoElement', {
        value: video,
        writable: true,
        configurable: true,
    });
    Object.defineProperty(target, 'updateSubtitleDisplay', {
        value: PlayerController.prototype.updateSubtitleDisplay,
        configurable: true,
    });
    try {
        target.loadSubtitles();
        const failed = video.querySelectorAll('track')[1];
        failed.dispatchEvent(new Event('error'));
        flushSync();
        expect(video.querySelectorAll('track')[1]).toBe(failed);
        playerStore.setSubtitleTrack(8);
        flushSync();
        const retried = video.querySelectorAll('track')[1];
        expect(retried).not.toBe(failed);
        expect(retried.getAttribute('src')).toBe(failed.getAttribute('src'));
        retried.dispatchEvent(new Event('error'));
        retried.dispatchEvent(new Event('load'));
        failed.dispatchEvent(new Event('error'));
        expect(
            (target as unknown as { nativeSubtitleFailure: unknown }).nativeSubtitleFailure,
        ).toBeNull();
        expect(target.restartStreamWithNewQuality).not.toHaveBeenCalled();
    } finally {
        cleanup();
        for (const timer of target.pendingShowTimeouts) clearTimeout(timer);
    }
});

it.each(['', 'English'])(
    'native audio ranks exact qualified tags and treats %s as unknown role metadata',
    async (label) => {
        const { target, inner } = controller();
        await prepare(target, inner);
        const source = playerStore.currentMediaSource!;
        source.audioStreams = [
            {
                index: 0,
                language: 'en-US',
                displayTitle: 'English US',
                codec: 'aac',
                channels: 2,
                isDefault: true,
            },
            {
                index: 1,
                language: 'en',
                displayTitle: 'English',
                codec: 'aac',
                channels: 2,
                isDefault: false,
            },
        ];
        const video = document.createElement('video');
        const tracks = [
            { language: 'en', label: 'English', enabled: true },
            { language: 'en-US', label: 'English', enabled: false },
        ];
        Object.defineProperty(video, 'audioTracks', { value: tracks });
        Object.defineProperty(target, 'videoElement', { value: video, writable: true });
        expect(target.applyDirectPlayAudioTrack(0)).toBe(true);
        expect(tracks.map((track) => track.enabled)).toEqual([false, true]);
        source.audioStreams = source.audioStreams.map((track, i) => ({
            ...track,
            language: 'en',
            title: i === 0 ? label || 'Main' : 'Audio Description',
        }));
        tracks.splice(1);
        tracks[0].label = label;
        expect(target.applyDirectPlayAudioTrack(0)).toBe(false);
        expect(target.applyDirectPlayAudioTrack(1)).toBe(false);
        tracks.push({ language: 'en', label, enabled: false });
        expect(target.applyDirectPlayAudioTrack(1)).toBe(true);
        expect(tracks.map((track) => track.enabled)).toEqual([false, true]);
    },
);

it('reapplies direct-file audio during restart metadata and renews the expired delayed-addtrack listener', async () => {
    vi.useFakeTimers();
    try {
        const { target, inner } = controller();
        await prepare(target, inner);
        playerStore.setPlayMethod('DirectPlay');
        const video = document.createElement('video');
        const events = new EventTarget();
        const tracks = [
            { language: 'de', label: 'German', enabled: true },
            { language: 'en', label: 'English', enabled: false },
        ];
        const remove = vi.fn(events.removeEventListener.bind(events));
        Object.defineProperties(tracks, {
            addEventListener: { value: events.addEventListener.bind(events) },
            removeEventListener: { value: remove },
        });
        Object.defineProperty(video, 'audioTracks', { value: tracks });
        for (const [key, value] of Object.entries({
            videoElement: video,
            isSafari: false,
            isRestartingPlayback: false,
            hasResumedInitialPosition: true,
            watchTogetherCtrl: {
                setMediaDuration: vi.fn(),
                beginSourceReplacement: vi.fn(),
                finishSourceReplacement: vi.fn(),
            },
        }))
            Object.defineProperty(target, key, { value, writable: true, configurable: true });
        playerStore.setAudioTrack(0);
        target.onLoadedMetadata();
        await vi.advanceTimersByTimeAsync(5001);
        expect(remove).toHaveBeenCalledOnce();
        playerStore.setAudioTrack(1);
        Object.defineProperty(target, 'isRestartingPlayback', { value: true, writable: true });
        target.onLoadedMetadata();
        expect(tracks.map((track) => track.enabled)).toEqual([false, true]);
        // Another direct-file load initially exposes only the file default.
        tracks.splice(1);
        tracks[0].enabled = true;
        target.onLoadedMetadata();
        tracks.push({ language: 'en', label: 'English', enabled: false });
        events.dispatchEvent(new Event('addtrack'));
        expect(tracks.map((track) => track.enabled)).toEqual([false, true]);
    } finally {
        vi.useRealTimers();
    }
});

it('the real caption shortcut restores a nonfirst edition and resolves saved preferences after a file change without persisting the toggle', () => {
    const { target } = nativeSubtitleController();
    const noop = vi.fn();
    const callbacks: KeyboardCallbacks = {
        onTogglePlayPause: noop,
        onSeek: noop,
        onSeekToPercent: noop,
        onStartAcceleratingSeek: noop,
        onStopAcceleratingSeek: noop,
        onAdjustVolume: noop,
        onToggleMute: noop,
        onShowVolumeIndicator: noop,
        onToggleSubtitles: () => target.toggleSubtitles(),
        onToggleFullscreen: noop,
        onCloseAllOverlays: () => false,
        onBack: noop,
        onAdjustSpeed: noop,
        onStepFrame: noop,
        onSkipSegment: noop,
        onGoToNextItem: noop,
        onShowSeekPercentIndicator: noop,
        onShowWatchPartyBackConfirm: noop,
        onCancelAutoSkip: noop,
    };
    const shortcuts = new VideoShortcuts(callbacks);
    const press = () =>
        shortcuts.handleKeydown(new KeyboardEvent('keydown', { key: 'c' }), {
            isFullscreen: false,
            isWatchPartyGuest: false,
            overlayHasActiveAutoSkip: false,
            isActiveWatchPartyHost: false,
            activeSegment: null,
            effectiveNextItem: null,
            showNextItemPrompt: false,
        });
    updatePreferences({ subtitleLanguage: 'en', subtitlesEnabled: true, subtitleTrackHint: null });
    playerStore.setSubtitleTrack(8);
    const saved = getPreferences();
    press();
    expect(playerStore.currentSubtitleTrackIndex).toBeNull();
    press();
    expect(playerStore.currentSubtitleTrackIndex).toBe(8);
    press();
    const previous = playerStore.currentMediaSource!;
    playerStore.currentMediaSource = {
        ...previous,
        id: OTHER,
        subtitleStreams: [
            {
                ...previous.subtitleStreams[0],
                index: 8,
                id: 'other-de',
                language: 'de',
                languageCode: 'de',
                isForced: false,
            },
            {
                ...previous.subtitleStreams[1],
                index: 9,
                id: 'other-en',
                language: 'en',
                languageCode: 'en',
                isForced: false,
            },
        ],
    };
    press();
    expect(playerStore.currentSubtitleTrackIndex).toBe(9);
    expect(getPreferences()).toEqual(saved);
});

it.each(['after-failure', 'while-pending', 'newer-different'] as const)(
    'retries a real failed audio probe for %s and applies only the latest native audio',
    async (kind) => {
        const { target, inner } = controller();
        const p = await prepare(target, inner);
        await inner.buildLumastraPlaybackUrl(p, 'remux');
        const cleanup = subtitleEffects(target);
        const video = document.createElement('video');
        const tracks = [
            { language: 'de', label: 'German', enabled: false },
            { language: 'en', label: 'English', enabled: true },
        ];
        Object.defineProperties(tracks, {
            addEventListener: { value: vi.fn() },
            removeEventListener: { value: vi.fn() },
        });
        Object.defineProperty(video, 'audioTracks', { value: tracks });
        for (const [key, value] of Object.entries({
            videoElement: video,
            isSafari: true,
            playbackManager: { getAudioTracks: () => [] },
            restartQueue: new RestartQueue(),
            restartStreamWithNewQuality: PlayerController.prototype.restartStreamWithNewQuality,
            reportProgress: PlayerController.prototype.reportProgress,
            tryStartRestart: PlayerController.prototype.tryStartRestart,
            finishRestart: PlayerController.prototype.finishRestart,
            readRestartResume: () => ({ position: 0, play: false }),
            syncWakeLockForQualityMode: vi.fn(),
            holdRestartUntilPlayable: () => target.finishRestart(),
            refreshTimeline: vi.fn(),
            setLumastraHdrInfo: vi.fn(),
            hasResumedInitialPosition: true,
            watchTogetherCtrl: {
                setMediaDuration: vi.fn(),
                beginSourceReplacement: vi.fn(),
                finishSourceReplacement: vi.fn(),
            },
        }))
            Object.defineProperty(target, key, { value, writable: true, configurable: true });
        const startsBefore = http.post.mock.calls.filter(
            ([url]) => url === '/api/play-sessions',
        ).length;
        // Vitest returns the next one-shot implementation from getMockImplementation;
        // capture the normal I/O implementation before queueing the deferred probe.
        const ordinaryPost = http.post.getMockImplementation()!;
        let fail!: (value: unknown) => void;
        http.post.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    fail = resolve;
                }),
        );
        http.post.mockImplementation(async (url, schema, body) => {
            const result = await ordinaryPost(url, schema, body);
            if (url === '/api/play-sessions')
                result.data.delivery.applied.audioStreamIndex = body.audioStreamIndex;
            return result;
        });
        try {
            playerStore.setAudioTrack(0);
            flushSync();
            await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
            if (kind !== 'after-failure') {
                playerStore.setAudioTrack(kind === 'newer-different' ? 1 : 0);
                flushSync();
            }
            fail({ data: null, status: 503, error: 'Unavailable' });
            if (kind === 'after-failure') {
                await vi.waitFor(() => expect(target.failedAudioSwitch?.index).toBe(0));
                expect(tracks.map((track) => track.enabled)).toEqual([false, true]);
                playerStore.setAudioTrack(0);
                flushSync();
            }
            const absolute = kind === 'newer-different' ? 4 : 1;
            await vi.waitFor(() =>
                expect(
                    http.post.mock.calls
                        .filter(([url]) => url === '/api/play-sessions')
                        .at(-1)?.[2],
                ).toMatchObject({ audioStreamIndex: absolute }),
            );
            await vi.waitFor(() =>
                expect(
                    http.post.mock.calls.filter(([url]) => url === '/api/play-sessions'),
                ).toHaveLength(startsBefore + 1),
            );
            await vi.waitFor(() => expect(target.audioSwitchInFlight).toBe(false));
            target.onLoadedMetadata();
            expect(playerStore.currentAudioTrackIndex).toBe(kind === 'newer-different' ? 1 : 0);
            expect(tracks.map((track) => track.enabled)).toEqual(
                kind === 'newer-different' ? [false, true] : [true, false],
            );
            expect(target.failedAudioSwitch).toBeNull();
        } finally {
            cleanup();
        }
    },
);

it.each([0, 120])(
    'initial metadata uses party position %s instead of saved progress',
    (position) => {
        const { target } = controller();
        const video = document.createElement('video');
        video.currentTime = 90;
        const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
        vi.spyOn(watchTogether, 'getSessionState').mockReturnValue({
            currentTime: position,
            isPlaying: false,
        });
        vi.spyOn(target, 'mightBeInWatchParty').mockReturnValue(true);
        for (const [key, value] of Object.entries({
            videoElement: video,
            isRestartingPlayback: false,
            hasResumedInitialPosition: false,
            lumastraPlayMethod: 'direct',
            props: {
                mediaDbId: MEDIA,
                playbackInfo: {
                    itemId: MEDIA,
                    mediaSources: [],
                    userData: { playbackPositionTicks: 900000000 },
                },
            },
            watchTogetherCtrl: {
                setMediaDuration: vi.fn(),
                beginSourceReplacement: vi.fn(),
                finishSourceReplacement: vi.fn(),
            },
        }))
            Object.defineProperty(target, key, { value, writable: true, configurable: true });
        target.onLoadedMetadata();
        expect(target.setVideoTime).toHaveBeenCalledWith(position, 'watch_party_sync');
        expect(target.setVideoTime).not.toHaveBeenCalledWith(90, 'resume_initial');
        expect(pause).toHaveBeenCalled();
    },
);

it.each([0, 120])(
    'real HLS controller startup follows rejoined party %s and preserves later quality position',
    async (position) => {
        const { target, video } = nativeSubtitleController();
        Object.defineProperty(target, 'isSafari', { value: true });
        Object.defineProperty(target, 'streamBitrateMeter', { value: { reset: vi.fn() } });
        vi.spyOn(video, 'load').mockImplementation(() => {});
        vi.spyOn(video, 'pause').mockImplementation(() => {});
        const oldSession = watchTogether.session;
        watchTogether.session = null;
        const manager = target.ensurePlaybackManager();
        try {
            await PlayerController.prototype.initializeHls.call(
                target,
                '/issued/start.m3u8',
                181,
                true,
            );
            Object.assign(watchTogether, {
                session: { itemId: MEDIA, currentTime: position, isPlaying: false },
            });
            video.currentTime = 181;
            video.dispatchEvent(new Event('loadedmetadata'));
            expect(video.currentTime).toBe(position);
            video.currentTime = 240;
            await PlayerController.prototype.initializeHls.call(
                target,
                '/issued/quality.m3u8',
                240,
            );
            video.dispatchEvent(new Event('loadedmetadata'));
            expect(video.currentTime).toBe(240);
        } finally {
            watchTogether.session = oldSession;
            manager.destroy(true);
        }
    },
);

describe('review fixes: reported-session restore and superseded preparation', () => {
    it('does not queue a third restart when the restart lock is held and the reporter restarts the session', async () => {
        const { target, inner } = controller();
        const queueQuality = vi.spyOn(
            (target as unknown as { restartQueue: RestartQueue }).restartQueue,
            'queueQuality',
        );
        Object.defineProperty(target, 'tryStartRestart', { value: () => false, writable: true });
        Object.defineProperty(target, 'videoElement', {
            value: document.createElement('video'),
            writable: true,
        });
        Object.defineProperty(target, 'restartStreamWithNewQuality', {
            value: vi.fn(),
            writable: true,
        });
        inner.playbackStart = {
            delivery: { kind: 'hls', url: '/issued/hls' },
        } as unknown as PlaybackStartResponse;
        await (
            target as unknown as { restoreReportedSession(): Promise<void> }
        ).restoreReportedSession();
        expect(queueQuality).not.toHaveBeenCalled();
        expect(target.restartStreamWithNewQuality).not.toHaveBeenCalled();
        expect(
            (target as unknown as { initializeHls: ReturnType<typeof vi.fn> }).initializeHls,
        ).not.toHaveBeenCalled();
    });

    it('a preparation superseded during the HLS fallback does not set a playback error', async () => {
        const { target, inner } = controller();
        await prepare(target, inner);
        Object.defineProperty(target, 'videoElement', {
            value: document.createElement('video'),
            writable: true,
        });
        vi.spyOn(
            target as unknown as { playbackCapabilities(): Promise<undefined> },
            'playbackCapabilities',
        ).mockImplementation(async () => {
            (target as unknown as { playbackGeneration: number }).playbackGeneration++;
            return undefined;
        });
        const setError = vi.spyOn(playerStore, 'setError');
        await target.fallbackToHlsTranscoding('test');
        expect(setError).not.toHaveBeenCalled();
        setError.mockRestore();
    });

    it('does not swallow other fallback failures, and handlePlayError ignores only the superseded error', async () => {
        const { target } = controller();
        const setError = vi.spyOn(playerStore, 'setError');
        target.handlePlayError(new PlaybackSupersededError());
        expect(setError).not.toHaveBeenCalled();
        target.handlePlayError(new Error('boom'));
        expect(setError).toHaveBeenCalledWith('Playback error: boom');
        setError.mockRestore();
    });
});
