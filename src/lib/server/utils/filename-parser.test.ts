// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { parseMediaFilename } from './filename-parser.js';
import { parseSubtitleFilename, seriesYearHint } from './filename-parser.js';

describe('ParsedFilename amendments', () => {
    it('parses range episodes S01E01E02E03', () => {
        const r = parseMediaFilename('Voyage.to.Orion.S01E01E02E03.mkv');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(1);
        expect(r.episodeEnd).toBe(3);
    });

    it('parses range episodes S01E01-E03', () => {
        const r = parseMediaFilename('Show.S01E01-E03.mkv');
        expect(r.episodeStart).toBe(1);
        expect(r.episodeEnd).toBe(3);
    });

    it('parses bare-number multi-episode S01E01-02-03', () => {
        const r = parseMediaFilename(
            'Harborfolk Adventures - S01E01-02-03 - Help Wanted + Reef Blower + Tea at the Treedome - HDTV-1080p.mp4',
        );
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(1);
        expect(r.episodeEnd).toBe(3);
    });

    it('bare-number multi-episode does not match quality token like -1080p', () => {
        const r = parseMediaFilename('Show.S01E05-1080p.mkv');
        expect(r.episodeStart).toBe(5);
        expect(r.episodeEnd).toBeUndefined();
    });

    it('parses split file Part1', () => {
        const r = parseMediaFilename('Show.S01E01.Part1.mkv');
        expect(r.episodeStart).toBe(1);
        expect(r.part).toBe(1);
    });

    it('parses split file pt2', () => {
        const r = parseMediaFilename('Show.S01E01.pt2.mkv');
        expect(r.part).toBe(2);
    });

    it('extracts edition: directors cut', () => {
        const r = parseMediaFilename('The.Lantern.1999.Directors.Cut.mkv');
        expect(r.edition).toBe('directors_cut');
        expect(r.title).toBe('The Lantern');
    });

    it('extracts edition: extended edition', () => {
        const r = parseMediaFilename('The.Lantern.1999.Extended.Edition.mkv');
        expect(r.edition).toBe('extended');
    });

    it('extracts edition: 4K', () => {
        const r = parseMediaFilename('The.Lantern.1999.4K.mkv');
        expect(r.edition).toBe('4k');
    });

    it('extracts IMDB ID from filename', () => {
        const r = parseMediaFilename('The.Lantern.1999.{imdb-tt0133093}.mkv');
        expect(r.imdbId).toBe('tt0133093');
        expect(r.title).toBe('The Lantern');
    });

    it('extracts IMDB ID from folder name', () => {
        const r = parseMediaFilename(
            '/movies/The Lantern (1999) {imdb-tt0133093}/The.Lantern.1999.mkv',
        );
        expect(r.imdbId).toBe('tt0133093');
    });

    it('single episode still works via episodeStart', () => {
        const r = parseMediaFilename('Show.S02E05.mkv');
        expect(r.season).toBe(2);
        expect(r.episodeStart).toBe(5);
        expect(r.episodeEnd).toBeUndefined();
    });

    // TMDB ID extraction
    it('extracts TMDB ID from {tmdb-603} in filename', () => {
        const r = parseMediaFilename('The.Lantern.1999.{tmdb-603}.mkv');
        expect(r.tmdbId).toBe('603');
        expect(r.title).toBe('The Lantern');
    });

    it('extracts TMDB ID from {tmdb-603} in folder name', () => {
        const r = parseMediaFilename('/movies/The Lantern (1999) {tmdb-603}/The.Lantern.1999.mkv');
        expect(r.tmdbId).toBe('603');
    });

    it('strips {tmdb-XXX} annotation from title', () => {
        const r = parseMediaFilename('Cloud Runner (1982) {tmdb-78}.mkv');
        expect(r.tmdbId).toBe('78');
        expect(r.title).not.toContain('tmdb');
        expect(r.title).toBe('Cloud Runner');
    });

    // Plex {edition-XXX} curly-brace format
    it("extracts edition from Plex {edition-Director's Cut}", () => {
        const r = parseMediaFilename("The.Lantern.1999.{edition-Director's Cut}.mkv");
        expect(r.edition).toBe('directors_cut');
        expect(r.title).toBe('The Lantern');
    });

    it('extracts edition from Plex {edition-Extended Edition}', () => {
        const r = parseMediaFilename('The.Lantern.1999.{edition-Extended Edition}.mkv');
        expect(r.edition).toBe('extended');
    });

    it('extracts edition from Plex {edition-Final Cut} as slugified fallback', () => {
        const r = parseMediaFilename('Cloud.Runner.1982.{edition-Final Cut}.mkv');
        expect(r.edition).toBe('final_cut');
    });

    it('extracts edition from Plex {edition-4K}', () => {
        const r = parseMediaFilename('Dawn.2021.{edition-4K}.mkv');
        expect(r.edition).toBe('4k');
    });

    it('extracts edition from folder name with {edition-XXX}', () => {
        const r = parseMediaFilename(
            "/movies/The Silent Beacon (2008) {edition-Director's Cut}/The Silent Beacon.mkv",
        );
        expect(r.edition).toBe('directors_cut');
    });

    // Split file keywords: cd, disc, disk, dvd
    it('parses split file cd1', () => {
        const r = parseMediaFilename('The.Silent.Beacon.2008.cd1.mkv');
        expect(r.part).toBe(1);
        expect(r.title).toBe('The Silent Beacon');
    });

    it('parses split file disc2', () => {
        const r = parseMediaFilename('Movie.disc2.mkv');
        expect(r.part).toBe(2);
    });

    it('parses split file disk1', () => {
        const r = parseMediaFilename('Movie.disk1.mkv');
        expect(r.part).toBe(1);
    });

    it('parses split file dvd1', () => {
        const r = parseMediaFilename('Movie.dvd1.avi');
        expect(r.part).toBe(1);
    });

    it('does not false-positive cd on Disco.cd (no digit follows)', () => {
        const r = parseMediaFilename('Disco.Lantern.2019.mkv');
        expect(r.part).toBeUndefined();
    });
});

