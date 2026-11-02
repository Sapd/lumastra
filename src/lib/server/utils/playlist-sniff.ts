// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Identify a playlist/manifest body by its CONTENT (rulings
 * T7-probe-outcomes-2, T7-dash-imf, T7-music — fix plan 6, Task 7). Shared by
 * the library scanner (`probeFileForScan`/`sniffFileForScan`, file-scanner
 * `shared.ts`) and the music-transcode spawn (`music-transcode/source-guard.ts`),
 * so both planes refuse exactly the same files.
 *
 * ffprobe cannot be the only judge: a reference-following body can make it
 * fail with "Invalid data" — about a file it REFERENCES — and FFmpeg 7.x/9.x
 * will not even detect HLS in a file whose extension is not `.m3u8`/`.m3u`;
 * music-metadata (the music scanner's tag reader) accepts a text body as a
 * track. The content is the stable identity.
 */

import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { withFsGuard } from './safe-fs.js';

/** Bytes of a file's head that every sniff reads. */
export const SNIFF_HEAD_BYTES = 4096;

/**
 * How far a NUL-free (text) file is read in search of a DASH/IMF manifest tag.
 * Real media has a NUL within its first bytes and never reads past the head.
 */
export const SNIFF_MANIFEST_MAX_BYTES = 5 * 1024 * 1024;

const SNIFF_CHUNK_BYTES = 64 * 1024;

/** The reference-following demuxer a file identifies itself as. */
export type PlaylistMagic = 'concat' | 'hls' | 'dash' | 'imf';

/**
 * `<MPD` (dashdec.c `dash_probe`: `av_stristr(p->buf, "<MPD")`),
 * `<CompositionPlaylist` (imfdec.c `imf_probe`: `strstr`, which also wants a
 * `ContentTitle>` element — the sniff does not) and `<AssetMap` (the IMF asset
 * map a composition playlist resolves through). Matched case-insensitively and
 * anywhere, as dash_probe does; both FFmpeg probes treat the buffer as a C
 * string, so they never see past its first NUL either.
 */
const MANIFEST_TAG = /<(mpd|compositionplaylist|assetmap)/i;

/** Longest manifest tag minus one: the overlap kept between chunks. */
const MANIFEST_TAG_OVERLAP = '<compositionplaylist'.length - 1;

function manifestTagIn(text: string): PlaylistMagic | null {
    const m = MANIFEST_TAG.exec(text);
    if (!m) return null;
    return m[1].toLowerCase() === 'mpd' ? 'dash' : 'imf';
}

/**
 * Identify a playlist/manifest body from a file's first bytes.
 *
 * Only the part of the head before its first NUL is text a demuxer's probe can
 * match, so only that part is examined. After a UTF-8 BOM and leading
 * whitespace:
 *
 * - `ffconcat version` — concatdec.c `concat_probe` (FFmpeg n7.1) matches the
 *   exact 20 bytes `ffconcat version 1.0` at offset 0; this is a superset
 *   (BOM, whitespace, any version).
 * - `#EXTM3U` — hls.c `hls_probe` requires it at offset 0 plus a
 *   `#EXT-X-STREAM-INF:`/`#EXT-X-TARGETDURATION:`/`#EXT-X-MEDIA-SEQUENCE:`
 *   tag and an `.m3u8`/`.m3u` name or HLS MIME type; the sniff needs only the
 *   first line, so an HLS body hidden in a `.mkv` or `.mp3` is refused too.
 * - A DASH/IMF manifest tag anywhere ({@link MANIFEST_TAG}).
 * - A bare concat script: a line that starts, after optional blanks, with the
 *   `file` directive and an argument, in a head with no NUL byte at all.
 *   concat_probe never auto-detects such a script (only `-f concat` reads it,
 *   and the app passes that flag only for its own generated list), so this is
 *   defence in depth; the NUL-free condition keeps binary containers out.
 *
 * A manifest tag past the head is found by {@link sniffFileForPlaylist}.
 */
export function sniffPlaylistMagic(head: Uint8Array): PlaylistMagic | null {
    const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
    const withoutBom =
        bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
    const nul = withoutBom.indexOf(0);
    const textPart = nul === -1 ? withoutBom : withoutBom.subarray(0, nul);
    const text = textPart.toString('latin1').replace(/^[\t\n\v\f\r ]+/, '');

    if (text.startsWith('ffconcat version')) return 'concat';
    if (text.startsWith('#EXTM3U')) return 'hls';
    const manifest = manifestTagIn(text);
    if (manifest) return manifest;
    if (nul === -1 && /^[ \t\r]*file[ \t]+\S/m.test(text)) return 'concat';
    return null;
}

/** What {@link sniffFileForPlaylist} found, and how many bytes it read. */
export interface PlaylistSniffResult {
    magic: PlaylistMagic | null;
    bytesRead: number;
}

function abortError(): Error {
    return Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
    });
}

