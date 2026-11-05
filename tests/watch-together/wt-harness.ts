// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Harness for the web-only Watch Together e2e (watch-together-web.e2e.ts).
 *
 * Shape (generalised from the browser <-> Apple TV conductor, tests/watch-together-tv.e2e.ts):
 *  - A Participant is one browser tab signed in as one user by forward-auth headers.
 *    Its moves (play, pause, seek, leave) go through the same keyboard shortcuts and
 *    panel buttons a person uses; its state is read from the <video> element.
 *  - A Party is one server-side session: created by a host participant through
 *    POST /api/watch-together (and adopted by the host tab via storage, exactly like
 *    the app's own "Watch together" button does), joined by guests through the
 *    /party/{code} link.
 *  - scenario() registers every scenario twice — user A hosting and user B hosting —
 *    so no assertion can pass only because of who the host happens to be.
 *  - The server is OBSERVED by polling GET /api/watch-together/{code} once a second
 *    (never an SSE tap: an extra SSE connection changes buffer-check accounting).
 *  - Results + drift go to ndjson files (Playwright restarts the worker after a failed
 *    test, which would lose module memory); globalTeardown writes summary.json.
 */

import {
    chromium,
    firefox,
    webkit,
    expect,
    test,
    type Browser,
    type BrowserContext,
    type CDPSession,
    type Page,
    type TestInfo,
} from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type postgres from 'postgres';
import { outDir, webUrl, wtUsersFor } from './wt-env';
import { connect, seedMovie, seedShow, type SeededMovie, type SeededShow } from './wt-seed';

// ---------------------------------------------------------------------------
// Config + small utilities
// ---------------------------------------------------------------------------

export const DRIFT_MAX = Number(process.env.WT_DRIFT_MAX || '1.0');
export const RUN_ID = process.env.WT_RUN_ID || 'norun';
export const STORAGE_KEY = 'dashboard_watch_party';
export const CLIENT_ID_KEY = 'dashboard_watch_party_client_id';
/** Web keyboard seek step (VideoShortcuts.ts, SEEK.DEFAULT_SECONDS). */
export const SEEK_STEP_S = 10;

const DIR = outDir();
mkdirSync(DIR, { recursive: true });

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One ndjson row; loosely typed on purpose — rows of several kinds share a file. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NdRow = Record<string, any>;

export function appendNdjson(file: string, row: NdRow): void {
    appendFileSync(
        join(DIR, file),
        JSON.stringify({ runId: RUN_ID, ts: Date.now(), ...row }) + '\n',
    );
}

export function readNdjson(file: string): NdRow[] {
    const p = join(DIR, file);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            try {
                return JSON.parse(l) as NdRow;
            } catch {
                return null;
            }
        })
        .filter((r): r is NdRow => !!r && r.runId === RUN_ID);
}

export const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function identityHeaders(user: string): Record<string, string> {
    return { 'X-Forwarded-User': user, 'X-Forwarded-Groups': 'Users' };
}

// ---------------------------------------------------------------------------
// In-page instrumentation (installed in every participant tab)
// ---------------------------------------------------------------------------

/**
 * Counts EventSource opens/errors for the WT stream, so a scenario can prove that a
 * network blip really cut the stream (rather than passing because nothing happened).
 */
function installProbes(): void {
    const w = window as unknown as {
        __wtSse: { opens: number; errors: number; urls: string[] };
        __wtSources: EventSource[];
        EventSource: typeof EventSource;
    };
    w.__wtSse = { opens: 0, errors: 0, urls: [] };
    w.__wtSources = [];
    // Media Session action handlers the app registers (lock screen, headset, OS "Now
    // Playing"), so a test can invoke exactly what the OS would call.
    const handlers: Record<string, MediaSessionActionHandler | null> = {};
    (window as unknown as { __wtMediaHandlers: typeof handlers }).__wtMediaHandlers = handlers;
    // Patch the prototype: WebKit ignores an own-property override on the instance.
    if ('mediaSession' in navigator && typeof MediaSession === 'function') {
        const proto = MediaSession.prototype;
        const origSet = proto.setActionHandler;
        proto.setActionHandler = function (action, handler) {
            handlers[action] = handler;
            return origSet.call(this, action, handler);
        };
    }
    // Page Lifecycle / visibility events with the element's time, for diagnostics.
    const life: string[] = [];
    (window as unknown as { __wtLife: string[] }).__wtLife = life;
    for (const ev of [
        'freeze',
        'resume',
        'visibilitychange',
        'seeking',
        'seeked',
        'play',
        'pause',
    ]) {
        // Media events do not bubble; a capturing listener on document still sees them.
        document.addEventListener(
            ev,
            () => {
                const v = document.querySelector('video');
                life.push(
                    `${Math.round(performance.now())} ${ev} ${document.visibilityState} t=${v?.currentTime.toFixed(2)} paused=${v?.paused}`,
                );
                if (life.length > 60) life.shift();
            },
            true,
        );
    }
    // Every HTMLMediaElement.play() outcome (last 20), for failure diagnostics.
    const plays: { t: number; muted: boolean; result: string }[] = [];
    (window as unknown as { __wtPlays: typeof plays }).__wtPlays = plays;
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        const entry = { t: Math.round(performance.now()), muted: this.muted, result: 'pending' };
        plays.push(entry);
        if (plays.length > 20) plays.shift();
        const p = origPlay.call(this);
        p.then(
            () => (entry.result = 'ok'),
            (e: Error) => (entry.result = `${e.name}: ${e.message}`.slice(0, 120)),
        );
        return p;
    };
    const Orig = w.EventSource;
    if (!Orig) return;
    class Probed extends Orig {
        constructor(url: string | URL, init?: ConstructorParameters<typeof EventSource>[1]) {
            super(url, init);
            const u = String(url);
            if (!u.includes('/watch-together/')) return;
            w.__wtSse.urls.push(u);
            w.__wtSources.push(this);
            this.addEventListener('open', () => w.__wtSse.opens++);
            this.addEventListener('error', () => w.__wtSse.errors++);
        }
    }
    w.EventSource = Probed;
}