describe('Jellyfin-compat naming gaps', () => {
    // #3 — 1x02 alternate episode form
    it('parses 1x02 alternate episode form', () => {
        const r = parseMediaFilename('Mira the Lantern Keeper 1x02.mkv');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(2);
        expect(r.title).toBe('Mira the Lantern Keeper');
    });

    it('parses 12x05 (two-digit season) alternate form', () => {
        const r = parseMediaFilename('Harbor Watch 12x05 The Haunting.mkv');
        expect(r.season).toBe(12);
        expect(r.episodeStart).toBe(5);
    });

    it('parses multi-episode 1x02-03 alternate form', () => {
        const r = parseMediaFilename('Show 1x02-03.mkv');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(2);
        expect(r.episodeEnd).toBe(3);
    });

    it('parses multi-episode 1x02x03 alternate form', () => {
        const r = parseMediaFilename('Show 1x02x03.mkv');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(2);
        expect(r.episodeEnd).toBe(3);
    });

    it('does NOT read a resolution token like 1920x1080 as season×episode', () => {
        const r = parseMediaFilename('The Lantern (1999) 1920x1080.mkv');
        expect(r.season).toBeUndefined();
        expect(r.episodeStart).toBeUndefined();
        expect(r.year).toBe(1999);
    });

    it('does NOT read 1280x720 as season×episode', () => {
        const r = parseMediaFilename('Daydream 2010 1280x720 BluRay.mkv');
        expect(r.season).toBeUndefined();
        expect(r.episodeStart).toBeUndefined();
    });

    it('does NOT read aspect-ratio tokens 4x3 / 16x9 as season×episode', () => {
        const a = parseMediaFilename('Old Movie (1985) 4x3.mkv');
        expect(a.season).toBeUndefined();
        expect(a.episodeStart).toBeUndefined();
        const b = parseMediaFilename('Concert 16x9.mkv');
        expect(b.season).toBeUndefined();
        expect(b.episodeStart).toBeUndefined();
    });

    // #4 — Jellyfin provider-id tag forms
    it('extracts TMDB ID from Jellyfin [tmdbid-603] tag', () => {
        const r = parseMediaFilename('The Lantern (1999) [tmdbid-603].mkv');
        expect(r.tmdbId).toBe('603');
        expect(r.title).toBe('The Lantern');
    });

    it('extracts TMDB ID from [tmdbid=603] (equals form)', () => {
        const r = parseMediaFilename('The Lantern (1999) [tmdbid=603].mkv');
        expect(r.tmdbId).toBe('603');
    });

    it('extracts IMDB ID from Jellyfin [imdbid-tt0133093] tag and cleans title', () => {
        const r = parseMediaFilename('The Lantern (1999) [imdbid-tt0133093].mkv');
        expect(r.imdbId).toBe('tt0133093');
        expect(r.title).toBe('The Lantern');
    });

    it('strips a [tvdbid-1234] tag from the title', () => {
        const r = parseMediaFilename(
            '/tv/Harbor Watch (2005) [tvdbid-78804]/Harbor Watch 1x01.mkv',
        );
        expect(r.title).not.toMatch(/tvdb/i);
    });

    // #9 — multi-part number past a single digit
    it('parses split file cd10 (two-digit part)', () => {
        const r = parseMediaFilename('Long.Movie.cd10.mkv');
        expect(r.part).toBe(10);
    });

    it('parses split file part12', () => {
        const r = parseMediaFilename('Long.Movie.part12.mkv');
        expect(r.part).toBe(12);
    });
});

describe('Year-at-start-of-title disambiguation', () => {
    it('parses "2001 A Harbor Journey (1968).mkv" — uses paren year, keeps full title', () => {
        const r = parseMediaFilename('2001 A Harbor Journey (1968).mkv');
        expect(r.title).toBe('2001 A Harbor Journey');
        expect(r.year).toBe(1968);
    });

    it('parses "1917 (2019).mkv" — leading year is part of title, paren year is release year', () => {
        const r = parseMediaFilename('1917 (2019).mkv');
        expect(r.title).toBe('1917');
        expect(r.year).toBe(2019);
    });

    it('parses "Cloud Runner 2049 (2017).mkv" — mid-title year not at index 0, paren year wins', () => {
        const r = parseMediaFilename('Cloud Runner 2049 (2017).mkv');
        expect(r.title).toBe('Cloud Runner 2049');
        expect(r.year).toBe(2017);
    });
});

describe('Anime 4-digit episode numbers', () => {
    // Jellyfin / large-anime S01E0001 style (absolute order stored as S01ExxXX)
    it('parses S01E0001 (4-digit episode)', () => {
        const r = parseMediaFilename('S01E0001 - SKY HARBOR [GER].avi');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(1);
        expect(r.title).toBe('SKY HARBOR');
    });

    it('parses S01E1000 (4-digit episode at 1000)', () => {
        const r = parseMediaFilename('Sky.Harbor.S01E1000.mkv');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(1000);
    });

    it('parses S01E0512 and strips leading zeros', () => {
        const r = parseMediaFilename('Sorami.S01E0512.720p.mkv');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(512);
    });

    it('parses multi-episode S01E0001E0002', () => {
        const r = parseMediaFilename('Sky.Harbor.S01E0001E0002.mkv');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(1);
        expect(r.episodeEnd).toBe(2);
    });

    // Dash notation used by fansub groups: "- 001 ["
    it('parses [Group] Series - 001 [tag] format', () => {
        const r = parseMediaFilename('[HorribleSubs] Sky Harbor - 001 [1080p].mkv');
        expect(r.title).toBe('Sky Harbor');
        expect(r.episodeStart).toBe(1);
        expect(r.season).toBeUndefined();
    });

    it('parses [Group] Series - 1000 [tag] format (4-digit)', () => {
        const r = parseMediaFilename('[Erai-raws] Sky Harbor - 1000 [720p].mkv');
        expect(r.title).toBe('Sky Harbor');
        expect(r.episodeStart).toBe(1000);
        expect(r.season).toBeUndefined();
    });
});

