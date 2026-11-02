// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Filename Parser
 *
 * Extracts structured media info from raw filenames.
 * Handles common patterns: dot-separated, dash-separated, anime [group] prefix.
 * Also extracts multi-episode ranges, split-file part numbers, edition labels,
 * and IMDB IDs embedded in filenames or parent folder names.
 *
 * Pure functions — no side effects, no DB access. Easy to unit test.
 */

import path from 'node:path';
import { seasonNumberFromFolderName } from './path-parsing.js';

export interface ParsedFilename {
    /** Cleaned-up title for metadata search. */
    title: string;
    /** Release/premiere year, if detectable. */
    year?: number;
    /** Season number for TV (1-based). */
    season?: number;
    /**
     * First episode number in the file (1-based).
     * For single-episode files this equals `episode` (backward-compat alias).
     */
    episodeStart?: number;
    /**
     * Last episode number for multi-episode files (e.g. S01E01E02E03 → 3).
     * Undefined for single-episode or movie files.
     */
    episodeEnd?: number;
    /**
     * Part number for split files (.Part1, .pt2).
     * Undefined for complete (non-split) files.
     */
    part?: number;
    /**
     * Edition label extracted from the filename.
     * Canonical values: 'directors_cut' | 'extended' | 'theatrical' | '4k' | 'remastered'
     */
    edition?: string;
    /**
     * IMDB ID (e.g. 'tt0133093') extracted from the filename or parent folder name.
     * Always lowercase.
     */
    imdbId?: string;
    /**
     * TMDB ID (e.g. '603') extracted from the filename or parent folder name.
     * Set when filename or folder contains {tmdb-603}.
     */
    tmdbId?: string;
    /**
     * @deprecated Use episodeStart instead.
     * Kept for backward compatibility — equals episodeStart.
     */
    episode?: number;
    /**
     * Version number for anime re-release variants (e.g. v2, v3).
     * Extracted from patterns like "- 01v2 [SubGroup].mkv".
     */
    version?: number;
    /**
     * Episode type for anime special releases.
     * 'regular' is the default for normal episodes; others indicate special content.
     */
    episodeType?: 'regular' | 'ova' | 'ona' | 'special';
    /**
     * Air date of a daily-show episode named by date instead of SxxExx
     * ("The Show 2021.03.14.mkv"), as `YYYY-MM-DD`. Only read when the caller
     * asks for it (`{ airDates: true }`, TV libraries) and only when the name
     * carries no episode number, which always wins. `year` then holds the
     * date's year unless the name has its own; use {@link seriesYearHint} for
     * TV, where that year is not the show's.
     */
    airDate?: string;
    /** True when `year` was taken from `airDate`, not from a year of its own. */
    yearFromAirDate?: boolean;
    /**
     * Absolute episode number the name carries beside its season: Sonarr's anime
     * form `SxxEyy - NNN - Title`, or a bare `S01E0422` whose episode is >= 100.
     * Undefined when the name has no such number. See {@link extractAbsoluteEpisode}.
     */
    absoluteEpisode?: number;
    /** Raw filename without extension (for logging). */
    raw: string;
}

// Quality/codec/source junk tokens — these appear after the real title/year/episode info
const JUNK_TOKENS = new Set([
    '2160p',
    '1080p',
    '1080i',
    '720p',
    '720i',
    '480p',
    '480i',
    '4k',
    'uhd',
    'fhd',
    'hd',
    'sd',
    'bluray',
    'blu-ray',
    'bdrip',
    'brrip',
    'web-dl',
    'webdl',
    'webrip',
    'web',
    'hdtv',
    'pdtv',
    'dvdrip',
    'dvdscr',
    'dvd',
    'hdrip',
    'hdr',
    'hdr10',
    'dolby',
    'atmos',
    'dts',
    'x264',
    'x265',
    'h264',
    'h265',
    'hevc',
    'avc',
    'xvid',
    'divx',
    'mpeg2',
    'aac',
    'ac3',
    'mp3',
    'flac',
    'opus',
    'proper',
    'repack',
    'extended',
    'theatrical',
    'directors',
    'cut',
    'remux',
    'hybrid',
    'yts',
    'yify',
    'rarbg',
]);

