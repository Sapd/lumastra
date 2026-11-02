// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared title-normalization regexes for remix/variant dedup in both the
 * metadata and sonic autoplay paths.
 *
 * Used as SQL `regexp_replace` patterns (Postgres ERE syntax, case-insensitive
 * via the `'gi'` flag). Applied as three successive passes:
 *
 *   Pass 1 — REMIX_TAG_REGEX:     bracket-wrapped tags
 *     "Song (Extended Mix)"   → "Song"
 *     "Track [Live Version]"  → "Track"
 *
 *   Pass 2 — DASH_REMIX_SUFFIX_REGEX: dash-separated suffixes
 *     "Rockstar - Radio Edit" → "Rockstar"
 *     "Song – Extended Mix"   → "Song"
 *
 *   Pass 3 — BARE_REMIX_SUFFIX_REGEX: un-bracketed, un-dashed bare suffixes
 *     "Rockstar Club Mix"     → "Rockstar"
 *     "Song Remastered"       → "Song"
 *
 * The three-pass approach is intentionally additive: each pass targets a
 * distinct syntactic convention found in real music libraries, so no single
 * regex needs to handle all cases and the risk of false-positive matches is
 * kept low per pass.
 *
 * IMPORTANT: REMIX_TAG_REGEX / DASH_REMIX_SUFFIX_REGEX / BARE_REMIX_SUFFIX_REGEX
 * and `normalizeTitle()` are dedup-KEY generators — their output feeds
 * partition keys and Set/Map membership across many callers. Their behavior
 * must stay stable; do not edit them when tuning `isVersionTagged()` below.
 *
 * Lives in `$lib/shared` because the pure-JS helpers (`normalizeTitle`,
 * `isVersionTagged`, `collapseTitleVariants`) are also used client-side
 * (e.g. grouping alternate versions in the /music search results); the file
 * must stay dependency-free so it works in both Node and the browser bundle.
 *
 * @module shared/music-title-normalize
 *
 * Remixer-credit extraction (linkable "(X Remix)" credits) lives in the
 * sibling module `remix-credit.ts`.
 */

/**
 * Version/variant marker keywords — remix, edit, live, remaster, etc. These
 * denote a different RECORDING/ARRANGEMENT of the same song and are the
 * signal `isVersionTagged()` looks for.
 */
const VERSION_TAG_KEYWORDS =
    'remix|rmx|mix|edit|version|remaster|live|acoustic|instrumental|radio|extended|club|dub|vip|bootleg';

/**
 * Featuring-credit keywords. These denote a GUEST CREDIT, not a different
 * version of the track, so they must never contribute to `isVersionTagged()`
 * — "Song (feat. X)" is the same original recording as "Song".
 */
const FEAT_TAG_KEYWORDS = 'feat\\.|ft\\.|featuring';

/** Combined keyword set — preserves normalizeTitle's original behavior. */
const ALL_TAG_KEYWORDS = `${VERSION_TAG_KEYWORDS}|${FEAT_TAG_KEYWORDS}`;

/**
 * Regex pattern to strip remix/version/feature tags from track titles.
 * Handles bracket-wrapped tags: "Song (Extended Mix)" → "Song".
 * Postgres ERE syntax for use with regexp_replace(..., 'gi').
 */
export const REMIX_TAG_REGEX = `\\s*[\\(\\[][^\\)\\]]*(?:${ALL_TAG_KEYWORDS}).*?[\\)\\]]`;

/**
 * Regex pattern to strip dash-separated remix suffixes NOT caught by
 * REMIX_TAG_REGEX (which requires brackets). Handles titles like:
 * "Rockstar - Radio Edit", "Song – Extended Mix", "Track — Club Version".
 * Applied as a second pass after REMIX_TAG_REGEX.
 * Postgres ERE syntax for use with regexp_replace(..., 'gi').
 */
export const DASH_REMIX_SUFFIX_REGEX = `\\s*[-\\u2013\\u2014]\\s*.*(?:${ALL_TAG_KEYWORDS}).*$`;

/**
 * Regex pattern to strip un-bracketed, un-dashed bare suffixes NOT caught
 * by the above two passes. Catches common forms like:
 * "Rockstar Club Mix" → "Rockstar", "Song Remastered" → "Song".
 * End-anchored so it only removes a TRAILING variant tag, not mid-title words.
 * Applied as a third pass after DASH_REMIX_SUFFIX_REGEX.
 * Postgres ERE syntax for use with regexp_replace(..., 'gi').
 *
 * Contains only version keywords (no feat./ft./featuring) — bare, un-bracketed
 * featuring credits aren't a real-world convention, so this list was never
 * shared with the feat side.
 */
