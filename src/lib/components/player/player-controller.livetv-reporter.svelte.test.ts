// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const startPlaySession = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/playback.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/api/playback.js')>()),
    startPlaySession,
}));
vi.mock('$lib/stores/server-capabilities.store', () => ({
    serverCapabilities: { fetch: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('./subtitle-renderer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./subtitle-renderer')>()),
    createSubtitleRendererManager: vi.fn(() => ({ destroy: vi.fn() })),
}));

import { PlayerController } from './player-controller.svelte';
import { PlaySessionReporter } from './play-session-reporter';

interface ReporterSetup {
    setupSubtitleAndProgressReporter(): Promise<void>;
    progressReporter: unknown;
}

function controllerFor(isLive: boolean): ReporterSetup {
    const target = Object.create(PlayerController.prototype);
    const properties = {
        playbackGeneration: 0,
        DEBUG: false,
        log: vi.fn(),
        progressReporter: null,
        props: {
            mediaDbId: isLive ? 'station-1' : 'movie-1',
            playbackInfo: { isLive, itemId: 'item-1', internalId: 'item-1', mediaSources: [] },
        },
    };
    for (const [key, value] of Object.entries(properties))
        Object.defineProperty(target, key, { value, writable: true, configurable: true });
    return target as ReporterSetup;
}

describe('web Live TV playback never uses the VOD play-session start', () => {
    beforeEach(() => startPlaySession.mockReset());

    it('builds no play-session reporter for a live channel', async () => {
        const controller = controllerFor(true);
        await controller.setupSubtitleAndProgressReporter().catch(() => undefined);
        expect(controller.progressReporter).not.toBeInstanceOf(PlaySessionReporter);
        expect(startPlaySession).not.toHaveBeenCalled();
    });

    it('still builds the reporter for on-demand video', async () => {
        const controller = controllerFor(false);
        await controller.setupSubtitleAndProgressReporter().catch(() => undefined);
        expect(controller.progressReporter).toBeInstanceOf(PlaySessionReporter);
    });
});

it.each([false, true])('web start omits audio selection when silent=%s', async (silent) => {
    const controller = Object.create(PlayerController.prototype) as PlayerController;
    Object.defineProperty(controller, 'warn', { value: vi.fn() });
    const indices = controller.getValidatedStreamIndices({
        currentAudioTrackIndex: 0,
        currentSubtitleTrackIndex: null,
        currentMediaSource: {
            audioStreams: silent ? [] : [{ index: 0, absoluteIndex: 3 }],
            subtitleStreams: [],
        },
    } as unknown as Parameters<PlayerController['getValidatedStreamIndices']>[0]);
    expect(indices.audioStreamIndexAbsolute).toBe(silent ? null : 3);
    // Exercise the real reporter too: null must disappear from the public request.
    startPlaySession.mockResolvedValue({ status: 422, error: 'test refusal', data: null });
    const reporter = new PlaySessionReporter({ mediaId: 'movie-1', deviceId: 'web' });
    await reporter.report('start', {
        itemId: 'movie-1',
        mediaSourceId: 'source',
        currentTime: 0,
        isPaused: false,
        isMuted: false,
        volume: 1,
        playMethod: 'direct',
        playSessionId: 'session',
        audioStreamIndex: indices.audioStreamIndexAbsolute,
        subtitleStreamIndex: null,
    });
    expect(startPlaySession.mock.calls.at(-1)?.[0].audioStreamIndex).toBe(silent ? undefined : 3);
    reporter.cleanup();
});
