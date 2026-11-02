// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bind a file with no episode number to a canonical episode by its TITLE.
 *
 * Specials and some German releases carry the episode name but no number:
 * `Season 00/The Ghost of Christmas.mp4`, `Pinky.05.Die.Verfluchten.der.Maeuse.avi`.
 * The scanner refuses to auto-number these into a season with canonical episodes
 * (it would invent an episode), so without a title match they never link.
 *
 * The rule is deliberately strict — exact, not fuzzy: after normalising both
 * sides, the canonical title must equal the filename title or be its trailing
 * words ("pinky 05 die verfluchten der maeuse" ends with "die verfluchten der
 * maeuse"). A wrong link is worse than no link, so an ambiguous result (two
 * different episodes matching equally well) binds nothing.
 */

export interface EpisodeTitleCandidate {
    id: string;
    titles: Array<string | null | undefined>;
}

/** Placeholder titles providers emit for unnamed episodes ("Episode 4", "Folge 12"). */
const GENERIC_TITLE_RE =
    /^(?:(?:episode|folge|episodio|ep|chapter|kapitel|special)\s*\d*|tba|tbd|untitled)$/;

/** Shortest canonical title (normalised) that may bind — below this, a trailing
 *  word like "pilot" or "ende" matches far too much. */
const MIN_TITLE_LENGTH = 4;

/** Fold compatibility forms (full-width, superscripts), lowercase, fold German umlauts to their ASCII spelling (filenames write "Maeuse"
 *  for "Mäuse"), strip remaining diacritics, and collapse punctuation to spaces. */
export function normalizeEpisodeTitle(value: string): string {
    return value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        // Recompose and keep other marks: kana dakuten and Indic vowel signs carry meaning.
        .normalize('NFC')
        .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
        .trim();
}

/** Provider placeholders cannot establish an episode's content identity. */
export function isGenericEpisodeTitle(value: string): boolean {
    const title = normalizeEpisodeTitle(value);
    return value.trim().length === 0 || GENERIC_TITLE_RE.test(title);
}

/**
 * Return the id of the one candidate whose title the filename title ends with,
 * or null when none or more than one episode match at the best length.
 */
export function matchEpisodeByTitle(
    fileTitle: string,
    candidates: EpisodeTitleCandidate[],
): string | null {
    const file = normalizeEpisodeTitle(fileTitle);
    if (!file) return null;

    let bestLength = 0;
    const best = new Set<string>();
    for (const candidate of candidates) {
        for (const raw of candidate.titles) {
            if (!raw) continue;
            const title = normalizeEpisodeTitle(raw);
            if (title.length < MIN_TITLE_LENGTH || isGenericEpisodeTitle(raw)) continue;
            if (file !== title && !file.endsWith(` ${title}`)) continue;
            if (title.length > bestLength) {
                bestLength = title.length;
                best.clear();
            }
            if (title.length === bestLength) best.add(candidate.id);
        }
    }
    return best.size === 1 ? [...best][0] : null;
}