export const BARE_REMIX_SUFFIX_REGEX =
    '\\s+(?:remix|rmx|club\\s+mix|radio\\s+edit|extended\\s+mix|remaster(?:ed)?|live|acoustic|instrumental)\\s*$';

/**
 * Apply all three title-normalization passes to a raw title string (JavaScript
 * runtime, for post-fetch filtering when SQL-level dedup is not available).
 *
 * Returns a lowercased, whitespace-trimmed stem.
 */
export function normalizeTitle(title: string): string {
    return title
        .replace(new RegExp(REMIX_TAG_REGEX, 'gi'), '')
        .replace(new RegExp(DASH_REMIX_SUFFIX_REGEX, 'gi'), '')
        .replace(new RegExp(BARE_REMIX_SUFFIX_REGEX, 'gi'), '')
        .trim()
        .toLowerCase();
}

// =============================================================================
// Version-tag-only detection (feat./ft./featuring excluded)
// =============================================================================

/**
 * Bracket-wrapped featuring-credit PHRASE, e.g. the "feat. Artist)" portion of
 * "(Radio Edit feat. Artist)". Strips only from the feat keyword through the
 * next closing bracket — NOT the whole enclosing tag — so a co-located
 * version marker earlier in the same tag survives the strip and is still
 * detectable afterward: "(Radio Edit feat. Artist)" → "(Radio Edit ".
 * Deliberately not anchored to "must follow an opening bracket": doing so
 * would need a lookbehind, which Postgres ARE doesn't support. In exchange,
 * a loose "feat." appearing outside any bracket but before an unrelated
 * closing bracket later in the title could over-strip — an accepted
 * trade-off since real titles overwhelmingly keep feat. credits inside their
 * own bracket/dash tag.
 * Postgres ERE syntax for use with regexp_replace(..., 'gi').
 */
export const FEAT_TAG_REGEX = `(?:${FEAT_TAG_KEYWORDS}).*?[\\)\\]]`;

/**
 * Dash-separated featuring-credit PHRASE, e.g. the "feat. Artist" portion of
 * "Song - Radio Edit feat. Artist". Strips only from the feat keyword to the
 * end of the string, preserving any version marker that precedes it:
 * "Song - Radio Edit feat. Artist" → "Song - Radio Edit ".
 * Postgres ERE syntax for use with regexp_replace(..., 'gi').
 */
export const FEAT_DASH_SUFFIX_REGEX = `(?:${FEAT_TAG_KEYWORDS}).*$`;

/**
 * Version keywords used ONLY by isVersionTagged's word-boundary-aware
 * detection patterns below — never by the stripping regexes above (those
 * are dedup-key generators and must stay stable). "remaster" gets an
 * explicit optional "ed" suffix here, matching the inflected form
 * BARE_REMIX_SUFFIX_REGEX already special-cases, so "Remastered" still
 * detects as version-tagged even with a strict trailing word boundary.
 * Every other keyword requires an exact word match, so "edit" doesn't fire
 * inside "Edition"/"credit" and "mix" doesn't fire inside "Mixtape".
 */
const VERSION_TAG_KEYWORDS_DETECTION =
    'remix|rmx|mix|edit|version|remaster(?:ed)?|live|acoustic|instrumental|radio|extended|club|dub|vip|bootleg';

/**
 * Trailing word-boundary assertion. Postgres ARE supports lookahead (`(?!`)
 * but NOT lookbehind, so boundaries are expressed as: a leading boundary is
 * built into the match itself (see the consumed "non-letter-or-start" prefix
 * group below) rather than asserted via lookbehind, and only this trailing
 * lookahead is used for the end of the keyword. No lookbehind appears
 * anywhere in this file.
 */
const NOT_FOLLOWED_BY_LETTER = '(?![a-zA-Z])';

/**
 * Bracket-wrapped version tag, version keywords only (no feat/ft/featuring),
 * with word boundaries so a keyword must be its own word inside the bracket
 * — not a substring of a longer word ("Edition", "Mixtape"). The optional
 * leading group `(?:[^\)\]]*?[^a-zA-Z])?` either matches nothing (keyword
 * sits immediately after the opening bracket) or consumes prior bracket
 * content ending in a non-letter, so the keyword can never be glued to a
 * preceding letter — this is the lookbehind-free way to require a leading
 * boundary. Used to TEST (not strip) a title for a version marker once feat
 * credits have already been removed.
 */