describe('Comprehensive anime filename formats', () => {
    // Version tag (v2, v3) after bare episode number
    it('parses [Group] Series - 01v2 [Quality] (version tag suffix)', () => {
        const r = parseMediaFilename('[HorribleSubs] Sky Harbor - 01v2 [720p].mkv');
        expect(r.title).toBe('Sky Harbor');
        expect(r.episodeStart).toBe(1);
    });

    it('parses [Group] Series - 1000v2 [Quality] (4-digit with version tag)', () => {
        const r = parseMediaFilename('[Erai-raws] Sky Harbor - 1000v2 [1080p].mkv');
        expect(r.title).toBe('Sky Harbor');
        expect(r.episodeStart).toBe(1000);
    });

    it('parses [Group] Series - 01v3 (version tag at end of string)', () => {
        const r = parseMediaFilename('[SubsPlease] Lantern Keeper - 25v3.mkv');
        expect(r.title).toBe('Lantern Keeper');
        expect(r.episodeStart).toBe(25);
    });

    // Multiple quality bracket tags
    it('parses [Group] Series - 01 [BD][1080p] (multiple brackets after ep)', () => {
        const r = parseMediaFilename('[HorribleSubs] Sky Harbor - 01 [BD][1080p].mkv');
        expect(r.title).toBe('Sky Harbor');
        expect(r.episodeStart).toBe(1);
    });

    it('parses [Group] Series - 001 [BD][1080p][HEVC] (three quality brackets)', () => {
        const r = parseMediaFilename('[Erai-raws] Sorami - 001 [BD][1080p][HEVC].mkv');
        expect(r.title).toBe('Sorami');
        expect(r.episodeStart).toBe(1);
    });

    // Season 0 specials / OVAs
    it('parses S00E01 (season 0 special)', () => {
        const r = parseMediaFilename('Series.Name.S00E01.mkv');
        expect(r.season).toBe(0);
        expect(r.episodeStart).toBe(1);
    });

    it('parses S00E05 (season 0, episode 5)', () => {
        const r = parseMediaFilename('Voyage.to.Orion.S00E05.OVA.mkv');
        expect(r.season).toBe(0);
        expect(r.episodeStart).toBe(5);
        expect(r.title).toBe('Voyage to Orion');
    });

    // 3-digit standard S:E episodes
    it('parses S01E001 (3-digit episode, standard format)', () => {
        const r = parseMediaFilename('Series.Name.S01E001.mkv');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(1);
        expect(r.title).toBe('Series Name');
    });

    it('parses S01E512 (3-digit high episode number)', () => {
        const r = parseMediaFilename('Sky.Harbor.S01E512.mkv');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(512);
    });

    // Dash-separated title with S:E marker
    it('parses Show Name - S01E001 - Episode Title', () => {
        const r = parseMediaFilename('Show Name - S01E001 - Episode Title.mkv');
        expect(r.title).toBe('Show Name');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(1);
    });

    // Bare episode at end of string (no quality tag)
    it('parses [Group] Series - 12 (bare ep at end, no quality bracket)', () => {
        const r = parseMediaFilename('[SubsPlease] Meralen - 12.mkv');
        expect(r.title).toBe('Meralen');
        expect(r.episodeStart).toBe(12);
    });

    it('parses Series - 42 (no group prefix, bare ep at end)', () => {
        const r = parseMediaFilename('My Harbor Academy - 42.mkv');
        expect(r.title).toBe('My Harbor Academy');
        expect(r.episodeStart).toBe(42);
    });

    // Number-before-dash form (e.g. "Varenth 01 - Title")
    it('parses Title NN - Subtitle (number before dash)', () => {
        const r = parseMediaFilename(
            'Varenth 01 - Der Schwarze Ritter [720p 10-bit][Jap.Eng.Dub][Ger.Eng.Sub][G_P]-MeisterMutaito.mkv',
        );
        expect(r.title).toBe('Varenth');
        expect(r.episodeStart).toBe(1);
    });

    it('parses Title NNN - Subtitle (3-digit number before dash)', () => {
        const r = parseMediaFilename('Show 365 - The End of Days.mkv');
        expect(r.title).toBe('Show');
        expect(r.episodeStart).toBe(365);
    });

    it('parses Title NNv2 - Subtitle (number-before-dash with version)', () => {
        const r = parseMediaFilename('My Anime 12v2 - Episode Title.mkv');
        expect(r.title).toBe('My Anime');
        expect(r.episodeStart).toBe(12);
        expect(r.version).toBe(2);
    });

    it('does not misread 4-digit year as episode (number-before-dash with year-like number)', () => {
        // "1997" is 4 digits — number-before-dash pattern is capped at 3 digits to avoid this
        const r = parseMediaFilename('Varenth 1997 - Title Without Episode.mkv');
        expect(r.episodeStart).toBeUndefined();
        expect(r.year).toBe(1997);
    });

    // Underscore-dash-underscore renamer form (e.g. "Title_-_01[Hi10P]")
    it('parses [Group]Title_-_NN[Hash] (underscore-dash-underscore separator)', () => {
        const r = parseMediaFilename(
            '[PCS]Harbor_San_To_Lantern_San_To_-_01[Hi10P][BD][1080p].mkv',
        );
        expect(r.title).toBe('Harbor San To Lantern San To');
        expect(r.episodeStart).toBe(1);
    });

    it('parses Title_-_NN.mkv (underscore-dash-underscore at end)', () => {
        const r = parseMediaFilename('Long_Show_Title_-_42[Hi10P].mkv');
        expect(r.title).toBe('Long Show Title');
        expect(r.episodeStart).toBe(42);
    });

    // EpNN prefix form (e.g. "Title.Ep01.German.AC3...")
    it('parses Title.EpNN.junk (German-release Ep prefix)', () => {
        const r = parseMediaFilename(
            'Orion.Lantern.Park.Ep01.German.AC3.DL.720p.BluRay.x264-GROUP.mkv',
        );
        expect(r.title).toBe('Orion Lantern Park');
        expect(r.episodeStart).toBe(1);
    });

    it('parses Title Ep NN (Ep with space)', () => {
        const r = parseMediaFilename('Some Show Ep 12 [1080p].mkv');
        expect(r.title).toBe('Some Show');
        expect(r.episodeStart).toBe(12);
    });

    it('parses Title_EpNN_junk (Ep with underscore)', () => {
        const r = parseMediaFilename('Other_Show_Ep05_BD.mkv');
        expect(r.title).toBe('Other Show');
        expect(r.episodeStart).toBe(5);
    });

    // Bare "ENN" / "Episode NN" with no season token — the season comes from the folder
    it('parses a bare eNN with no season (cd.720p.e01)', () => {
        const r = parseMediaFilename('cd.720p.e01.mkv');
        expect(r.episodeStart).toBe(1);
        expect(r.season).toBeUndefined();
    });

    it('parses Title.ENN.junk and Title Episode NN', () => {
        expect(parseMediaFilename('Lunaris.E12.1080p.BluRay.mkv').episodeStart).toBe(12);
        expect(parseMediaFilename('Lunaris.E12.1080p.BluRay.mkv').title).toBe('Lunaris');
        expect(parseMediaFilename('Lunaris Episode 07 [BD].mkv').episodeStart).toBe(7);
    });

    it('parses a leading episode number inside a Season folder (NN Title [720p])', () => {
        const r = parseMediaFilename(
            '/data/anime/Orbit Guild (2002) [imdbid-tt0377210]/Season 01/01 Abgrund [720p].mkv',
        );
        expect(r.episodeStart).toBe(1);
        expect(r.title).toBe('Abgrund');
        expect(parseMediaFilename('/tv/Show/Specials/03v2 Recap.mkv').episodeStart).toBe(3);
    });

    it('does not read a leading number as an episode outside a Season folder', () => {
        expect(
            parseMediaFilename('/movies/12 Quiet Guests (1957)/12 Quiet Guests (1957).mkv')
                .episodeStart,
        ).toBeUndefined();
        expect(parseMediaFilename('01 Abgrund [720p].mkv').episodeStart).toBeUndefined();
    });

    it('reads an SxxEyy held in a leading bracket instead of dropping it as a group tag', () => {
        const r = parseMediaFilename('[S04.E05] Star Harbor Enterprise - Cold Station 12.mp4');
        expect(r.season).toBe(4);
        expect(r.episodeStart).toBe(5);
        expect(r.title).toBe('Star Harbor Enterprise Cold Station 12');
        // A real group tag is still stripped
        expect(parseMediaFilename('[SubsPlease] Meralen - 05 (1080p).mkv').title).toBe('Meralen');
    });

    it('parses a dash-joined bare eNN (misfits-nichtnachmachen720-e04)', () => {
        const r = parseMediaFilename('misfits-nichtnachmachen720-e04.mkv');
        expect(r.episodeStart).toBe(4);
    });

    it('parses spelled-out Staffel N Folge M / Season N Episode M', () => {
        const r = parseMediaFilename(
            'Moonwoven Staffel 3 Folge 06 Die Macht der Gefühle Part 1_4.mp4',
        );
        expect(r.season).toBe(3);
        expect(r.episodeStart).toBe(6);
        expect(r.part).toBe(1);
        const e = parseMediaFilename('Show Season 2 Episode 4.mkv');
        expect([e.season, e.episodeStart]).toEqual([2, 4]);
        // A lone "Staffel 3" is not an episode
        expect(parseMediaFilename('Moonwoven Staffel 3.mkv').episodeStart).toBeUndefined();
    });

    it('does not read E-AC3, HARB-E or E.2008-style tokens as an episode', () => {
        expect(parseMediaFilename('Movie.2010.1080p.E-AC3.x265.mkv').episodeStart).toBeUndefined();
        expect(parseMediaFilename('HARB-E.2008.1080p.mkv').episodeStart).toBeUndefined();
        expect(parseMediaFilename('Harb.E.2008.1080p.mkv').episodeStart).toBeUndefined();
    });

    // Underscore + number + bracket (e.g. "Title_NN[hash]")
    it('parses [Group]Title_NN[Quality][Hash] (underscore+number+bracket)', () => {
        const r = parseMediaFilename('[OtakuKingdomSubs]Hikari_ni_Iku_Yo!_10[720p][888B10FE].mp4');
        expect(r.title).toBe('Hikari ni Iku Yo!');
        expect(r.episodeStart).toBe(10);
    });

    it('does not misread quality tokens like 1080 as episode (underscore+bracket)', () => {
        // "1080" is 4 digits and \d{1,3}(?!\d) excludes it
        const r = parseMediaFilename('Show_Title_1080p_Bluray[Hi10P].mkv');
        expect(r.episodeStart).toBeUndefined();
    });

    // Known limitations — document expected behavior
    it('does not extract episode from underscore-only numeric suffix (known limitation)', () => {
        // No dash separator at all means neither anime pattern can match
        const r = parseMediaFilename('Series_Name_001.mkv');
        expect(r.episodeStart).toBeUndefined();
        expect(r.season).toBeUndefined();
        // Number survives as part of the title after underscore normalisation
        expect(r.title).toBe('Series Name 001');
    });

    it('does not extract episode from all-bracketed format (known limitation)', () => {
        // [Group][Title][EP][Quality] — no "- N" separator; title falls back to raw
        const r = parseMediaFilename('[HorribleSubs][Sky Harbor][001][720p].mkv');
        expect(r.episodeStart).toBeUndefined();
    });

    it('does not extract range from bare anime dash range (known limitation)', () => {
        // "- 01-02 [" — bare episode ranges are not supported; dashes are normalised
        // to spaces so the numbers survive as title tokens
        const r = parseMediaFilename('[HorribleSubs] Sky Harbor - 01-02 [720p].mkv');
        expect(r.episodeStart).toBeUndefined();
        expect(r.title).toBe('Sky Harbor 01 02');
    });
});

