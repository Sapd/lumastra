// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hardware acceleration plan for a rendition encode.
 *
 * ## The shape of the compromise
 *
 * A rendition is encoded once and then played offline on whatever device pulled
 * it, forever. That makes correctness worth more than speed here than anywhere
 * else in the pipeline — a wrong file is not a stutter, it is a user's whole
 * download. So this uses the GPU for the one stage that dominates the cost and
 * leaves everything else alone:
 *
 *   decode   → CPU
 *   filters  → CPU (tone map + scale)
 *   encode   → GPU
 *
 * ## Why NOT hardware decode — measured, not assumed
 *
 * The first version of this added `-hwaccel qsv` on the theory that omitting
 * `-hwaccel_output_format` would hand the filters ordinary system-memory frames.
 * That is false for this ffmpeg build. Measured on prod (jellyfin-ffmpeg,
 * iHD/VA-API 1.22, a 1080p Blu-ray remux), `-hwaccel qsv` alone still produced
 * hardware frames, the software `scale` could not ingest them, and ffmpeg's
 * inserted auto_scale failed:
 *
 *   Impossible to convert between the formats supported by the filter
 *   'graph -1 input from stream 0:0' and the filter 'auto_scale_0'
 *   [vost#0:0/h264_qsv] Could not open encoder before EOF → error code -22
 *
 * which is the same auto_scale/-22 signature as the `-color_range` HDR incident.
 * Decoding in software makes the filter chain byte-for-byte the pure-CPU one, so
 * `tonemapx` and `scale` cannot behave differently just because a GPU is
 * present, and the encoder receives plain 8-bit frames it uploads itself.
 *
 * The same run with software decode produced a correct artifact: h264 High,
 * yuv420p, 1334x720, AAC-LC stereo, ~2.6 Mbps against a 2.5 Mbps target.
 *
 * Adding hardware decode later is a real optimisation for 4K sources, but it
 * needs an explicit `hwdownload,format=<sw fmt>` head on the filter chain and
 * its own verification against HDR input — not a flag flip.
 *
 * ## No learned deny-map, on purpose
 *
 * A GPU attempt that fails falls back to software for THAT encode and nothing is
 * remembered. The persistent decode deny-map previously taught itself
 * "av1@10bit is undecodable" from a bug in our own args, then kept enforcing that
 * lesson for 30 days after the bug was fixed — across pods, with no way to
 * invalidate it. A stateless retry cannot outlive its cause.
 */

import { config } from '$lib/server/config.js';
import { hardwareDetection } from '$lib/server/services/transcoding/hardware-detection.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('DownloadRenditionHw');

export interface RenditionHwPlan {
    /** Encoder name, e.g. `h264_qsv`. Always an H.264 encoder — see below. */
    encoder: string;
    /** Args that must precede `-i` (device selection). */
    initArgs: string[];
    /**
     * VA-API only: its encoder takes an opaque surface rather than system
     * memory, so the filter chain has to end with `format=nv12,hwupload`.
     */
    needsHwUpload: boolean;
    /** `-preset` value the encoder actually understands, or null to omit. */
    preset: string | null;
    /**
     * `-pix_fmt` this encoder actually wants, or null when the filter chain
     * already fixes the format (VA-API's hwupload).
     *
     * Explicit rather than left to ffmpeg: QSV logs
     * `Incompatible pixel format 'yuv420p' for codec 'h264_qsv', auto-selecting
     * format 'nv12'` and silently inserts a converter. It works, but implicit
     * format negotiation around a hardware encoder is precisely how the
     * auto_scale/-22 failures in this codebase began, so we state the format we
     * mean instead of discovering what ffmpeg picked.
     */
    pixFmt: string | null;
}

/**
 * H.264 encoder per acceleration backend.
 *
 * H.264 specifically, never HEVC/AV1: the artifact has to decode on any device
 * that downloaded it, with no server left to fall back to. Hardware H.264
 * encoders are all 8-bit, which is exactly what we want anyway.
 */
const ENCODER_BY_ACCEL: Record<
    string,
    { encoder: string; preset: string | null; pixFmt: string | null }
> = {
    // QSV takes nv12; yuv420p makes it auto-select and insert a converter.
    qsv: { encoder: 'h264_qsv', preset: 'veryfast', pixFmt: 'nv12' },
    // NVENC's named presets moved to p1..p7; the old aliases are deprecated and
    // warn. Omitting it takes the encoder default rather than risking a version
    // split between jellyfin-ffmpeg builds.
    nvenc: { encoder: 'h264_nvenc', preset: null, pixFmt: 'yuv420p' },
    // VA-API's format is set by the hwupload at the tail of the filter chain.
    vaapi: { encoder: 'h264_vaapi', preset: null, pixFmt: null },
    amf: { encoder: 'h264_amf', preset: null, pixFmt: 'yuv420p' },
    videotoolbox: { encoder: 'h264_videotoolbox', preset: null, pixFmt: 'yuv420p' },
};

/**
 * Resolve the plan, or null to encode entirely in software.
 *
 * Returns null when the operator disabled it, when `GPU_ACCELERATION` is `none`,
 * or when ffmpeg does not actually list the encoder — the last check matters
 * because `GPU_ACCELERATION` records intent, not the capability of the ffmpeg
 * binary that happens to be installed (prod fetches its own build at runtime).
 */
export async function resolveRenditionHwPlan(): Promise<RenditionHwPlan | null> {
    if (!config.DOWNLOAD_RENDITION_HWACCEL) return null;

    const accel = config.GPU_ACCELERATION;
    if (accel === 'none') return null;

    const entry = ENCODER_BY_ACCEL[accel];
    if (!entry) return null;

    if (!(await hardwareDetection.supportsEncoder(entry.encoder))) {
        logger.info('GPU encoder not available in this ffmpeg build — using software', {
            accel,
            encoder: entry.encoder,
        });
        return null;
    }

    const initArgs: string[] = [];
    if (accel === 'vaapi') {
        const device = config.VAAPI_DEVICE;
        if (device) initArgs.push('-vaapi_device', device);
    } else if (accel === 'qsv') {
        const device = config.QSV_DEVICE;
        if (device) initArgs.push('-qsv_device', device);
    }

    return {
        encoder: entry.encoder,
        initArgs,
        needsHwUpload: accel === 'vaapi',
        preset: entry.preset,
        pixFmt: entry.pixFmt,
    };
}
