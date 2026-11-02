// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `-format_whitelist` for every ffmpeg that opens a LIBRARY file.
 *
 * The content sniff (`transcoding/input-guard.ts`) reads the file and ffmpeg
 * opens it later; a file rewritten in between into an ffconcat/HLS/DASH/SDP
 * body is demuxed by a demuxer that follows the references it names. The
 * whitelist (`media-format-whitelist.ts`) keeps those demuxers from being
 * selected at all, so it is applied at the spawn, per input, instead of only on
 * the HLS transcode input.
 *
 * `spawnFFmpegSafely({ libraryInput })` does this for its callers. A spawner
 * that builds its own argv calls {@link guardLibraryInput} directly.
 * `library-input-guard.scan.test.ts` fails a library-input spawn site that
 * does neither.
 */

import { config } from '../config.js';
import { Logger } from './logger.js';
import { getMediaFormatWhitelist, prepareMediaFormatWhitelist } from './media-format-whitelist.js';

const logger = Logger.for('LibraryInputGuard');

/**
 * `args` with `-format_whitelist <demuxers>` placed directly before each
 * `-i <inputPath>` pair it protects (an input option applies to the next `-i`). Unchanged when the caller already set one, when the binary's demuxers
 * could not be enumerated (the sniff still covers that case, as for the
 * transcode input) or when `-i <inputPath>` is not in the argv.
 */
export function guardLibraryInput(
    args: readonly string[],
    inputPath: string,
    ffmpegPath: string = config.FFMPEG_PATH,
): string[] {
    if (args.includes('-format_whitelist')) return [...args];
    const inputs = args.flatMap((arg, i) => (arg === '-i' && args[i + 1] === inputPath ? [i] : []));
    if (inputs.length === 0) {
        logger.warn('Library input not found in ffmpeg argv; no -format_whitelist applied', {
            inputPath,
        });
        return [...args];
    }
    const whitelist = getMediaFormatWhitelist(ffmpegPath);
    if (!whitelist) return [...args];
    const out: string[] = [];
    args.forEach((arg, i) => {
        if (inputs.includes(i)) out.push('-format_whitelist', whitelist);
        out.push(arg);
    });
    return out;
}

/**
 * The `-format_whitelist` option pair for an ffprobe whose last argument is the
 * library file (ffprobe has no `-i` there); `[]` when no whitelist is
 * available. Spread it directly before the path. The scanner's own ffprobe
 * does not use this: it needs to NAME the playlist demuxer to classify a refusal.
 */
export async function ffprobeLibraryInputArgs(
    ffmpegPath: string = config.FFMPEG_PATH,
    signal?: AbortSignal,
): Promise<string[]> {
    signal?.throwIfAborted();
    const warm = prepareMediaFormatWhitelist(ffmpegPath);
    if (warm && signal) {
        // Discovery is shared; abort this waiter without ever launching the
        // private library-file probe after its caller's budget has expired.
        await new Promise<void>((resolve, reject) => {
            const abort = (): void => {
                signal.removeEventListener('abort', abort);
                reject(signal.reason);
            };
            signal.addEventListener('abort', abort, { once: true });
            void warm
                .then(() => {
                    signal.removeEventListener('abort', abort);
                    resolve();
                })
                .catch((error: unknown) => {
                    signal.removeEventListener('abort', abort);
                    reject(error);
                });
            if (signal.aborted) abort();
        });
    } else if (warm) await warm;
    signal?.throwIfAborted();
    const whitelist = getMediaFormatWhitelist(ffmpegPath);
    return whitelist ? ['-format_whitelist', whitelist] : [];
}
