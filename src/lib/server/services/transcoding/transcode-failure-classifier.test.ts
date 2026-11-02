// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    classifyTranscodeFailure,
    formatTranscodeFailureMessage,
    isGpuEncoderSessionFailure,
    isLearnableGpuDecodeFailure,
    GPU_SURFACE_MISMATCH_RE,
    GPU_RESOURCE_EXHAUSTION_RE,
} from './transcode-failure-classifier.js';

describe('classifyTranscodeFailure', () => {
    // Regression: ten of the fifteen rows on the prod transcode-failures page were
    // ordinary teardown filed as failures, and the two most alarming labels on that
    // page ('gpu-init' — "verify the GPU is passed through") were on rows where the
    // GPU was never involved.
    describe('output-side write failures (teardown, not a fault)', () => {
        const REAPED_SEGMENT = [
            "[hls @ 0x7147] Failed to open file '/tmp/stellar-transcode/abc/gen-0001/segment_00155.m4s.tmp'",
            '[aost#0:1/aac @ 0x7147] Error submitting a packet to the muxer: No such file or directory',
            '[out#0/hls @ 0x7147] Task finished with error code: -2 (No such file or directory)',
        ].join('\n');

        it('classifies a reaped segment write as output-unavailable, not missing-input', () => {
            const f = classifyTranscodeFailure(REAPED_SEGMENT, 254);
            expect(f.category).toBe('output-unavailable');
            expect(f.hint).toMatch(/working directory was removed/);
        });

        it('wins over gpu-init even when the benign VA-API banner is present', () => {
            // The banner is printed on EVERY hardware job, success or not, and
            // 'Failed to open file' satisfies GPU_FAIL_RE — which is exactly how a
            // deleted directory came to be reported as a GPU init failure.
            const stderr = [
                'libva info: VA-API version 1.22.0',
                'libva info: Trying to open /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so',
                'libva info: va_openDriver() returns 0',
                REAPED_SEGMENT,
            ].join('\n');
            expect(classifyTranscodeFailure(stderr, 254).category).toBe('output-unavailable');
        });

        it('classifies a failed segment rename as output-unavailable', () => {
            const stderr =
                '[hls @ 0x71] failed to rename file /tmp/stellar-transcode/abc/gen-0001/index.m3u8.tmp to /tmp/stellar-transcode/abc/gen-0001/index.m3u8: No such file or directory';
            expect(classifyTranscodeFailure(stderr, 255).category).toBe('output-unavailable');
        });

        it('leaves a genuine missing SOURCE file as missing-input', () => {
            const stderr = '/data/movies/Gone (2020)/Gone.mkv: No such file or directory';
            expect(classifyTranscodeFailure(stderr, 1).category).toBe('missing-input');
        });

        it('leaves a genuine encoder-init failure as gpu-init', () => {
            // The prod AV1/DV10 signature — an output path is never named, so the
            // new rule must not swallow it.
            const stderr = [
                'libva info: VA-API version 1.22.0',
                '[hevc_qsv @ 0x707] Current profile is unsupported',
                '[vost#0:0/hevc_qsv @ 0x707] Could not open encoder before EOF',
                '[vost#0:0/hevc_qsv @ 0x707] Task finished with error code: -22 (Invalid argument)',
            ].join('\n');
            expect(classifyTranscodeFailure(stderr, 218).category).toBe('gpu-init');
        });
    });

    it('classifies NVENC init failure as gpu-init with a hint', () => {
        const stderr = [
            '[h264_nvenc @ 0x55] Cannot load nvcuda.dll',
            '[h264_nvenc @ 0x55] Failed to initialize NVENC',
            'Error initializing output stream 0:0',
        ].join('\n');
        const f = classifyTranscodeFailure(stderr, 1);
        expect(f.category).toBe('gpu-init');
        expect(f.hint).toMatch(/GPU_ACCELERATION=none/);
        expect(formatTranscodeFailureMessage(f)).toContain(f.summary);
        expect(formatTranscodeFailureMessage(f)).toContain('—');
    });

    it('classifies "No capable devices" NVENC error as gpu-init', () => {
        const f = classifyTranscodeFailure('[h264_nvenc @ 0x1] No NVENC capable devices found', 1);
        expect(f.category).toBe('gpu-init');
    });

    it('classifies a VAAPI open failure as gpu-init', () => {
        const f = classifyTranscodeFailure(
            'Failed to open the VAAPI device: /dev/dri/renderD128',
            1,
        );
        expect(f.category).toBe('gpu-init');
    });

    it('classifies an unknown encoder as codec-unsupported', () => {
        const f = classifyTranscodeFailure('Unknown encoder libsvtav1', 1);
        expect(f.category).toBe('codec-unsupported');
        expect(f.hint).toMatch(/codec/i);
    });

    it('classifies a missing source file as missing-input', () => {
        const f = classifyTranscodeFailure('/media/x.mkv: No such file or directory', 1);
        expect(f.category).toBe('missing-input');
    });

    it('classifies permission denied', () => {
        const f = classifyTranscodeFailure('/transcode/seg0.ts: Permission denied', 1);
        expect(f.category).toBe('permission');
    });

    it('classifies out-of-memory', () => {
        const f = classifyTranscodeFailure('Cannot allocate memory', 1);
        expect(f.category).toBe('out-of-memory');
    });

    it('returns unknown with no hint when nothing matches', () => {
        const f = classifyTranscodeFailure('some unremarkable line', 1);
        expect(f.category).toBe('unknown');
        expect(f.hint).toBeUndefined();
        // Still produces a summary-only message.
        expect(formatTranscodeFailureMessage(f)).toBe(f.summary);
    });

    it('prefers gpu-init over invalid-argument when a GPU token is present', () => {
        // GPU encoders often emit "Invalid argument" as a symptom of a deeper
        // hwaccel problem — the gpu-init category is the actionable one.
        const f = classifyTranscodeFailure(
            '[hevc_qsv @ 0x9] Error initializing the MFX video session\nInvalid argument',
            1,
        );
        expect(f.category).toBe('gpu-init');
    });

    it('classifies an AMD AMF encoder failure as gpu-init', () => {
        const f = classifyTranscodeFailure('[h264_amf @ 0x3] Failed to initialise AMF context', 1);
        expect(f.category).toBe('gpu-init');
    });

    it('does not over-match the bare "amf" substring in plain text', () => {
        // "amf" embedded mid-word plus a generic "failed" must NOT be gpu-init.
        const f = classifyTranscodeFailure('streamframe decode failed', 1);
        expect(f.category).not.toBe('gpu-init');
    });

    it('falls back to the spawn-error message when stderr is empty', () => {
        const f = classifyTranscodeFailure('', null, 'spawn ffmpeg ENOENT');
        expect(f.summary).toContain('spawn ffmpeg ENOENT');
        expect(f.category).toBe('unknown');
    });
});

