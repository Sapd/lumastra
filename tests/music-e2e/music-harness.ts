// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Harness for the music player e2e (music-player.e2e.ts).
 *
 * Observation, never stubbing: the player runs on real <audio> elements and the real
 * Web Audio graph. An init script taps the graph where it reaches the speakers
 * (every connect() to an AudioDestinationNode also feeds an AnalyserNode), so a
 * scenario reads what a listener would hear — overall level and, because every
 * fixture track is its own sine tone, WHICH track is audible. Player state comes
 * from `window.__musicPlayerStore` (dev builds, or a build with VITE_E2E_HOOKS=true).
 *
 * A recorder samples all of that in the page (setInterval, so it keeps going in a
 * hidden tab, throttled to ~1 Hz there) and a frame recorder samples the seek bar
 * geometry on every animation frame (visible tabs only) for the hand-off checks.
 */

import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MUSIC_USER, webUrl } from './music-env';
import type { ProxyFault, ProxyLogEntry } from './music-proxy';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// In-page probe
// ---------------------------------------------------------------------------

export interface StoreView {
    trackId: string | null;
    title: string | null;
    isPlaying: boolean;
    isCrossfading: boolean;
    playingElsewhere: boolean;
    currentTimeMs: number;
    durationMs: number;
    volume: number;
    queueIds: string[];
    queueTitles: string[];
    autoplaySeed: string | null;
    autoplayEnabled: boolean;
}

export interface Sample {
    /** performance.now() in the page */
    t: number;
    vis: 'visible' | 'hidden';
    s: StoreView | null;
    /** dB at each watched tone (index = __probeTones order); -200 = silent */
    tones: number[];
    /** RMS of the output, dBFS */
    rms: number;
    els: { src: string; paused: boolean; t: number; rs: number; err: number | null }[];
    title: string[];
    xfadeClass: boolean;
    oldFill: boolean;
    valuenow: number | null;
}

export interface Frame {
    t: number;
    /** seek bar top (px, viewport) */
    top: number | null;
    /** progress fill width / bar width */
    fill: number | null;
    oldFill: boolean;
    titles: string[];
    xfade: boolean;
    strip: boolean;
}

/**
 * Installed with addInitScript in every tab, before any app code runs. Keep it
 * self-contained (it is serialised into the page).
 */
