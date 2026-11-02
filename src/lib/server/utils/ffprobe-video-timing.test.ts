// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import frozenAv1 from './__fixtures__/nonadvancing-av1-packets.json';
import extremeSeekAv1 from './__fixtures__/nonadvancing-av1-extreme-seek-packets.json';

const mocks = vi.hoisted(() => ({
    exec: vi.fn(),
    guard: vi.fn(),
    stat: vi.fn(),
    inputArgs: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
    ...(await original<typeof import('node:fs/promises')>()),
    stat: (...args: unknown[]) => mocks.stat(...args),
}));
vi.mock('node:child_process', async () => {
    const { promisify } = await import('node:util');
    const execFile = Object.assign(vi.fn(), { [promisify.custom]: mocks.exec });
    return { execFile };
});
vi.mock('$lib/server/services/transcoding/input-guard.js', () => ({
    assertTranscodeInputIsMedia: mocks.guard,
}));
vi.mock('./library-input-guard.js', () => ({ ffprobeLibraryInputArgs: mocks.inputArgs }));
import { fsGuardStats } from './safe-fs.js';
import { hasNonadvancingVideoTiming, probeVideoTiming } from './ffprobe-video-timing.js';

interface Packet {
    pts_time: string;
    dts_time: string;
    duration_time: string;
    size: string;
    flags: string;
}
function fixture(packets: Partial<Packet>[], codec = 'av1'): unknown {
    return { streams: [{ codec_name: codec }], packets };
}
function cfr(count = 4096): Packet[] {
    return Array.from({ length: count }, (_, i) => ({
        pts_time: String(i / 24),
        dts_time: String(i / 24),
        duration_time: String(1 / 24),
        size: '16011',
        flags: '___',
    }));
}

describe('positive evidence of a frozen packet timeline', () => {
    it('recognizes the recorded malformed AV1 tail, including nonempty non-discard packets', () => {
        expect(hasNonadvancingVideoTiming(frozenAv1)).toBe(true);
    });
    it('keeps the recorded too-short extreme-seek AV1 sample inconclusive', () => {
        expect(extremeSeekAv1.packets).toHaveLength(194);
        expect(hasNonadvancingVideoTiming(extremeSeekAv1)).toBe(false);
    });
    it('does not confuse a normal full packet cap or an unchanged black picture with frozen timestamps', () => {
        expect(hasNonadvancingVideoTiming(fixture(cfr()))).toBe(false);
    });
    it('accepts VFR and decode reordering, including duplicates within small temporal groups', () => {
        const packets = cfr().map((p, i) => ({
            ...p,
            pts_time: String(Math.floor(i / 4) * 0.17 + (i % 2 === 0 ? 0.04 : 0)),
            dts_time: String(Math.floor(i / 4) * 0.17),
        }));
        expect(hasNonadvancingVideoTiming(fixture(packets))).toBe(false);
    });
    it('accepts AV1 hidden temporal units interleaved with displayed frames', () => {
        const packets = cfr().flatMap((p) => [
            { ...p, duration_time: '0', flags: '_D_' },
            { ...p, duration_time: '0' },
            p,
        ]);
        expect(hasNonadvancingVideoTiming(fixture(packets))).toBe(false);
    });
    it.each(['pts_time', 'dts_time', 'duration_time'])('missing %s is inconclusive', (key) => {
        const packets = cfr().map((p) => ({ ...p, pts_time: '37', dts_time: '37', [key]: 'N/A' }));
        expect(hasNonadvancingVideoTiming(fixture(packets))).toBe(false);
    });
    it('does not treat discard/empty/header packets as displayed frames or count tiny payloads', () => {
        for (const override of [
            { flags: '_D_' },
            { size: '0' },
            { size: '3' },
            { duration_time: '0' },
        ]) {
            const packets = cfr().map((p) => ({
                ...p,
                pts_time: '37',
                dts_time: '37',
                ...override,
            }));
            expect(hasNonadvancingVideoTiming(fixture(packets))).toBe(false);
        }
    });
    it('a few repeated timestamps remain inconclusive, regardless of packet payload', () => {
        const packets = cfr().flatMap((p) => [p, p, p]);
        expect(hasNonadvancingVideoTiming(fixture(packets))).toBe(false);
    });
});

