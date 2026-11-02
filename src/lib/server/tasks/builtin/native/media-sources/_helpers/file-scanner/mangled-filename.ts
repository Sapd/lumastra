// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A path is "mangled" when it contains U+FFFD, the Unicode replacement
 * character.
 *
 * Node's `fs.readdir` substitutes U+FFFD for any byte sequence in an on-disk
 * filename that isn't valid UTF-8 — e.g. a Latin-1/ISO-8859-1-encoded name
 * where `ö` is the single byte `0xF6` instead of the UTF-8 `0xC3 0xB6`. The
 * decoded string we hold (`Erlk�nig.mp3`) therefore no longer maps to the
 * real bytes on disk, so every later `fs.open` / ffprobe on it ENOENTs. Left
 * undetected this makes the file silently vanish from the library: a
 * `media_files` row is written but the item can never be probed, created, or
 * linked (observed on prod with Latin-1-named music files).
 *
 * This is orthogonal to Unicode NFC/NFD normalization — a valid-UTF-8 NFD name
 * round-trips fine and is not mangled.
 *
 * Note: the decode is lossy — every undecodable byte run collapses to a single
 * U+FFFD, so two distinct on-disk files that differ only in their invalid
 * byte(s) can decode to the same string and share one `media_files` stub row.
 * Both need the same fix (rename to UTF-8), so the reported entry is still
 * actionable; only the count may under-represent. Callers should therefore
 * confirm the path is genuinely unopenable (e.g. via `stat`) before treating a
 * U+FFFD as proof of mangling, since a real filename may legitimately contain
 * the replacement character.
 */
export function isMangledFilename(filePath: string): boolean {
    return filePath.includes('�');
}
