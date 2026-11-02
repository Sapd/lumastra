// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    acquirePlaybackCpuSlot,
    playbackCpuExempt,
    playbackDeferralExpired,
    MAX_PLAYBACK_DEFERRAL_MS,
    parseCpuPressure,
    recordPlaybackDeferral,
    type PressureState,
    countPlaybackTranscodes,
    type PlaybackEncodeJob,
    decidePlaybackPressure,
    getPlaybackPressure,
    isBackgroundCpuTask,
    publishPlaybackPressure,
    type PlaybackPressureSample,
} from './playback-pressure.js';
import type { ValkeyLike } from './valkey-types.js';

vi.mock('$lib/server/cache/valkey.js', () => ({ getCoordinationClient: () => null }));
vi.mock('node:fs/promises', () => ({
    readFile: async (p: string) =>
        p === '/proc/self/cgroup' ? '0::/\n' : 'some avg10=0.00 avg60=0.00 total=0',
}));
const sample = (cpu = 0, gpu = 0, load = 0): PlaybackPressureSample => ({
    activeSessions: 1,
    cpuTranscodes: cpu,
    gpuTranscodes: gpu,
    loadRatioPerCore: load,
    sampledAt: Date.now(),
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/** Separate reader and publisher share only this TTL-aware wire store. */
function wireStore(): {
    publisher: ValkeyLike;
    reader: ValkeyLike;
    keys: Map<string, { value: string; expires: number }>;
} {
    const keys = new Map<string, { value: string; expires: number }>();
    const sorted = new Map<string, Map<string, number>>();
    const command = async (args: string[]): Promise<unknown> => {
        for (const [key, record] of keys) if (record.expires <= Date.now()) keys.delete(key);
        if (args[0] === 'SET') {
            if (args.includes('NX') && keys.has(args[1])) return null;
            keys.set(args[1], {
                value: args[2],
                expires: Date.now() + Number(args[args.indexOf('EX') + 1]) * 1000,
            });
            return 'OK';
        }
        if (args[0] === 'GET') return keys.get(args[1])?.value ?? null;
        const publishers = sorted.get(args[1]) ?? new Map<string, number>();
        sorted.set(args[1], publishers);
        if (args[0] === 'ZADD') {
            const offset = args[2] === 'NX' ? 1 : 0;
            if (!offset || !publishers.has(args[3 + offset]))
                publishers.set(args[3 + offset], Number(args[2 + offset]));
            return 1;
        }
        if (args[0] === 'ZREM') {
            publishers.delete(args[2]);
            return 1;
        }
        if (args[0] === 'ZRANGE')
            return [...publishers]
                .sort((a, b) => a[1] - b[1])
                .slice(0, 1)
                .flatMap(([k, v]) => [k, String(v)]);
        if (args[0] === 'EVAL') {
            if (args[1].includes('state-cas')) {
                if ((keys.get(args[3])?.value ?? '') !== args[4]) return 0;
                keys.set(args[3], { value: args[5], expires: Date.now() + 300_000 });
                return 1;
            }
            if (keys.get(args[3])?.value !== args[4]) return 0;
            if (args[1].includes('slot-release')) {
                keys.delete(args[3]);
                return 1;
            }
            if (args[1].includes('slot-renew')) {
                keys.get(args[3])!.expires = Date.now() + Number(args[5]) * 1000;
                return 1;
            }
        }
        if (args[0] === 'EXPIRE') return 1;
        if (args[0] === 'ZREMRANGEBYSCORE') {
            for (const [key, score] of publishers)
                if (score <= Number(args[3])) publishers.delete(key);
            return 1;
        }
        if (args[0] === 'ZRANGEBYSCORE')
            return [...publishers]
                .filter(([, score]) => score >= Number(args[2]))
                .map(([key]) => key);
        if (args[0] === 'MGET') return args.slice(1).map((key) => keys.get(key)?.value ?? null);
        throw new Error(`Unexpected command ${args[0]}`);
    };
    return { publisher: { customCommand: command }, reader: { customCommand: command }, keys };
}

describe('playback CPU admission decision', () => {
    it('pauses for CPU encoding even at low load', () => {
        expect(decidePlaybackPressure([sample(1)], 1.25).reason).toBe('cpu_transcode');
    });
    it('allows GPU encoding and idle hosts', () => {
        expect(decidePlaybackPressure([sample(0, 2, 0.5)], 1.25).paused).toBe(false);
    });
    it('trips only above the threshold', () => {
        expect(decidePlaybackPressure([sample(0, 0, 1.25)], 1.25).paused).toBe(false);
        expect(decidePlaybackPressure([sample(0, 0, 1.26)], 1.25).reason).toBe('host_load');
    });
    it('holds through the recovery band and cools off below 80 percent', () => {
        expect(
            decidePlaybackPressure([sample(0, 0, 1.1)], 1.25, {
                limited: true,
                holdUntil: Date.now() + 60_000,
            }).reason,
        ).toBe('host_load');
        expect(
            decidePlaybackPressure([sample(0, 0, 1)], 1.25, {
                limited: true,
                holdUntil: Date.now() + 60_000,
            }).reason,
        ).toBe('cooloff');
        expect(decidePlaybackPressure([sample(0, 0, 1)], 1.25).paused).toBe(false);
    });
    it('zero disables only load shedding', () => {
        expect(decidePlaybackPressure([sample(0, 0, 100)], 0).paused).toBe(false);
        expect(decidePlaybackPressure([sample(1)], 0).paused).toBe(true);
    });
    it('includes CPU, legacy analysis, and sonic but leaves IO work alone', () => {
        expect(isBackgroundCpuTask('cpu', 'trickplay-generation')).toBe(true);
        expect(isBackgroundCpuTask('analysis', 'lumastra-intro-analyzer')).toBe(true);
        expect(isBackgroundCpuTask('embedding', 'sonic-embedding-backfill')).toBe(true);
        expect(isBackgroundCpuTask('io', 'scan')).toBe(false);
    });
});

describe('cross-process playback pressure', () => {
    it('keeps the pressure decision when concurrent readers win all hysteresis CAS writes', async () => {
        const wire = wireStore();
        await publishPlaybackPressure(
            'web',
            { cpuTranscodes: 1, gpuTranscodes: 0, activeSessions: 1 },
            wire.publisher,
        );
        const contended: ValkeyLike = {
            customCommand: async (args): Promise<unknown> => {
                if (args[0] === 'EVAL' && args[1].includes('state-cas')) return 0;
                return wire.reader.customCommand(args);
            },
        };
        expect(await getPlaybackPressure(contended, 2)).toMatchObject({
            paused: true,
            reason: 'cpu_transcode',
        });
    });

    it('publishes counts to task Valkey and expires dead publishers', async () => {
        vi.useFakeTimers();
        const wire = wireStore();
        await publishPlaybackPressure(
            'web-a',
            { cpuTranscodes: 1, gpuTranscodes: 2, activeSessions: 3 },
            wire.publisher,
        );
        expect(await getPlaybackPressure(wire.reader, 0)).toMatchObject({
            paused: true,
            cpuTranscodes: 1,
            gpuTranscodes: 2,
        });
        vi.advanceTimersByTime(30_001);
        // A live worker's empty snapshot must not extend a dead web pod's hold.
        await publishPlaybackPressure(
            'worker',
            { cpuTranscodes: 0, gpuTranscodes: 0, activeSessions: 0 },
            wire.publisher,
        );
        expect(await getPlaybackPressure(wire.reader, 0)).toMatchObject({
            paused: false,
            cpuTranscodes: 0,
            gpuTranscodes: 0,
        });
    });
    it('sums web replicas and resumes automatically after a sustained recovery', async () => {
        vi.useFakeTimers();
        const wire = wireStore();
        await publishPlaybackPressure(
            'web-a',
            { cpuTranscodes: 1, gpuTranscodes: 0, activeSessions: 1 },
            wire.publisher,
        );
        await publishPlaybackPressure(
            'web-b',
            { cpuTranscodes: 2, gpuTranscodes: 1, activeSessions: 3 },
            wire.publisher,
        );
        expect((await getPlaybackPressure(wire.reader, 0)).cpuTranscodes).toBe(3);
        await publishPlaybackPressure(
            'web-a',
            { cpuTranscodes: 0, gpuTranscodes: 0, activeSessions: 0 },
            wire.publisher,
        );
        await publishPlaybackPressure(
            'web-b',
            { cpuTranscodes: 0, gpuTranscodes: 1, activeSessions: 1 },
            wire.publisher,
        );
        expect((await getPlaybackPressure(wire.reader, 0)).reason).toBe('cooloff');
        vi.advanceTimersByTime(30_001);
        expect((await getPlaybackPressure(wire.reader, 0)).paused).toBe(false);
    });
    it('ignores malformed and old payloads even when an external writer omits TTL', async () => {
        const wire = wireStore();
        await publishPlaybackPressure(
            'bad',
            { cpuTranscodes: 1, gpuTranscodes: 0, activeSessions: 1 },
            wire.publisher,
        );
        await publishPlaybackPressure(
            'old',
            { cpuTranscodes: 1, gpuTranscodes: 0, activeSessions: 1 },
            wire.publisher,
        );
        wire.keys.set('v2:playback-pressure:bad', { value: '{broken', expires: Infinity });
        wire.keys.set('v2:playback-pressure:old', {
            value: JSON.stringify({ ...sample(9), sampledAt: Date.now() - 31_000 }),
            expires: Infinity,
        });
        expect((await getPlaybackPressure(wire.reader, 0)).paused).toBe(false);
    });
    it('Valkey command and client resolution failures mean no pressure', async () => {
        const client = {
            customCommand: async (): Promise<unknown> => {
                throw new Error('offline');
            },
        };
        expect((await getPlaybackPressure(client, 2)).paused).toBe(false);
        const fail = (): never => {
            throw new Error('offline');
        };
        expect((await getPlaybackPressure(fail, 2)).paused).toBe(false);
        const slot = await acquirePlaybackCpuSlot(fail, 'run');
        expect(slot).not.toBeNull();
        await slot!.release();
        await expect(
            publishPlaybackPressure(
                'web',
                { cpuTranscodes: 1, gpuTranscodes: 0, activeSessions: 1 },
                client,
            ),
        ).resolves.toBeUndefined();
    });
});

describe('active playback encode classification', () => {
    function job(overrides: Partial<PlaybackEncodeJob> = {}): PlaybackEncodeJob {
        return {
            config: {},
            lastSegmentRequestedAt: Date.now(),
            status: 'running',
            generationRole: 'current',
            process: { killed: false, exitCode: null },
            transcodeDecisionResult: { videoAction: 'transcode', useGpu: false },
            ...overrides,
        };
    }
    it('counts starting CPU encodes, GPU encodes and software fallbacks accurately', () => {
        const gpu = { videoAction: 'transcode', useGpu: true, gpuEncoder: 'h264_nvenc' };
        expect(
            countPlaybackTranscodes([
                job({ status: 'starting', process: null }),
                job({ transcodeDecisionResult: gpu }),
                job({
                    transcodeDecisionResult: gpu,
                    config: { softwareEncodeFallback: 'h264_nvenc' },
                }),
                job({ transcodeDecisionResult: { videoAction: 'transcode', useGpu: true } }),
            ]),
        ).toEqual({ cpuTranscodes: 3, gpuTranscodes: 1, activeSessions: 4 });
    });
    it('counts a resumed CPU encoder after SIGSTOP/SIGCONT set ChildProcess.killed', () => {
        expect(
            countPlaybackTranscodes([
                job({ process: { killed: true, exitCode: null, signalCode: null } }),
                job({ process: { killed: true, exitCode: null, signalCode: 'SIGTERM' } }),
            ]),
        ).toMatchObject({ cpuTranscodes: 1, gpuTranscodes: 0 });
    });
    it('excludes direct streams, audio-only, previews, retired and finished processes', () => {
        expect(
            countPlaybackTranscodes([
                job({ transcodeDecisionResult: { videoAction: 'copy', useGpu: false } }),
                job({ transcodeDecisionResult: undefined }),
                job({ config: { isPreview: true } }),
                job({ config: { cacheKey: 'preview-artifact' } }),
                job({ generationRole: 'previous' }),
                job({ status: 'stopped' }),
                job({ status: 'ready', process: null }),
                job({ process: { killed: false, exitCode: 0 } }),
            ]),
        ).toMatchObject({ cpuTranscodes: 0, gpuTranscodes: 0 });
    });
});

describe('bounded background CPU admission', () => {
    it('one shared slot makes progress under pressure and renews during a long job', async () => {
        vi.useFakeTimers();
        const wire = wireStore();
        const first = await acquirePlaybackCpuSlot(wire.publisher, 'worker-a:run1');
        expect(first).not.toBeNull();
        expect(await acquirePlaybackCpuSlot(wire.reader, 'worker-b:run2')).toBeNull();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(await acquirePlaybackCpuSlot(wire.reader, 'worker-b:run2')).toBeNull();
        await first!.release();
        const second = await acquirePlaybackCpuSlot(wire.reader, 'worker-b:run2');
        expect(second).not.toBeNull();
        await first!.release();
        expect(await acquirePlaybackCpuSlot(wire.publisher, 'worker-a:run3')).toBeNull();
        await second!.release();
    });
    it('preserves first deferral age and expires the cap at exactly 15 minutes', async () => {
        vi.useFakeTimers();
        const wire = wireStore();
        const start = Date.now();
        await recordPlaybackDeferral(wire.publisher, 'run', start);
        await vi.advanceTimersByTimeAsync(120_000);
        await recordPlaybackDeferral(wire.publisher, 'run', Date.now());
        expect((await getPlaybackPressure(wire.reader, 2)).deferredMinutes).toBe(2);
        expect(playbackDeferralExpired(start, start + MAX_PLAYBACK_DEFERRAL_MS - 1)).toBe(false);
        expect(playbackDeferralExpired(start, start + MAX_PLAYBACK_DEFERRAL_MS)).toBe(true);
        expect(playbackDeferralExpired(undefined, start + MAX_PLAYBACK_DEFERRAL_MS)).toBe(false);
        expect(playbackDeferralExpired(0, MAX_PLAYBACK_DEFERRAL_MS)).toBe(true);
        await recordPlaybackDeferral(wire.reader, 'run', undefined);
        expect((await getPlaybackPressure(wire.reader, 2)).deferredMinutes).toBe(0);
    });
    it('exempts ingest probes and explicitly manual work', () => {
        expect(playbackCpuExempt('file-system-scan-probe')).toBe(true);
        expect(playbackCpuExempt('trickplay-generation', true)).toBe(true);
        expect(playbackCpuExempt('trickplay-generation')).toBe(false);
    });
    it('ignores load when playback is inactive and prefers pod PSI over host load', () => {
        expect(decidePlaybackPressure([{ ...sample(0, 0, 99), activeSessions: 0 }], 2).paused).toBe(
            false,
        );
        expect(
            decidePlaybackPressure([{ ...sample(0, 1, 99), cpuPressurePercent: 0 }], 2).paused,
        ).toBe(false);
        expect(decidePlaybackPressure([{ ...sample(), cpuPressurePercent: 21 }], 2).reason).toBe(
            'pod_pressure',
        );
        expect(parseCpuPressure('some avg10=21.50 avg60=1.00 total=7')).toBe(21.5);
        expect(parseCpuPressure('full avg10=99.00')).toBeUndefined();
    });
    it('damps repeated trip/recover cycles with hysteresis, hold and minimum run time', () => {
        let state: PressureState = { limited: false, holdUntil: 0 };
        const step = (now: number, load: number): ReturnType<typeof decidePlaybackPressure> => {
            const result = decidePlaybackPressure([sample(0, 1, load)], 2, state, now);
            state = result.state;
            return result;
        };
        for (const base of [0, 400_000]) {
            expect(step(base, 2.1).paused).toBe(true);
            expect(step(base + 10_000, 1.7).paused).toBe(true);
            expect(step(base + 69_999, 1.6).reason).toBe('cooloff');
            expect(step(base + 70_000, 1.6).paused).toBe(false);
            expect(step(base + 71_000, 2.9).reason).toBe('minimum_run');
            expect(step(base + 189_999, 2.9).paused).toBe(false);
            expect(step(base + 190_000, 2.9).paused).toBe(true);
            expect(step(base + 250_001, 0).paused).toBe(false);
        }
        expect(
            decidePlaybackPressure([sample(1)], 2, {
                limited: false,
                holdUntil: 0,
                resumedAt: Date.now(),
            }).reason,
        ).toBe('cpu_transcode');
        const expired = decidePlaybackPressure([], 2, { limited: true, holdUntil: 9999 }, 0);
        expect(decidePlaybackPressure([sample(0, 1, 3)], 2, expired.state, 1).paused).toBe(false);
        expect(decidePlaybackPressure([sample(0, 1, 3)], 2, expired.state, 120_000).paused).toBe(
            true,
        );
    });
    it('stopped and idle user jobs do not count as active CPU encodes', () => {
        const job: PlaybackEncodeJob = {
            config: {},
            status: 'running',
            generationRole: 'current',
            lastSegmentRequestedAt: Date.now(),
            process: { killed: false, exitCode: null },
            transcodeDecisionResult: { videoAction: 'transcode', useGpu: false },
        };
        expect(
            countPlaybackTranscodes([
                { ...job, throttlePaused: true },
                { ...job, parked: 'unwatched' },
                { ...job, lastSegmentRequestedAt: Date.now() - 20_001 },
                { ...job, lastSegmentRequestedAt: undefined },
            ]).cpuTranscodes,
        ).toBe(0);
    });
});
