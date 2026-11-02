// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { musicPlayerStore } from './music-player.store';

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), errorToast: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: api.errorToast } }));
vi.mock('$lib/api/user', () => ({
    getPlaybackPreferences: api.get,
    updatePlaybackPreferences: api.update,
}));

beforeEach(async () => {
    api.get.mockReset().mockResolvedValue({ data: {} });
    api.errorToast.mockReset();
    api.update.mockReset().mockResolvedValue({ data: {} });
    musicPlayerStore._updateForTest!((s) => ({ ...s, alwaysShowBeatPulse: false }));
    await musicPlayerStore.loadMusicSettings();
});

it('defaults off and missing saved preferences restore false', async () => {
    expect(get(musicPlayerStore).alwaysShowBeatPulse).toBe(false);
    api.get.mockResolvedValue({ data: {} });
    await musicPlayerStore.setAlwaysShowBeatPulse(true);
    await musicPlayerStore.loadMusicSettings();
    expect(get(musicPlayerStore).alwaysShowBeatPulse).toBe(false);
});

it('persists toggles and restores saved enabled preferences with crossfade disabled', async () => {
    await musicPlayerStore.setAlwaysShowBeatPulse(true);
    expect(api.update).toHaveBeenCalledWith({ musicAlwaysShowBeatPulse: true });
    await musicPlayerStore.setAlwaysShowBeatPulse(false);
    expect(api.update).toHaveBeenLastCalledWith({ musicAlwaysShowBeatPulse: false });
    api.get.mockResolvedValue({
        data: { musicAlwaysShowBeatPulse: true, musicCrossfadeEnabled: false },
    });
    await musicPlayerStore.loadMusicSettings();
    expect(get(musicPlayerStore).alwaysShowBeatPulse).toBe(true);
    expect(get(musicPlayerStore).crossfadeEnabled).toBe(false);
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

it('reports returned API errors and restores the last saved state', async () => {
    api.get.mockResolvedValue({ data: { musicAlwaysShowBeatPulse: true } });
    await musicPlayerStore.loadMusicSettings();
    api.update.mockResolvedValue({ data: null, error: 'forbidden' });
    await musicPlayerStore.setAlwaysShowBeatPulse(false);
    expect(get(musicPlayerStore).alwaysShowBeatPulse).toBe(true);
    expect(api.errorToast).toHaveBeenCalledWith(expect.stringContaining('Could not save'));
});

it('serializes rapid writes so the last choice persists, even if an older write fails', async () => {
    const first = deferred<{ data: null; error: string }>();
    api.update.mockReturnValueOnce(first.promise).mockResolvedValue({ data: {} });
    const enable = musicPlayerStore.setAlwaysShowBeatPulse(true);
    await vi.waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    const disable = musicPlayerStore.setAlwaysShowBeatPulse(false);
    const finalEnable = musicPlayerStore.setAlwaysShowBeatPulse(true);
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(get(musicPlayerStore).alwaysShowBeatPulse).toBe(true);
    first.resolve({ data: null, error: 'failed' });
    await Promise.all([enable, disable, finalEnable]);
    expect(api.update.mock.calls.map(([body]) => body.musicAlwaysShowBeatPulse)).toEqual([
        true,
        false,
        true,
    ]);
    expect(get(musicPlayerStore).alwaysShowBeatPulse).toBe(true);
    api.get.mockResolvedValue({ data: { musicAlwaysShowBeatPulse: true } });
    await musicPlayerStore.loadMusicSettings();
    expect(get(musicPlayerStore).alwaysShowBeatPulse).toBe(true);
});

it('restores the successful preceding write when the latest queued choice fails', async () => {
    const first = deferred<{ data: Record<string, never> }>();
    api.update
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue({ data: null, error: 'failed' });
    const enable = musicPlayerStore.setAlwaysShowBeatPulse(true);
    await vi.waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    const disable = musicPlayerStore.setAlwaysShowBeatPulse(false);
    first.resolve({ data: {} });
    await Promise.all([enable, disable]);
    expect(get(musicPlayerStore).alwaysShowBeatPulse).toBe(true);
});

it('ignores a stale settings GET only for the beat choice while loading other preferences', async () => {
    const read = deferred<{ data: { musicAlwaysShowBeatPulse: boolean; musicShowBpm: boolean } }>();
    api.get.mockReturnValue(read.promise);
    const load = musicPlayerStore.loadMusicSettings();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await musicPlayerStore.setAlwaysShowBeatPulse(true);
    read.resolve({ data: { musicAlwaysShowBeatPulse: false, musicShowBpm: false } });
    await load;
    expect(get(musicPlayerStore).alwaysShowBeatPulse).toBe(true);
    expect(get(musicPlayerStore).showBpm).toBe(false);
});

it('does not overwrite an optimistic choice when GET starts during a pending write', async () => {
    const write = deferred<{ data: Record<string, never> }>();
    api.update.mockReturnValueOnce(write.promise);
    const pending = musicPlayerStore.setAlwaysShowBeatPulse(true);
    await vi.waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    await musicPlayerStore.loadMusicSettings();
    expect(get(musicPlayerStore).alwaysShowBeatPulse).toBe(true);
    write.resolve({ data: {} });
    await pending;
});

it('reports thrown request failures and can save again afterwards', async () => {
    api.update.mockRejectedValueOnce(new Error('offline'));
    await musicPlayerStore.setAlwaysShowBeatPulse(true);
    expect(get(musicPlayerStore).alwaysShowBeatPulse).toBe(false);
    expect(api.errorToast).toHaveBeenCalledOnce();
    await musicPlayerStore.setAlwaysShowBeatPulse(true);
    expect(get(musicPlayerStore).alwaysShowBeatPulse).toBe(true);
});

it('ignores a GET issued during a write even if it returns after the write succeeds', async () => {
    const write = deferred<{ data: Record<string, never> }>();
    const read = deferred<{ data: { musicAlwaysShowBeatPulse: boolean } }>();
    api.update.mockReturnValueOnce(write.promise);
    const pending = musicPlayerStore.setAlwaysShowBeatPulse(true);
    await vi.waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    api.get.mockReturnValueOnce(read.promise);
    const load = musicPlayerStore.loadMusicSettings();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    write.resolve({ data: {} });
    await pending;
    read.resolve({ data: { musicAlwaysShowBeatPulse: false } });
    await load;
    expect(get(musicPlayerStore).alwaysShowBeatPulse).toBe(true);
});

vi.mock('$app/stores', () => ({
    page: { subscribe: (run: (value: unknown) => void) => {
        run({ data: { user: { userId: 'music-player-test-user' } } });
        return () => undefined;
    } },
}));
