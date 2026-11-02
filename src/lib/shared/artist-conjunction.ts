// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * THE definition of "this artist name carries a collaboration marker", as one
 * structural table rendered into every dialect that needs it.
 *
 * Two places act on this heuristic and they are not the same weight:
 *
 *  - `buildArtistUnsplitFragment` (`music-hygiene.queries.ts`) COUNTS and LISTS
 *    the rows in the admin media browser.
 *  - `findCollaborationArtists` (`artist-merge.queries.ts`) feeds the pass that
 *    MERGES and SPLITS real artist rows.
 *
 * Their doc comments have claimed to mirror each other since both were written,
 * and until `08c9bcdf1` nothing enforced it. Both spelled the symbol branch
 * `<space>*[&+]<space>*` — zero-or-more on each side, which reduces to "the name
 * contains an `&` or a `+` ANYWHERE". The band `+44` was therefore listed as a
 * combined artist AND queued for splitting, in the one catalogue where `+`, `-`
 * and `=` are symbol-only album fixtures. A false positive here does not cost
 * one row; it costs the operator's trust in every count on the page.
 *
 * ## Why a shared SOURCE STRING and not a shared query fragment
 *
 * The single-source-of-truth that would be ideal — both queries importing one
 * `sql` fragment — is not available. The two call sites differ in scope on
 * purpose (`findCollaborationArtists` adds `parent_id IS NULL` and its own
 * `status` check; the hygiene fragment inherits the browser's base population,
 * which also applies `has_files`), and interpolating a JS string into a
 * postgres.js tagged template turns the pattern into a BIND PARAMETER, changing
 * the emitted SQL of two shipped queries to buy a refactor. `sql.unsafe` would
 * keep the text but throw away the injection guarantee for a composed fragment.
 *
 * So the queries keep their literals and this module owns the DEFINITION. The
 * link is asserted in the blocking tier, both directions:
 *
 *  - `music-hygiene.queries.test.ts` and `artist-merge.queries.test.ts` assert
 *    each query's emitted SQL contains this module's rendering verbatim, so
 *    editing a regex in either file without editing this table fails CI.
 *  - `artist-conjunction.test.ts` compiles the SAME rendering to a JS `RegExp`
 *    and drives the semantics table (`+44` must not flag, `Soren & Fenwick`
 *    must). That is what the integration tier used to be the only home for, and
 *    the integration tier gates nothing: `package.json`'s `test` script excludes
 *    `*.integration.test.ts` and CI's `integration-tests` job is
 *    `continue-on-error: true`.
 *
 * The residual gap is honest and small: the semantics table runs on the JS regex
 * engine, not Postgres's ARE. It is exact for the constructs used here — `\s`,
 * `[&+]`, `[.]`, `?`, `|`, and ASCII case folding all behave identically in both
 * — but a construct that does NOT (a POSIX class, a back-reference, a
 * collation-sensitive range) must not be added to this table without moving the
 * proof back to the integration tier. See `reference_pg_between_a_and_z_is_
 * collation_aware`: `BETWEEN 'A' AND 'Z'` matches 'Ä' in Postgres and not in JS.
 */

/**
 * One marker word, plus whether an abbreviating full stop may follow it.
 *
 * "und" and "and" are only CANDIDATE filters. Since the scanner stopped
 * splitting ambiguous joiners unconditionally (`artist-credit.ts`), an "A and
 * B" credit is stored as one row and this pass is what decides it — so "and"
 * has to be matched here, or "Rowan And Cian"-style rows could never be split
 * even when the library proves the parts separate. The decision itself is
 * evidence-based, so "Ich und Ich", "Earth, Wind and Fire" and "Florence and
 * the Machine" survive the merge although they match.
 */
interface ConjunctionWord {
    word: string;
    /** `feat` / `feat.` — an optional literal dot, never the "any character" dot. */
    abbreviated: boolean;
}

/**
 * Keep in sync with `ARTIST_COLLAB_SEPARATOR` (audio-processor). A marker the
 * scanner splits on but this table omits leaves every row created BEFORE that
 * marker was added combined forever, because the merge pass is the only thing
 * that retro-splits already-stored artists. That is exactly what happened to
 * " x ": the scanner learned it, the query did not.
 */
