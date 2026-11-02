// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `deriveSessionState` — pure function, no I/O, no mocks.
 */
import { describe, test, expect } from 'vitest';
import { deriveDelivery, deriveSessionState, glanceSessions, isStruggling } from './session-state';
import type { AdminPlaySession } from '$lib/schemas/api-admin-responses';
import type { FFmpegJobInfo } from '$lib/types/admin-metrics';

function makeSession(overrides: Partial<AdminPlaySession> = {}): AdminPlaySession {
    return {
        __id: 'sess-1',
        username: 'denis',
        title: 'Test',
        clientname: 'Web',
        browsername: 'Safari',
        playIsPlaying: true,
        ...overrides,
    } as AdminPlaySession;
}

function makeJob(overrides: Partial<FFmpegJobInfo> = {}): FFmpegJobInfo {
    return {
        jobId: 'job-1',
        playSessionId: 'sess-1',
        itemId: 'item-1',
        username: 'denis',
        deviceId: 'dev-1',
        status: 'running',
        mode: 'remux',
        startedAt: '2026-01-01T00:00:00Z',
        elapsedSeconds: 10,
        lastAccessedAt: '2026-01-01T00:00:00Z',
        lastAccessedSecondsAgo: 1,
        lastProgressAt: '2026-01-01T00:00:00Z',
        lastProgressSecondsAgo: 1,
        segmentsReady: 5,
        segmentOffset: 0,
        totalSegments: 100,
        progressPercent: 50,
        masterPlaylistReady: true,
        isSeeking: false,
        seekCount: 0,
        audioTrackCount: 1,
        audioTracks: [],
        subtitleTrackCount: 0,
        subtitles: [],
        processRunning: true,
        outputDir: '/tmp/out',
        ...overrides,
    } as FFmpegJobInfo;
}

describe('deriveSessionState — health', () => {
    test('playing_default — no jobs, playing, no buffer issue → playing', () => {
        const s = deriveSessionState(makeSession(), []);
        expect(s.health.kind).toBe('playing');
    });

    test('paused_wins_over_stalled — paused + stalled job → paused', () => {
        const job = makeJob({
            lastProgressSecondsAgo: 60,
            processRunning: true,
        });
        const s = deriveSessionState(makeSession({ playIsPlaying: false }), [job]);
        expect(s.health.kind).toBe('paused');
    });

    test('errored_wins_over_paused — errored job + paused → errored', () => {
        const job = makeJob({ error: 'boom', status: 'error' });
        const s = deriveSessionState(makeSession({ playIsPlaying: false }), [job]);
        expect(s.health).toEqual({ kind: 'errored', reason: 'boom' });
    });

    test('low_buffer_at_1s — buffer 1.5s, playing → low_buffer', () => {
        const s = deriveSessionState(makeSession({ buffer_health_sec: 1.5 }), []);
        expect(s.health).toEqual({ kind: 'low_buffer', seconds: 1.5 });
    });

    test('low_buffer_at_2s_not_triggered — buffer exactly 2.0s → playing', () => {
        const s = deriveSessionState(makeSession({ buffer_health_sec: 2.0 }), []);
        expect(s.health.kind).toBe('playing');
    });

    test('stalled_only_if_running — stale job but processRunning=false → playing', () => {
        const job = makeJob({
            lastProgressSecondsAgo: 60,
            processRunning: false,
        });
        const s = deriveSessionState(makeSession(), [job]);
        expect(s.health.kind).toBe('playing');
    });

    test('stalled_triggers_at_31s — running, stale, status!=ready → stalled', () => {
        const job = makeJob({
            lastProgressSecondsAgo: 31,
            processRunning: true,
            status: 'running',
        });
        const s = deriveSessionState(makeSession(), [job]);
        expect(s.health).toEqual({ kind: 'stalled', since: 31 });
    });
});

