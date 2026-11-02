// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WakeLockController, type WakeLockControllerDeps } from './wake-lock.controller';
import { requestWakeLock, setupWakeLockReacquisition } from '$lib/utils/wake-lock';
import { setupBackgroundPlayback } from '$lib/utils/background-playback';
import { playerStore } from './playerStore.svelte';

vi.mock('$lib/utils/wake-lock', () => ({
    requestWakeLock: vi.fn(),
    setupWakeLockReacquisition: vi.fn(() => () => {}),
    destroyWakeLock: vi.fn(),
}));

vi.mock('$lib/utils/background-playback', () => ({
    setupBackgroundPlayback: vi.fn(() => () => {}),
}));

describe('WakeLockController', () => {
    const baseDeps: WakeLockControllerDeps = {
        getVideoElement: () => undefined,
        isInitialized: () => false,
        reportProgress: vi.fn(),
        initializeHls: vi.fn(),
        log: vi.fn(),
        isAudioOnly: () => false,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        playerStore.isPlaying = true;
    });

    it('does not reacquire on visibility change in audio-only mode', () => {
        new WakeLockController({ ...baseDeps, isAudioOnly: () => true }).setup();

        const shouldBeActive = vi.mocked(setupWakeLockReacquisition).mock.calls[0]?.[0];
        expect(shouldBeActive?.()).toBe(false);
    });

    it('still reacquires on visibility change for video', () => {
        new WakeLockController({ ...baseDeps, isAudioOnly: () => false }).setup();

        const shouldBeActive = vi.mocked(setupWakeLockReacquisition).mock.calls[0]?.[0];
        expect(shouldBeActive?.()).toBe(true);
    });

    it('does not request a wake lock on background resume in audio-only mode', () => {
        new WakeLockController({ ...baseDeps, isAudioOnly: () => true }).setup();

        const config = vi.mocked(setupBackgroundPlayback).mock.calls[0]?.[0];
        config?.onResume(5000);

        expect(requestWakeLock).not.toHaveBeenCalled();
    });

    it('still requests a wake lock on background resume for video', () => {
        new WakeLockController({ ...baseDeps, isAudioOnly: () => false }).setup();

        const config = vi.mocked(setupBackgroundPlayback).mock.calls[0]?.[0];
        config?.onResume(5000);

        expect(requestWakeLock).toHaveBeenCalled();
    });
});
