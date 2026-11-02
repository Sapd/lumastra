// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Isolated Chromium proof of first-play audio handling. Run through
 * lumastra-remote node tests/player-startup-audio.browser.mjs.
 * Uses the production methods verbatim and a silent synthetic AAC fixture.
 * This exercises browser policy/events, not the full watch page or HLS delivery.
 * Unrelated controller services are replaced with inert collaborators.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { transform } from 'esbuild';
import { chromium } from '@playwright/test';

async function methods(file, className, names) {
    const source =
        className === 'PlayerController' && process.env.PLAYER_CONTROLLER_BLOB
            ? execFileSync('git', ['cat-file', 'blob', process.env.PLAYER_CONTROLLER_BLOB], {
                  encoding: 'utf8',
              })
            : await readFile(file, 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const cls = parsed.statements.find(
        (node) => ts.isClassDeclaration(node) && node.name?.text === className,
    );
    assert.ok(cls, className);
    return names
        .map((name) => {
            const member = cls.members.find((node) => node.name?.getText(parsed) === name);
            assert.ok(member, `${className}.${name}`);
            return member.getText(parsed);
        })
        .join('\n');
}

const root = 'src/lib/components/player/';
const controllerMethods = await methods(`${root}player-controller.svelte.ts`, 'PlayerController', [
    'onPlay',
    'bootstrapFirstPlay',
    'onVolumeChange',
    'handleVolume',
    'showMutedAutoplayPrompt',
    'handleAutoplayResult',
    'handleAutoplayUnmute',
    'togglePlayPause',
]);
const managerMethods = await methods(`${root}playback-manager.ts`, 'PlaybackManager', [
    'tryAutoPlay',
    'startMutedPlayback',
    'detectAutoplayPolicy',
]);
const startup = (await readFile(`${root}startup-mute.ts`, 'utf8')).replaceAll('export ', '');
const { code } = await transform(
    `
${startup}
const noop = () => {};
const events = [];
const playerStore = {
    isMuted: false, volume: 0.6, qualityMode: 'original', isLive: false,
    setVolume(v) { this.volume = v; }, toggleMute() { this.isMuted = !this.isMuted; },
    showControlsTemporarily: noop, startProgressReporting: noop,
    setShowControls: noop, setPausedByUser: noop,
};
const watchTogether = { isInWatchParty: false, getHasSyncedInitially: () => true };
const TIMING = { AUTOPLAY_TUTORIAL_DELAY_MS: 100000 };
const requestWakeLock = noop;
const updatePreferences = noop;
class Controller { ${controllerMethods} }
class Manager { ${managerMethods} }
const video = document.querySelector('video');
const c = new Controller();
Object.assign(c, {
    videoElement: video, isInitialized: false, isIOS: false,
    mutedByAutoplayFallback: false, log: noop, shouldSuppressErrors: () => false,
    applyPlaybackResumedReset: noop, resetEngagementTracking: noop,
    startEngagementTicker: noop, reportProgress: noop, buildQualityRestartKey: () => '',
    consumePendingAudioSwitch: noop, abrCtrl: { onPlaybackStart: noop },
    updatePlaybackIntent: noop, playbackManager: { startDeferredSource: noop },
    handlePlayError: e => events.push(e.name),
});
video.volume = playerStore.volume;
localStorage.setItem('playerVolume', JSON.stringify({ volume: 0.6, muted: false }));
video.addEventListener('play', () => c.onPlay());
video.addEventListener('volumechange', () => c.onVolumeChange());
document.querySelector('#mute').onclick = () => {
    playerStore.toggleMute(); video.muted = playerStore.isMuted;
};
document.querySelector('#play').onclick = () => c.togglePlayPause();
document.querySelector('#unmute').onclick = () => c.handleAutoplayUnmute();
const manager = new Manager();
Object.assign(manager, {
    sourceGeneration: 0, isDestroyed: false,
    config: { videoElement: video, log: noop, events: {
        onMutedFallbackStart: () => { c.mutedByAutoplayFallback = true; },
        onAutoplayResult: r => { events.push(r); c.handleAutoplayResult(r); },
    } },
    emitError: e => events.push({ error: e.error.name }),
});
window.snapshot = () => ({
    muted: video.muted, paused: video.paused, volume: video.volume,
    time: video.currentTime, readyState: video.readyState,
    initialized: c.isInitialized, storeMuted: playerStore.isMuted,
    prompt: !!c.showAutoplayMutedPrompt, events: structuredClone(events),
    saved: JSON.parse(localStorage.getItem('playerVolume')),
});
if (location.search.includes('autoplay')) manager.tryAutoPlay();
`,
    { loader: 'ts', target: 'es2022' },
);

const media = await readFile('tests/fixtures/watch-together/wt-episode-60s.mp4');
const server = createServer((req, res) => {
    if (req.url === '/fixture.mp4') {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': media.length });
        res.end(media);
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<video src="/fixture.mp4" preload="auto" playsinline></video>
            <button id="mute">Mute</button><button id="play">Play/Pause</button>
            <button id="unmute">Unmute autoplay</button><script>${code}</script>`);
    }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
    for (const blocked of [false, true]) {
        const browser = await chromium.launch({
            headless: true,
            args: [
                `--autoplay-policy=${blocked ? 'document-user-activation-required' : 'no-user-gesture-required'}`,
                '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
            ],
        });
        try {
            for (let run = 1; run <= 2; run++) {
                for (const scenario of ['paused-mute', 'autoplay']) {
                    const context = await browser.newContext();
                    const page = await context.newPage();
                    const errors = [];
                    page.on('pageerror', (error) => errors.push(error.message));
                    await page.goto(`${url}/?${scenario}`);
                    await page.reload();
                    await page.waitForFunction(
                        () => document.querySelector('video').readyState >= 3,
                    );
                    if (scenario === 'paused-mute') {
                        await page.getByRole('button', { name: 'Mute', exact: true }).click();
                        await page.getByRole('button', { name: 'Play/Pause' }).click();
                    } else {
                        await page.waitForFunction(() => window.snapshot().events.length > 0);
                    }
                    await page
                        .waitForFunction(() => window.snapshot().initialized)
                        .catch(async (error) => {
                            throw new Error(
                                JSON.stringify({
                                    blocked,
                                    run,
                                    scenario,
                                    errors,
                                    snapshot: await page.evaluate(() => window.snapshot()),
                                }),
                                { cause: error },
                            );
                        });
                    const initial = await page.evaluate(() => window.snapshot());
                    const expectedMuted = scenario === 'paused-mute' || blocked;
                    const failures = [];
                    if (initial.muted !== expectedMuted || initial.storeMuted !== expectedMuted)
                        failures.push('first-play mute overridden');
                    if (initial.volume !== 0.6) failures.push('volume changed');
                    if (initial.paused) failures.push('playback paused unexpectedly');
                    if (
                        blocked &&
                        scenario === 'autoplay' &&
                        !initial.events.some((e) => e.usedMutedFallback)
                    )
                        failures.push('browser did not take muted autoplay fallback');
                    // A real Play gesture resumes the fallback without implicitly unmuting.
                    if (scenario === 'autoplay') {
                        // Compare an ordinary deliberate mute with automatic fallback.
                        if (!blocked)
                            await page.getByRole('button', { name: 'Mute', exact: true }).click();
                        await page.getByRole('button', { name: 'Play/Pause' }).click();
                        await page.getByRole('button', { name: 'Play/Pause' }).click();
                        const resumed = await page.evaluate(() => window.snapshot());
                        if (!resumed.muted || resumed.paused)
                            failures.push('Play gesture lost muted playback');
                        if (blocked) {
                            await page.getByRole('button', { name: 'Unmute autoplay' }).click();
                            const unmuted = await page.evaluate(() => window.snapshot());
                            if (unmuted.muted || unmuted.storeMuted)
                                failures.push('explicit unmute failed');
                        }
                    }
                    const beforeProgress = await page.evaluate(() => window.snapshot().time);
                    await page
                        .waitForFunction(
                            (previous) => window.snapshot().time > previous + 0.1,
                            beforeProgress,
                            { timeout: 3000 },
                        )
                        .catch(() => failures.push('playback did not advance'));
                    results.push({ blocked, run, scenario, initial, failures, errors });
                    await context.close();
                }
            }
        } finally {
            await browser.close();
        }
    }
    console.log(JSON.stringify(results, null, 2));
    assert.equal(results.filter((r) => r.failures.length || r.errors.length).length, 0);
} finally {
    await new Promise((resolve) => server.close(resolve));
}