describe('deriveSessionState — method', () => {
    test('direct_no_jobs → direct', () => {
        expect(deriveSessionState(makeSession(), []).method.kind).toBe('direct');
    });

    test('remux_plan_mode → remux', () => {
        const s = deriveSessionState(makeSession({ plan_mode: 'remux' }), []);
        expect(s.method.kind).toBe('remux');
    });

    test('remux_play_method_fallback — no plan_mode, playMethod=remux → remux', () => {
        const s = deriveSessionState(makeSession({ playMethod: 'remux' }), []);
        expect(s.method.kind).toBe('remux');
    });

    test('full_transcode_plan → full_transcode with reason[0]', () => {
        const s = deriveSessionState(
            makeSession({
                plan_mode: 'full_transcode',
                plan_reasons: ['hevc not supported'],
            }),
            [],
        );
        expect(s.method).toEqual({
            kind: 'full_transcode',
            reason: 'hevc not supported',
        });
    });

    test('full_transcode_via_playmethod → full_transcode', () => {
        const s = deriveSessionState(makeSession({ playMethod: 'transcode' }), []);
        expect(s.method.kind).toBe('full_transcode');
    });

    test('audio_transcode → audio_transcode', () => {
        const s = deriveSessionState(makeSession({ plan_mode: 'audio_transcode' }), []);
        expect(s.method.kind).toBe('audio_transcode');
    });

    // The audio-only rung (video dropped, `-vn`). It has NO plan_mode of its own
    // — it is a client-side quality selection that reuses whichever plan the
    // other rungs were built from — so playMethod is the only signal, and it has
    // to beat plan_mode. The three cases below cover the plan_modes an audio-only
    // session realistically arrives with. Fixtures deliberately carry a
    // CONFLICTING plan_mode: with the arm placed after the plan_mode branches
    // (or missing entirely) each would resolve to something else.
    test('audio_only_play_method_beats_remux_plan → audio_only', () => {
        const s = deriveSessionState(
            makeSession({ playMethod: 'audio_only', plan_mode: 'remux' }),
            [],
        );
        expect(s.method.kind).toBe('audio_only');
    });

    test('audio_only_play_method_beats_full_transcode_plan → audio_only', () => {
        const s = deriveSessionState(
            makeSession({
                playMethod: 'audio_only',
                plan_mode: 'full_transcode',
                plan_reasons: ['hevc not supported'],
            }),
            [],
        );
        expect(s.method.kind).toBe('audio_only');
    });

    test('audio_only_play_method_beats_audio_transcode_plan → audio_only', () => {
        const s = deriveSessionState(
            makeSession({ playMethod: 'audio_only', plan_mode: 'audio_transcode' }),
            [],
        );
        expect(s.method.kind).toBe('audio_only');
    });

    test('audio_only_is_not_a_plan_mode — plan_mode alone never yields audio_only', () => {
        // Guards the inverse: nothing should start reporting audio_only just
        // because a plan says so. Only the session's own playMethod can.
        const s = deriveSessionState(makeSession({ plan_mode: 'remux' }), []);
        expect(s.method.kind).toBe('remux');
    });

    test('starting_when_no_plan_and_progress_zero → starting', () => {
        const job = makeJob({ progressPercent: 0, processRunning: true });
        const s = deriveSessionState(makeSession(), [job]);
        expect(s.method.kind).toBe('starting');
    });

    test('completing_overrides_direct_when_no_plan — job at 100% → completing', () => {
        const job = makeJob({ progressPercent: 100 });
        const s = deriveSessionState(makeSession(), [job]);
        expect(s.method.kind).toBe('completing');
    });

    test('plan_mode_beats_completing — plan_mode=remux + job at 100% → remux', () => {
        const job = makeJob({ progressPercent: 100 });
        const s = deriveSessionState(makeSession({ plan_mode: 'remux' }), [job]);
        expect(s.method.kind).toBe('remux');
    });
});

