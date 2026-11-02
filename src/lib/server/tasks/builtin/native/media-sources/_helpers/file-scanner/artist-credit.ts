// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Artist-credit splitting: turning one tag string ("Rob & Chris feat. Sandberg")
 * into the artist rows it credits.
 *
 * Two kinds of joiner, and they are not equally trustworthy:
 *
 *  - STRONG markers — " feat. ", " ft. ", " featuring ", " vs. ", " x " — always
 *    join distinct acts. They split without further evidence.
 *  - AMBIGUOUS joiners — " & ", " + ", " and ", " und " (and a comma inside such
 *    a group) — join two acts OR sit inside one act's name. "Santiano & Nathan
 *    Evans" is two artists; "Rob & Chris", "Harris & Ford", "Echo & the
 *    Bunnymen", "Earth, Wind & Fire" are one. No string-only rule separates
 *    them: on the production library, "every part is one word" matched 299 of
 *    881 distinct "&" credits and most of those were real hardstyle collabs
 *    ("Withard & Sonera", "Zany & Duro").
 *
 * What does separate them is the rest of the library. A name that is an artist
 * in its own right is credited WITHOUT its partner somewhere else — "Withard"
 * shows up with a dozen different partners, "Rob" never appears without
 * "Chris". So an ambiguous group is split only where the library's own tags
 * prove a part independent, and dependent neighbours are glued back together:
 * "Blasterjaxx & Harris & Ford" → ["Blasterjaxx", "Harris & Ford"].
 *
 * Getting it wrong is not symmetric. Keeping a real collab whole leaves one
 * extra artist row ("Drake & Future") — cosmetic. Splitting an act creates rows
 * like "Rob", "Chris", "W", "G", "The Bunnymen" that every unrelated track with
 * the same bare name then attaches to. So the default, without evidence, is to
 * keep the group whole.
 *
 * `parseArtistNames` is the evidence-free half (ambiguous groups stay whole);
 * `resolveArtistCredit` applies the evidence. Operator `no_split` flags and
 * NFO/MusicBrainz-identified artist rows are "known acts" and never split.
 */

/**
 * Always a boundary between two acts. Space-flanked so "Matrixxman" is safe.
 * The trailing space is a lookahead so a skipped " X" (see `isCollabX`) does
 * not swallow the space a following " x " needs.
 */
const STRONG_MARKER = /\s+(feat\.?|ft\.?|featuring|vs\.?|x)(?=\s)/gi;
/**
 * A joiner token right after an " x " marker (sticky: read at the marker's
 * end, never by slicing the rest). Not "and"/"und": "Axo x And One" is a
 * collab with the band "And One".
 */
const JOINER_AHEAD = /\s*(?:feat\.?|ft\.?|featuring|vs\.?|[&+])(?=\s|$)/iy;
/** A lowercase " x " right after an " x " marker. */
const LOWER_X_AHEAD = /\s*x(?=\s|$)/y;
/**
 * Joins two acts or sits inside one act's name. Whitespace on BOTH sides is
 * required: "W&W", "G&G", "Solid&Sound" are names, never joins.
 */
const AMBIGUOUS_JOINER = /\s+[&+]\s+|\s+(?:and|und)\s+/i;
/**
 * Atom boundaries inside an ambiguous group, captured so runs can be glued
 * back. An Oxford comma (", & ", ", and ") is ONE boundary — listed first, or
 * the plain comma wins and leaves "& Dieter" as an atom. Only a lowercase
 * ", and " / ", und ": "Foo, And One" credits the band "And One". Hence no /i
 * flag; the plain " and " is spelled case-insensitively.
 */
const AMBIGUOUS_ATOM_BOUNDARY =
    /(\s*,\s*(?:[&+]|and|und)\s+|\s+[&+]\s+|\s+(?:[Aa][Nn][Dd]|[Uu][Nn][Dd])\s+|\s*,\s*)/;
const AMBIGUOUS_ATOM_SPLIT =
    /\s*,\s*(?:[&+]|and|und)\s+|\s+[&+]\s+|\s+(?:[Aa][Nn][Dd]|[Uu][Nn][Dd])\s+|\s*,\s*/;
const COMMA_SEPARATOR = /\s*,\s*/;
const LEADING_ARTICLE = /^(?:the|der|die|das)\s+/i;

