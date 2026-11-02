// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { sniffFileForPlaylist, type PlaylistMagic } from '$lib/server/utils/playlist-sniff.js';

/**
 * The transcode source is a playlist/manifest body, not media. `status` is the
 * HTTP status every music route maps it to (415: the stored file is not a
 * media type the transcoder accepts), the same `status`-carrying error shape
 * the routes already handle for the 503 slot-exhaustion case. The video
 * transcode spawns throw it too (`transcoding/input-guard.ts`), where it fails
 * the job like any other spawn failure.
 */
export class PlaylistSourceRefusedError extends Error {
    readonly status = 415;

    constructor(
        readonly sourcePath: string,
        readonly magic: PlaylistMagic,
    ) {
        super(`transcode source is a ${magic} playlist/manifest body, not media`);
        this.name = 'PlaylistSourceRefusedError';
    }
}

/**
 * Refuse a music-transcode source whose content is a playlist/manifest body
 * (ruling T7-music). ffmpeg reads the source with `-protocol_whitelist file`,
 * which still lets an ffconcat script follow an HLS playlist to an absolute
 * path in another library; the scanner now refuses such bodies at ingest, and
 * this covers rows linked before it did.
 *
 * `MusicTranscodeService.streamFor` — the only entry point to every
 * music-transcode spawn, including a cached result — runs this first. The
 * sniff is the scanner's own (`sniffFileForPlaylist`): one 4 KiB read for real
 * audio, which always has a NUL byte in its head. An abort rejects with
 * `status: 503`; other read errors propagate unchanged, as the spawn would
 * have failed on them anyway.
 */
export async function assertTranscodeSourceIsMedia(
    sourcePath: string,
    signal?: AbortSignal,
): Promise<void> {
    let sniff;
    try {
        sniff = await sniffFileForPlaylist(sourcePath, { signal });
    } catch (err) {
        // A client that disconnected mid-sniff gets the same 503 the slot wait
        // gives it (`slot-wait.ts`), not a logged 500.
        if (err instanceof Error && err.name === 'AbortError') {
            throw Object.assign(err, { status: 503 });
        }
        throw err;
    }
    if (sniff?.magic) throw new PlaylistSourceRefusedError(sourcePath, sniff.magic);
}
