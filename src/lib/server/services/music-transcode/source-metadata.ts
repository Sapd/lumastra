// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Source metadata for music transcode decisioning.
 *
 * Thin adapter over the existing ffprobe helper at `$lib/server/utils/ffprobe`.
 * The decision module (Task 3.1) consumes `SourceMetadata` — this module
 * extracts the fields it needs from a raw `probeFormat` + `probeStreams`
 * call so callers don't have to know about ffprobe internals.
 */

import { extname } from 'node:path';

import { probeFormat, probeStreams, containerFromExtension } from '$lib/server/utils/ffprobe.js';
import type { SourceMetadata } from './decision.js';
import { assertTranscodeSourceIsMedia, PlaylistSourceRefusedError } from './source-guard.js';

/**
 * Probe an audio source file and return decision-ready metadata.
 *
 * Cost: spawns two ffprobe processes (format + streams). Callers should
 * gate this on whether transcode decisioning actually needs source info
 * (e.g. when a `maxBitrateKbps` query param is present) and avoid probing on
 * the no-op fall-through path.
 *
 * Fallback behavior: missing fields default to safe values that won't
 * accidentally force transcoding (codec='unknown', bitrate=0, channels=2,
 * sampleRate=44100, bitDepth=16). A playlist/manifest body rejects with
 * `PlaylistSourceRefusedError` (status 415).
 */
export async function probeAudioSource(filePath: string): Promise<SourceMetadata> {
    // Refuse a playlist/manifest body before ffprobe opens it (ruling
    // T7-music): ffprobe would follow its references and report the codec and
    // layout of a file elsewhere, which Subsonic `getTranscodeDecision`
    // returns to the client. Other sniff errors keep this function's
    // fall-back-to-defaults contract; the probes below hit the same error.
    await assertTranscodeSourceIsMedia(filePath).catch((err: unknown) => {
        if (err instanceof PlaylistSourceRefusedError) throw err;
    });

    // Run both probes in parallel — they spawn separate ffprobe processes
    // but each call is short for an audio file (<50ms typical).
    const [fmt, streams] = await Promise.all([
        probeFormat(filePath).catch(() => null),
        probeStreams(filePath).catch(() => null),
    ]);

    // Prefer container derived from file extension — ffprobe's format_name
    // is comma-separated for some containers (e.g. "mov,mp4,m4a,3gp,3g2,mj2")
    // which is not safe to match against decision-module profiles.
    const ext = extname(filePath).toLowerCase().replace(/^\./, '');
    const containerFromExt = containerFromExtension(filePath);
    const container = containerFromExt ?? (ext.length > 0 ? ext : (fmt?.formatName ?? 'unknown'));

    const firstAudio = streams?.audio[0];
    const codec = firstAudio?.codec ?? 'unknown';

    // Bitrate: prefer stream-level (per-track), fall back to format-level
    // (container total). Many lossy files only expose container bitrate.
    const bitrate = firstAudio?.bitRate ?? fmt?.bitrate ?? 0;
    const sampleRate = firstAudio?.sampleRate ?? 44100;
    const channels = firstAudio?.channels ?? 2;

    // Bit depth is not consistently exposed by ffprobe for compressed codecs.
    // Decision module currently treats this as advisory — default to 16.
    const bitDepth = 16;

    return {
        container,
        codec,
        bitrate,
        sampleRate,
        channels,
        bitDepth,
    };
}