describe('Milo Farrow production filenames', () => {
    // Standard films: "Title (Year) [imdbid-ttXXX] - Quality.mkv"
    it("parses Scholar's Lantern (apostrophe preserved)", () => {
        const r = parseMediaFilename(
            "Milo Farrow and the Scholar's Lantern (2001) [imdbid-tt0241527] - Bluray-1080p.mkv",
        );
        expect(r.title).toBe("Milo Farrow and the Scholar's Lantern");
        expect(r.year).toBe(2001);
        expect(r.imdbId).toBe('tt0241527');
    });

    it('parses Hall of Lanterns', () => {
        const r = parseMediaFilename(
            'Milo Farrow and the Hall of Lanterns (2002) [imdbid-tt0295297] - Bluray-1080p.mkv',
        );
        expect(r.title).toBe('Milo Farrow and the Hall of Lanterns');
        expect(r.year).toBe(2002);
        expect(r.imdbId).toBe('tt0295297');
    });

    it('parses Half-Moon Keeper (hyphen in title normalised to space)', () => {
        const r = parseMediaFilename(
            'Milo Farrow and the Half-Moon Keeper (2009) [imdbid-tt0417741] - Bluray-1080p.mkv',
        );
        // Separators are normalised: "Half-Blood" → "Half Blood"
        expect(r.title).toBe('Milo Farrow and the Half Moon Keeper');
        expect(r.year).toBe(2009);
        expect(r.imdbId).toBe('tt0417741');
    });

    it('parses Distant Harbors Part 1 — extracts part number, keeps "Part 1" in title', () => {
        const r = parseMediaFilename(
            'Milo Farrow and the Distant Harbors Part 1 (2010) [imdbid-tt0926084] - Bluray-1080p.mkv',
        );
        expect(r.part).toBe(1);
        expect(r.year).toBe(2010);
        expect(r.imdbId).toBe('tt0926084');
        // "Part 1" is extracted as part number but remains in title text
        expect(r.title).toBe('Milo Farrow and the Distant Harbors Part 1');
    });

    it('parses Distant Harbors Part 2 — part=2', () => {
        const r = parseMediaFilename(
            'Milo Farrow and the Distant Harbors Part 2 (2011) [imdbid-tt1201607] - Bluray-1080p.mkv',
        );
        expect(r.part).toBe(2);
        expect(r.year).toBe(2011);
        expect(r.imdbId).toBe('tt1201607');
    });

    it('parses 20th Anniversary special (8-digit IMDB ID)', () => {
        const r = parseMediaFilename(
            'Milo Farrow 20th Anniversary Return to Starhaven (2022) [imdbid-tt16116174] - WEBDL-1080p.mp4',
        );
        expect(r.title).toBe('Milo Farrow 20th Anniversary Return to Starhaven');
        expect(r.year).toBe(2022);
        expect(r.imdbId).toBe('tt16116174');
    });

    // Satire films: dash-separated, no [imdbid-...], no year in filename
    it('parses satire film with dash-separated German title (no year, no IMDB)', () => {
        const r = parseMediaFilename('Milo-Farrow-und-der-geheime-Pornokeller.mp4');
        expect(r.title).toBe('Milo Farrow und der geheime Pornokeller');
        expect(r.year).toBeUndefined();
        expect(r.imdbId).toBeUndefined();
    });

    it('parses second satire film with dash-separated title', () => {
        const r = parseMediaFilename('Milo-Farrow-und-der-Plastikpokal.mp4');
        expect(r.title).toBe('Milo Farrow und der Plastikpokal');
        expect(r.year).toBeUndefined();
        expect(r.imdbId).toBeUndefined();
    });

    it('parses "Milo Farrow und ein Stein" with 8-digit IMDB ID and Full HD quality label', () => {
        const r = parseMediaFilename(
            'Milo Farrow und ein Stein (2006) [imdbid-tt20766450] - Full HD.mp4',
        );
        expect(r.title).toBe('Milo Farrow und ein Stein');
        expect(r.year).toBe(2006);
        // 8-digit IMDB ID (tt20766450) still matched by \btt\d{7,8}\b
        expect(r.imdbId).toBe('tt20766450');
    });
});

