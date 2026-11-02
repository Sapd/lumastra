// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together — web-only e2e: two browser contexts, two users, one party.
 *
 * Run with playwright.watch-together.config.ts (NOT collected by the normal run).
 * Every scenario runs twice: user A (test2) hosting and user B (uitest) hosting.
 * `@pr` marks the per-PR subset (scenarios 1–3); the nightly job runs everything.
 *
 * Drift is the spread of the players' currentTime read at the same instant
 * (Promise.all of page.evaluate), median of 5 samples 300 ms apart, taken only after
 * an expect.poll convergence. Threshold WT_DRIFT_MAX (default 1.0 s). Below 3 s the
 * web drift compensator corrects by playback rate (±5 %), so convergence after a
 * disturbance can take ~20 s: converge timeouts are 20–25 s.
 */

import { expect, test, type CDPSession } from '@playwright/test';
import { webUrl } from './wt-env';
import {
    CdpBrowser,
    CLIENT_ID_KEY,
    DRIFT_MAX,
    identityHeaders,
    Party,
    readNdjson,
    scenario,
    SEEK_STEP_S,
    serverLog,
    sleep,
    type Participant,
    type Scn,
} from './wt-harness';
import { INTRO, OUTRO } from './wt-seed';

const PR = ['@pr'];
/** Needs Chromium itself (DevTools lifecycle/visibility control): not in cross-engine projects. */
const CHROMIUM_ONLY = '@chromium-only';
/** Web drift compensator's hard-seek threshold (SYNC_HARD_SEEK_THRESHOLD). */
const HARD_SEEK_THRESHOLD_S = 3;

// ---------------------------------------------------------------------------
// 1. Guest pause / play, both directions, and the position a guest pause leaves
// ---------------------------------------------------------------------------

scenario('guest pause and play', { tag: PR }, async ({ rec, movieParty }) => {
    const { party, host, guest } = await movieParty();
    const both = [host, guest];
    await rec.waitPlayState(both, false, 'fresh party paused');
    await rec.measureDrift(both, 'fresh party');

    await host.play();
    await rec.waitPlayState(both, true, 'host play -> guest plays');
    await sleep(4_000);
    await rec.measureDrift(both, 'after host play');

    // Guest pause: the guest sends ITS position; the server takes it when it is within
    // [-1, +10] s of the last host heartbeat, so nobody seeks back on a guest's pause.
    await guest.pause();
    await rec.waitPlayState(both, false, 'guest pause -> host pauses');
    const guestAt = (await guest.position())!;
    await rec.measureDrift(both, 'after guest pause');
    const hostAt = (await host.position())!;
    const server = (await party.session()).session;
    rec.log('observed', {
        label: 'positions after guest pause',
        guestAt,
        hostAt,
        server: server?.currentTime,
    });
    expect(server?.isPlaying, 'server still playing after guest pause').toBe(false);
    expect(
        Math.abs((server?.currentTime ?? -99) - guestAt),
        `server position ${server?.currentTime} is not the guest's pause position ${guestAt}`,
    ).toBeLessThan(1.5);
    expect(hostAt, 'host jumped back on a guest pause').toBeGreaterThan(guestAt - 1.5);

    await guest.play();
    await rec.waitPlayState(both, true, 'guest play -> host plays');
    await sleep(4_000);
    await rec.measureDrift(both, 'after guest play');

    await host.pause();
    await rec.waitPlayState(both, false, 'host pause -> guest pauses');
    await rec.measureDrift(both, 'after host pause');
});

// ---------------------------------------------------------------------------
// 2. Host presses Play right after a guest joined (heartbeat-vs-Play race, 730bbb1eb9)
// ---------------------------------------------------------------------------