describe('bounded selected local input probing', () => {
    let directory: string;
    let path: string;
    beforeEach(async () => {
        vi.clearAllMocks();
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        mocks.stat.mockReset().mockImplementation(actual.stat);
        mocks.guard.mockReset().mockResolvedValue(undefined);
        directory = await mkdtemp(join(tmpdir(), 'video-timing-'));
        path = join(directory, 'video.mkv');
        await writeFile(path, 'local fixture');
        mocks.inputArgs.mockResolvedValue(['-format_whitelist', 'matroska,webm']);
        mocks.exec.mockResolvedValue({ stdout: JSON.stringify(frozenAv1) });
    });
    afterEach(async () => {
        vi.useRealTimers();
        await rm(directory, { recursive: true, force: true });
    });
    it('uses the safe local-input guards and finite packet/output/time caps', async () => {
        expect(await probeVideoTiming(path, 3724.192)).toBe('nonadvancing');
        expect(mocks.guard).toHaveBeenCalledWith({ localFilePath: path });
        expect(mocks.exec).toHaveBeenCalledWith(
            expect.any(String),
            expect.arrayContaining([
                '-read_intervals',
                '3714.192%+#4096',
                '-format_whitelist',
                'matroska,webm',
                path,
            ]),
            expect.objectContaining({
                timeout: 15_000,
                maxBuffer: 2 * 1024 * 1024,
                killSignal: 'SIGKILL',
            }),
        );
    });
    it('finds the recorded defect using the actual file end rather than an extreme seek or decoder window', async () => {
        mocks.exec.mockImplementation(async (_binary: string, args: string[]) => ({
            stdout: JSON.stringify(args.includes('3714.192%+#4096') ? frozenAv1 : extremeSeekAv1),
        }));
        expect(await probeVideoTiming(path, 3724.192)).toBe('nonadvancing');
    });
    it('starts a short file at zero and refuses an unusable duration without spawning', async () => {
        await probeVideoTiming(path, 5);
        expect(mocks.exec.mock.calls[0][1]).toContain('0%+#4096');
        mocks.exec.mockClear();
        for (const duration of [0, -1, NaN, Infinity])
            expect(await probeVideoTiming(path, duration)).toBe('inconclusive');
        expect(mocks.exec).not.toHaveBeenCalled();
    });
    it.each(['timeout', 'output cap', 'nonzero exit'])(
        'does not diagnose %s from partial positive stdout',
        async (cause) => {
            mocks.exec.mockRejectedValue(
                Object.assign(new Error(cause), { stdout: JSON.stringify(frozenAv1) }),
            );
            expect(await probeVideoTiming(path, 3724.192)).toBe('inconclusive');
        },
    );
    it('discards malformed JSON', async () => {
        mocks.exec.mockResolvedValue({ stdout: '{' });
        expect(await probeVideoTiming(path, 3724.192)).toBe('inconclusive');
    });
    it('refuses pre-abort without spawning and propagates an abort during the probe', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(probeVideoTiming(path, 3724.192, controller.signal)).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(mocks.exec).not.toHaveBeenCalled();
        const active = new AbortController();
        mocks.exec.mockImplementation(async () => {
            active.abort();
            throw new Error('killed');
        });
        await expect(probeVideoTiming(path, 3724.192, active.signal)).rejects.toMatchObject({
            name: 'AbortError',
        });
    });
    it('does not attribute evidence to a replaced local input', async () => {
        mocks.exec.mockImplementation(async () => {
            await writeFile(path, 'a replaced local fixture');
            return { stdout: JSON.stringify(frozenAv1) };
        });
        expect(await probeVideoTiming(path, 3724.192)).toBe('input-changed');
    });
    it('discards successful packet evidence if the file disappears before the final stat', async () => {
        mocks.exec.mockImplementation(async () => {
            await rm(path);
            return { stdout: JSON.stringify(frozenAv1) };
        });
        expect(await probeVideoTiming(path, 3724.192)).toBe('input-changed');
    });
    it.each(['before', 'after'])(
        'bounds a stalled %s stat and retains its real FS permit',
        async (stage) => {
            const actual =
                await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
            const identity = await actual.stat(path, { bigint: true });
            let finish!: (value: typeof identity) => void;
            if (stage === 'after') mocks.stat.mockResolvedValueOnce(identity);
            mocks.stat.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            );
            vi.useFakeTimers();
            const before = fsGuardStats().inFlight;
            const probe = probeVideoTiming(path, 3724.192);
            const result = expect(probe).resolves.toBe('inconclusive');
            await vi.advanceTimersByTimeAsync(5001);
            await result;
            expect(fsGuardStats().inFlight).toBe(before + 1);
            expect(mocks.exec).toHaveBeenCalledTimes(stage === 'after' ? 1 : 0);
            finish(identity);
            await vi.advanceTimersByTimeAsync(0);
            expect(fsGuardStats().inFlight).toBe(before);
        },
    );
    it.each(['before', 'after'])(
        'aborts immediately during a stalled %s stat without releasing its occupied permit',
        async (stage) => {
            const actual =
                await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
            const identity = await actual.stat(path, { bigint: true });
            let finish!: (value: typeof identity) => void;
            if (stage === 'after') mocks.stat.mockResolvedValueOnce(identity);
            mocks.stat.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            );
            const controller = new AbortController();
            vi.useFakeTimers();
            const before = fsGuardStats().inFlight;
            const probe = probeVideoTiming(path, 3724.192, controller.signal);
            const result = expect(probe).rejects.toMatchObject({ name: 'AbortError' });
            await vi.advanceTimersByTimeAsync(0);
            controller.abort();
            await result;
            expect(fsGuardStats().inFlight).toBe(before + 1);
            finish(identity);
            await vi.advanceTimersByTimeAsync(0);
            expect(fsGuardStats().inFlight).toBe(before);
        },
    );
    it('bounds the whole preflight when preparation never returns', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        mocks.stat.mockResolvedValue(await actual.stat(path, { bigint: true }));
        mocks.guard.mockReturnValue(new Promise(() => {}));
        vi.useFakeTimers();
        const probe = probeVideoTiming(path, 3724.192);
        const result = expect(probe).resolves.toBe('inconclusive');
        await vi.advanceTimersByTimeAsync(30_001);
        await result;
        expect(mocks.exec).not.toHaveBeenCalled();
    });
});
