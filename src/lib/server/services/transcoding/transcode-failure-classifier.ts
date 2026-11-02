// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Classifies an FFmpeg transcode failure into an actionable category with a
 * remediation hint, wrapping `summarizeFfmpegStderr` (which picks the single
 * most informative stderr line). The category + hint turn a raw FFmpeg error
 * into something an operator/user can act on — most importantly distinguishing
 * a GPU/hwaccel init failure (fixable by passing the device through or setting
 * GPU_ACCELERATION=none) from a genuinely unsupported codec.
 *
 * Conservative by design: when nothing matches, category is 'unknown' and no
 * hint is attached, so the existing one-line summary still shows.
 */

import { summarizeFfmpegStderr } from './ffmpeg-error-summary.js';

export type TranscodeFailureCategory =
    | 'output-unavailable'
    | 'gpu-init'
    | 'codec-unsupported'
    | 'missing-input'
    | 'permission'
    | 'out-of-memory'
    | 'invalid-argument'
    | 'unknown';

export interface TranscodeFailure {
    category: TranscodeFailureCategory;
    /** One-line human summary from `summarizeFfmpegStderr`. */
    summary: string;
    /** Actionable remediation for the category, when known. */
    hint?: string;
}

/**
 * Tokens that indicate the failing operation involved a hardware encoder/decoder.
 * No word boundaries: these appear joined in encoder names like `hevc_qsv` /
 * `h264_nvenc` where `\b` would not match between the underscore and the token.
 */
const GPU_TOKEN_RE =
    // Long tokens are boundary-free (match inside `hevc_qsv`, `h264_nvenc`).
    // `amf` is short, so anchor it to an encoder-name/standalone shape
    // (`h264_amf`, `_amf`, ` amf`) to avoid mid-word collisions in plain text.
    /(nvenc|nvdec|cuda|cuvid|nvcuda|vaapi|qsv|(?:_|\b)amf(?:_|\b)|d3d11|videotoolbox|vdpau)/i;
/** Generic init/availability failure verbs (paired with a GPU token below). */
const GPU_FAIL_RE =
    /(init|initiali|open(?:ing)?|load|capable|no (?:capable )?device|not (?:available|supported)|failed|cannot|unavailable|OpenEncodeSession)/i;

/**
 * FFmpeg could not write its OWN output — an HLS segment, its `.tmp` twin, the
 * media playlist, or the fMP4 init file. Every one of these names a file we
 * created the directory for, so the source media is irrelevant to the failure.
 *
 * In practice this only ever means the job's working directory was reaped while
 * FFmpeg was still running: a stop, a supersede, or a seek retiring the previous
 * generation. It is teardown, not a transcode fault — the `'output-unavailable'`
 * category is what the recorder keys on to keep those out of the failure log.
 *
 * It must be tested BEFORE `gpu-init` and `missing-input` in {@link categorize}:
 * `Failed to open file` satisfies GPU_FAIL_RE and the ever-present benign
 * `libva info: VA-API version …` banner satisfies GPU_TOKEN_RE, so a reaped
 * directory used to be reported to the operator as a GPU initialisation failure
 * ("verify the GPU is passed through"); `No such file or directory` likewise
 * read as a missing SOURCE file when the missing file was our own segment.
 */
const OUTPUT_WRITE_RE =
    /(?:Failed to open file|failed to rename file)\s+'?[^'\n]*(?:segment_\d+\.[A-Za-z0-9]+|init_\d+\.mp4|\.m3u8)|Error submitting a packet to the muxer: No such file or directory/i;

const CODEC_RE =
    /Unknown (?:encoder|decoder|codec|muxer|demuxer)\b|Encoder .* not found|Decoder .* not found/i;
const MISSING_INPUT_RE =
    /No such file or directory|Cannot open (?:file|input)|Could not open file|Invalid data found when processing input/i;
const PERMISSION_RE = /Permission denied|Operation not permitted/i;
const OOM_RE = /Cannot allocate memory|out of memory|ENOMEM|Out of memory/i;
const INVALID_ARG_RE =
    /Invalid (?:argument|option|value)|Option .* not found|Error splitting the argument/i;