scenario('host play right after join', { tag: PR }, async (s) => {
    const { rec } = s;
    const m = await s.movie();
    const host = await s.participant(s.hostUser, 'host');
    const guest = await s.participant(s.guestUser, 'guest');
    const party = s.track(
        await Party.create(host, { id: m.id, title: m.title, mediaType: 'movie' }, s.title),
    );
    // No settle time: Play lands while the join buffer check and the first host
    // heartbeats are still in flight.
    await party.join(guest, { ready: false });
    const tPlay = Date.now();
    await host.play();
    const both = [host, guest];
    await guest.waitForVideoReady();
    await rec.waitPlayState(both, true, 'host play right after join -> both play', 25_000);
    // The join's own barrier (it starts ~1 s after the join and resumes within the 5 s
    // timeout + 1.5 s lead) may legitimately pause everyone once; whether the Play lands
    // before or after it depends on how fast the guest's page joined (Firefox: before).
    // Let it settle, then nobody may pause again: a heartbeat sampled before the Play
    // must not write isPlaying=false back, and the guest must not trail.
    await sleep(Math.max(0, tPlay + 8_000 - Date.now()));
    await rec.waitPlayState(both, true, 'both playing once the join barrier settled', 25_000);
    const tSettled = Date.now();
    await rec.holdPlayState(both, true, 8_000, 'no pause after the race window');
    await rec.measureDrift(both, 'after play right after join');
    const flips = readNdjson('server-events.ndjson').filter(
        (r) => r.test === s.title && r.ts > tSettled && r.isPlaying === false,
    );
    expect(
        flips.length,
        `server reported isPlaying=false after the Play: ${JSON.stringify(flips[0])}`,
    ).toBe(0);
});

// ---------------------------------------------------------------------------
// 3. Host seeks are followed; a guest seek is blocked (UI and server)
// ---------------------------------------------------------------------------

scenario('host seek followed, guest seek blocked', { tag: PR }, async ({ rec, movieParty }) => {
    const { party, host, guest } = await movieParty();
    const both = [host, guest];
    await host.play();
    await rec.waitPlayState(both, true, 'playing before seeks');
    await sleep(3_000);
    await rec.measureDrift(both, 'before seeks');

    const jumpOf = async (p: Participant, act: () => Promise<void>): Promise<number> => {
        const before = (await p.position())!;
        const t0 = Date.now();
        await act();
        await sleep(2_500);
        return (await p.position())! - before - (Date.now() - t0) / 1000;
    };

    const fwd = await jumpOf(host, () => host.seek('forward'));
    rec.log('observed', { label: 'host forward seek jump', jump: fwd });
    expect(fwd, 'host forward seek did not move the host').toBeGreaterThan(SEEK_STEP_S / 2);
    await rec.waitPlayState(both, true, 'playing after host forward seek', 25_000);
    await rec.measureDrift(both, 'after host forward seek');

    const back = await jumpOf(host, () => host.seek('back'));
    rec.log('observed', { label: 'host back seek jump', jump: back });
    expect(back, 'host back seek did not move the host').toBeLessThan(-SEEK_STEP_S / 2);
    await rec.measureDrift(both, 'after host back seek');

    // Two quick presses: the second lands while the first seek's barrier has paused
    // the host's own player. It used to be broadcast as isPlaying:false and the
    // whole party stopped (fixed in the store's seekResumeIntent).
    await host.seek('forward');
    await host.seek('forward');
    await rec.waitPlayState(both, true, 'still playing after two quick host seeks', 25_000);
    await rec.holdPlayState(both, true, 3_000, 'party keeps playing after two quick seeks');
    await rec.measureDrift(both, 'after two quick host seeks');
    expect((await party.session()).session?.isPlaying, 'server paused the party').toBe(true);

    // Guest: keyboard seek is ignored, the progress bar is disabled, and a raw seek
    // request is refused by the server.
    const gJump = await jumpOf(guest, () => guest.seek('forward'));
    rec.log('observed', { label: 'guest keyboard seek jump', jump: gJump });
    expect(Math.abs(gJump), 'guest keyboard seek moved the guest').toBeLessThan(SEEK_STEP_S / 2);
    await guest.page.mouse.move(400, 300);
    await expect(guest.page.locator('.progress-bar[role="slider"]').first()).toHaveAttribute(
        'aria-disabled',
        'true',
    );
    const res = await guest.context.request.post(
        `${webUrl()}/api/watch-together/${party.code}/seek`,
        {
            data: { clientId: await guest.clientId(), currentTime: 200, isPlaying: true },
            headers: { Origin: webUrl() },
        },
    );
    rec.log('observed', { label: 'guest raw seek status', status: res.status() });
    expect(res.status(), 'server accepted a guest seek').toBe(403);
    await rec.measureDrift(both, 'after blocked guest seeks');
    expect((await host.position())!, 'party moved to the guest seek target').toBeLessThan(150);
});