function installProbe(): void {
    type W = Window & {
        __probe: {
            analysers: AnalyserNode[];
            els: HTMLMediaElement[];
            tones: number[];
            rec: unknown[];
            frames: unknown[];
            recTimer: number | null;
            frameOn: boolean;
            plays: { t: number; src: string; result: string }[];
        };
        __musicPlayerStore?: {
            subscribe: (cb: (s: Record<string, unknown>) => void) => () => void;
        };
    };
    const w = window as unknown as W;
    const probe: W['__probe'] = {
        analysers: [],
        els: [],
        tones: [],
        rec: [],
        frames: [],
        recTimer: null,
        frameOn: false,
        plays: [],
    };
    w.__probe = probe;

    // 1. Tap the output: whatever connects to the destination also feeds an analyser.
    const origConnect = AudioNode.prototype.connect as (
        this: AudioNode,
        dest: AudioNode | AudioParam,
        ...rest: number[]
    ) => AudioNode | void;
    const tapped = new WeakSet<AudioNode>();
    (AudioNode.prototype as unknown as { connect: typeof origConnect }).connect = function (
        this: AudioNode,
        dest: AudioNode | AudioParam,
        ...rest: number[]
    ) {
        const out = origConnect.call(this, dest, ...rest);
        if (dest instanceof AudioDestinationNode && !tapped.has(this)) {
            tapped.add(this);
            const an = this.context.createAnalyser();
            an.fftSize = 8192;
            an.smoothingTimeConstant = 0;
            origConnect.call(this, an);
            probe.analysers.push(an);
        }
        return out;
    };

    // 2. Every media element the app creates (the decks are never in the DOM).
    const origCreate = document.createElement.bind(document);
    document.createElement = function (tag: string, opts?: { is?: string }) {
        const el = origCreate(tag, opts);
        if (el instanceof HTMLMediaElement) probe.els.push(el);
        return el;
    } as typeof document.createElement;
    const OrigAudio = window.Audio;
    window.Audio = function (src?: string) {
        const el = new OrigAudio(src);
        probe.els.push(el);
        return el;
    } as unknown as typeof Audio;
    window.Audio.prototype = OrigAudio.prototype;
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        if (!probe.els.includes(this)) probe.els.push(this);
        const entry = {
            t: Math.round(performance.now()),
            src: this.src.slice(-60),
            result: 'pending',
        };
        probe.plays.push(entry);
        if (probe.plays.length > 40) probe.plays.shift();
        const p = origPlay.call(this);
        p.then(
            () => (entry.result = 'ok'),
            (e: Error) => (entry.result = `${e.name}: ${e.message}`.slice(0, 100)),
        );
        return p;
    };

    // 3. Readers.
    const storeView = (): Record<string, unknown> | null => {
        const st = w.__musicPlayerStore;
        if (!st) return null;
        let s: Record<string, unknown> = {};
        st.subscribe((v) => (s = v))();
        const cur = s.currentTrack as { id?: string; title?: string } | null;
        const queue = (s.queue as { track: { id: string; title: string } }[] | undefined) ?? [];
        const seed = s.autoplaySeed as { type?: string; mood?: string } | null;
        return {
            trackId: cur?.id ?? null,
            title: cur?.title ?? null,
            isPlaying: s.isPlaying === true,
            isCrossfading: s.isCrossfading === true,
            playingElsewhere: s.playingElsewhere === true,
            currentTimeMs: Number(s.currentTimeMs ?? 0),
            durationMs: Number(s.durationMs ?? 0),
            volume: Number(s.volume ?? -1),
            queueIds: queue.map((q) => q.track.id),
            queueTitles: queue.map((q) => q.track.title),
            autoplaySeed: seed ? `${seed.type}:${seed.mood ?? ''}` : null,
            autoplayEnabled: s.autoplayEnabled === true,
        };
    };
    const buf = new Float32Array(8192);
    const levels = (): { tones: number[]; rms: number } => {
        const tones = probe.tones.map(() => -200);
        let rms = -200;
        for (const an of probe.analysers) {
            const n = an.frequencyBinCount;
            const freq = new Float32Array(n);
            an.getFloatFrequencyData(freq);
            const binHz = an.context.sampleRate / an.fftSize;
            probe.tones.forEach((hz, i) => {
                const b = Math.round(hz / binHz);
                // Peak of the 3 bins around the tone (the sine sits between bins).
                const v = Math.max(freq[b - 1] ?? -200, freq[b] ?? -200, freq[b + 1] ?? -200);
                if (Number.isFinite(v)) tones[i] = Math.max(tones[i], v);
            });
            an.getFloatTimeDomainData(buf.subarray(0, an.fftSize));
            let sum = 0;
            for (let k = 0; k < an.fftSize; k++) sum += buf[k] * buf[k];
            const r = Math.sqrt(sum / an.fftSize);
            rms = Math.max(rms, r > 0 ? 20 * Math.log10(r) : -200);
        }
        return { tones, rms };
    };
    const seekbar = (): HTMLElement | null =>
        document.querySelector('.mini-player .seekbar[role="slider"]');
    const titles = (): string[] =>
        Array.from(document.querySelectorAll('.mini-player p.text-\\[15px\\]')).map((p) =>
            (p.textContent ?? '').trim(),
        );
    const fillFrac = (bar: HTMLElement | null): number | null => {
        if (!bar) return null;
        const fill = Array.from(bar.querySelectorAll<HTMLElement>('div.bg-primary-500')).find(
            (d) => !d.classList.contains('xfade-old-fill') && d.style.width.endsWith('%'),
        );
        if (!fill) return null;
        const w0 = bar.getBoundingClientRect().width;
        return w0 > 0 ? fill.getBoundingClientRect().width / w0 : null;
    };

    /** The dissolving copy of the old fill, while it is still visible (it stays
     *  mounted at opacity 0 once its animation has run). */
    const visibleOldFill = (): boolean => {
        const el = document.querySelector('.mini-player .xfade-old-fill');
        return !!el && Number(getComputedStyle(el).opacity) > 0.05;
    };

    const sample = (): unknown => {
        const bar = seekbar();
        const { tones, rms } = levels();
        return {
            t: Math.round(performance.now()),
            vis: document.visibilityState,
            s: storeView(),
            tones: tones.map((x) => Math.round(x * 10) / 10),
            rms: Math.round(rms * 10) / 10,
            els: probe.els
                .filter((e) => e.src)
                .map((e) => ({
                    src: e.src.replace(/^.*\/tracks\//, '').slice(0, 60),
                    paused: e.paused,
                    t: Math.round(e.currentTime * 100) / 100,
                    rs: e.readyState,
                    err: e.error?.code ?? null,
                })),
            title: titles(),
            xfadeClass: !!document.querySelector('.mini-player.mini-player-crossfading'),
            oldFill: visibleOldFill(),
            valuenow: bar ? Number(bar.getAttribute('aria-valuenow')) : null,
        };
    };

    (window as unknown as { __probeApi: unknown }).__probeApi = {
        sample,
        storeView,
        setTones(hz: number[]) {
            probe.tones = hz;
        },
        startRec(intervalMs: number) {
            probe.rec = [];
            if (probe.recTimer !== null) clearInterval(probe.recTimer);
            probe.recTimer = window.setInterval(() => {
                probe.rec.push(sample());
                if (probe.rec.length > 3000) probe.rec.shift();
            }, intervalMs);
        },
        stopRec() {
            if (probe.recTimer !== null) clearInterval(probe.recTimer);
            probe.recTimer = null;
            return probe.rec;
        },
        startFrames() {
            probe.frames = [];
            probe.frameOn = true;
            const tick = (): void => {
                if (!probe.frameOn) return;
                const bar = seekbar();
                probe.frames.push({
                    t: Math.round(performance.now()),
                    top: bar ? Math.round(bar.getBoundingClientRect().top * 10) / 10 : null,
                    fill: fillFrac(bar),
                    oldFill: visibleOldFill(),
                    titles: titles(),
                    xfade: !!document.querySelector('.mini-player.mini-player-crossfading'),
                    strip: !!document.querySelector('.mini-player .upnext-strip'),
                });
                if (probe.frames.length > 5000) probe.frames.shift();
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        },
        stopFrames() {
            probe.frameOn = false;
            return probe.frames;
        },
        plays: () => probe.plays,
    };
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

type ProbeApi = {
    sample: () => Sample;
    storeView: () => StoreView | null;
    setTones: (hz: number[]) => void;
    startRec: (ms: number) => void;
    stopRec: () => Sample[];
    startFrames: () => void;
    stopFrames: () => Frame[];
    plays: () => { t: number; src: string; result: string }[];
};

/** The page-side store API used to set a scene (never to fake a result). */
export interface StoreApi {
    play: (track: unknown) => Promise<void>;
    startPlayback: (track: unknown) => Promise<void>;
    pause: () => void;
    seekTo: (ms: number) => void;
    addToQueue: (track: unknown) => void;
    removeFromQueue: (id: string) => void;
    reorderQueue: (items: unknown[]) => void;
    clearQueue: () => void;
    init: () => Promise<void>;
    subscribe: (cb: (s: Record<string, unknown>) => void) => () => void;
}

export async function prepareContext(context: BrowserContext): Promise<void> {
    await context.addInitScript(installProbe);
}

export class Tab {
    /** Re-applied after every navigation (the probe lives in the page). */
    private tones: number[] = [];

    constructor(
        readonly page: Page,
        readonly name: string,
    ) {}

    static async open(context: BrowserContext, name: string, path = '/music'): Promise<Tab> {
        const page = await context.newPage();
        const tab = new Tab(page, name);
        await tab.goto(path);
        return tab;
    }

    async goto(path: string): Promise<void> {
        const res = await this.page.goto(path, { waitUntil: 'domcontentloaded' });
        if (res && res.status() >= 400)
            throw new Error(`${this.name}: ${path} -> HTTP ${res.status()}`);
        await this.page
            .waitForFunction(
                () => !!(window as unknown as { __musicPlayerStore?: unknown }).__musicPlayerStore,
                null,
                { timeout: 30_000 },
            )
            .catch(() => {
                throw new Error(
                    `${this.name}: window.__musicPlayerStore missing — build with VITE_E2E_HOOKS=true`,
                );
            });
        await this.page.evaluate(() =>
            (window as unknown as { __musicPlayerStore: StoreApi }).__musicPlayerStore.init(),
        );
        if (this.tones.length) await this.setTones(this.tones);
    }

    async view(): Promise<StoreView> {
        const v = await this.page.evaluate(() =>
            (window as unknown as { __probeApi: ProbeApi }).__probeApi.storeView(),
        );
        if (!v) throw new Error(`${this.name}: no store`);
        return v;
    }

    async sample(): Promise<Sample> {
        return this.page.evaluate(() =>
            (window as unknown as { __probeApi: ProbeApi }).__probeApi.sample(),
        );
    }

    async setTones(hz: number[]): Promise<void> {
        this.tones = hz;
        await this.page.evaluate(
            (h) => (window as unknown as { __probeApi: ProbeApi }).__probeApi.setTones(h),
            hz,
        );
    }

    async startRec(ms = 100): Promise<void> {
        await this.page.evaluate(
            (i) => (window as unknown as { __probeApi: ProbeApi }).__probeApi.startRec(i),
            ms,
        );
    }

    async stopRec(): Promise<Sample[]> {
        return this.page.evaluate(() =>
            (window as unknown as { __probeApi: ProbeApi }).__probeApi.stopRec(),
        );
    }

    async startFrames(): Promise<void> {
        await this.page.evaluate(() =>
            (window as unknown as { __probeApi: ProbeApi }).__probeApi.startFrames(),
        );
    }

    async stopFrames(): Promise<Frame[]> {
        return this.page.evaluate(() =>
            (window as unknown as { __probeApi: ProbeApi }).__probeApi.stopFrames(),
        );
    }

    async plays(): Promise<{ t: number; src: string; result: string }[]> {
        return this.page.evaluate(() =>
            (window as unknown as { __probeApi: ProbeApi }).__probeApi.plays(),
        );
    }

    /** Fetch full track rows the way the app does (GET /api/music/tracks/{id}). */
    async fetchTrack(id: string): Promise<Record<string, unknown>> {
        return this.page.evaluate(async (tid) => {
            const r = await fetch(`/api/music/tracks/${tid}`);
            if (!r.ok) throw new Error(`GET track ${tid}: ${r.status}`);
            const body = (await r.json()) as Record<string, unknown>;
            return (body.track ?? body.data ?? body) as Record<string, unknown>;
        }, id);
    }

    miniPlayer() {
        return this.page.locator('.mini-player').first();
    }

    toggle() {
        return this.miniPlayer()
            .getByRole('button', { name: /^(Play|Pause)$/ })
            .first();
    }

    seekbar() {
        return this.miniPlayer().getByRole('slider', { name: 'Seek' });
    }

    volume() {
        return this.miniPlayer().getByRole('slider', { name: 'Volume' });
    }

    elsewhereHint() {
        return this.page.getByTestId('music-playing-elsewhere');
    }

    playHere() {
        return this.page.getByTestId('music-play-here');
    }

    /** Click the seek bar at `fraction` of its width (the real pointer path). */
    async clickSeek(fraction: number): Promise<void> {
        const box = await this.seekbar().boundingBox();
        if (!box) throw new Error(`${this.name}: no seek bar`);
        await this.page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
    }
}

/** dB above which a tone counts as audible (silence reads ~-200; a deck at -14 LUFS ~ -30). */
export const AUDIBLE_DB = -70;

export function audibleTones(s: Sample, hz: number[], probeTones: number[]): number[] {
    return hz.filter((h) => {
        const i = probeTones.indexOf(h);
        return i >= 0 && s.tones[i] > AUDIBLE_DB;
    });
}

// ---------------------------------------------------------------------------
// Fault proxy control (music-proxy.ts)
// ---------------------------------------------------------------------------

export const proxy = {
    async fault(f: ProxyFault): Promise<void> {
        const r = await fetch(`${webUrl()}/__e2e_proxy/fault`, {
            method: 'POST',
            body: JSON.stringify(f),
        });
        expect(r.ok).toBe(true);
    },
    async reset(): Promise<void> {
        await fetch(`${webUrl()}/__e2e_proxy/reset`, { method: 'POST' });
    },
    async log(match: string): Promise<ProxyLogEntry[]> {
        const r = await fetch(`${webUrl()}/__e2e_proxy/log?match=${encodeURIComponent(match)}`);
        return (await r.json()) as ProxyLogEntry[];
    },
};

export function identityHeaders(): Record<string, string> {
    return { 'X-Forwarded-User': MUSIC_USER, 'X-Forwarded-Groups': 'Users' };
}

// ---------------------------------------------------------------------------
// A real hidden tab (see reference: Playwright's focus emulation keeps pages visible)
// ---------------------------------------------------------------------------

/**
 * A Chromium WE launch ourselves and attach to with `noDefaults`: in
 * `--headless=new` it has a real tab strip, so activating another tab makes ours
 * genuinely `hidden` — requestAnimationFrame stops, timers throttle — which a
 * Playwright-launched browser never does (same recipe as the WT e2e CdpBrowser).
 */
export class CdpBrowser {
    private constructor(
        readonly browser: Browser,
        private readonly proc: ChildProcess,
        private readonly profileDir: string,
    ) {}

    static async launch(): Promise<CdpBrowser> {
        const profileDir = mkdtempSync(join(tmpdir(), 'music-cdp-'));
        const proc = spawn(
            chromium.executablePath(),
            [
                '--headless=new',
                '--remote-debugging-port=0',
                `--user-data-dir=${profileDir}`,
                '--no-sandbox',
                '--no-first-run',
                '--no-default-browser-check',
                '--autoplay-policy=no-user-gesture-required',
                '--mute-audio',
                'about:blank',
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        const ws = await new Promise<string>((resolve, reject) => {
            let buf = '';
            const timer = setTimeout(
                () => reject(new Error(`Chromium did not expose DevTools: ${buf.slice(0, 400)}`)),
                30_000,
            );
            proc.stderr!.on('data', (d: Buffer) => {
                buf += d.toString();
                const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
                if (m) {
                    clearTimeout(timer);
                    resolve(m[1]);
                }
            });
            proc.on('exit', (code) => {
                clearTimeout(timer);
                reject(new Error(`Chromium exited (${code}): ${buf.slice(0, 400)}`));
            });
        });
        const browser = await chromium.connectOverCDP(ws, { noDefaults: true });
        return new CdpBrowser(browser, proc, profileDir);
    }

    get context(): BrowserContext {
        return this.browser.contexts()[0];
    }

    /** Bring a blank tab to the front: every other tab becomes hidden. */
    async hideOthers(): Promise<() => Promise<void>> {
        const cdp = await this.browser.newBrowserCDPSession();
        const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as {
            targetId: string;
        };
        await cdp.send('Target.activateTarget', { targetId });
        return async () => {
            await cdp.send('Target.closeTarget', { targetId });
            await cdp.detach().catch(() => {});
        };
    }

    async close(): Promise<void> {
        await this.browser.close().catch(() => {});
        this.proc.kill('SIGTERM');
        await sleep(300);
        if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
        rmSync(this.profileDir, { recursive: true, force: true });
    }
}
