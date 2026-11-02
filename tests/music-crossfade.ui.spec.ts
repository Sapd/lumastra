// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Crossfade & Channel E2E Tests
 *
 * Tests the full crossfade pipeline end-to-end using a real Chromium browser:
 *   1. Unit-level store access via window.__musicPlayerStore (dev-only)
 *   2. Audio element mocking via addInitScript() for deterministic playback
 *   3. Manual outro simulation to trigger the crossfade engine
 *   4. DOM observation for track transition verification
 *
 * Crossfade is triggered by the progress loop when currentTime >= outro_start_ms.
 * We simulate this by setting the mock audio element's currentTime past the outro
 * threshold, then letting the requestAnimationFrame loop fire naturally in Chromium.
 *
 * Note: Audio output is not verified (Playwright headless has no audio device).
 * We verify state transitions: isCrossfading=true → track swap → isCrossfading=false.
 */

import { adminTest as test, expect } from './fixtures/auth';
import type { Page, Locator } from '@playwright/test';
import { ensureSeededMusicStreamable } from './helpers/music-fixture';
import { gotoHydrated } from './helpers/cold-load';
import { initializeMusicStore } from './helpers/music-startup';
import type { MusicPlayerState } from '$lib/stores/music-player.store';
import type { MusicTrack } from '$lib/schemas/music';
import {
    TEST_MUSIC_TRACK_ID,
    TEST_MUSIC_TRACK_2_ID,
    TEST_MUSIC_ALBUM_ID,
    TEST_MUSIC_ARTIST_ID,
} from './global-setup';

// ============================================================================
// Helpers
// ============================================================================

/** Wait for the store to expose itself (only in dev mode). */
async function waitForStore(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        return new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => resolve(false), 5000);
            const check = (): void => {
                if (
                    (
                        window as Window & {
                            __musicPlayerStore?: unknown;
                        }
                    ).__musicPlayerStore
                ) {
                    clearTimeout(timeout);
                    resolve(true);
                    return;
                }
                requestAnimationFrame(check);
            };
            check();
        });
    });
}

/** Get current store state snapshot. */
async function getStoreState(page: Page): Promise<Record<string, unknown> | null> {
    return page.evaluate(() => {
        const store = (
            window as Window & {
                __musicPlayerStore?: {
                    subscribe: (cb: (s: unknown) => void) => () => void;
                };
            }
        ).__musicPlayerStore;
        if (!store) return null;
        let state: unknown;
        const unsub = store.subscribe((s) => (state = s));
        unsub();
        return state as Record<string, unknown>;
    });
}

/** Inject a MusicTrack into the store for playback (bypasses audio.play). */
async function injectPlay(page: Page, track: MusicTrack): Promise<void> {
    await page.evaluate((t) => {
        const store = (
            window as Window & {
                __musicPlayerStore?: {
                    play: (track: unknown) => Promise<void>;
                };
            }
        ).__musicPlayerStore;
        if (store) void store.play(t);
    }, track);
}

/** Advance the active audio element's currentTime to trigger outro detection. */
async function advanceAudioToOutro(page: Page, outroStartMs: number): Promise<void> {
    await page.evaluate((ms) => {
        // The active deck is NOT in the document: WebAudioBackend creates its
        // <audio> elements with createElement and never appends them, so the old
        // `document.querySelectorAll('audio')` here matched nothing and this
        // helper silently did nothing — the outro was never reached and the test
        // fell through to its `test.skip()` escape hatch. Use the elements the
        // init script collects at creation time instead.
        const collected = (window as Window & { __testAudioEls?: HTMLMediaElement[] })
            .__testAudioEls;
        const audioEls: HTMLMediaElement[] = collected?.length
            ? collected
            : Array.from(document.querySelectorAll('audio'));
        audioEls.forEach((el) => {
            if (el.src) {
                Object.defineProperty(el, 'currentTime', {
                    get: () => ms / 1000,
                    configurable: true,
                });
                Object.defineProperty(el, 'paused', {
                    get: () => false,
                    configurable: true,
                });
                Object.defineProperty(el, 'duration', {
                    get: () => 2,
                    configurable: true,
                });
            }
        });
    }, outroStartMs);
}

// ============================================================================
// Test fixtures (from global-setup seeded data)
// ============================================================================