const VERSION_ONLY_TAG_REGEX = `[\\(\\[](?:[^\\)\\]]*?[^a-zA-Z])?(?:${VERSION_TAG_KEYWORDS_DETECTION})${NOT_FOLLOWED_BY_LETTER}`;

/**
 * Dash-separated version suffix, version keywords only, with the same
 * word-boundary treatment as VERSION_ONLY_TAG_REGEX. Used to TEST (not
 * strip) a title for a version marker once feat credits have already been
 * removed.
 */
const VERSION_ONLY_DASH_SUFFIX_REGEX = `[-\\u2013\\u2014]\\s*(?:[^\\n]*?[^a-zA-Z])?(?:${VERSION_TAG_KEYWORDS_DETECTION})${NOT_FOLLOWED_BY_LETTER}`;

/**
 * Whole-title match for a title that IS exactly a bare version keyword
 * ("Remix", "Live", "Acoustic") with no surrounding words — not caught by
 * BARE_REMIX_SUFFIX_REGEX, which requires a preceding `\s+` (i.e. at least
 * one other word before the keyword).
 */
const VERSION_ONLY_WHOLE_TITLE_REGEX = `^(?:${VERSION_TAG_KEYWORDS_DETECTION})$`;

/**
 * SQL-safe (Postgres ARE) alternation of all four version-only test
 * patterns, for a single `~*` match against a title that has already had its
 * feat./ft./featuring credit stripped (see FEAT_TAG_REGEX / FEAT_DASH_SUFFIX_REGEX).
 * Mirrors `isVersionTagged()` for use directly inside a SQL `ORDER BY`/`CASE`.
 * Callers should COALESCE the title to '' first — `~*` against SQL NULL is
 * NULL (falsy in a boolean CASE), which would otherwise rank a NULL-titled
 * row as "preferred original".
 */
export const VERSION_ONLY_SQL_PATTERN = `(?:${VERSION_ONLY_TAG_REGEX})|(?:${VERSION_ONLY_DASH_SUFFIX_REGEX})|(?:${BARE_REMIX_SUFFIX_REGEX})|(?:${VERSION_ONLY_WHOLE_TITLE_REGEX})`;

/**
 * Trailing bracketed variant segment — the "(Radio Edit)" / "[Remix]" chunk
 * at the end of a title — for dedup-key generation via
 * `regexp_replace(..., 'g')`.
 *
 * MUST be bound as a query parameter, never written inline inside a sql``
 * template: postgres.js assembles query text from the template literal's
 * COOKED strings, where `\s` silently cooks to `s` and `\)` to `)`. An
 * inlined '\s*[\(\[].+[\)\]]\s*$' reaches Postgres as 's*[([].+[)]]s*$',
 * whose tail parses as "a `)` followed by a LITERAL `]`" — matching
 * virtually no real title, silently turning the dedup normalization into a
 * no-op (shipped bug: mood shelves showed "Blinding Lights (instrumental)"
 * AND "(Major Lazer remix)" side by side). Bound parameters bypass template
 * cooking entirely; the doubled backslashes below are plain JS string
 * escapes.
 */
export const TRAILING_VARIANT_SEGMENT_SQL_PATTERN = '\\s*[\\(\\[].+[\\)\\]]\\s*$';

/**
 * Whether a title carries a version/variant marker (remix, mix, edit, live,
 * acoustic, instrumental, radio edit, extended, club, dub, vip, bootleg,
 * remaster, version, rmx...).
 *
 * Featuring credits are NOT version markers: "Song (feat. X)" returns false.
 * Implemented by first stripping feat./ft./featuring PHRASES (bracketed or
 * dash-suffixed — not the whole enclosing tag, so a co-located version
 * marker like "Radio Edit" in "(Radio Edit feat. Artist)" survives and is
 * still detected), then testing the word-boundary-aware version-only
 * patterns against the remainder.
 */
export function isVersionTagged(title: string): boolean {
    const withoutFeat = title
        .replace(new RegExp(FEAT_TAG_REGEX, 'gi'), '')
        .replace(new RegExp(FEAT_DASH_SUFFIX_REGEX, 'gi'), '');
    return (
        new RegExp(VERSION_ONLY_TAG_REGEX, 'i').test(withoutFeat) ||
        new RegExp(VERSION_ONLY_DASH_SUFFIX_REGEX, 'i').test(withoutFeat) ||
        new RegExp(BARE_REMIX_SUFFIX_REGEX, 'i').test(withoutFeat) ||
        new RegExp(VERSION_ONLY_WHOLE_TITLE_REGEX, 'i').test(withoutFeat.trim())
    );
}