export interface SseStats {
    opens: number;
    errors: number;
    urls: string[];
}

// ---------------------------------------------------------------------------
// Participant
// ---------------------------------------------------------------------------

export interface VideoState {
    t: number;
    paused: boolean;
    muted: boolean;
    readyState: number;
    ended: boolean;
}

export class Participant {
    /**
     * Set for a participant whose page must never receive a user activation: every
     * read then goes through a raw CDP Runtime.evaluate with userGesture:false.
     * Playwright's own page.evaluate/waitForFunction run with userGesture:true
     * (playwright-core crExecutionContext), so merely polling the <video> would hand
     * the page the very activation an autoplay test is about.
     */
    private noGesture: CDPSession | null = null;
    /** Page errors + console errors (last 15), for failure diagnostics. */
    readonly errors: string[] = [];
    /**
     * Requests Chromium aborted with net::ERR_NETWORK_CHANGED. The preprod CI host
     * starts/stops containers all the time (new veth interfaces); Chromium treats
     * that as a network change and fails in-flight requests — a page load hit by it
     * shows the app's error page. Environmental, not the app: see waitForVideoReady.
     */
    networkChanges = 0;

    constructor(
        readonly label: string,
        readonly user: string,
        readonly userId: string,
        readonly context: BrowserContext,
        readonly page: Page,
    ) {
        const keep = (line: string): void => {
            this.errors.push(`${new Date().toISOString().slice(11, 23)} ${line}`.slice(0, 400));
            if (this.errors.length > 15) this.errors.shift();
        };
        page.on('pageerror', (e) => keep(`pageerror ${e.message}`));
        page.on('console', (m) => {
            if (m.type() !== 'error') return;
            if (m.text().includes('ERR_NETWORK_CHANGED')) this.networkChanges++;
            keep(`console ${m.text()}`);
        });
        page.on('response', (r) => {
            if (r.status() >= 500) keep(`HTTP ${r.status()} ${r.url()}`);
            // The host's catch-up asks the server whether the party still plays.
            if (r.request().method() === 'GET' && /\/api\/watch-together$/.test(r.url())) {
                void r
                    .json()
                    .then((b: { party?: { isPlaying?: boolean; currentTime?: number } }) =>
                        keep(
                            `GET party ${r.status()} isPlaying=${b.party?.isPlaying} t=${b.party?.currentTime}`,
                        ),
                    )
                    .catch(() => keep(`GET party ${r.status()} (unreadable)`));
            }
        });
    }

    /** What a person would see: the start of the page's visible text. */
    visibleText(): Promise<string> {
        return this.read(() =>
            (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300),
        ).catch(() => '');
    }

    async readWithoutGestures(): Promise<void> {
        this.noGesture = await this.context.newCDPSession(this.page);
    }

    /** Evaluate `fn(arg)` in the page; gesture-free after readWithoutGestures(). */
    private async read<T, A = null>(fn: (arg: A) => T, arg?: A): Promise<T> {
        if (!this.noGesture) {
            return this.page.evaluate(
                fn as (a: unknown) => T,
                (arg ?? null) as unknown,
            ) as Promise<T>;
        }
        const res = (await this.noGesture.send('Runtime.evaluate', {
            expression: `(${fn.toString()})(${JSON.stringify(arg ?? null)})`,
            returnByValue: true,
            awaitPromise: true,
            userGesture: false,
        })) as { result: { value: T }; exceptionDetails?: { text: string } };
        if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
        return res.result.value;
    }

