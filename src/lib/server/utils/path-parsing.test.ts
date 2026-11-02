// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    extractSeriesTitleFromPath,
    extractSeriesYearFromPath,
    extractSeasonNumberFromPath,
    seasonNumberFromFolderName,
    resolveSeasonNumber,
} from './path-parsing';

describe('extractSeriesTitleFromPath', () => {
    const root = '/data/anime/';

    it('extracts series name above Season folder', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Orbit Guild (2002) [imdbid-tt0377210]/Season 01/01 Abgrund [720p].mkv',
                root,
                'fallback',
            ),
        ).toBe('Orbit Guild');
    });

    it('strips parenthesized year', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Sky Harbor (1999)/Season 01/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Sky Harbor');
    });

    it('strips bare trailing year', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Drifting Clouds 2008/Season 03/S03E01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Drifting Clouds');
    });

    it('strips IMDB ID in brackets', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Sorami [imdbid-tt0409591]/Season 01/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Sorami');
    });

    it('strips TMDB ID in braces', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Voyage to Orion {tmdb-1429}/Season 01/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Voyage to Orion');
    });

    it('strips Jellyfin-style [tmdbid-N] and {tvdb-N} tags, also glued to the title', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Voyage to Orion[tmdbid-85221]/Season 01/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Voyage to Orion');
        expect(
            extractSeriesTitleFromPath(
                '/data/tv/Voyage to Orion (1908) {tvdb-71663}/Season 01/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Voyage to Orion');
    });

    it('strips TVDB ID in brackets', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Steins Gate [tvdbid-12345]/Season 01/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Steins Gate');
    });

    it('handles German "Staffel" season folders', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Dark (2017)/Staffel 1/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Dark');
    });

    it('handles French "Saison" season folders', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Lupin (2021)/Saison 2/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Lupin');
    });

    it('handles Spanish "Temporada" season folders', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/La Casa de Papel/Temporada 3/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('La Casa de Papel');
    });

    it('handles short S01 season folders', () => {
        expect(
            extractSeriesTitleFromPath('/data/anime/Friends/S01/ep01.mkv', root, 'fallback'),
        ).toBe('Friends');
    });

    it('uses shallowest folder when no season folder exists (single level)', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Sky Harbor/01 Romance Dawn.mkv',
                root,
                'fallback',
            ),
        ).toBe('Sky Harbor');
    });

    it('uses shallowest folder when no season folder exists (two levels)', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/My Show/Extras/behind-the-scenes.mkv',
                root,
                'fallback',
            ),
        ).toBe('My Show');
    });

    it('uses shallowest folder for non-standard season subfolder', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/My Show/Season 01 Special/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('My Show');
    });

    it('uses first folder for flat structure (file directly under root)', () => {
        expect(
            extractSeriesTitleFromPath('/data/anime/Movie Name/movie.mkv', root, 'fallback'),
        ).toBe('Movie Name');
    });

    it('returns fallback when file is directly in library root', () => {
        expect(extractSeriesTitleFromPath('/data/anime/standalone.mkv', root, 'my fallback')).toBe(
            'my fallback',
        );
    });

    it('returns fallback when stripping leaves empty string', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/(2002) [imdbid-tt0377210]/Season 01/ep.mkv',
                root,
                'my fallback',
            ),
        ).toBe('my fallback');
    });

    it('handles season folder at index 0 (skips it)', () => {
        // Season folder is the first segment — no parent folder above it
        expect(
            extractSeriesTitleFromPath('/data/anime/Season 01/ep01.mkv', root, 'my fallback'),
        ).toBe('Season 01');
    });

    it('strips combined year and IMDB ID', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Orbit Guild (2002) [imdbid-tt0377210]/Season 01/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Orbit Guild');
    });

    it('handles nested season folders (specials subfolder)', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/My Show/Season 01/Season 01 Special/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('My Show');
    });

    it('handles library root without trailing slash', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/My Show/Season 01/ep01.mkv',
                '/data/anime',
                'fallback',
            ),
        ).toBe('My Show');
    });

    it('strips numeric disambiguation suffix (0)', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Sentenced to Be a Hero (0)/Season 01/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Sentenced to Be a Hero');
    });

    it('strips numeric disambiguation suffix (1)', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Some Series (1)/Season 01/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Some Series');
    });

    it('strips numeric disambiguation suffix (2) and higher', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Some Series (2)/Season 01/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Some Series');
    });

    it('does not strip (0) when combined with year tag — year regex fires first', () => {
        // Year regex removes (2023), then (0) is a separate standalone tag that also gets removed
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Dark Show (2023) (0)/Season 01/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Dark Show');
    });

    it('strips empty IMDB ID tag [imdbid-] (Jellyfin unresolved series)', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/tv/Squatters[imdbid-]/Season 1/Squatters (2025) S01E01 WEBDL.mkv',
                root,
                'fallback',
            ),
        ).toBe('Squatters');
    });

    it('strips empty TMDB ID tag [tmdb-] (Jellyfin unresolved series)', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/tv/Petals of Reincarnation[tmdb-]/Season 1/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Petals of Reincarnation');
    });

    it('strips empty TVDB ID tag [tvdbid-]', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/tv/Some Show [tvdbid-]/Season 1/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Some Show');
    });

    it('strips empty braced TMDB tag {tmdb-}', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/tv/Some Show {tmdb-}/Season 1/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Some Show');
    });

    it('strips braced TMDB tag with non-digit content {tmdb-abc123}', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/anime/Some Show {tmdb-abc123}/Season 1/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Some Show');
    });

    it('strips year + empty IMDB tag combination', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/tv/Petals of Reincarnation (2026) [imdbid-]/Season 01/ep01.mkv',
                root,
                'fallback',
            ),
        ).toBe('Petals of Reincarnation');
    });

    it('extracts series name above a Specials folder', () => {
        expect(
            extractSeriesTitleFromPath(
                '/data/tv/The Outpost (2005)/Specials/Deleted Scene.mkv',
                '/data/tv',
                'fallback',
            ),
        ).toBe('The Outpost');
    });
});

