// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `videoCodec` / `audioCodec` query-param allowlists for the HLS playback route
 * (security review 2026-09-12, C17): these values used to reach ffmpeg argv
 * unvalidated.
 *
 * Lives beside `+server.ts` rather than inside it because SvelteKit permits only
 * handler exports (GET, POST, …, or a `_` prefix) from a route module, and a
 * stray one fails the build with "Invalid export". Same reason `file-selection.ts`
 * sits next door.
 */

// 'none' disables video (see resolveVideoDisabled); 'copy' asks the decision
// engine to keep its own choice; the rest are the generic codec names
// transcode-decision.ts's CODEC_ENCODER_MAP / AUDIO_HINT_ENCODER_MAP know how to
// map to a real encoder. Anything else is ignored, matching the other override
// params (hlsContainer, hlsAudioMode, …), which also default rather than 400.
export const ALLOWED_VIDEO_CODEC_OVERRIDES = new Set(['none', 'copy', 'h264', 'hevc', 'av1']);
export const ALLOWED_AUDIO_CODEC_OVERRIDES = new Set([
    'copy',
    'aac',
    'ac3',
    'eac3',
    'mp3',
    'opus',
    'flac',
]);

/**
 * Validate a `videoCodec`/`audioCodec` override query param against its
 * allowlist. An unrecognised value is ignored (returns undefined) rather than
 * reaching the decision engine, matching the ignore-and-default convention the
 * other override params use.
 */
export function resolveCodecOverride(
    raw: string | null,
    allowed: ReadonlySet<string>,
): string | undefined {
    return raw !== null && allowed.has(raw) ? raw : undefined;
}
