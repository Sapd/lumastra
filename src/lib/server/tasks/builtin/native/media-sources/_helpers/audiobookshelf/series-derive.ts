// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Derive a grouping key (series + position) for an AudiobookShelf item.
 *
 * AudiobookShelf's own `seriesName` is unreliable in practice. Measured against a
 * real 1188-item server (2026-07-29): a 666-item radio-play library had 81% of
 * items with an EMPTY `seriesName`, with the numbering living in the title
 * (`"65 - Als der Meister sich verlor"`) — while 537 of those 538 items sat in a
 * multi-item folder whose name IS the series (`"Die Sieben Laternenzeichen ???"`).
 * Grouping on `seriesName` alone would leave most of that library as a flat wall
 * of cards sorted by leading digit.
 *
 * So the key is a fallback chain: explicit series → folder → nothing.
 *
 * ## Locale neutrality
 *
 * Lumastra ships open source, so none of these rules may assume a language or a
 * script. What we rely on is structural, not linguistic:
 *
 * - the `#N` suffix is AudiobookShelf's own convention, not a word;
 * - `dirname` is a filesystem property;
 * - a leading integer is positional.
 *
 * Nothing here matches on German or English tokens ("Folge", "Volume", "Part",
 * "Band", …) precisely because that list is unbounded and would silently favour
 * whichever languages we happened to think of. An input matching no rule yields
 * `sequence: null` rather than a guess — a missing position is recoverable, a
 * wrong one silently misorders a shelf.
 *
 * Digits are matched with `\p{Nd}` (Unicode decimal digits) rather than `[0-9]`,
 * so Eastern Arabic and Devanagari numerals parse too.
 */

/** Where the series name came from. Surfaced for admin/debugging, not for display. */
export type SeriesSource = 'abs-series' | 'folder' | 'none';

export interface DerivedSeries {
    /** Human-readable series name, or null when the item is standalone. */
    name: string | null;
    /** Position within the series, or null when no position could be read. */
    sequence: number | null;
    /** Which rule produced `name`. */
    source: SeriesSource;
}

export interface SeriesDeriveInput {
    /** `media.metadata.seriesName` — may carry an embedded `#N`, may be absent. */
    seriesName?: string | null;
    /** `media.metadata.series[].sequence` when AudiobookShelf provides it structurally. */
    absSequence?: string | number | null;
    /** Item title, used only as a last resort for the position. */
    title?: string | null;
    /** `relPath` — the item's path relative to its library folder. */
    relPath?: string | null;
}

/**
 * Trailing `#N` that AudiobookShelf appends to a combined series label, e.g.
 * `"Erweitertes Jack-Ryan-Universum (in Veröffentlichungsreihenfolge) #9"`.
 * Allows a decimal (`#2.5` is a real convention for interquels).
 */
const TRAILING_HASH_SEQUENCE = /\s*#(\p{Nd}+(?:[.,]\p{Nd}+)?)\s*$/u;

/**
 * The same trailing `#` field when AudiobookShelf put a LABEL in it rather than a
 * bare number, e.g. `"Milo Farrow #Book 3"` — measured on a production shelf,
 * where that item carried `series[0].name = "Milo Farrow #Book 3"` and
 * `sequence: null`, so it was stranded in a one-book "series" of its own AND lost
 * its position, while books 1, 2 and 5 grouped correctly under "Milo Farrow".
 *
 * Still structural, not linguistic: `\p{L}` matches "any letters", never a
 * specific word like "Book" / "Band" / "Tome". What it will NOT do is swallow a
 * `#` that belongs to the name — the digits must run to the END, so
 * `"Nr. #1 Detektei"` keeps its `#1` (trailing text after the number ⇒ no match)
 * and only the whole-string form is treated as a sequence field.
 */
const TRAILING_HASH_LABELLED_SEQUENCE = /\s*#\s*\p{L}+[\s.\-–—_:]*(\p{Nd}+(?:[.,]\p{Nd}+)?)\s*$/u;

/**
 * A leading integer used as a position, e.g. `"65 - Als der Meister sich verlor"`.
 *
 * A punctuation separator is REQUIRED. Accepting bare whitespace would turn
 * `"2001 A Harbor Journey"` into position 2001 and `"1984"` into 1984 — real
 * titles silently mis-ordering a shelf. Missing a position is recoverable; a
 * wrong one is not.
 */
const LEADING_SEQUENCE = /^\s*(\p{Nd}+)\s*[-–—._:)\]/]/u;

const IS_DECIMAL_DIGIT = /^\p{Nd}$/u;

/**
 * Positions at or above this are treated as years, not series positions.
 * Only applies to the title fallback — an explicit `#N` or a structural
 * AudiobookShelf sequence is trusted at any magnitude.
 */
const TITLE_SEQUENCE_CEILING = 1000;

/**
 * Numeric value of a single Unicode decimal digit, for any script.
 *
 * `Number.parseFloat` only understands ASCII, so `"٦٥"` (Eastern Arabic) parses
 * as NaN even though `\p{Nd}` matched it. Unicode lays decimal digit blocks out
 * as ten contiguous code points starting at zero, so walking back to the block
 * start gives the value. The walk is capped at nine steps so two adjacent blocks
 * can never be conflated.
 */