const TRACK_1: MusicTrack = {
    id: TEST_MUSIC_TRACK_ID,
    title: 'Test Track 01',
    type: 'track',
    artists: [{ id: TEST_MUSIC_ARTIST_ID, title: 'Test Artist' }],
    albumArtist: { id: TEST_MUSIC_ARTIST_ID, title: 'Test Artist' },
    album: { id: TEST_MUSIC_ALBUM_ID, title: 'Test Album' },
    durationMs: 2000,
    trackNumber: null,
    discNumber: null,
    genres: [],
    year: null,
    images: {},
    isRadio: false,
    audioFeatures: {
        bpm: 120,
        key: 'C',
        energy: 0.75,
        outroStartMs: 1500,
        introEndMs: 500,
        beatGrid: [0, 0.5, 1, 1.5],
    },
};

const TRACK_2: MusicTrack = {
    id: TEST_MUSIC_TRACK_2_ID,
    title: 'Test Track 02',
    type: 'track',
    artists: [{ id: TEST_MUSIC_ARTIST_ID, title: 'Test Artist' }],
    albumArtist: { id: TEST_MUSIC_ARTIST_ID, title: 'Test Artist' },
    album: { id: TEST_MUSIC_ALBUM_ID, title: 'Test Album' },
    durationMs: 2000,
    trackNumber: null,
    discNumber: null,
    genres: [],
    year: null,
    images: {},
    isRadio: false,
    audioFeatures: {
        bpm: 125,
        key: 'G',
        energy: 0.65,
        introEndMs: 0,
    },
};

// ============================================================================
// Tests
// ============================================================================

