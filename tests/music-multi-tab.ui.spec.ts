// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music player across browser tabs (music-tab-sync.ts).
 *
 * Two pages in ONE context are two tabs: they share localStorage and a
 * BroadcastChannel, exactly like tabs of one browser profile. Before the tab
 * coordinator, opening a second tab while the first one played made the new
 * tab resume the same track from the snapshot's stale position — the same song
 * twice, seconds apart (reproduced on preprod 2026-09-29).
 *
 * Media is stubbed like music-crossfade.ui.spec.ts: headless Chromium has no
 * audio device, and what matters here is which tab's player is playing.
 * Assertions read the dev-only `window.__musicPlayerStore` plus the stubbed
 * elements' `paused`, and the user-visible mini-player button and hint.
 */

import { adminTest as test, expect } from './fixtures/auth';
import type { BrowserContext, Page } from '@playwright/test';
import { TEST_MUSIC_TRACK_ID, TEST_MUSIC_TRACK_2_ID } from './global-setup';
import { ensureSeededMusicStreamable, SEEDED_MUSIC_TRACK } from './helpers/music-fixture';
import { gotoHydrated } from './helpers/cold-load';
import { initializeMusicStore } from './helpers/music-startup';

const TRACK: Record<string, unknown> = SEEDED_MUSIC_TRACK;

const TRACK_2: Record<string, unknown> = {
    ...TRACK,
    id: TEST_MUSIC_TRACK_2_ID,
    title: 'Test Track 02',
};

interface PlayerSnapshot {
    trackId: string | null;
    isPlaying: boolean;
    playingElsewhere: boolean;
    currentTimeMs: number;
    /** Stubbed <audio> elements with a source that are not paused. */
    audiblePlayers: number;
}

type StoreWindow = Window & {
    __musicPlayerStore?: {
        subscribe: (cb: (s: Record<string, unknown>) => void) => () => void;
        play: (track: unknown) => Promise<void>;
        pause: () => void;
        seekTo: (ms: number) => void;
        init: () => Promise<void>;
    };
    __testAudioEls?: HTMLMediaElement[];
};

/** Stub media playback and collect the backend's (detached) audio elements. */
async function stubMedia(context: BrowserContext): Promise<void> {
    await context.addInitScript(() => {
        HTMLMediaElement.prototype.play = function () {
            Object.defineProperty(this, 'paused', { get: () => false, configurable: true });
            return Promise.resolve();
        };
        HTMLMediaElement.prototype.pause = function () {
            Object.defineProperty(this, 'paused', { get: () => true, configurable: true });
        };
        // The preload waits for metadata; a stubbed element never loads any.
        const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
            configurable: true,
            get(this: HTMLMediaElement) {
                return srcDescriptor?.get?.call(this) as string;
            },
            set(this: HTMLMediaElement, value: string) {
                srcDescriptor?.set?.call(this, value);
                if (value) setTimeout(() => this.dispatchEvent(new Event('loadedmetadata')), 0);
            },
        });
        Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
            configurable: true,
            get: () => 1,
        });
        const created: HTMLMediaElement[] = [];
        (window as Window & { __testAudioEls?: HTMLMediaElement[] }).__testAudioEls = created;
        const originalCreateElement = document.createElement.bind(document);
        document.createElement = function (
            tagName: string,
            options?: Parameters<typeof originalCreateElement>[1],
        ) {
            const el = originalCreateElement(tagName, options);
            if (String(tagName).toLowerCase() === 'audio') created.push(el as HTMLMediaElement);
            return el;
        } as typeof document.createElement;
    });
}

async function openTab(context: BrowserContext): Promise<Page> {
    const page = await context.newPage();
    await gotoHydrated(page, '/music');
    await page.waitForFunction(() => !!(window as StoreWindow).__musicPlayerStore, null, {
        timeout: 30_000,
    });
    // The store is exposed at import; the layout starts its backend init on
    // mount. init() is idempotent and shares the in-flight run, so this just
    // waits for the one the page started.
    await initializeMusicStore(page);
    return page;
}

async function snapshot(page: Page): Promise<PlayerSnapshot> {
    return page.evaluate(() => {
        const w = window as StoreWindow;
        let s: Record<string, unknown> = {};
        w.__musicPlayerStore?.subscribe((v) => (s = v))();
        const track = s.currentTrack as { id?: string } | null;
        return {
            trackId: track?.id ?? null,
            isPlaying: s.isPlaying === true,
            playingElsewhere: s.playingElsewhere === true,
            currentTimeMs: Number(s.currentTimeMs ?? 0),
            audiblePlayers: (w.__testAudioEls ?? []).filter((el) => el.src && !el.paused).length,
        };
    });
}

async function playIn(page: Page, positionMs = 0, track = TRACK): Promise<void> {
    await page.evaluate(
        async ({ track, positionMs }) => {
            const store = (window as StoreWindow).__musicPlayerStore!;
            await store.play(track);
            if (positionMs > 0) store.seekTo(positionMs);
        },
        { track, positionMs },
    );
    await expect.poll(async () => (await snapshot(page)).isPlaying).toBe(true);
}

