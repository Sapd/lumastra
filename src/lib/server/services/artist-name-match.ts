// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Artist-name normalisation and compound-name splitting.
 *
 * Shared by every enrichment source that has to decide "is the artist the
 * provider returned actually the artist we asked for?".
 *
 * WHY THIS IS STRICT. Some provider search endpoints (Deezer in particular)
 * are fuzzy and ALWAYS return something plausible-looking with a real photo
 * attached. Measured against 60 artists from a production library that
 * TheAudioDB/Discogs could not resolve, the top Deezer result was a DIFFERENT
 * artist in 16 of 60 cases — "Wildstyles" → "Wildstylez", "NOIZE" → "Boys
 * Noize", "Robert Prime" → "Robert Palmer", "Cre-Yo" → "Crazy Frog". Taking
 * the first result on trust would staple a stranger's face onto a fifth of
 * the artists it "fixed", and nothing downstream would ever flag it.
 *
 * Accept only equality after conservative punctuation normalisation. Search
 * queries may be broader, but never lower the candidate acceptance threshold.
 */

/** Fold case/encoding/whitespace without erasing joint-credit separators. */
function exactArtistName(name: string): string {
    return name.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Ignore apostrophes and dots within words; treat other punctuation as word
 * boundaries. Preserve diacritics and word boundaries: Niño is not Nino, and
 * D-Tune is not DTune. Comma/ampersand credits use exactArtistName instead.
 */
export function normalizeArtistName(name: string): string {
    return exactArtistName(name)
        .replace(/['’‘.]/g, '')
        .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/** Co-equal credits must match the full credit, including its separator. */
export function artistNamesMatch(a: string, b: string): boolean {
    if (/[,＆&]/u.test(a) || /[,＆&]/u.test(b)) {
        const exact = exactArtistName(a);
        return exact.length > 0 && exact === exactArtistName(b);
    }
    const na = normalizeArtistName(a);
    return na.length > 0 && na === normalizeArtistName(b);
}

/**
 * At most two searches: the original spelling, then a broader punctuation-free
 * query on a miss. Split merged capitals (DAgostino -> D Agostino), fold accents
 * for retrieval only, and retain every word. Never split a co-equal credit or
 * retry it loosely. Identical queries are not sent twice.
 */
export function artistSearchQueries(name: string): string[] {
    const original = name.trim();
    if (!original || !/[\p{L}\p{N}]/u.test(original)) return [];
    if (/[,＆&]/u.test(original)) return [original];
    const loose = original
        .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ');
    return loose && loose !== exactArtistName(original) ? [original, loose] : [original];
}

/**
 * Separators that mark a "lead artist + someone else" compound credit.
 *
 * `&` and `,` are deliberately ABSENT. Those join co-equal acts ("Soren &
 * Fenwick"), where showing only the first member's photo misrepresents the
 * group. The separators listed here all place a genuine lead act first:
 * `feat.`/`ft.` (guest), `presents`/`pres.` (alias project), `meets`, `vs.`,
 * `with`. Showing the lead's photo for those is defensible — it is the same
 * performer.
 *
 * Anchored on `\s+` either side so a name that merely CONTAINS one of these
 * words ("Meets The Eye", "Withard") is never split.
 */
const COMPOUND_SEPARATOR =
    /\s+(?:presents?|pres\.?|meets|feat\.?|featuring|ft\.?|vs\.?|versus|with)\s+/i;

/**
 * For a compound credit, return the lead artist's name; otherwise null.
 *
 * Used only as a LAST resort, after the full name has missed on every source,
 * so the extra provider round-trip is paid exclusively by the small set of
 * names that actually carry a separator (67 of 4,916 artists in the reference
 * library — 1.4%).
 */
export function leadArtistName(name: string): string | null {
    if (/[,＆&]/u.test(name)) return null;
    const parts = name.split(COMPOUND_SEPARATOR);
    if (parts.length < 2) return null;
    const lead = parts[0].trim();
    // A one-character lead ("A feat. B") is too weak to search on, and a lead
    // identical to the input means the split changed nothing.
    if (lead.length < 2 || normalizeArtistName(lead) === normalizeArtistName(name)) return null;
    return lead;
}