describe('deriveSessionState — resource', () => {
    test('no_jobs → jobCount 0, runningJobs 0', () => {
        const r = deriveSessionState(makeSession(), []).resource;
        expect(r).toEqual({ jobCount: 0, runningJobs: 0 });
    });

    test('one_completed_job — 1 job, processRunning=false → 1/0 (ghost paradox fix)', () => {
        const job = makeJob({ processRunning: false });
        const r = deriveSessionState(makeSession(), [job]).resource;
        expect(r).toEqual({ jobCount: 1, runningJobs: 0 });
    });

    test('mixed_running_and_completed — 2 jobs, 1 running → 2/1', () => {
        const jobs = [
            makeJob({ jobId: 'a', processRunning: true }),
            makeJob({ jobId: 'b', processRunning: false }),
        ];
        const r = deriveSessionState(makeSession(), jobs).resource;
        expect(r).toEqual({ jobCount: 2, runningJobs: 1 });
    });
});

describe('deriveSessionState — severity', () => {
    test('healthy_when_playing', () => {
        expect(deriveSessionState(makeSession(), []).severity).toBe('healthy');
    });

    test('degraded_when_paused', () => {
        const s = deriveSessionState(makeSession({ playIsPlaying: false }), []);
        expect(s.severity).toBe('degraded');
    });

    test('error_when_errored', () => {
        const job = makeJob({ error: 'boom', status: 'error' });
        const s = deriveSessionState(makeSession(), [job]);
        expect(s.severity).toBe('error');
    });
});

