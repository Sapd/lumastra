// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The audiobook player's volume is a standing preference, not session state —
 * unlike music-playback-persistence.ts there is no MAX_AGE_MS expiry and no
 * `browser`/SSR guard: every call is wrapped in try/catch, which is what makes
 * this safe to call from the store module's synchronous init on the server
 * (where `localStorage` is not defined at all) as well as in the browser.
 */

const STORAGE_KEY = 'lumastra:audiobook-volume';

export interface PersistedAudiobookVolume {
    volume: number;
    isMuted: boolean;
}

const DEFAULT_VOLUME: PersistedAudiobookVolume = { volume: 1, isMuted: false };

export function saveAudiobookVolume(state: PersistedAudiobookVolume): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // localStorage full, unavailable (SSR), or private browsing — silently ignore
    }
}

export function loadAudiobookVolume(): PersistedAudiobookVolume {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_VOLUME;

        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return DEFAULT_VOLUME;
        const record = parsed as Record<string, unknown>;

        const volume =
            typeof record.volume === 'number' && Number.isFinite(record.volume)
                ? Math.max(0, Math.min(1, record.volume))
                : DEFAULT_VOLUME.volume;
        const isMuted =
            typeof record.isMuted === 'boolean' ? record.isMuted : DEFAULT_VOLUME.isMuted;

        return { volume, isMuted };
    } catch {
        /* expected: JSON.parse failure on corrupt localStorage data */
        return DEFAULT_VOLUME;
    }
}