const CONJUNCTION_WORDS: readonly ConjunctionWord[] = [
    { word: 'feat', abbreviated: true },
    { word: 'ft', abbreviated: true },
    { word: 'featuring', abbreviated: false },
    { word: 'vs', abbreviated: true },
    // Space-flanking is what keeps this from matching inside "Lanternxman".
    { word: 'x', abbreviated: false },
    { word: 'und', abbreviated: false },
    { word: 'and', abbreviated: false },
];

/** The symbol markers, as a character class. Matched case-sensitively (`~`). */
const CONJUNCTION_SYMBOL_CLASS = '[&+]';

/**
 * How one regex dialect spells the two constructs the markers need.
 *
 * `posix` is what `music-hygiene.queries.ts` writes; `ere` is what
 * `artist-merge.queries.ts` writes and what JS understands. They are two
 * spellings of one pattern, which is why a verbatim text compare between the two
 * query files could only ever assert that they are spelled differently.
 *
 * `dot` is a LITERAL full stop in both. Note that `ere.dot` is a single
 * backslash followed by a dot at RUNTIME; inside a tagged-template SQL string it
 * has to be written `\\.`, because JS strips the unrecognised escape `\.` down
 * to `.` — "any character" — before Postgres ever sees it. That trap has been
 * hit twice in this series.
 */
interface ConjunctionDialect {
    space: string;
    dot: string;
}

const POSIX_DIALECT: ConjunctionDialect = { space: '[[:space:]]', dot: '[.]' };
const ERE_DIALECT: ConjunctionDialect = { space: '\\s', dot: '\\.' };

function renderWordBranch(dialect: ConjunctionDialect): string {
    const atoms = CONJUNCTION_WORDS.map((mk) =>
        mk.abbreviated ? `${mk.word}${dialect.dot}?` : mk.word,
    );
    return `${dialect.space}+(${atoms.join('|')})${dialect.space}+`;
}

function renderSymbolBranch(dialect: ConjunctionDialect): string {
    return `${dialect.space}+${CONJUNCTION_SYMBOL_CLASS}${dialect.space}+`;
}

/**
 * BOTH branches require whitespace on BOTH sides. `+` not `*` is the whole
 * point: see the module header.
 */
export const CONJUNCTION_WORD_REGEX_POSIX = renderWordBranch(POSIX_DIALECT);
export const CONJUNCTION_SYMBOL_REGEX_POSIX = renderSymbolBranch(POSIX_DIALECT);
export const CONJUNCTION_WORD_REGEX_ERE = renderWordBranch(ERE_DIALECT);
export const CONJUNCTION_SYMBOL_REGEX_ERE = renderSymbolBranch(ERE_DIALECT);

/** `~*` on the word branch (case-insensitive), plain `~` on the symbol branch. */
const WORD_MATCHER = new RegExp(CONJUNCTION_WORD_REGEX_ERE, 'i');
const SYMBOL_MATCHER = new RegExp(CONJUNCTION_SYMBOL_REGEX_ERE);

/**
 * Whether an artist name carries a collaboration marker — the `OR` of the two
 * branches, ignoring the `no_split` escape hatch.
 *
 * This is a HEURISTIC and no surface may present its output as a defect list.
 * "Above & Lanterns" is one act, "Aria Fenwick & Nora Vale" is two, and no
 * string-only test separates them; a real library always has correct rows here.
 */
export function hasArtistConjunctionMarker(title: string): boolean {
    return WORD_MATCHER.test(title) || SYMBOL_MATCHER.test(title);
}

/** The `custom_metadata` key an operator sets to suppress a row permanently. */
export const ARTIST_NO_SPLIT_KEY = 'no_split';

/**
 * The full predicate both queries apply: a conjunction marker AND no operator
 * `no_split` flag.
 *
 * The flag is compared as a STRING against `'true'` because that is what the SQL
 * does — `COALESCE(custom_metadata->>'no_split', '') <> 'true'`, where `->>`
 * renders a jsonb `true` and a jsonb `"true"` identically. Treating it as
 * JS-truthy instead would suppress a row someone had flagged `false`.
 */
export function shouldFlagArtistForSplit(row: {
    title: string;
    custom_metadata?: Record<string, unknown> | null;
}): boolean {
    const flag = row.custom_metadata?.[ARTIST_NO_SPLIT_KEY];
    if (flag !== undefined && flag !== null && String(flag) === 'true') return false;
    return hasArtistConjunctionMarker(row.title);
}
