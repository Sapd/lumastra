// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FFmpeg arguments for one offline-download rendition: a single progressive MP4.
 *
 * ## Why this is not the HLS pipeline
 *
 * `ffmpeg-args-builder.ts` only ever emits `-f hls`. Everything it exists for —
 * segments, ABR ladders, seek storms, generation promotion — serves a stream
 * being scrubbed in real time against a live server. A download is one file,
 * encoded once, played later with no server in the loop. It needs the opposite
 * output shape (`-f mp4 -movflags +faststart`) and none of that machinery, so it
 * gets its own small args function for the same reason `audiobook-remux.service.ts`
 * declined to route a book through the video pipeline.
 *
 * ## Codec choice is fixed; the encoder that produces it is not
 *
 * The artifact must decode on whatever device downloaded it, forever, offline, so
 * the OUTPUT is always H.264 High 8-bit + AAC-LC in MP4. Which encoder produces
 * those bytes — libx264 or a GPU encoder — is a performance decision, and
 * {@link RenditionHwPlan} carries it. Hardware H.264 encoders are all 8-bit, so
 * the compatibility guarantee is unaffected either way.
 *
 * What stays on the CPU regardless is the FILTER chain (tone map + scale). See
 * hw-plan.ts for why: every HDR incident in this codebase came from keeping
 * frames on the GPU across filters, and the encoder is where the time actually
 * goes.
 */

import { getDownloadRung, type DownloadRung } from '$lib/shared/download-rungs.js';
import type { RenditionHwPlan } from './hw-plan.js';

export interface RenditionEncodeSpec {
    inputPath: string;
    outputPath: string;
    rung: DownloadRung;
    /**
     * Absolute ffmpeg stream index of the chosen audio track — the same value
     * `LumastraVersion.tracks.audio[].absoluteIndex` carries, which is the
     * canonical selection value on this API (NOT the audio-relative index).
     *
     * `null` means the source has no audio stream at all (silent film). The
     * encode then drops audio rather than mapping a track that does not exist.
     */
    audioIndex: number | null;
    /** Tone-map to SDR. True for any HDR/HLG/Dolby Vision source. */
    isHdr: boolean;
    /** Hardware plan, or null/omitted to encode entirely in software. */
    hw?: RenditionHwPlan | null;
}

/**
 * Peak-to-average headroom for the capped-VBR ladder.
 *
 * The size estimate the client showed the user is `bitrate × duration`, so the
 * average must actually hold. `-maxrate` at 1.5× with a 2× buffer lets a busy
 * scene spend without letting the file drift away from the number the user
 * agreed to download.
 */
const MAXRATE_FACTOR = 1.5;
const BUFSIZE_FACTOR = 2;

/**
 * Build the argument vector. Pure — spawned with an array, never a shell string,
 * so no value here is shell-quoted and a path with spaces or quotes is inert.
 */