/**
 * Sniff a file for a playlist/manifest body. Returns null for anything that is
 * not a regular file.
 *
 * Reads {@link SNIFF_HEAD_BYTES} and applies {@link sniffPlaylistMagic}. When
 * that finds nothing and the head is a full, NUL-free (text) block, reading
 * continues in chunks up to the first NUL or {@link SNIFF_MANIFEST_MAX_BYTES},
 * looking for a DASH/IMF manifest tag anywhere (ruling T7-dash-imf) — a tag
 * behind a long XML comment would otherwise pass. Real media has a NUL within
 * its first bytes, so it costs one 4 KiB read.
 *
 * The open is non-blocking, so a FIFO is recognised and skipped instead of
 * hanging; the whole read runs under `withFsGuard` (global fs concurrency cap +
 * timeout, `FsTimeoutError`); `signal` is checked between reads and rejects
 * with an `AbortError`; the file handle is always closed. Any fs error rejects
 * with its `code` intact.
 */
export async function sniffFileForPlaylist(
    filePath: string,
    opts: { signal?: AbortSignal } = {},
): Promise<PlaylistSniffResult | null> {
    const { signal } = opts;
    if (signal?.aborted) throw abortError();
    return withFsGuard(
        async () => {
            const fh = await open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
            try {
                if (!(await fh.stat()).isFile()) return null;

                const head = Buffer.alloc(SNIFF_HEAD_BYTES);
                let total = 0;
                while (total < SNIFF_HEAD_BYTES) {
                    const { bytesRead } = await fh.read(
                        head,
                        total,
                        SNIFF_HEAD_BYTES - total,
                        total,
                    );
                    if (bytesRead === 0) break;
                    total += bytesRead;
                }
                if (signal?.aborted) throw abortError();
                const headBytes = head.subarray(0, total);
                const magic = sniffPlaylistMagic(headBytes);
                if (magic || total < SNIFF_HEAD_BYTES || headBytes.includes(0)) {
                    return { magic, bytesRead: total };
                }

                let carry = headBytes.toString('latin1').slice(-MANIFEST_TAG_OVERLAP);
                const chunk = Buffer.alloc(SNIFF_CHUNK_BYTES);
                while (total < SNIFF_MANIFEST_MAX_BYTES) {
                    if (signal?.aborted) throw abortError();
                    const want = Math.min(SNIFF_CHUNK_BYTES, SNIFF_MANIFEST_MAX_BYTES - total);
                    const { bytesRead } = await fh.read(chunk, 0, want, total);
                    if (bytesRead === 0) break;
                    total += bytesRead;
                    let slice = chunk.subarray(0, bytesRead);
                    const nul = slice.indexOf(0);
                    if (nul !== -1) slice = slice.subarray(0, nul);
                    const text = carry + slice.toString('latin1');
                    const tag = manifestTagIn(text);
                    if (tag) return { magic: tag, bytesRead: total };
                    if (nul !== -1) break;
                    carry = text.slice(-MANIFEST_TAG_OVERLAP);
                }
                return { magic: null, bytesRead: total };
            } finally {
                await fh.close();
            }
        },
        'sniffFileForPlaylist',
        filePath,
    );
}