/**
 * Definitive evidence of a GPU decode *surface* mismatch: the source silently
 * fell back to software decode (the forced `-hwaccel_output_format qsv/vaapi`
 * couldn't decode it in hardware) and the system-memory frames then hit a
 * GPU-only filter/encoder, which FFmpeg's auto-inserted scaler could not
 * reconcile (`auto_scale -38` → this line). This is the ONLY line that proves a
 * genuine per-codec hardware-decode gap; the trailing "Could not open encoder" /
 * "reinitializing filters!" symptoms are ambiguous (see below) and must not gate
 * learning on their own.
 */
export const GPU_SURFACE_MISMATCH_RE = /impossible to convert between the formats/i;

/**
 * Transient GPU resource / session / allocation failures. On a small-VRAM card
 * (e.g. Intel Arc A380, 6 GB) concurrent transcodes exhaust encode sessions or
 * device memory and FFmpeg prints the SAME terminal "Could not open encoder"
 * line as a real decode mismatch — and, when a QSV/VAAPI *session* fails to
 * create, it also silently software-falls-back and emits the identical
 * `impossible to convert…` cascade. So a match here means the failure is NOT
 * proof of a silicon decode gap: the codec must never be written to the learned
 * deny-map from such an exit (it would poison a perfectly decodable codec).
 */
export const GPU_RESOURCE_EXHAUSTION_RE =
    // Error-context MFX session failure ONLY — deliberately NOT a bare "mfx
    // session", because the QSV encoder logs a benign "Initialized an internal
    // MFX session" line even on a genuine decode gap; matching that would wrongly
    // suppress a real lesson. [^\n]{0,40} keeps each alternative line-scoped.
    /(?:error|failed)[^\n]{0,40}mfx session|failed to initiali[sz]e vaapi|device creation failed|failed to (?:create|allocate)[^\n]{0,40}(?:session|surface|context|frame|device)|cannot allocate memory|out of memory|enomem|resource temporarily unavailable|device (?:is )?busy|no free surfaces/i;

/**
 * Whether an FFmpeg failure stderr proves a genuine per-codec hardware-decode
 * gap that should be *learned* (source codec permanently routed through the
 * software-decode bridge). Requires the definitive surface-mismatch line AND the
 * absence of any transient resource/session signature — otherwise a busy-GPU
 * failure would be misattributed to the codec. Conservative by design: when in
 * doubt, return false (the caller still bridges the single job, just never
 * persists the lesson).
 */
export function isLearnableGpuDecodeFailure(stderr: string): boolean {
    return GPU_SURFACE_MISMATCH_RE.test(stderr) && !GPU_RESOURCE_EXHAUSTION_RE.test(stderr);
}

/**
 * The NVIDIA encoder could not be opened for this job. On a GeForce card the
 * encoder is shared with every other app that encodes video — game streaming
 * (Sunshine/Apollo, GeForce Experience), OBS, Discord streaming, instant
 * replay — and the driver caps concurrent sessions; with no session left,
 * `OpenEncodeSessionEx` fails with "out of memory (10)" or "incompatible
 * client key (21)". A missing or too-old driver library ends the same way.
 * None of this is about the media: the job can still be encoded in software.
 */
export const NVENC_SESSION_FAILURE_RE =
    // CUDA errors count only on an NVENC encoder's own log line: the same
    // tokens from cuvid / scale_cuda / tonemap_cuda are a decode or filter
    // problem, not a missing encode session.
    /OpenEncodeSessionEx failed|No (?:NVENC )?capable devices found|\[\w*nvenc[^\]\n]*\][^\n]*(?:cuInit\(0\) failed|CUDA_ERROR_OUT_OF_MEMORY)|Cannot load (?:libnvidia-encode|nvEncodeAPI)|minimum required Nvidia driver for nvenc/i;

/**
 * The TRANSIENT part of {@link NVENC_SESSION_FAILURE_RE}: the encoder exists
 * but had no free session or memory right now. Only this is worth probing
 * again later (hardware-detection.ts); "no capable devices", a missing
 * library or an old driver stay that way, and re-probing them every minute
 * would spawn FFmpeg on the playback start path forever.
 */
