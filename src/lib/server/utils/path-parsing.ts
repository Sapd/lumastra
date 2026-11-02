// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Parse a folder name into a season number.
 *
 * Recognizes the season-folder conventions Jellyfin/Plex use:
 *   - "Season 01" / "Season 1" / "Staffel 2" / "Saison 3" / "Temporada 4" → the number
 *   - "S01" (abbreviated) → the number
 *   - "Specials" / "Special" → 0   (Jellyfin places specials in a Specials/Season 00 folder)
 *
 * Returns null when the folder name is not a season folder.
 */
export function seasonNumberFromFolderName(name: string): number | null {
    const n = name.trim();
    if (/^specials?$/i.test(n)) return 0;
    const worded = n.match(/^(?:season|staffel|saison|temporada)\s*(\d{1,4})$/i);
    if (worded) return Number.parseInt(worded[1], 10);
    const abbreviated = n.match(/^s(\d{1,4})$/i);
    if (abbreviated) return Number.parseInt(abbreviated[1], 10);
    return null;
}

/** True when the folder name is a recognised season folder (incl. "Specials"). */
function isSeasonFolder(name: string): boolean {
    return seasonNumberFromFolderName(name) !== null;
}

/**
 * Extract the series title from the directory structure for TV files.
 *
 * Walks up from the file looking for the series folder — the first folder
 * above any season folder ("Season XX", "Specials", …). Strips year and
 * embedded IDs from the name.
 *
 * Used by both the video processor (unmatched fallback) and metadata matching
 * (fuzzy search query) to avoid using episode filenames as series titles.
 */
export function extractSeriesTitleFromPath(
    filePath: string,
    libraryRoot: string,
    fallbackTitle: string,
): string {
    const seriesFolder = findSeriesFolder(filePath, libraryRoot);
    if (!seriesFolder) return fallbackTitle;

    return (
        seriesFolder
            .replace(/\s*\((?:19|20)\d{2}\)\s*/g, '') // (2002)
            .replace(/\s+(?:19|20)\d{2}(?=\s|$)/g, '') // trailing bare year
            .replace(/\s*\(\d+\)\s*/g, '') // (0), (1) — anime disambiguation
            // [imdbid-tt0377210], [tmdbid-85221] (Jellyfin naming), [tvdbid-…], or empty
            .replace(/\s*\[(?:imdbid|tmdbid|tmdb|tvdbid)-[^\]]*\]\s*/gi, '')
            .replace(/\s*\{(?:tmdb|tmdbid|imdb|tvdb)-[^}]*\}\s*/gi, '') // {tmdb-12345}, {tvdb-…}
            .trim() || fallbackTitle
    );
}

/**
 * Extract the series year from the series folder's "(YYYY)" tag, e.g. 2001
 * for "Scrubs (2001) [imdbid-tt0285403]". Two same-title shows ("Scrubs (2001)"
 * and "Scrubs (2026)") differ only by this year once the title is searched.
 *
 * A repeated tag ("Scrubs (2026) (2026)", as some tools write it) is that year.
 * Two different years are ambiguous and give undefined, as does a folder
 * without a parenthesized year. A bare year is never read: it is too often the
 * title itself ("1923").
 */
export function extractSeriesYearFromPath(
    filePath: string,
    libraryRoot: string,
): number | undefined {
    const seriesFolder = findSeriesFolder(filePath, libraryRoot);
    if (!seriesFolder) return undefined;
    const years = new Set(
        [...seriesFolder.matchAll(/\(((?:19|20)\d{2})\)/g)].map((m) => Number(m[1])),
    );
    return years.size === 1 ? [...years][0] : undefined;
}

/** The series folder of a TV file: the first folder above any season folder. */
function findSeriesFolder(filePath: string, libraryRoot: string): string | undefined {
    const relativePath = filePath.startsWith(libraryRoot)
        ? filePath.slice(libraryRoot.length)
        : filePath;
    const segments = relativePath.replace(/^\//, '').split('/').slice(0, -1); // exclude filename

    if (segments.length === 0) return undefined;

    let seriesFolder: string | undefined;
    for (let i = segments.length - 1; i >= 0; i--) {
        if (isSeasonFolder(segments[i])) {
            // Walk up past any consecutive season folders (e.g., "Season 01/Season 01 Special/")
            let j = i - 1;
            while (j >= 0 && isSeasonFolder(segments[j])) j--;
            if (j >= 0) seriesFolder = segments[j];
            break;
        }
    }

    if (!seriesFolder) {
        // No standard season folder found. Use the first (shallowest) segment
        // as the series title — the folder directly under the library root is
        // almost always the show name. Deeper folders (Extras, Specials, random
        // subfolders) are not the series title.
        seriesFolder = segments[0];
    }

    return seriesFolder || undefined;
}

/**
 * Extract the season number for a TV file from its folder path.
 *
 * Returns the number of the nearest season folder above the file
 * ("Season 02" → 2, "Specials" → 0), or undefined when there is no season
 * folder in the path.
 *
 * The filename's own `SxxExx` (parsed separately by the filename parser) takes
 * precedence over this — a file explicitly named `Show S03E01.mkv` sitting in a
 * mislabelled "Season 01" folder is season 3, matching Jellyfin. This folder
 * value is the fallback when the filename carries no season (common for anime /
 * simple `Show - 05.mkv` naming, where previously everything defaulted to
 * season 1).
 */
export function extractSeasonNumberFromPath(
    filePath: string,
    libraryRoot: string,
): number | undefined {
    const relativePath = filePath.startsWith(libraryRoot)
        ? filePath.slice(libraryRoot.length)
        : filePath;
    const segments = relativePath.replace(/^\//, '').split('/').slice(0, -1); // exclude filename

    for (let i = segments.length - 1; i >= 0; i--) {
        const n = seasonNumberFromFolderName(segments[i]);
        if (n !== null) return n;
    }
    return undefined;
}

/**
 * Resolve an episode's season number from the three available signals, in the
 * precedence Jellyfin uses:
 *   1. an explicit `SxxExx` season parsed from the filename (a mislabelled
 *      "Season 02" folder never overrides it);
 *   2. else the season of the "Season NN"/"Specials" folder the file sits in;
 *   3. else a specials/OVA/ONA token in the filename → season 0;
 *   4. else season 1.
 *
 * Season 0 (Specials) is a real value, so all signals are compared with
 * `!== undefined`, never truthiness.
 */
export function resolveSeasonNumber(
    filenameSeason: number | undefined,
    folderSeason: number | undefined,
    episodeType: 'regular' | 'ova' | 'ona' | 'special' | undefined,
): number {
    if (filenameSeason !== undefined) return filenameSeason;
    if (folderSeason !== undefined) return folderSeason;
    if (episodeType === 'special' || episodeType === 'ova' || episodeType === 'ona') return 0;
    return 1;
}