// Reliability: dropped commands exercise the real player recovery path.
scenario('seek request failure recovers playback', { tag: PR }, async ({ rec, movieParty }) => {
    const { party, host, guest } = await movieParty();
    await host.play();
    await rec.waitPlayState([host, guest], true, 'playing before failed seek');
    await sleep(8000);
    await rec.waitPlayState([host, guest], true, 'initial join barrier settled');
    let intercepted = 0;
    const endpoint = `**/api/watch-together/${party.code}/seek`;
    await host.page.route(
        endpoint,
        (route) => {
            intercepted++;
            return route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'Temporary failure' }),
            });
        },
        { times: 1 },
    );
    await host.seek('forward');
    await expect.poll(() => intercepted).toBe(1);
    await rec.waitPlayState([host, guest], true, 'failed seek recovers without Play', 25000);
    await rec.holdPlayState([host, guest], true, 3000, 'keeps playing after failed seek');
    await rec.measureDrift([host, guest], 'in sync after failed seek');
});

scenario('missing initial seek barrier recovers playback', {}, async ({ rec, movieParty }) => {
    const { party, host, guest } = await movieParty();
    await host.play();
    await rec.waitPlayState([host, guest], true, 'playing before lost barrier');
    await sleep(8000);
    await rec.waitPlayState([host, guest], true, 'initial join barrier settled');
    let intercepted = 0;
    // A successful response with no corresponding server command models the
    // missing initial SSE event; the host must recover its local generation.
    await host.page.route(
        `**/api/watch-together/${party.code}/seek`,
        (route) => {
            intercepted++;
            return route.fulfill({ status: 204 });
        },
        { times: 1 },
    );
    const started = Date.now();
    await host.seek('forward');
    await expect.poll(() => intercepted).toBe(1);
    await rec.waitPlayState([host], false, 'host pauses for missing barrier');
    await rec.waitPlayState([host, guest], true, 'lost initial event recovers without Play', 30000);
    expect(
        Date.now() - started,
        'recovery must come from the missing-event watchdog',
    ).toBeGreaterThanOrEqual(14000);
    await rec.holdPlayState([host, guest], true, 3000, 'keeps playing after lost barrier');
    await rec.measureDrift([host, guest], 'in sync after lost barrier');
});

scenario(
    'closed guest is removed automatically',
    { timeout: 4 * 60000 },
    async ({ rec, movieParty }) => {
        const { party, host, guest } = await movieParty();
        const clientId = await guest.clientId();
        await host.play();
        await rec.waitPlayState([host, guest], true, 'playing before browser close');
        await guest.page.close();
        await expect
            .poll(
                async () =>
                    (await party.session()).session?.participants?.some(
                        (p) => p.clientId === clientId,
                    ),
                {
                    timeout: 190000,
                    intervals: [1000],
                    message: 'closed guest membership never expired',
                },
            )
            .toBe(false);
        expect((await party.session()).session?.hostClientId).toBe(await host.clientId());
        await host.seek('forward');
        await rec.waitPlayState(
            [host],
            true,
            'host resumes after departed guest barrier cleanup',
            25000,
        );
    },
);

// ---------------------------------------------------------------------------
// 3b. Host pauses / plays from the lock screen or headset (Media Session)
// ---------------------------------------------------------------------------

scenario('host lock-screen pause and play', {}, async ({ rec, movieParty }) => {
    const { party, host, guest } = await movieParty();
    test.skip(!(await host.hasMediaSession()), 'host engine has no Media Session API');
    const both = [host, guest];
    await host.play();
    await rec.waitPlayState(both, true, 'playing before the media key');
    await sleep(3_000);

    // These used to act on the host's element only: the guests played on.
    await host.mediaKey('pause');
    await rec.waitPlayState(both, false, 'lock-screen pause -> guest pauses');
    await rec.measureDrift(both, 'after lock-screen pause');
    expect((await party.session()).session?.isPlaying, 'server still playing').toBe(false);

    await host.mediaKey('play');
    await rec.waitPlayState(both, true, 'lock-screen play -> guest plays');
    await sleep(3_000);
    await rec.measureDrift(both, 'after lock-screen play');
});

