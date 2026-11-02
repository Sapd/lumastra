// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, screen } from '@testing-library/svelte';
import type { Writable } from 'svelte/store';
import type { TrackAudioFeatures } from '$lib/schemas/api-music-dto';
import { musicPlayerStore } from '$lib/stores/music-player.store';
import { tick } from 'svelte';
import PlayheadBeatPulse from './PlayheadBeatPulse.svelte';
import CrossfadeSeekbarFx from './CrossfadeSeekbarFx.svelte';
import CrossfadeSettings from './CrossfadeSettings.svelte';

const initial = vi.hoisted(() => ({
    alwaysShowBeatPulse: false,
    isPlaying: true,
    isLoadingTrack: false,
    isCrossfading: false,
    crossfadeProgress: 0.5,
    crossfadeTotalBeats: 8,
    crossfadeCurrentBeat: 1,
    progress: 0.5,
    crossfadeEnabled: false,
    queue: [],
    currentTimeMs: 1000,
    currentTrack: {
        id: 'a',
        audioFeatures: { beatGrid: [0, 1, 2], bpm: 120 } satisfies TrackAudioFeatures,
    },
}));
vi.mock('$lib/stores/music-player.store', async () => {
    const { writable } = await import('svelte/store');
    const store = writable(initial);
    return {
        musicPlayerStore: {
            ...store,
            loadMusicSettings: vi.fn(),
            setAlwaysShowBeatPulse: vi.fn((enabled: boolean) =>
                store.update((s) => ({ ...s, alwaysShowBeatPulse: enabled })),
            ),
        },
    };
});
const state = musicPlayerStore as unknown as Writable<typeof initial>;

afterEach(cleanup);
beforeEach(() => state.set(initial));

function strength(container: HTMLElement): number {
    return Number(
        (container.querySelector('.playhead-circle') as HTMLElement).style.getPropertyValue(
            '--beat-strength',
        ),
    );
}

describe('shared playhead', () => {
    it('retains the existing hidden mini thumb by default and always shows the full-screen thumb', () => {
        const mini = render(PlayheadBeatPulse, { progress: 0.5 });
        expect(mini.container.querySelector('.visible')).toBeNull();
        expect(strength(mini.container)).toBe(0);
        const full = render(PlayheadBeatPulse, { progress: 0.5, large: true });
        expect(full.container.querySelector('.visible.large')).not.toBeNull();
    });
    it('pulses the one circle without changing its position, and stops on pause/loading/disable', async () => {
        const view = render(PlayheadBeatPulse, { progress: 0.5 });
        state.update((s) => ({ ...s, alwaysShowBeatPulse: true }));
        await tick();
        expect(strength(view.container)).toBe(1);
        expect(view.container.querySelectorAll('.playhead-circle')).toHaveLength(1);
        expect((view.container.querySelector('.playhead') as HTMLElement).style.left).toBe('50%');
        state.update((s) => ({ ...s, currentTimeMs: 1110 }));
        await tick();
        expect(strength(view.container)).toBeCloseTo(0.5);
        for (const change of [
            { isPlaying: false },
            { isPlaying: true, isLoadingTrack: true },
            { isLoadingTrack: false, alwaysShowBeatPulse: false },
        ]) {
            state.update((s) => ({ ...s, ...change }));
            await tick();
            expect(strength(view.container)).toBe(0);
        }
    });
    it('keeps scrub preview position and suppresses pulsing while scrubbing', async () => {
        state.update((s) => ({ ...s, alwaysShowBeatPulse: true }));
        const view = render(PlayheadBeatPulse, { progress: 0.8, large: true, seeking: true });
        expect(strength(view.container)).toBe(0);
        expect((view.container.querySelector('.playhead') as HTMLElement).style.left).toBe('80%');
        await view.rerender({ progress: 0.2, large: true, seeking: false });
        expect(strength(view.container)).toBe(1);
        expect((view.container.querySelector('.playhead') as HTMLElement).style.left).toBe('20%');
    });
    it('tracks replacement grids and never manufactures beats without timing', async () => {
        state.update((s) => ({ ...s, alwaysShowBeatPulse: true }));
        const view = render(PlayheadBeatPulse, { progress: 0.5 });
        state.update((s) => ({
            ...s,
            currentTrack: {
                id: 'b',
                audioFeatures: { beatGrid: [0.5, 1.5], bpm: 120 } satisfies TrackAudioFeatures,
            },
        }));
        await tick();
        expect(strength(view.container)).toBe(0);
        state.update((s) => ({
            ...s,
            currentTrack: {
                id: 'c',
                audioFeatures: { beatGrid: [], bpm: 0 } satisfies TrackAudioFeatures,
            },
        }));
        await tick();
        expect(strength(view.container)).toBe(0);
    });
});

it('keeps the fade dissolve/glow and has only one pulsing circle when enabled', async () => {
    const view = render(CrossfadeSeekbarFx);
    state.update((s) => ({ ...s, isCrossfading: true }));
    await tick();
    expect(view.container.querySelector('.xfade-glow')).not.toBeNull();
    expect(view.container.querySelector('.xfade-old-fill')).not.toBeNull();
    expect(view.container.querySelector('.xfade-spark-beat')).not.toBeNull();
    state.update((s) => ({ ...s, alwaysShowBeatPulse: true }));
    await tick();
    expect(view.container.querySelector('.xfade-glow')).not.toBeNull();
    expect(view.container.querySelector('.xfade-old-fill')).not.toBeNull();
    expect(view.container.querySelector('.xfade-spark')).toBeNull();
});

it('offers an accessible beat switch even with crossfade disabled', async () => {
    render(CrossfadeSettings);
    const toggle = screen.getByRole('switch', { name: 'Always show beat pulse' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(musicPlayerStore.setAlwaysShowBeatPulse).toHaveBeenCalledWith(true);
});