function digitValue(codePoint: number): number | null {
    let zero = codePoint;
    for (let step = 0; step < 9; step++) {
        const previous = String.fromCodePoint(zero - 1);
        if (!IS_DECIMAL_DIGIT.test(previous)) break;
        zero--;
    }
    const value = codePoint - zero;
    return value >= 0 && value <= 9 ? value : null;
}

/** Rewrite any-script decimal digits to ASCII, leaving everything else alone. */
function toAsciiDigits(raw: string): string {
    let out = '';
    for (const char of raw) {
        if (IS_DECIMAL_DIGIT.test(char)) {
            const value = digitValue(char.codePointAt(0)!);
            if (value === null) return raw;
            out += String(value);
        } else {
            out += char;
        }
    }
    return out;
}

/**
 * Parse a numeric string that may use either `.` or `,` as the decimal mark and
 * may be written in any script's decimal digits.
 */
function parseNumber(raw: string): number | null {
    const n = Number.parseFloat(toAsciiDigits(raw).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

/**
 * Split a combined series label into its name and embedded position.
 * Returns the input unchanged when there is no `#N` suffix.
 */
export function splitSeriesLabel(label: string): { name: string; sequence: number | null } {
    // Bare `#N` first — the common form, and the stricter pattern of the two.
    const match = TRAILING_HASH_SEQUENCE.exec(label) ?? TRAILING_HASH_LABELLED_SEQUENCE.exec(label);
    if (!match) return { name: label.trim(), sequence: null };
    return {
        name: label.slice(0, match.index).trim(),
        sequence: parseNumber(match[1]),
    };
}

/**
 * Read a leading position from a title.
 *
 * Deliberately requires a separator after the digits, so `"1984"` (a title) does
 * not become position 1984, while `"65 - Als der Meister sich verlor"` does
 * become 65.
 */
export function sequenceFromTitle(title: string): number | null {
    const match = LEADING_SEQUENCE.exec(title);
    if (!match) return null;
    const value = parseNumber(match[1]);
    if (value === null) return null;

    // A leading four-digit number is far more likely a year than a position —
    // an omnibus title like "1984 / Animal Farm" would otherwise sort as #1984.
    // Measured on a real 1188-item server the highest genuine position was 219
    // and nothing parsed above 999, so the bound costs nothing there while
    // protecting libraries we have not seen. Failing to a missing position is
    // recoverable; a wrong one silently misorders a shelf.
    return value >= TITLE_SEQUENCE_CEILING ? null : value;
}

/**
 * The folder immediately containing the item, which for foldered libraries is
 * the series. Handles both separators, since `relPath` originates on the
 * AudiobookShelf host and may not match this process's platform.
 *
 * Returns null for an item sitting at the library root — a top-level file is a
 * standalone book, not a one-item series.
 */
export function folderSeriesName(relPath: string): string | null {
    const normalised = relPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const lastSlash = normalised.lastIndexOf('/');
    if (lastSlash <= 0) return null;

    const parent = normalised.slice(0, lastSlash);
    const leaf = parent.slice(parent.lastIndexOf('/') + 1).trim();
    return leaf.length > 0 ? leaf : null;
}

/**
 * Resolve the grouping key for one item.
 *
 * The position is resolved independently of the name: a book can take its series
 * from the folder while taking its position from the title, which is precisely
 * the common radio-play case.
 */
export function deriveSeries(input: SeriesDeriveInput): DerivedSeries {
    const rawLabel = input.seriesName?.trim() ?? '';

    let name: string | null = null;
    let source: SeriesSource = 'none';
    let sequence: number | null = null;

    if (rawLabel.length > 0) {
        const split = splitSeriesLabel(rawLabel);
        if (split.name.length > 0) {
            name = split.name;
            source = 'abs-series';
            sequence = split.sequence;
        }
    }

    if (name === null && input.relPath) {
        const folder = folderSeriesName(input.relPath);
        if (folder) {
            name = folder;
            source = 'folder';
        }
    }

    // A structural sequence from AudiobookShelf beats anything we parsed.
    if (input.absSequence !== undefined && input.absSequence !== null) {
        const explicit =
            typeof input.absSequence === 'number'
                ? Number.isFinite(input.absSequence)
                    ? input.absSequence
                    : null
                : parseNumber(String(input.absSequence).trim());
        if (explicit !== null) sequence = explicit;
    }

    // Last resort, and only for an item we actually placed in a series.
    if (sequence === null && name !== null && input.title) {
        sequence = sequenceFromTitle(input.title);
    }

    return { name, sequence, source };
}

/**
 * `media_items.sort_order` is an integer column, but series positions are
 * occasionally fractional (`#2.5`). Scale by 1000 so interquels keep their place
 * between neighbours, and clamp so a nonsense upstream value cannot overflow.
 */
export const SORT_ORDER_SCALE = 1000;
const SORT_ORDER_MAX = 2_000_000_000;

export function sequenceToSortOrder(sequence: number | null): number | null {
    if (sequence === null || !Number.isFinite(sequence) || sequence < 0) return null;
    const scaled = Math.round(sequence * SORT_ORDER_SCALE);
    return Math.min(scaled, SORT_ORDER_MAX);
}
