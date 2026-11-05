// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Web music player regression e2e — real audio, real Web Audio crossfade engine.
 * Harness: music-harness.ts. Config + how to run: tests/playwright/playwright.music.config.ts.
 *
 * What a scenario asserts is what a listener hears (the output analyser, one sine
 * tone per fixture track) and what the UI shows; the store is only read, and only
 * used to set a scene where the UI path is not the thing under test (queue edits
 * go through the same public store methods the queue panel calls).
 *
 * @pr = the per-PR subset (cross-tab mirroring + crossfade).
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
    AUDIBLE_DB,
    CdpBrowser,
    identityHeaders,
    prepareContext,
    proxy,
    sleep,
    Tab,
    type Frame,
    type Sample,
    type StoreView,
} from './music-harness';
import { readCatalog, XF, type Catalog, type SeedTrack } from './music-seed';
import { webUrl } from './music-env';
import { PlaybackStartResponseSchema } from '../../src/lib/schemas/playback-start';

const cat: Catalog = readCatalog();

const pageLog: string[] = [];

test.beforeEach(async ({ context, request }) => {
    await proxy.reset();
    // Baseline preferences for every test (a radio turns autoplay on and keeps it).
    const prefs = await request.patch('/api/me/playback-preferences', {
        headers: { Origin: webUrl() },
        data: {
            musicCrossfadeEnabled: true,
            musicCrossfadeBeats: XF.beats,
            musicAutoplayEnabled: false,
        },
    });
    expect(prefs.ok()).toBe(true);
    await prepareContext(context);
    pageLog.length = 0;
    const t0 = Date.now();
    const watch = (p: Page): void => {
        const tag = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
        p.on('console', (m) => {
            if (
                ['error', 'warning'].includes(m.type()) ||
                /\[(PWA|Crossfade|MusicPlayer)/.test(m.text())
            ) {
                pageLog.push(`${tag()} ${m.type()} ${m.text().slice(0, 300)}`);
            }
        });
        p.on('framenavigated', (f) => {
            if (f === p.mainFrame()) pageLog.push(`${tag()} navigated ${f.url()}`);
        });
        p.on('crash', () => pageLog.push(`${tag()} crash`));
    };
    context.pages().forEach(watch);
    context.on('page', watch);
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixtures arg
test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('page-log', { body: pageLog.join('\n'), contentType: 'text/plain' });
    }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type StoreWindow = Window & {
    __musicPlayerStore: {
        seekTo: (ms: number) => void;
        skip: () => void;
        addToQueue: (t: unknown) => void;
        removeFromQueue: (id: string) => void;
        reorderQueue: (items: unknown[]) => void;
        subscribe: (cb: (s: Record<string, unknown>) => void) => () => void;
    };
};

/** Open an album page and press "Play All" (the real UI path). */
async function playAlbum(tab: Tab, albumId: string, firstTrack: SeedTrack): Promise<void> {
    await tab.goto(`/music/albums/${albumId}`);
    await tab.page.getByRole('button', { name: 'Play All' }).click();
    await expect
        .poll(
            async () => {
                const v = await tab.view();
                return v.isPlaying && v.trackId === firstTrack.id;
            },
            { timeout: 20_000 },
        )
        .toBe(true);
}

async function waitAudible(tab: Tab, hzIndex: number, timeout = 10_000): Promise<void> {
    await expect
        .poll(async () => (await tab.sample()).tones[hzIndex], { timeout })
        .toBeGreaterThan(AUDIBLE_DB);
}

function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(2)}s`;
}

/** First index where `pred` holds, or -1. */
function firstIdx<T>(xs: T[], pred: (x: T) => boolean, from = 0): number {
    for (let i = from; i < xs.length; i++) if (pred(xs[i])) return i;
    return -1;
}

/** Longest stretch (ms) where the store says playing but nothing is audible. */
function longestSilentWhilePlaying(samples: Sample[]): number {
    let worst = 0;
    let start: number | null = null;
    for (const s of samples) {
        const silent = s.s?.isPlaying && s.rms < -60;
        if (silent) start ??= s.t;
        else start = null;
        if (start !== null) worst = Math.max(worst, s.t - start);
    }
    return worst;
}

function minimalTrack(t: SeedTrack, c: Catalog): Record<string, unknown> {
    const artist = Object.values(c.artists).find((a) => a.id === t.artistId);
    const album = Object.values(c.albums).find((a) => a.id === t.albumId);
    return {
        id: t.id,
        title: t.title,
        artist: artist?.name,
        album: album?.title,
        duration: t.seconds,
        albumId: t.albumId,
        artistId: t.artistId,
        mediaType: 'track',
    };
}

async function attach(name: string, data: unknown): Promise<void> {
    await test.info().attach(name, {
        body: JSON.stringify(data, null, 1),
        contentType: 'application/json',
    });
}

// ===========================================================================
// 1. Cross-tab mirroring
// ===========================================================================

test.describe('1. cross-tab mirroring @pr', () => {
    const LONG_HZ = () => cat.long.map((t) => t.hz);

    async function playingPair(context: BrowserContext): Promise<{ a: Tab; b: Tab }> {
        const a = await Tab.open(context, 'A');
        await a.setTones(LONG_HZ());
        await playAlbum(a, cat.albums.long.id, cat.long[0]);
        await waitAudible(a, 0);
        const b = await Tab.open(context, 'B');
        await b.setTones(LONG_HZ());
        await expect(b.elsewhereHint()).toBeVisible({ timeout: 10_000 });
        return { a, b };
    }

    test('B mirrors track, queue and moving position; pause, volume and seek in B act on A', async ({
        context,
    }) => {
        const { a, b } = await playingPair(context);

        // Track + queue + position.
        await expect.poll(async () => (await b.view()).trackId).toBe(cat.long[0].id);
        const [va, vb] = await Promise.all([a.view(), b.view()]);
        expect(vb.queueIds).toEqual(va.queueIds);
        expect(vb.queueIds).toEqual([cat.long[1].id, cat.long[2].id]);
        expect(vb.isPlaying).toBe(false);
        expect(vb.playingElsewhere).toBe(true);
        expect(Math.abs(vb.currentTimeMs - va.currentTimeMs)).toBeLessThan(1_500);
        // B is silent: the music plays in A only.
        expect((await b.sample()).els.filter((e) => !e.paused)).toHaveLength(0);
        // The mirrored position moves.
        const p0 = (await b.view()).currentTimeMs;
        await sleep(2_500);
        const p1 = (await b.view()).currentTimeMs;
        expect(p1 - p0).toBeGreaterThan(1_500);
        expect(p1 - p0).toBeLessThan(4_000);
        // The transport says what the listener hears.
        await expect(b.toggle()).toHaveAccessibleName('Pause');

        // Volume in B -> A's level drops (measured at A's output).
        const before = (await a.sample()).tones[0];
        await b.volume().fill('0.25');
        await expect.poll(async () => (await a.view()).volume).toBeCloseTo(0.25, 2);
        await expect
            .poll(async () => (await a.sample()).tones[0], { timeout: 5_000 })
            .toBeLessThan(before - 6);
        await b.volume().fill('1');
        await expect.poll(async () => (await a.view()).volume).toBeCloseTo(1, 2);

        // Seek in B (click on the bar) -> A's deck jumps there; B stays a mirror.
        await b.clickSeek(0.6);
        const target = 0.6 * cat.long[0].seconds * 1000;
        await expect
            .poll(async () => (await a.sample()).els.find((e) => !e.paused)?.t ?? 0, {
                timeout: 5_000,
            })
            .toBeGreaterThan(target / 1000 - 3);
        const afterSeek = await a.view();
        expect(Math.abs(afterSeek.currentTimeMs - target)).toBeLessThan(4_000);
        expect(afterSeek.isPlaying).toBe(true);
        await sleep(1_200); // past a mirror tick
        const bAfter = await b.view();
        expect(Math.abs(bAfter.currentTimeMs - afterSeek.currentTimeMs)).toBeLessThan(2_500);
        expect(bAfter.isPlaying).toBe(false);

        // Pause in B -> A pauses and goes silent.
        await b.toggle().click();
        await expect.poll(async () => (await a.view()).isPlaying).toBe(false);
        await expect
            .poll(async () => (await a.sample()).tones[0], { timeout: 5_000 })
            .toBeLessThan(AUDIBLE_DB);
        await expect(b.toggle()).toHaveAccessibleName('Play');
        await expect(b.elsewhereHint()).toBeHidden();
    });

    test('"Play here" in B moves playback to B, from where it was; A stops', async ({
        context,
    }) => {
        const { a, b } = await playingPair(context);
        await a.page.evaluate(() =>
            (window as unknown as StoreWindow).__musicPlayerStore.seekTo(40_000),
        );
        expect((await a.view()).autoplayEnabled, 'A autoplay').toBe(false);
        expect((await b.view()).autoplayEnabled, 'B autoplay').toBe(false);
        await expect.poll(async () => (await b.view()).currentTimeMs).toBeGreaterThan(39_000);
        const handAt = (await a.view()).currentTimeMs;

        await b.playHere().click();

        await expect.poll(async () => (await b.view()).isPlaying).toBe(true);
        await expect.poll(async () => (await a.view()).isPlaying).toBe(false);
        await waitAudible(b, 0);
        await expect
            .poll(async () => (await a.sample()).tones[0], { timeout: 5_000 })
            .toBeLessThan(AUDIBLE_DB);
        const vb = await b.view();
        expect(vb.trackId).toBe(cat.long[0].id);
        expect(vb.currentTimeMs).toBeGreaterThan(handAt - 1_000);
        expect(vb.currentTimeMs).toBeLessThan(handAt + 6_000);
        expect(vb.queueIds, `B queue: ${vb.queueTitles.join(', ')}; A autoplay pref`).toEqual([
            cat.long[1].id,
            cat.long[2].id,
        ]);
        await expect(b.elsewhereHint()).toBeHidden();
        await expect(a.elsewhereHint()).toBeVisible();
    });

    test('closing the playing tab clears "playing elsewhere" in B at once', async ({ context }) => {
        const { a, b } = await playingPair(context);
        const t0 = Date.now();
        await a.page.close({ runBeforeUnload: true });
        await expect(b.elsewhereHint()).toBeHidden({ timeout: 3_000 });
        expect(Date.now() - t0).toBeLessThan(3_000);
        await expect(b.toggle()).toHaveAccessibleName('Play');
    });

    test('a crashed playing tab stops showing as playing within ~8 s and does not skip ahead', async ({
        context,
    }) => {
        const { a, b } = await playingPair(context);
        await b.startRec(250);
        const cdp = await context.newCDPSession(a.page);
        const crashAtPos = (await a.view()).currentTimeMs;
        const crashAt = Date.now();
        void cdp.send('Page.crash').catch(() => {});
        // B must survive A's crash (separate renderer).
        await sleep(500);
        expect((await b.view()).trackId).toBe(cat.long[0].id);

        await expect(b.elsewhereHint()).toBeHidden({ timeout: 15_000 });
        const clearedAfter = Date.now() - crashAt;
        const rec = await b.stopRec();
        await attach(
            'b-samples',
            rec.map((s) => ({ t: s.t, e: s.s?.playingElsewhere, p: s.s?.currentTimeMs })),
        );
        // Heartbeat 3 s, expiry 8 s + 0.3 s probe (music-tab-sync.ts).
        expect(clearedAfter, `hint cleared ${seconds(clearedAfter)} after the crash`).toBeLessThan(
            12_000,
        );
        expect((await b.view()).isPlaying).toBe(false);
        await expect(b.toggle()).toHaveAccessibleName('Play');

        // The shown position is where the music stopped, not "crash + 8 s of play".
        const pos = (await b.view()).currentTimeMs;
        expect(pos, `B shows ${seconds(pos)}, A crashed at ${seconds(crashAtPos)}`).toBeLessThan(
            crashAtPos + 4_000,
        );
        await sleep(2_000);
        expect((await b.view()).currentTimeMs).toBe(pos);
    });

    test('queue edits in B (add, remove, reorder) edit the queue A plays', async ({ context }) => {
        const { a, b } = await playingPair(context);
        const queueOf = async (t: Tab) => (await t.view()).queueIds;

        // remove long[2]
        const itemIds = await b.page.evaluate(() => {
            let s: Record<string, unknown> = {};
            (window as unknown as StoreWindow).__musicPlayerStore.subscribe((v) => (s = v))();
            return (s.queue as { id: string; track: { id: string } }[]).map((q) => [
                q.id,
                q.track.id,
            ]);
        });
        const removeItem = itemIds.find(([, tid]) => tid === cat.long[2].id)![0];
        await b.page.evaluate(
            (id) => (window as unknown as StoreWindow).__musicPlayerStore.removeFromQueue(id),
            removeItem,
        );
        await expect.poll(() => queueOf(a)).toEqual([cat.long[1].id]);

        // add xfade[0]
        await b.page.evaluate(
            (t) => (window as unknown as StoreWindow).__musicPlayerStore.addToQueue(t),
            minimalTrack(cat.xfade[0], cat),
        );
        await expect.poll(() => queueOf(a)).toEqual([cat.long[1].id, cat.xfade[0].id]);
        await expect.poll(() => queueOf(b)).toEqual([cat.long[1].id, cat.xfade[0].id]);

        // reorder: xfade[0] first
        await b.page.evaluate(() => {
            const st = (window as unknown as StoreWindow).__musicPlayerStore;
            let s: Record<string, unknown> = {};
            st.subscribe((v) => (s = v))();
            st.reorderQueue([...(s.queue as unknown[])].reverse());
        });
        await expect.poll(() => queueOf(a)).toEqual([cat.xfade[0].id, cat.long[1].id]);
        await expect.poll(() => queueOf(b)).toEqual([cat.xfade[0].id, cat.long[1].id]);
        // A kept playing through all of it.
        expect((await a.view()).isPlaying).toBe(true);
        expect((await a.view()).trackId).toBe(cat.long[0].id);
    });
});

// ===========================================================================
// 2. Crossfade
// ===========================================================================

const XF_HZ = () => cat.xfade.map((t) => t.hz);

/** Play the crossfade album, seek near the outro, record through the fade. */
async function recordFade(
    tab: Tab,
    opts: { from: SeedTrack; seekToMs: number; untilMs: number; frames?: boolean },
): Promise<{ rec: Sample[]; frames: Frame[] }> {
    await tab.page.evaluate(
        (ms) => (window as unknown as StoreWindow).__musicPlayerStore.seekTo(ms),
        opts.seekToMs,
    );
    await tab.startRec(100);
    if (opts.frames) await tab.startFrames();
    await sleep(opts.untilMs);
    const frames = opts.frames ? await tab.stopFrames() : [];
    const rec = await tab.stopRec();
    return { rec, frames };
}

interface FadeFacts {
    /** index of the first sample with isCrossfading */
    startIdx: number;
    endIdx: number;
    /** outgoing position (store) right before the fade */
    outgoingPosMs: number;
    /** first sample where the incoming tone is audible */
    incomingAudibleIdx: number;
    /** last sample where the outgoing tone is audible */
    outgoingLastIdx: number;
    bothAudible: number;
}

function fadeFacts(rec: Sample[], outIdx: number, inIdx: number, outId: string): FadeFacts {
    const startIdx = firstIdx(rec, (s) => !!s.s?.isCrossfading);
    const endIdx = startIdx < 0 ? -1 : firstIdx(rec, (s) => !s.s?.isCrossfading, startIdx);
    const before = rec.slice(0, Math.max(0, startIdx)).filter((s) => s.s?.trackId === outId);
    const incomingAudibleIdx = firstIdx(rec, (s) => s.tones[inIdx] > AUDIBLE_DB);
    let outgoingLastIdx = -1;
    rec.forEach((s, i) => {
        if (s.tones[outIdx] > AUDIBLE_DB) outgoingLastIdx = i;
    });
    return {
        startIdx,
        endIdx,
        outgoingPosMs: before.length ? before[before.length - 1].s!.currentTimeMs : -1,
        incomingAudibleIdx,
        outgoingLastIdx,
        bothAudible: rec.filter((s) => s.tones[outIdx] > AUDIBLE_DB && s.tones[inIdx] > AUDIBLE_DB)
            .length,
    };
}

test.describe('2. crossfade @pr', () => {
    test('the next track starts at the fade point; the seek bar hands off without snapping back or teleporting', async ({
        page,
    }) => {
        const tab = new Tab(page, 'A');
        await tab.goto('/music');
        await tab.setTones(XF_HZ());
        await playAlbum(tab, cat.albums.xfade.id, cat.xfade[0]);
        await waitAudible(tab, 0);

        const { rec, frames } = await recordFade(tab, {
            from: cat.xfade[0],
            seekToMs: 70_000,
            untilMs: 18_000,
            frames: true,
        });
        await attach('samples', rec);
        await attach('frames', frames);
        const f = fadeFacts(rec, 0, 1, cat.xfade[0].id);
        await attach('fade', f);

        // The fade started, at the outro (30 s; downbeat-aligned, so up to a bar late).
        expect(f.startIdx, 'no crossfade happened').toBeGreaterThan(0);
        expect(f.outgoingPosMs).toBeGreaterThan(XF.outroStartMs - 600);
        expect(f.outgoingPosMs).toBeLessThan(XF.outroStartMs + 2_600);
        // The incoming track becomes audible at the fade start, not before.
        expect(f.incomingAudibleIdx).toBeGreaterThanOrEqual(f.startIdx - 2);
        // A blend, not a cut: both tones audible together for a while…
        expect(f.bothAudible * 100, 'ms with both tracks audible').toBeGreaterThan(3_000);
        // …and the outgoing track is not cut early: audible for most of the 8 s fade.
        const outLastMs = rec[f.outgoingLastIdx].t - rec[f.startIdx].t;
        expect(outLastMs, 'outgoing audible after fade start').toBeGreaterThan(XF.fadeMs * 0.6);
        // The fade ends, with the incoming track playing alone.
        expect(f.endIdx).toBeGreaterThan(f.startIdx);
        const last = rec[rec.length - 1];
        expect(last.s?.trackId).toBe(cat.xfade[1].id);
        expect(last.s?.isPlaying).toBe(true);
        expect(last.tones[1]).toBeGreaterThan(AUDIBLE_DB);
        expect(last.tones[0]).toBeLessThan(AUDIBLE_DB);
        // No silence anywhere in the transition.
        expect(longestSilentWhilePlaying(rec)).toBeLessThan(500);

        // The store promotes the incoming track at fade start.
        const promoted = firstIdx(rec, (s) => s.s?.trackId === cat.xfade[1].id);
        expect(Math.abs(promoted - f.startIdx)).toBeLessThanOrEqual(5);

        // Seek bar: one hand-off from the old position (~0.67) to the new (~0),
        // then it only moves forward — no snap back to the old position.
        const xf = frames.filter((fr) => fr.fill !== null);
        const hand = firstIdx(xf, (fr) => fr.fill! < 0.3);
        expect(hand, 'fill never handed off').toBeGreaterThan(0);
        expect(xf[hand - 1].fill!).toBeGreaterThan(0.6);
        const after = xf.slice(hand);
        const snapBack = after.find((fr) => fr.fill! > 0.45);
        expect(snapBack, `fill snapped back to ${snapBack?.fill}`).toBeUndefined();
        for (let i = 1; i < after.length; i++) {
            expect(after[i].fill! + 0.02).toBeGreaterThanOrEqual(after[i - 1].fill!);
        }
        // The dissolve layer shows at the hand-off and is gone within a second.
        const dissolve = frames.filter((fr) => fr.oldFill);
        expect(dissolve.length).toBeGreaterThan(0);
        expect(dissolve[dissolve.length - 1].t - dissolve[0].t).toBeLessThan(1_200);
        // The bar never teleports (the info strip slides; it never jumps its height).
        let maxJump = 0;
        for (let i = 1; i < frames.length; i++) {
            const [p, c] = [frames[i - 1].top, frames[i].top];
            if (p !== null && c !== null) maxJump = Math.max(maxJump, Math.abs(c - p));
        }
        const tops = frames.map((fr) => fr.top).filter((x): x is number => x !== null);
        await attach('seekbar-top', {
            maxJump,
            min: Math.min(...tops),
            max: Math.max(...tops),
        });
        expect(
            Math.max(...tops) - Math.min(...tops),
            'the strip never moved the bar',
        ).toBeGreaterThan(10);
        // The strip's slide+fade keyframes are valid CSS (a missing ';' once made
        // Chromium drop both the min-height and the fade).
        expect(pageLog.filter((l) => l.includes('Invalid keyframe'))).toEqual([]);
        // A glide spreads the strip's height over many frames (380 ms ease); a
        // teleport moves the whole height in one.
        const travel = Math.max(...tops) - Math.min(...tops);
        expect(maxJump, `largest per-frame seek bar move (px) of ${travel} px`).toBeLessThan(
            travel * 0.5,
        );
    });

    test('a dj-outro boundary fades at the outro, not at the later vocal end', async ({ page }) => {
        const tab = new Tab(page, 'A');
        await tab.goto('/music');
        await tab.setTones(XF_HZ());
        await playAlbum(tab, cat.albums.xfade.id, cat.xfade[0]);
        // To track 3 (dj-outro, vocals "end" at 79 s).
        for (let i = 0; i < 2; i++) {
            await page.evaluate(() => (window as unknown as StoreWindow).__musicPlayerStore.skip());
            await sleep(500);
        }
        await expect
            .poll(async () => (await tab.view()).trackId, { timeout: 15_000 })
            .toBe(cat.xfade[2].id);
        const { rec } = await recordFade(tab, {
            from: cat.xfade[2],
            seekToMs: 71_000,
            untilMs: 8_000,
        });
        const f = fadeFacts(rec, 2, 3, cat.xfade[2].id);
        await attach('fade', f);
        expect(f.startIdx, 'no crossfade happened').toBeGreaterThan(0);
        expect(f.outgoingPosMs).toBeLessThan(XF.outroStartMs + 2_600);
    });

    for (const [label, fault] of [
        ['dead incoming stream (404)', { status: 404, count: 100 }],
        ['incoming stream refused once (401, like an expired token)', { status: 401, count: 1 }],
    ] as const) {
        test(`${label}: the old track keeps playing or ends cleanly — never a silence lock`, async ({
            page,
        }) => {
            const tab = new Tab(page, 'A');
            await tab.goto('/music');
            await tab.setTones(XF_HZ());
            // Armed before anything can prefetch the next track.
            await proxy.fault({
                match: `/tracks/${cat.xfade[1].id}/stream`,
                kind: 'status',
                ...fault,
            });
            await playAlbum(tab, cat.albums.xfade.id, cat.xfade[0]);
            await waitAudible(tab, 0);
            const { rec } = await recordFade(tab, {
                from: cat.xfade[0],
                seekToMs: 72_000,
                untilMs: 26_000,
            });
            await attach('samples', rec);
            await attach('stream-log', await proxy.log(cat.xfade[1].id));
            await attach('plays', await tab.plays());

            // The fault really hit.
            const hits = (await proxy.log(`/tracks/${cat.xfade[1].id}/stream`)).filter(
                (e) => e.fault,
            );
            expect(hits.length).toBeGreaterThan(0);

            // Never "playing" over silence for more than a moment.
            const lock = longestSilentWhilePlaying(rec);
            expect(lock, 'longest silence while the player says playing (ms)').toBeLessThan(2_000);

            // The outgoing track was not cut into silence at the fade point: it stays
            // audible to (near) its end, unless something else is audible instead.
            const fadeAt = firstIdx(
                rec,
                (s) =>
                    (s.s?.currentTimeMs ?? 0) >= XF.outroStartMs &&
                    s.s?.trackId === cat.xfade[0].id,
            );
            const outEnd = rec.reduce((acc, s, i) => (s.tones[0] > AUDIBLE_DB ? i : acc), -1);
            const anyAudibleAfter = rec
                .slice(Math.max(0, fadeAt))
                .filter((s) => s.rms > -60).length;
            const outcome = {
                outgoingAudibleUntilPos: rec[outEnd]?.els.find((e) =>
                    e.src.startsWith(cat.xfade[0].id),
                )?.t,
                final: rec[rec.length - 1].s,
                lockMs: lock,
                audibleSamplesAfterFadePoint: anyAudibleAfter,
            };
            await attach('outcome', outcome);
            const final = rec[rec.length - 1];
            if (final.s?.isPlaying) {
                // Still playing: it must be audible, and not the dead track.
                expect(final.rms).toBeGreaterThan(-60);
            }
            if (fault.status === 404) {
                // A dead track is passed over: the session goes on with track 3.
                const heard3 = rec.some((s) => s.tones[2] > AUDIBLE_DB);
                expect(heard3, 'track 3 never played after the dead track 2').toBe(true);
                expect(final.s?.trackId).toBe(cat.xfade[2].id);
            }
            if (fault.status === 401 && fault.count === 1) {
                // A one-off refusal: the next track must still get played.
                const heard = rec.some((s) => s.tones[1] > AUDIBLE_DB);
                expect(heard, 'track 2 never became audible after a single 401').toBe(true);
            }
        });
    }
});

// ===========================================================================
// 3. Range reconnect
// ===========================================================================

test.describe('3. range reconnect', () => {
    // The legacy /music/stream-token mint was removed with unified playback
    // starts. Exercise the public start and its returned URL: an <audio> element
    // must be able to fetch and reconnect using only that URL's grant.
    const streamTest = test.extend<{ transcodedV1Url: string }>({
        transcodedV1Url: async ({ request }, use) => {
            const created = await request.post('/api/me/pats', {
                headers: { Origin: webUrl() },
                data: {
                    name: `music-range-e2e ${Date.now()}`,
                    scopes: ['read', 'write'],
                    expiresInDays: 1,
                },
            });
            expect(created.status(), await created.text()).toBe(201);
            const pat = (await created.json()) as { id: string; token: string };
            let sessionId: string | undefined;
            try {
                const response = await request.post('/api/v1/play-sessions', {
                    headers: {
                        Authorization: `Bearer ${pat.token}`,
                        'X-Forwarded-User': '',
                        'X-Forwarded-Groups': '',
                    },
                    data: {
                        mediaId: cat.flac.id,
                        deviceId: 'music-range-e2e',
                        audio: { format: 'mp3', bitrateKbps: 128 },
                    },
                });
                expect(response.status(), await response.text()).toBe(201);
                expect(response.headers()['content-type']).toContain('application/json');
                const start = PlaybackStartResponseSchema.parse(await response.json());
                sessionId = start.playbackSessionId;
                expect(start.kind).toBe('music');
                if (start.delivery.kind !== 'file') throw new Error('Expected music file delivery');
                const url = new URL(start.delivery.url, webUrl());
                expect(url.pathname).toBe(`/api/v1/music/tracks/${cat.flac.id}/stream`);
                expect(url.searchParams.get('format')).toBe('mp3');
                expect(url.searchParams.get('bitrateKbps')).toBe('128');
                expect(url.searchParams.get('grant')).toBe(start.grant.token);
                await use(start.delivery.url);
            } finally {
                try {
                    if (sessionId) {
                        const cancelled = await request.delete(`/api/play-sessions/${sessionId}`, {
                            headers: { Origin: webUrl() },
                        });
                        expect(cancelled.status(), await cancelled.text()).toBe(204);
                    }
                } finally {
                    const revoked = await request.delete(`/api/me/pats/${pat.id}`, {
                        headers: { Origin: webUrl() },
                    });
                    expect(revoked.ok(), await revoked.text()).toBe(true);
                }
            }
        },
    });

    streamTest(
        'transcoded v1 stream: a Range request returns exactly the rest of the encode',
        async ({ page, transcodedV1Url: url }) => {
            await page.goto('/music');
            const res = await page.evaluate(async (u) => {
                const hex = async (r: Response) => {
                    const b = new Uint8Array(await r.arrayBuffer());
                    let h = 0;
                    for (const x of b) h = (h * 31 + x) >>> 0;
                    return { len: b.length, hash: h, head: Array.from(b.slice(0, 4)) };
                };
                const full = await fetch(u);
                const fullInfo = {
                    status: full.status,
                    type: full.headers.get('content-type'),
                    ...(await hex(full)),
                };
                const N = 200_000;
                const part = await fetch(u, { headers: { Range: `bytes=${N}-` } });
                const partBytes = new Uint8Array(await part.arrayBuffer());
                const again = await fetch(u);
                const all = new Uint8Array(await again.arrayBuffer());
                const tail = all.slice(N);
                let same = tail.length === partBytes.length;
                for (let i = 0; same && i < tail.length; i++) same = tail[i] === partBytes[i];
                return {
                    full: fullInfo,
                    part: {
                        status: part.status,
                        cr: part.headers.get('content-range'),
                        len: partBytes.length,
                    },
                    totalAgain: all.length,
                    same,
                };
            }, url);
            await attach('range', res);
            expect(res.full.status).toBe(200);
            expect(res.full.type).toContain('audio/mpeg');
            expect(res.part.status).toBe(206);
            expect(res.part.cr).toBe(`bytes 200000-${res.totalAgain - 1}/${res.totalAgain}`);
            expect(res.same, 'ranged bytes equal the tail of the full encode').toBe(true);
        },
    );

    streamTest(
        'transcoded v1 stream in an <audio> element: a dropped connection resumes from where it was',
        async ({ page, transcodedV1Url: url }) => {
            await page.goto('/music');
            const path = new URL(url, webUrl()).pathname;
            // ~128 kbit/s: 250 kB is ~15 s of a 60 s track.
            await proxy.fault({ match: path, kind: 'cut', afterBytes: 250_000, count: 1 });
            await page.evaluate((u) => {
                const el = new Audio(u);
                (window as unknown as { __rangeEl: HTMLAudioElement }).__rangeEl = el;
                const times: number[] = [];
                (window as unknown as { __rangeTimes: number[] }).__rangeTimes = times;
                el.addEventListener('timeupdate', () => times.push(el.currentTime));
                el.playbackRate = 4; // reach the cut quickly; the server encodes ahead anyway
                void el.play();
            }, url);
            await expect
                .poll(
                    () =>
                        page.evaluate(
                            () =>
                                (window as unknown as { __rangeEl: HTMLAudioElement }).__rangeEl
                                    .currentTime,
                        ),
                    { timeout: 40_000 },
                )
                .toBeGreaterThan(30);
            const st = await page.evaluate(() => {
                const w = window as unknown as {
                    __rangeEl: HTMLAudioElement;
                    __rangeTimes: number[];
                };
                return { err: w.__rangeEl.error?.code ?? null, times: w.__rangeTimes };
            });
            const log = await proxy.log(path);
            await attach('proxy-log', log);
            expect(st.err).toBeNull();
            expect(log.some((e) => e.fault === 'cut')).toBe(true);
            // The reconnect asked for the rest, and got it.
            const resumed = log.filter((e) => !e.fault && e.range && !/^bytes=0-/.test(e.range));
            expect(resumed.length, 'a ranged re-request after the drop').toBeGreaterThan(0);
            expect(resumed[0].status).toBe(206);
            // Playback never restarted from the top after passing the cut.
            const passed = firstIdx(st.times, (t) => t > 16);
            expect(passed).toBeGreaterThan(0);
            expect(Math.min(...st.times.slice(passed))).toBeGreaterThan(10);
        },
    );

    test('web player: a dropped stream mid-track resumes near the position, no replay', async ({
        page,
    }) => {
        const tab = new Tab(page, 'A');
        await tab.goto('/music');
        await tab.setTones(cat.long.map((t) => t.hz));
        const path = `/tracks/${cat.long[0].id}/stream`;
        // 96 kbit/s ≈ 12 kB/s: cut ~25 s in.
        await proxy.fault({ match: path, kind: 'cut', afterBytes: 300_000, count: 1 });
        await playAlbum(tab, cat.albums.long.id, cat.long[0]);
        await tab.startRec(250);
        // Chromium buffers ahead, so the drop lands early; play through it.
        await page.evaluate(() =>
            (window as unknown as StoreWindow).__musicPlayerStore.seekTo(20_000),
        );
        await expect
            .poll(async () => (await tab.view()).currentTimeMs, { timeout: 30_000 })
            .toBeGreaterThan(35_000);
        const rec = await tab.stopRec();
        const log = await proxy.log(path);
        await attach('proxy-log', log);
        await attach(
            'samples',
            rec.map((s) => ({ t: s.t, p: s.s?.currentTimeMs, rms: s.rms })),
        );
        expect(log.some((e) => e.fault === 'cut')).toBe(true);
        const v = await tab.view();
        expect(v.trackId).toBe(cat.long[0].id);
        expect(v.isPlaying).toBe(true);
        // Monotonic after the seek: no replay from the start.
        const after = rec.filter((s) => (s.s?.currentTimeMs ?? 0) > 19_000);
        expect(Math.min(...after.map((s) => s.s!.currentTimeMs))).toBeGreaterThan(18_000);
        expect(longestSilentWhilePlaying(rec)).toBeLessThan(2_000);
    });
});

// ===========================================================================
// 4. Hidden tab crossfade
// ===========================================================================

test.describe('4. hidden tab', () => {
    test('a genuinely hidden tab still crossfades: gradual, on time, no hard swap', async () => {
        const cdp = await CdpBrowser.launch();
        try {
            const ctx = cdp.context;
            await ctx.setExtraHTTPHeaders(identityHeaders());
            await prepareContext(ctx);
            const page = await ctx.newPage();
            await page.setViewportSize({ width: 1280, height: 800 });
            const tab = new Tab(page, 'hidden');
            await page.goto(`${webUrl()}/music`);
            await tab.goto(`${webUrl()}/music`);
            await tab.setTones(XF_HZ());
            await tab.goto(`${webUrl()}/music/albums/${cat.albums.xfade.id}`);
            await page.getByRole('button', { name: 'Play All' }).click();
            await expect
                .poll(async () => (await tab.view()).trackId, { timeout: 20_000 })
                .toBe(cat.xfade[0].id);
            await waitAudible(tab, 0);
            await page.evaluate(() =>
                (window as unknown as StoreWindow).__musicPlayerStore.seekTo(69_000),
            );
            await tab.startRec(200);
            const restore = await cdp.hideOthers();
            await sleep(18_000);
            await restore();
            await page.bringToFront().catch(() => {});
            const rec = await tab.stopRec();
            await attach('samples', rec);

            const hidden = rec.filter((s) => s.vis === 'hidden');
            expect(hidden.length, 'the tab was really hidden').toBeGreaterThan(5);
            const f = fadeFacts(hidden, 0, 1, cat.xfade[0].id);
            await attach('fade', f);
            expect(f.startIdx, 'no crossfade while hidden').toBeGreaterThan(0);
            expect(f.outgoingPosMs).toBeGreaterThan(XF.outroStartMs - 1_500);
            expect(f.outgoingPosMs).toBeLessThan(XF.outroStartMs + 3_000);
            // Gradual: several (≈1 Hz) samples with both tones.
            expect(f.bothAudible, 'hidden samples with both tracks audible').toBeGreaterThanOrEqual(
                3,
            );
            // The outgoing track was not cut early by a fallback hard swap.
            const outLastMs = hidden[f.outgoingLastIdx].t - hidden[f.startIdx].t;
            expect(outLastMs).toBeGreaterThan(XF.fadeMs * 0.5);
            expect(longestSilentWhilePlaying(hidden)).toBeLessThan(1_500);
            const last = rec[rec.length - 1];
            expect(last.s?.trackId).toBe(cat.xfade[1].id);
            expect(last.tones[1]).toBeGreaterThan(AUDIBLE_DB);
        } finally {
            await cdp.close();
        }
    });
});

// ===========================================================================
// 5. Fast search
// ===========================================================================

test.describe('5. fast search', () => {
    test('Ctrl/Cmd+F focuses search; arrows + Enter play a song; artist and album open', async ({
        page,
    }) => {
        const tab = new Tab(page, 'A');
        await tab.goto('/music');
        await tab.setTones([cat.search[0].hz]);
        const input = page.getByRole('textbox', { name: /Search artists, albums, tracks/ }).first();
        await page.locator('body').click({ position: { x: 5, y: 300 } });
        await page.keyboard.press('ControlOrMeta+f');
        await expect(input).toBeFocused();
        await page.keyboard.type('Zephyr');
        const rows = page.locator('[data-music-search-section="songs"] button[data-track-row]');
        await expect(rows).toHaveCount(3, { timeout: 15_000 });

        await page.keyboard.press('ArrowDown');
        await expect(rows.nth(0)).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(rows.nth(1)).toBeFocused();
        const wanted = await rows.nth(1).getAttribute('title');
        await page.keyboard.press('Enter');
        await expect.poll(async () => (await tab.view()).title, { timeout: 15_000 }).toBe(wanted);
        await expect.poll(async () => (await tab.view()).isPlaying).toBe(true);
        await waitAudible(tab, 0);
        await expect(
            page
                .locator(
                    '[data-music-search-section="songs"] li [aria-current="true"], [data-music-search-section="songs"] [aria-current="true"]',
                )
                .first(),
        ).toBeVisible();

        // Artist link in a song row -> the artist opens.
        const row = page.locator('[data-music-search-section="songs"] li').first();
        await row.hover();
        await row
            .getByRole('button', { name: cat.artists.search.name, exact: true })
            .first()
            .click();
        const dialog = page.getByRole('dialog').filter({ hasText: cat.artists.search.name });
        await expect(dialog).toBeVisible({ timeout: 10_000 });
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();

        // Album link -> the album opens.
        await row.hover();
        await row
            .getByRole('button', { name: cat.albums.search.title, exact: true })
            .first()
            .click();
        const albumDialog = page.getByRole('dialog').filter({ hasText: cat.albums.search.title });
        await expect(albumDialog).toBeVisible({ timeout: 10_000 });
    });
});

// ===========================================================================
// 6. Mood radio + cluster shuffle
// ===========================================================================

async function setPrefs(page: Page, prefs: Record<string, unknown>): Promise<void> {
    const status = await page.evaluate(async (body) => {
        const r = await fetch('/api/me/playback-preferences', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return r.status;
    }, prefs);
    expect(status).toBeLessThan(300);
}

test.describe('6. mood radio + clusters', () => {
    for (const autoplay of [true, false]) {
        test(`a mood chip starts a radio whose queue follows the mood (autoplay setting ${autoplay ? 'on' : 'off'})`, async ({
            page,
        }) => {
            const tab = new Tab(page, 'A');
            await page.goto('/music');
            await setPrefs(page, { musicAutoplayEnabled: autoplay });
            await tab.goto('/music/explore');
            await page
                .getByRole('button', { name: /Chill$/ })
                .first()
                .click();
            await expect
                .poll(async () => (await tab.view()).autoplaySeed, { timeout: 15_000 })
                .toBe('mood:chill');
            await expect
                .poll(async () => (await tab.view()).trackId, { timeout: 15_000 })
                .toBe(cat.radio.seed.id);
            const queueTitles = (seed: string, mood: string | null) =>
                page.evaluate(
                    async ({ seed, mood }) => {
                        const r = await fetch('/api/music/recommendations', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                context: { currentTrackId: seed },
                                ...(mood ? { seed: { type: 'mood', mood } } : {}),
                            }),
                        });
                        const body = (await r.json().catch(() => null)) as {
                            next?: { title: string };
                            alternatives?: { title: string }[];
                        } | null;
                        const titles = [
                            body?.next?.title,
                            ...(body?.alternatives ?? []).map((t) => t.title),
                        ].filter((t): t is string => !!t);
                        return { status: r.status, titles };
                    },
                    { seed, mood },
                );
            const moodQueue = await queueTitles(cat.radio.seed.id, 'chill');
            await attach('mood-queue-api', moodQueue);
            // The smart queue tops up one pick at a time while playing.
            await expect
                .poll(async () => (await tab.view()).queueIds.length, { timeout: 20_000 })
                .toBeGreaterThanOrEqual(1);
            const v: StoreView = await tab.view();
            await attach('queue', v.queueTitles);
            const chill = new Set(cat.radio.chill.map((t) => t.id));
            // The queue leans chill (the ranking's diversity pass may still mix in a
            // neighbour, so not every pick is).
            const nChill = v.queueIds.filter((id) => chill.has(id)).length;
            expect(nChill, `queue: ${v.queueTitles.join(', ')}`).toBeGreaterThan(
                v.queueIds.length / 2,
            );
            // …and so does the server's whole candidate list (next + alternatives).
            expect(moodQueue.status).toBe(200);
            const isChill = (t: string) => t.includes('Chill');
            const isWorkout = (t: string) => t.includes('Workout');
            expect(
                moodQueue.titles.filter(isChill).length,
                moodQueue.titles.join(', '),
            ).toBeGreaterThan(moodQueue.titles.filter(isWorkout).length);

            // Control: the same seed track WITHOUT the mood follows its own sound
            // (workout). Proves the scenario can tell the mood arm apart.
            const plain = await queueTitles(cat.radio.seed.id, null);
            await attach('no-mood-control', plain);
            expect(plain.status).toBe(200);
            expect(plain.titles.filter(isWorkout).length, plain.titles.join(', ')).toBeGreaterThan(
                plain.titles.filter(isChill).length,
            );
            await setPrefs(page, { musicAutoplayEnabled: false });
        });
    }

    test('cluster shuffle (GET v1 music/sonic-mixes/{id}/shuffle) plays only that cluster, in a stable seeded order', async ({
        page,
    }) => {
        await page.goto('/music');
        const created = await page.evaluate(async () => {
            const r = await fetch('/api/me/pats', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: `music-e2e ${Date.now()}`,
                    scopes: ['read'],
                    expiresInDays: 1,
                }),
            });
            return { status: r.status, body: (await r.json()) as { id?: string; token?: string } };
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const pat = created.body.token!;
        try {
            const base = `${webUrl()}/api/v1/music/sonic-mixes/${cat.clusters.chill}/shuffle`;
            const get = async (seed: string, i: number) => {
                const r = await fetch(`${base}?seed=${seed}&i=${i}`, {
                    headers: { Authorization: `Bearer ${pat}` },
                });
                const b = new Uint8Array(await r.arrayBuffer());
                return {
                    body: r.status === 200 ? '' : new TextDecoder().decode(b).slice(0, 300),
                    status: r.status,
                    type: r.headers.get('content-type'),
                    id: r.headers.get('x-track-id'),
                    count: r.headers.get('x-track-count'),
                    bytes: b.length,
                    // MPEG audio frame sync (no ID3 by design)
                    sync: b[0] === 0xff && (b[1] & 0xe0) === 0xe0,
                };
            };
            const order: string[] = [];
            for (let i = 0; i < 5; i++) {
                const r = await get('4242', i);
                expect(r.status, r.body).toBe(200);
                expect(r.type).toContain('audio/mpeg');
                expect(r.sync).toBe(true);
                expect(r.count).toBe('5');
                order.push(r.id!);
            }
            const chill = new Set(cat.radio.chill.map((t) => t.id));
            expect(order.every((id) => chill.has(id))).toBe(true);
            expect(new Set(order).size).toBe(5);
            expect((await get('4242', 5)).id).toBe(order[0]); // wraps
            expect((await get('4242', 2)).id).toBe(order[2]); // stable
            // The web's cluster list shows the same members.
            const members = await page.evaluate(async (id) => {
                const r = await fetch(`/api/music/sonic-mixes/${id}/tracks`);
                return { status: r.status, text: await r.text() };
            }, cat.clusters.chill);
            expect(members.status).toBe(200);
            for (const id of order) expect(members.text).toContain(id);
        } finally {
            if (created.body.id) {
                await page.evaluate(
                    (id) => fetch(`/api/me/pats/${id}`, { method: 'DELETE' }),
                    created.body.id,
                );
            }
        }
    });
});