// ---------------------------------------------------------------------------
// 4. Guest leaves mid-playback and rejoins
// ---------------------------------------------------------------------------

scenario('leave and rejoin mid-playback', {}, async ({ rec, movieParty }) => {
    const { party, host, guest } = await movieParty();
    const both = [host, guest];
    await host.play();
    await rec.waitPlayState(both, true, 'playing before leave');
    await sleep(3_000);

    await guest.leave();
    await expect
        .poll(() => guest.storedParty(), {
            message: 'guest storage kept the party',
            timeout: 10_000,
        })
        .toBeNull();
    await expect
        .poll(async () => (await party.session()).session?.participants?.length ?? -1, {
            message: 'server still lists the guest after leave',
            timeout: 10_000,
        })
        .toBe(1);
    await rec.holdPlayState([host], true, 5_000, 'host keeps playing while the guest is away');

    await party.join(guest);
    await rec.waitPlayState(both, true, 'both playing after rejoin', 25_000);
    await rec.measureDrift(both, 'after rejoin');
});

// ---------------------------------------------------------------------------
// 5. Host ends the party: the guest's stored party is cleared
// ---------------------------------------------------------------------------

scenario('host ends the party', {}, async ({ rec, movieParty }) => {
    const { party, host, guest } = await movieParty();
    await host.play();
    await rec.waitPlayState([host, guest], true, 'playing before the host ends it');
    expect(await guest.storedParty(), 'guest has no stored party').not.toBeNull();

    await host.disband();
    party.ended = true;
    await expect
        .poll(() => guest.storedParty(), {
            message: 'guest kept its stored party after the host ended it',
            timeout: 10_000,
            intervals: [250, 500],
        })
        .toBeNull();
    await expect(guest.page.locator('.toast-disband').first()).toBeVisible({ timeout: 10_000 });
    // No public display name is set for these users; login names stay private.
    await expect(guest.page.locator('.toast-disband .toast-displayName').first()).toHaveText(
        'Someone',
    );
    // The guest hears session_ended before the host's own disband request returns
    // and clears its storage, so this is a poll too.
    await expect
        .poll(() => host.storedParty(), { message: 'host kept its stored party', timeout: 10_000 })
        .toBeNull();
    await expect
        .poll(async () => (await party.session(guest.user)).status, { timeout: 10_000 })
        .toBe(404);
});

// ---------------------------------------------------------------------------
// 6. Network blip (context.setOffline) on the guest, then on the host
// ---------------------------------------------------------------------------

scenario('network blip', {}, async ({ rec, movieParty }) => {
    const { host, guest } = await movieParty();
    const both = [host, guest];
    await host.play();
    await rec.waitPlayState(both, true, 'playing before blips');
    await sleep(3_000);

    for (const who of [guest, host]) {
        const before = (await who.sse())!;
        await who.goOffline();
        await sleep(6_000);
        await who.goOnline();
        const after = (await who.sse())!;
        rec.log('observed', { label: `${who.label} blip sse`, before, after });
        // No permanent pause: the party comes back playing, in sync.
        await rec.waitPlayState(both, true, `playing after ${who.label} blip`, 25_000);
        await rec.measureDrift(both, `after ${who.label} blip`);
    }
});

// ---------------------------------------------------------------------------
// 7. Real hidden tab (and a frozen one) — see CdpBrowser for why this needs its own
//    Chromium: Playwright's focus emulation keeps its pages visible.
// ---------------------------------------------------------------------------

