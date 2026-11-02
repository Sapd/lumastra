// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bound on any text that comes out of a media file's tags, an NFO or a provider
 * before it reaches a whitespace-led regex (artist-credit splitting, remix and
 * series-title cleanup, ...). An ID3v2 frame can be megabytes and music-metadata
 * does not collapse whitespace, so a 40 KB artist tag of spaces cost seconds per
 * call in `\s+feat\s+`-shaped patterns. Clamping once at the boundary bounds
 * every downstream regex, because the stored value is bounded too.
 */

/**
 * UTF-16 units kept of one tag string. Multi-artist credits of a compilation can
 * run to a couple of KB, so the cap is generous; real titles are far shorter.
 */
export const MAX_TAG_TEXT_LENGTH = 4096;

/** Where an over-long credit is cut by preference: between names, not inside one. */
const CUT_SEPARATORS = [';', '/', ',', ' & '];

/** A whitespace run this long is not text, it is padding or an attack. */
const LONG_WHITESPACE_RUN = /\s{9,}/g;

/** Collapse absurd whitespace runs to one space, then cap the length. */
export function clampTagText(value: string): string {
    const collapsed = value.length > 8 ? value.replace(LONG_WHITESPACE_RUN, ' ') : value;
    if (collapsed.length <= MAX_TAG_TEXT_LENGTH) return collapsed;
    let end = MAX_TAG_TEXT_LENGTH;
    // Cut after the last separator in the second half, so a long artist list
    // loses whole trailing names instead of ending mid-name.
    const kept = collapsed.slice(0, end);
    let cut = -1;
    for (const sep of CUT_SEPARATORS) cut = Math.max(cut, kept.lastIndexOf(sep));
    if (cut > end / 2) return kept.slice(0, cut).trimEnd();
    // Never end on half of a surrogate pair.
    const last = collapsed.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return collapsed.slice(0, end);
}
