// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Canonical "Various Artists" constant + matcher, shared between server and
 * client. The label is the exact string written into the database for the
 * synthetic compilation artist; `isVariousArtistsName` is the runtime check
 * used by caps, embedding text, station filters, and modal display logic.
 *
 * Keep this file dependency-free so it works in both Node and the browser
 * bundle.
 */

export const VARIOUS_ARTISTS_LABEL = 'Various Artists';
export const VARIOUS_ARTISTS_COVER_URL = '/placeholders/lumastra-various-artists.webp';

/**
 * Threshold for cleaning oversized legacy artist ROWS / track credit strings.
 * Album placement uses album-artist-rule.ts; a long credit must never override
 * an album's consistent ALBUMARTIST tag or a manual lock.
 */
export const COMPILATION_ARTIST_THRESHOLD = 6;

const VA_NAME_PATTERN = /^(va|v\.a\.?|v\/a|various(\s+artists?)?)$/i;
const VA_SLASH_SUFFIX_PATTERN = /[/\\]\s*(va|v\.a\.?|various(\s+artists?)?)\s*$/i;

/**
 * Scene/ripper release names written into ALBUMARTIST, where the VA marker is a
 * PREFIX on a release title rather than the whole value:
 *
 *   "VA - Future Trance Vol 61 (2012)"
 *   "VA-Technobase.FM.Vol.22-3CD-2018-VOiCE"
 *   "VA.-.Technobase.FM.Vol.27-WEB-2020-ZzZz"
 *   "Various Artists - Bravo Hits 100"
 *
 * Deliberately narrow, because a false positive here is destructive: this
 * predicate gates diversity caps, station filters, embedding text and display,
 * so a real band misread as VA is misclassified everywhere at once.
 *
 * Two guards keep it tight:
 *
 *   1. The short aliases (VA / V.A. / V/A) must be UPPERCASE. Scene releases
 *      always capitalize them, whereas a lowercase "va-" opens the door to real
 *      names like "Va-Va Voom". Only the unambiguous full form
 *      ("Various Artists") is matched case-insensitively.
 *   2. A DASH must follow (optionally dot-wrapped, as in "VA.-."). A plain
 *      space is not enough — that is what keeps "Various Cruelties" out, the
 *      same band the whole-string pattern above was written to protect.
 */
const VA_RELEASE_SEPARATOR = String.raw`\s*\.?\s*[-–—]\s*\.?\s*\S`;
/** Short aliases — case-SENSITIVE (uppercase only), see guard 1 above. */
const VA_SHORT_RELEASE_PREFIX_PATTERN = new RegExp(`^(?:VA|V\\.A\\.?|V/A)${VA_RELEASE_SEPARATOR}`);
/** Full form — unambiguous, so case-insensitive is safe here. */
const VA_LONG_RELEASE_PREFIX_PATTERN = new RegExp(
    `^various\\s+artists?${VA_RELEASE_SEPARATOR}`,
    'i',
);

/**
 * Curated localized "Various Artists" labels written by foreign taggers
 * (Picard, etc.). Canonical source of truth — every SQL site that needs these
 * (migration, health invariant, scanner self-heal) inlines the SAME strings
 * NFC-normalized and matched EXACTLY (never ASCII-folded: folding mangles
 * "Çeşitli Sanatçılar" → "eitli sanatlar"). Whole-string members only, so real
 * bands like "Various Cruelties" are not swept in.
 */
export const VARIOUS_ARTISTS_ALIASES: readonly string[] = [
    'Çeşitli Sanatçılar', // Turkish
    'Verschiedene Interpreten', // German
    'Varios Artistas', // Spanish
    'Vários Artistas', // Portuguese
    'Artistes Divers', // French
    'Multi-interprètes', // French
    'Artisti Vari', // Italian
    'Verschillende Artiesten', // Dutch
    'Различные исполнители', // Russian
].map((s) => s.normalize('NFC'));

const VARIOUS_ARTISTS_ALIAS_SET = new Set(VARIOUS_ARTISTS_ALIASES.map((s) => s.toLowerCase()));

/**
 * True when `name` matches the "Various Artists" marker (canonical label,
 * common aliases like "VA"/"V.A."/"Various", or localized aliases written by
 * foreign taggers: Turkish, German, Spanish, Portuguese, French, Italian,
 * Dutch, Russian). Empty/null returns false — callers should treat those as
 * "unknown", not as VA.
 */
export function isVariousArtistsName(name: string | null | undefined): boolean {
    if (!name) return false;
    const trimmed = name.trim();
    if (trimmed.length === 0) return false;
    if (
        VA_NAME_PATTERN.test(trimmed) ||
        VA_SLASH_SUFFIX_PATTERN.test(trimmed) ||
        VA_SHORT_RELEASE_PREFIX_PATTERN.test(trimmed) ||
        VA_LONG_RELEASE_PREFIX_PATTERN.test(trimmed)
    )
        return true;
    return VARIOUS_ARTISTS_ALIAS_SET.has(trimmed.normalize('NFC').toLowerCase());
}
