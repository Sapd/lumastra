// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock('$lib/api/user', () => ({
    getPlaybackPreferences: api.get,
    updatePlaybackPreferences: api.update,
}));

let cleanup = (): void => {};
let removeListeners = (): void => {};
beforeEach(() => {
    vi.resetModules();
    api.get.mockReset();
    api.update.mockReset().mockResolvedValue({ data: {}, error: null });
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
            get length() {
                return values.size;
            },
            key: (index: number) => [...values.keys()][index] ?? null,
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => {
                values.set(key, String(value));
            },
            removeItem: (key: string) => {
                values.delete(key);
            },
            clear: () => {
                values.clear();
            },
        },
    });
    const windowListeners = vi.spyOn(window, 'addEventListener');
    const documentListeners = vi.spyOn(document, 'addEventListener');
    removeListeners = () => {
        for (const [type, listener, options] of windowListeners.mock.calls)
            window.removeEventListener(type, listener, options);
        for (const [type, listener, options] of documentListeners.mock.calls)
            document.removeEventListener(type, listener, options);
        windowListeners.mockRestore();
        documentListeners.mockRestore();
    };
});
afterEach(() => {
    cleanup();
    removeListeners();
});

test('mounted badges load saved visibility and react to later preference edits', async () => {
    let release!: (value: unknown) => void;
    api.get.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    );
    const testing = await import('@testing-library/svelte/pure');
    const Badge = (await import('./EpisodeLanguageBadges.svelte')).default;
    const { playbackPreferences, updatePreference, forceSyncToServer } =
        await import('$lib/components/player/preferences-sync.svelte');
    const view = testing.render(Badge, {
        audioLanguages: ['jpn'],
        subtitleLanguages: ['deu'],
        showSeparator: true,
    });
    cleanup = testing.cleanup;
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledOnce());
    expect(view.queryByText('JA')).toBeNull();
    expect(view.queryByText('DE')).toBeNull();
    expect(view.queryByText('·')).toBeNull();
    release({
        data: { showEpisodeLanguages: false, updatedAt: '2026-10-26T12:00:00Z' },
        error: null,
    });
    await vi.waitFor(() => expect(playbackPreferences.ready).toBe(true));
    expect(view.queryByText('JA')).toBeNull();
    expect(view.queryByText('DE')).toBeNull();
    expect(view.queryByText('·')).toBeNull();

    updatePreference('showEpisodeLanguages', true);
    await view.findByText('JA');
    expect(view.getByText('DE')).toBeTruthy();
    expect(view.getByText('·')).toBeTruthy();
    await forceSyncToServer();
    expect(api.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ showEpisodeLanguages: true }),
        { keepalive: true },
    );

    updatePreference('showEpisodeLanguages', false);
    await vi.waitFor(() => expect(view.queryByText('JA')).toBeNull());
    expect(view.queryByText('DE')).toBeNull();
    expect(view.queryByText('·')).toBeNull();
    await forceSyncToServer();
    expect(api.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ showEpisodeLanguages: false }),
        { keepalive: true },
    );
    // The cold dynamic imports above run inside this test; on a loaded runner they
    // alone take over 10 s (12 s measured at load 53 on 2026-10-31).
}, 30_000);
