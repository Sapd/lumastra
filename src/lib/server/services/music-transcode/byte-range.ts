// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One `Range` header against a file of `size` bytes, per RFC 9110 §14.
 *
 * `ignore` is a header that is malformed or not a byte range — the server
 * must serve the whole file then, not refuse. A multi-range header gets its
 * first range as a single-part 206. Deliberately not the shared
 * `parseRangeHeader`: that one treats a garbage header like an
 * unsatisfiable one, lets `start > end` through to `createReadStream`, and
 * has no suffix form (`bytes=-N`).
 */
export function parseByteRange(
    header: string,
    size: number,
): { kind: 'ignore' } | { kind: 'unsatisfiable' } | { kind: 'range'; start: number; end: number } {
    const spec = /^\s*bytes\s*=\s*([^,]*)/i.exec(header)?.[1]?.trim();
    if (!spec) return { kind: 'ignore' };
    const suffix = /^-(\d+)$/.exec(spec);
    if (suffix) {
        const length = Number(suffix[1]);
        if (length === 0 || size === 0) return { kind: 'unsatisfiable' };
        return { kind: 'range', start: Math.max(0, size - length), end: size - 1 };
    }
    const bounded = /^(\d+)-(\d*)$/.exec(spec);
    if (!bounded) return { kind: 'ignore' };
    const start = Number(bounded[1]);
    // Only an explicit last byte before the first is invalid syntax; an open
    // end past the file is a range that simply starts too late (416).
    if (bounded[2] !== '' && Number(bounded[2]) < start) return { kind: 'ignore' };
    if (start >= size) return { kind: 'unsatisfiable' };
    const last = bounded[2] === '' ? size - 1 : Number(bounded[2]);
    return { kind: 'range', start, end: Math.min(last, size - 1) };
}