async function hiddenTabScenario(
    s: Scn,
    hide: 'guest' | 'host',
    mode: 'hidden' | 'hidden+frozen' | 'hidden+ua-paused',
): Promise<void> {
    const { rec } = s;
    const cdp = await CdpBrowser.launch();
    s.onCleanup(() => cdp.close());
    const m = await s.movie();
    const host =
        hide === 'host'
            ? await s.participant(s.hostUser, 'host', { context: cdp.context })
            : await s.participant(s.hostUser, 'host');
    const guest =
        hide === 'guest'
            ? await s.participant(s.guestUser, 'guest', { context: cdp.context })
            : await s.participant(s.guestUser, 'guest');
    const party = s.track(
        await Party.create(host, { id: m.id, title: m.title, mediaType: 'movie' }, s.title),
    );
    await party.join(guest);
    const both = [host, guest];
    const hidden = hide === 'host' ? host : guest;
    const visible = hide === 'host' ? guest : host;

    await host.play();
    await rec.waitPlayState(both, true, 'playing before hiding');
    await sleep(3_000);
    await rec.measureDrift(both, 'before hiding');

    const restore = await cdp.hideOthers();
    await expect
        .poll(() => hidden.page.evaluate(() => document.visibilityState), {
            message: 'the tab did not become hidden',
            timeout: 5_000,
        })
        .toBe('hidden');
    let session: CDPSession | null = null;
    if (mode === 'hidden+frozen') {
        session = await hidden.context.newCDPSession(hidden.page);
        await session.send('Page.setWebLifecycleState', { state: 'frozen' });
    }
    if (mode === 'hidden+ua-paused') {
        // What Safari/iOS does to a backgrounded tab: the BROWSER pauses its video and
        // fires no Page Lifecycle event (WebKit and Gecko never shipped freeze/resume).
        // The player gets a plain `pause` — no user toggle, so no party sync.
        await hidden.page.evaluate(() => document.querySelector('video')?.pause());
    }
    // The visible member is not held hostage by a hidden one.
    await rec.holdPlayState(
        [visible],
        true,
        15_000,
        `${visible.label} plays on while ${hide} is ${mode}`,
    );
    if (session) {
        await session.send('Page.setWebLifecycleState', { state: 'active' });
        await session.detach().catch(() => {});
    }
    // The member that stayed visible played on; the party must catch up with it,
    // never be pulled back (a frozen host once rewound everyone by the freeze).
    const visibleAt = (await visible.position())!;
    await restore();
    await expect.poll(() => hidden.page.evaluate(() => document.visibilityState)).toBe('visible');
    await rec.waitPlayState(both, true, `both playing after ${mode}`, 25_000);
    await rec.measureDrift(both, `after ${hide} ${mode}`);
    const visibleAfter = (await visible.position())!;
    rec.log('observed', {
        label: `${visible.label} position across ${mode}`,
        visibleAt,
        visibleAfter,
    });
    expect(
        visibleAfter,
        `${visible.label} was pulled back from ${visibleAt.toFixed(1)} s to ${visibleAfter.toFixed(1)} s`,
    ).toBeGreaterThan(visibleAt - 1);
}

scenario('hidden guest tab', { tag: [CHROMIUM_ONLY] }, (s) =>
    hiddenTabScenario(s, 'guest', 'hidden'),
);
scenario('hidden host tab', { tag: [CHROMIUM_ONLY] }, (s) =>
    hiddenTabScenario(s, 'host', 'hidden'),
);

/**
 * A FROZEN background tab (Page.setWebLifecycleState frozen while hidden: timers and
 * media stop, as mobile browsers and Chrome's memory/energy saver do). Both found
 * real bugs on 2026-10-01, fixed the same day:
 *  - frozen HOST: it came back paused where it froze, its heartbeat flipped the
 *    session to paused, the guest played on — a split party that never healed. The
 *    host now catches up with the party on `resume` (freezeCatchUpTarget).
 *  - frozen GUEST: on reconnect the replay delivered seconds-old host_position
 *    events, anchored as "now" — the guest hard-seeked back. Now aged by send time.
 */
scenario('frozen guest tab', { tag: [CHROMIUM_ONLY] }, (s) =>
    hiddenTabScenario(s, 'guest', 'hidden+frozen'),
);
scenario('frozen host tab', { tag: [...PR, CHROMIUM_ONLY] }, (s) =>
    hiddenTabScenario(s, 'host', 'hidden+frozen'),
);
/**
 * Safari / Firefox: a host whose browser pauses its media in the background without any
 * freeze/resume event. Same split as the frozen host, detected from "playing when
 * hidden, paused on return, no explicit pause sent".
 */
