// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together — cross-client e2e: Chromium (this spec) <-> Apple TV simulator.
 *
 * Run with tests/playwright/playwright.watch-together-tv.config.ts (NOT collected by the normal run).
 * The Apple TV app is driven by an XCUITest "driver" that polls ${WT_E2E_DIR}/tv-cmd.json;
 * the app itself writes a state probe (WT_TV_PROBE_FILE) every ~250 ms.
 *
 * Env: WT_WEB_URL, WT_WEB_USER (default test2), WT_ITEM_ID, WT_TV_PAT, WT_E2E_DIR,
 *      WT_TV_PROBE_FILE, WT_SCENARIOS (comma list), WT_DRIFT_MAX (default 1.0 s).
 *
 * Design decisions (see report):
 *  - The server is observed by POLLING GET /api/v1/watch-together/{code} once a second,
 *    never by an SSE tap: the SSE GET registers a connection for the participant's user
 *    (the TV's user) and could affect buffer-check accounting, which would make the
 *    measurement change the thing measured.
 *  - Playwright restarts the worker after a failed test, so nothing needed across tests
 *    lives in module memory: results/drift go to ndjson files, and the TV is quit by a
 *    final test (not afterAll, which would also fire on every worker restart).
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WEB_URL = (process.env.WT_WEB_URL || '').replace(/\/$/, '');
const WEB_USER = process.env.WT_WEB_USER || 'test2';
const ITEM_ID = process.env.WT_ITEM_ID || '7e2e0000-0000-4000-8000-00000000a7b1';
const ITEM_TITLE = 'WT E2E Test Pattern';
// Seeded show: 3 episodes of one season, 60 s each, Intro 5-15 s and Outro (credits) 45-60 s.
const EP2 = '7e2e0000-0000-4000-8000-00000000b102';
const EP3 = '7e2e0000-0000-4000-8000-00000000b103';
// The browser-hosted scenario uses its own show (seeded by the runner), so the
// TV-hosted run's watch progress can't make E2 reopen at its end and auto-advance.
const WEB_EP2 = '7e2e0000-0000-4000-8000-00000000c102';
const WEB_EP3 = '7e2e0000-0000-4000-8000-00000000c103';
const TV_PAT = process.env.WT_TV_PAT || '';
const DIR = process.env.WT_E2E_DIR || './test-results/wt-e2e';
const PROBE_FILE = process.env.WT_TV_PROBE_FILE || '';
// xcodebuild reinstalls the app when the driver starts, which moves its data
// container — so a path resolved up front goes stale. With the simulator + bundle
// id the probe path is re-resolved whenever the file disappears.
const TV_UDID = process.env.WT_TV_UDID || '';
const TV_BUNDLE_ID = process.env.WT_TV_BUNDLE_ID || '';
let probePath = PROBE_FILE;
let probePathResolvedAt = 0;

function resolveProbePath(): string {
    if (probePath && existsSync(probePath)) return probePath;
    if (!TV_UDID || !TV_BUNDLE_ID || Date.now() - probePathResolvedAt < 2_000) return probePath;
    probePathResolvedAt = Date.now();
    try {
        const container = execFileSync(
            'xcrun',
            ['simctl', 'get_app_container', TV_UDID, TV_BUNDLE_ID, 'data'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
        probePath = join(container, 'Library/Caches/wt-probe.json');
    } catch {
        // app not installed yet — keep the old guess
    }
    return probePath;
}
const DRIFT_MAX = Number(process.env.WT_DRIFT_MAX || '1.0');
const RUN_ID = process.env.WT_RUN_ID || 'norun';
const SCENARIOS = (process.env.WT_SCENARIOS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const STORAGE_KEY = 'dashboard_watch_party';
const CLIENT_ID_KEY = 'dashboard_watch_party_client_id';

/** A probe older than this is not a trustworthy "now" (the app writes every ~250 ms). */
const PROBE_MAX_AGE_S = 1.5;

mkdirSync(DIR, { recursive: true });

// Browser identity: forward-auth headers on every request (page + context.request).
test.use({
    extraHTTPHeaders: { 'X-Forwarded-User': WEB_USER, 'X-Forwarded-Groups': 'Users' },
});

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function appendNdjson(file: string, row: Record<string, unknown>): void {
    appendFileSync(
        join(DIR, file),
        JSON.stringify({ runId: RUN_ID, ts: Date.now(), ...row }) + '\n',
    );
}

/** One ndjson row; loosely typed on purpose — rows of several kinds share a file. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NdRow = Record<string, any>;

function readNdjson(file: string): NdRow[] {
    const p = join(DIR, file);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            try {
                return JSON.parse(l);
            } catch {
                return null;
            }
        })
        .filter((r): r is NdRow => !!r && r.runId === RUN_ID);
}

function readJson<T>(path: string): T | null {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
        return null; // missing, or caught mid-write
    }
}

const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------------------------------------------------------------------
// TV bridge (command channel + probe)
// ---------------------------------------------------------------------------

interface TvProbe {
    t: number; // unix seconds, wall clock of the sample
    appState?: string;
    connection?: string;
    playbackState?: string;
    inSession?: boolean;
    code?: string;
    role?: 'host' | 'guest';
    participants?: unknown;
    sessionTime?: number;
    sessionPlaying?: boolean;
    position?: number;
    playing?: boolean;
    engine?: string;
    itemId?: string;
    /** The item the TV's player is on (the session's itemId switches first). */
    playerItemId?: string;
}

interface TvAck {
    seq: number;
    cmd: string;
    ok: boolean;
    error?: string;
    marker?: string;
    t?: number;
}

class TvBridge {
    private seq = 0;
    private readyPromise: Promise<void> | null = null;
    private cmdFile = join(DIR, 'tv-cmd.json');
    private ackFile = join(DIR, 'tv-ack.json');

    /** Wait (once) for the XCUITest driver; xcodebuild needs minutes to build. */
    ready(): Promise<void> {
        this.readyPromise ??= (async () => {
            // Strictly increasing across worker restarts: continue after whatever the
            // ack/cmd files say (a command that timed out may still be acked later).
            const lastAck = readJson<TvAck>(this.ackFile)?.seq ?? 0;
            const lastCmd = readJson<{ seq: number }>(this.cmdFile)?.seq ?? 0;
            this.seq = Math.max(lastAck, lastCmd);

            const deadline = Date.now() + 10 * 60_000;
            while (!existsSync(join(DIR, 'tv-driver.json'))) {
                if (Date.now() > deadline)
                    throw new Error('tv-driver.json never appeared (10 min)');
                await sleep(1_000);
            }
        })();
        return this.readyPromise;
    }

    async send(
        cmd: string,
        args: Record<string, string> = {},
        timeoutMs = cmd === 'launch' ? 180_000 : 120_000,
    ): Promise<TvAck> {
        await this.ready();
        const seq = ++this.seq;
        const tmp = this.cmdFile + '.tmp';
        // Write + rename so the driver never reads a half-written command.
        writeFileSync(tmp, JSON.stringify({ seq, cmd, args }));
        renameSync(tmp, this.cmdFile);
        appendNdjson('tv-commands.ndjson', { seq, cmd, args });

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const ack = readJson<TvAck>(this.ackFile);
            if (ack && ack.seq >= seq) {
                appendNdjson('tv-commands.ndjson', { ack });
                if (ack.seq > seq)
                    throw new Error(`TV ack seq ${ack.seq} skipped past ${seq} (${cmd})`);
                if (!ack.ok)
                    throw new Error(`TV command '${cmd}' failed: ${ack.error ?? 'unknown'}`);
                return ack;
            }
            await sleep(250);
        }
        throw new Error(`TV command '${cmd}' (seq ${seq}) not acked within ${timeoutMs} ms`);
    }

    press(button: string, times = 1): Promise<TvAck> {
        return this.send('press', { button, times: String(times) });
    }

    probe(): TvProbe | null {
        const path = resolveProbePath();
        return path ? readJson<TvProbe>(path) : null;
    }

    /**
     * The TV's playhead extrapolated to this instant (the probe is up to 250 ms old),
     * or null if the sample is too old to trust. `allowStale` is for a backgrounded app,
     * where the app legitimately stops writing.
     */
    positionNow(allowStale = false): { pos: number; playing: boolean; ageS: number } | null {
        const p = this.probe();
        if (!p || typeof p.position !== 'number') return null;
        const ageS = Date.now() / 1000 - p.t;
        const fresh = ageS <= PROBE_MAX_AGE_S;
        if (!fresh && !allowStale) return null;
        const playing = !!p.playing;
        return { pos: p.position + (playing && fresh ? ageS : 0), playing, ageS };
    }

    async waitProbe(
        pred: (p: TvProbe) => boolean,
        timeoutMs: number,
        label: string,
    ): Promise<TvProbe> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const p = this.probe();
            if (p && pred(p)) return p;
            await sleep(250);
        }
        throw new Error(
            `TV probe: ${label} not reached within ${timeoutMs} ms; last=${JSON.stringify(this.probe())}`,
        );
    }
}