export const NVENC_BUSY_RE = /OpenEncodeSessionEx failed|CUDA_ERROR_OUT_OF_MEMORY/i;

/**
 * Whether a failed GPU job should be retried with a software encoder: the
 * job encoded with NVENC and the stderr shows the encoder could not open.
 */
export function isGpuEncoderSessionFailure(
    gpuEncoder: string | undefined,
    stderr: string,
): boolean {
    return !!gpuEncoder && /nvenc/i.test(gpuEncoder) && NVENC_SESSION_FAILURE_RE.test(stderr);
}

const HINTS: Record<Exclude<TranscodeFailureCategory, 'unknown'>, string> = {
    'output-unavailable':
        "FFmpeg could not write its own output — the job's working directory was removed while it was still running. That is normally a stopped, superseded, or seeked playback session being torn down, not a transcode fault.",
    'gpu-init':
        'Hardware (GPU) encoding failed to initialize. Verify the GPU is passed through to the container and its drivers are installed, or set GPU_ACCELERATION=none to fall back to software. See https://lumastra.org/guides/gpu-transcoding/.',
    'codec-unsupported':
        'The required codec is not available in this FFmpeg build. Try a different output codec, or use the bundled jellyfin-ffmpeg.',
    'missing-input':
        'The source media file could not be opened — it may be missing, on an unmounted volume, or corrupt.',
    permission:
        'FFmpeg was denied access to the media file or the transcode output directory. Check file ownership and the FFMPEG_TRANSCODE_DIR permissions.',
    'out-of-memory':
        'The server ran out of memory during transcoding. Reduce concurrent transcodes (FFMPEG_MAX_JOBS_PER_USER) or give the container more memory.',
    'invalid-argument':
        'FFmpeg rejected an argument — often a codec/encoder option unsupported by the selected encoder. If using a GPU encoder, try GPU_ACCELERATION=none to isolate it.',
};

function categorize(stderr: string): TranscodeFailureCategory {
    // Output-side write failures come first: they satisfy the gpu-init and
    // missing-input signatures by accident (see OUTPUT_WRITE_RE), and answering
    // "your GPU failed to initialise" for a directory we deleted ourselves sends
    // the operator after the wrong thing entirely.
    if (OUTPUT_WRITE_RE.test(stderr)) return 'output-unavailable';
    // GPU init is checked next: it's the most actionable for the OSS GPU story
    // and its symptoms (Invalid argument, failed) overlap weaker categories.
    if (GPU_TOKEN_RE.test(stderr) && GPU_FAIL_RE.test(stderr)) return 'gpu-init';
    if (CODEC_RE.test(stderr)) return 'codec-unsupported';
    if (PERMISSION_RE.test(stderr)) return 'permission';
    if (OOM_RE.test(stderr)) return 'out-of-memory';
    if (MISSING_INPUT_RE.test(stderr)) return 'missing-input';
    if (INVALID_ARG_RE.test(stderr)) return 'invalid-argument';
    return 'unknown';
}

/**
 * Classify a transcode failure. `stderr` is the raw FFmpeg stderr tail (may be
 * empty); `exitCode` and `fallbackMessage` are forwarded to
 * `summarizeFfmpegStderr` for the human one-liner.
 */
export function classifyTranscodeFailure(
    stderr: string,
    exitCode: number | null,
    fallbackMessage?: string,
): TranscodeFailure {
    const summary = summarizeFfmpegStderr(stderr, exitCode, fallbackMessage);
    const category = categorize(stderr);
    return category === 'unknown'
        ? { category, summary }
        : { category, summary, hint: HINTS[category] };
}

/**
 * Convenience: a single player-facing line — the summary, plus the hint when
 * known. Keeps the publish/SSE contract a plain string.
 */
export function formatTranscodeFailureMessage(failure: TranscodeFailure): string {
    return failure.hint ? `${failure.summary} — ${failure.hint}` : failure.summary;
}