function miniPlayerToggle(page: Page) {
    return page
        .locator('.mini-player')
        .getByRole('button', { name: /^(Play|Pause)$/ })
        .first();
}

test.describe('Music player — multiple tabs', () => {
    // A fresh database loses the seeded track's file link to the first library
    // scan, and the real <audio> element then fails on a 404 (see the helper).
    test.beforeAll(async () => {
        await ensureSeededMusicStreamable();
    });

    test.beforeEach(async ({ context }) => {
        await stubMedia(context);
    });

    test('opening a second tab while music plays does not play it twice', async ({ context }) => {
        const a = await openTab(context);
        await playIn(a, 3_000);

        const b = await openTab(context);

        // B shows the same track, paused, lined up with A, and says why.
        await expect.poll(async () => (await snapshot(b)).trackId).toBe(TEST_MUSIC_TRACK_ID);
        const restored = await snapshot(b);
        expect(restored.isPlaying).toBe(false);
        expect(restored.audiblePlayers).toBe(0);
        expect(restored.playingElsewhere).toBe(true);
        expect(restored.currentTimeMs).toBeGreaterThanOrEqual(3_000);
        await expect(b.getByTestId('music-playing-elsewhere')).toBeVisible();
        // The transport reflects what the listener hears: music is playing.
        await expect(miniPlayerToggle(b)).toHaveAccessibleName('Pause');

        // A was not disturbed.
        const playing = await snapshot(a);
        expect(playing.isPlaying).toBe(true);
        expect(playing.audiblePlayers).toBe(1);
    });

    test('"Play here" in the other tab moves playback there, from the same spot', async ({
        context,
    }) => {
        const a = await openTab(context);
        await playIn(a, 3_000);
        const b = await openTab(context);
        await expect(b.getByTestId('music-play-here')).toBeVisible();

        // A moves on while B sits paused; B must pick up from A, not from
        // where it restored.
        await a.evaluate(() => (window as StoreWindow).__musicPlayerStore!.seekTo(6_000));
        await b.getByTestId('music-play-here').click();

        await expect.poll(async () => (await snapshot(b)).isPlaying).toBe(true);
        await expect.poll(async () => (await snapshot(a)).isPlaying).toBe(false);
        // isPlaying is optimistic while a fresh delivery grant/source loads.
        // Wait for the backend element too before asserting audible ownership.
        await expect.poll(async () => (await snapshot(b)).audiblePlayers).toBe(1);
        const [nowA, nowB] = [await snapshot(a), await snapshot(b)];
        expect(nowA.audiblePlayers).toBe(0);
        expect(nowB.audiblePlayers).toBe(1);
        expect(nowB.currentTimeMs).toBeGreaterThanOrEqual(6_000);
        expect(nowB.playingElsewhere).toBe(false);
        await expect(b.getByTestId('music-playing-elsewhere')).toBeHidden();
        await expect(a.getByTestId('music-playing-elsewhere')).toBeVisible();
        // A's transport now reflects the music playing in B.
        await expect(miniPlayerToggle(a)).toHaveAccessibleName('Pause');
    });

    test('starting a track in a fresh tab pauses the playing one', async ({ context }) => {
        const a = await openTab(context);
        await playIn(a);
        const b = await openTab(context);

        await playIn(b);

        await expect.poll(async () => (await snapshot(a)).isPlaying).toBe(false);
        expect((await snapshot(a)).audiblePlayers).toBe(0);
        expect((await snapshot(b)).audiblePlayers).toBe(1);
    });

    test('the "other tab" hint clears when that tab pauses', async ({ context }) => {
        const a = await openTab(context);
        await playIn(a);
        const b = await openTab(context);
        await expect(b.getByTestId('music-playing-elsewhere')).toBeVisible();

        await a.evaluate(() => (window as StoreWindow).__musicPlayerStore!.pause());

        await expect(b.getByTestId('music-playing-elsewhere')).toBeHidden();
    });

    test("closing an idle tab does not overwrite the playing tab's saved session", async ({
        context,
    }) => {
        const a = await openTab(context);
        await playIn(a, 3_000);
        const b = await openTab(context);
        await expect.poll(async () => (await snapshot(b)).trackId).toBe(TEST_MUSIC_TRACK_ID);

        await b.close({ runBeforeUnload: true });

        // The snapshot still says A is playing, so reopening resumes A's
        // session rather than B's paused copy.
        const saved = await a.evaluate(() =>
            JSON.parse(localStorage.getItem('lumastra:music-playback') ?? 'null'),
        );
        expect(saved?.wasPlaying).toBe(true);
        expect(saved?.currentTrack?.id).toBe(TEST_MUSIC_TRACK_ID);
    });

    test('control: a lone tab that reloads mid-song resumes playing', async ({ context }) => {
        const a = await openTab(context);
        await playIn(a, 3_000);

        await a.reload();
        await a.waitForFunction(() => !!(window as StoreWindow).__musicPlayerStore);

        await expect.poll(async () => (await snapshot(a)).isPlaying).toBe(true);
        const resumed = await snapshot(a);
        expect(resumed.trackId).toBe(TEST_MUSIC_TRACK_ID);
        expect(resumed.playingElsewhere).toBe(false);
    });

    test('the other tab follows the playing tab: track changes and a moving position', async ({
        context,
    }) => {
        const a = await openTab(context);
        await playIn(a, 2_000);
        const b = await openTab(context);
        await expect.poll(async () => (await snapshot(b)).trackId).toBe(TEST_MUSIC_TRACK_ID);

        // A moves on to another track: B shows it, without playing it.
        await playIn(a, 0, TRACK_2);
        await expect.poll(async () => (await snapshot(b)).trackId).toBe(TEST_MUSIC_TRACK_2_ID);
        const first = await snapshot(b);
        expect(first.isPlaying).toBe(false);
        expect(first.audiblePlayers).toBe(0);
        await expect(b.getByTestId('music-playing-elsewhere')).toBeVisible();

        // …and its position keeps moving while A plays.
        await expect
            .poll(async () => (await snapshot(b)).currentTimeMs, { timeout: 5_000 })
            .toBeGreaterThan(first.currentTimeMs + 900);

        // "Play here" in B continues A's current track there.
        await b.getByTestId('music-play-here').click();
        await expect.poll(async () => (await snapshot(b)).isPlaying).toBe(true);
        await expect.poll(async () => (await snapshot(a)).isPlaying).toBe(false);
        // isPlaying is optimistic while a fresh delivery grant/source loads.
        // Wait for the backend element too before asserting audible ownership.
        await expect.poll(async () => (await snapshot(b)).audiblePlayers).toBe(1);
        const [nowA, nowB] = [await snapshot(a), await snapshot(b)];
        expect(nowB.trackId).toBe(TEST_MUSIC_TRACK_2_ID);
        expect(nowB.audiblePlayers).toBe(1);
        expect(nowA.audiblePlayers).toBe(0);
    });

    test('seeking in the other tab moves the playing tab, and the bar stays put', async ({
        context,
    }) => {
        const a = await openTab(context);
        await playIn(a, 1_000);
        const b = await openTab(context);
        await expect(b.getByTestId('music-playing-elsewhere')).toBeVisible();

        await b.evaluate(() => (window as StoreWindow).__musicPlayerStore!.seekTo(6_000));

        await expect
            .poll(async () => (await snapshot(a)).currentTimeMs, { timeout: 5_000 })
            .toBeGreaterThanOrEqual(6_000);
        await b.waitForTimeout(1_200); // past the mirror ticks
        const nowB = await snapshot(b);
        expect(nowB.currentTimeMs).toBeGreaterThanOrEqual(6_000);
        expect(nowB.isPlaying).toBe(false);
        expect((await snapshot(a)).isPlaying).toBe(true);
    });

    test('Pause in the other tab pauses the music where it plays; Play then plays it here', async ({
        context,
    }) => {
        const a = await openTab(context);
        await playIn(a, 2_000);
        const b = await openTab(context);
        await expect(miniPlayerToggle(b)).toHaveAccessibleName('Pause');

        await miniPlayerToggle(b).click();
        await expect.poll(async () => (await snapshot(a)).isPlaying).toBe(false);
        expect((await snapshot(b)).isPlaying).toBe(false);
        await expect(miniPlayerToggle(b)).toHaveAccessibleName('Play');
        await expect(b.getByTestId('music-playing-elsewhere')).toBeHidden();

        await miniPlayerToggle(b).click();
        await expect.poll(async () => (await snapshot(b)).isPlaying).toBe(true);
        expect((await snapshot(a)).isPlaying).toBe(false);
    });

    test("volume in the other tab sets the playing tab's volume", async ({ context }) => {
        const a = await openTab(context);
        await playIn(a, 1_000);
        const b = await openTab(context);
        await expect(b.getByTestId('music-playing-elsewhere')).toBeVisible();
        const volumeOf = (p: Page) =>
            p.evaluate(() => {
                let v = -1;
                (window as StoreWindow).__musicPlayerStore!.subscribe(
                    (s) => (v = Number(s.volume)),
                )();
                return v;
            });

        await b.evaluate(() =>
            (
                (window as StoreWindow).__musicPlayerStore as unknown as {
                    setVolume: (v: number) => void;
                }
            ).setVolume(0.25),
        );

        await expect.poll(() => volumeOf(a)).toBe(0.25);
        // Polled, not read once: b mirrors a's broadcasts, and one a sent before it
        // applied the change can land on b after a already shows 0.25 (CI probe
        // 38455172417 read 0.8 there). b must end up at 0.25; one stuck at 0.8 fails.
        await expect.poll(() => volumeOf(b)).toBe(0.25);
        expect((await snapshot(a)).isPlaying).toBe(true);
    });
});