describe('isLearnableGpuDecodeFailure (GPU decode-capability learn gate)', () => {
    // A genuine per-codec hardware-decode gap: the source silently fell back to
    // software decode and the system frames could not be reconciled with the
    // GPU-only scaler. The definitive line is "Impossible to convert…"; the
    // trailing "Could not open encoder" is just the terminal symptom.
    const GENUINE_QSV_DECODE_GAP = [
        '[Parsed_scale_qsv_1 @ 0x556] Error while filtering: Function not implemented',
        "Impossible to convert between the formats supported by the filter 'graph 0 input' and the filter 'auto_scale_0'",
        'Error reinitializing filters!',
        'Failed to inject frame into filter network: Function not implemented',
        '[hevc_qsv @ 0x778] Could not open encoder before EOF',
        'Conversion failed!',
    ].join('\n');

    // Same terminal cascade, but a transient MFX *session* creation failure caused
    // the software fallback — silicon capability is NOT proven.
    const TRANSIENT_MFX_SESSION = [
        '[hevc_qsv @ 0x1] Error creating a MFX session: -9 (device busy).',
        "Impossible to convert between the formats supported by the filter 'graph 0 input' and the filter 'auto_scale_0'",
        '[hevc_qsv @ 0x1] Could not open encoder before EOF',
        'Conversion failed!',
    ].join('\n');

    // Busy small-VRAM Arc: encode session / device memory exhausted. The terminal
    // "Could not open encoder" appears with NO surface-mismatch line at all.
    const TRANSIENT_BUSY_GPU = [
        '[hevc_qsv @ 0x1] Cannot allocate memory',
        '[hevc_qsv @ 0x1] Could not open encoder before EOF',
        'Conversion failed!',
    ].join('\n');

    // NVDEC 10-bit H.264 genuine gap (Ampere has no 10-bit H.264 decode) — the
    // CUDA filter graph hits the same surface mismatch, no resource token.
    const GENUINE_NVDEC_10BIT = [
        '[Parsed_scale_cuda_0 @ 0x9] Error while filtering: Function not implemented',
        "Impossible to convert between the formats supported by the filter 'graph 0 input' and the filter 'auto_scale_0'",
        '[hevc_nvenc @ 0x9] Could not open encoder before EOF',
    ].join('\n');

    it('learns a genuine QSV per-codec decode gap', () => {
        expect(isLearnableGpuDecodeFailure(GENUINE_QSV_DECODE_GAP)).toBe(true);
    });

    it('learns a genuine NVDEC 10-bit H.264 gap', () => {
        expect(isLearnableGpuDecodeFailure(GENUINE_NVDEC_10BIT)).toBe(true);
    });

    it('does NOT learn when a transient MFX session error caused the fallback', () => {
        // The surface-mismatch line is present, but the session error proves the
        // failure is transient — learning it would poison a decodable codec.
        expect(GPU_SURFACE_MISMATCH_RE.test(TRANSIENT_MFX_SESSION)).toBe(true);
        expect(GPU_RESOURCE_EXHAUSTION_RE.test(TRANSIENT_MFX_SESSION)).toBe(true);
        expect(isLearnableGpuDecodeFailure(TRANSIENT_MFX_SESSION)).toBe(false);
    });

    it('does NOT learn a busy/OOM GPU failure with no surface-mismatch line', () => {
        expect(GPU_SURFACE_MISMATCH_RE.test(TRANSIENT_BUSY_GPU)).toBe(false);
        expect(isLearnableGpuDecodeFailure(TRANSIENT_BUSY_GPU)).toBe(false);
    });

    it('does NOT learn a bare "Could not open encoder" (ambiguous busy-GPU error)', () => {
        expect(isLearnableGpuDecodeFailure('[hevc_qsv @ 0x1] Could not open encoder')).toBe(false);
    });

    it('does NOT learn various transient resource/session signatures', () => {
        for (const s of [
            'Failed to initialise VAAPI connection: -1 (unknown libva error)',
            'Failed to create session: not enough resources',
            'Failed to allocate surface',
            'resource temporarily unavailable',
            'no free surfaces in the pool',
            'out of memory',
        ]) {
            expect(GPU_RESOURCE_EXHAUSTION_RE.test(s)).toBe(true);
        }
    });
});