scenario('browser-paused host tab (Safari-like)', { tag: [CHROMIUM_ONLY] }, (s) =>
    hiddenTabScenario(s, 'host', 'hidden+ua-paused'),
);

// ---------------------------------------------------------------------------
// 8. Episodes: Skip Intro, Next Episode, and the guest's end-of-episode card
// ---------------------------------------------------------------------------

async function setAutoplayNext(s: Scn, user: string, enabled: boolean): Promise<void> {
    const ctx = await s.browser.newContext({
        baseURL: webUrl(),
        extraHTTPHeaders: identityHeaders(user),
    });
    try {
        const res = await ctx.request.patch('/api/me/playback-preferences', {
            data: { autoplayNextEpisode: enabled },
            headers: { Origin: webUrl() },
        });
        expect(res.ok(), `PATCH playback-preferences failed: ${res.status()}`).toBe(true);
    } finally {
        await ctx.close();
    }
}

scenario('episodes: skip intro, next episode, guest waits', { timeout: 5 * 60_000 }, async (s) => {
    const { rec } = s;
    // Decision: auto-advance (default ON) is pinned OFF for both users. The test then
    // owns every move between episodes — the host's Next Episode click — and the
    // guest's end-of-episode card is deterministic instead of racing the host's
    // countdown. Auto-advance itself is a single-player feature with its own tests.
    for (const u of [s.hostUser, s.guestUser]) await setAutoplayNext(s, u, false);

    const show = await s.show();
    const [, ep2, ep3] = show.episodes;
    const host = await s.participant(s.hostUser, 'host');
    const guest = await s.participant(s.guestUser, 'guest');
    const party = s.track(
        await Party.create(host, { id: ep2.id, title: ep2.title, mediaType: 'episode' }, s.title),
    );
    await party.join(guest);
    const both = [host, guest];

    await host.play();
    await rec.waitPlayState(both, true, 'host play -> guest plays');

    // Intro 5–15 s: only the host gets the skip control.
    await expect
        .poll(async () => (await host.position()) ?? -1, { timeout: 20_000 })
        .toBeGreaterThan(INTRO.start + 1);
    expect(
        await guest.page.locator('button.skip-button').count(),
        'guest shows a skip button',
    ).toBe(0);
    await host.page.mouse.move(400, 300);
    const skip = host.page.locator('button.skip-button').first();
    await skip.waitFor({ state: 'visible', timeout: 10_000 });
    await skip.click();
    await expect
        .poll(async () => (await guest.position()) ?? -1, {
            message: 'guest did not follow the intro skip',
            timeout: 20_000,
        })
        .toBeGreaterThan(INTRO.end - 0.5);
    // The skip is a party seek: each player resumes when its own barrier releases it.
    await rec.waitPlayState(both, true, 'both playing after skip intro', 20_000);
    await rec.measureDrift(both, 'after skip intro');

    // Outro (45–60 s): host moves the party on.
    expect(await guest.page.locator('.next-episode-container .next-episode-button').count()).toBe(
        0,
    );
    const next = host.page.locator('.next-episode-container .next-episode-button').first();
    await next.waitFor({ state: 'visible', timeout: 45_000 });
    expect(
        await guest.page.locator('.next-episode-container .next-episode-button').count(),
        'guest shows a next-episode button',
    ).toBe(0);
    await next.click();
    party.item = { id: ep3.id, title: ep3.title, mediaType: 'episode' };
    for (const p of both) {
        await p.page.waitForURL(`**/watch/${ep3.id}**`, { timeout: 25_000 });
        await p.waitForVideoReady();
        // Not the previous item's clock: the new stream restarts near 0.
        await expect
            .poll(async () => (await p.position()) ?? 99, { timeout: 15_000 })
            .toBeLessThan(10);
    }
    // Both wait PAUSED on the new episode; nobody starts it alone.
    await rec.holdPlayState(both, false, 6_000, 'both wait paused on the next episode');
    await host.play();
    await rec.waitPlayState(both, true, 'host play on next episode -> both play', 25_000);
    await rec.measureDrift(both, 'after next episode play');

    // Last episode: host jumps near the end; when it ends the guest shows the
    // "waiting for the host" card (there is no next episode to pick).
    for (let i = 0; i < 4; i++) await host.seek('forward');
    await expect
        .poll(async () => (await guest.position()) ?? 0, { timeout: 25_000 })
        .toBeGreaterThan(OUTRO.start);
    const waiting = guest.page.locator('.wp-waiting[role="status"]');
    await waiting.waitFor({ state: 'visible', timeout: 40_000 });
    await expect(waiting.locator('.wp-waiting-title')).toHaveText('Waiting for the host');
    rec.log('observed', { label: 'guest end card', text: await waiting.innerText() });
    expect(
        await host.page.locator('.wp-waiting').count(),
        'host shows the guest waiting card',
    ).toBe(0);
});