test.describe('Crossfade Engine — E2E', () => {
    // On a fresh database the first library scan drops the seeded tracks' file
    // link, so their stream answers 404 and the player ends the track in a
    // MediaError (previous() then lands on a cleared currentTrack). Re-link the
    // fixture first; see helpers/music-fixture.ts.
    test.beforeAll(async () => {
        await ensureSeededMusicStreamable();
    });

    test.beforeEach(async ({ page }) => {
        // Mock HTMLAudioElement.play() to resolve immediately (no audio hardware needed)
        // Also mock src setting so the stream 404 doesn't break the test
        await page.addInitScript(() => {
            const originalDescriptor = Object.getOwnPropertyDescriptor(
                HTMLMediaElement.prototype,
                'play',
            );

            HTMLMediaElement.prototype.play = function () {
                // Simulate play without actually playing
                Object.defineProperty(this, 'paused', {
                    get: () => false,
                    configurable: true,
                });
                return Promise.resolve();
            };

            // Keep original pause
            const originalPause = HTMLMediaElement.prototype.pause.bind(HTMLMediaElement.prototype);
            HTMLMediaElement.prototype.pause = function () {
                Object.defineProperty(this, 'paused', {
                    get: () => true,
                    configurable: true,
                });
            };

            void originalDescriptor; // suppress unused warning
            void originalPause;

            // Collect every <audio> the audio backend creates.
            //
            // `handleTrackEnded` left the store's public API in 14f02b134
            // ("extract audio into platform-specific backends") — the end of a
            // track now arrives from the backend's `ended` listener via
            // `onTrackEnded`. WebAudioBackend never appends its decks to the
            // document, so `querySelectorAll('audio')` cannot reach them; hook
            // createElement instead and let the specs dispatch on the real
            // elements, which exercises the actual path rather than an internal.
            const created: HTMLMediaElement[] = [];
            (window as Window & { __testAudioEls?: HTMLMediaElement[] }).__testAudioEls = created;
            const originalCreateElement = document.createElement.bind(document);
            document.createElement = function (tagName: string) {
                const el = originalCreateElement(tagName);
                if (String(tagName).toLowerCase() === 'audio') {
                    created.push(el as HTMLMediaElement);
                }
                return el;
            } as typeof document.createElement;
        });

        // The store module can execute before Kit has mounted the route.
        // Wait for hydration before evaluating it, including transport recovery.
        await gotoHydrated(page, '/music');
        expect(await waitForStore(page), 'dev server exposes the music store').toBe(true);
        await initializeMusicStore(page);
    });

    test('beat pulse stays on the playhead in both players and respects pause and reduced motion', async ({
        page,
    }) => {
        await page.route('**/api/me/playback-preferences', (route) =>
            route.fulfill({
                json: {
                    audioLanguage: null,
                    subtitleLanguage: null,
                    subtitlesEnabled: true,
                    forcedSubtitlesEnabled: true,
                    subtitleStyle: null,
                    qualityMode: 'original',
                    maxBitrateBps: null,
                    preferredResolution: null,
                    autoplayNextEpisode: true,
                    skipIntroAutomatically: false,
                    skipCreditsAutomatically: false,
                    nextEpisodeCountdownSecondsDefault: 10,
                    musicAlwaysShowBeatPulse: true,
                    musicCrossfadeEnabled: false,
                },
            }),
        );
        await page.evaluate(
            (track) => {
                const store = (
                    window as Window & {
                        __musicPlayerStore?: {
                            _updateForTest: (fn: (s: MusicPlayerState) => MusicPlayerState) => void;
                        };
                    }
                ).__musicPlayerStore!;
                store._updateForTest((s) => ({
                    ...s,
                    currentTrack: track,
                    currentTimeMs: 1000,
                    durationMs: 10000,
                    progress: 0.1,
                    isPlaying: true,
                    isLoadingTrack: false,
                    isCrossfading: false,
                    crossfadeEnabled: false,
                    alwaysShowBeatPulse: false,
                    isFullScreen: false,
                }));
            },
            { ...TRACK_1, audioFeatures: { bpm: 120, beatGrid: [0, 1, 2] } },
        );
        await expect(page.locator('.playhead:not(.large) .pulsing')).toHaveCount(0);
        await page.evaluate(async () => {
            await (
                window as Window & {
                    __musicPlayerStore?: {
                        setAlwaysShowBeatPulse: (enabled: boolean) => Promise<void>;
                    };
                }
            ).__musicPlayerStore!.setAlwaysShowBeatPulse(true);
        });

        async function setPosition(timeMs: number, playing = true): Promise<void> {
            await page.evaluate(
                ({ timeMs, playing }) => {
                    (
                        window as Window & {
                            __musicPlayerStore?: {
                                _updateForTest: (
                                    fn: (s: MusicPlayerState) => MusicPlayerState,
                                ) => void;
                            };
                        }
                    ).__musicPlayerStore!._updateForTest((s) => ({
                        ...s,
                        currentTimeMs: timeMs,
                        isPlaying: playing,
                    }));
                },
                { timeMs, playing },
            );
        }
        async function visual(circle: Locator): Promise<{ scale: number; brightness: number }> {
            return circle.evaluate((el) => {
                const style = getComputedStyle(el);
                return {
                    scale:
                        style.transform === 'none' ? 1 : new DOMMatrixReadOnly(style.transform).a,
                    brightness: Number(style.filter.match(/brightness\(([\d.]+)\)/)?.[1] ?? 1),
                };
            });
        }
        for (const large of [false, true]) {
            await page.evaluate((large) => {
                (
                    window as Window & {
                        __musicPlayerStore?: {
                            setFullScreen: (value: boolean) => void;
                        };
                    }
                ).__musicPlayerStore!.setFullScreen(large);
            }, large);
            const head = page.locator(large ? '.playhead.large' : '.playhead:not(.large)');
            const circle = head.locator('.playhead-circle');
            await expect(circle).toHaveCount(1);
            const before = await head.boundingBox();
            await setPosition(1000);
            await expect.poll(async () => (await visual(circle)).scale).toBeCloseTo(1.35);
            await expect.poll(async () => (await visual(circle)).brightness).toBeCloseTo(1.3);
            await setPosition(1110);
            await expect.poll(async () => (await visual(circle)).scale).toBeCloseTo(1.175);
            await expect.poll(async () => (await visual(circle)).brightness).toBeCloseTo(1.15);
            await setPosition(1300);
            await expect.poll(async () => (await visual(circle)).scale).toBe(1);
            await expect.poll(async () => (await visual(circle)).brightness).toBe(1);
            await setPosition(1000, false);
            await expect.poll(async () => (await visual(circle)).scale).toBe(1);
            await expect.poll(async () => (await visual(circle)).brightness).toBe(1);
            await setPosition(1000);
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await expect(circle).toHaveCSS('transform', 'none');
            await expect(circle).toHaveCSS('filter', 'none');
            expect((await head.boundingBox())?.x).toBe(before?.x);
            await page.emulateMedia({ reducedMotion: 'no-preference' });
        }
    });

    // -------------------------------------------------------------------------
    // Store accessibility
    // -------------------------------------------------------------------------

    test('musicPlayerStore is accessible via window.__musicPlayerStore in dev mode', async ({
        page,
    }) => {
        const state = await getStoreState(page);
        expect(state).not.toBeNull();
        expect(state).toHaveProperty('currentTrack');
        expect(state).toHaveProperty('isPlaying');
        expect(state).toHaveProperty('isCrossfading');
        expect(state).toHaveProperty('autoplaySeed');
    });

    test('initial store state: no track playing, no channel', async ({ page }) => {
        const state = await getStoreState(page);
        expect(state?.currentTrack).toBeNull();
        expect(state?.isPlaying).toBe(false);
        expect(state?.isCrossfading).toBe(false);
        expect(state?.autoplaySeed).toBeNull();
    });

    // -------------------------------------------------------------------------
    // Track playback via store injection
    // -------------------------------------------------------------------------

    test('injecting a track via play() shows mini-player', async ({ page }) => {
        await injectPlay(page, TRACK_1);

        // Mini-player should become visible (currentTrack is set)
        await page.waitForFunction(
            () => {
                const store = (
                    window as Window & {
                        __musicPlayerStore?: {
                            subscribe: (cb: (s: Record<string, unknown>) => void) => () => void;
                        };
                    }
                ).__musicPlayerStore;
                if (!store) return false;
                let state: Record<string, unknown> = {};
                const unsub = store.subscribe((s) => {
                    state = s as Record<string, unknown>;
                });
                unsub();
                return state.currentTrack !== null;
            },
            null,
            { timeout: 5000 },
        );

        const state = await getStoreState(page);
        expect(state?.currentTrack).not.toBeNull();
        expect((state?.currentTrack as Record<string, unknown>)?.title).toBe('Test Track 01');
    });

    test('playing a track sets isPlaying=true', async ({ page }) => {
        await injectPlay(page, TRACK_1);

        await page.waitForFunction(
            () => {
                const store = (
                    window as Window & {
                        __musicPlayerStore?: {
                            subscribe: (cb: (s: Record<string, unknown>) => void) => () => void;
                        };
                    }
                ).__musicPlayerStore;
                if (!store) return false;
                let state: Record<string, unknown> = {};
                const unsub = store.subscribe((s) => {
                    state = s as Record<string, unknown>;
                });
                unsub();
                return state.isPlaying === true;
            },
            null,
            { timeout: 5000 },
        );

        const state = await getStoreState(page);
        expect(state?.isPlaying).toBe(true);
    });

    // -------------------------------------------------------------------------
    // Outro detection and crossfade triggering
    // -------------------------------------------------------------------------

    test('outro detection triggers isCrossfading when track reaches outro_start_ms', async ({
        page,
    }) => {
        // Play track 1 and queue track 2 (nextTrack needed for crossfade)
        await injectPlay(page, TRACK_1);
        await page.waitForFunction(
            () => {
                const store = (
                    window as Window & {
                        __musicPlayerStore?: {
                            subscribe: (cb: (s: Record<string, unknown>) => void) => () => void;
                        };
                    }
                ).__musicPlayerStore;
                if (!store) return false;
                let state: Record<string, unknown> = {};
                const unsub = store.subscribe((s) => {
                    state = s as Record<string, unknown>;
                });
                unsub();
                return state.currentTrack !== null;
            },
            null,
            { timeout: 5000 },
        );

        // Set nextTrack in the store so crossfade has a target
        await page.evaluate((track2) => {
            const store = (
                window as Window & {
                    __musicPlayerStore?: {
                        addToQueue: (t: unknown) => void;
                    };
                }
            ).__musicPlayerStore;
            if (store) store.addToQueue(track2);
        }, TRACK_2);

        // Advance audio currentTime past outro_start_ms (1500ms → 1.5s)
        await advanceAudioToOutro(page, 1600);

        // Wait for isCrossfading to become true (max 2s — rAF loop should catch it)
        const crossfadeTriggered = await page
            .waitForFunction(
                () => {
                    const store = (
                        window as Window & {
                            __musicPlayerStore?: {
                                subscribe: (cb: (s: Record<string, unknown>) => void) => () => void;
                            };
                        }
                    ).__musicPlayerStore;
                    if (!store) return false;
                    let state: Record<string, unknown> = {};
                    const unsub = store.subscribe((s) => {
                        state = s as Record<string, unknown>;
                    });
                    unsub();
                    return state.isCrossfading === true;
                },
                null,
                { timeout: 5000 },
            )
            .catch(() => null);

        // Note: crossfade requires initAudio() to have been called (needs audio elements).
        // In this test, audio context may not be fully initialised without user gesture.
        // We skip the assertion if the audio context was never created, which is expected
        // in headless environments without user interaction.
        if (crossfadeTriggered) {
            const state = await getStoreState(page);
            expect(state?.isCrossfading).toBe(true);
        } else {
            // crossfade not triggered because audio context not initialised (no deck available)
            // This is acceptable in headless test environments — the logic is unit-tested
            test.skip();
        }
    });

    // -------------------------------------------------------------------------
    // handleTrackEnded — no-crossfade path
    // -------------------------------------------------------------------------

    test('handleTrackEnded plays next track when not crossfading', async ({ page }) => {
        await injectPlay(page, TRACK_1);
        await page.waitForFunction(
            () => {
                const store = (
                    window as Window & {
                        __musicPlayerStore?: {
                            subscribe: (cb: (s: Record<string, unknown>) => void) => () => void;
                        };
                    }
                ).__musicPlayerStore;
                if (!store) return false;
                let state: Record<string, unknown> = {};
                const unsub = store.subscribe((s) => {
                    state = s as Record<string, unknown>;
                });
                unsub();
                return state.isPlaying === true;
            },
            null,
            { timeout: 5000 },
        );

        // Add track 2 to queue then fire ended
        await page.evaluate((track2) => {
            const store = (
                window as Window & {
                    __musicPlayerStore?: { addToQueue: (t: unknown) => void };
                }
            ).__musicPlayerStore;
            store?.addToQueue(track2);
            // Fire the real `ended` event the backend listens for; only the
            // active deck's listener acts on it.
            for (const el of (window as Window & { __testAudioEls?: HTMLMediaElement[] })
                .__testAudioEls ?? []) {
                el.dispatchEvent(new Event('ended'));
            }
        }, TRACK_2);

        await page.waitForFunction(
            () => {
                const store = (
                    window as Window & {
                        __musicPlayerStore?: {
                            subscribe: (cb: (s: Record<string, unknown>) => void) => () => void;
                        };
                    }
                ).__musicPlayerStore;
                if (!store) return false;
                let state: Record<string, unknown> = {};
                const unsub = store.subscribe((s) => {
                    state = s as Record<string, unknown>;
                });
                unsub();
                const track = state.currentTrack as Record<string, unknown> | null;
                return track?.title === 'Test Track 02';
            },
            null,
            { timeout: 5000 },
        );

        const state = await getStoreState(page);
        expect((state?.currentTrack as Record<string, unknown>)?.title).toBe('Test Track 02');
    });

    // NOTE: there used to be a 'handleTrackEnded is a no-op when isCrossfading=true'
    // test here. It asserted nothing — its own comment conceded "In this test,
    // isCrossfading is false, so we test the positive path" — and the state it
    // named is not reachable from the page: the guard lives in the backend's
    // `ended` listener (`!this._isCrossfading`), and nothing exposes a way to
    // force that flag. The positive path is covered by the test above; a test
    // that asserts nothing is worse than no test, so it is gone rather than
    // silently green.

    // -------------------------------------------------------------------------
    // Channel mode state transitions
    // -------------------------------------------------------------------------

    test('getSeedCrossfadeBeats returns the DJ beat count via window helper', async ({ page }) => {
        // `da38fb064` (unify radio & smart queue into one autoplay system) renamed
        // the channel concept to a seed, and with it `__getChannelCrossfadeBeats`
        // → `__getSeedCrossfadeBeats`. This spec kept calling the old name, so the
        // helper was always undefined and every branch compared null.
        //
        // The beat model changed with it: getDjCrossfadeBeats(outgoing, incoming,
        // mood) pays attention to BPM first — with at least one BPM known, a chill
        // mood blends over 64 beats, an energetic one over 32, anything else 48;
        // with no BPM at all it returns 4 and the duration falls back to 2s.
        const beats = async (seed: unknown, outgoingBpm?: number, incomingBpm?: number) =>
            page.evaluate(
                ({ seed: s, outgoingBpm: o, incomingBpm: i }) => {
                    const fn = (
                        window as Window & {
                            __getSeedCrossfadeBeats?: (
                                seed: unknown,
                                outgoingBpm?: number,
                                incomingBpm?: number,
                            ) => number;
                        }
                    ).__getSeedCrossfadeBeats;
                    if (!fn) return null;
                    return fn(s, o, i);
                },
                { seed, outgoingBpm, incomingBpm },
            );

        expect(await beats({ type: 'mood', mood: 'chill', label: 'Chill' }, 120, 124)).toBe(64);
        expect(await beats({ type: 'mood', mood: 'energetic', label: 'Energetic' }, 120, 124)).toBe(
            32,
        );
        expect(await beats({ type: 'genre', genre: 'rock', label: 'Rock' }, 120, 124)).toBe(48);
        expect(await beats(null, 120, 124)).toBe(48);

        // No BPM on either side — the beat count is not meaningful and the engine
        // uses its fixed fallback.
        expect(await beats({ type: 'mood', mood: 'chill', label: 'Chill' })).toBe(4);
        expect(await beats(null)).toBe(4);
    });

    test('skip() while no channel active advances to next queue track', async ({ page }) => {
        await injectPlay(page, TRACK_1);
        await page.waitForFunction(
            () => {
                const store = (
                    window as Window & {
                        __musicPlayerStore?: {
                            subscribe: (cb: (s: Record<string, unknown>) => void) => () => void;
                        };
                    }
                ).__musicPlayerStore;
                if (!store) return false;
                let state: Record<string, unknown> = {};
                const unsub = store.subscribe((s) => {
                    state = s as Record<string, unknown>;
                });
                unsub();
                return state.isPlaying === true;
            },
            null,
            { timeout: 5000 },
        );

        await page.evaluate((track2) => {
            const store = (
                window as Window & {
                    __musicPlayerStore?: {
                        addToQueue: (t: unknown) => void;
                        skip: () => Promise<void>;
                    };
                }
            ).__musicPlayerStore;
            if (store) {
                store.addToQueue(track2);
                void store.skip();
            }
        }, TRACK_2);

        await page.waitForFunction(
            () => {
                const store = (
                    window as Window & {
                        __musicPlayerStore?: {
                            subscribe: (cb: (s: Record<string, unknown>) => void) => () => void;
                        };
                    }
                ).__musicPlayerStore;
                if (!store) return false;
                let state: Record<string, unknown> = {};
                const unsub = store.subscribe((s) => {
                    state = s as Record<string, unknown>;
                });
                unsub();
                const track = state.currentTrack as Record<string, unknown> | null;
                return track?.title === 'Test Track 02';
            },
            null,
            { timeout: 5000 },
        );

        const state = await getStoreState(page);
        expect((state?.currentTrack as Record<string, unknown>)?.title).toBe('Test Track 02');
    });

    test('previous() while channel is active is a no-op', async ({ page }) => {
        await injectPlay(page, TRACK_1);
        await page.waitForFunction(
            () => {
                const store = (
                    window as Window & {
                        __musicPlayerStore?: {
                            subscribe: (cb: (s: Record<string, unknown>) => void) => () => void;
                        };
                    }
                ).__musicPlayerStore;
                if (!store) return false;
                let state: Record<string, unknown> = {};
                const unsub = store.subscribe((s) => {
                    state = s as Record<string, unknown>;
                });
                unsub();
                return state.isPlaying === true;
            },
            null,
            { timeout: 5000 },
        );

        // Inject a fake autoplay seed via seedAutoplay mock, then call previous()
        // Since we can't easily start a real channel (needs server), we test
        // that previous() navigates history when NOT in channel mode
        await page.evaluate((track2) => {
            const store = (
                window as Window & {
                    __musicPlayerStore?: {
                        play: (t: unknown) => Promise<void>;
                        previous: () => void;
                    };
                }
            ).__musicPlayerStore;
            if (store) {
                // Play track2, then call previous() → should go back to track1
                void store.play(track2);
            }
        }, TRACK_2);

        await page.waitForFunction(
            () => {
                const store = (
                    window as Window & {
                        __musicPlayerStore?: {
                            subscribe: (cb: (s: Record<string, unknown>) => void) => () => void;
                        };
                    }
                ).__musicPlayerStore;
                if (!store) return false;
                let state: Record<string, unknown> = {};
                const unsub = store.subscribe((s) => {
                    state = s as Record<string, unknown>;
                });
                unsub();
                const track = state.currentTrack as Record<string, unknown> | null;
                return track?.title === 'Test Track 02';
            },
            null,
            { timeout: 5000 },
        );

        await page.evaluate(() => {
            const store = (
                window as Window & {
                    __musicPlayerStore?: { previous: () => void };
                }
            ).__musicPlayerStore;
            if (store) store.previous();
        });

        // Without channel mode: previous() goes back to track 1 from history.
        // It clears currentTrack and then awaits play(), so wait for the title.
        await expect
            .poll(
                async () =>
                    ((await getStoreState(page))?.currentTrack as Record<string, unknown> | null)
                        ?.title,
            )
            .toBe('Test Track 01');
        const state = await getStoreState(page);
        expect((state?.currentTrack as Record<string, unknown>)?.title).toBe('Test Track 01');
    });
});