    get name(): string {
        return `${this.label}(${this.user})`;
    }

    video(): Promise<VideoState | null> {
        return this.read(() => {
            const v = document.querySelector('video');
            return v
                ? {
                      t: v.currentTime,
                      paused: v.paused,
                      muted: v.muted,
                      readyState: v.readyState,
                      ended: v.ended,
                  }
                : null;
        }).catch(() => null);
    }

    async position(): Promise<number | null> {
        return (await this.video())?.t ?? null;
    }

    async playing(): Promise<boolean | null> {
        const v = await this.video();
        return v ? !v.paused : null;
    }

    async clientId(): Promise<string | null> {
        return this.read((k: string) => sessionStorage.getItem(k), CLIENT_ID_KEY).catch(() => null);
    }

    storedParty(): Promise<string | null> {
        return this.read((k: string) => localStorage.getItem(k), STORAGE_KEY).catch(() => null);
    }

    sse(): Promise<SseStats | null> {
        return this.read(() => (window as unknown as { __wtSse?: SseStats }).__wtSse ?? null).catch(
            () => null,
        );
    }

    plays(): Promise<unknown> {
        return this.read(
            () => (window as unknown as { __wtPlays?: unknown }).__wtPlays ?? null,
        ).catch(() => null);
    }

    lifecycle(): Promise<unknown> {
        return this.read(
            () => (window as unknown as { __wtLife?: unknown }).__wtLife ?? null,
        ).catch(() => null);
    }

    hasUserActivation(): Promise<boolean | null> {
        return this.read(() => navigator.userActivation?.hasBeenActive ?? null);
    }

    /**
     * Lose the network: the context goes offline AND its open Watch Together streams
     * die. Chromium's offline emulation (context.setOffline) fails new requests but
     * leaves an already-open EventSource streaming — measured: no error, no reconnect
     * across a 15 s "outage". A real outage kills the stream, which the browser
     * reports as an `error` on the EventSource; that is what is simulated here.
     */
    async goOffline(): Promise<void> {
        await this.context.setOffline(true);
        await this.page
            .evaluate(() => {
                const w = window as unknown as { __wtSources?: EventSource[] };
                for (const es of w.__wtSources ?? []) {
                    if (es.readyState === EventSource.CLOSED) continue;
                    es.close();
                    es.dispatchEvent(new Event('error'));
                }
            })
            .catch(() => {});
    }

    async goOnline(): Promise<void> {
        await this.context.setOffline(false);
    }

    /** Press Play/Pause on the lock screen / headset: the app's Media Session handler. */
    /** Playwright's Linux WebKit ships without the Media Session API. */
    async hasMediaSession(): Promise<boolean> {
        return this.page.evaluate(() => 'mediaSession' in navigator);
    }

    async mediaKey(action: 'play' | 'pause'): Promise<void> {
        const ok = await this.page.evaluate((a) => {
            const h = (
                window as unknown as {
                    __wtMediaHandlers?: Record<string, ((d: { action: string }) => void) | null>;
                }
            ).__wtMediaHandlers?.[a];
            if (!h) return false;
            h({ action: a });
            return true;
        }, action);
        const probe = ok
            ? ''
            : await this.page.evaluate(() =>
                  JSON.stringify({
                      metadata: typeof MediaMetadata,
                      registered: Object.keys(
                          (window as unknown as { __wtMediaHandlers?: object }).__wtMediaHandlers ??
                              {},
                      ),
                      setter: String(navigator.mediaSession?.setActionHandler).slice(0, 80),
                  }),
              );
        expect(ok, `${this.name}: no Media Session '${action}' handler registered ${probe}`).toBe(
            true,
        );
    }

    /** Keyboard shortcuts land on the document; make sure no input/button holds focus. */
    private async key(key: string): Promise<void> {
        await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
        await this.page.keyboard.press(key);
    }

    /** Press play (only if paused — `k` toggles). */
    async play(): Promise<void> {
        if ((await this.playing()) === false) await this.key('k');
    }

    /** Press pause (only if playing). */
    async pause(): Promise<void> {
        if ((await this.playing()) === true) await this.key('k');
    }

    /** One keyboard seek step (±10 s). */
    async seek(direction: 'forward' | 'back'): Promise<void> {
        await this.key(direction === 'forward' ? 'ArrowRight' : 'ArrowLeft');
    }

    private async openPanel(): Promise<void> {
        const panel = this.page.locator('.watch-together-panel');
        if (await panel.isVisible().catch(() => false)) return;
        // Controls auto-hide; a mouse move brings them (and the avatar cluster) back.
        await this.page.mouse.move(400, 300);
        await this.page.locator('.cluster-btn').first().click({ timeout: 10_000 });
        await panel.waitFor({ state: 'visible', timeout: 10_000 });
    }