describe('Real-world Jellyfin library filename samples', () => {
    // Dominant format: "Series Title (Year) - SxxExx - NNN - Episode Title [Quality][Codec]-Group.mkv"
    it('parses 86 - Eighty Six Jellyfin multi-bracket format', () => {
        const r = parseMediaFilename(
            '86 - Eighty Six (2021) - S01E01 - 001 - Undertaker [WEBDL-720p][8bit][x264][AAC 2.0][DE+JA+EN]-ZeroTwo.mkv',
        );
        expect(r.title).toBe('86 Eighty Six');
        expect(r.year).toBe(2021);
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(1);
    });

    it('parses Drifting Clouds standard Western series format', () => {
        const r = parseMediaFilename('Drifting Clouds - S01E01 - Pilot - WEBDL-2160p.mkv');
        expect(r.title).toBe('Drifting Clouds');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(1);
        expect(r.year).toBeUndefined();
    });

    it('parses Lantern Guild Z without year in filename', () => {
        const r = parseMediaFilename('Lantern Guild Z - S01E01 - Ein außerirdischer Krieger.mkv');
        expect(r.title).toBe('Lantern Guild Z');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(1);
        expect(r.year).toBeUndefined();
    });

    it('parses movie with [imdbid-ttXXX] annotation and quality suffix', () => {
        // Jellyfin uses "imdbid-" prefix (not "imdb-"), extracted via bare /\bttNNN\b/ regex
        const r = parseMediaFilename(
            'A Bright Harbor (2001) [imdbid-tt0268978] - Bluray-1080p.mkv',
        );
        expect(r.title).toBe('A Bright Harbor');
        expect(r.year).toBe(2001);
        expect(r.imdbId).toBe('tt0268978');
        expect(r.season).toBeUndefined();
    });

    it('extracts imdbId from folder path with [imdbid-ttXXX] folder', () => {
        const r = parseMediaFilename(
            '/data/media/libraries/anime/Sky Harbor (1999) [imdbid-tt0388629]/Season 01/S01E0001 - SKY HARBOR [GER].avi',
        );
        expect(r.imdbId).toBe('tt0388629');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(1);
        expect(r.title).toBe('SKY HARBOR');
    });

    it('parses absolute-ordered anime episode (S01E0001 at start, title after)', () => {
        const r = parseMediaFilename('S01E0001 - SKY HARBOR [GER].avi');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(1);
        expect(r.title).toBe('SKY HARBOR');
    });

    it('parses high absolute episode number S01E1000', () => {
        const r = parseMediaFilename('S01E1000 - SKY HARBOR [GER].avi');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(1000);
    });
});

describe('parseMediaFilename', () => {
    // Movies — dot-separated
    it('parses "Movie.Name.2020.1080p.BluRay.mkv"', () => {
        const result = parseMediaFilename('Movie.Name.2020.1080p.BluRay.mkv');
        expect(result.title).toBe('Movie Name');
        expect(result.year).toBe(2020);
        expect(result.season).toBeUndefined();
        expect(result.episode).toBeUndefined();
    });

    // Movies — parenthesised year
    it('parses "Movie Name (2020).mkv"', () => {
        const result = parseMediaFilename('Movie Name (2020).mkv');
        expect(result.title).toBe('Movie Name');
        expect(result.year).toBe(2020);
    });

    // Movies — no year
    it('parses "Some Movie Title.mkv" with no year', () => {
        const result = parseMediaFilename('Some Movie Title.mkv');
        expect(result.title).toBe('Some Movie Title');
        expect(result.year).toBeUndefined();
    });

    // TV — SxxExx format
    it('parses "Show.Name.S01E02.Episode.Title.mkv"', () => {
        const result = parseMediaFilename('Show.Name.S01E02.Episode.Title.mkv');
        expect(result.title).toBe('Show Name');
        expect(result.season).toBe(1);
        expect(result.episode).toBe(2);
    });

    // TV — with year before episode marker
    it('parses "Show.Name.2019.S02E05.1080p.mkv"', () => {
        const result = parseMediaFilename('Show.Name.2019.S02E05.1080p.mkv');
        expect(result.title).toBe('Show Name');
        expect(result.year).toBe(2019);
        expect(result.season).toBe(2);
        expect(result.episode).toBe(5);
    });

    // TV — dash-separated with spaces
    it('parses "Show Name - S03E07 - Episode Title.mkv"', () => {
        const result = parseMediaFilename('Show Name - S03E07 - Episode Title.mkv');
        expect(result.title).toBe('Show Name');
        expect(result.season).toBe(3);
        expect(result.episode).toBe(7);
    });

    // Anime — [Group] prefix and bare episode number
    it('parses "[SubGroup] Anime Name - 12 [720p].mkv"', () => {
        const result = parseMediaFilename('[SubGroup] Anime Name - 12 [720p].mkv');
        expect(result.title).toBe('Anime Name');
        expect(result.episode).toBe(12);
        expect(result.season).toBeUndefined();
    });

    // Strips path component
    it('strips directory path before parsing', () => {
        const result = parseMediaFilename(
            '/media/movies/Great Movie (2021)/Great Movie (2021).mkv',
        );
        expect(result.title).toBe('Great Movie');
        expect(result.year).toBe(2021);
    });

    // Handles mixed case junk tokens
    it('strips codec/quality junk tokens', () => {
        const result = parseMediaFilename('Movie.Name.2018.4K.HDR.x265.HEVC.WEB-DL.mkv');
        expect(result.title).toBe('Movie Name');
        expect(result.year).toBe(2018);
    });
});

