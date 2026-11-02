// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { musicTrackFromCard } from '$lib/utils/music-track';

// @vitest-environment happy-dom

/**
 * Security fix C7, fix round 1: `Clear-Site-Data: "storage"` was dropped from
 * the server response because it wipes ALL localStorage, including per-DEVICE
 * keys (sidebar/dock/nav-pin UI state, mute/output-device preference, …) that
 * must survive logout on a shared browser — see
 * device-id.ts:getDeviceId()/dashboard_device_id for why. This curated wipe
 * is the replacement: only the listed user-specific keys/prefixes, all of
 * sessionStorage, and the two auth cookies. Shared by both logout paths.
 */

import {
    PlaybackPreferenceJournal,
    PREFERENCE_EPOCH_KEY,
    PREFERENCE_PERMIT_KEY,
} from '$lib/shared/playback-preference-journal';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, version: 'test-version' }));

const { clearUserClientState } = await import('./clear-user-client-state.js');
const { savePlaybackState, resumePlaybackPersistence } =
    await import('../stores/music-playback-persistence.js');

describe('clearUserClientState', () => {
    afterEach(() => {
        localStorage.clear();
        sessionStorage.clear();
        resumePlaybackPersistence();
        document.cookie.split(';').forEach((c) => {
            const name = c.split('=')[0]?.trim();
            if (name) document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT`;
        });
    });

    it('retires the durable permit even without a cache and removes every tab-owned replay entry', () => {
        const a = new PlaybackPreferenceJournal(localStorage, () => true);
        const b = new PlaybackPreferenceJournal(localStorage, () => true);
        a.record('subtitleLanguage', 'de', 1);
        const audio = b.record('audioLanguage', 'fr', 1)!;
        b.acknowledge([audio]);
        const oldEpoch = localStorage.getItem(PREFERENCE_EPOCH_KEY);
        localStorage.removeItem('playerPreferences');
        clearUserClientState();
        expect(localStorage.getItem(PREFERENCE_EPOCH_KEY)).toBe(oldEpoch);
        expect(localStorage.getItem(PREFERENCE_PERMIT_KEY)).toBeNull();
        expect(a.isCurrent()).toBe(false);
        expect(
            Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).some(
                (key) => key?.startsWith('lumastra:pref-ack:'),
            ),
        ).toBe(false);
        expect(new PlaybackPreferenceJournal(localStorage, () => true).entries()).toEqual([]);
        expect(
            Array.from({ length: localStorage.length }, (_, index) =>
                localStorage.key(index),
            ).filter((key) => key?.startsWith('lumastra:pref-journal:')),
        ).toEqual([]);
    });

    it('retires without allocating at quota with the main cache already absent', () => {
        const sibling = new PlaybackPreferenceJournal(localStorage, () => true);
        sibling.record('audioLanguage', 'de', 1);
        localStorage.removeItem('playerPreferences');
        const previous = localStorage.getItem(PREFERENCE_EPOCH_KEY)!;
        const original = localStorage.setItem.bind(localStorage);
        let failures = 0;
        const write = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
            const hasJournal = Array.from({ length: localStorage.length }, (_, index) =>
                localStorage.key(index),
            ).some((entry) => entry?.startsWith('lumastra:pref-journal:'));
            if (key === PREFERENCE_EPOCH_KEY && hasJournal) {
                failures++;
                throw new Error('Quota');
            }
            original(key, value);
        });
        try {
            clearUserClientState();
            expect(failures).toBe(0);
            expect(localStorage.getItem(PREFERENCE_EPOCH_KEY)).toBe(previous);
            expect(localStorage.getItem(PREFERENCE_PERMIT_KEY)).toBeNull();
            expect(sibling.isCurrent()).toBe(false);
            expect(sibling.record('audioLanguage', 'de', 2)).toBeUndefined();
        } finally {
            write.mockRestore();
        }
    });

    it('removes the preallocated permit when every marker write is denied', () => {
        const sibling = new PlaybackPreferenceJournal(localStorage, () => true);
        sibling.record('audioLanguage', 'de', 1);
        localStorage.removeItem('playerPreferences');
        const previous = localStorage.getItem(PREFERENCE_EPOCH_KEY);
        const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
            throw new Error('Storage denied');
        });
        try {
            clearUserClientState();
            expect(localStorage.getItem(PREFERENCE_EPOCH_KEY)).toBe(previous);
            expect(localStorage.getItem(PREFERENCE_PERMIT_KEY)).toBeNull();
            expect(sibling.isCurrent()).toBe(false);
        } finally {
            write.mockRestore();
        }
        const recovered = new PlaybackPreferenceJournal(localStorage, () => true);
        expect(recovered.isCurrent()).toBe(false);
        recovered.bootstrap();
        expect(recovered.isCurrent()).toBe(true);
        expect(recovered.generation).toBeGreaterThan(sibling.generation);
        expect(recovered.epoch).not.toBe(sibling.epoch);
        expect(sibling.isCurrent()).toBe(false);
    });

    it('removes every curated user-specific key', () => {
        const curatedKeys = [
            'dashboard_jellyfin_credentials',
            'devUser',
            'dashboard_watch_party',
            'playerPreferences',
            'lumastra:pref-dirty',
            'onlyWatchedContent',
            'onlyWatchedBasedRecommendations',
            'showOnlyUnratedContent',
            'hideWatchedContent',
            'persistentDetailedModeRating',
            'uiPreferences',
            'lumastra-desktop-notifications-enabled',
            'dashboard-last-reload',
            'dashboard-reload-loop-detected',
            'dashboard-cache',
        ];
        for (const key of curatedKeys) localStorage.setItem(key, 'x');

        clearUserClientState();

        for (const key of curatedKeys) {
            expect(localStorage.getItem(key)).toBeNull();
        }
    });

    it('removes the three un-namespaced music/search client keys (C13)', () => {
        // These three keys carry the previous user's listening activity,
        // search terms and taste preferences, but had no user field and were
        // never in USER_SPECIFIC_KEYS/PREFIXES — so they auto-restored for
        // the next signed-in user on a shared device (2026-09-16 C13).
        const leakyKeys = [
            'lumastra:music-playback',
            'lumastra:recent-searches:v1',
            'lumastra:music-alchemy:v1',
            'lumastra:music-alchemy:v2',
            'lumastra:music-alchemy:v3',
        ];
        for (const key of leakyKeys) localStorage.setItem(key, 'x');

        clearUserClientState();

        for (const key of leakyKeys) {
            expect(localStorage.getItem(key)).toBeNull();
        }
    });

    it('suppresses playback persistence so a beforeunload firing after the wipe cannot re-write the key (C13)', () => {
        // The module-level `beforeunload` listener in music-player.store.ts
        // calls persistState() unconditionally on every page unload,
        // including the logout redirect, which ends in savePlaybackState().
        // Adding the key to the curated list alone is not sufficient because
        // that listener runs AFTER the wipe. clearUserClientState() must
        // also flip a flag that savePlaybackState() itself checks, so the
        // re-write never happens.
        //
        // Fix round 1 (2026-09-16): this calls the REAL savePlaybackState()
        // — the actual storage boundary the suppression guard lives in —
        // instead of re-implementing the guard inline. The original version
        // of this test wrapped a hand-rolled
        // `if (!isPlaybackPersistenceSuppressed()) localStorage.setItem(...)`
        // check, which meant deleting the real guard turned no test red.
        localStorage.setItem('lumastra:music-playback', 'x');

        clearUserClientState();

        // Simulate the beforeunload handler's persistState() call firing
        // after the wipe by calling the real function it ends in.
        savePlaybackState({
            autoplaySeed: null,
            playbackContext: null,
            currentTrack: musicTrackFromCard({
                id: 'track-1',
                title: 'Track',
                artists: [{ id: null, title: 'Artist' }],
            }),
            position: 0,
            queue: [],
            history: [],
            volume: 1,
            wasPlaying: false,
            savedAt: Date.now(),
        });

        expect(localStorage.getItem('lumastra:music-playback')).toBeNull();
    });

    it('removes keys matching the username-carrying prefixes', () => {
        localStorage.setItem('dashboard-request-notifications-alice', 'x');
        localStorage.setItem('lumastra:resume:v1:some-item', 'x');

        clearUserClientState();

        expect(localStorage.getItem('dashboard-request-notifications-alice')).toBeNull();
        expect(localStorage.getItem('lumastra:resume:v1:some-item')).toBeNull();
    });

    it('leaves per-device localStorage keys alone', () => {
        const perDeviceKeys = [
            'sidebar-sections-collapsed',
            'DOCK_TRIGGER_STORAGE_KEY',
            'admin-nav-pinned',
            // Sidebar sections an admin expanded: keyed by username so it
            // already stays per user, and kept across logout on purpose.
            'admin-nav-expanded:alice',
            // Security review 2026-09-15, fix round 1: dashboard_device_id
            // (device-id.ts:getDeviceId()) was previously listed in
            // USER_SPECIFIC_KEYS and wiped on every logout, contradicting
            // this file's own module doc and clear-site-data.ts's documented
            // contract that it must survive — see clear-site-data.ts's
            // comment for the consequence (a new user_devices row per login,
            // orphaning the old one's name/heartbeat history).
            'dashboard_device_id',
        ];
        for (const key of perDeviceKeys) localStorage.setItem(key, 'kept');

        clearUserClientState();

        for (const key of perDeviceKeys) {
            expect(localStorage.getItem(key)).toBe('kept');
        }
    });

    it('clears sessionStorage entirely', () => {
        sessionStorage.setItem('anything', 'x');

        clearUserClientState();

        expect(sessionStorage.length).toBe(0);
    });

    it('expires the devUser and PARAGLIDE_LOCALE cookies', () => {
        document.cookie = 'devUser=someuser; path=/';
        document.cookie = 'PARAGLIDE_LOCALE=en; path=/';

        clearUserClientState();

        expect(document.cookie).not.toContain('devUser=someuser');
        expect(document.cookie).not.toContain('PARAGLIDE_LOCALE=en');
    });

    it('is a no-op outside the browser', async () => {
        vi.resetModules();
        vi.doMock('$app/environment', () => ({ browser: false, version: 'test-version' }));
        const { clearUserClientState: clearOutsideBrowser } =
            await import('./clear-user-client-state.js');

        localStorage.setItem('devUser', 'x');
        clearOutsideBrowser();
        expect(localStorage.getItem('devUser')).toBe('x');

        vi.doUnmock('$app/environment');
    });
});
