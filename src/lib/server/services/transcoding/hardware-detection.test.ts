// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Keep the learn-on-failure persistence purely in-memory for unit tests so we
// don't reach for a live Valkey (the production calls are best-effort anyway).
vi.mock('../../cache/valkey.js', () => ({
    cacheGet: vi.fn(async () => null),
    cacheSet: vi.fn(async () => true),
    cacheDel: vi.fn(async () => 1),
}));

// The cross-replica bus is stubbed so publishes are assertable without a live
// Valkey pub/sub connection. The handler-registration functions become no-ops,
// which is fine: these tests drive the receiving side by calling the service's
// applyRemote* methods directly — the same thing the real handlers do.
vi.mock('../../cache/decode-deny-bus.js', () => ({
    publishDecodeDenySync: vi.fn(),
    onRemoteDecodeDenyLearn: vi.fn(),
    onRemoteDecodeDenyReset: vi.fn(),
}));

import {
    BUSY_ENCODER_PROBE_RETRY_MS,
    nvencSupportsAv1,
    buildEncoderProbeArgs,
    buildVaapiHdrTonemapProbeArgs,
    hardwareDetection,
} from './hardware-detection';
import { config } from '../../config.js';

describe('buildEncoderProbeArgs', () => {
    it('adds -vaapi_device + hwupload for VAAPI encoders (else the probe always fails)', () => {
        const args = buildEncoderProbeArgs('h264_vaapi');
        const joined = args.join(' ');
        expect(joined).toContain('-vaapi_device');
        expect(joined).toContain('format=nv12,hwupload');
        expect(args).toContain('h264_vaapi');
        // device flag must precede the input so the VAAPI surface is initialised
        expect(args.indexOf('-vaapi_device')).toBeLessThan(args.indexOf('-i'));
    });

    it('initialises a QSV device + uploads frames for QSV encoders', () => {
        const args = buildEncoderProbeArgs('h264_qsv');
        const joined = args.join(' ');
        expect(joined).toContain('qsv=qs@va');
        expect(joined).toContain('format=qsv');
        expect(joined).toContain('hwupload');
        expect(args).toContain('h264_qsv');
    });

    it('keeps the simple form for NVENC (it uploads internally)', () => {
        const args = buildEncoderProbeArgs('h264_nvenc');
        const joined = args.join(' ');
        expect(joined).not.toContain('-vaapi_device');
        expect(joined).not.toContain('hwupload');
        expect(joined).not.toContain('-init_hw_device');
        expect(args).toContain('h264_nvenc');
    });
});

describe('nvencSupportsAv1', () => {
    it('returns false for Ampere / pre-Ada GeForce (no AV1 encoder)', () => {
        // The case that motivated this: RTX 3090 lists av1_nvenc but it fails -22.
        expect(nvencSupportsAv1('NVIDIA GeForce RTX 3090')).toBe(false);
        expect(nvencSupportsAv1('NVIDIA GeForce RTX 3060 Ti')).toBe(false);
        expect(nvencSupportsAv1('NVIDIA GeForce RTX 2080 Super')).toBe(false);
        expect(nvencSupportsAv1('NVIDIA GeForce GTX 1660')).toBe(false);
    });

    it('returns true for Ada Lovelace (RTX 40-series) and Blackwell (50-series)', () => {
        expect(nvencSupportsAv1('NVIDIA GeForce RTX 4090')).toBe(true);
        expect(nvencSupportsAv1('NVIDIA GeForce RTX 4060')).toBe(true);
        expect(nvencSupportsAv1('NVIDIA GeForce RTX 5080')).toBe(true);
    });

    it('handles Ada datacenter cards (L4 / L40 / L40S)', () => {
        expect(nvencSupportsAv1('NVIDIA L40S')).toBe(true);
        expect(nvencSupportsAv1('NVIDIA L40')).toBe(true);
        expect(nvencSupportsAv1('NVIDIA L4')).toBe(true);
    });

    it('returns false for older datacenter GPUs (no AV1 NVENC)', () => {
        expect(nvencSupportsAv1('NVIDIA A100-SXM4-80GB')).toBe(false);
        expect(nvencSupportsAv1('Tesla T4')).toBe(false);
        expect(nvencSupportsAv1('Tesla V100-PCIE-16GB')).toBe(false);
    });

    it('is case-insensitive and tolerant of spacing', () => {
        expect(nvencSupportsAv1('nvidia geforce rtx4080')).toBe(true);
        expect(nvencSupportsAv1('GeForce RTX 3070')).toBe(false);
    });
});