describe('parseSubtitleFilename', () => {
    it('parses simple language tag', () => {
        const r = parseSubtitleFilename('/movies/Movie.en.srt');
        expect(r.language).toBe('en');
        expect(r.isForced).toBe(false);
        expect(r.isSDH).toBe(false);
        expect(r.format).toBe('srt');
        expect(r.baseName).toBe('Movie');
    });

    it('parses forced flag', () => {
        const r = parseSubtitleFilename('Movie.de.forced.srt');
        expect(r.language).toBe('de');
        expect(r.isForced).toBe(true);
        expect(r.isSDH).toBe(false);
    });

    it('parses SDH flag', () => {
        const r = parseSubtitleFilename('Movie.en.sdh.srt');
        expect(r.language).toBe('en');
        expect(r.isSDH).toBe(true);
    });

    it('parses 3-char language code', () => {
        const r = parseSubtitleFilename('Movie.eng.srt');
        expect(r.language).toBe('eng');
        expect(r.isForced).toBe(false);
    });

    it('normalizes lowercase BCP-47 region to uppercase', () => {
        const r = parseSubtitleFilename('Movie.pt-br.srt');
        expect(r.language).toBe('pt-BR');
    });

    it('hi is treated as Hindi language code, not SDH', () => {
        const r = parseSubtitleFilename('Movie.hi.srt');
        expect(r.language).toBe('hi');
        expect(r.isSDH).toBe(false);
    });

    it('parses sdh flag correctly', () => {
        const r = parseSubtitleFilename('Movie.en.sdh.srt');
        expect(r.language).toBe('en');
        expect(r.isSDH).toBe(true);
    });

    it('parses BCP-47 region tags', () => {
        const r = parseSubtitleFilename('Movie.pt-BR.srt');
        expect(r.language).toBe('pt-BR');
    });

    it('handles file without language tag', () => {
        const r = parseSubtitleFilename('Movie.srt');
        expect(r.language).toBeNull();
        expect(r.baseName).toBe('Movie');
    });

    it('handles .ass format', () => {
        const r = parseSubtitleFilename('Show.S01E01.en.ass');
        expect(r.format).toBe('ass');
        expect(r.language).toBe('en');
    });

    it('handles .vtt format without language', () => {
        const r = parseSubtitleFilename('Movie.vtt');
        expect(r.format).toBe('vtt');
        expect(r.language).toBeNull();
    });

    it('ignores unknown suffixes as part of baseName', () => {
        const r = parseSubtitleFilename('My.Cool.Movie.2024.en.srt');
        expect(r.language).toBe('en');
        expect(r.baseName).toBe('My.Cool.Movie.2024');
    });
});

describe('S_E_PATTERN does not truncate over-long episode runs', () => {
    // The episode group was capped at \d{1,4}, so a 5-digit run was silently
    // truncated: "S01E12345" produced episode 1234 — a DIFFERENT episode, not
    // a rejected one. Same class of bug as the two-digit cap that left
    // image-scanner unable to see episodes >= 100 (fixed in e11593c15).
    //
    // A negative lookahead would be the wrong fix here: making the pattern
    // fail drops parsing through to the anime bare-number / Ep## rules, which
    // can invent a different number again. Capturing the whole run keeps the
    // same code path and cannot silently substitute a wrong episode.
    it('reads the full digit run rather than the first four', () => {
        const r = parseMediaFilename('Show.S01E12345.mkv');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(12345);
    });

    it('leaves realistic 1-4 digit episodes untouched', () => {
        expect(parseMediaFilename('Show.S01E1.mkv').episodeStart).toBe(1);
        expect(parseMediaFilename('Show.S01E05.mkv').episodeStart).toBe(5);
        expect(parseMediaFilename('Show.S01E293.mkv').episodeStart).toBe(293);
        expect(parseMediaFilename('S01E0001 - SKY HARBOR [GER].avi').episodeStart).toBe(1);
        expect(parseMediaFilename('Sky.Harbor.S01E1000.mkv').episodeStart).toBe(1000);
    });

    it('still stops at a non-digit boundary', () => {
        const r = parseMediaFilename('Show - S01E07 - Title - Bluray-1080p.mkv');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(7);
    });
});

describe('SxxExx with a separator between season and episode', () => {
    // Measured on production: "Oria.13.S01.E01.German.AC3.DL.720p.BluRay.x264-Fuuko.mkv"
    // parsed to no season and no episode at all, so the scanner fell through to
    // auto-numbering and linked all 12 files to invented "Episode 13".."Episode 23"
    // rows beside the real, TMDB-matched episodes 1-12 — which stayed file-less.
    it('reads S01.E01', () => {
        const r = parseMediaFilename('Oria.13.S01.E01.German.AC3.DL.720p.BluRay.x264-Fuuko.mkv');
        expect(r.season).toBe(1);
        expect(r.episodeStart).toBe(1);
        expect(r.title).toBe('Oria 13');
    });

    it('reads space, underscore and dash separators', () => {
        for (const f of ['Show S02 E05.mkv', 'Show_S02_E05.mkv', 'Show - S02-E05 - Title.mkv']) {
            const r = parseMediaFilename(f);
            expect([f, r.season, r.episodeStart]).toEqual([f, 2, 5]);
        }
    });

    it('does not read a season token followed by an unrelated word', () => {
        // "S01.Extras" has no episode number; it must not become one.
        const r = parseMediaFilename('Show.S01.Extras.mkv');
        expect(r.episodeStart).toBeUndefined();
    });

    it('does not fire inside a word', () => {
        // "Tests1 E2" — the S is the end of a word, not a season marker.
        const r = parseMediaFilename('Tests1 E2.mkv');
        expect(r.season).toBeUndefined();
    });

    it('leaves the unseparated form on its existing path', () => {
        const r = parseMediaFilename('Show.S01E02.mkv');
        expect([r.season, r.episodeStart]).toEqual([1, 2]);
    });
});

describe('British "Series N - NN" naming', () => {
    // Measured on production: iPlayer downloads named
    // "<Show>_Series_2_-_03._<Title>_<pid>_original.mp4" parsed to episode 2 and
    // no season (the number-before-dash rule took the series number), so every
    // file of the series was linked to S1E2.
    it('reads the iPlayer underscore form as season + episode', () => {
        const r = parseMediaFilename(
            '/tv/Hollow Manor (2019)/Season 02/Hollow_Manor_Series_2_-_03._Redding_Weddy_p08abcde_original.mp4',
        );
        expect([r.season, r.episodeStart]).toEqual([2, 3]);
        expect(r.title).toBe('Hollow Manor');
    });

    it('reads the spaced form', () => {
        const r = parseMediaFilename('Hollow Manor - Series 3 - 05. Something to Share.mkv');
        expect([r.season, r.episodeStart]).toEqual([3, 5]);
        expect(r.title).toBe('Hollow Manor');
    });

    it('reads "Series N Episode NN"', () => {
        const r = parseMediaFilename('Hollow Manor Series 2 Episode 4.mkv');
        expect([r.season, r.episodeStart]).toEqual([2, 4]);
    });

    it('does not read "Series" without a dash-separated episode number', () => {
        const r = parseMediaFilename('Hollow Manor Series 2 Bloopers.mkv');
        expect(r.season).toBeUndefined();
    });

    it('reads "Series" at the start of the name', () => {
        const r = parseMediaFilename('Series 2 - 03. Redding Weddy.mkv');
        expect([r.season, r.episodeStart]).toEqual([2, 3]);
    });

    it('reads en and em dashes', () => {
        for (const f of ['Hollow Manor Series 2 – 03.mkv', 'Hollow Manor Series 2 — 03.mkv']) {
            const r = parseMediaFilename(f);
            expect([f, r.season, r.episodeStart]).toEqual([f, 2, 3]);
        }
    });

    it('does not read a resolution or "3D" after the dash as the episode', () => {
        for (const f of ['Hollow.Manor.Series.2.-.720p.mkv', 'Hollow Manor Series 2 - 3D.mkv']) {
            const r = parseMediaFilename(f);
            expect([f, r.season, r.episodeStart === 720 || r.episodeStart === 3]).toEqual([
                f,
                undefined,
                false,
            ]);
        }
    });

    it('reads "Series N Ep NN"', () => {
        const r = parseMediaFilename('Hollow Manor Series 2 Ep 4.mkv');
        expect([r.season, r.episodeStart]).toEqual([2, 4]);
    });
});

