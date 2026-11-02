// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What an episode group leaves out, for the ordering preview.
 *
 * A provider group lists only the episodes it places. While the ordering is
 * active, an episode that is not in the group but shares its original season
 * with one that is drops out of every episode list (see
 * `buildUnmappedEpisodeFilterFragment`); a season with no episode in the group
 * keeps its original numbering. Season totals come from the provider's own
 * season list; without them the left-out count is unknown (null).
 */

export interface SeasonTotal {
    seasonNumber: number;
    episodeCount: number;
}

export interface SeasonCoverage {
    seasonNumber: number;
    /** Distinct episodes of this original season the group places. */
    inGroup: number;
    /** The season's own episode count, or null when unknown. */
    total: number | null;
}

export interface PreviewCoverage {
    /** Original seasons the group touches, ascending. */
    seasons: SeasonCoverage[];
    /** Episodes of touched seasons the group leaves out; null when totals are unknown. */
    notInOrdering: number | null;
    /** Seasons with episodes and none in the group: they stay as they are. */
    untouchedSeasons: number[];
}

export function previewCoverage(
    episodes: ReadonlyArray<{ originalSeason: number; originalEpisode: number }>,
    seasonTotals: ReadonlyArray<SeasonTotal> | undefined,
): PreviewCoverage {
    const perSeason = new Map<number, Set<number>>();
    for (const ep of episodes) {
        const set = perSeason.get(ep.originalSeason) ?? new Set<number>();
        set.add(ep.originalEpisode);
        perSeason.set(ep.originalSeason, set);
    }
    const totals = new Map((seasonTotals ?? []).map((t) => [t.seasonNumber, t.episodeCount]));
    const known = seasonTotals !== undefined && seasonTotals.length > 0;

    const seasons = [...perSeason.entries()]
        .sort(([a], [b]) => a - b)
        .map(([seasonNumber, eps]) => ({
            seasonNumber,
            inGroup: eps.size,
            total: known ? (totals.get(seasonNumber) ?? null) : null,
        }));

    let notInOrdering: number | null = known ? 0 : null;
    if (notInOrdering !== null) {
        for (const s of seasons) {
            if (s.total !== null) notInOrdering += Math.max(0, s.total - s.inGroup);
        }
    }

    const untouchedSeasons = known
        ? [...totals.entries()]
              .filter(([n, count]) => count > 0 && !perSeason.has(n))
              .map(([n]) => n)
              .sort((a, b) => a - b)
        : [];

    return { seasons, notInOrdering, untouchedSeasons };
}