import { COMPILATION_ARTIST_THRESHOLD } from '$lib/shared/various-artists.js';
import { clampTagText } from '$lib/server/utils/tag-text.js';

/**
 * A part counts as an independent artist once it is credited without any of
 * its partners in at least this many distinct tags. One is not enough: bare
 * first names collide across unrelated acts ("Chris, Nora" is not the Chris of
 * "Rob & Chris"), and on the reference library one stray tag was exactly the
 * noise level that separated duos from collabs.
 */
export const INDEPENDENT_CREDIT_MIN_TAGS = 2;

/** Case-insensitive dedup preserving first occurrence + order. */
function dedupeNames(parts: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of parts) {
        const key = p.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            out.push(p);
        }
    }
    return out;
}

function splitTrimmed(value: string, separator: RegExp): string[] {
    return value
        .split(separator)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

/**
 * Whether the " x " marker ending at `end` joins two acts. An act's name can
 * END in "X" ("Ziggo X"), and then the marker is followed by the real joiner:
 * "Ziggo X & Bohold", "Ziggo X feat. Kilo", "Nova X Vs. Kaylo". Splitting
 * there made rows "& Bohold", "feat. Kilo", "Vs. Kaylo". So an x followed by
 * another joiner is part of the name. Two x in a row: a lowercase second one
 * is the joiner ("Ziggo X x DJ Seq"); otherwise the first is, as it always
 * was ("Axo x X Embassy", "AXO X X EMBASSY").
 */
function isCollabX(value: string, end: number): boolean {
    JOINER_AHEAD.lastIndex = end;
    if (JOINER_AHEAD.test(value)) return false;
    LOWER_X_AHEAD.lastIndex = end;
    return !LOWER_X_AHEAD.test(value);
}

/**
 * A part of a credit the strong markers split, trimmed. Also drops joiners
 * left dangling at either end by a malformed tag ("W, x Axo" → "W"), so they
 * never become an artist row of their own. Index scans, not regexes: a
 * `(\s*,)+$` is quadratic on a long comma run.
 */
function trimSplitPart(part: string): string {
    const isSpace = (c: string): boolean => /\s/.test(c);
    let from = 0;
    let to = part.length;
    for (;;) {
        while (from < to && isSpace(part[from])) from++;
        // A leading joiner only when whitespace follows it: "+44" is a name.
        if (from + 1 < to && ',&+'.includes(part[from]) && isSpace(part[from + 1])) {
            from++;
            continue;
        }
        break;
    }
    while (to > from && (isSpace(part[to - 1]) || part[to - 1] === ',')) to--;
    return part.slice(from, to);
}

/** Split at every strong marker (see `isCollabX` for the " x " exception). */
function splitStrong(value: string): string[] {
    const parts: string[] = [];
    let start = 0;
    for (const m of value.matchAll(STRONG_MARKER)) {
        // A marker right after a split starts the next name ("Axo x X Embassy").
        if (m.index === start && start > 0) continue;
        const end = m.index + m[0].length;
        if (/^x$/i.test(m[1]) && !isCollabX(value, end)) continue;
        parts.push(value.slice(start, m.index));
        start = end;
    }
    if (parts.length === 0) return value.trim() ? [value.trim()] : [];
    parts.push(value.slice(start));
    return parts.map(trimSplitPart).filter((s) => s.length > 0);
}

interface SplitDialect {
    strong(value: string): string[];
    atomBoundary: RegExp;
}

const CURRENT_DIALECT: SplitDialect = {
    strong: splitStrong,
    atomBoundary: AMBIGUOUS_ATOM_BOUNDARY,
};

/** Comparison key for a name or a whole tag. */
export function normalizeCreditName(name: string): string {
    return name.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Known-act comparison key: joiner-insensitive, so the tags "above und lanterns"
 * and "Above + Lanterns" are the act "Above & Lanterns" too.
 */
function actKey(name: string): string {
    return normalizeCreditName(name).replace(/\s+(?:[&+]|and|und)\s+/g, ' & ');
}

/** Whether a (strong-split) group contains an ambiguous joiner. */
export function isAmbiguousArtistGroup(group: string): boolean {
    return AMBIGUOUS_JOINER.test(clampTagText(group));
}

/**
 * Evidence-free split of an artist tag.
 *
 * 1. Strong markers split: "A feat. B" → ["A", "B"]. Each resulting group is
 *    kept whole — "Rob & Chris feat. Sandberg" → ["Rob & Chris", "Sandberg"].
 * 2. Without a strong marker, a group carrying an ambiguous joiner stays whole
 *    ("Rob & Chris", "Earth, Wind & Fire"); `resolveArtistCredit` decides it.
 * 3. Otherwise a comma list splits unless a part starts with a definite article
 *    ("Tyler, The Creator"). Identical parts dedupe, so a stray trailing comma
 *    ("A,") collapses to "A".
 *
 * Returns at least one entry for non-empty input.
 */
export function parseArtistNames(name: string): string[] {
    return parseWith(CURRENT_DIALECT, name);
}

function parseWith(dialect: SplitDialect, name: string): string[] {
    const trimmed = clampTagText(name).trim();
    if (!trimmed) return [];

    const groups = dedupeNames(dialect.strong(trimmed));
    if (groups.length > 1) return groups;
    if (groups.length === 0) return [trimmed];

    const group = groups[0];
    if (isAmbiguousArtistGroup(group)) return [group];

    const commaParts = dedupeNames(splitTrimmed(group, COMMA_SEPARATOR));
    if (commaParts.length > 1 && !commaParts.some((p) => LEADING_ARTICLE.test(p))) {
        return commaParts;
    }
    if (commaParts.length === 1) return [commaParts[0]];
    return [group];
}

/**
 * Every name a tag could possibly credit: strong split, then each group split
 * at every ambiguous joiner and comma. The upper bound on distinct artists —
 * what compilation detection counts, and what the evidence index is built from.
 */
export function atomizeArtistCredit(name: string): string[] {
    return splitStrong(clampTagText(name).trim()).flatMap((group) =>
        splitTrimmed(group, AMBIGUOUS_ATOM_SPLIT),
    );
}

/** How many distinct names a credit could at most resolve to. */
export function countArtistCreditAtoms(name: string): number {
    return new Set(atomizeArtistCredit(name).map(normalizeCreditName)).size;
}

export interface ArtistCreditEvidence {
    /** Credited without every one of `partners` in enough distinct tags. */
    isIndependent(atom: string, partners: readonly string[]): boolean;
    /** An operator-flagged or NFO/MusicBrainz-identified single act. */
    isKnownAct(name: string): boolean;
}

/** No evidence at all: every ambiguous group stays whole. */
export const NO_ARTIST_CREDIT_EVIDENCE: ArtistCreditEvidence = {
    isIndependent: () => false,
    isKnownAct: () => false,
};

/**
 * Index the library's artist tags. Each distinct (normalised) tag counts once,
 * so re-tagged duplicates of one release do not inflate a part's independence.
 *
 * Sampler credits (as many names as the compilation threshold) are left out:
 * two different 30-name radio-sampler tags that each mention a "Chris" say
 * nothing about whether the Chris of "Rob & Chris" records on his own, and bare
 * first names are exactly where that noise would re-create the over-split.
 *
 * A known act inside a tag is indexed as ONE name. Otherwise "Above & Lanterns"
 * would count as a tag crediting "Lanterns" without "Way", and "Way and Lanterns"
 * (another act) came apart on the production library.
 */
export function buildArtistCreditEvidence(
    tags: Iterable<string>,
    knownActs: Iterable<string> = [],
): ArtistCreditEvidence {
    const acts = new Set<string>();
    for (const act of knownActs) {
        if (typeof act === 'string' && act.trim()) acts.add(actKey(act));
    }
    const tagAtoms: Set<string>[] = [];
    const tagsByAtom = new Map<string, number[]>();
    const seenTags = new Set<string>();
    for (const raw of tags) {
        if (typeof raw !== 'string') continue;
        const key = normalizeCreditName(raw);
        if (!key || seenTags.has(key)) continue;
        seenTags.add(key);
        if (countArtistCreditAtoms(raw) >= COMPILATION_ARTIST_THRESHOLD) continue;
        const atoms = new Set(
            splitStrong(raw.trim())
                .flatMap((group) =>
                    acts.has(actKey(group)) ? [group] : splitTrimmed(group, AMBIGUOUS_ATOM_SPLIT),
                )
                .map(normalizeCreditName),
        );
        const index = tagAtoms.push(atoms) - 1;
        for (const atom of atoms) {
            const list = tagsByAtom.get(atom);
            if (list) list.push(index);
            else tagsByAtom.set(atom, [index]);
        }
    }

    return {
        isIndependent(atom, partners) {
            const occurrences = tagsByAtom.get(normalizeCreditName(atom));
            if (!occurrences) return false;
            const partnerKeys = partners.map(normalizeCreditName);
            let count = 0;
            for (const index of occurrences) {
                const atoms = tagAtoms[index];
                if (partnerKeys.some((p) => atoms.has(p))) continue;
                if (++count >= INDEPENDENT_CREDIT_MIN_TAGS) return true;
            }
            return false;
        },
        isKnownAct(name) {
            return acts.has(actKey(name));
        },
    };
}

/**
 * Decide one ambiguous group. Parts the evidence proves independent stand
 * alone; each run of consecutive dependent parts is glued back with its
 * original joiners. No independent part → the group stays whole.
 */
export function resolveArtistGroup(group: string, evidence: ArtistCreditEvidence): string[] {
    return resolveGroupWith(CURRENT_DIALECT, group, evidence);
}

function resolveGroupWith(
    dialect: SplitDialect,
    group: string,
    evidence: ArtistCreditEvidence,
): string[] {
    const trimmed = clampTagText(group).trim();
    if (!isAmbiguousArtistGroup(trimmed) || evidence.isKnownAct(trimmed)) return [trimmed];

    // split() with a capturing group alternates [atom, joiner, atom, ...].
    const pieces = trimmed.split(dialect.atomBoundary);
    const atoms: string[] = [];
    const joiners: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
        if (i % 2 === 0) atoms.push(pieces[i].trim());
        else joiners.push(pieces[i]);
    }
    if (atoms.some((a) => a.length === 0)) return [trimmed];
    // A name that repeats around its joiner is one act: "Ich und Ich",
    // "W & W", "Hoffmann & Hoffmann", "Years & Years".
    if (new Set(atoms.map(normalizeCreditName)).size !== atoms.length) return [trimmed];

    const independent = atoms.map((atom, i) =>
        evidence.isIndependent(
            atom,
            atoms.filter((_, j) => j !== i),
        ),
    );
    if (!independent.some(Boolean)) return [trimmed];

    const out: string[] = [];
    let run: string | null = null;
    for (let i = 0; i < atoms.length; i++) {
        if (independent[i]) {
            if (run !== null) out.push(run);
            run = null;
            out.push(atoms[i]);
        } else {
            run = run === null ? atoms[i] : `${run}${joiners[i - 1]}${atoms[i]}`;
        }
    }
    if (run !== null) out.push(run);
    return dedupeNames(out.map((s) => s.trim()).filter((s) => s.length > 0));
}

/** Full credit resolution: evidence-free split, then evidence per ambiguous group. */
export function resolveArtistCredit(name: string, evidence: ArtistCreditEvidence): string[] {
    return resolveWith(CURRENT_DIALECT, name, evidence);
}

function resolveWith(
    dialect: SplitDialect,
    name: string,
    evidence: ArtistCreditEvidence,
): string[] {
    const groups = parseWith(dialect, name);
    return dedupeNames(
        groups.flatMap((g) =>
            isAmbiguousArtistGroup(g) ? resolveGroupWith(dialect, g, evidence) : [g],
        ),
    );
}

/**
 * Re-join an artist value music-metadata split at "/". ID3v2.3 TPE1 has no
 * multi-value frames, so music-metadata splits it at every "/" — "Axel /\
 * Ingo" (a duo styling its name with "/\") arrives as ["Axel", "\ Ingo"]
 * and created an artist row "\ Ingo". No standalone name starts with a
 * backslash, so such a piece goes back onto the one before it.
 */
export function mergeSlashSplitCredits(parts: readonly string[]): string[] {
    const out: string[] = [];
    for (const part of parts) {
        if (part.startsWith('\\') && out.length > 0) {
            out[out.length - 1] += /^\\\s/.test(part) ? ` /${part}` : `/${part}`;
        } else {
            out.push(part);
        }
    }
    return out;
}