    /** Leave through the party panel (guest), like a person would. */
    async leave(): Promise<void> {
        await this.openPanel();
        await this.page.locator('.leave-btn').first().click({ timeout: 10_000 });
    }

    /** End the party through the panel (host). */
    async disband(): Promise<void> {
        await this.openPanel();
        await this.page
            .locator('button.host-action-btn.disband')
            .first()
            .click({ timeout: 10_000 });
        // A confirmation step, if the UI asks for one.
        const confirm = this.page.locator('.confirm-btn, .dialog-btn.confirm, .disband-confirm');
        if (
            await confirm
                .first()
                .isVisible({ timeout: 1_500 })
                .catch(() => false)
        ) {
            await confirm.first().click();
        }
    }

    async waitForVideoReady(timeout = 90_000): Promise<void> {
        const deadline = Date.now() + timeout;
        let seenNetworkChanges = this.networkChanges;
        let reloads = 0;
        while (Date.now() < deadline) {
            const v = await this.video();
            if ((v?.readyState ?? -1) >= 2) return;
            // Only for the environmental network-change abort, at most twice, and only
            // while there is no player at all: a real app failure still fails.
            if (!v && this.networkChanges > seenNetworkChanges && reloads < 2) {
                seenNetworkChanges = this.networkChanges;
                reloads++;
                this.errors.push(`reload ${reloads} after net::ERR_NETWORK_CHANGED`);
                await sleep(1_000);
                await this.page.reload().catch(() => {});
                continue;
            }
            await sleep(250);
        }
        expect(
            (await this.video())?.readyState ?? -1,
            `${this.name}: video never became ready (url ${this.page.url()})`,
        ).toBeGreaterThanOrEqual(2);
    }
}

// ---------------------------------------------------------------------------
// Server observer
// ---------------------------------------------------------------------------

export interface ServerSession {
    code?: string;
    currentTime?: number;
    isPlaying?: boolean;
    lastSync?: number;
    itemId?: string;
    hostClientId?: string;
    host?: {
        userId: string;
        displayName: string | null;
        images: { primary: { href: string; revision: string; source: string } };
    };
    participants?: {
        clientId: string;
        userId: string;
        displayName: string | null;
        images: { primary: { href: string; revision: string; source: string } };
    }[];
}

export async function fetchSession(
    code: string,
    asUser: string,
): Promise<{ status: number; session: ServerSession | null }> {
    const res = await fetch(`${webUrl()}/api/watch-together/${code}`, {
        headers: identityHeaders(asUser),
    });
    const body = (await res.json().catch(() => null)) as { party?: ServerSession } | null;
    return { status: res.status, session: body?.party ?? null };
}

export class ServerPoller {
    last: { status: number; session: ServerSession | null } | { error: string } | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private inFlight = false;

    start(code: string, asUser: string, title: string): void {
        this.stop();
        const tick = async (): Promise<void> => {
            if (this.inFlight) return;
            this.inFlight = true;
            try {
                const r = await fetchSession(code, asUser);
                this.last = r;
                const s = r.session;
                appendNdjson('server-events.ndjson', {
                    test: title,
                    code,
                    status: r.status,
                    currentTime: s?.currentTime,
                    isPlaying: s?.isPlaying,
                    lastSync: s?.lastSync,
                    participants: s?.participants?.length,
                });
            } catch (e) {
                this.last = { error: String(e) };
            } finally {
                this.inFlight = false;
            }
        };
        void tick();
        this.timer = setInterval(() => void tick(), 1_000);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}

// ---------------------------------------------------------------------------
// Party
// ---------------------------------------------------------------------------

export interface PartyItem {
    id: string;
    title: string;
    mediaType: 'movie' | 'episode';
}

export class Party {
    readonly guests: Participant[] = [];
    readonly poller = new ServerPoller();
    ended = false;

    private constructor(
        readonly code: string,
        readonly host: Participant,
        readonly hostClientId: string,
        public item: PartyItem,
    ) {}

    get guest(): Participant {
        return this.guests[0];
    }

    get members(): Participant[] {
        return [this.host, ...this.guests];
    }

