// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one provider episode a daily-show file's air date points at, shared by
 * the scanner and the post-sync air-date pass so both decide alike. Two
 * episodes on one day are told apart by the file's season folder when it names
 * one of them, else by preferring the only regular episode over specials
 * (unless the file sits in a Specials folder). Anything else is ambiguous.
 */
export function pickAirDateEpisode<T extends { season_number: number }>(
    candidates: T[],
    folderSeason: number | undefined,
): T | null {
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) return null;
    if (folderSeason !== undefined) {
        const inFolder = candidates.filter((c) => c.season_number === folderSeason);
        if (inFolder.length === 1) return inFolder[0];
    }
    if (folderSeason !== 0) {
        const regular = candidates.filter((c) => c.season_number > 0);
        if (regular.length === 1) return regular[0];
    }
    return null;
}
