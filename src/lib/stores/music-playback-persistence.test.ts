// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { musicTrackFromCard } from '$lib/utils/music-track';

/**
 * Regression tests for music playback persistence.
 *
 * Focus: the queue rehydrated from localStorage must never contain duplicate
 * QueueItem ids. The queue panel renders `{#each localQueue as item (item.id)}`,
 * so a duplicate id throws Svelte's `each_key_duplicate` at runtime. In-app queue
 * mutations already dedup, but a legacy/corrupt persisted queue (e.g. the old
 * bare `MusicTrack[]` format that listed a track twice) could restore repeats.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    loadPlaybackState,
    savePlaybackState,
    type PersistedPlaybackState,
} from './music-playback-persistence';

const STORAGE_KEY = 'lumastra:music-playback';

// Hermetic in-memory localStorage so the test doesn't depend on the node
// experimental localStorage backing file.
beforeEach(() => {
    const store = new Map<string, string>();
    globalThis.localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
            return store.size;
        },
    } as Storage;
});

function track(id: string) {
    return musicTrackFromCard({ id, title: `Track ${id}`, artists: [{ id: null, title: 'A' }] });
}

describe('loadPlaybackState queue dedup', () => {
    it('drops version 2 snapshots whose track durations were stored in seconds', () => {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                version: 2,
                savedAt: Date.now(),
                currentTrack: { ...track('old'), durationSeconds: 180 },
                queue: [],
            }),
        );
        expect(loadPlaybackState()).toBeNull();
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('restores millisecond durations and resets a position within two seconds of the end', () => {
        const currentTrack = { ...track('current'), durationMs: 180_000 };
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                version: 3,
                savedAt: Date.now(),
                currentTrack,
                position: 179_000,
                queue: [],
            }),
        );
        const restored = loadPlaybackState();
        expect(restored?.currentTrack?.durationMs).toBe(180_000);
        expect(restored?.position).toBe(0);
    });

    it('drops a persisted station context that has no string stationId', () => {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                version: 3,
                savedAt: Date.now(),
                currentTrack: null,
                queue: [],
                playbackContext: { type: 'station', name: 'Old', stationIndex: 2 },
            }),
        );
        expect(loadPlaybackState()?.playbackContext).toBeNull();
    });

    it('keeps a station context with a stationId and other context types', () => {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                version: 3,
                savedAt: Date.now(),
                currentTrack: null,
                queue: [],
                playbackContext: { type: 'station', name: 'New', stationId: 'abcdef012345.1' },
            }),
        );
        expect(loadPlaybackState()?.playbackContext).toEqual({
            type: 'station',
            name: 'New',
            stationId: 'abcdef012345.1',
        });
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                version: 3,
                savedAt: Date.now(),
                currentTrack: null,
                queue: [],
                playbackContext: { type: 'genre', name: 'Trance' },
            }),
        );
        expect(loadPlaybackState()?.playbackContext).toEqual({ type: 'genre', name: 'Trance' });
    });

    it('drops duplicate QueueItem ids (new format), keeping first occurrence', () => {
        const raw = {
            version: 3,
            savedAt: Date.now(),
            queue: [
                { track: track('t1'), source: 'user', id: 't1' },
                { track: track('t2'), source: 'smart', id: 't2' },
                // duplicate of the first slot — would trigger each_key_duplicate
                { track: track('t1'), source: 'smart', id: 't1' },
            ],
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));

        const loaded = loadPlaybackState();
        const ids = loaded?.queue.map((q) => q.id) ?? [];
        expect(ids).toEqual(['t1', 't2']);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('discards legacy snapshots before reading incompatible tracks', () => {
        const raw = {
            savedAt: Date.now(),
            // legacy format: bare tracks, same track twice
            queue: [track('a'), track('b'), track('a')],
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(raw));

        const loaded = loadPlaybackState();
        const ids = loaded?.queue.map((q) => q.id) ?? [];
        expect(loaded).toBeNull();
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('round-trips a clean queue unchanged', () => {
        const state: PersistedPlaybackState = {
            autoplaySeed: null,
            playbackContext: null,
            currentTrack: null,
            position: 0,
            queue: [
                { track: track('x'), source: 'user', id: 'x' },
                { track: track('y'), source: 'user', id: 'y' },
            ],
            history: [],
            volume: 0.8,
            wasPlaying: false,
            savedAt: Date.now(),
        };
        savePlaybackState(state);

        const loaded = loadPlaybackState();
        expect(loaded?.queue.map((q) => q.id)).toEqual(['x', 'y']);
    });
});

it('drops malformed current-version entries without crashing', () => {
    localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
            version: 3,
            savedAt: Date.now(),
            currentTrack: { id: 'old', artist: 'Legacy artist' },
            queue: [null, { track: null }, { id: 'wrong', source: 'user', track: track('valid') }],
            history: [null, { id: 'old' }, track('history')],
        }),
    );
    const restored = loadPlaybackState();
    expect(restored?.currentTrack).toBeNull();
    expect(restored?.queue.map((q) => q.id)).toEqual(['valid']);
    expect(restored?.history.map((t) => t.id)).toEqual(['history']);
});