describe('isGpuEncoderSessionFailure (NVENC → software fallback gate)', () => {
    it.each([
        '[hevc_nvenc @ 0x1] OpenEncodeSessionEx failed: out of memory (10): (no details)',
        '[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: incompatible client key (21): (no details)',
        '[hevc_nvenc @ 0x1] No capable devices found',
        '[h264_nvenc @ 0x1] No NVENC capable devices found',
        '[h264_nvenc @ 0x1] dl_fn->cuda_dl->cuInit(0) failed -> CUDA_ERROR_NO_DEVICE: no CUDA-capable device is detected',
        '[h264_nvenc @ 0x1] Cannot load libnvidia-encode.so.1',
        '[hevc_nvenc @ 0x1] dl_fn->cuda_dl->cuCtxCreate(...) failed -> CUDA_ERROR_OUT_OF_MEMORY: out of memory',
        '[hevc_nvenc @ 0x1] The minimum required Nvidia driver for nvenc is 570.0 or newer',
    ])('matches %s', (line) => {
        expect(isGpuEncoderSessionFailure('hevc_nvenc', line)).toBe(true);
    });

    it('does not match a CUDA error from the decoder or a CUDA filter', () => {
        for (const line of [
            '[hevc_cuvid @ 0x1] ctx->cvdl->cuvidCreateDecoder(...) failed -> CUDA_ERROR_OUT_OF_MEMORY: out of memory',
            '[scale_cuda @ 0x1] cu->cuInit(0) failed -> CUDA_ERROR_NO_DEVICE',
        ]) {
            expect(isGpuEncoderSessionFailure('hevc_nvenc', line)).toBe(false);
        }
    });

    it('does not match a failure that is about the media, not the encoder', () => {
        expect(
            isGpuEncoderSessionFailure(
                'hevc_nvenc',
                '[matroska,webm @ 0x1] Invalid data found when processing input',
            ),
        ).toBe(false);
    });

    it('applies only to NVENC jobs', () => {
        const line = 'OpenEncodeSessionEx failed: out of memory (10)';
        expect(isGpuEncoderSessionFailure('hevc_qsv', line)).toBe(false);
        expect(isGpuEncoderSessionFailure(undefined, line)).toBe(false);
    });
});
