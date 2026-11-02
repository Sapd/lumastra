// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bounded reader for sidecar text files (external subtitles, NFO).
 *
 * A library writer controls these files and a logged-in user (or a scan) makes
 * the server parse them, so every reader goes through here: the size check
 * runs BEFORE the bytes are decoded to a string and before any regex sees them.
 * The cap is the subtitle resolver's long-standing 10 MiB: ASS files with
 * embedded fonts or heavy karaoke run to several MiB, and the parsers behind
 * this reader are linear, so the cap bounds memory, not regex time.
 */

import { ContainmentError, readContainedFile } from './contained-fs.js';

/** Most bytes we will parse from one sidecar text file (subtitles, NFO). */
export const MAX_SIDECAR_TEXT_BYTES = 10 * 1024 * 1024;

export class SidecarTooLargeError extends Error {
    readonly path: string;
    readonly limitBytes: number;

    constructor(path: string, limitBytes: number) {
        super(`Sidecar text file exceeds ${limitBytes} bytes: ${path}`);
        this.name = 'SidecarTooLargeError';
        this.path = path;
        this.limitBytes = limitBytes;
    }
}

/**
 * Read a sidecar text file as UTF-8, rejecting (SidecarTooLargeError) anything
 * over `maxBytes`. Goes through the containment helper: a symlink out of the
 * library roots, a FIFO or a device is refused (ContainmentError) instead of
 * being followed or blocking a thread.
 */
export async function readSidecarText(
    path: string,
    maxBytes: number = MAX_SIDECAR_TEXT_BYTES,
): Promise<string> {
    try {
        return (await readContainedFile(path, { maxBytes })).toString('utf8');
    } catch (err) {
        if (err instanceof ContainmentError && err.kind === 'too_large') {
            throw new SidecarTooLargeError(path, maxBytes);
        }
        throw err;
    }
}
