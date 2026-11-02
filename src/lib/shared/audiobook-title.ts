// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audiobook display-title cleanup.
 *
 * AudiobookShelf titles routinely bake the narrator into the title
 * ("Milo Farrow und der Stein der Weisen - Gesprochen von Felix Vale"), which
 * makes every surface that shows a title render a sentence instead of a title.
 *
 * The connector phrase is NOT something this module tries to know: it varies by
 * language and by whoever tagged the library ("Gesprochen von", "Narrated by",
 * "Read by", "gelesen von", or nothing at all), so a phrase list would be a
 * permanent guessing game and a wrong trim is worse than a long title.
 *
 * Instead the trim is driven by DATA we already have: the narrator names the ABS
 * sweep persisted under `custom_metadata.audiobookshelf.narrators`. A trailing
 * segment is removed only when it ENDS WITH one of those exact names — whatever
 * words precede the name inside that segment. That makes the rule
 * language-agnostic and self-verifying, and nothing is lost because the modal
 * shows the narrator as its own field.
 *
 * Only ever used for DISPLAY. The stored title, the URL slug, the search index
 * and every id stay untouched.
 */

/**
 * Separators an operator/ABS plausibly uses between a title and a trailing
 * credit. Ordered longest-first only for readability — the algorithm picks by
 * position, not by list order.
 */
const SEPARATORS = [' - ', ' – ', ' — ', ' | ', ' · ', ': '] as const;

/**
 * A credit is a suffix, not a second title. Above this length the trailing
 * segment is far more likely to be part of the work's real name (a subtitle that
 * happens to end in a person's name) than a "narrated by" credit.
 */
const MAX_SUFFIX_LENGTH = 60;

/** Guard against reducing a title to a fragment ("A - Read by X" → "A"). */
const MIN_HEAD_LENGTH = 3;

/** Trailing parenthetical/bracketed credit, e.g. "Title (Narrated by X)". */
const TRAILING_BRACKET_RE = /\s*[([]([^()[\]]*)[)\]]\s*$/;

/** Lowercase + collapse whitespace so tagging noise doesn't defeat the match. */
function normalize(value: string): string {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * True when `tail` ends with `narrator` on a word boundary.
 *
 * The boundary check matters: a bare `endsWith` would let a one-token narrator
 * ("Vale") match the tail of an unrelated word ("Felix Vale" is fine, but
 * "Steinvale" must not count as "Vale").
 */
function endsWithName(tail: string, narrator: string): boolean {
    if (tail === narrator) return true;
    if (!tail.endsWith(narrator)) return false;
    const boundary = tail.charAt(tail.length - narrator.length - 1);
    return boundary === '' || !/[\p{L}\p{N}]/u.test(boundary);
}

/**
 * Remove a trailing narrator credit from an audiobook title.
 *
 * Returns the title unchanged whenever the rule cannot be applied with
 * certainty: no narrators known, no separator, an over-long trailing segment, a
 * segment that does not end in a known narrator name, or a head too short to
 * stand on its own.
 *
 * @param title     Raw title as stored.
 * @param narrators Narrator names from the ABS metadata block.
 */
export function stripNarratorSuffix(
    title: string | undefined | null,
    narrators: readonly string[] | undefined,
): string {
    const raw = (title ?? '').trim();
    if (!raw) return title ?? '';

    const names = (narrators ?? [])
        .map(normalize)
        // A single-character "name" would match almost any tail; ignore it.
        .filter((name) => name.length >= 2);
    if (names.length === 0) return raw;

    const matchesNarrator = (segment: string): boolean => {
        const normalized = normalize(segment);
        if (!normalized) return false;
        return names.some((name) => endsWithName(normalized, name));
    };

    const accept = (head: string): string | null => {
        const trimmedHead = head.replace(/[\s\-–—|·:,;]+$/u, '').trim();
        return trimmedHead.length >= MIN_HEAD_LENGTH ? trimmedHead : null;
    };

    // 1) Trailing parenthetical credit — checked first because a bracketed
    //    segment is unambiguous and may itself contain a separator.
    const bracket = TRAILING_BRACKET_RE.exec(raw);
    if (bracket && bracket[1].length <= MAX_SUFFIX_LENGTH && matchesNarrator(bracket[1])) {
        const head = accept(raw.slice(0, bracket.index));
        if (head) return head;
    }

    // 2) Last separator in the string — "A - B - Read by X" must lose only the
    //    final segment.
    let cutAt = -1;
    let cutLength = 0;
    for (const separator of SEPARATORS) {
        const at = raw.lastIndexOf(separator);
        if (at > cutAt) {
            cutAt = at;
            cutLength = separator.length;
        }
    }
    if (cutAt > 0) {
        const tail = raw.slice(cutAt + cutLength);
        if (tail.length <= MAX_SUFFIX_LENGTH && matchesNarrator(tail)) {
            const head = accept(raw.slice(0, cutAt));
            if (head) return head;
        }
    }

    return raw;
}