describe('seasonNumberFromFolderName', () => {
    it('parses "Season 02" → 2', () => {
        expect(seasonNumberFromFolderName('Season 02')).toBe(2);
    });
    it('parses "Season 1" → 1', () => {
        expect(seasonNumberFromFolderName('Season 1')).toBe(1);
    });
    it('parses "Staffel 3" / "Saison 4" / "Temporada 5"', () => {
        expect(seasonNumberFromFolderName('Staffel 3')).toBe(3);
        expect(seasonNumberFromFolderName('Saison 4')).toBe(4);
        expect(seasonNumberFromFolderName('Temporada 5')).toBe(5);
    });
    it('parses abbreviated "S07" → 7', () => {
        expect(seasonNumberFromFolderName('S07')).toBe(7);
    });
    it('maps "Specials"/"Special" → 0 (Jellyfin)', () => {
        expect(seasonNumberFromFolderName('Specials')).toBe(0);
        expect(seasonNumberFromFolderName('Special')).toBe(0);
    });
    it('parses "Season 00" → 0', () => {
        expect(seasonNumberFromFolderName('Season 00')).toBe(0);
    });
    it('returns null for non-season folders', () => {
        expect(seasonNumberFromFolderName('The Outpost')).toBeNull();
        expect(seasonNumberFromFolderName('Extras')).toBeNull();
    });
});

describe('extractSeasonNumberFromPath', () => {
    const root = '/data/tv';

    it('reads the season number from the "Season 02" folder', () => {
        expect(
            extractSeasonNumberFromPath('/data/tv/My Show/Season 02/My Show - 05.mkv', root),
        ).toBe(2);
    });

    it('maps a "Specials" folder to season 0', () => {
        expect(extractSeasonNumberFromPath('/data/tv/My Show/Specials/xmas.mkv', root)).toBe(0);
    });

    it('returns undefined when there is no season folder in the path', () => {
        expect(
            extractSeasonNumberFromPath('/data/tv/My Show/My Show - 05.mkv', root),
        ).toBeUndefined();
    });

    it('uses the nearest (deepest) season folder', () => {
        expect(extractSeasonNumberFromPath('/data/tv/My Show/Season 03/Specials/x.mkv', root)).toBe(
            0,
        );
    });
});

describe('resolveSeasonNumber (precedence)', () => {
    it('filename SxxExx wins over the folder season', () => {
        // "Series S01E15" inside a mislabelled "Season 02" folder → season 1
        expect(resolveSeasonNumber(1, 2, 'regular')).toBe(1);
    });

    it('folder season is used when the filename carries no season', () => {
        expect(resolveSeasonNumber(undefined, 2, 'regular')).toBe(2);
    });

    it('folder season wins over an OVA/Special title token', () => {
        // An "OVA" file inside "Season 02" → 2 (folder beats the token)
        expect(resolveSeasonNumber(undefined, 2, 'ova')).toBe(2);
    });

    it('specials/OVA/ONA token → season 0 when there is no folder season', () => {
        expect(resolveSeasonNumber(undefined, undefined, 'special')).toBe(0);
        expect(resolveSeasonNumber(undefined, undefined, 'ova')).toBe(0);
        expect(resolveSeasonNumber(undefined, undefined, 'ona')).toBe(0);
    });

    it('defaults to season 1', () => {
        expect(resolveSeasonNumber(undefined, undefined, 'regular')).toBe(1);
        expect(resolveSeasonNumber(undefined, undefined, undefined)).toBe(1);
    });

    it('season 0 from either filename or folder is preserved (not treated as absent)', () => {
        expect(resolveSeasonNumber(0, 5, 'regular')).toBe(0); // explicit S00 in filename
        expect(resolveSeasonNumber(undefined, 0, 'regular')).toBe(0); // Specials folder
    });
});

describe('extractSeriesYearFromPath', () => {
    const root = '/data/series';
    it('reads the year of the series folder', () => {
        expect(
            extractSeriesYearFromPath(
                '/data/series/Shorefolk (2001) [imdbid-tt0285403]/Season 01/Shorefolk - S01E01.mkv',
                root,
            ),
        ).toBe(2001);
    });
    it('reads a doubled "(2026) (2026)" as 2026', () => {
        expect(
            extractSeriesYearFromPath(
                '/data/series/Shorefolk (2026) (2026) [imdbid-tt37017338]/Season 01/Shorefolk - S01E01.mkv',
                root,
            ),
        ).toBe(2026);
    });
    it('is undefined when the folder has no year', () => {
        expect(
            extractSeriesYearFromPath(
                '/data/series/Shorefolk/Season 01/Shorefolk - S01E01.mkv',
                root,
            ),
        ).toBeUndefined();
    });
    it('is undefined when the folder names two different years', () => {
        expect(
            extractSeriesYearFromPath('/data/series/Show (2001) (2026)/Season 01/S01E01.mkv', root),
        ).toBeUndefined();
    });
    it('ignores a year that is the title itself, not a (YYYY) tag', () => {
        expect(extractSeriesYearFromPath('/data/series/1923/Season 01/S01E01.mkv', root)).toBe(
            undefined,
        );
    });
    it('uses the shallowest folder when there is no season folder', () => {
        expect(
            extractSeriesYearFromPath('/data/series/Show (2019)/Show - 05 (2021).mkv', root),
        ).toBe(2019);
    });
});