    /**
     * Host creates the party for `item` and opens it — what the app's "Watch together"
     * button does: POST /api/watch-together under the tab's clientId, then the watch
     * page adopts the stored session.
     */
    static async create(host: Participant, item: PartyItem, title: string): Promise<Party> {
        const clientId = `client_e2e_${host.label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const res = await host.context.request.post(`${webUrl()}/api/watch-together/parties`, {
            data: {
                itemId: item.id,
                mediaType: item.mediaType,
                title: item.title,
                clientId,
                currentTime: 0,
            },
        });
        expect(
            res.ok(),
            `create session failed: ${res.status()} ${await res.text().catch(() => '')}`,
        ).toBe(true);
        const created = (await res.json()) as {
            party: { code: string; host: { userId: string; displayName: string | null } };
        };
        expect(created.party.host.userId, 'server must return a stable public author').toMatch(
            /^[0-9a-f-]{36}$/i,
        );
        const code = created.party.code;
        const party = new Party(code, host, clientId, item);

        await host.page.addInitScript(
            ({ cidKey, cid, sKey, sVal }) => {
                if (!sessionStorage.getItem(cidKey)) sessionStorage.setItem(cidKey, cid);
                if (!localStorage.getItem(sKey)) localStorage.setItem(sKey, sVal);
            },
            {
                cidKey: CLIENT_ID_KEY,
                cid: clientId,
                sKey: STORAGE_KEY,
                sVal: JSON.stringify({ code, userId: created.party.host.userId }),
            },
        );
        await host.page.goto(`${webUrl()}/watch/${item.id}`);
        await host.waitForVideoReady();
        party.poller.start(code, host.user, title);
        return party;
    }

    /**
     * Guest joins through the party link. `ready=false` returns as soon as the watch
     * URL is reached (for the "host presses play right after a join" race).
     */
    async join(guest: Participant, opts: { ready?: boolean } = {}): Promise<void> {
        await guest.page.goto(`${webUrl()}/party/${this.code}`);
        // The SSR'd button is visible before hydration attaches its handler; an early
        // click silently no-ops, so wait out hydration and retry.
        await guest.page.waitForTimeout(2_500);
        const join = guest.page.locator('.device-option.this-device, .join-here-btn').first();
        let joined = /\/watch\//.test(guest.page.url());
        for (let i = 0; i < 3 && !joined; i++) {
            await join.click({ timeout: 10_000 }).catch(() => {});
            joined = await guest.page
                .waitForURL(`**/watch/${this.item.id}**`, { timeout: 10_000 })
                .then(() => true)
                .catch(() => /\/watch\//.test(guest.page.url()));
        }
        expect(joined, `${guest.name} did not reach the watch page after joining`).toBe(true);
        if (!this.guests.includes(guest)) this.guests.push(guest);
        // The server must list THIS tab under THIS user (not the dev admin fallback).
        const cid = await guest.clientId();
        await expect
            .poll(
                async () => {
                    const party = (await this.session()).session;
                    return party?.participants?.find((p) => p.clientId === cid)?.userId;
                },
                { message: `${guest.name} (${cid}) not listed as a participant`, timeout: 10_000 },
            )
            .toBe(guest.userId);
        if (opts.ready !== false) await guest.waitForVideoReady();
    }

    session(asUser = this.host.user): Promise<{ status: number; session: ServerSession | null }> {
        return fetchSession(this.code, asUser);
    }

    /** End via API (cleanup path; the UI path is Participant.disband). */
    async endViaApi(): Promise<void> {
        if (this.ended) return;
        await this.host.context.request
            .delete(`${webUrl()}/api/watch-together/${this.code}`, {
                headers: { Origin: webUrl() },
                timeout: 10_000,
            })
            .catch(() => {});
        this.ended = true;
    }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export interface DriftSample {
    positions: number[];
    playing: boolean[];
    drift: number;
}

/** Both (all) players read at the same instant. */
export async function sampleDrift(members: Participant[]): Promise<DriftSample | null> {
    const states = await Promise.all(members.map((m) => m.video()));
    if (states.some((s) => !s)) return null;
    const positions = states.map((s) => s!.t);
    return {
        positions,
        playing: states.map((s) => !s!.paused),
        drift: Math.max(...positions) - Math.min(...positions),
    };
}

export class Recorder {
    constructor(readonly title: string) {}

    log(kind: string, row: NdRow): void {
        appendNdjson('drift.ndjson', { kind, test: this.title, ...row });
    }

    /** Poll until every member reports `playing`. Returns ms taken. */
    async waitPlayState(
        members: Participant[],
        playing: boolean,
        label: string,
        timeout = 20_000,
    ): Promise<number> {
        const t0 = Date.now();
        await expect
            .poll(
                async () => {
                    const s = await sampleDrift(members);
                    return s
                        ? s.playing.map((p) => (p ? 'playing' : 'paused')).join(',')
                        : 'no-video';
                },
                {
                    message: `${label}: expected ${members.map((m) => m.name).join(' + ')} all ${playing ? 'playing' : 'paused'}`,
                    timeout,
                    intervals: [250, 500],
                },
            )
            .toBe(members.map(() => (playing ? 'playing' : 'paused')).join(','));
        const ms = Date.now() - t0;
        this.log('play-state', { label, playing, ms });
        return ms;
    }

    /** Poll until the spread of positions is under DRIFT_MAX. Returns ms taken. */
    async converge(
        members: Participant[],
        label: string,
        timeout = 25_000,
        max = DRIFT_MAX,
    ): Promise<number> {
        const t0 = Date.now();
        await expect
            .poll(async () => (await sampleDrift(members))?.drift ?? Infinity, {
                message: `${label}: players did not converge below ${max} s`,
                timeout,
                intervals: [250, 500],
            })
            .toBeLessThan(max);
        const ms = Date.now() - t0;
        this.log('converge', { label, ms });
        return ms;
    }

    /**
     * Converge first, then 5 simultaneous samples 300 ms apart; assert the median spread
     * and that every member agrees on play state.
     */
    async measureDrift(
        members: Participant[],
        label: string,
        timeout = 25_000,
        max = DRIFT_MAX,
    ): Promise<number> {
        const convergeMs = await this.converge(members, label, timeout, max);
        await sleep(300);
        const samples: DriftSample[] = [];
        for (let i = 0; i < 5; i++) {
            const s = await sampleDrift(members);
            if (s) samples.push(s);
            await sleep(300);
        }
        expect(samples.length, `${label}: fewer than 3 usable samples`).toBeGreaterThanOrEqual(3);
        const drifts = samples.map((s) => s.drift);
        const last = samples[samples.length - 1];
        const row = {
            label,
            samples: samples.map((s) => ({
                p: s.positions.map((x) => +x.toFixed(3)),
                on: s.playing,
            })),
            median: median(drifts),
            max: Math.max(...drifts),
            min: Math.min(...drifts),
            playing: last.playing,
            convergeMs,
            threshold: max,
        };
        this.log('drift', row);
        expect(row.median, `${label}: median drift ${row.median.toFixed(3)} s`).toBeLessThan(max);
        expect(
            new Set(last.playing).size,
            `${label}: play-state disagreement ${JSON.stringify(last.playing)}`,
        ).toBe(1);
        return row.median;
    }

    /** Assert play state holds for `ms` (no member flips) — e.g. "nobody starts alone". */
    async holdPlayState(
        members: Participant[],
        playing: boolean,
        ms: number,
        label: string,
    ): Promise<void> {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            const s = await sampleDrift(members);
            expect(
                s && s.playing.every((p) => p === playing),
                `${label}: expected all ${playing ? 'playing' : 'paused'} for ${ms} ms, got ${JSON.stringify(s)}`,
            ).toBe(true);
            await sleep(400);
        }
        this.log('hold', { label, playing, ms });
    }
}

// ---------------------------------------------------------------------------
// Real hidden tab (connectOverCDP with noDefaults)
// ---------------------------------------------------------------------------

/**
 * A Chromium launched by the test itself (not by Playwright), attached with connectOverCDP(noDefaults).
 *
 * Why: Playwright enables CDP focus emulation on every page it creates, which keeps
 * `document.visibilityState === 'visible'` no matter what — minimising the window,
 * bringing another tab to the front and Page.setWebLifecycleState all silently no-op
 * (measured on Linux headless Chromium 153). Only the DEFAULT context of a browser
 * attached with `noDefaults: true` skips that emulation. In `--headless=new` such a
 * browser has a real tab strip: activating another tab makes ours genuinely hidden,
 * and Page.setWebLifecycleState('frozen') then really stops its timers.
 */
export class CdpBrowser {
    private constructor(
        readonly browser: Browser,
        private readonly proc: ChildProcess,
        private readonly profileDir: string,
    ) {}

    static async launch(extraArgs: string[] = []): Promise<CdpBrowser> {
        const profileDir = mkdtempSync(join(tmpdir(), 'wt-cdp-'));
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
                ...extraArgs,
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

    /** Bring a blank tab to the front: every other tab of this browser becomes hidden. */
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

// ---------------------------------------------------------------------------
// Scenario wrapper
// ---------------------------------------------------------------------------

export type Direction = 'A hosts' | 'B hosts';

/**
 * Browser of a participant. WebKit is Safari's engine (Playwright's build); Brave is
 * the real Brave binary (WT_BRAVE_PATH) with its own defaults — notably autoplay.
 */
export type Engine = 'chromium' | 'webkit' | 'firefox' | 'brave';

/**
 * Per-project engine roles (tests/playwright/playwright.watch-together.config.ts `metadata`): which
 * engine the host and the guests run in. Default: everyone in Chromium.
 */
export interface EngineRoles {
    hostEngine?: Engine;
    guestEngine?: Engine;
    /** Cross-engine projects run one user direction: the engine roles are what vary. */
    singleDirection?: boolean;
}

async function launchEngine(engine: Exclude<Engine, 'chromium'>): Promise<Browser> {
    // `args: []` explicitly: the test runner merges the config's launchOptions (the
    // Chromium-only --autoplay-policy / --mute-audio flags) into every launch, and
    // WebKit dies on them.
    if (engine === 'brave') {
        const executablePath = process.env.WT_BRAVE_PATH;
        if (!executablePath) throw new Error('WT_BRAVE_PATH is not set');
        // No autoplay flag: Brave's own (stricter) autoplay default is the point.
        return chromium.launch({ executablePath, args: ['--mute-audio'] });
    }
    if (engine === 'firefox') {
        return firefox.launch({
            args: [],
            firefoxUserPrefs: {
                // Remote-driven play has no user gesture (Chromium: --autoplay-policy).
                'media.autoplay.default': 0,
                'media.autoplay.blocking_policy': 0,
                // Silent, like --mute-audio (the fixtures are silent too).
                'media.volume_scale': '0.0',
            },
        });
    }
    return webkit.launch({ args: [] });
}
export const DIRECTIONS: Direction[] = ['A hosts', 'B hosts'];

export interface Scn {
    title: string;
    direction: Direction;
    /** User of the host / first guest for this direction. */
    hostUser: string;
    guestUser: string;
    rec: Recorder;
    sql: postgres.Sql;
    testInfo: TestInfo;
    browser: Browser;
    /**
     * New context + tab for `user` (forward-auth headers, probes, trace). Its engine
     * follows the project's roles: labels starting with "host" use the host engine,
     * all others the guest engine; a given `context` keeps its own browser.
     */
    participant(
        user: string,
        label: string,
        opts?: { context?: BrowserContext; engine?: Engine },
    ): Promise<Participant>;
    /** This project's engine roles. */
    engines: { host: Engine; guest: Engine };
    /** Movie seeded under fresh ids for this test. */
    movie(): Promise<SeededMovie>;
    show(): Promise<SeededShow>;
    /** Host creates a party for a fresh movie, guest joins; both paused at 0, ready. */
    movieParty(): Promise<{ party: Party; host: Participant; guest: Participant }>;
    /** Track a party so cleanup ends it. */
    track(party: Party): Party;
    /** Register extra cleanup (runs first, reverse order). */
    onCleanup(fn: () => Promise<void>): void;
}

export function scenario(
    name: string,
    opts: {
        tag?: string[];
        timeout?: number;
        directions?: Direction[];
        /** Known product bug: skipped (test.fixme) unless WT_RUN_FIXME=1. */
        fixme?: string;
    },
    body: (s: Scn) => Promise<void>,
): void {
    for (const direction of opts.directions ?? DIRECTIONS) {
        const title = `${name} [${direction}]`;
        test(title, { tag: opts.tag ?? [] }, async ({ browser }, testInfo) => {
            test.fixme(!!opts.fixme && !process.env.WT_RUN_FIXME, opts.fixme);
            const roles = (testInfo.project.metadata ?? {}) as EngineRoles;
            const engines = {
                host: roles.hostEngine ?? 'chromium',
                guest: roles.guestEngine ?? 'chromium',
            };
            test.skip(
                !!roles.singleDirection && direction === 'B hosts',
                'cross-engine projects run one direction',
            );
            // Unique per project, so results/drift rows of several projects never mix.
            const runTitle =
                engines.host === 'chromium' && engines.guest === 'chromium'
                    ? title
                    : `${title} {${testInfo.project.name}}`;
            test.setTimeout(opts.timeout ?? 4 * 60_000);
            // Per worker: parallel scenarios never share a user (see wtUsersFor).
            const [a, b] = wtUsersFor(testInfo.parallelIndex);
            const hostUser = direction === 'A hosts' ? a : b;
            const guestUser = direction === 'A hosts' ? b : a;
            const rec = new Recorder(runTitle);
            const sql = connect();
            const contexts: { ctx: BrowserContext; own: boolean }[] = [];
            const participants: Participant[] = [];
            const parties: Party[] = [];
            const cleanups: (() => Promise<void>)[] = [];
            const extraBrowsers: Partial<Record<Engine, Browser>> = {};
            const t0 = Date.now();

            const s: Scn = {
                title: runTitle,
                direction,
                hostUser,
                guestUser,
                rec,
                sql,
                testInfo,
                browser,
                engines,
                async participant(user, label, o = {}) {
                    const own = !o.context;
                    const engine =
                        o.engine ?? (label.startsWith('host') ? engines.host : engines.guest);
                    let engineBrowser = browser;
                    if (!o.context && engine !== 'chromium') {
                        engineBrowser = extraBrowsers[engine] ??= await launchEngine(engine);
                    }
                    const ctx =
                        o.context ??
                        (await engineBrowser.newContext({
                            baseURL: webUrl(),
                            viewport: { width: 1280, height: 720 },
                            extraHTTPHeaders: identityHeaders(user),
                        }));
                    if (!own) await ctx.setExtraHTTPHeaders(identityHeaders(user));
                    // Traces: the config's `trace: 'retain-on-failure'` already records
                    // every context made from the `browser` fixture.
                    if (!contexts.some((c) => c.ctx === ctx)) contexts.push({ ctx, own });
                    const page = await ctx.newPage();
                    await page.addInitScript(installProbes);
                    const [account] = await sql<{ id: string }[]>`
                        SELECT id FROM users WHERE username = ${user.toLowerCase()} AND deleted_at IS NULL
                    `;
                    expect(account, `missing seeded account ${user}`).toBeDefined();
                    const p = new Participant(label, user, account.id, ctx, page);
                    participants.push(p);
                    return p;
                },
                movie: () => seedMovie(sql, runTitle),
                async show() {
                    const show = await seedShow(sql, runTitle);
                    cleanups.push(async () => {
                        rmSync(show.fixtureDir, { recursive: true, force: true });
                    });
                    return show;
                },
                async movieParty() {
                    const m = await s.movie();
                    const host = await s.participant(hostUser, 'host');
                    const guest = await s.participant(guestUser, 'guest');
                    const party = s.track(
                        await Party.create(
                            host,
                            { id: m.id, title: m.title, mediaType: 'movie' },
                            runTitle,
                        ),
                    );
                    await party.join(guest);
                    return { party, host, guest };
                },
                track(party) {
                    parties.push(party);
                    return party;
                },
                onCleanup(fn) {
                    cleanups.push(fn);
                },
            };

            try {
                await body(s);
                appendNdjson('results.ndjson', {
                    test: runTitle,
                    status: 'passed',
                    ms: Date.now() - t0,
                });
            } catch (err) {
                // test.skip() inside the body throws; let Playwright see it unwrapped.
                if (testInfo.expectedStatus === 'skipped') {
                    appendNdjson('results.ndjson', { test: runTitle, status: 'skipped' });
                    throw err;
                }
                const msg = err instanceof Error ? err.message : String(err);
                const diag: string[] = [];
                for (const p of participants) {
                    const shot = testInfo.outputPath(`fail-${p.label}.png`);
                    await p.page.screenshot({ path: shot }).catch(() => {});
                    diag.push(
                        `${p.name}: video=${JSON.stringify(await p.video())} url=${p.page.url()} sse=${JSON.stringify(await p.sse())} plays=${JSON.stringify(await p.plays())}\n    text=${JSON.stringify(await p.visibleText())}\n    errors=${JSON.stringify(p.errors)}\n    lifecycle=${JSON.stringify(await p.lifecycle())}`,
                    );
                }
                for (const party of parties)
                    diag.push(`server: ${JSON.stringify(party.poller.last)}`);
                appendNdjson('results.ndjson', {
                    test: runTitle,
                    status: 'failed',
                    error: msg.slice(0, 2_000),
                    ms: Date.now() - t0,
                });
                throw new Error(`${msg}\n--- diagnostics ---\n${diag.join('\n')}`, { cause: err });
            } finally {
                // Parties first, while every context is still open: a host living in
                // a CdpBrowser is gone once its cleanup closes that browser, and its
                // DELETE then failed silently. The leaked party was later ended by the
                // server's sweeper, which (until fixed alongside this) also wiped the
                // next scenario's host's "current party" pointer.
                for (const party of parties) {
                    party.poller.stop();
                    await party.endViaApi();
                }
                for (const fn of cleanups.reverse()) await fn().catch(() => {});
                for (const { ctx, own } of contexts) if (own) await ctx.close().catch(() => {});
                for (const b of Object.values(extraBrowsers)) await b?.close().catch(() => {});
                await sql.end().catch(() => {});
            }
        });
    }
}

/** The server's log (the config redirects it into the output directory). */
export function serverLog(): string {
    const p = join(DIR, 'server.log');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/** Summary writer for the zz-finalize test. */
export function writeSummary(): NdRow {
    const results = readNdjson('results.ndjson');
    const drift = readNdjson('drift.ndjson');
    const tests: NdRow = {};
    for (const r of results) {
        const rows = drift.filter((d) => d.test === r.test);
        const measured = rows.filter((d) => d.kind === 'drift');
        tests[r.test] = {
            status: r.status,
            error: r.error ?? null,
            durationMs: r.ms,
            drift: {
                measurements: measured.length,
                worstMedian: measured.length ? Math.max(...measured.map((d) => d.median)) : null,
                worstMax: measured.length ? Math.max(...measured.map((d) => d.max)) : null,
            },
            timeToConvergeMs: rows
                .filter((d) => d.kind === 'converge')
                .map((d) => ({ label: d.label, ms: d.ms })),
            observations: rows.filter((d) => d.kind === 'observed'),
        };
    }
    return { runId: RUN_ID, driftMax: DRIFT_MAX, tests };
}
