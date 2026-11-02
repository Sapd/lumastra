// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The single sanitiser for user- and client-supplied DISPLAY LABELS.
 *
 * Covers the labels a caller gets to name: device and client names from the
 * `/j` and `/subsonic` compat headers, playlist names and comments, API-token
 * names. They share a shape — free text, attacker-chosen, persisted, then
 * rendered somewhere later, often to a *different* user or to an admin.
 *
 * Svelte escapes `{...}` interpolation and the XML serializer escapes entities,
 * so this is NOT the defence against script injection — those sinks already
 * hold. What escaping does nothing about, and what this handles:
 *
 *   - **Bidi spoofing.** U+202E (RLO) reverses rendered order, so a hostile
 *     label can be made to read exactly like a familiar one in a device list.
 *   - **Invisible padding.** Zero-width characters make two different entries
 *     render identically, so one can impersonate another.
 *   - **Unbounded length.** A megabyte-long playlist name is a layout and
 *     storage problem on every surface that shows it.
 *   - **Control characters.** Illegal in XML output, and noise anywhere else.
 *
 * Applied at the boundary where the value enters, so every downstream consumer
 * (DB, cache, UI, XML) gets the clean value without each having to remember.
 */

/**
 * Written as escapes — the literals are invisible or control codes:
 *   U+0000-U+001F, U+007F-U+009F  C0/C1 controls
 *   U+200B-U+200D, U+FEFF         zero-width. Includes ZWNJ/ZWJ, which are
 *                                 treated as spoofing vectors here. KNOWN
 *                                 TRADE-OFF: ZWNJ is orthographically required
 *                                 in Persian (می‌روم loses meaning without it)
 *                                 and ZWJ composes emoji, so a label in those
 *                                 scripts is altered. Accepted deliberately —
 *                                 see the grapheme-safe truncation tests.
 *   U+200E-U+200F, U+202A-U+202E, U+2066-U+2069   bidi overrides
 */
const UNSAFE_DISPLAY_CHARS =
    // eslint-disable-next-line no-control-regex -- deliberately matching control chars
    /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Matches the `max(255)` the REST playlist endpoint already enforces. */
export const MAX_DISPLAY_NAME_LENGTH = 255;

/**
 * Segments by user-perceived character rather than UTF-16 code unit.
 *
 * Built once: this runs on every parsed auth header, and constructing a
 * Segmenter per call is not free.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Strip unsafe characters, collapse whitespace runs, and cap the length.
 *
 * Truncation appends `…` so a shortened label is visibly shortened rather than
 * silently different. Returns '' for input that sanitises away entirely —
 * callers decide whether that means "reject" or "fall back to a default".
 *
 * Length is counted in graphemes, not `String.length`. A plain `slice()` counts
 * UTF-16 code units, so a boundary landing inside an emoji leaves a lone
 * surrogate that becomes U+FFFD on the way to the database — silent corruption
 * rather than clean truncation. Graphemes also keep combining marks attached to
 * their base character instead of stranding them.
 *
 * Note ZWJ emoji sequences do NOT survive this function, and that is deliberate:
 * U+200D falls in the zero-width range stripped above, so 👨‍👩‍👧 is decomposed
 * into three separate emoji before truncation ever runs. Zero-width characters
 * are the spoofing vector this sanitiser exists to remove, and that outranks
 * rendering a family emoji faithfully in a device label.
 */
export function sanitizeDisplayName(
    value: string,
    maxLength: number = MAX_DISPLAY_NAME_LENGTH,
): string {
    const cleaned = value.replace(UNSAFE_DISPLAY_CHARS, '').replace(/\s+/g, ' ').trim();
    // Fast path: `length` in code units is an upper bound on the grapheme count,
    // so anything under the cap by that measure is definitely under it.
    if (cleaned.length <= maxLength) return cleaned;

    const graphemes = Array.from(GRAPHEMES.segment(cleaned), (s) => s.segment);
    if (graphemes.length <= maxLength) return cleaned;
    return graphemes.slice(0, maxLength).join('') + '…';
}