describe('VA-API HDR tone-map capability', () => {
    it('probe args upload an HDR-tagged frame and try tonemap_vaapi', () => {
        const args = buildVaapiHdrTonemapProbeArgs();
        const joined = args.join(' ');
        expect(joined).toContain('-vaapi_device');
        expect(joined).toContain('color_trc=smpte2084');
        expect(joined).toContain('hwupload');
        expect(joined).toContain('tonemap_vaapi');
        // probe must end at a null sink (no encode)
        expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
        expect(joined).not.toContain('-c:v');
    });

    it('getHdrTonemapMode: vaapi reflects probe, qsv/nvenc hardware, none software', () => {
        // unprobed → safe default 'hardware' for vaapi
        expect(hardwareDetection.getHdrTonemapMode('qsv')).toBe('hardware');
        expect(hardwareDetection.getHdrTonemapMode('nvenc')).toBe('hardware');
        expect(hardwareDetection.getHdrTonemapMode('none')).toBe('software');
        expect(hardwareDetection.getHdrTonemapMode('amf')).toBe('n/a');
        // supportsVaapiHdrTonemap defaults true until positively probed false
        expect(hardwareDetection.supportsVaapiHdrTonemap()).toBe(true);
        expect(hardwareDetection.getHdrTonemapMode('vaapi')).toBe('hardware');
    });

    // Windows tower 2026-10-14: Lumastra probed NVENC while Sunshine and other
    // encodes held every session; the failed probe was cached until a restart,
    // so every later transcode ran on the CPU even after the encoder was free.
    it('retries a probe that failed only because the encoder was busy, after a minute', async () => {
        const svc = hardwareDetection as unknown as {
            runFFmpeg(args: string[], opts?: unknown): Promise<string>;
        };
        hardwareDetection.refreshAllProbes();
        vi.useFakeTimers();
        const run = vi
            .spyOn(svc, 'runFFmpeg')
            .mockRejectedValueOnce(
                new Error(
                    '[hevc_nvenc @ 0x1] OpenEncodeSessionEx failed: out of memory (10): (no details)\nConversion failed!',
                ),
            )
            .mockResolvedValue('');
        try {
            await expect(hardwareDetection.probeEncoder('hevc_nvenc')).resolves.toBe(false);
            // Within the minute: still the cached "no".
            await expect(hardwareDetection.probeEncoder('hevc_nvenc')).resolves.toBe(false);
            expect(run).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(BUSY_ENCODER_PROBE_RETRY_MS);
            await expect(hardwareDetection.probeEncoder('hevc_nvenc')).resolves.toBe(true);
            expect(run).toHaveBeenCalledTimes(2);
        } finally {
            run.mockRestore();
            vi.useRealTimers();
            hardwareDetection.refreshAllProbes();
        }
    });

    it.each([
        '[h264_nvenc @ 0x1] Cannot load libnvidia-encode.so.1',
        '[hevc_nvenc @ 0x1] No capable devices found',
        '[hevc_nvenc @ 0x1] The minimum required Nvidia driver for nvenc is 570.0 or newer',
    ])('a permanent NVENC failure stays cached: %s', async (line) => {
        const svc = hardwareDetection as unknown as {
            runFFmpeg(args: string[], opts?: unknown): Promise<string>;
        };
        hardwareDetection.refreshAllProbes();
        vi.useFakeTimers();
        const run = vi
            .spyOn(svc, 'runFFmpeg')
            .mockRejectedValue(new Error(`${line}\nConversion failed!`));
        try {
            await expect(hardwareDetection.probeEncoder('hevc_nvenc')).resolves.toBe(false);
            vi.advanceTimersByTime(BUSY_ENCODER_PROBE_RETRY_MS * 5);
            await expect(hardwareDetection.probeEncoder('hevc_nvenc')).resolves.toBe(false);
            expect(run).toHaveBeenCalledTimes(1);
        } finally {
            run.mockRestore();
            vi.useRealTimers();
            hardwareDetection.refreshAllProbes();
        }
    });

    it('keeps a probe that failed because the encoder does not exist cached', async () => {
        const svc = hardwareDetection as unknown as {
            runFFmpeg(args: string[], opts?: unknown): Promise<string>;
        };
        hardwareDetection.refreshAllProbes();
        vi.useFakeTimers();
        const run = vi
            .spyOn(svc, 'runFFmpeg')
            .mockRejectedValue(
                new Error(
                    "[av1_nvenc @ 0x1] Provided device doesn't support required NVENC features\nConversion failed!",
                ),
            );
        try {
            await expect(hardwareDetection.probeEncoder('av1_nvenc')).resolves.toBe(false);
            vi.advanceTimersByTime(BUSY_ENCODER_PROBE_RETRY_MS * 5);
            await expect(hardwareDetection.probeEncoder('av1_nvenc')).resolves.toBe(false);
            expect(run).toHaveBeenCalledTimes(1);
        } finally {
            run.mockRestore();
            vi.useRealTimers();
            hardwareDetection.refreshAllProbes();
        }
    });

    // Fresh install: boot detection ran with GPU_ACCELERATION=none, then the setup
    // wizard switched to vaapi at runtime. The tone-map probe must still run before
    // the first transcode, or AMD radeonsi gets tonemap_vaapi and HDR→SDR fails.
    it('getBestEncoder probes VA-API tone-mapping when vaapi was enabled after boot', async () => {
        const svc = hardwareDetection as unknown as {
            vaapiHdrTonemap: boolean | null;
            getCapabilities(): Promise<unknown>;
            probeEncoderRuntime(encoder: string): Promise<boolean>;
            runFFmpeg(args: string[], opts?: unknown): Promise<string>;
        };
        svc.vaapiHdrTonemap = null;
        const accel = vi.spyOn(config, 'GPU_ACCELERATION', 'get').mockReturnValue('vaapi');
        const caps = vi.spyOn(svc, 'getCapabilities').mockResolvedValue({
            encoders: ['h264_vaapi'],
            decoders: [],
            hwaccels: ['vaapi'],
            filters: ['tonemap_vaapi', 'scale_vaapi'],
        });
        const encProbe = vi.spyOn(svc, 'probeEncoderRuntime').mockResolvedValue(true);
        // radeonsi: "VAAPI driver doesn't support HDR"
        const run = vi
            .spyOn(svc, 'runFFmpeg')
            .mockRejectedValue(new Error("VAAPI driver doesn't support HDR"));
        try {
            await expect(hardwareDetection.getBestEncoder('h264')).resolves.toBe('h264_vaapi');
            expect(hardwareDetection.supportsVaapiHdrTonemap()).toBe(false);
            expect(hardwareDetection.getHdrTonemapMode('vaapi')).toBe('software');

            // cached: a second call does not re-probe
            await hardwareDetection.getBestEncoder('h264');
            expect(run).toHaveBeenCalledTimes(1);

            // concurrent first callers share ONE in-flight probe
            svc.vaapiHdrTonemap = null;
            await Promise.all([
                hardwareDetection.getBestEncoder('h264'),
                hardwareDetection.getBestEncoder('h264'),
                hardwareDetection.probeVaapiHdrTonemap(),
            ]);
            expect(run).toHaveBeenCalledTimes(2);
            expect(hardwareDetection.supportsVaapiHdrTonemap()).toBe(false);
        } finally {
            accel.mockRestore();
            caps.mockRestore();
            encProbe.mockRestore();
            run.mockRestore();
            svc.vaapiHdrTonemap = null;
        }
    });
});