export function buildRenditionArgs(spec: RenditionEncodeSpec): string[] {
    const { rung } = spec;
    const hw = spec.hw ?? null;

    const filters: string[] = [];
    if (spec.isHdr) {
        // Exactly the chain ffmpeg-args-builder settled on for CPU tone mapping.
        // The obvious-looking zscale chain is NOT a substitute: it aborts on
        // Dolby Vision ("no path between colorspaces") and never reaches an
        // 8-bit pixel format, so libx264 fails to open and the encode dies at
        // exit -22. `tonemapx` handles HDR10/HLG/DV and emits yuv420p directly.
        filters.push('tonemapx=tonemap=hable:p=bt709:t=bt709:m=bt709:r=tv:format=yuv420p');
    }
    // -2 keeps the aspect ratio and forces an even width (h264 requires it).
    // min(ih,H) is a downscale-only clamp: a 480p source asked for the 1080p rung
    // is encoded at 480p rather than upscaled into a bigger file with no more
    // detail. The comma is escaped because ffmpeg's parser uses it as the filter
    // separator.
    filters.push(`scale=-2:'min(ih\\,${rung.height})'`);
    if (hw?.needsHwUpload) {
        // VA-API's encoder takes an opaque surface, unlike QSV/NVENC which accept
        // system memory and upload internally. Must come last, after the frames
        // are already 8-bit SDR at the target size.
        filters.push('format=nv12', 'hwupload');
    }

    const maxrate = Math.round(rung.videoBitrate * MAXRATE_FACTOR);
    const bufsize = Math.round(rung.videoBitrate * BUFSIZE_FACTOR);

    return [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'warning',
        // Overwrite: the output path is a private partial file this process owns.
        '-y',
        ...(hw?.initArgs ?? []),
        // No `-hwaccel`: decode stays in software so the filter chain is
        // identical to the pure-CPU path. Measured, not assumed — see hw-plan.ts.
        '-i',
        spec.inputPath,

        // First video stream + the ONE audio track the user picked. Everything
        // else is dropped: no subtitles (they stay sidecars the client renders),
        // no data/attachment streams (fonts and cover art break some muxers).
        '-map',
        '0:v:0',
        ...(spec.audioIndex === null ? [] : ['-map', `0:${spec.audioIndex}`]),
        '-sn',
        '-dn',
        // Chapters survive — they cost nothing and offline players use them.
        '-map_chapters',
        '0',

        '-vf',
        filters.join(','),

        '-c:v',
        hw?.encoder ?? 'libx264',
        // veryfast is the knee of the quality/throughput curve for a background
        // job: slower presets buy a few percent bitrate efficiency for multiples
        // of wall-clock, and the user is waiting on this before they can travel.
        // Hardware encoders each have their own preset vocabulary, so the plan
        // says what (if anything) this one understands.
        ...(hw ? (hw.preset ? ['-preset', hw.preset] : []) : ['-preset', 'veryfast']),
        '-profile:v',
        'high',
        '-level',
        '4.1',
        // Stated, never inferred. A VA-API surface carries its own format (the
        // hwupload set it), so it gets no -pix_fmt at all; every other encoder
        // gets the format IT wants rather than whatever ffmpeg auto-selects.
        ...(hw ? (hw.pixFmt ? ['-pix_fmt', hw.pixFmt] : []) : ['-pix_fmt', 'yuv420p']),
        '-b:v',
        String(rung.videoBitrate),
        '-maxrate',
        String(maxrate),
        '-bufsize',
        String(bufsize),

        ...(spec.audioIndex === null
            ? // No audio stream to encode. `-map 0:v:0` alone already excludes
              // audio; `-an` is stated anyway so the intent survives a future
              // edit to the map list.
              ['-an']
            : ['-c:a', 'aac', '-ac', '2', '-b:a', String(rung.audioBitrate), '-ar', '48000']),

        '-f',
        'mp4',
        // Moves the moov atom to the front. Without it the file is unplayable
        // until the last byte lands — which defeats a resumable download and
        // makes the client unable to read duration from a partial file.
        '-movflags',
        '+faststart',

        // Machine-readable progress on stdout; humans read stderr.
        '-progress',
        'pipe:1',
        '-nostats',

        spec.outputPath,
    ];
}

/**
 * Parse ffmpeg's `-progress` key=value stream into a percentage.
 *
 * ffmpeg reports elapsed output time, never a percentage, so the duration has to
 * come from the caller. Returns null when the chunk carries no position yet.
 */
export function parseProgressPct(chunk: string, durationMs: number | null): number | null {
    if (durationMs === null || durationMs <= 0) return null;
    // Last wins: one read can span several progress blocks.
    let outTimeUs: number | null = null;
    for (const line of chunk.split('\n')) {
        const [key, value] = line.split('=');
        if (key?.trim() === 'out_time_us' || key?.trim() === 'out_time_ms') {
            const parsed = Number(value?.trim());
            if (Number.isFinite(parsed) && parsed >= 0) {
                // `out_time_ms` is a long-standing ffmpeg misnomer: it is
                // MICROseconds, same as out_time_us. Treating it as ms would
                // report 1000x progress and finish the bar in the first second.
                outTimeUs = parsed;
            }
        }
    }
    if (outTimeUs === null) return null;
    const pct = (outTimeUs / 1000 / durationMs) * 100;
    return Math.max(0, Math.min(99, Math.round(pct)));
}

/** Resolve a wire rung id, rejecting anything not on the published ladder. */
export function resolveRung(rungId: string): DownloadRung | null {
    return getDownloadRung(rungId) ?? null;
}