const tv = new TvBridge();

// ---------------------------------------------------------------------------
// Server observer (polling; see header for why not SSE)
// ---------------------------------------------------------------------------

class ServerPoller {
    last: unknown = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private inFlight = false;

    start(code: string, scenario: string): void {
        this.stop();
        const tick = async () => {
            if (this.inFlight) return;
            this.inFlight = true;
            try {
                const res = await fetch(`${WEB_URL}/api/v1/watch-together/${code}`, {
                    headers: { Authorization: `Bearer ${TV_PAT}` },
                });
                type SessionView = {
                    currentTime?: number;
                    isPlaying?: boolean;
                    lastSync?: number;
                    participants?: unknown;
                };
                const body = (await res.json().catch(() => null)) as {
                    party?: SessionView;
                } | null;
                const s: SessionView | null = body?.party ?? (body as SessionView | null);
                this.last = { status: res.status, session: s };
                appendNdjson('server-events.ndjson', {
                    scenario,
                    code,
                    status: res.status,
                    currentTime: s?.currentTime,
                    isPlaying: s?.isPlaying,
                    lastSync: s?.lastSync,
                    participants: s?.participants,
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
// Scenario context + browser helpers
// ---------------------------------------------------------------------------

interface Ctx {
    name: string;
    page: Page;
    context: BrowserContext;
    poller: ServerPoller;
    code?: string;
    /** True when the browser user is the session host (so cleanup may DELETE it). */
    webIsHost: boolean;
}

interface WebState {
    t: number;
    paused: boolean;
}

function webState(page: Page): Promise<WebState | null> {
    return page.evaluate(() => {
        const v = document.querySelector('video');
        return v ? { t: v.currentTime, paused: v.paused } : null;
    });
}

async function waitForVideoReady(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            const v = document.querySelector('video');
            return !!v && v.readyState >= 2;
        },
        undefined,
        { timeout: 90_000 },
    );
}

/** Own clientId per tab; only set when absent so it survives page.goto within the tab. */
async function seedClientId(
    page: Page,
    clientId: string,
    stored?: { code: string; userId: string },
): Promise<void> {
    await page.addInitScript(
        ({ cidKey, cid, sKey, sVal }) => {
            if (!sessionStorage.getItem(cidKey)) sessionStorage.setItem(cidKey, cid);
            if (sVal && !localStorage.getItem(sKey)) localStorage.setItem(sKey, sVal);
        },
        {
            cidKey: CLIENT_ID_KEY,
            cid: clientId,
            sKey: STORAGE_KEY,
            sVal: stored ? JSON.stringify({ code: stored.code, userId: stored.userId }) : '',
        },
    );
}

/** Open /party/{code} and join. Tolerates an auto-join (already on /watch). */
async function joinViaPartyLink(page: Page, code: string, itemId = ITEM_ID): Promise<void> {
    await page.goto(`/party/${code}`);
    // The SSR'd join button is visible before hydration attaches its handler; an early
    // click silently no-ops, so wait out hydration and retry (as the two-tab spec does).
    await page.waitForTimeout(2_500);
    const join = page.locator('.join-here-btn, .device-option.this-device').first();
    let joined = /\/watch\//.test(page.url());
    for (let i = 0; i < 3 && !joined; i++) {
        await join.click({ timeout: 10_000 }).catch(() => {});
        joined = await page
            .waitForURL(`**/watch/${itemId}**`, { timeout: 10_000 })
            .then(() => true)
            .catch(() => /\/watch\//.test(page.url()));
    }
    expect(joined, 'browser did not reach the watch page after joining').toBe(true);
    await waitForVideoReady(page);
}

/** Focus the player once so keyboard shortcuts land. */
async function focusPlayer(page: Page): Promise<void> {
    // The video fills the body: clicking its corner can toggle playback before
    // the following shortcut, turning an intended Pause into a second Play.
    await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        document.body.tabIndex = -1;
        document.body.focus();
    });
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface DriftSample {
    web: number;
    tv: number;
    drift: number;
    webPlaying: boolean;
    tvPlaying: boolean;
}

async function sampleDrift(ctx: Ctx, allowStale = false): Promise<DriftSample | null> {
    const w = await webState(ctx.page);
    const t = tv.positionNow(allowStale);
    if (!w || !t) return null;
    return {
        web: w.t,
        tv: t.pos,
        drift: Math.abs(t.pos - w.t),
        webPlaying: !w.paused,
        tvPlaying: t.playing,
    };
}

/** Poll until both sides report the given play state. Returns ms taken. */
async function waitPlayState(
    ctx: Ctx,
    playing: boolean,
    label: string,
    timeout = 20_000,
): Promise<number> {
    const t0 = Date.now();
    await expect
        .poll(
            async () => {
                const s = await sampleDrift(ctx);
                return s ? `${s.webPlaying === playing && s.tvPlaying === playing}` : 'no-sample';
            },
            {
                message: `${label}: expected both sides playing=${playing}`,
                timeout,
                intervals: [250, 500],
            },
        )
        .toBe('true');
    const ms = Date.now() - t0;
    appendNdjson('drift.ndjson', { kind: 'play-state', scenario: ctx.name, label, playing, ms });
    return ms;
}

/** Poll until |tv - web| < DRIFT_MAX; returns time-to-converge in ms. */
async function converge(
    ctx: Ctx,
    label: string,
    timeout = 20_000,
    allowStale = false,
): Promise<number> {
    const t0 = Date.now();
    await expect
        .poll(async () => (await sampleDrift(ctx, allowStale))?.drift ?? Infinity, {
            message: `${label}: TV and browser did not converge`,
            timeout,
            intervals: [250, 500],
        })
        .toBeLessThan(DRIFT_MAX);
    const ms = Date.now() - t0;
    appendNdjson('drift.ndjson', { kind: 'converge', scenario: ctx.name, label, ms });
    return ms;
}

/** Converge, then take 5 samples 300 ms apart and assert median drift + play-state agreement. */
async function measureDrift(ctx: Ctx, label: string, timeout = 20_000): Promise<void> {
    const convergeMs = await converge(ctx, label, timeout);
    await sleep(300);
    const samples: DriftSample[] = [];
    for (let i = 0; i < 5; i++) {
        const s = await sampleDrift(ctx);
        if (s) samples.push(s);
        await sleep(300);
    }
    expect(samples.length, `${label}: fewer than 3 usable drift samples`).toBeGreaterThanOrEqual(3);
    const drifts = samples.map((s) => s.drift);
    const last = samples[samples.length - 1];
    const row = {
        kind: 'drift',
        scenario: ctx.name,
        label,
        samples,
        median: median(drifts),
        max: Math.max(...drifts),
        min: Math.min(...drifts),
        tvPlaying: last.tvPlaying,
        webPlaying: last.webPlaying,
        convergeMs,
    };
    appendNdjson('drift.ndjson', row);
    expect(row.median, `${label}: median drift ${row.median.toFixed(3)} s`).toBeLessThan(DRIFT_MAX);
    expect(
        row.tvPlaying,
        `${label}: play-state disagreement (tv=${row.tvPlaying} web=${row.webPlaying})`,
    ).toBe(row.webPlaying);
}

// ---------------------------------------------------------------------------
// Setup / cleanup shared by scenarios
// ---------------------------------------------------------------------------

/** Fresh TV on the detail page, TV creates+hosts a party, browser joins via the link. */
async function setupTvHosted(ctx: Ctx, itemId = ITEM_ID, mediaType = 'movie'): Promise<void> {
    await tv.send('launch', { openMedia: `${itemId}|${mediaType}` });
    await tv.send('createParty');
    const p = await tv.waitProbe(
        (x) => !!x.inSession && !!x.code && x.role === 'host',
        60_000,
        'TV hosting a party',
    );
    ctx.code = p.code!;
    ctx.poller.start(ctx.code, ctx.name);
    ctx.webIsHost = false;

    await seedClientId(ctx.page, `client_e2e_web_${ctx.name}_${Date.now()}`);
    await joinViaPartyLink(ctx.page, ctx.code, itemId);
    await focusPlayer(ctx.page);
    // Server initiates a join buffer-check ~1 s after join; let it settle.
    await ctx.page.waitForTimeout(3_000);
}

async function webToggle(ctx: Ctx): Promise<void> {
    await ctx.page.keyboard.press('k');
}

/** Poll until the TV playhead is inside [min, max] seconds (e.g. "in the intro"). */
async function waitTvPosition(
    label: string,
    min: number,
    max: number,
    timeout = 30_000,
): Promise<void> {
    await expect
        .poll(() => tv.positionNow()?.pos ?? -1, {
            message: `${label}: TV position not in [${min}, ${max}]`,
            timeout,
            intervals: [250],
        })
        .toBeGreaterThanOrEqual(min);
    expect(
        tv.positionNow()?.pos ?? Infinity,
        `${label}: TV already past ${max} s`,
    ).toBeLessThanOrEqual(max);
}

/** Poll until the TV playhead reaches `min` seconds. */
async function waitTvAtLeast(label: string, min: number, timeout = 20_000): Promise<void> {
    await expect
        .poll(() => tv.positionNow()?.pos ?? -1, {
            message: `${label}: TV position < ${min}`,
            timeout,
            intervals: [250],
        })
        .toBeGreaterThanOrEqual(min);
}

/**
 * Assert an overlay is NOT on screen. The driver acks overlayVisible with ok=false and
 * an "absent: ..." error when the overlay never shows up; any other failure (driver
 * crash, ack timeout) is a real error and must not be read as "absent".
 */
async function expectTvOverlayAbsent(id: string, timeoutS = 4): Promise<void> {
    let err: unknown = null;
    try {
        await tv.send('overlayVisible', { id, timeout: String(timeoutS) });
    } catch (e) {
        err = e;
    }
    expect(err, `TV overlay '${id}' was visible but must be absent`).not.toBeNull();
    expect(String(err), `overlayVisible '${id}' failed for a reason other than absence`).toMatch(
        /absent/i,
    );
}

/** After a navigate: browser on /watch/<id> with a ready video, TV probe on the same item. */
async function expectBothOnItem(ctx: Ctx, itemId: string, label: string): Promise<void> {
    await ctx.page.waitForURL(`**/watch/${itemId}**`, { timeout: 25_000 });
    await tv.waitProbe(
        // ...and its clock restarted: the coordinator switches its item before the new
        // stream replaces the old one, which keeps running for a moment.
        (p) => p.itemId === itemId && p.playerItemId === itemId && (p.position ?? 99) < 10,
        25_000,
        `${label}: TV player on item ${itemId}`,
    );
    await waitForVideoReady(ctx.page);
}

/** Both start paused near 0 on a fresh party. */
async function expectFreshPartyInSync(ctx: Ctx): Promise<void> {
    await waitPlayState(ctx, false, 'fresh party paused');
    await measureDrift(ctx, 'fresh party');
}

/** Leave nothing behind: web off the watch page, any session ended, TV out of the player. */
async function cleanup(ctx: Ctx): Promise<void> {
    ctx.poller.stop();
    await ctx.context.setOffline(false).catch(() => {});
    await ctx.page.goto('/', { timeout: 15_000 }).catch(() => {});
    if (tv.probe()?.inSession) {
        // Host exit disbands the party, guest exit leaves it.
        await tv.send('exitPlayer').catch(() => {});
        await tv.waitProbe((p) => !p.inSession, 10_000, 'TV left the session').catch(() => {});
    }
    if (ctx.code && ctx.webIsHost) {
        await ctx.context.request
            .delete(`/api/watch-together/${ctx.code}`, { headers: { Origin: WEB_URL } })
            .catch(() => {});
    }
    // Safety net: a party the TV still hosts would change the next scenario's screens
    // (Rejoin panel) — end it server-side with the TV's own token.
    await disbandTvParty().catch(() => {});
}

async function disbandTvParty(): Promise<void> {
    const headers = { Authorization: `Bearer ${TV_PAT}`, 'content-type': 'application/json' };
    const res = await fetch(`${WEB_URL}/api/v1/watch-together`, { headers });
    const session = (
        (await res.json()) as {
            party: { code: string; hostClientId: string; host: { userId: string } } | null;
        }
    ).party;
    if (!session) return;
    await fetch(
        `${WEB_URL}/api/v1/watch-together/${session.code}/events?clientId=${encodeURIComponent(session.hostClientId)}`,
        {
            method: 'POST',
            headers,
            body: JSON.stringify({ clientId: session.hostClientId, type: 'disband', payload: {} }),
        },
    );
}

/** Screenshot web + TV and dump the last probe/server poll for the error message. */
async function diagnostics(ctx: Ctx): Promise<string> {
    const stamp = `${ctx.name}-${Date.now()}`;
    await ctx.page.screenshot({ path: join(DIR, `fail-${stamp}-web.png`) }).catch(() => {});
    await tv.send('screenshot', { name: `fail-${stamp}` }, 30_000).catch(() => {});
    const web = await webState(ctx.page).catch(() => null);
    return [
        `last TV probe: ${JSON.stringify(tv.probe())}`,
        `last server poll: ${JSON.stringify(ctx.poller.last)}`,
        `web video: ${JSON.stringify(web)} url=${ctx.page.url()}`,
        `screenshots: ${DIR}/fail-${stamp}-*`,
    ].join('\n');
}

/** Register a scenario: skip filter, diagnostics on failure, result row, guaranteed cleanup. */
function scenario(name: string, body: (ctx: Ctx) => Promise<void>): void {
    test(name, async ({ page, context }) => {
        test.skip(SCENARIOS.length > 0 && !SCENARIOS.includes(name), 'not in WT_SCENARIOS');
        const ctx: Ctx = { name, page, context, poller: new ServerPoller(), webIsHost: false };
        const t0 = Date.now();
        try {
            await body(ctx);
            appendNdjson('results.ndjson', {
                scenario: name,
                status: 'passed',
                ms: Date.now() - t0,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const diag = await diagnostics(ctx);
            appendNdjson('results.ndjson', {
                scenario: name,
                status: 'failed',
                error: msg,
                ms: Date.now() - t0,
            });
            throw new Error(`${msg}\n--- diagnostics ---\n${diag}`, { cause: err });
        } finally {
            await cleanup(ctx);
        }
    });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test.describe('Watch Together — browser <-> Apple TV', () => {
    test.beforeAll(async () => {
        test.setTimeout(11 * 60_000); // up to 10 min for xcodebuild to bring the driver up
        expect(WEB_URL, 'WT_WEB_URL is required').not.toBe('');
        expect(TV_PAT, 'WT_TV_PAT is required').not.toBe('');
        expect(PROBE_FILE, 'WT_TV_PROBE_FILE is required').not.toBe('');
        await tv.ready();
    });

    scenario('tv-hosts-basic', async (ctx) => {
        await setupTvHosted(ctx);
        await expectFreshPartyInSync(ctx);

        await tv.press('playPause');
        await waitPlayState(ctx, true, 'TV play -> browser plays');
        await ctx.page.waitForTimeout(3_000);
        await measureDrift(ctx, 'after TV play');

        await tv.press('playPause');
        await waitPlayState(ctx, false, 'TV pause -> browser pauses');
        await measureDrift(ctx, 'after TV pause');
    });

    scenario('web-controls-tv', async (ctx) => {
        await setupTvHosted(ctx);
        await expectFreshPartyInSync(ctx);

        await webToggle(ctx); // browser (guest) play
        await waitPlayState(ctx, true, 'browser play -> TV plays');
        await ctx.page.waitForTimeout(3_000);
        await measureDrift(ctx, 'after browser play');

        await webToggle(ctx); // browser (guest) pause
        await waitPlayState(ctx, false, 'browser pause -> TV pauses');
        await measureDrift(ctx, 'after browser pause');
    });

    scenario('seeks', async (ctx) => {
        await setupTvHosted(ctx);
        await tv.press('playPause');
        await waitPlayState(ctx, true, 'playing before seeks');
        await ctx.page.waitForTimeout(3_000);
        await measureDrift(ctx, 'before seeks');

        // Host (TV) seeks. The jump size is logged, not asserted: the TV skip interval is
        // an app detail; what matters is that the browser follows.
        const observeJump = async (label: string, before: number, t0: number) => {
            await sleep(2_500);
            const after = tv.positionNow();
            const elapsed = (Date.now() - t0) / 1000;
            const jump = after ? after.pos - before - elapsed : null;
            appendNdjson('drift.ndjson', { kind: 'seek-jump', scenario: ctx.name, label, jump });
            return jump;
        };

        let before = tv.positionNow()!.pos;
        let t0 = Date.now();
        await tv.press('right', 2);
        const fwd = await observeJump('TV right x2', before, t0);
        expect(fwd, 'TV position did not move forward on 2x right').toBeGreaterThan(5);
        await converge(ctx, 'browser follows TV forward seek', 25_000);
        await waitPlayState(ctx, true, 'playing after forward seek', 25_000);
        await measureDrift(ctx, 'after TV forward seek', 25_000);

        before = tv.positionNow()!.pos;
        t0 = Date.now();
        await tv.press('left');
        const back = await observeJump('TV left x1', before, t0);
        expect(back, 'TV position did not move backward on left').toBeLessThan(-3);
        await converge(ctx, 'browser follows TV backward seek', 25_000);
        await measureDrift(ctx, 'after TV backward seek', 25_000);

        // Second skip INSIDE the first skip's barrier (which holds the host paused for
        // ~2 s). The host used to read its paused player and broadcast "seek, paused",
        // stopping the whole party; and a seek inside the echo window was dropped.
        before = tv.positionNow()!.pos;
        t0 = Date.now();
        await tv.press('right');
        await sleep(1_500);
        await tv.press('right');
        const spaced = await observeJump('TV right, right 1.5 s later', before, t0);
        expect(spaced, 'the second skip inside the barrier was lost').toBeGreaterThan(14);
        await waitPlayState(ctx, true, 'party keeps playing after a skip inside a barrier', 25_000);
        await converge(ctx, 'browser follows the spaced double skip', 25_000);
        await measureDrift(ctx, 'after spaced double skip', 25_000);

        // Web guest seek: VideoShortcuts ignores seek keys when isWatchPartyGuest (VOD guests
        // cannot seek from the keyboard), same as tvOS guests. Log what actually happens and
        // assert the party stays in sync either way.
        const w0 = (await webState(ctx.page))!.t;
        const wt0 = Date.now();
        await ctx.page.keyboard.press('ArrowRight');
        await ctx.page.waitForTimeout(4_000);
        const w1 = (await webState(ctx.page))!.t;
        const webJump = w1 - w0 - (Date.now() - wt0) / 1000;
        const blocked = webJump < 5;
        appendNdjson('drift.ndjson', { kind: 'guest-seek', scenario: ctx.name, webJump, blocked });
        test.info().annotations.push({
            type: 'guest-seek',
            description: blocked
                ? 'guest seek blocked by design'
                : `web guest seek ACCEPTED (jump ${webJump.toFixed(1)} s)`,
        });
        console.log(
            blocked
                ? '[seeks] guest seek blocked by design'
                : `[seeks] web guest seek accepted, jump=${webJump}`,
        );
        await converge(
            ctx,
            blocked ? 'still in sync after blocked guest seek' : 'TV follows web guest seek',
            25_000,
        );
        await measureDrift(ctx, 'after guest seek attempt', 25_000);
    });

    scenario('web-leave-rejoin', async (ctx) => {
        await setupTvHosted(ctx);
        await tv.press('playPause');
        await waitPlayState(ctx, true, 'playing before leave');
        await ctx.page.waitForTimeout(3_000);

        await ctx.page.goto('/'); // leave the player (party membership may persist in localStorage)
        await ctx.page.waitForTimeout(5_000);
        expect(tv.probe()?.playing, 'TV should keep playing while the browser is away').toBe(true);

        await joinViaPartyLink(ctx.page, ctx.code!);
        await focusPlayer(ctx.page);
        await converge(ctx, 'browser resumes at shared position', 20_000);
        await waitPlayState(ctx, true, 'both playing after rejoin');
        await measureDrift(ctx, 'after browser rejoin');
    });

    scenario('tv-background', async (ctx) => {
        await setupTvHosted(ctx);
        await tv.press('playPause');
        await waitPlayState(ctx, true, 'playing before background');
        await ctx.page.waitForTimeout(3_000);

        await tv.send('background');
        await sleep(10_000);
        const during = {
            web: await webState(ctx.page),
            tv: tv.probe(),
            server: ctx.poller.last,
        };
        appendNdjson('drift.ndjson', {
            kind: 'observed',
            scenario: ctx.name,
            label: 'while TV backgrounded',
            ...during,
        });

        await tv.send('activate');
        await sleep(3_000);
        const after = tv.probe();
        const needsRejoin = !after?.inSession || after.appState !== 'active';
        appendNdjson('drift.ndjson', {
            kind: 'observed',
            scenario: ctx.name,
            label: 'after activate',
            probe: after,
            needsRejoin,
        });
        console.log(
            `[tv-background] after activate: inSession=${after?.inSession} needsRejoin=${needsRejoin}`,
        );
        if (!after?.inSession) {
            await tv.send('rejoin');
            await tv.waitProbe((p) => !!p.inSession, 30_000, 'TV back in session after rejoin');
        }
        test.info().annotations.push({
            type: 'tv-background',
            description: needsRejoin
                ? 'TV needed rejoin after activate'
                : 'TV stayed in session across background',
        });

        // Both sides must agree on play state again, then positions must match.
        await expect
            .poll(
                async () => {
                    const s = await sampleDrift(ctx);
                    return s ? s.webPlaying === s.tvPlaying : false;
                },
                {
                    message: 'play state did not re-agree after background',
                    timeout: 25_000,
                    intervals: [500],
                },
            )
            .toBe(true);
        await measureDrift(ctx, 'after TV background + rejoin', 25_000);
    });

    scenario('web-hidden-tab', async (ctx) => {
        await setupTvHosted(ctx);
        await tv.press('playPause');
        await waitPlayState(ctx, true, 'playing before hidden');
        await ctx.page.waitForTimeout(3_000);

        // Headless Chromium has no real tab visibility, and CDP Page.setWebLifecycleState
        // only offers frozen/active (freezing would stop timers, a different test). So fake
        // what the app observes: document.hidden / visibilityState + a visibilitychange event.
        const method = 'visibility-override';
        appendNdjson('drift.ndjson', {
            kind: 'observed',
            scenario: ctx.name,
            label: 'hidden-tab method',
            method,
        });
        console.log(`[web-hidden-tab] method=${method}`);
        await ctx.page.evaluate(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                get: () => 'hidden',
            });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await sleep(10_000);
        await ctx.page.evaluate(() => {
            // Deleting the own-property restores the prototype getters.
            const doc = document as unknown as Record<'hidden' | 'visibilityState', unknown>;
            delete doc.hidden;
            delete doc.visibilityState;
            document.dispatchEvent(new Event('visibilitychange'));
        });

        await waitPlayState(ctx, true, 'playing after returning from hidden', 25_000);
        await measureDrift(ctx, 'after hidden tab', 20_000);
    });

    scenario('web-network-blip', async (ctx) => {
        await setupTvHosted(ctx);
        await tv.press('playPause');
        await waitPlayState(ctx, true, 'playing before blip');
        await ctx.page.waitForTimeout(3_000);

        await ctx.context.setOffline(true);
        await sleep(6_000);
        await ctx.context.setOffline(false);

        // No permanent pause: the party must come back to playing on both sides.
        await waitPlayState(ctx, true, 'playing after network blip', 25_000);
        await measureDrift(ctx, 'after network blip', 25_000);
    });

    scenario('tv-host-ends', async (ctx) => {
        await setupTvHosted(ctx);
        await tv.press('playPause');
        await waitPlayState(ctx, true, 'playing before host ends');
        await ctx.page.waitForTimeout(2_000);
        expect(await ctx.page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).not.toBeNull();

        await tv.send('exitPlayer'); // host exit disbands the party

        // Web store on `session_ended`: shows a 'disband' toast, clearStorage() (removes
        // dashboard_watch_party) and disconnects. It does not itself navigate away, so the
        // cleared localStorage entry is the reliable signal.
        await expect
            .poll(() => ctx.page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY), {
                message: 'web did not drop the watch party after host disbanded',
                timeout: 10_000,
                intervals: [250, 500],
            })
            .toBeNull();

        // Whether the video stops is not guaranteed by the store (it just disconnects), so
        // this is observed + annotated rather than failing the scenario.
        await sleep(3_000);
        const w = await webState(ctx.page);
        const toast = await ctx.page
            .locator('[role="status"], [role="alert"], [aria-live]')
            .allInnerTexts()
            .catch(() => [] as string[]);
        appendNdjson('drift.ndjson', {
            kind: 'observed',
            scenario: ctx.name,
            label: 'web after session_ended',
            video: w,
            url: ctx.page.url(),
            toast,
        });
        test.info().annotations.push({
            type: 'session-ended',
            description: `video paused=${w?.paused} url=${ctx.page.url()} toast=${JSON.stringify(toast)}`,
        });
        console.log(`[tv-host-ends] web video paused=${w?.paused}, toast=${JSON.stringify(toast)}`);
    });

    scenario('web-hosts-tv-joins', async (ctx) => {
        // Browser creates the session under its own clientId and adopts it (as the two-tab spec).
        const clientId = `client_e2e_web_host_${Date.now()}`;
        const res = await ctx.context.request.post('/api/watch-together/parties', {
            data: {
                itemId: ITEM_ID,
                mediaType: 'movie',
                title: ITEM_TITLE,
                clientId,
                currentTime: 0,
            },
        });
        expect(
            res.ok(),
            `create session failed: ${res.status()} ${await res.text().catch(() => '')}`,
        ).toBe(true);
        const {
            code,
            host: { userId: hostUserId },
        } = ((await res.json()) as { party: { code: string; host: { userId: string } } }).party;
        ctx.code = code;
        ctx.webIsHost = true;

        await seedClientId(ctx.page, clientId, { code, userId: hostUserId });
        await ctx.page.goto(`/watch/${ITEM_ID}`);
        await waitForVideoReady(ctx.page);
        await focusPlayer(ctx.page);

        await tv.send('launch', {});
        await tv.send('joinParty', { code });
        await tv.waitProbe(
            (p) => !!p.inSession && p.role === 'guest',
            60_000,
            'TV joined as guest',
        );
        ctx.poller.start(code, ctx.name);
        await ctx.page.waitForTimeout(3_000);

        await webToggle(ctx); // host play
        await waitPlayState(ctx, true, 'browser (host) play -> TV plays');
        await ctx.page.waitForTimeout(3_000);
        await measureDrift(ctx, 'after browser play');

        await tv.press('playPause'); // guest pause: anyone can pause
        await waitPlayState(ctx, false, 'TV (guest) pause -> browser pauses');
        await measureDrift(ctx, 'after TV pause');

        await webToggle(ctx); // resume, then host seek while playing
        await waitPlayState(ctx, true, 'browser resumes');
        await ctx.page.waitForTimeout(2_000);
        await ctx.page.keyboard.press('ArrowRight');
        await converge(ctx, 'TV follows browser (host) seek', 25_000);
        await measureDrift(ctx, 'after browser seek', 25_000);

        // Host ends the session via API: TV must leave the session.
        const del = await ctx.context.request.delete(`/api/watch-together/${code}`, {
            // SvelteKit's CSRF guard rejects a cross-site DELETE without an Origin.
            headers: { Origin: WEB_URL },
        });
        expect(del.ok(), `DELETE session failed: ${del.status()}`).toBe(true);
        await tv.waitProbe((p) => !p.inSession, 10_000, 'TV out of session after host ended it');
    });

    scenario('tv-hosts-episodes', async (ctx) => {
        await setupTvHosted(ctx, EP2, 'episode');

        await tv.press('playPause');
        await waitPlayState(ctx, true, 'TV play -> browser plays');
        await measureDrift(ctx, 'after TV play');

        // Intro is 5-15 s: a guest has no skip control (only the host may move the party).
        await waitTvPosition('inside intro', 6, 13);
        const guestSkip = await ctx.page.locator('button.skip-button').count();
        appendNdjson('drift.ndjson', {
            kind: 'observed',
            scenario: ctx.name,
            label: 'browser guest skip buttons during intro',
            count: guestSkip,
        });
        expect(guestSkip, 'browser guest must not show a skip button').toBe(0);

        await tv.send('pressOverlay', { id: 'player.skip', timeout: '20' });
        await waitTvAtLeast('TV skipped intro', 14.5);
        await converge(ctx, 'browser follows TV intro skip', 25_000);
        await measureDrift(ctx, 'after TV skip intro', 25_000);

        // The next-episode card appears near the end (~40-45 s); host selects it.
        await tv.send('pressOverlay', { id: 'player.nextEpisode', timeout: '60' });
        await expectBothOnItem(ctx, EP3, 'after TV next episode');

        // After a next-episode move the party waits at the start of the new episode for
        // someone to press Play (the server parks it paused at 0; neither client
        // auto-plays in a party). What must never happen is one side playing alone — the
        // TV host used to start E3 by itself while the browser sat at 0.
        const tHold = Date.now();
        while (Date.now() - tHold < 6_000) {
            const s = await sampleDrift(ctx);
            expect(
                s && (s.webPlaying || s.tvPlaying),
                `one side started the next episode alone: ${JSON.stringify(s)} url=${ctx.page.url()}`,
            ).toBeFalsy();
            await sleep(500);
        }
        await tv.press('playPause');
        await waitPlayState(ctx, true, 'TV host play on next episode -> browser plays', 30_000);
        await measureDrift(ctx, 'after next episode play', 30_000);
    });

    scenario('web-hosts-episodes', async (ctx) => {
        const clientId = `client_e2e_web_host_${Date.now()}`;
        const res = await ctx.context.request.post('/api/watch-together/parties', {
            data: {
                itemId: WEB_EP2,
                mediaType: 'episode',
                title: 'Pattern Part 2',
                clientId,
                currentTime: 0,
            },
        });
        expect(
            res.ok(),
            `create session failed: ${res.status()} ${await res.text().catch(() => '')}`,
        ).toBe(true);
        const {
            code,
            host: { userId: hostUserId },
        } = ((await res.json()) as { party: { code: string; host: { userId: string } } }).party;
        ctx.code = code;
        ctx.webIsHost = true;

        await seedClientId(ctx.page, clientId, { code, userId: hostUserId });
        await ctx.page.goto(`/watch/${WEB_EP2}`);
        await waitForVideoReady(ctx.page);
        await focusPlayer(ctx.page);

        await tv.send('launch', {});
        await tv.send('joinParty', { code });
        await tv.waitProbe(
            (p) => !!p.inSession && p.role === 'guest',
            60_000,
            'TV joined as guest',
        );
        ctx.poller.start(code, ctx.name);
        await ctx.page.waitForTimeout(3_000);

        await webToggle(ctx); // host play
        await waitPlayState(ctx, true, 'browser (host) play -> TV plays');
        await measureDrift(ctx, 'after browser play');

        // Intro 5-15 s: the TV guest must not offer a skip; the web host does.
        await waitTvPosition('inside intro', 6, 11);
        await expectTvOverlayAbsent('player.skip', 4);
        const skip = ctx.page.locator('button.skip-button').first();
        await skip.waitFor({ state: 'visible', timeout: 15_000 });
        await skip.click();
        await waitTvAtLeast('TV follows browser intro skip', 14.5, 25_000);
        await converge(ctx, 'TV follows browser intro skip', 25_000);
        await measureDrift(ctx, 'after browser skip intro', 25_000);

        // Outro: host moves the party to the next episode.
        const next = ctx.page.locator('.next-episode-container .next-episode-button').first();
        await next.waitFor({ state: 'visible', timeout: 50_000 });
        await next.click();
        await expectBothOnItem(ctx, WEB_EP3, 'after browser next episode');

        // Observation only: the web host does not auto-play after navigating in a party.
        let autoPlayed = false;
        const tAuto = Date.now();
        while (Date.now() - tAuto < 10_000 && !autoPlayed) {
            const s = await sampleDrift(ctx);
            autoPlayed = !!s && s.webPlaying && s.tvPlaying;
            if (!autoPlayed) await sleep(500);
        }
        appendNdjson('drift.ndjson', {
            kind: 'observed',
            scenario: ctx.name,
            label: 'party auto-plays after web host next episode',
            autoPlayed,
        });
        console.log(`[web-hosts-episodes] auto-play after navigate: ${autoPlayed}`);

        // Pressing play only if still paused: toggling an already-playing party would pause it.
        if (!autoPlayed) {
            await focusPlayer(ctx.page);
            await webToggle(ctx);
        }
        await waitPlayState(ctx, true, 'browser play on next episode -> TV plays', 30_000);
        await measureDrift(ctx, 'after next episode play', 30_000);
    });

    // Last test (not afterAll): a worker restart after a failure would re-run afterAll
    // and quit the TV mid-run. This also writes the summary from the ndjson files.
    test('zz-finalize', async () => {
        await tv.send('quit', {}, 30_000).catch((e) => console.log(`[finalize] quit: ${e}`));

        const results = readNdjson('results.ndjson');
        const drift = readNdjson('drift.ndjson');
        const summary: Record<string, unknown> = {};
        for (const r of results) {
            const rows = drift.filter((d) => d.scenario === r.scenario);
            const measured = rows.filter((d) => d.kind === 'drift');
            summary[r.scenario] = {
                status: r.status,
                error: r.error ?? null,
                durationMs: r.ms,
                drift: {
                    measurements: measured.length,
                    worstMedian: measured.length
                        ? Math.max(...measured.map((d) => d.median))
                        : null,
                    worstMax: measured.length ? Math.max(...measured.map((d) => d.max)) : null,
                },
                timeToConvergeMs: rows
                    .filter((d) => d.kind === 'converge')
                    .map((d) => ({ label: d.label, ms: d.ms })),
                observations: rows.filter((d) =>
                    ['observed', 'seek-jump', 'guest-seek'].includes(d.kind),
                ),
            };
        }
        writeFileSync(
            join(DIR, 'summary.json'),
            JSON.stringify({ runId: RUN_ID, driftMax: DRIFT_MAX, scenarios: summary }, null, 2),
        );
    });
});