describe('GPU decode-capability learning', () => {
    beforeEach(async () => {
        await hardwareDetection.resetDecodeCapabilities();
    });

    it('treats whitelisted codecs as hardware-decodable, others not (qsv + vaapi)', () => {
        for (const backend of ['qsv', 'vaapi'] as const) {
            expect(hardwareDetection.isSourceHardwareDecodable(backend, 'h264')).toBe(true);
            expect(hardwareDetection.isSourceHardwareDecodable(backend, 'HEVC')).toBe(true);
            // MPEG-4 ASP / VC-1 are not in the whitelist (Arc can't hw-decode them)
            expect(hardwareDetection.isSourceHardwareDecodable(backend, 'mpeg4')).toBe(false);
            expect(hardwareDetection.isSourceHardwareDecodable(backend, 'vc1')).toBe(false);
        }
    });

    it('marks qsv/vaapi/nvenc bridgeable, amf not (yet)', () => {
        expect(hardwareDetection.canSoftwareDecodeBridge('qsv')).toBe(true);
        expect(hardwareDetection.canSoftwareDecodeBridge('vaapi')).toBe(true);
        expect(hardwareDetection.canSoftwareDecodeBridge('nvenc')).toBe(true);
        // amf has no verified bridge yet → never diverted, even for mpeg4
        expect(hardwareDetection.canSoftwareDecodeBridge('amf')).toBe(false);
        expect(hardwareDetection.isSourceHardwareDecodable('amf', 'mpeg4')).toBe(true);
    });

    it('NVDEC decodes mpeg4/vc1 (unlike Arc) but not 10-bit H.264', () => {
        // NVENC whitelist is broad — keeps mpeg4/vc1 that Arc dropped
        expect(hardwareDetection.isSourceHardwareDecodable('nvenc', 'mpeg4')).toBe(true);
        expect(hardwareDetection.isSourceHardwareDecodable('nvenc', 'vc1')).toBe(true);
        // 8-bit H.264 zero-copies
        expect(hardwareDetection.isSourceHardwareDecodable('nvenc', 'h264', 8)).toBe(true);
        // 10-bit H.264 (Hi10P) is denied STATICALLY — no learn cycle needed
        expect(hardwareDetection.isSourceHardwareDecodable('nvenc', 'h264', 10)).toBe(false);
    });

    it('statically denies >8-bit H.264 on every bridgeable backend (no silicon decodes Hi10P)', () => {
        for (const backend of ['qsv', 'vaapi', 'nvenc'] as const) {
            expect(hardwareDetection.isSourceHardwareDecodable(backend, 'h264', 10)).toBe(false);
            expect(hardwareDetection.isSourceHardwareDecodable(backend, 'h264', 12)).toBe(false);
            // 8-bit / unknown depth stays hardware-decoded
            expect(hardwareDetection.isSourceHardwareDecodable(backend, 'h264', 8)).toBe(true);
            expect(hardwareDetection.isSourceHardwareDecodable(backend, 'h264')).toBe(true);
        }
        // Non-bridgeable backends are never diverted, even for Hi10P
        expect(hardwareDetection.isSourceHardwareDecodable('amf', 'h264', 10)).toBe(true);
        // 10-bit HEVC is fine everywhere — the static rule is H.264-specific
        expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'hevc', 10)).toBe(true);
        expect(hardwareDetection.isSourceHardwareDecodable('nvenc', 'hevc', 10)).toBe(true);
    });

    it('exposes the static Hi10P denial in the admin snapshot (bridgeable backends only)', () => {
        for (const backend of ['qsv', 'vaapi', 'nvenc'] as const) {
            const snapshot = hardwareDetection.getDecodeCapabilitySnapshot(backend);
            expect(snapshot.staticSoftwareDecoded).toEqual([
                expect.objectContaining({ codec: 'h264', bitDepths: '10/12-bit' }),
            ]);
        }
        // Non-bridgeable backend never diverts → nothing statically denied
        expect(hardwareDetection.getDecodeCapabilitySnapshot('amf').staticSoftwareDecoded).toEqual(
            [],
        );
    });

    it('bit-depth keying: a 10-bit H.264 lesson does not regress 8-bit H.264', () => {
        hardwareDetection.markSourceNotHardwareDecodable('nvenc', 'h264', { bitDepth: 10 });
        // 10-bit now bridges, 8-bit still zero-copies
        expect(hardwareDetection.isSourceHardwareDecodable('nvenc', 'h264', 10)).toBe(false);
        expect(hardwareDetection.isSourceHardwareDecodable('nvenc', 'h264', 8)).toBe(true);
        expect(hardwareDetection.isSourceHardwareDecodable('nvenc', 'h264', undefined)).toBe(true);
        const entry = hardwareDetection
            .getDecodeCapabilitySnapshot('nvenc')
            .learned.find((e) => e.codec === 'h264');
        expect(entry?.bitDepth).toBe(10);
    });

    it('treats unknown/empty codec as not decodable on a bridgeable backend', () => {
        expect(hardwareDetection.isSourceHardwareDecodable('qsv', undefined)).toBe(false);
        expect(hardwareDetection.isSourceHardwareDecodable('qsv', '')).toBe(false);
    });

    it('learns per-backend and flips only that backend (case-insensitive)', () => {
        expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1')).toBe(true);
        hardwareDetection.markSourceNotHardwareDecodable('qsv', 'AV1', { bitDepth: 8 });
        expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1')).toBe(false);
        // VA-API is unaffected by a QSV lesson
        expect(hardwareDetection.isSourceHardwareDecodable('vaapi', 'av1')).toBe(true);
        expect(hardwareDetection.getNonHardwareDecodableCodecs('qsv')).toContain('av1');
    });

    it('reset clears the learned set and restores the whitelist verdict', async () => {
        hardwareDetection.markSourceNotHardwareDecodable('vaapi', 'vp9', { bitDepth: 8 });
        expect(hardwareDetection.isSourceHardwareDecodable('vaapi', 'vp9')).toBe(false);

        const cleared = await hardwareDetection.resetDecodeCapabilities();
        expect(cleared).toBe(1);
        expect(hardwareDetection.getNonHardwareDecodableCodecs()).toEqual([]);
        expect(hardwareDetection.isSourceHardwareDecodable('vaapi', 'vp9')).toBe(true);
    });

    it('reset can target a single backend', async () => {
        hardwareDetection.markSourceNotHardwareDecodable('qsv', 'mpeg4', { bitDepth: 8 });
        hardwareDetection.markSourceNotHardwareDecodable('vaapi', 'vc1', { bitDepth: 8 });

        const cleared = await hardwareDetection.resetDecodeCapabilities('qsv');
        expect(cleared).toBe(1);
        expect(hardwareDetection.getNonHardwareDecodableCodecs('qsv')).toEqual([]);
        // vaapi lesson survives
        expect(hardwareDetection.isSourceHardwareDecodable('vaapi', 'vc1')).toBe(false);
    });

    it('snapshot exposes the whitelist plus learned entries with metadata', () => {
        hardwareDetection.markSourceNotHardwareDecodable('qsv', 'mpeg4', {
            bitDepth: 8,
            sample: 'Obersalzberg - DVD.avi',
        });

        const snap = hardwareDetection.getDecodeCapabilitySnapshot('qsv');
        expect(snap.backend).toBe('qsv');
        expect(snap.bridgeable).toBe(true);
        expect(snap.hardwareDecodableCodecs).toContain('h264');
        expect(snap.learned).toHaveLength(1);
        expect(snap.learned[0].codec).toBe('mpeg4');
        expect(snap.learned[0].sample).toBe('Obersalzberg - DVD.avi');
        // learnedAt is a parseable ISO timestamp
        expect(Number.isNaN(Date.parse(snap.learned[0].learnedAt))).toBe(false);
    });

    it('refuses to learn without a known bit depth (a bare-codec key over-reaches)', () => {
        // The failure is real but un-keyable: writing it would land on the bare
        // "hevc" key and divert every 8-bit HEVC source too. Caller bridges its
        // own job instead (ffmpeg-transcode sets forceSoftwareDecodeBridge).
        const persisted = hardwareDetection.markSourceNotHardwareDecodable('qsv', 'hevc', {
            sample: 'unprobed.mkv',
        });
        expect(persisted).toBe(false);
        expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'hevc', 8)).toBe(true);
        expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'hevc', 10)).toBe(true);
        expect(hardwareDetection.getDecodeCapabilitySnapshot('qsv').learned).toEqual([]);
    });

    it('reports true when a lesson is persisted, including a redundant re-learn', () => {
        expect(
            hardwareDetection.markSourceNotHardwareDecodable('qsv', 'vc1', { bitDepth: 8 }),
        ).toBe(true);
        // Already known and still in effect — nothing written, but the caller's
        // job IS covered by the existing lesson, so this is not a refusal.
        expect(
            hardwareDetection.markSourceNotHardwareDecodable('qsv', 'vc1', { bitDepth: 8 }),
        ).toBe(true);
    });

    it('records the real depth on an 8-bit lesson (bare key, honest scope)', () => {
        hardwareDetection.markSourceNotHardwareDecodable('nvenc', 'hevc', { bitDepth: 8 });
        const entry = hardwareDetection
            .getDecodeCapabilitySnapshot('nvenc')
            .learned.find((e) => e.codec === 'hevc');
        // Depth is preserved even though decodeKey folds 8-bit to "hevc"...
        expect(entry?.bitDepth).toBe(8);
        expect(entry?.scope).toMatch(/8-bit/);
        // ...and the bare key still catches un-probed sources, as the scope says.
        expect(hardwareDetection.isSourceHardwareDecodable('nvenc', 'hevc', 8)).toBe(false);
        expect(hardwareDetection.isSourceHardwareDecodable('nvenc', 'hevc')).toBe(false);
        // A higher depth is keyed separately and stays hardware-decoded.
        expect(hardwareDetection.isSourceHardwareDecodable('nvenc', 'hevc', 10)).toBe(true);
    });

    it('snapshot explains each lesson: scope, reason and expiry', () => {
        hardwareDetection.markSourceNotHardwareDecodable('nvenc', 'hevc', { bitDepth: 10 });
        const entry = hardwareDetection.getDecodeCapabilitySnapshot('nvenc').learned[0];
        expect(entry.scope).toContain('10-bit');
        expect(entry.scope).toMatch(/8-bit HEVC still hardware-decodes/i);
        expect(entry.reason).toMatch(/decode-surface mismatch/i);
        // Expiry is learnedAt + the 30-day TTL.
        expect(Date.parse(entry.expiresAt) - Date.parse(entry.learnedAt)).toBe(
            30 * 24 * 60 * 60 * 1000,
        );
    });

    it('snapshot for a non-bridgeable backend reports not bridgeable, no whitelist', () => {
        const snap = hardwareDetection.getDecodeCapabilitySnapshot('amf');
        expect(snap.bridgeable).toBe(false);
        expect(snap.hardwareDecodableCodecs).toEqual([]);
        expect(snap.learned).toEqual([]);
    });
});