describe('OVA / ONA with an episode number', () => {
    // Measured on production: "Corpse.Party-Tortured.Souls.OVA.01.German..." lost
    // its number with the stripped OVA token, so the episode was never read.
    it('reads OVA.NN as the episode number', () => {
        const r = parseMediaFilename(
            'Ashgrove.Academy.OVA.01.German.AC3.DL.720p.BluRay.x264-GROUP.mkv',
        );
        expect(r.episodeType).toBe('ova');
        expect(r.episodeStart).toBe(1);
        expect(r.season).toBeUndefined();
        expect(r.title).toBe('Ashgrove Academy');
    });

    it('reads "ONA 3"', () => {
        const r = parseMediaFilename('Ashgrove Academy ONA 3 [1080p].mkv');
        expect([r.episodeType, r.episodeStart]).toEqual(['ona', 3]);
    });

    it('does not read a resolution after the token as an episode', () => {
        const r = parseMediaFilename('Ashgrove.Academy.OVA.720p.BluRay.mkv');
        expect(r.episodeType).toBe('ova');
        expect(r.episodeStart).toBeUndefined();
    });

    it('lets an explicit SxxEyy win over the OVA number', () => {
        const r = parseMediaFilename('Voyage.to.Orion.S00E05.OVA.2.mkv');
        expect([r.season, r.episodeStart]).toEqual([0, 5]);
    });

    it('beats a bare dash number after it', () => {
        const r = parseMediaFilename('Ashgrove Academy OVA 02 - 05.mkv');
        expect(r.episodeStart).toBe(2);
        expect(r.title).toBe('Ashgrove Academy');
    });

    it('keeps a year that follows the number', () => {
        const r = parseMediaFilename('Ashgrove.Academy.OVA.01.2012.German.1080p.BluRay.mkv');
        expect([r.episodeStart, r.year, r.title]).toEqual([1, 2012, 'Ashgrove Academy']);
    });

    it('reads a version suffix and a parenthesis after the number', () => {
        const v2 = parseMediaFilename('Ashgrove Academy OVA 01v2 [1080p].mkv');
        expect([v2.episodeStart, v2.version, v2.title]).toEqual([1, 2, 'Ashgrove Academy']);
        const paren = parseMediaFilename('Ashgrove.Academy.OVA.03(1080p).mkv');
        expect(paren.episodeStart).toBe(3);
    });

    it('wins over an air date when air dates are read', () => {
        const r = parseMediaFilename('Ashgrove Academy 2021.03.14 OVA 3.mkv', { airDates: true });
        expect([r.episodeStart, r.airDate]).toEqual([3, undefined]);
    });

    it('leaves the season to the folder', () => {
        // The scanner then files it under the folder season (resolveSeasonNumber):
        // a provider listing the OVAs as season 1 matches the "Season 01" folder.
        const r = parseMediaFilename(
            '/anime/Ashgrove Academy/Season 01/Ashgrove.Academy.OVA.02.mkv',
        );
        expect([r.season, r.episodeStart, r.episodeType]).toEqual([undefined, 2, 'ova']);
    });
});

describe('Daily-show air dates', () => {
    const tv = (name: string) => parseMediaFilename(name, { airDates: true });

    it.each([
        ['The Show 2021.03.14.mkv', 'The Show'],
        ['The.Show.2021-03-14.mkv', 'The Show'],
        ['The_Show_2021_03_14.mkv', 'The Show'],
        ['The Show 2021 03 14.mkv', 'The Show'],
        ['The Show - 2021-03-14 - Guest Name.mkv', 'The Show'],
        ['The Show 2021.03.14 1080p WEB h264.mkv', 'The Show'],
    ])('reads %s as an air date', (name, title) => {
        const r = tv(`/tv/The Show/${name}`);
        expect(r.airDate).toBe('2021-03-14');
        expect(r.title).toBe(title);
        expect(r.season).toBeUndefined();
        expect(r.episodeStart).toBeUndefined();
        expect(r.year).toBe(2021);
        expect(r.yearFromAirDate).toBe(true);
    });

    it('does not take the day for an anime episode number', () => {
        // "14 - Guest" matches the number-before-dash anime form on its own.
        const r = tv('The Show 2021 03 14 - Guest.mkv');
        expect(r.airDate).toBe('2021-03-14');
        expect(r.episodeStart).toBeUndefined();
    });

    it('takes the rest of the name as the title when the date leads', () => {
        const r = tv('/tv/The Show/Season 2021/2021.03.14 - Guest Name.mkv');
        expect(r.airDate).toBe('2021-03-14');
        expect(r.title).toBe('Guest Name');
        expect(r.episodeStart).toBeUndefined();
    });

    it.each([
        ['The Show S05E12 2021.03.14.mkv', 5, 12],
        ['The Show 2021.03.14 5x12.mkv', 5, 12],
        ['The Show E05 2021-03-14.mkv', undefined, 5],
        ['The Show - 2021-03-14 - 05.mkv', undefined, 5],
        ['[Group] The Show - 05 [2021.03.14].mkv', undefined, 5],
        ['The Show Episode 12 (2021-03-14).mkv', undefined, 12],
        ['/tv/The Show/Season 1/05 - 2021-03-14.mkv', undefined, 5],
    ])('lets the episode number in %s win over the date', (name, season, episode) => {
        const r = tv(name);
        expect(r.airDate).toBeUndefined();
        expect(r.season).toBe(season);
        expect(r.episodeStart).toBe(episode);
    });

    it('reads a trailing copy number after the date as no episode number', () => {
        // Only a number BEFORE the date counts in a season folder.
        const r = tv('/tv/The Show/Season 2021/2021.03.14 2.mkv');
        expect(r.airDate).toBe('2021-03-14');
        expect(r.episodeStart).toBeUndefined();
    });

    it.each([
        'The Show 2020 10 10bit.mkv', // encoding tag, not a day
        'The Show 2021.02.30.mkv', // no such day
        'The Show 2021.13.01.mkv', // no such month
        'The Show 2021.03-14.mkv', // mixed separators
        'The Show 14.03.2021.mkv', // day first: ambiguous, not read
        'The Show 2021.3.14.mkv', // unpadded
    ])('does not read %s as an air date', (name) => {
        expect(tv(name).airDate).toBeUndefined();
    });

    it('leaves a plain year alone', () => {
        const r = tv('Night of the Living Dead 1968 1080p BluRay.mkv');
        expect(r.airDate).toBeUndefined();
        expect(r.year).toBe(1968);
    });

    it('keeps a separate show year in the name', () => {
        const r = tv('The Show (2015) 2021.03.14.mkv');
        expect(r.airDate).toBe('2021-03-14');
        expect(r.title).toBe('The Show');
        expect(r.year).toBe(2015);
        expect(r.yearFromAirDate).toBeUndefined();
    });

    it.each(['Birthday 2015_06_12.mp4', 'IMG_2021_03_14_123456.mp4', 'The Show 2021.03.14.mkv'])(
        'reads no air date in %s unless asked (non-TV libraries)',
        (name) => {
            const r = parseMediaFilename(name);
            expect(r.airDate).toBeUndefined();
            expect(r.yearFromAirDate).toBeUndefined();
        },
    );

    describe('seriesYearHint', () => {
        it('drops a year that only came from the air date', () => {
            expect(seriesYearHint(tv('The Show 2021.03.14.mkv'))).toBeUndefined();
        });

        it('keeps the show year from the name', () => {
            expect(seriesYearHint(tv('The Show (2015) 2021.03.14.mkv'))).toBe(2015);
        });

        it('keeps a show year equal to the air year', () => {
            expect(seriesYearHint(tv('The Show (2021) 2021.03.14.mkv'))).toBe(2021);
        });

        it('passes a normal year through', () => {
            expect(seriesYearHint(tv('The Show 2015 S01E01.mkv'))).toBe(2015);
        });
    });
});