// ---------------------------------------------------------------------------
// 9. Two tabs of the same user plus a second user (Web Lock clientId uniqueness)
// ---------------------------------------------------------------------------

scenario('two tabs of one user plus a second user', {}, async (s) => {
    const { rec } = s;
    const { party, host, guest } = await s.movieParty();
    // Second tab of the HOST's user, in the same context (shared localStorage), with
    // the first tab's sessionStorage copied over — what "Duplicate tab" does. Its
    // clientId must be re-minted (the Web Lock is held by the first tab), otherwise the
    // server would take it for the host itself.
    const tab2 = await s.participant(s.hostUser, 'host-tab2', { context: host.context });
    await tab2.page.addInitScript(
        ({ k, v }) => {
            if (!sessionStorage.getItem(k)) sessionStorage.setItem(k, v);
        },
        { k: CLIENT_ID_KEY, v: party.hostClientId },
    );
    await party.join(tab2);
    const all = [host, guest, tab2];

    const ids = await Promise.all(all.map((p) => p.clientId()));
    rec.log('observed', { label: 'client ids', ids });
    expect(new Set(ids).size, `client ids not unique: ${JSON.stringify(ids)}`).toBe(3);
    expect(ids[0]).toBe(party.hostClientId);
    await expect
        .poll(
            async () =>
                (await party.session()).session?.participants
                    ?.map((p) => p.clientId)
                    .sort()
                    .join(','),
            {
                timeout: 10_000,
            },
        )
        .toBe([...ids].sort().join(','));
    expect((await party.session()).session?.hostClientId).toBe(party.hostClientId);

    await host.play();
    await rec.waitPlayState(all, true, 'host play -> all three play');
    await sleep(3_000);
    await rec.measureDrift(all, 'three players after host play');

    await tab2.pause();
    await rec.waitPlayState(all, false, 'second tab pause -> all pause');
    await rec.measureDrift(all, 'three players after second-tab pause');

    // Closing the second tab leaves the party (and its host) intact.
    await tab2.page.close();
    await guest.play();
    await rec.waitPlayState([host, guest], true, 'guest play after the second tab closed');
    await rec.measureDrift([host, guest], 'after second tab closed');
    expect((await party.session()).session?.hostClientId).toBe(party.hostClientId);
});

// ---------------------------------------------------------------------------
// 11. SSE outage > 10 s, and an outage the 50-event replay ring cannot cover
// ---------------------------------------------------------------------------