/** Edition pattern → canonical value pairs, checked in order. */
const EDITION_PATTERNS: Array<[RegExp, string]> = [
    [/directors?'?[.\s_-]?cut/i, 'directors_cut'],
    [/extended[.\s_-]?(?:edition|cut)?/i, 'extended'],
    [/theatrical[.\s_-]?(?:cut|version)?/i, 'theatrical'],
    [/\b4k\b|uhd|\b2160p\b/i, '4k'],
    [/remaster(?:ed)?/i, 'remastered'],
    [/\bcoloriz(?:ed)?\b/i, 'colorized'],
    [/\bimax\b/i, 'imax'],
    [/\bunrated\b/i, 'unrated'],
    [/\buncut\b/i, 'uncut'],
    [/\bcriterion\b/i, 'criterion'],
    [/special[.\s_-]?edition/i, 'special_edition'],
    [/black[.\s_-]?and[.\s_-]?chrome/i, 'black_and_chrome'],
    [/final[.\s_-]?cut/i, 'final_cut'],
    [/open[.\s_-]?matte/i, 'open_matte'],
];

/** Multi-episode pattern: S01E01E02E03, S01E01-E03, or S01E01-02-03 (bare-number continuation).
 *  Bare-number continuation capped at 2 digits to avoid matching quality tokens like -1080p/-720p. */
const MULTI_EP_PATTERN = /[Ss](\d{1,2})[Ee](\d{2,4})(?:(?:[-_]?[Ee]\d{2,4})|(?:-\d{2}(?!\d)))+/;

/**
 * SxxExx single-episode pattern, e.g. S01E02, s1e2, S01E0001 (anime 4-digit).
 *
 * The episode group is unbounded (`\d+`), not `\d{1,4}`. A fixed cap does not
 * reject an over-long run — it TRUNCATES it, so "S01E12345" silently became
 * episode 1234: a different, real-looking episode rather than a parse failure.
 * Digits in real release names are always followed by a separator, so `\d+`
 * changes nothing for 1-4 digit episodes; it only stops the substitution.
 *
 * A negative lookahead was considered and rejected: making this pattern FAIL
 * drops parsing through to the anime bare-number / "Ep##" rules below, which
 * can produce a different wrong number instead. Consuming the whole run keeps
 * the same branch and cannot substitute silently.
 */
const S_E_PATTERN = /[Ss](\d{1,2})[Ee](\d+)/;

/**
 * SxxExx with a separator between the two halves: "S01.E01", "S01 E01",
 * "S01_E01", "S01-E01". Some scene groups name releases this way
 * ("Oria.13.S01.E01.German...-Fuuko"). Unparsed, such a file drops to
 * auto-numbering and is linked to an invented episode instead of the real one.
 *
 * Tried only after S_E_PATTERN, so the unseparated form keeps its own path. The
 * leading boundary stops a word ending in "s" from being read as a season, and
 * requiring digits after the E means "S01.Extras" is not an episode.
 */
const S_SEP_E_PATTERN = /(?<![A-Za-z0-9])[Ss](\d{1,2})[._ -]+[Ee](\d+)(?!\d)/;

/** Spelled-out season + episode, e.g. "Charmed Staffel 3 Folge 06" or "Season 2 Episode 4".
 *  Both words are required, so a lone "Staffel 3" folder-style token is not an episode. */
const WORDED_SE_PATTERN =
    /(?<![A-Za-z])(?:Staffel|Season|Series|Saison|Temporada)[\s._-]*(\d{1,2})[\s._-]*(?:Folge|Episode|Episodio|[EÉ]pisode|Ep)[\s._-]*(\d{1,4})(?!\d)/i;

/**
 * British "Series N - NN" naming, as iPlayer downloads write it:
 * "Show_Series_2_-_03._Title_p08qyvrv_original.mp4" or "Show - Series 2 - 03. Title".
 * Without it the number-before-dash rule reads the SERIES number as the episode.
 * The dash (ASCII, en or em) is required, so "Show Series 2 Bloopers" stays a
 * title, and the number must end at a separator, so "Series 2 - 720p" is not E720.
 */
const SERIES_DASH_EPISODE_PATTERN =
    /(?<![A-Za-z])Series[\s._]*(\d{1,2})[\s._]*[-\u2013\u2014][\s._]*(\d{1,3})(?=[\s._[\]()-]|$)/i;

/**
 * Alternate season×episode form used by many scene/EU releases and supported by
 * Jellyfin: "1x02", "01x002", "12x05". Guards against false positives:
 *   - a non-alphanumeric boundary before the season + a non-digit after the
 *     episode, and the season capped at two digits, reject resolution tokens
 *     like "1280x720"/"1920x1080" (season candidate is always digit-prefixed);
 *   - the EPISODE must be at least two digits, so aspect-ratio notation like
 *     "4x3" / "16x9" (a stand-in for the Windows-illegal ':') is NOT read as
 *     S4E3 / S16E9. Real episode notation is zero-padded ("4x03").
 */
const X_SE_PATTERN = /(?<![A-Za-z0-9])(\d{1,2})x(\d{2,3})(?!\d)/i;

/** Multi-episode alternate form: "1x02-03", "1x02x03" (episodes 2–3 digits). */
const X_MULTI_EP_PATTERN = /(?<![A-Za-z0-9])(\d{1,2})x(\d{2,3})(?:[-x](\d{2,3}))+(?!\d)/i;

/** Bare episode number for anime (after a dash or space), e.g. "- 12 [" or "- 01v2 [".
 *  Separator class `[\s_]` accepts underscore so renamer-style "Title_-_01[..]" matches
 *  before the step-7 underscore→space normalisation. */
const ANIME_EPISODE_PATTERN = /(?:^|[\s_])-[\s_]*(\d{1,4})(?:v(\d+))?(?:[\s_]|$|\[)/;

/** Number-before-dash anime form, e.g. "Varenth 01 - Der Schwarze Ritter".
 *  Capped at 3 digits + `(?!\d)` so 4-digit years like "1997" can't be misread as episodes;
 *  the trailing `[\s_]+\S` requires real content after the dash so a stray "Title 01 - "
 *  doesn't match. */
const ANIME_EPISODE_NUMBER_FIRST_PATTERN = /(?:^|[\s_])(\d{1,3})(?!\d)(?:v(\d+))?[\s_]*-[\s_]+\S/;

/** "EpNN" / "Episode NN" / bare "ENN" prefix form, e.g. "Amagi.Brilliant.Park.Ep01.German..."
 *  or "cd.720p.e01". A bare "E" takes no separator before the digits, so "Harb.E.2008" stays
 *  a title; the season comes from the folder. */
const EP_PREFIX_PATTERN =
    /(?:^|[\s_.-])(?:[Ee]p(?:isode)?[\s_.]?|[Ee])(\d{1,4})(?!\d)(?:v(\d+))?(?=[\s_.[]|$)/;

/** Leading episode number, e.g. "01 Abgrund [720p]". Only trusted when the file sits in a
 *  "Season NN"/"Specials" folder — on its own it would read "12 Quiet Guests" as episode 12. */
const LEADING_EPISODE_NUMBER_PATTERN = /^(\d{1,3})(?!\d)(?:v(\d+))?(?=[\s_.[-]|$)/;

/** Underscore-or-space + number + bracket, e.g. "Asobi_ni_Iku_Yo!_10[720p][hash]".
 *  Capped at 3 digits + `(?!\d)` so quality tokens like "1080" cannot match. */
const ANIME_EPISODE_BEFORE_BRACKET_PATTERN = /(?:^|[\s_])(\d{1,3})(?!\d)(?:v(\d+))?\[/;

/** Episode type tokens for anime — detected before junk stripping to SET episodeType, not discard.
 *  Only unambiguous tokens that never appear in normal movie/TV titles.
 *  'movie' intentionally excluded: too common in real titles (e.g. "LEGO Movie"). */
const EPISODE_TYPE_PATTERNS: Array<[RegExp, 'ova' | 'ona' | 'special']> = [
    [/\bOVA\b/i, 'ova'],
    [/\bONA\b/i, 'ona'],
    [/\bSpecial\b/i, 'special'],
];

/** OVA/ONA token followed by its number, e.g. "Show.OVA.01.German", "Show ONA 3" or
 *  "Show OVA 01v2". The number must end at a separator, so "OVA.720p" is not episode 720. */
const OVA_ONA_NUMBER_PATTERN = /\b(?:OVA|ONA)[\s._-]*(\d{1,3})(?:v(\d+))?(?=[\s._[\]()+,-]|$)/i;

/**
 * Daily-show air date, year first: "2021.03.14", "2021-03-14", "2021_03_14",
 * "2021 03 14". The two separators must match, so "2021.03-14" is not a date.
 * Day-first and month-first forms are left out: "03.04.2021" is ambiguous.
 */
const AIR_DATE_PATTERN =
    /(?<![A-Za-z0-9])((?:19|20)\d{2})([.\-_ ])(0[1-9]|1[0-2])\2(0[1-9]|[12]\d|3[01])(?![A-Za-z0-9])/;

/**
 * Find a daily-show air date in the working string. Returns the ISO date and
 * the string with the date removed: the text before it when the date is not
 * leading ("The Show 2021.03.14 Guest" → "The Show"), else the text after it
 * ("2021.03.14 - Guest" → "- Guest"). Calendar-checked, so "2021.02.30" is no date.
 *
 * A name that ALSO carries an episode number is not a daily-show name: the
 * number wins ("Show S01E05 2021.03.14", "Show - 05 [2021.03.14]", and in a
 * season folder "05 - 2021-03-14"). That is checked on the name with the date
 * cut out, so the date's own digits can't pass for an episode number ("Show
 * 2021 03 14 - Guest" would otherwise read "14 - Guest" as episode 14).
 */
function extractAirDate(
    working: string,
    inSeasonFolder: boolean,
): { airDate?: string; working: string } {
    const m = AIR_DATE_PATTERN.exec(working);
    if (!m) return { working };
    const [y, mo, d] = [m[1], m[3], m[4]].map((v) => parseInt(v, 10));
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return { working };
    const withoutDate =
        `${working.slice(0, m.index)} ${working.slice(m.index + m[0].length)}`.trim();
    if (
        extractEpisode(withoutDate).episodeStart !== undefined ||
        // The leading-number rule looks only before the date: "05 - 2021-03-14"
        // is episode 5, "2021.03.14 2" a second copy of that day's file.
        (inSeasonFolder && LEADING_EPISODE_NUMBER_PATTERN.test(working.slice(0, m.index).trim()))
    ) {
        return { working };
    }
    return {
        airDate: `${m[1]}-${m[3]}-${m[4]}`,
        working:
            m.index === 0 ? working.slice(m[0].length).trim() : working.slice(0, m.index).trim(),
    };
}

/**
 * The year to identify a SERIES by. For a daily-show file the parsed year is
 * usually just the air date's year, which says nothing about the show
 * ("Show (2015)" airing in 2021), so it is dropped; a separate year in the
 * name ("The Show (2015) 2021.03.14") is kept.
 */
export function seriesYearHint(
    parsed: Pick<ParsedFilename, 'year' | 'yearFromAirDate'>,
): number | undefined {
    return parsed.yearFromAirDate ? undefined : parsed.year;
}

export interface ParseMediaFilenameOptions {
    /**
     * Read daily-show air dates ("The Show 2021.03.14.mkv"). Only for TV
     * libraries: elsewhere a date is part of the name ("Birthday 2015_06_12",
     * "IMG_2021_03_14_123456") and must not cut the title.
     */
    airDates?: boolean;
}

/** Year pattern: 4-digit number between 1900–2099 */
const YEAR_PATTERN = /\b((?:19|20)\d{2})\b/;

/** Year wrapped in parentheses, e.g. " (2020)" — checked before bare YEAR_PATTERN to avoid leaving a dangling "(".
 *  Also 1880–1899 here, for early films such as "(1896)": in parentheses a four-digit number
 *  is a year, while a bare 18xx can be part of a title ("1812"). */
const PAREN_YEAR_PATTERN = /\s*\((18[89]\d|(?:19|20)\d{2})\)/;

/** Part pattern: .Part1, .pt2, .cd1, .disc2, .disk3, .dvd4, .cd10 etc.
 *  Two digits so multi-disc sets past 9 (`cd10`, `part12`) parse correctly. */
const PART_PATTERN = /[.\s_-](?:part|pt|cd|dis[ck]|dvd)[.\s_-]?(\d{1,2})(?!\d)/i;

/**
 * The split-file part token of a file name, and the name without it (the
 * stack key). Two files are parts of one video only when their stack keys are
 * equal and their part numbers differ — "Movie - Part1.mkv" + "Movie -
 * Part2.mkv". A lone "Milo Farrow … Part 1 (2010) - Bluray-1080p.mkv" matches
 * the token too, but the "Part 1" is its title (Jellyfin's stacking rule).
 */
export function splitPartToken(fileName: string): { part: number; stackKey: string } | null {
    const base = path.basename(fileName);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const match = PART_PATTERN.exec(stem);
    if (!match) return null;
    const stackKey = (stem.slice(0, match.index) + stem.slice(match.index + match[0].length))
        .toLowerCase()
        .trim();
    return { part: parseInt(match[1], 10), stackKey };
}

/** Strip {imdb-ttXXX}, [imdbid-ttXXX], [imdbid=tt...] annotations from the title.
 *  Accepts Jellyfin's `imdbid` token and `-`/`_`/space/`=` separators. */
const IMDB_ANNOTATION_PATTERN = /[{[]\s*imdb(?:id)?[-_ =]?tt\d{7,8}[^}\]]*[}\]]/gi;

/** Strip {tmdb-XXX}, [tmdbid-XXX], [tmdbid=XXX] annotations from the title.
 *  Accepts Jellyfin's `tmdbid` token and `-`/`_`/space/`=` separators. */
const TMDB_ANNOTATION_PATTERN = /[{[]\s*tmdb(?:id)?[-_ =]?\d+[^}\]]*[}\]]/gi;

/** Strip {tvdb-XXX}, [tvdbid-XXX] annotations from the title.
 *  We don't resolve TVDB ids (no TVDB metadata provider), but the tag must not
 *  pollute the search title. */
const TVDB_ANNOTATION_PATTERN = /[{[]\s*tvdb(?:id)?[-_ =]?\d+[^}\]]*[}\]]/gi;