describe('deriveDelivery + isStruggling', () => {
    // 6 s segments: offset 10 + 5 ready = encoded to 90 s of media.
    const job = (o: Partial<FFmpegJobInfo> = {}): FFmpegJobInfo =>
        makeJob({ segmentOffset: 10, segmentsReady: 5, elapsedSeconds: 15, ...o });

    test('headroom is encoded-until minus the playhead', () => {
        const d = deriveDelivery(makeSession({ playCurrentTime: 70 }), [job()], 6);
        expect(d.headroomSec).toBe(20);
        // 5 segments x 6 s in 15 s of wall clock = 2x realtime.
        expect(d.encodeSpeed).toBe(2);
    });

    test("a copy-mode job's own 10 s segments win over the global 6 s", () => {
        // Prod 2026-10-16: an audio-only remux 95 segments in (950 s) at
        // playhead 758 s read as 0 s headroom with 6 s, flagging the row.
        const remux = makeJob({
            segmentsReady: 95,
            segmentDurationSeconds: 10,
            elapsedSeconds: 774,
        });
        const session = makeSession({ playCurrentTime: 758 });
        const d = deriveDelivery(session, [remux], 6);
        expect(d.headroomSec).toBe(192);
        expect(d.encodeSpeed).toBeCloseTo(950 / 774);
        expect(isStruggling(deriveSessionState(session, [remux]), d, [remux])).toBe(false);
    });

    test('no segment duration = no time-based guesses', () => {
        const d = deriveDelivery(makeSession({ playCurrentTime: 70 }), [job()], undefined);
        expect(d.headroomSec).toBeUndefined();
        expect(d.encodeSpeed).toBeUndefined();
    });

    test('a job younger than 5 s reports no speed', () => {
        const d = deriveDelivery(makeSession(), [job({ elapsedSeconds: 2 })], 6);
        expect(d.encodeSpeed).toBeUndefined();
    });

    test('encoder names the GPU encoder, or CPU', () => {
        const gpu = job({
            transcodeDecision: {
                videoAction: 'transcode',
                audioAction: 'copy',
                useGpu: true,
                gpuEncoder: 'h264_qsv',
                needsTonemapping: false,
            },
        });
        expect(deriveDelivery(makeSession(), [gpu], 6).encoder).toBe('h264_qsv');
        expect(deriveDelivery(makeSession(), [job()], 6).encoder).toBe('CPU');
        expect(deriveDelivery(makeSession(), [], 6)).toEqual({});
    });

    test('a pause is not struggling, even though severity calls it degraded', () => {
        const session = makeSession({ playIsPlaying: false, playCurrentTime: 89 });
        const state = deriveSessionState(session, [job()]);
        expect(state.severity).toBe('degraded');
        expect(isStruggling(state, deriveDelivery(session, [job()], 6), [job()])).toBe(false);
    });

    test('a playing transcode about to run out of output is struggling', () => {
        const session = makeSession({ playCurrentTime: 85 });
        const state = deriveSessionState(session, [job()]);
        expect(isStruggling(state, deriveDelivery(session, [job()], 6), [job()])).toBe(true);
    });

    test('...unless the job already encoded to the end of the file', () => {
        const done = job({ progressPercent: 100 });
        const session = makeSession({ playCurrentTime: 85 });
        const state = deriveSessionState(session, [done]);
        expect(isStruggling(state, deriveDelivery(session, [done], 6), [done])).toBe(false);
    });

    test('a playing session whose encode the server flagged as slow is struggling', () => {
        const slow = job({ slowReason: 'gpu_busy' });
        // 80 s ready ahead: more than LOW_HEADROOM_SECONDS, but a slow encoder eats it.
        const session = makeSession({ playCurrentTime: 10 });
        const state = deriveSessionState(session, [slow]);
        const delivery = deriveDelivery(session, [slow], 6);
        expect(delivery.slowReason).toBe('gpu_busy');
        expect(isStruggling(state, delivery, [slow])).toBe(true);
        const paused = makeSession({ playIsPlaying: false, playCurrentTime: 10 });
        expect(
            isStruggling(deriveSessionState(paused, [slow]), deriveDelivery(paused, [slow], 6)),
        ).toBe(false);
    });

    test('a slow encode with minutes ready ahead is not struggling yet', () => {
        // 10 + 30 segments x 6 s = 240 s encoded, playhead at 10 s.
        const slow = job({ slowReason: 'cpu_slow', segmentsReady: 30 });
        const session = makeSession({ playCurrentTime: 10 });
        const delivery = deriveDelivery(session, [slow], 6);
        expect(delivery.headroomSec).toBeGreaterThanOrEqual(120);
        expect(isStruggling(deriveSessionState(session, [slow]), delivery, [slow])).toBe(false);
    });

    test('a job that fell back to software names the CPU even when its row still says GPU', () => {
        const fellBack = job({
            softwareFallbackFrom: 'hevc_nvenc',
            transcodeDecision: {
                videoAction: 'transcode',
                audioAction: 'copy',
                useGpu: true,
                gpuEncoder: 'hevc_nvenc',
                needsTonemapping: false,
            },
        });
        const delivery = deriveDelivery(makeSession(), [fellBack], 6);
        expect(delivery.encoder).toBe('CPU');
        expect(delivery.softwareFallbackFrom).toBe('hevc_nvenc');
    });

    test('low buffer and stalls are struggling regardless of headroom', () => {
        const low = makeSession({ buffer_health_sec: 1 });
        expect(isStruggling(deriveSessionState(low, []), {})).toBe(true);
        expect(isStruggling(deriveSessionState(makeSession(), []), {})).toBe(false);
    });
});

describe('glanceSessions', () => {
    test("totals and per-session rows use the table's rules", () => {
        const sessions = [
            makeSession({
                __id: 'a',
                bandwidth_mbps: 8,
                playMethod: 'transcode',
                playCurrentTime: 85,
            }),
            makeSession({ __id: 'b', bandwidth_mbps: 2, playIsPlaying: false }),
            makeSession({ __id: 'c' }),
        ];
        const jobs = [makeJob({ playSessionId: 'a', segmentOffset: 10, segmentsReady: 5 })];
        const { bySession, totals } = glanceSessions(sessions, jobs, 6);
        expect(totals).toEqual({ watching: 3, transcoding: 1, struggling: 1, bandwidthMbps: 10 });
        expect(bySession.get('a')?.struggling).toBe(true);
        // Paused is not struggling.
        expect(bySession.get('b')?.struggling).toBe(false);
        expect(bySession.get('c')?.transcoding).toBe(false);
    });
});
