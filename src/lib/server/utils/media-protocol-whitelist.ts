// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `-protocol_whitelist` value for the media-plane library-input sites whose
 * demuxers can follow further references out of the file's own content: the
 * ffprobe library probe and the music-source `probeFormat`/`probeStreams`
 * (`probeMediaFile`/`probeFormat`/`probeStreams`, `utils/ffprobe.ts`), the
 * transcode input — single and concat —
 * (`FFmpegArgsBuilder.addInputFile` / `addConcatInputFile`,
 * `services/transcoding/ffmpeg-args-builder.ts`), and every music-transcode
 * encode-arg builder's `-i` (`services/music-transcode/ffmpeg-args.ts`).
 *
 * The media plane is local-disk-only by design (`media-path-resolver.ts`
 * — "local file access is now always enabled", hybrid/remote mode retired).
 * Every one of these sites receives only a resolved local filesystem path or
 * (for concat) the app's own temp concat-list file, itself opened as
 * `file:`; no `pipe:`, `data:`, or network input reaches any of them
 * (`FFmpegArgsBuilder` has no network-input method). `file` alone is
 * therefore sufficient; unlike the stream-proxy plane's
 * `FFMPEG_PROTOCOL_WHITELIST` (`native/livetv-proxy/src/config.rs`, a
 * network-only list for LiveTV), no network protocol belongs here.
 *
 * This is the app's own contribution to R2's residual (S11: "the app itself
 * has no control" before this fix) — it does not depend on the pinned
 * jellyfin-ffmpeg binary's own HLS/concat demuxer gates, which remain the
 * last line of defense for the remaining media-plane argv sites this
 * constant is deliberately NOT applied to (S-P1b: the scanner's
 * playlist-class-container refusal is their chokepoint instead — this does
 * NOT include music or the one probeFormat/probeStreams caller
 * (`probeAudioSource`, `services/music-transcode/source-metadata.ts`), which
 * carry the whitelist directly. The whitelist does not stop a `file`-only
 * reference chain (ffconcat → `.m3u8` → an absolute path); what stops it is
 * the content sniff (`utils/playlist-sniff.ts`) at scan time on both planes
 * and before every music-transcode spawn (fix-plan-6 Task 7 fix round 5),
 * and, on the transcode input, `-format_whitelist`
 * (`media-format-whitelist.ts`, F4), which keeps the reference-following
 * demuxers from being selected at all.
 */
export const MEDIA_PROTOCOL_WHITELIST = 'file';
