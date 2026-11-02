// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from 'vitest';
import {
    loadAudiobookVolume,
    saveAudiobookVolume,
    type PersistedAudiobookVolume,
} from './audiobook-player-persistence';

const STORAGE_KEY = 'lumastra:audiobook-volume';

// Hermetic in-memory localStorage so the test doesn't depend on the node
// experimental localStorage backing file. Matches music-playback-persistence.test.ts.
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

describe('loadAudiobookVolume', () => {
    it('returns the default when nothing is stored', () => {
        expect(loadAudiobookVolume()).toEqual({ volume: 1, isMuted: false });
    });

    it('round-trips a saved value', () => {
        const state: PersistedAudiobookVolume = { volume: 0.42, isMuted: false };
        saveAudiobookVolume(state);
        expect(loadAudiobookVolume()).toEqual(state);
    });

    it('round-trips a muted value', () => {
        saveAudiobookVolume({ volume: 0.7, isMuted: true });
        expect(loadAudiobookVolume()).toEqual({ volume: 0.7, isMuted: true });
    });

    it('falls back to defaults on corrupt JSON', () => {
        localStorage.setItem(STORAGE_KEY, '{not json');
        expect(loadAudiobookVolume()).toEqual({ volume: 1, isMuted: false });
    });

    it('clamps an out-of-range volume and ignores a non-boolean isMuted', () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ volume: 5, isMuted: 'yes' }));
        expect(loadAudiobookVolume()).toEqual({ volume: 1, isMuted: false });
    });

    it('falls back to defaults when the stored value is not an object', () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify('nope'));
        expect(loadAudiobookVolume()).toEqual({ volume: 1, isMuted: false });
    });
});
