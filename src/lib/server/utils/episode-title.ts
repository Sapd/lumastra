// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Episode Title Builder Utilities
 *
 * Pure helpers for constructing display titles for combined multi-episode files
 * (one physical file backing two or more episode rows, e.g. S01E05E06).
 */

export interface EpisodeTitleSibling {
    episode_number: number | null;
    title: string | null;
    /** Physical season of this sibling; absent means the caller's season. */
    season_number?: number | null;
}

export interface CombinedEpisodeTitleResult {
    /** Combined episode title joined with " / " (de-duplicated). */
    title: string;
    /** Episode range string e.g. "S01E05-E06". Single episodes: "S01E05". */
    rangeCode: string;
    /** Lowest episode number in the group (start of range). */
    episodeStart: number;
    /** Highest episode number in the group (end of range, same as start for singles). */
    episodeEnd: number;
}

/**
 * Build the combined display title and episode-range code for a group of
 * file-sibling episodes.
 *
 * When `siblings` has exactly one entry, the result is the same as the
 * existing single-episode formatting — callers can use it unconditionally.
 *
 * A file an admin linked by hand can hold episodes no range describes: 9x37 +
 * 9x41, or 11x16 + 10x19. Those get a "+"-joined code in file order
 * ("S09E37+E41", "S11E16+S10E19") and `episodeStart === episodeEnd`, so no
 * caller presents them as a range.
 *
 * @param siblings - All episodes sharing the same default file, in file order
 *   (getFileSiblingEpisodes). Must contain at least one element.
 * @param seasonNumber - Physical season number (used to build the range code).
 */
export function buildCombinedEpisodeTitle(
    siblings: EpisodeTitleSibling[],
    seasonNumber: number,
): CombinedEpisodeTitleResult {
    const s = String(seasonNumber).padStart(2, '0');

    const epNumbers = siblings.map((ep) => ep.episode_number ?? 0).filter((n) => n > 0);
    const title = joinTitles(siblings);

    if (!isContiguousSet(siblings, seasonNumber)) {
        let lastSeason = seasonNumber;
        const parts = siblings.map((ep, i) => {
            const season = ep.season_number ?? seasonNumber;
            const e = `E${String(ep.episode_number ?? 0).padStart(2, '0')}`;
            const code =
                i === 0 || season !== lastSeason ? `S${String(season).padStart(2, '0')}${e}` : e;
            lastSeason = season;
            return code;
        });
        const first = siblings[0].episode_number ?? 1;
        return { title, rangeCode: parts.join('+'), episodeStart: first, episodeEnd: first };
    }

    const episodeStart = epNumbers.length > 0 ? Math.min(...epNumbers) : 1;
    const episodeEnd = epNumbers.length > 0 ? Math.max(...epNumbers) : episodeStart;

    const eStart = String(episodeStart).padStart(2, '0');
    const eEnd = String(episodeEnd).padStart(2, '0');

    const rangeCode = episodeEnd > episodeStart ? `S${s}E${eStart}-E${eEnd}` : `S${s}E${eStart}`;

    return { title, rangeCode, episodeStart, episodeEnd };
}

/**
 * True when the siblings are one season's consecutive episodes (in any order),
 * i.e. a range code describes them. A sibling without a number may fill a hole
 * (9, null, 11 is still 9–11), so the test is "the span is no wider than the
 * file has episodes", not "no holes".
 */
export function isContiguousSet(
    siblings: readonly Pick<EpisodeTitleSibling, 'episode_number' | 'season_number'>[],
    seasonNumber: number,
): boolean {
    if (siblings.some((ep) => (ep.season_number ?? seasonNumber) !== seasonNumber)) return false;
    const numbers = siblings.map((ep) => ep.episode_number ?? 0).filter((n) => n > 0);
    if (numbers.length < 2) return true;
    return Math.max(...numbers) - Math.min(...numbers) + 1 <= siblings.length;
}

function joinTitles(siblings: EpisodeTitleSibling[]): string {
    // Collect titles in order, skipping nulls and de-duplicating adjacent
    const seen = new Set<string>();
    const titleParts: string[] = [];
    for (const ep of siblings) {
        const t = ep.title?.trim();
        if (t && !seen.has(t)) {
            seen.add(t);
            titleParts.push(t);
        }
    }

    return titleParts.length > 0 ? titleParts.join(' / ') : '';
}