describe('GPU decode-capability learning — TTL / self-heal', () => {
    // A learned lesson can never be contradicted by observation (a denied codec is
    // always bridged, so hardware decode is never re-attempted). Expiry is the only
    // self-heal: a false positive evaporates after the TTL; a genuine gap re-learns.
    beforeEach(async () => {
        vi.useFakeTimers();
        await hardwareDetection.resetDecodeCapabilities();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('expires a lesson after the TTL — codec becomes decodable and drops from views', () => {
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        hardwareDetection.markSourceNotHardwareDecodable('qsv', 'av1', { bitDepth: 10 });
        expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1', 10)).toBe(false);

        // 31 days later — past the 30-day TTL.
        vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
        expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1', 10)).toBe(true);
        // Hidden from the admin snapshot and the compact summary once expired.
        expect(hardwareDetection.getDecodeCapabilitySnapshot('qsv').learned).toEqual([]);
        expect(hardwareDetection.getNonHardwareDecodableCodecs('qsv')).toEqual([]);
    });

    it('still enforces a lesson within the TTL window', () => {
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        hardwareDetection.markSourceNotHardwareDecodable('vaapi', 'vp9', { bitDepth: 8 });

        vi.setSystemTime(new Date('2026-01-20T00:00:00Z')); // 19 days < 30
        expect(hardwareDetection.isSourceHardwareDecodable('vaapi', 'vp9')).toBe(false);
        expect(hardwareDetection.getDecodeCapabilitySnapshot('vaapi').learned).toHaveLength(1);
    });

    it('re-confirming a genuine gap after expiry refreshes the lesson (window restarts)', () => {
        // 10-bit H.264 is now statically denied, so use a learned-only example:
        // an early-gen NVDEC that can't hardware-decode 10-bit HEVC.
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        hardwareDetection.markSourceNotHardwareDecodable('nvenc', 'hevc', { bitDepth: 10 });

        vi.setSystemTime(new Date('2026-02-01T00:00:00Z')); // expired
        expect(hardwareDetection.isSourceHardwareDecodable('nvenc', 'hevc', 10)).toBe(true);

        // The genuine gap fails again → re-learned with a fresh stamp.
        hardwareDetection.markSourceNotHardwareDecodable('nvenc', 'hevc', { bitDepth: 10 });
        expect(hardwareDetection.isSourceHardwareDecodable('nvenc', 'hevc', 10)).toBe(false);
        const entry = hardwareDetection
            .getDecodeCapabilitySnapshot('nvenc')
            .learned.find((e) => e.codec === 'hevc');
        expect(entry?.learnedAt).toBe('2026-02-01T00:00:00.000Z');
    });

    // A lesson is INFERRED from an FFmpeg failure, so one of our own argument bugs
    // can teach a false one — and nothing re-verifies a denied codec, so it outlives
    // the fix. This really happened: a `-color_range` bug made a decodable AV1 source
    // emit the surface-mismatch signature, and the lesson kept forcing the software
    // bridge for days after that bug was fixed. Validity is therefore tied to the
    // build, so shipping a fix retires the lessons it invalidates.
    it('ignores a lesson recorded by a different build', () => {
        hardwareDetection.markSourceNotHardwareDecodable('qsv', 'av1', { bitDepth: 10 });
        expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1', 10)).toBe(false);

        const learned = hardwareDetection.getDecodeCapabilitySnapshot('qsv').learned;
        expect(learned.find((e) => e.codec === 'av1')?.learnedBy).toBe(config.buildInfo.version);

        // Now the deploy: same lesson on disk, different build running.
        const original = config.buildInfo.version;
        try {
            config.buildInfo.version = 'a-newer-build-that-fixed-the-bug';
            expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1', 10)).toBe(true);
        } finally {
            config.buildInfo.version = original;
        }
    });

    // `Dockerfile` defaults `ARG APP_VERSION=dev`, so every self-built image — i.e.
    // most self-hosters, who don't pull the published one — stamps every build `dev`.
    // `dev === dev` would keep a FALSE lesson enforced for its full 30 days across
    // every upgrade, silently reproducing the exact failure this mechanism prevents.
    // An identity that can't distinguish two builds must therefore expire at once.
    // An indistinct stamp must NOT disarm the lesson in-process. It once did, and
    // the consequence was severe: markSourceNotHardwareDecodable still reported
    // success, so the ladder skipped forceSoftwareDecodeBridge, respawned the SAME
    // unbridged args, and then refused further rescue because gpuBridgeRetried was
    // set — turning a codec that recovered after one transparent retry into a
    // permanent playback failure, on exactly the self-built images that carry the
    // Dockerfile's default `dev` stamp.
    it.each(['dev', 'unknown'])(
        'still enforces a lesson in-process on an indistinct build (%s)',
        (indistinct) => {
            const original = config.buildInfo.version;
            try {
                config.buildInfo.version = indistinct;
                hardwareDetection.markSourceNotHardwareDecodable('qsv', 'av1', { bitDepth: 10 });

                expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1', 10)).toBe(false);
            } finally {
                config.buildInfo.version = original;
            }
        },
    );

    // ...but it must not SURVIVE a restart, because nothing could ever retire it:
    // the stamp matches forever, so a false lesson would pin across every upgrade.
    // Rejecting on hydrate is what makes "relearn per restart" true.
    it('does not hydrate a lesson carrying an indistinct build stamp', async () => {
        const { cacheGet } = await import('../../cache/valkey.js');
        const original = config.buildInfo.version;
        try {
            config.buildInfo.version = 'dev';
            vi.mocked(cacheGet).mockResolvedValueOnce(
                JSON.stringify({
                    qsv: [
                        {
                            codec: 'av1',
                            bitDepth: 10,
                            learnedAt: new Date().toISOString(),
                            learnedBy: 'dev',
                        },
                    ],
                }),
            );
            await hardwareDetection.resetDecodeCapabilities();
            (hardwareDetection as unknown as { gpuDenyHydrated: boolean }).gpuDenyHydrated = false;
            await (
                hardwareDetection as unknown as { hydrateGpuDecodeDenyList(): Promise<void> }
            ).hydrateGpuDecodeDenyList();

            expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1', 10)).toBe(true);
        } finally {
            config.buildInfo.version = original;
        }
    });

    // Validity is keyed on `learnedBy`, so the field MUST survive the Valkey round
    // trip. It originally did not — hydrate rebuilt entries without it, which made
    // every persisted lesson read as "another build's" and therefore permanently
    // expired. That turned the whole cache into dead weight silently: a real silicon
    // gap would re-learn on every process restart (one failed playback each time),
    // and the admin panel would show no lessons while Valkey still held them.
    // The in-memory tests above all passed throughout — only a round trip catches it.
    it('keeps a lesson enforced across a persist → hydrate round trip', async () => {
        const { cacheGet, cacheSet } = await import('../../cache/valkey.js');

        hardwareDetection.markSourceNotHardwareDecodable('qsv', 'av1', {
            bitDepth: 10,
            sample: 'x.mkv',
        });
        const persisted = vi.mocked(cacheSet).mock.calls.at(-1)?.[1] as string;
        expect(persisted).toContain('learnedBy');

        // Fresh process: same build, lesson replayed out of Valkey.
        vi.mocked(cacheGet).mockResolvedValueOnce(persisted);
        await hardwareDetection.resetDecodeCapabilities();
        (hardwareDetection as unknown as { gpuDenyHydrated: boolean }).gpuDenyHydrated = false;
        await (
            hardwareDetection as unknown as { hydrateGpuDecodeDenyList(): Promise<void> }
        ).hydrateGpuDecodeDenyList();

        expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1', 10)).toBe(false);
        expect(
            hardwareDetection
                .getDecodeCapabilitySnapshot('qsv')
                .learned.find((e) => e.codec === 'av1')?.learnedBy,
        ).toBe(config.buildInfo.version);
    });
});

// A reset lands on exactly ONE replica (it is an admin HTTP request), and the
// deny-map is hydrate-once + write-whole-map. Without cross-replica sync the
// operator's only escape hatch from a false lesson appears to work while every
// other replica keeps enforcing it — and whole-map writes silently erase each
// other's entries. See cache/decode-deny-bus.ts.
describe('GPU decode-capability learning — cross-replica sync', () => {
    beforeEach(async () => {
        await hardwareDetection.resetDecodeCapabilities();
    });

    it('publishes a learn so peers do not each have to fail a playback to discover it', async () => {
        const { publishDecodeDenySync } = await import('../../cache/decode-deny-bus.js');

        hardwareDetection.markSourceNotHardwareDecodable('qsv', 'av1', {
            bitDepth: 10,
            sample: 'x.mkv',
        });

        expect(vi.mocked(publishDecodeDenySync)).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'learn',
                backend: 'qsv',
                entry: expect.objectContaining({ codec: 'av1', bitDepth: 10 }),
            }),
        );
    });

    it('publishes a reset — the case that makes the admin button work cluster-wide', async () => {
        const { publishDecodeDenySync } = await import('../../cache/decode-deny-bus.js');
        vi.mocked(publishDecodeDenySync).mockClear();

        await hardwareDetection.resetDecodeCapabilities();

        expect(vi.mocked(publishDecodeDenySync)).toHaveBeenCalledWith({
            kind: 'reset',
            backend: undefined,
        });
    });

    it('enforces a peer lesson, preserving its origin build rather than restamping it', () => {
        hardwareDetection.applyRemoteDecodeDenyLearn('qsv', 'av1@10bit', {
            codec: 'av1',
            bitDepth: 10,
            learnedAt: new Date().toISOString(),
            learnedBy: config.buildInfo.version,
            sample: 'peer.mkv',
        });

        expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1', 10)).toBe(false);
        expect(
            hardwareDetection
                .getDecodeCapabilitySnapshot('qsv')
                .learned.find((e) => e.codec === 'av1')?.sample,
        ).toBe('peer.mkv');
    });

    // A peer's lesson from a DIFFERENT build must stay retired locally — restamping
    // it with the receiver's build would resurrect exactly the stale lessons the
    // build stamp exists to expire.
    it('does not resurrect a peer lesson recorded by another build', () => {
        hardwareDetection.applyRemoteDecodeDenyLearn('qsv', 'av1@10bit', {
            codec: 'av1',
            bitDepth: 10,
            learnedAt: new Date().toISOString(),
            learnedBy: 'some-other-build',
        });

        expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1', 10)).toBe(true);
    });

    it('applies a peer reset locally', () => {
        hardwareDetection.markSourceNotHardwareDecodable('qsv', 'av1', { bitDepth: 10 });
        expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1', 10)).toBe(false);

        hardwareDetection.applyRemoteDecodeDenyReset();

        expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1', 10)).toBe(true);
    });

    // Echoing a remote event back onto the bus would loop it and let two replicas
    // take turns rewriting the same Valkey blob.
    it('never re-publishes an event it received', async () => {
        const { publishDecodeDenySync } = await import('../../cache/decode-deny-bus.js');
        vi.mocked(publishDecodeDenySync).mockClear();

        hardwareDetection.applyRemoteDecodeDenyLearn('qsv', 'av1@10bit', {
            codec: 'av1',
            bitDepth: 10,
            learnedAt: new Date().toISOString(),
            learnedBy: config.buildInfo.version,
        });
        hardwareDetection.applyRemoteDecodeDenyReset();

        expect(vi.mocked(publishDecodeDenySync)).not.toHaveBeenCalled();
    });
});