/** Plex {edition-Name} curly-brace edition format (max 32 chars per Plex spec) */
const EDITION_BRACE_PATTERN = /[{[]\s*edition[-_\s]([^}\]]{1,32})[}\]]/i;

/** Map a natural-language edition name from {edition-XXX} to a canonical value. */
function normalizeEditionName(name: string): string {
    const lower = name.toLowerCase().trim();
    if (/director/.test(lower)) return 'directors_cut';
    if (/extended/.test(lower)) return 'extended';
    if (/theatrical/.test(lower)) return 'theatrical';
    if (/4k|uhd|2160p/.test(lower)) return '4k';
    if (/remaster/.test(lower)) return 'remastered';
    if (/coloriz/.test(lower)) return 'colorized';
    if (/imax/.test(lower)) return 'imax';
    if (/unrated/.test(lower)) return 'unrated';
    if (/uncut/.test(lower)) return 'uncut';
    if (/criterion/.test(lower)) return 'criterion';
    return lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Map a canonical edition value (e.g. 'directors_cut') to a human-readable display name. */
export function editionCanonicalToDisplayName(canonical: string): string {
    const MAP: Record<string, string> = {
        directors_cut: "Director's Cut",
        extended: 'Extended',
        theatrical: 'Theatrical',
        '4k': '4K',
        remastered: 'Remastered',
        colorized: 'Colorized',
        imax: 'IMAX',
        unrated: 'Unrated',
        uncut: 'Uncut',
        criterion: 'Criterion',
        special_edition: 'Special Edition',
        black_and_chrome: 'Black and Chrome',
        final_cut: 'Final Cut',
        open_matte: 'Open Matte',
    };
    if (MAP[canonical]) return MAP[canonical];
    // Fallback: title-case the underscore-separated string
    return canonical
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/**
 * Extract edition label from the working string.
 * Precedence: Plex {edition-XXX} → path-extracted → dot-pattern regex.
 */
function extractEdition(
    working: string,
    pathEdition: string | undefined,
): { edition?: string; working: string } {
    // Plex {edition-Director's Cut} format — highest priority
    const braceMatch = EDITION_BRACE_PATTERN.exec(working);
    if (braceMatch) {
        return {
            edition: normalizeEditionName(braceMatch[1]),
            working: working.replace(EDITION_BRACE_PATTERN, ' ').trim(),
        };
    }

    // Path-extracted edition (from parent folder)
    if (pathEdition) {
        return { edition: pathEdition, working };
    }

    // Dot-pattern regexes (directors_cut, extended, theatrical, 4k, remastered)
    for (const [re, value] of EDITION_PATTERNS) {
        if (re.test(working)) {
            return {
                edition: value,
                working: working.replace(re, ' ').trim(),
            };
        }
    }

    return { working };
}

/**
 * Extract season/episode info from the working string.
 * Precedence: multi-episode (S01E01E02) → single (S01E02) → anime bare number (- 12).
 */
function extractEpisode(working: string): {
    season?: number;
    episodeStart?: number;
    episodeEnd?: number;
    version?: number;
    working: string;
} {
    // Multi-episode: S01E01E02E03, S01E01-E03, or S01E01-02-03
    const multiMatch = MULTI_EP_PATTERN.exec(working);
    if (multiMatch) {
        // Extract both E-prefixed (E01) and bare-number continuation (-02) episode numbers
        const allEps = [...multiMatch[0].matchAll(/[Ee](\d{2,4})|-(\d{2})(?!\d)/g)].map((m) =>
            parseInt(m[1] ?? m[2], 10),
        );
        return {
            season: parseInt(multiMatch[1], 10),
            episodeStart: allEps[0],
            episodeEnd: allEps[allEps.length - 1],
            working:
                multiMatch.index === 0
                    ? working.slice(multiMatch[0].length).trim()
                    : working.slice(0, multiMatch.index).trim(),
        };
    }

    // Multi-episode alternate form: 1x02-03, 1x02x03
    const xMultiMatch = X_MULTI_EP_PATTERN.exec(working);
    if (xMultiMatch) {
        const eps = [...xMultiMatch[0].replace(/^\d{1,2}x/i, '').matchAll(/\d{1,3}/g)].map((m) =>
            parseInt(m[0], 10),
        );
        return {
            season: parseInt(xMultiMatch[1], 10),
            episodeStart: eps[0],
            episodeEnd: eps[eps.length - 1],
            working:
                xMultiMatch.index === 0
                    ? working.slice(xMultiMatch[0].length).trim()
                    : working.slice(0, xMultiMatch.index).trim(),
        };
    }

    // Single episode: S01E02 or S01E0001
    const seMatch = S_E_PATTERN.exec(working);
    if (seMatch) {
        return {
            season: parseInt(seMatch[1], 10),
            episodeStart: parseInt(seMatch[2], 10),
            working:
                seMatch.index === 0
                    ? working.slice(seMatch[0].length).trim()
                    : working.slice(0, seMatch.index).trim(),
        };
    }

    // Single episode, separated halves: S01.E02, S01 E02
    const sepMatch = S_SEP_E_PATTERN.exec(working);
    if (sepMatch) {
        return {
            season: parseInt(sepMatch[1], 10),
            episodeStart: parseInt(sepMatch[2], 10),
            working:
                sepMatch.index === 0
                    ? working.slice(sepMatch[0].length).trim()
                    : working.slice(0, sepMatch.index).trim(),
        };
    }

    // Spelled-out: "Staffel 3 Folge 06", "Season 2 Episode 4"
    const wordedMatch = WORDED_SE_PATTERN.exec(working);
    if (wordedMatch) {
        return {
            season: parseInt(wordedMatch[1], 10),
            episodeStart: parseInt(wordedMatch[2], 10),
            working:
                wordedMatch.index === 0
                    ? working.slice(wordedMatch[0].length).trim()
                    : working.slice(0, wordedMatch.index).trim(),
        };
    }

    // British "Series 2 - 03"
    const seriesMatch = SERIES_DASH_EPISODE_PATTERN.exec(working);
    if (seriesMatch) {
        return {
            season: parseInt(seriesMatch[1], 10),
            episodeStart: parseInt(seriesMatch[2], 10),
            working:
                seriesMatch.index === 0
                    ? working.slice(seriesMatch[0].length).trim()
                    : working.slice(0, seriesMatch.index).trim(),
        };
    }

    // Single episode alternate form: 1x02, 01x002
    const xSeMatch = X_SE_PATTERN.exec(working);
    if (xSeMatch) {
        return {
            season: parseInt(xSeMatch[1], 10),
            episodeStart: parseInt(xSeMatch[2], 10),
            working:
                xSeMatch.index === 0
                    ? working.slice(xSeMatch[0].length).trim()
                    : working.slice(0, xSeMatch.index).trim(),
        };
    }

    // Anime bare episode number: "- 12 [" or "- 01v2 [" (digit AFTER dash)
    const animeMatch = ANIME_EPISODE_PATTERN.exec(working);
    if (animeMatch) {
        return {
            episodeStart: parseInt(animeMatch[1], 10),
            version: animeMatch[2] ? parseInt(animeMatch[2], 10) : undefined,
            working: working.slice(0, animeMatch.index).trim(),
        };
    }

    // Anime number-before-dash: "Varenth 01 - Der Schwarze Ritter" (digit BEFORE dash)
    const numberFirstMatch = ANIME_EPISODE_NUMBER_FIRST_PATTERN.exec(working);
    if (numberFirstMatch) {
        return {
            episodeStart: parseInt(numberFirstMatch[1], 10),
            version: numberFirstMatch[2] ? parseInt(numberFirstMatch[2], 10) : undefined,
            working: working.slice(0, numberFirstMatch.index).trim(),
        };
    }

    // "EpNN" prefix: "Orion.Lantern.Park.Ep01.German.AC3..."
    const epPrefixMatch = EP_PREFIX_PATTERN.exec(working);
    if (epPrefixMatch) {
        return {
            episodeStart: parseInt(epPrefixMatch[1], 10),
            version: epPrefixMatch[2] ? parseInt(epPrefixMatch[2], 10) : undefined,
            working: working.slice(0, epPrefixMatch.index).trim(),
        };
    }

    // Number directly before bracket: "Hikari_ni_Iku_Yo!_10[720p]..."
    const beforeBracketMatch = ANIME_EPISODE_BEFORE_BRACKET_PATTERN.exec(working);
    if (beforeBracketMatch) {
        return {
            episodeStart: parseInt(beforeBracketMatch[1], 10),
            version: beforeBracketMatch[2] ? parseInt(beforeBracketMatch[2], 10) : undefined,
            working: working.slice(0, beforeBracketMatch.index).trim(),
        };
    }

    return { working };
}

/**
 * Sonarr's anime form: `SxxEyy - NNN - Title`. The number is a segment of its own, 2-4 digits,
 * directly after the SxxEyy token and delimited by ` - ` on both sides, so `S02E05 - 24 Hours`
 * (a title), `S03E01-02 - Career Day` (a two-parter) and `S01E05 - 12 Angry Men` do not match.
 * Captures season, episode and the absolute number.
 */
const SONARR_ABSOLUTE_PATTERN = /(?<![A-Za-z0-9])[Ss](\d{1,2})[Ee](\d{1,4}) - (\d{2,4}) - /;

/** A bare `S01E0422`: season 1 with an SxxEyy token, whose episode number is the absolute one. */
const SEASON_ONE_SE_PATTERN = /(?<![A-Za-z0-9])[Ss]0*1[Ee]\d+(?!\d)/;

/**
 * Absolute episode number carried by the file name, or undefined. `raw` is the
 * basename without its extension (parseMediaFilename strips the directories), so
 * a folder called `Show - S09E21 - 188 - Title` never counts.
 *
 * The Sonarr form must name a real season (not 0: specials are not part of the
 * absolute run) and the absolute number cannot be below the per-season episode
 * number (`S09E21 - 12 - Title` is an episode called "12"). `S01E05 - 300 -
 * Title` passes these checks even when 300 is a title; the title check of the
 * reconciliation (the file's title must agree with the target's name) guards it.
 *
 * A Sonarr segment of 1900-2099 is ambiguous with a year in the title position
 * (`Show - S01E05 - 1984 - Title`), so it is declined; the series' episodes past
 * 1899 do not exist outside very long runs and fall back to the number-match path.
 * The bare form needs season 1 and an episode >= 100: a normal season 1 does not
 * run that long, a single-season absolute library does.
 */
function extractAbsoluteEpisode(
    raw: string,
    season: number | undefined,
    episodeStart: number | undefined,
    episodeEnd: number | undefined,
): number | undefined {
    const sonarr = SONARR_ABSOLUTE_PATTERN.exec(raw);
    if (sonarr) {
        const seasonInName = parseInt(sonarr[1], 10);
        const episodeInName = parseInt(sonarr[2], 10);
        const n = parseInt(sonarr[3], 10);
        if (seasonInName === 0 || n < episodeInName) return undefined;
        return n > 0 && !(n >= 1900 && n <= 2099) ? n : undefined;
    }
    if (
        season === 1 &&
        episodeStart !== undefined &&
        episodeStart >= 100 &&
        episodeEnd === undefined &&
        SEASON_ONE_SE_PATTERN.test(raw)
    ) {
        return episodeStart;
    }
    return undefined;
}

/**
 * Extract release year from the working string.
 * Precedence: parenthesised "(2020)" → bare year (not at index 0) → disambiguate leading year.
 */
function extractYear(working: string): { year?: number; working: string } {
    // Parenthesised year: "(2020)" — highest priority, unambiguous
    const parenMatch = PAREN_YEAR_PATTERN.exec(working);
    if (parenMatch) {
        return {
            year: parseInt(parenMatch[1], 10),
            working: working.slice(0, parenMatch.index).trim(),
        };
    }

    // Bare year
    const yearMatch = YEAR_PATTERN.exec(working);
    if (!yearMatch) return { working };

    // Year NOT at start — standard case: "The Lantern 1999 1080p" → year=1999
    if (yearMatch.index !== 0) {
        return {
            year: parseInt(yearMatch[1], 10),
            working: working.slice(0, yearMatch.index).trim(),
        };
    }

    // Year at start — title starts with a year (e.g. "2001 A Harbor Journey 1968").
    // Look for a later year to use as the release year.
    const laterMatch = working.slice(yearMatch[0].length).match(YEAR_PATTERN);
    if (laterMatch && laterMatch.index !== undefined) {
        return {
            year: parseInt(laterMatch[1], 10),
            working: working.slice(0, yearMatch[0].length + laterMatch.index).trim(),
        };
    }

    // No later year found — leading digits are part of the title, leave year undefined
    return { working };
}

export interface ParsedSubtitleFilename {
    /** BCP-47 language tag: 'en', 'de', 'pt-BR', or null if not detected */
    language: string | null;
    /** True if 'forced' appears in the filename */
    isForced: boolean;
    /** True if 'sdh' or 'hi' (hearing impaired) appears in the filename */
    isSDH: boolean;
    /** Subtitle format from extension */
    format: 'srt' | 'ass' | 'ssa' | 'vtt' | 'sub' | 'sup';
    /** Filename stem with language/flag suffixes stripped */
    baseName: string;
}

/**
 * Known ISO 639-1 (2-char) and common ISO 639-2 (3-char) language codes.
 * BCP-47 region variants like 'pt-BR' are matched by the region pattern below.
 */
const LANG_2 = new Set([
    'af',
    'ar',
    'az',
    'be',
    'bg',
    'bn',
    'bs',
    'ca',
    'cs',
    'cy',
    'da',
    'de',
    'el',
    'en',
    'eo',
    'es',
    'et',
    'eu',
    'fa',
    'fi',
    'fr',
    'ga',
    'gl',
    'gu',
    'he',
    'hi',
    'hr',
    'hu',
    'hy',
    'id',
    'is',
    'it',
    'ja',
    'ka',
    'kk',
    'km',
    'kn',
    'ko',
    'ku',
    'lt',
    'lv',
    'mk',
    'ml',
    'mn',
    'mr',
    'ms',
    'mt',
    'my',
    'nb',
    'ne',
    'nl',
    'no',
    'pa',
    'pl',
    'pt',
    'ro',
    'ru',
    'sk',
    'sl',
    'sq',
    'sr',
    'sv',
    'sw',
    'ta',
    'te',
    'th',
    'tl',
    'tr',
    'uk',
    'ur',
    'uz',
    'vi',
    'zh',
]);

const LANG_3 = new Set([
    'chi',
    'zho',
    'eng',
    'fre',
    'fra',
    'ger',
    'deu',
    'jpn',
    'kor',
    'por',
    'rus',
    'spa',
    'ara',
    'dut',
    'nld',
    'ita',
    'pol',
    'tur',
    'swe',
    'nor',
    'dan',
    'fin',
    'ces',
    'slk',
    'hrv',
    'bul',
    'ron',
    'hun',
    'heb',
    'ind',
    'vie',
    'tha',
    'ell',
    'ukr',
    'cat',
    'nob',
    'srp',
    'est',
    'lav',
    'lit',
    'slv',
    'isl',
    'mkd',
    'mlt',
    'cym',
    'bos',
    'glg',
    'euc',
    'eus',
    'afr',
    'swh',
    'msa',
    'ben',
    'hin',
    'tam',
    'tel',
    'kan',
    'mal',
    'mar',
    'guj',
    'nep',
    'sin',
    'mya',
    'khm',
    'lao',
    'amh',
    'som',
    'yor',
    'hau',
    'mon',
    'kaz',
]);

/** BCP-47 region variant pattern: 'pt-BR', 'zh-TW', 'zh-CN' */
const BCP47_REGION = /^([a-z]{2,3})-([A-Z]{2})$/;

/** Subtitle flags recognized in filenames */
const FORCED_RE = /^forced$/i;
// 'hi' is excluded here — it is ISO 639-1 for Hindi and would cause false positives.
// SDH-tagged files should use 'sdh' explicitly.
const SDH_RE = /^sdh$/i;

const SUBTITLE_FORMATS_SET = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub', 'sup']);

function isLanguageCode(token: string): boolean {
    if (LANG_2.has(token.toLowerCase())) return true;
    if (LANG_3.has(token.toLowerCase())) return true;
    // Normalize region: 'pt-br' → 'pt-BR' before testing
    const normalized = token.replace(/-([a-z]{2})$/, (_, r: string) => '-' + r.toUpperCase());
    if (BCP47_REGION.test(normalized)) return true;
    return false;
}

/**
 * Parse a subtitle filename to extract language, flags, and format.
 *
 * Subtitle filenames follow the convention:
 *   <baseName>.<lang>.<flags>.<ext>
 *
 * Examples:
 *   Movie.en.srt           → { language: 'en', isForced: false, isSDH: false }
 *   Movie.de.forced.srt    → { language: 'de', isForced: true }
 *   Movie.pt-BR.srt        → { language: 'pt-BR' }
 *   Movie.en.sdh.srt       → { language: 'en', isSDH: true }
 *   Movie.srt              → { language: null }
 */
export function parseSubtitleFilename(filePath: string): ParsedSubtitleFilename {
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase().slice(1);
    const stem = path.basename(filename, path.extname(filename));

    // Split stem on '.' to find language/flag tokens at the end
    const parts = stem.split('.');
    let language: string | null = null;
    let isForced = false;
    let isSDH = false;
    let baseEnd = parts.length;

    // Scan from the end, consuming known tokens
    for (let i = parts.length - 1; i >= 0; i--) {
        const token = parts[i];
        if (FORCED_RE.test(token)) {
            isForced = true;
            baseEnd = i;
        } else if (SDH_RE.test(token)) {
            isSDH = true;
            baseEnd = i;
        } else if (isLanguageCode(token)) {
            // Normalize region suffix to uppercase (e.g. 'pt-br' → 'pt-BR')
            language = token.replace(/-([a-z]{2})$/, (_, r: string) => '-' + r.toUpperCase());
            baseEnd = i;
            break; // Language is the last marker — stop here
        } else {
            break; // Unknown token — part of the base name
        }
    }

    const baseName = parts.slice(0, baseEnd).join('.');

    const format = (
        SUBTITLE_FORMATS_SET.has(ext) ? ext : 'srt'
    ) as ParsedSubtitleFilename['format'];

    return {
        language,
        isForced,
        isSDH,
        format,
        baseName: baseName || stem,
    };
}

/**
 * Parse a media filename (or full path) into structured info.
 */
export function parseMediaFilename(
    filePathOrName: string,
    options: ParseMediaFilenameOptions = {},
): ParsedFilename {
    // 0. Extract IMDB ID, TMDB ID, and edition from full path (covers both filename and parent folder)
    const imdbMatch = filePathOrName.match(/\btt\d{7,8}\b/i);
    const imdbId = imdbMatch ? imdbMatch[0].toLowerCase() : undefined;
    const tmdbBraceMatch = filePathOrName.match(/[{[]\s*tmdb(?:id)?[-_ =]?(\d+)[^}\]]*[}\]]/i);
    const tmdbId = tmdbBraceMatch ? tmdbBraceMatch[1] : undefined;
    const pathEditionMatch = EDITION_BRACE_PATTERN.exec(filePathOrName);
    const pathEdition = pathEditionMatch ? normalizeEditionName(pathEditionMatch[1]) : undefined;

    // Work with just the filename, no directory
    const filename = path.basename(filePathOrName);
    // Strip extension
    const extname = path.extname(filename);
    const raw = extname ? filename.slice(0, -extname.length) : filename;

    let working = raw;

    // 1. Strip [group] prefix (anime) — unless the bracket IS the episode token
    //    ("[S04.E05] Star Harbor Enterprise - Cold Station 12"), which is unwrapped.
    working = working.replace(/^\[([^\]]*)\]\s*/, (_m, inner: string) =>
        S_E_PATTERN.test(inner) || S_SEP_E_PATTERN.test(inner) ? `${inner} ` : '',
    );

    // 2. Strip {imdb-ttXXXXXXX}, {tmdb-XXX}, {tvdb-XXX} annotations so they don't pollute the title
    working = working
        .replace(IMDB_ANNOTATION_PATTERN, '')
        .replace(TMDB_ANNOTATION_PATTERN, '')
        .replace(TVDB_ANNOTATION_PATTERN, '')
        .trim();

    // 3. Extract part number from working string (before episode/year stripping)
    const partMatch = PART_PATTERN.exec(working);
    const part = partMatch ? parseInt(partMatch[1], 10) : undefined;

    // 4. Extract edition
    const editionResult = extractEdition(working, pathEdition);
    const edition = editionResult.edition;
    working = editionResult.working;

    // 4b. Detect episode type (OVA/ONA/Special/Movie) before junk stripping
    let episodeType: ParsedFilename['episodeType'];
    // The number after an OVA/ONA token is its episode ("OVA.01"). Read it before
    // the token is stripped, else it is a stray number nothing reads. It loses
    // only to a rule that also names the season (SxxEyy, 1x02, "Series 2 - 03");
    // it beats the bare-number rules and an air date (applied below).
    let typedEpisodeNumber: number | undefined;
    let typedVersion: number | undefined;
    let typedEpisodeIndex = 0;
    const typedNumberMatch = OVA_ONA_NUMBER_PATTERN.exec(working);
    if (typedNumberMatch) {
        typedEpisodeNumber = parseInt(typedNumberMatch[1], 10);
        typedVersion = typedNumberMatch[2] ? parseInt(typedNumberMatch[2], 10) : undefined;
        typedEpisodeIndex = typedNumberMatch.index;
        working =
            `${working.slice(0, typedNumberMatch.index)} ${working.slice(typedNumberMatch.index + typedNumberMatch[0].length)}`.trim();
        episodeType = /^ova/i.test(typedNumberMatch[0]) ? 'ova' : 'ona';
    }
    for (const [re, type] of episodeType ? [] : EPISODE_TYPE_PATTERNS) {
        if (re.test(working)) {
            episodeType = type;
            // Remove the matched token from working so it doesn't pollute the title
            working = working.replace(re, ' ').trim();
            break;
        }
    }

    // 5. Extract episode info. A daily-show air date is read first: the anime
    //    fallbacks would otherwise take the day in "Show 2021 03 14 - Guest" for
    //    an episode number. A real episode number still wins (extractAirDate).
    const inSeasonFolder =
        seasonNumberFromFolderName(path.basename(path.dirname(filePathOrName))) !== null;
    const airDateResult =
        options.airDates && typedEpisodeNumber === undefined
            ? extractAirDate(working, inSeasonFolder)
            : { working };
    const airDate = airDateResult.airDate;
    working = airDateResult.working;
    const episodeResult: ReturnType<typeof extractEpisode> = airDate
        ? { working }
        : extractEpisode(working);
    let { episodeStart, version } = episodeResult;
    const { season, episodeEnd } = episodeResult;
    working = episodeResult.working;
    let cutTitleAtTypedToken = false;
    if (typedEpisodeNumber !== undefined && season === undefined) {
        episodeStart = typedEpisodeNumber;
        version = typedVersion;
        cutTitleAtTypedToken = typedEpisodeIndex > 0;
    }
    if (!airDate && episodeStart === undefined && inSeasonFolder) {
        const leading = LEADING_EPISODE_NUMBER_PATTERN.exec(working);
        if (leading) {
            episodeStart = parseInt(leading[1], 10);
            version = leading[2] ? parseInt(leading[2], 10) : undefined;
            working = working.slice(leading[0].length).trim();
        }
    }

    // 6. Extract year. A daily-show file without a year of its own takes the
    //    air date's (callers identifying a series use seriesYearHint).
    const yearResult = extractYear(working);
    working = yearResult.working;
    // Like the other episode rules, the title is the text before the OVA token
    // ("Show.OVA.01.German..." → "Show"). Cut after the year is read, so
    // "Show.OVA.01.2012" keeps 2012. The rules above only ever shorten
    // `working` to a prefix, so the index still points at the token.
    if (cutTitleAtTypedToken && working.length > typedEpisodeIndex) {
        working = working.slice(0, typedEpisodeIndex).trim();
    }
    const yearFromAirDate = yearResult.year === undefined && airDate !== undefined;
    const year = yearResult.year ?? (airDate ? parseInt(airDate.slice(0, 4), 10) : undefined);

    // 7. Normalise separators: dots and underscores → spaces, then trim dashes
    working = working
        .replace(/[._]+/g, ' ')
        .replace(/\s*-\s*/g, ' ')
        .trim();

    // 8. Split remaining tokens and drop junk
    const tokens = working.split(/\s+/).filter((t) => {
        if (!t) return false;
        if (JUNK_TOKENS.has(t.toLowerCase())) return false;
        // Drop [bracketed] blocks
        if (/^\[.*\]$/.test(t)) return false;
        return true;
    });

    const title = tokens.join(' ').trim() || raw;

    return {
        title,
        year,
        season,
        episodeStart,
        episodeEnd,
        part,
        edition,
        imdbId,
        tmdbId,
        episode: episodeStart, // backward-compat alias
        version,
        episodeType,
        airDate,
        yearFromAirDate: yearFromAirDate || undefined,
        absoluteEpisode: extractAbsoluteEpisode(raw, season, episodeStart, episodeEnd),
        raw,
    };
}