describe('absolute episode number in the file name', () => {
    const abs = (name: string): number | undefined => parseMediaFilename(name).absoluteEpisode;

    it.each([
        [
            'Bleach (2004) - S09E21 - 188 - Duel! Amagai vs. Ichigo [Bluray-720p][AAC 2.0][x264]-GRP.mkv',
            188,
        ],
        [
            'You and I Are Polar Opposites (2026) - S02E13 - 025 - You and I Are Polar Opposites [WEBDL-720p][AAC 2.0][h264]-GRP.mkv',
            25,
        ],
        ['Naruto Shippuden (2007) - S13E33 - 293 - Power Episode 4 [Bluray-720p]-GRP.mkv', 293],
        [
            'Pokémon (1997) - S20E44 - 1266 - The Plan for Capturing Rayquaza [HDTV-720p]-GRP.mkv',
            1266,
        ],
        ['Season 13/S01E0422 - ONE PIECE [GER-JAP].mp4', 422],
    ])('reads %s', (name, expected) => {
        expect(abs(name)).toBe(expected);
    });

    it('keeps the season and episode of the Sonarr form', () => {
        const r = parseMediaFilename('Bleach (2004) - S09E21 - 188 - Duel! [Bluray-720p].mkv');
        expect([r.season, r.episodeStart]).toEqual([9, 21]);
    });

    it.each([
        'Abbott Elementary - S03E01-02 - Career Day - WEBDL-1080p.mkv',
        "Detective Conan - S14E29 - Home of Beika's Grenier - WEBDL-720p.mkv",
        'MythBusters - S2004E15 - Exploding Jawbreaker - HDTV-720p.mkv',
        'Show - S02E05 - 24 Hours - WEBDL-1080p.mkv',
        'Show - S02E05 - 24Hours - WEBDL-1080p.mkv',
        'Show - S01E05 - 1984 - Title - WEBDL-1080p.mkv',
        'Show - S01E05 - 2024 - Title - WEBDL-1080p.mkv',
        'Show - S01E05 - 7 - Title - WEBDL-1080p.mkv',
        'Show - S01E05 - 12345 - Title - WEBDL-1080p.mkv',
        'Show - S01E05 - Title - 188 - WEBDL-1080p.mkv',
        'Show - S01E05E06 - 188 - Title.mkv',
        'Show - S01E05 - 188.mkv',
        'Show - S01E05 - Title.mkv',
        'Show - S02E105 - Title.mkv',
        'Show - S01E99 - Title.mkv',
        'Show - 1x105 - Title.mkv',
        // Specials are not part of the absolute run.
        'Show - S00E05 - 12 - Title.mkv',
        'Show - S00E05 - 120 - Title.mkv',
        // The absolute number cannot be below the number inside its season.
        'Show - S09E21 - 12 - Title.mkv',
        'Show - S02E13 - 012 - Title.mkv',
    ])('declines %s', (name) => {
        expect(abs(name)).toBeUndefined();
    });

    it('accepts an absolute number equal to the number inside its season', () => {
        expect(abs('Show - S02E13 - 013 - Title.mkv')).toBe(13);
    });

    // Documented limit: the number check cannot tell a title from an absolute
    // number here. The reconciliation's title check (the file's title must agree
    // with the target's name) is what guards it.
    it('accepts S01E05 - 300 - Title (a title called 300 passes; the title check guards it)', () => {
        expect(abs('Show - S01E05 - 300 - Title.mkv')).toBe(300);
    });

    it('reads the file name only, never the folders above it', () => {
        expect(abs('/media/Show - S09E21 - 188 - Folder/Episode One.mkv')).toBeUndefined();
        expect(abs('/media/Show - S09E21 - 188 - Folder/Show - S09E21 - 190 - Real.mkv')).toBe(190);
        expect(parseMediaFilename('/a/Show - S09E21 - 188 - X/ep.mkv').raw).toBe('ep');
    });

    it('reads a year-looking value just outside 1900-2099', () => {
        expect(abs('Show - S01E05 - 1899 - Title.mkv')).toBe(1899);
        expect(abs('Show - S01E05 - 2100 - Title.mkv')).toBe(2100);
    });
});

describe('pre-1900 years', () => {
    it('reads a parenthesised 1880–1899 year and strips it from the title', () => {
        const r = parseMediaFilename('The Lantern Show (1896).mkv');
        expect(r.title).toBe('The Lantern Show');
        expect(r.year).toBe(1896);
    });

    it('does not read a bare 18xx number as a year', () => {
        const r = parseMediaFilename('1812 Overture Live.mkv');
        expect(r.year).toBeUndefined();
        expect(r.title).toContain('1812');
    });

    it('CONTROL: a parenthesised 1902 still parses', () => {
        const r = parseMediaFilename('A Lunar Voyage (1902).mkv');
        expect(r.title).toBe('A Lunar Voyage');
        expect(r.year).toBe(1902);
    });
});
