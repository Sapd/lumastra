// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Remix-credit extraction: find the remixer-candidate span inside a track
 * title's version tag ("Summertime (Ekowraith Remix)" → "Ekowraith").
 *
 * Match-only consumers: the file-scanner post-pass resolves candidates
 * against EXISTING artists (never creates), and `linkifyTitle` links known
 * artist names only inside these zones. A missed candidate is therefore
 * always harmless — the worst case is an unlinked name.
 *
 * Lives in `$lib/shared` because zone-finding runs client-side (title
 * linkification) AND server-side (scan pass). Must stay dependency-free.
 * The frozen dedup-key regexes in `music-title-normalize.ts` are NOT used
 * or modified here — this module has its own word lists because those
 * regexes are stripping/matching patterns, not tokenizable word lists.
 */

/** Version/variant words — mirrors VERSION_TAG_KEYWORDS conceptually. */
export const VERSION_KEYWORD_WORDS: readonly string[] = [
    'remix',
    'rmx',
    'mix',
    'edit',
    'version',
    'remaster',
    'remastered',
    'live',
    'acoustic',
    'instrumental',
    'radio',
    'extended',
    'club',
    'dub',
    'vip',
    'bootleg',
];

/**
 * Common non-artist tag qualifiers. Not version keywords, but they appear
 * as tag prefixes constantly ("(Original Mix)", "(Album Version)") and must
 * never become artist-lookup candidates — even if a library artist happens
 * to carry one of these names.
 */
export const CREDIT_QUALIFIER_WORDS: readonly string[] = [
    'original',
    'album',
    'single',
    'official',
    'deluxe',
    'mono',
    'stereo',
    'bonus',
];

const VERSION_WORD_SET: ReadonlySet<string> = new Set(VERSION_KEYWORD_WORDS);
const NON_ARTIST_WORD_SET: ReadonlySet<string> = new Set([
    ...VERSION_KEYWORD_WORDS,
    ...CREDIT_QUALIFIER_WORDS,
]);

/** Candidate span offsets into the ORIGINAL title (keyword run excluded). */
export interface RemixCreditZone {
    /** Inclusive start offset. */
    start: number;
    /** Exclusive end offset. */
    end: number;
}

interface Token {
    text: string;
    start: number;
    end: number;
}

function tokenize(text: string, offset: number): Token[] {
    const tokens: Token[] = [];
    const wordPattern = /\S+/g;
    let match: RegExpExecArray | null;
    while ((match = wordPattern.exec(text)) !== null) {
        tokens.push({
            text: match[0],
            start: offset + match.index,
            end: offset + match.index + match[0].length,
        });
    }
    return tokens;
}

/** Lowercase and strip non-alphanumeric edges ("Remix," → "remix"). */
function normalizeToken(token: string): string {
    return token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

/** Leading/trailing bracket-only runs — NOT general punctuation ("Cc.K", "A$AP", "!!!" stay untouched). */
const LEADING_BRACKETS = /^[([]+/;
const TRAILING_BRACKETS = /[)\]]+$/;

/** Words that can never be (part of) an artist candidate. */
function isNonArtistWord(normalized: string): boolean {
    return (
        normalized.length === 0 || NON_ARTIST_WORD_SET.has(normalized) || /^\d{4}$/.test(normalized)
    );
}

/**
 * Turn one tag segment (bracket content or dash suffix) into a candidate
 * zone, or null when the segment carries no plausible remixer:
 * a trailing run of version/qualifier/year words is peeled off the end;
 * it must contain at least one TRUE version keyword, and what remains
 * before it must contain at least one word that could be an artist.
 */
function zoneFromSegment(text: string, offset: number): RemixCreditZone | null {
    const tokens = tokenize(text, offset);
    if (tokens.length < 2) return null;

    let cut = tokens.length;
    let sawVersionWord = false;
    while (cut > 0) {
        const normalized = normalizeToken(tokens[cut - 1].text);
        if (VERSION_WORD_SET.has(normalized)) {
            sawVersionWord = true;
            cut--;
            continue;
        }
        if (isNonArtistWord(normalized)) {
            cut--;
            continue;
        }
        break;
    }

    if (!sawVersionWord || cut === 0 || cut === tokens.length) return null;

    const candidateTokens = tokens.slice(0, cut);
    if (candidateTokens.every((token) => isNonArtistWord(normalizeToken(token.text)))) {
        return null;
    }

    // An unbalanced/mixed-type bracket tag (e.g. "Song [(Ekowraith Remix)]" or
    // "((Ekowraith Remix)") can leave a stray "(" or "[" glued to the first
    // candidate token (bracketSegment's regex only excludes ")"/"]" from the
    // capture). Left in, the zone's sliced text carries the bracket char,
    // which the scan-time SQL lookup strips away (so it still resolves and
    // writes the credit) but the display-time delimiter check does not (so
    // the link silently fails to render) — trim it here so both sides agree.
    const firstToken = candidateTokens[0];
    const lastToken = candidateTokens[candidateTokens.length - 1];
    const leadingBrackets = firstToken.text.match(LEADING_BRACKETS)?.[0].length ?? 0;
    const trailingBrackets = lastToken.text.match(TRAILING_BRACKETS)?.[0].length ?? 0;

    const start = firstToken.start + leadingBrackets;
    const end = lastToken.end - trailingBrackets;
    if (start >= end) return null;

    return { start, end };
}

/**
 * All candidate zones in a title: every bracketed segment, plus the suffix
 * after the LAST dash separator when that suffix is bracket-free (bracketed
 * tags are already covered by the first pass).
 */
export function findRemixCreditZones(title: string): RemixCreditZone[] {
    const zones: RemixCreditZone[] = [];

    const bracketSegment = /[([]([^)\]]*)[)\]]/g;
    let match: RegExpExecArray | null;
    while ((match = bracketSegment.exec(title)) !== null) {
        const zone = zoneFromSegment(match[1], match.index + 1);
        if (zone) zones.push(zone);
    }

    const dashSeparator = /\s[-–—]\s/g;
    let lastSeparator: RegExpExecArray | null = null;
    while ((match = dashSeparator.exec(title)) !== null) {
        lastSeparator = match;
    }
    if (lastSeparator) {
        const suffixStart = lastSeparator.index + lastSeparator[0].length;
        const suffix = title.slice(suffixStart);
        if (!/[()[\]]/.test(suffix)) {
            const zone = zoneFromSegment(suffix, suffixStart);
            if (zone) zones.push(zone);
        }
    }
    return zones;
}

/** Trimmed verbatim candidate strings (collabs NOT split — caller's job). */
export function extractRemixerCandidates(title: string): string[] {
    return findRemixCreditZones(title)
        .map((zone) => title.slice(zone.start, zone.end).trim())
        .filter((candidate) => candidate.length > 0);
}