// =============================================================================
// Shared variant-collapse helper
// =============================================================================

/**
 * Collapse a candidate pool to one representative per normalized
 * title+artist-key group, preferring the untagged (original) title over a
 * remix/edit/live variant. Ties (equal taggedness) keep the existing order —
 * the first-seen candidate for a group wins, so for an already-shuffled
 * input the shuffle order is preserved; for a kNN/rank-ordered input the
 * original ordering is preserved.
 *
 * Generic over the caller's row shape via `getTitle`/`getArtistKey` — used by
 * both the genre-plan per-genre pool selection and the stations queue, so
 * the grouping logic has a single implementation.
 */
export function collapseTitleVariants<T>(
    items: T[],
    getTitle: (item: T) => string,
    getArtistKey: (item: T) => string,
): T[] {
    const bestByKey = new Map<string, { position: number; item: T }>();
    const keyOrder: string[] = [];

    for (const item of items) {
        const key = `${normalizeTitle(getTitle(item))}::${getArtistKey(item)}`;
        const existing = bestByKey.get(key);
        if (!existing) {
            bestByKey.set(key, { position: keyOrder.length, item });
            keyOrder.push(key);
            continue;
        }
        if (isVersionTagged(getTitle(existing.item)) && !isVersionTagged(getTitle(item))) {
            bestByKey.set(key, { position: existing.position, item });
        }
    }

    return keyOrder.map((key) => bestByKey.get(key)!.item);
}

// ---------------------------------------------------------------------------
// Novelty-cut detection (autoplay candidate filter)
// ---------------------------------------------------------------------------

/**
 * Titles that mark a track as a NOVELTY CUT — a version whose audio is not
 * representative of the song, and which nobody wants autoplay to serve them
 * unasked. Same intent as MUSIC_AUTOPLAY_MIN_TRACK_SECONDS (which keeps skits
 * and album intros out of the queue) but keyed on the title, because these run
 * to full length and sail past a duration floor.
 *
 * Scope is deliberately narrow — a cappella and karaoke only:
 *
 *   - A cappella cuts are voice-only, so their MSCLAP embedding describes a
 *     solo voice rather than the song's production, which makes them an
 *     unreliable nearest neighbour for anything vocal-forward. They also run
 *     to full length ("Hamma! (a cappella)" is 212s), so the duration floor
 *     that catches skits and intros never sees them.
 *
 *     NOTE ON EVIDENCE: this filter is justified by what an a cappella IS —
 *     a novelty version nobody wants served unasked — NOT by a measured
 *     retrieval failure. An earlier draft of this comment claimed such a cut
 *     was the top neighbour of a German-rap seed; that was inferred from an
 *     ARTIST name recurring at hop 1 and was never confirmed at the track
 *     level. Checked afterwards, the seed's top raw neighbours contained no
 *     a cappella at all. Excluding these did not measurably change genre
 *     drift. Don't cite this filter as a drift fix.
 *   - Karaoke cuts are backing tracks with the lead removed — same problem,
 *     plus nobody wants one served mid-session.
 *
 * "Instrumental" is deliberately NOT matched. An instrumental keeps the full
 * production minus the vocal, so its embedding is representative, and 309 of
 * this library's 24,240 tracks carry the word — many of them legitimately
 * (scores, electronic). Excluding them would be a far wider net than the
 * evidence supports; a cappella + karaoke together are 37 tracks (0.15%).
 *
 * NOT a hard exclusion from the library or from explicit playback — callers
 * apply this only when CHOOSING a track on the user's behalf.
 */
// "a cappella" is the correct spelling and the one tags least often use: the
// single-p "acapella" is the common misspelling, and single-l "acapela" turns
// up too. Matching only the double-p forms let the most frequent spelling of
// the thing this filter exists to catch straight through.
export const NOVELTY_CUT_REGEX = /(a[ -]?ca?pp?ell?a|karaoke)/i;

/** True when a title marks a novelty cut autoplay should not pick itself. */
export function isNoveltyCutTitle(title: string | null | undefined): boolean {
    if (!title) return false;
    return NOVELTY_CUT_REGEX.test(title);
}
