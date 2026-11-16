// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Path segment sanitising for the web download queue (FAT32 / exFAT USB sticks).
 * The server already sanitises names; this is the client-side belt and braces
 * plus a per-folder collision suffix, because two different titles can sanitise
 * to the same name and the second would silently overwrite the first.
 */

const MAX_SEGMENT = 120;
// eslint-disable-next-line no-control-regex -- control characters are exactly what FAT forbids
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

function splitExt(name: string): { stem: string; ext: string } {
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || name.length - dot > 10) return { stem: name, ext: '' };
    return { stem: name.slice(0, dot), ext: name.slice(dot) };
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
    let clean = trimEnd(name.replace(FORBIDDEN, '_'));
    if (clean === '') clean = '_';
    if (clean.length > MAX_SEGMENT) {
        const { stem, ext } = splitExt(clean);
        clean = trimEnd(stem.slice(0, MAX_SEGMENT - ext.length)) + ext;
        if (clean === '' || clean === ext) clean = '_' + ext;
    }
    if (!used) return clean;

    let candidate = clean;
    let n = 1;
    while (used.has(candidate.toLowerCase())) {
        n += 1;
        const { stem, ext } = splitExt(clean);
        const suffix = ` (${n})`;
        const room = MAX_SEGMENT - ext.length - suffix.length;
        candidate = `${trimEnd(stem.slice(0, room))}${suffix}${ext}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}