// THE contract the transcode ladder depends on, stated directly.
//
// ffmpeg-transcode.service.ts does:
//     const persisted = markSourceNotHardwareDecodable(...);
//     if (!persisted) job.config.forceSoftwareDecodeBridge = true;
//     job.gpuBridgeRetried = true;
// i.e. a `true` return is a PROMISE that the deny-map will now divert this source,
// so the caller does not need to force the bridge itself. If that promise is
// broken, the respawn rebuilds the same unbridged args, fails identically, and
// `gpuBridgeRetried` then blocks any further rescue — a permanent playback
// failure where the codec used to recover after one transparent retry.
//
// That is exactly what a read-time build-stamp rejection did. Asserting the
// coupling directly catches the whole class, not just that one instance.
describe('learn → enforcement coupling (what the transcode ladder relies on)', () => {
    beforeEach(async () => {
        await hardwareDetection.resetDecodeCapabilities();
    });

    const CASES = [
        ['a normal release build', 'v1.2.3-4-gabc1234'],
        // Dockerfile's default, so every self-built image.
        ['a self-built image', 'dev'],
        ['no build identity at all', 'unknown'],
    ] as const;

    it.each(CASES)('a persisted lesson really diverts the source (%s)', (_label, version) => {
        const original = config.buildInfo.version;
        try {
            config.buildInfo.version = version;

            const persisted = hardwareDetection.markSourceNotHardwareDecodable('qsv', 'av1', {
                bitDepth: 10,
            });

            // Reporting success while leaving the source hardware-decodable is the
            // broken promise: the caller would skip forceSoftwareDecodeBridge.
            if (persisted) {
                expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1', 10)).toBe(false);
            }
        } finally {
            config.buildInfo.version = original;
        }
    });

    // The other half: when the lesson CANNOT be scoped we must return false, so the
    // caller rescues its own job instead of trusting a diversion that never happens.
    it('returns false when the depth is unknown, so the caller forces the bridge itself', () => {
        const persisted = hardwareDetection.markSourceNotHardwareDecodable('qsv', 'av1', {});

        expect(persisted).toBe(false);
        expect(hardwareDetection.isSourceHardwareDecodable('qsv', 'av1')).toBe(true);
    });
});
