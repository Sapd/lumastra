// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { IncidentReporter } from './incident-reporter.js';
import { IncidentRingBuffer } from './incident-buffer.js';

function makeReporter(overrides: Record<string, unknown> = {}) {
    const post = vi.fn().mockResolvedValue(undefined);
    const patchResolve = vi.fn().mockResolvedValue(undefined);
    const beacon = vi.fn();
    const buffer = new IncidentRingBuffer({ maxEntries: 120, maxAgeMs: 90_000 });
    const reporter = new IncidentReporter({
        attemptId: 'attempt-1',
        buffer,
        deviceId: 'device-1',
        post,
        patchResolve,
        beacon,
        ...overrides,
    } as never);
    return { reporter, post, patchResolve, beacon, buffer };
}

describe('IncidentReporter', () => {
    it('flushes on the first error', () => {
        const { reporter, post } = makeReporter();
        reporter.reportError('session-1', { errorType: 'network' });
        expect(post).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith(
            expect.objectContaining({ attemptId: 'attempt-1', triggerType: 'error' }),
        );
    });

    it('always flushes a terminal event, bypassing the non-terminal budget', () => {
        const { reporter, post } = makeReporter();
        for (let i = 0; i < 4; i++) {
            reporter.reportError('session-1', { errorType: 'network', httpStatus: 500 + i });
        }
        // Budget of 4 non-terminal flushes is now exhausted.
        reporter.reportError('session-1', { errorType: 'network', httpStatus: 599 });
        expect(post).toHaveBeenCalledTimes(4);

        reporter.reportTerminal('session-1');
        expect(post).toHaveBeenCalledTimes(5); // terminal is NOT dropped by the budget
    });

    it('coalesces an identical repeated error within the dedup window instead of counting a new flush', () => {
        let currentTime = 0;
        const { reporter, post } = makeReporter({ now: () => currentTime });
        reporter.reportError('session-1', {
            errorType: 'network',
            stage: 'manifest',
            httpStatus: 502,
        });
        currentTime = 2_000; // still inside the 15s coalescing window
        reporter.reportError('session-1', {
            errorType: 'network',
            stage: 'manifest',
            httpStatus: 502,
        });
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('sends a resolve PATCH on reportRecovered', () => {
        const { reporter, patchResolve } = makeReporter();
        reporter.reportRecovered();
        expect(patchResolve).toHaveBeenCalledWith({ attemptId: 'attempt-1' });
    });

    it('does not beacon on pagehide if nothing was ever flushed', () => {
        const { reporter, beacon } = makeReporter();
        reporter.onPageHide();
        expect(beacon).not.toHaveBeenCalled();
    });

    it('beacons on pagehide if a prior flush already happened', () => {
        const { reporter, beacon } = makeReporter();
        reporter.reportError('session-1', { errorType: 'network' });
        reporter.onPageHide();
        expect(beacon).toHaveBeenCalledTimes(1);
    });

    it('does not beacon a spurious terminal incident on pagehide after a successful recovery', () => {
        const { reporter, beacon } = makeReporter();
        reporter.reportError('session-1', { errorType: 'network' });
        reporter.reportRecovered();
        reporter.onPageHide();
        expect(beacon).not.toHaveBeenCalled();
    });

    it('beacons again on pagehide if a new error flushes after a recovery', () => {
        const { reporter, beacon } = makeReporter();
        reporter.reportError('session-1', { errorType: 'network' });
        reporter.reportRecovered();
        reporter.reportError('session-1', { errorType: 'media' });
        reporter.onPageHide();
        expect(beacon).toHaveBeenCalledTimes(1);
    });

    it('carries the recovery cause and failure stage on a terminal incident', () => {
        const { reporter, post } = makeReporter();
        reporter.reportTerminal('session-1', {
            reconnectCause: 'stall',
            stage: 'media-segment',
            message: 'retries-exhausted',
        });

        // A terminal incident is the one users actually hit ("reload the page").
        // Posting it with null cause/stage is why prod 2026-09-11 could not tell
        // a stall-driven give-up from a dead manifest after the fact.
        const body = post.mock.calls[0][0] as Record<string, unknown>;
        expect(body.triggerType).toBe('terminal');
        expect(body.reconnectCause).toBe('stall');
        expect(body.stage).toBe('media-segment');
        expect(body.message).toBe('retries-exhausted');
    });

    it('omits terminal diagnostic fields when none are known', () => {
        const { reporter, post } = makeReporter();
        reporter.reportTerminal('session-1');
        const body = post.mock.calls[0][0] as Record<string, unknown>;
        expect(body.triggerType).toBe('terminal');
        expect(body.reconnectCause).toBeUndefined();
        expect(body.stage).toBeUndefined();
    });

    it('only posts a terminal incident once, even if reportTerminal is called twice for the same attempt', () => {
        const { reporter, post } = makeReporter();
        reporter.reportTerminal('session-1');
        reporter.reportTerminal('session-1');
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('coalesces a burst of reconnect attempts for the same cause instead of burning multiple budget slots', () => {
        let currentTime = 0;
        const { reporter, post } = makeReporter({ now: () => currentTime });
        reporter.reportReconnect('session-1', 'network');
        currentTime = 1_000; // still inside the 15s coalescing window
        reporter.reportReconnect('session-1', 'network');
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('does not coalesce reconnect attempts with different causes', () => {
        const { reporter, post } = makeReporter();
        reporter.reportReconnect('session-1', 'network');
        reporter.reportReconnect('session-1', 'media');
        expect(post).toHaveBeenCalledTimes(2);
    });

    it('does not collide dedup keys across differently-shaped errors containing the delimiter character', () => {
        const { reporter, post } = makeReporter();
        reporter.reportError('session-1', { errorType: 'a|b', stage: 'c' });
        reporter.reportError('session-1', { errorType: 'a', stage: 'b|c' });
        expect(post).toHaveBeenCalledTimes(2);
    });

    it('swallows a rejected post() instead of producing an unhandled rejection', async () => {
        const post = vi.fn().mockRejectedValue(new Error('offline'));
        const { reporter } = makeReporter({ post });
        expect(() => reporter.reportError('session-1', { errorType: 'network' })).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();
    });

    it('swallows a rejected patchResolve() instead of producing an unhandled rejection', async () => {
        const patchResolve = vi.fn().mockRejectedValue(new Error('offline'));
        const { reporter } = makeReporter({ patchResolve });
        expect(() => reporter.reportRecovered()).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();
    });

    it('swallows a rejected terminal post() instead of producing an unhandled rejection', async () => {
        const post = vi.fn().mockRejectedValue(new Error('offline'));
        const { reporter } = makeReporter({ post });
        expect(() => reporter.reportTerminal('session-1')).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();
    });

    it('only beacons once on pagehide, even when both pagehide and beforeunload fire', () => {
        const { reporter, beacon } = makeReporter();
        reporter.reportError('session-1', { errorType: 'network' });
        reporter.onPageHide();
        reporter.onPageHide();
        expect(beacon).toHaveBeenCalledTimes(1);
    });
});

describe('IncidentReporter timeline wiring', () => {
    // Inside the buffer's 90s age window, or eviction drops the entries before
    // the reporter ever reads them.
    const t0 = Date.now();

    it('carries the buffer entries recorded before the flush into the posted body', () => {
        const { reporter, post, buffer } = makeReporter();
        buffer.push({ t: t0 - 3_000, kind: 'seek', detail: { fromPosition: 10, toPosition: 300 } });
        buffer.push({ t: t0 - 2_000, kind: 'quality_switch', detail: { level: 3 } });
        buffer.push({ t: t0 - 1_000, kind: 'rebuffer_event', detail: { position: 300 } });

        reporter.reportError('session-1', { errorType: 'network' });

        const body = post.mock.calls[0]?.[0] as { timeline: unknown[] };
        expect(body.timeline).toEqual([
            { t: t0 - 3_000, kind: 'seek', detail: { fromPosition: 10, toPosition: 300 } },
            { t: t0 - 2_000, kind: 'quality_switch', detail: { level: 3 } },
            { t: t0 - 1_000, kind: 'rebuffer_event', detail: { position: 300 } },
        ]);
    });

    it('carries entries pushed after an earlier flush into the next flush', () => {
        const { reporter, post, buffer } = makeReporter();
        buffer.push({ t: t0 - 2_000, kind: 'play' });
        reporter.reportError('session-1', { errorType: 'network' });

        buffer.push({
            t: t0 - 1_000,
            kind: 'reconnect_attempt',
            detail: { cause: 'stall', attempt: 1 },
        });
        reporter.reportReconnect('session-1', 'stall');

        const second = post.mock.calls[1]?.[0] as { timeline: Array<{ kind: string }> };
        expect(second.timeline.map((e) => e.kind)).toEqual(['play', 'reconnect_attempt']);
    });

    it('carries the buffer entries into the pagehide beacon body too', () => {
        const { reporter, beacon, buffer } = makeReporter();
        reporter.reportError('session-1', { errorType: 'network' });
        buffer.push({ t: t0 - 1_000, kind: 'media_stalled', detail: { bufferHealth: 0 } });
        reporter.onPageHide();

        const body = beacon.mock.calls[0]?.[0] as {
            timeline: Array<{ kind: string }>;
            playSessionId: string;
        };
        expect(body.timeline.map((e) => e.kind)).toEqual(['media_stalled']);
        // The unload path reuses the last session id a flush reported. It is
        // still '' when no flush ever carried one — playbackIncidentReportSchema
        // must keep accepting an empty string for that beacon to land.
        expect(body.playSessionId).toBe('session-1');
    });
});

describe('IncidentReporter device/client attribution', () => {
    it('sends the deviceId with every posted incident', () => {
        const { reporter, post } = makeReporter({ deviceId: 'device-xyz' });
        reporter.reportError('session-1', { errorType: 'network' });
        expect(post).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-xyz' }));
    });

    it('sends the deviceId on the terminal post and the pagehide beacon too', () => {
        const { reporter, post, beacon } = makeReporter({ deviceId: 'device-xyz' });
        reporter.reportTerminal('session-1');
        expect(post).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-xyz' }));

        reporter.onPageHide();
        expect(beacon).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-xyz' }));
    });

    it('includes the clientInfo getter result in the posted body', () => {
        const { reporter, post } = makeReporter({
            clientInfo: () => ({ userAgent: 'test-agent', playMethod: 'DirectPlay' }),
        });
        reporter.reportError('session-1', { errorType: 'network' });
        expect(post).toHaveBeenCalledWith(
            expect.objectContaining({
                clientInfo: { userAgent: 'test-agent', playMethod: 'DirectPlay' },
            }),
        );
    });

    it('evaluates clientInfo at FLUSH time, so a mid-session playMethod change is reported', () => {
        // The whole reason clientInfo is a getter rather than a captured value:
        // a direct-play attempt that falls back to transcode and THEN fails must
        // report the method it actually failed with, not the one it started on.
        let playMethod = 'DirectPlay';
        const { reporter, post } = makeReporter({
            clientInfo: () => ({ playMethod }),
        });

        reporter.reportError('session-1', { errorType: 'network' });
        playMethod = 'Transcode';
        reporter.reportError('session-1', { errorType: 'media' });

        expect(
            (post.mock.calls[0]?.[0] as { clientInfo: { playMethod: string } }).clientInfo,
        ).toEqual({ playMethod: 'DirectPlay' });
        expect(
            (post.mock.calls[1]?.[0] as { clientInfo: { playMethod: string } }).clientInfo,
        ).toEqual({ playMethod: 'Transcode' });
    });

    it('omits clientInfo when no getter was supplied', () => {
        const { reporter, post } = makeReporter();
        reporter.reportError('session-1', { errorType: 'network' });
        expect((post.mock.calls[0]?.[0] as { clientInfo?: unknown }).clientInfo).toBeUndefined();
    });

    // Prod 2026-09-26: media_id was NULL on all 262 playback_incident_events
    // rows — the web player never handed the reporter a media id.
    const MEDIA_A = '0f73a082-6bee-443d-8828-91595597e6a4';
    const MEDIA_B = 'd493972d-1738-4298-b822-e6066d25037f';

    it('sends the mediaId getter result, evaluated at flush time', () => {
        let current = MEDIA_A;
        const { reporter, post } = makeReporter({ mediaId: () => current });
        reporter.reportError('session-1', { errorType: 'network' });
        current = MEDIA_B;
        reporter.reportTerminal('session-1');
        expect((post.mock.calls[0]?.[0] as { mediaId?: string }).mediaId).toBe(MEDIA_A);
        expect((post.mock.calls[1]?.[0] as { mediaId?: string }).mediaId).toBe(MEDIA_B);
    });

    it('omits a non-UUID mediaId instead of letting it 422 the whole report', () => {
        const { reporter, post } = makeReporter({ mediaId: () => 'livetv-channel-7' });
        reporter.reportError('session-1', { errorType: 'network' });
        expect('mediaId' in (post.mock.calls[0]?.[0] as object)).toBe(false);
    });

    // Prod: 31 terminal rows with play_session_id = '' — every one the unload
    // beacon, which hard-coded an empty id even though the reporter had
    // flushed under a real session moments earlier.
    it('beacons the last reported playSessionId on pagehide, not an empty string', () => {
        const { reporter, beacon } = makeReporter();
        reporter.reportReconnect('session-1', 'stall');
        reporter.reportError('session-2', { errorType: 'network' });
        reporter.onPageHide();
        expect((beacon.mock.calls[0]?.[0] as { playSessionId: string }).playSessionId).toBe(
            'session-2',
        );
    });

    it('does not let an empty playSessionId overwrite the last known one', () => {
        const { reporter, beacon } = makeReporter();
        reporter.reportError('session-1', { errorType: 'network' });
        reporter.reportError('', { errorType: 'media' });
        reporter.onPageHide();
        expect((beacon.mock.calls[0]?.[0] as { playSessionId: string }).playSessionId).toBe(
            'session-1',
        );
    });
});

/**
 * PlayerController cannot be instantiated under vitest (Svelte 5 runes plus
 * DOM/HLS.js dependencies — the same constraint reconnect-controller.test.ts
 * documents), so the call sites that feed the ring buffer are asserted against
 * the source text. This is what catches a regression where the buffer is
 * constructed and handed to the reporter but never written to, which ships an
 * empty `timeline` on every incident.
 */
describe('player-controller incident buffer call sites', () => {
    // Resolved from the vitest root rather than `import.meta.url`: the
    // components config serves modules over a non-file URL, so a
    // module-relative URL can't be handed to readFileSync here.
    const source = readFileSync(
        resolve(process.cwd(), 'src/lib/components/player/player-controller.svelte.ts'),
        'utf8',
    );

    const kinds = [
        'seek',
        'quality_switch',
        'play',
        'pause',
        'reconnect_attempt',
        'rebuffer_event',
        'playback_stall',
        'media_stalled',
    ] as const;

    it.each(kinds)('records a %s entry into the incident buffer', (kind) => {
        expect(source).toMatch(
            new RegExp(`incidentBuffer\\?\\.push\\(\\{[^}]*?kind: '${kind}'`, 's'),
        );
    });

    it('constructs the reporter with a deviceId and a clientInfo getter', () => {
        const anchor = source.indexOf('new IncidentReporter({');
        expect(anchor).toBeGreaterThan(-1);
        const construction = source.slice(anchor, anchor + 900);
        // Reuses the file's existing device-id helper rather than a second
        // device-id mechanism.
        expect(construction).toContain('deviceId: getDeviceId()');
        // A GETTER, not a captured object literal — a snapshot would freeze
        // playMethod at attempt start.
        expect(construction).toMatch(/clientInfo:\s*\(\)\s*=>/);
        expect(construction).toContain('playMethod');
    });

    it('constructs the reporter with a mediaId getter over the CURRENT item', () => {
        const anchor = source.indexOf('new IncidentReporter({');
        const construction = source.slice(anchor, anchor + 1200);
        expect(construction).toMatch(/mediaId:\s*\(\)\s*=>\s*this\.currentMediaDbId\b/);
    });

    it.each([
        ['recordSeek', 'seek'],
        ['recordQualitySwitch', 'quality_switch'],
        ['recordMediaStalled', 'media_stalled'],
    ])('pushes alongside the existing %s telemetry call', (telemetryCall, kind) => {
        const anchor = source.indexOf(telemetryCall);
        expect(anchor).toBeGreaterThan(-1);
        // The push must sit in the same handler as the telemetry call, not
        // somewhere else in this 8k-line file.
        const window = source.slice(anchor, anchor + 800);
        expect(window).toContain(`kind: '${kind}'`);
    });
});
