// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Path segment sanitising for the web download queue (FAT32 / exFAT USB sticks).
 * The server already sanitises names; this is the client-side belt and braces
 * plus a per-folder collision suffix, because two different titles can sanitise
 * to the same name and the second would silently overwrite the first.
 */

const MAX_SEGMENT = 120;
/** exFAT / ext4 / eCryptfs-style limits count bytes: 200 leaves room for a collision suffix. */
const MAX_SEGMENT_BYTES = 200;
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;
// eslint-disable-next-line no-control-regex -- control characters are exactly what FAT forbids
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

function splitExt(name: string): { stem: string; ext: string } {
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || name.length - dot > 10) return { stem: name, ext: '' };
    return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Cut to at most n UTF-16 units without splitting a surrogate pair. */
function truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    let cut = n;
    const last = s.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    return s.slice(0, cut);
}

/** Cut to at most n UTF-8 bytes on a code point boundary (never splits a surrogate pair). */
function truncateBytes(s: string, n: number): string {
    if (n <= 0) return '';
    let bytes = 0;
    let out = '';
    for (const ch of s) {
        const b = utf8Bytes(ch);
        if (bytes + b > n) break;
        bytes += b;
        out += ch;
    }
    return out;
}

/** stem + suffix + ext within both the character and the byte cap; the extension is kept. */
function fit(stem: string, suffix: string, ext: string): string {
    const charRoom = MAX_SEGMENT - ext.length - suffix.length;
    const byteRoom = MAX_SEGMENT_BYTES - utf8Bytes(ext) - utf8Bytes(suffix);
    const cut = trimEnd(truncateBytes(truncate(stem, charRoom), byteRoom));
    return `${cut}${suffix}${ext}`;
}

/** Windows (and exFAT readers on it) refuse CON, NUL, COM1 ... even with an extension. */
function avoidReserved(name: string): string {
    const dot = name.indexOf('.');
    const first = dot === -1 ? name : name.slice(0, dot);
    if (!RESERVED.test(first)) return name;
    return dot === -1 ? `${name}_` : `${first}_${name.slice(dot)}`;
}

function trimEnd(s: string): string {
    return s.replace(/[. ]+$/, '');
}

/**
 * @param used Names already taken in the same folder (compared case-insensitively).
 *   When given, a collision gets " (2)", " (3)" ... before the extension and the
 *   result is added to the set.
 */
export function sanitizePathSegment(name: string, used?: Set<string>): string {
    let clean = avoidReserved(trimEnd(name.replace(FORBIDDEN, '_')));
    if (clean === '') clean = '_';
    if (clean.length > MAX_SEGMENT || utf8Bytes(clean) > MAX_SEGMENT_BYTES) {
        const { stem, ext } = splitExt(clean);
        clean = fit(stem, '', ext);
        if (clean === '' || clean === ext) clean = '_' + ext;
    }
    if (!used) return clean;

    let candidate = clean;
    let n = 1;
    while (used.has(candidate.toLowerCase())) {
        n += 1;
        const { stem, ext } = splitExt(clean);
        candidate = fit(stem, ` (${n})`, ext);
    }
    used.add(candidate.toLowerCase());
    return candidate;
}