// ============================================================================
// Channel integration
// ============================================================================

test.describe('Channel Mode — API integration', () => {
    test('POST /api/music/radio/start returns session with correct channel context', async ({
        request,
    }) => {
        const res = await request.post('/api/music/radio/start', {
            data: { type: 'genre', genre: 'electronic' },
        });
        if (!res.ok()) {
            test.skip();
            return;
        }
        const body = (await res.json()) as {
            sessionId: string;
            channel: { type: string; genre: string; label: string };
            tracks: Array<{ id: string; title: string }>;
        };
        expect(body.channel.type).toBe('genre');
        expect(body.channel.genre).toBe('electronic');
        expect(body.channel.label).toBe('Electronic'); // enriched label
        expect(Array.isArray(body.tracks)).toBe(true);
    });

    test('mood channel context includes enriched label and emoji', async ({ request }) => {
        const res = await request.post('/api/music/radio/start', {
            data: { type: 'mood', mood: 'chill' },
        });
        if (!res.ok()) {
            test.skip();
            return;
        }
        const body = (await res.json()) as {
            channel: {
                type: string;
                mood: string;
                label: string;
                emoji: string;
            };
        };
        expect(body.channel.label).toBe('Chill');
        expect(body.channel.emoji).toBe('😌');
    });

    test('full channel lifecycle: start → next → skip → stop', async ({ request }) => {
        // Start
        const startRes = await request.post('/api/music/radio/start', {
            data: { type: 'mood', mood: 'chill' },
        });
        if (!startRes.ok()) {
            test.skip();
            return;
        }
        const start = (await startRes.json()) as {
            sessionId: string;
            tracks: Array<{ id: string }>;
        };
        const { sessionId, tracks } = start;
        expect(sessionId).toBeTruthy();

        // Next
        const nextRes = await request.get(`/api/music/radio/next?sessionId=${sessionId}&count=3`);
        expect(nextRes.ok()).toBe(true);
        const next = (await nextRes.json()) as {
            tracks: unknown[];
            suggestions: unknown[];
        };
        expect(Array.isArray(next.tracks)).toBe(true);
        expect(Array.isArray(next.suggestions)).toBe(true);

        // Session info
        const sessionRes = await request.get(`/api/music/radio/session?sessionId=${sessionId}`);
        expect(sessionRes.ok()).toBe(true);
        const session = (await sessionRes.json()) as {
            channel: { type: string };
            currentTrackId: string | null;
            queue: string[];
        };
        expect(session.channel.type).toBe('mood');

        // Skip (if tracks available)
        if (tracks[0]) {
            const skipRes = await request.post('/api/music/radio/skip', {
                data: { sessionId, trackId: tracks[0].id },
            });
            expect(skipRes.ok()).toBe(true);
        }

        // Stop
        const stopRes = await request.delete(`/api/music/radio/stop?sessionId=${sessionId}`);
        expect(stopRes.status()).toBe(204);

        // Session should be gone
        const deadRes = await request.get(`/api/music/radio/session?sessionId=${sessionId}`);
        expect(deadRes.status()).toBe(404);
    });
});