scenario(
    'stream outage beyond the replay ring',
    { timeout: 6 * 60_000 },
    async ({ rec, movieParty }) => {
        const { party, host, guest } = await movieParty();
        const both = [host, guest];
        await host.play();
        await rec.waitPlayState(both, true, 'playing before outage');
        await sleep(3_000);

        // (a) 15 s offline, party keeps playing: the guest reconnects (Last-Event-ID) and
        // re-syncs without anyone pressing anything.
        const sse0 = (await guest.sse())!;
        await guest.goOffline();
        await sleep(15_000);
        await guest.goOnline();
        // Reconnects back off (1, 2, 4, 8 s …), so the first successful reopen can come
        // well after the network does.
        await expect
            .poll(async () => (await guest.sse())?.opens ?? 0, {
                message: 'the guest stream never reconnected',
                timeout: 40_000,
                intervals: [500, 1_000],
            })
            .toBeGreaterThan(sse0.opens);
        rec.log('observed', {
            label: 'sse across 15 s outage',
            before: sse0,
            after: await guest.sse(),
        });
        await rec.waitPlayState(both, true, 'playing after a 15 s outage', 30_000);
        // The one step held to the product's guarantee rather than 1 s: a guest whose
        // player stalled while offline (its buffer ran dry) comes back up to ~3 s off.
        // Below SYNC_HARD_SEEK_THRESHOLD (3 s) the compensator corrects by playback
        // rate over minutes, and a reconnect does not force a resync — measured 2.67 s
        // still open after 25 s (reported, 2026-10-01). The drift row records the value.
        await rec.measureDrift(both, 'after 15 s outage', 25_000, HARD_SEEK_THRESHOLD_S);

        // (b) Offline while the host makes > 50 moves: the guest's cursor falls out of the
        // replay ring, so only the `connected` snapshot can bring it back. The host ends
        // PAUSED at a position the guest has never seen.
        await guest.goOffline();
        for (let i = 0; i < 28; i++) {
            await host.page.keyboard.press('k');
            await sleep(450);
        }
        await host.pause();
        await host.seek('forward');
        await host.seek('forward');
        await sleep(1_500);
        const target = (await host.position())!;
        await guest.goOnline();
        await rec.waitPlayState(
            both,
            false,
            'guest paused like the host after the long outage',
            40_000,
        );
        await rec.measureDrift(both, 'after outage beyond the ring', 40_000);
        expect(Math.abs((await guest.position())! - target)).toBeLessThan(DRIFT_MAX);
        const server = (await party.session()).session;
        expect(server?.isPlaying).toBe(false);
    },
);

// ---------------------------------------------------------------------------
// 12. Joining a PLAYING party: the join buffer check and its 5 s timeout
// ---------------------------------------------------------------------------

/**
 * On a join the server pauses the party for a buffer check and resumes when every
 * client with a live stream answers `ready`, or after 5 s ("Buffer check timeout,
 * resuming anyway"). The browser <-> Apple TV run saw the timeout on ~1 in 14 checks:
 * a guest still cold-loading /party -> /watch got the barrier from the `connected`
 * snapshot but was not buffered at the target in time. Harmless (everyone resumes
 * together), so the timeouts are RECORDED per join; what must hold is that the guest
 * ends up playing in sync each time, within the timeout plus a load.
 */
scenario('join a playing party', {}, async ({ rec, movieParty }) => {
    const { party, host, guest } = await movieParty();
    await host.play();
    await rec.waitPlayState([host, guest], true, 'playing before the rejoins');
    const joins: { ms: number; timeouts: number }[] = [];
    for (let i = 0; i < 3; i++) {
        await guest.leave();
        await expect.poll(() => guest.storedParty(), { timeout: 10_000 }).toBeNull();
        await sleep(2_000);
        const logFrom = serverLog().length;
        const t0 = Date.now();
        await party.join(guest);
        await rec.waitPlayState([host, guest], true, `join ${i + 1}: both playing`, 20_000);
        await rec.converge([host, guest], `join ${i + 1}: in sync`, 20_000);
        const ms = Date.now() - t0;
        await sleep(1_000); // let the server flush its log lines for this join
        // Only this party's lines: with WT_WORKERS > 1 other scenarios log into the
        // same server.log at the same time.
        const timeouts = serverLog()
            .slice(logFrom)
            .split('\n')
            .filter(
                (l) =>
                    l.includes('Buffer check timeout, resuming anyway') &&
                    l.toUpperCase().includes(party.code.toUpperCase()),
            ).length;
        joins.push({ ms, timeouts });
    }
    rec.log('observed', { label: 'join-to-synced', joins, code: party.code });
    await rec.measureDrift([host, guest], 'after the last rejoin');
    expect(
        Math.max(...joins.map((j) => j.ms)),
        `join-to-synced: ${JSON.stringify(joins)}`,
    ).toBeLessThan(15_000);
});
