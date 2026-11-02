// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure display formatting for the transcode-failures admin page: turns the
 * classifier's raw category id (`transcode_failure_events.category`) and the
 * raw FFmpeg encoder id (`transcode_failure_events.encoder`) into an
 * operator-facing label — plus, for categories, a one-line hint on what the
 * failure usually means and what to check.
 *
 * This is client code, so it never imports the classifier itself
 * (`$lib/server/services/transcoding/transcode-failure-classifier.ts` is
 * server-only). The category list below must be kept in sync BY HAND with
 * `TranscodeFailureCategory` there. A category or encoder id this module
 * doesn't recognise (a future classifier category, or an exotic encoder)
 * still renders — as a humanized version of the raw id — rather than
 * throwing or showing nothing.
 */

import * as m from '$lib/paraglide/messages.js';

export interface CategoryDisplay {
    /** Operator-facing label, e.g. "Source file missing". */
    label: string;
    /** One-line "what this usually means / what to check", or null when unknown. */
    hint: string | null;
}

const CATEGORY_DISPLAY: Record<string, () => CategoryDisplay> = {
    'output-unavailable': () => ({
        label: m.admin_transcode_failures_category_output_unavailable_label(),
        hint: m.admin_transcode_failures_category_output_unavailable_hint(),
    }),
    'gpu-init': () => ({
        label: m.admin_transcode_failures_category_gpu_init_label(),
        hint: m.admin_transcode_failures_category_gpu_init_hint(),
    }),
    'codec-unsupported': () => ({
        label: m.admin_transcode_failures_category_codec_unsupported_label(),
        hint: m.admin_transcode_failures_category_codec_unsupported_hint(),
    }),
    'missing-input': () => ({
        label: m.admin_transcode_failures_category_missing_input_label(),
        hint: m.admin_transcode_failures_category_missing_input_hint(),
    }),
    permission: () => ({
        label: m.admin_transcode_failures_category_permission_label(),
        hint: m.admin_transcode_failures_category_permission_hint(),
    }),
    'out-of-memory': () => ({
        label: m.admin_transcode_failures_category_out_of_memory_label(),
        hint: m.admin_transcode_failures_category_out_of_memory_hint(),
    }),
    'invalid-argument': () => ({
        label: m.admin_transcode_failures_category_invalid_argument_label(),
        hint: m.admin_transcode_failures_category_invalid_argument_hint(),
    }),
    unknown: () => ({
        label: m.admin_transcode_failures_category_unknown_label(),
        hint: null,
    }),
};

/** "gpu-failure" / "some_weird_id" → "Gpu failure" / "Some weird id". */
function humanizeUnknownId(id: string): string {
    const words = id.replace(/[-_]+/g, ' ').trim();
    if (!words) return id;
    return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/**
 * Maps a raw failure category id to a label + hint. A category not in the
 * map above (e.g. a future classifier category) falls back to a humanized
 * version of the raw id with no hint — never throws, never shows nothing.
 */
export function formatFailureCategory(category: string): CategoryDisplay {
    const known = CATEGORY_DISPLAY[category];
    if (known) return known();
    return { label: humanizeUnknownId(category), hint: null };
}

export interface EncoderDisplay {
    /** Operator-facing label, e.g. "Intel QSV (H.264)". */
    label: string;
}

const VENDOR_LABEL: Record<string, () => string> = {
    qsv: () => m.admin_transcode_failures_vendor_qsv(),
    nvenc: () => m.admin_transcode_failures_vendor_nvenc(),
    amf: () => m.admin_transcode_failures_vendor_amf(),
    vaapi: () => m.admin_transcode_failures_vendor_vaapi(),
    videotoolbox: () => m.admin_transcode_failures_vendor_videotoolbox(),
};

const CODEC_LABEL: Record<string, () => string> = {
    h264: () => m.admin_transcode_failures_codec_h264(),
    hevc: () => m.admin_transcode_failures_codec_hevc(),
    av1: () => m.admin_transcode_failures_codec_av1(),
    vp9: () => m.admin_transcode_failures_codec_vp9(),
    mpeg2: () => m.admin_transcode_failures_codec_mpeg2(),
};

/**
 * Maps a raw encoder id (`h264_qsv`, `hevc_nvenc`, …) or `null` (software) to
 * an operator-facing label. Encoder ids follow `<codec>_<vendor>` throughout
 * the transcoding pipeline (see `hardware-detection.ts`'s `getBestEncoder`);
 * an id that doesn't split into a known codec + vendor pair (a future
 * hardware backend, or a software encoder name like `libx264`) falls back to
 * showing the raw id verbatim rather than guessing.
 */
export function formatEncoderName(encoder: string | null): EncoderDisplay {
    const raw = encoder ?? 'software';
    if (raw === 'software') {
        return { label: m.admin_transcode_failures_encoder_software() };
    }
    const separator = raw.indexOf('_');
    if (separator === -1) return { label: raw };

    const codec = raw.slice(0, separator);
    const vendor = raw.slice(separator + 1);
    const codecLabel = CODEC_LABEL[codec]?.();
    const vendorLabel = VENDOR_LABEL[vendor]?.();
    if (!codecLabel || !vendorLabel) return { label: raw };

    return { label: `${vendorLabel} (${codecLabel})` };
}
