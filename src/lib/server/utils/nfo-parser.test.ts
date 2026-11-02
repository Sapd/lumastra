// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    parseNfoContent,
    findNfoPath,
    readNfoForVideo,
    parseAlbumNfoContent,
    parseArtistNfoContent,
} from './nfo-parser.js';

describe('parseNfoContent', () => {
    it('extracts IMDB ID from uniqueid tag', () => {
        const xml = `<movie>
            <title>The Lantern</title>
            <uniqueid type="imdb" default="true">tt0133093</uniqueid>
            <uniqueid type="tmdb">603</uniqueid>
        </movie>`;
        const result = parseNfoContent(xml);
        expect(result.imdbId).toBe('tt0133093');
        expect(result.tmdbId).toBe('603');
    });

    it('extracts IMDB ID from legacy <imdbid> tag', () => {
        const xml = `<movie><imdbid>tt0133093</imdbid></movie>`;
        const result = parseNfoContent(xml);
        expect(result.imdbId).toBe('tt0133093');
    });

    it('extracts episode details', () => {
        const xml = `<episodedetails>
            <uniqueid type="imdb">tt1480055</uniqueid>
            <season>1</season>
            <episode>1</episode>
        </episodedetails>`;
        const result = parseNfoContent(xml);
        expect(result.imdbId).toBe('tt1480055');
        expect(result.season).toBe(1);
        expect(result.episode).toBe(1);
    });

    it('returns empty object for unrecognised content', () => {
        const result = parseNfoContent('<garbage/>');
        expect(result).toEqual({});
    });

    it('handles uniqueid with attributes in different order', () => {
        const xml = `<movie>
            <uniqueid default="true" type="imdb">tt9876543</uniqueid>
        </movie>`;
        const result = parseNfoContent(xml);
        expect(result.imdbId).toBe('tt9876543');
    });

    it('falls back to bare tt ID in content', () => {
        const xml = `<movie><id>tt1234567</id></movie>`;
        const result = parseNfoContent(xml);
        expect(result.imdbId).toBe('tt1234567');
    });
});

describe('parseNfoContent — local content (title/year/plot)', () => {
    it('extracts title, year, and plot', () => {
        const xml = `<movie>
            <title>The Lantern</title>
            <year>1999</year>
            <plot>A hacker learns the truth about his reality.</plot>
        </movie>`;
        const result = parseNfoContent(xml);
        expect(result.title).toBe('The Lantern');
        expect(result.year).toBe(1999);
        expect(result.plot).toBe('A hacker learns the truth about his reality.');
    });

    it('extracts a provider-less NFO (movie not in any external database)', () => {
        // The real-world regression: a fan edit / parody with NO uniqueid, only
        // local content. Must yield plot/title/year and no provider id.
        const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <plot>Eine Synchro von Coldmirror und die Fortsetzung von "Milo Farrow und ein Stein"</plot>
  <title>Milo Farrow und der geheime Pornokeller (2008)</title>
  <year>2008</year>
  <director>Coldmirror</director>
</movie>`;
        const result = parseNfoContent(xml);
        expect(result.imdbId).toBeUndefined();
        expect(result.tmdbId).toBeUndefined();
        expect(result.title).toBe('Milo Farrow und der geheime Pornokeller (2008)');
        expect(result.year).toBe(2008);
        expect(result.plot).toContain('Coldmirror');
    });

    it('decodes XML entities in title and plot', () => {
        const xml = `<movie>
            <title>Tom &amp; Jerry &lt;Special&gt;</title>
            <plot>He said &quot;hello&quot; &amp; left. Caf&#233;.</plot>
        </movie>`;
        const result = parseNfoContent(xml);
        expect(result.title).toBe('Tom & Jerry <Special>');
        expect(result.plot).toBe('He said "hello" & left. Café.');
    });

    it('handles a multi-line plot', () => {
        const xml = `<movie>
            <plot>Line one.
Line two.</plot>
        </movie>`;
        const result = parseNfoContent(xml);
        expect(result.plot).toBe('Line one.\nLine two.');
    });

    it('falls back to <outline> when <plot> is absent', () => {
        const xml = `<movie><outline>Short synopsis.</outline></movie>`;
        expect(parseNfoContent(xml).plot).toBe('Short synopsis.');
    });

    it('prefers <plot> over <outline>', () => {
        const xml = `<movie><outline>Short.</outline><plot>Full description.</plot></movie>`;
        expect(parseNfoContent(xml).plot).toBe('Full description.');
    });

    it('ignores an empty plot tag', () => {
        expect(parseNfoContent('<movie><plot>  </plot></movie>').plot).toBeUndefined();
    });

    it('still returns {} for unrecognised content with no local fields', () => {
        expect(parseNfoContent('<garbage/>')).toEqual({});
    });

    it('ignores a commented-out plot/title/year and uses the real ones', () => {
        const xml = `<movie>
            <!-- <title>Old Title</title><year>1990</year><plot>Old plot.</plot> -->
            <title>Real Title</title>
            <year>2008</year>
            <plot>Real plot.</plot>
        </movie>`;
        const result = parseNfoContent(xml);
        expect(result.title).toBe('Real Title');
        expect(result.year).toBe(2008);
        expect(result.plot).toBe('Real plot.');
    });

    it('falls through to <outline> when <plot> is present but empty', () => {
        const xml = `<movie><plot></plot><outline>Real synopsis.</outline></movie>`;
        expect(parseNfoContent(xml).plot).toBe('Real synopsis.');
    });

    it('unwraps CDATA in plot and title', () => {
        const xml = `<movie>
            <title><![CDATA[Tom & Jerry]]></title>
            <plot><![CDATA[A cat & mouse chase <in> HD.]]></plot>
        </movie>`;
        const result = parseNfoContent(xml);
        expect(result.title).toBe('Tom & Jerry');
        expect(result.plot).toBe('A cat & mouse chase <in> HD.');
    });

    it('does not throw on an out-of-range numeric entity, and keeps the provider id', () => {
        const xml = `<movie>
            <uniqueid type="imdb">tt0133093</uniqueid>
            <plot>Bad entity &#xFFFFFFFF; here.</plot>
        </movie>`;
        const result = parseNfoContent(xml);
        // The whole parse must not abort — the imdb id survives.
        expect(result.imdbId).toBe('tt0133093');
        // The unresolvable ref is left as the literal original.
        expect(result.plot).toContain('&#xFFFFFFFF;');
    });

    it('rejects <year>0000</year> (does not set year=0)', () => {
        expect(parseNfoContent('<movie><year>0000</year></movie>').year).toBeUndefined();
    });
});

describe('readNfoForVideo', () => {
    let dir: string;
    afterEach(async () => {
        if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('returns plot/year/title for a provider-less NFO (regression)', async () => {
        // Before the fix, readNfoForVideo returned {} unless the NFO carried an
        // imdb/tmdb id — silently discarding the description for a local movie
        // that is not in TMDB. It must now surface the local content.
        dir = await mkdtemp(join(tmpdir(), 'nfo-test-'));
        const video = join(dir, 'My-Local-Movie.mkv');
        await writeFile(
            join(dir, 'My-Local-Movie.nfo'),
            `<movie><title>My Local Movie</title><year>2008</year><plot>A description.</plot></movie>`,
        );
        const data = await readNfoForVideo(video);
        expect(data.plot).toBe('A description.');
        expect(data.year).toBe(2008);
        expect(data.title).toBe('My Local Movie');
        expect(data.imdbId).toBeUndefined();
    });

    it('prefers the provider id when both a sidecar and movie.nfo exist', async () => {
        dir = await mkdtemp(join(tmpdir(), 'nfo-test-'));
        const video = join(dir, 'Film.mkv');
        await writeFile(
            join(dir, 'Film.nfo'),
            `<movie><uniqueid type="imdb">tt0133093</uniqueid><plot>Sidecar plot.</plot></movie>`,
        );
        const data = await readNfoForVideo(video);
        expect(data.imdbId).toBe('tt0133093');
        expect(data.plot).toBe('Sidecar plot.');
    });

    it('returns {} when no NFO exists', async () => {
        dir = await mkdtemp(join(tmpdir(), 'nfo-test-'));
        const data = await readNfoForVideo(join(dir, 'Nothing.mkv'));
        expect(data).toEqual({});
    });

    it('prefers the plot-bearing movie.nfo over a title-only sibling .nfo', async () => {
        // Sibling `<file>.nfo` has only a <title>; movie.nfo carries the plot.
        // The richer candidate must win rather than the sparse sibling shadowing it.
        dir = await mkdtemp(join(tmpdir(), 'nfo-test-'));
        const video = join(dir, 'Film.mkv');
        await writeFile(join(dir, 'Film.nfo'), `<movie><title>Just A Title</title></movie>`);
        await writeFile(
            join(dir, 'movie.nfo'),
            `<movie><title>Full</title><plot>The real description.</plot></movie>`,
        );
        const data = await readNfoForVideo(video);
        expect(data.plot).toBe('The real description.');
    });
});

describe('parseNfoContent — kind discriminator', () => {
    it('sets kind=episode for <episodedetails> root', () => {
        const xml = `<episodedetails>
            <uniqueid type="imdb">tt1480055</uniqueid>
            <season>1</season>
            <episode>1</episode>
        </episodedetails>`;
        const result = parseNfoContent(xml);
        expect(result.kind).toBe('episode');
    });

    it('sets kind=series for <tvshow> root', () => {
        const xml = `<tvshow>
            <title>For All Mankind</title>
            <uniqueid type="imdb">tt7772588</uniqueid>
        </tvshow>`;
        const result = parseNfoContent(xml);
        expect(result.kind).toBe('series');
    });

    it('sets kind=movie for <movie> root', () => {
        const xml = `<movie>
            <uniqueid type="imdb">tt0133093</uniqueid>
        </movie>`;
        const result = parseNfoContent(xml);
        expect(result.kind).toBe('movie');
    });

    it('leaves kind undefined for unrecognised root tag', () => {
        const xml = `<nfofile><imdbid>tt1234567</imdbid></nfofile>`;
        const result = parseNfoContent(xml);
        expect(result.kind).toBeUndefined();
    });

    it('detects kind correctly when leading XML declaration is present', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<episodedetails>
    <uniqueid type="imdb">tt35287360</uniqueid>
    <season>3</season>
    <episode>7</episode>
</episodedetails>`;
        const result = parseNfoContent(xml);
        expect(result.kind).toBe('episode');
        expect(result.imdbId).toBe('tt35287360');
    });

    it('detects kind with leading whitespace before root element', () => {
        const xml = `\n\n  <tvshow>\n    <title>Test Show</title>\n  </tvshow>`;
        const result = parseNfoContent(xml);
        expect(result.kind).toBe('series');
    });

    it('ignores commented-out tags when detecting kind', () => {
        // A commented-out <movie> block must NOT classify this NFO as a movie;
        // the real <episodedetails> root wins.
        const xml = `<!-- <movie><title>Old Movie</title></movie> -->
<episodedetails>
    <uniqueid type="imdb">tt35287360</uniqueid>
    <season>3</season>
    <episode>7</episode>
</episodedetails>`;
        const result = parseNfoContent(xml);
        expect(result.kind).toBe('episode');
        expect(result.imdbId).toBe('tt35287360');
    });

    it('detects kind for namespaced root element', () => {
        // `<ns:tvshow>` must classify as series; the namespace prefix is
        // stripped from the local-name match.
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ns:tvshow xmlns:ns="http://example.com/nfo">
    <title>Namespaced Show</title>
    <uniqueid type="imdb">tt7772588</uniqueid>
</ns:tvshow>`;
        const result = parseNfoContent(xml);
        expect(result.kind).toBe('series');
    });
});

describe('parseAlbumNfoContent', () => {
    it('extracts all fields from valid album NFO', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<album>
    <title>OK Computer</title>
    <year>1997</year>
    <genre>Alternative Rock</genre>
    <genre>Art Rock</genre>
    <musicbrainzalbumid>b1392450-e666-3926-a536-22c65f834433</musicbrainzalbumid>
    <musicbrainzreleasegroupid>a1392450-e666-3926-a536-22c65f834433</musicbrainzreleasegroupid>
    <review>A landmark album...</review>
</album>`;
        const result = parseAlbumNfoContent(xml);
        expect(result.title).toBe('OK Computer');
        expect(result.year).toBe(1997);
        expect(result.genre).toEqual(['Alternative Rock', 'Art Rock']);
        expect(result.musicbrainzAlbumId).toBe('b1392450-e666-3926-a536-22c65f834433');
        expect(result.musicbrainzReleaseGroupId).toBe('a1392450-e666-3926-a536-22c65f834433');
        expect(result.review).toBe('A landmark album...');
    });

    it('handles missing fields gracefully', () => {
        const result = parseAlbumNfoContent('<album></album>');
        expect(result.title).toBeUndefined();
        expect(result.year).toBeUndefined();
        expect(result.genre).toBeUndefined();
    });
});

describe('parseArtistNfoContent', () => {
    it('extracts all fields from valid artist NFO', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<artist>
    <name>Riverglass</name>
    <musicbrainzartistid>a74b1b7f-71a5-4011-9441-d0b5e4122711</musicbrainzartistid>
    <biography>English rock band formed in 1985...</biography>
    <genre>Alternative Rock</genre>
    <genre>Electronic</genre>
</artist>`;
        const result = parseArtistNfoContent(xml);
        expect(result.name).toBe('Riverglass');
        expect(result.musicbrainzArtistId).toBe('a74b1b7f-71a5-4011-9441-d0b5e4122711');
        expect(result.biography).toBe('English rock band formed in 1985...');
        expect(result.genre).toEqual(['Alternative Rock', 'Electronic']);
    });

    it('handles missing fields gracefully', () => {
        const result = parseArtistNfoContent('<artist></artist>');
        expect(result.name).toBeUndefined();
        expect(result.biography).toBeUndefined();
    });
});

describe('findNfoPath', () => {
    it('returns basename.nfo path', () => {
        const paths = findNfoPath('/media/movies/The.Lantern.1999.mkv');
        expect(paths[0]).toBe('/media/movies/The.Lantern.1999.nfo');
        expect(paths[1]).toBe('/media/movies/movie.nfo');
    });

    it('returns episode nfo paths for TV', () => {
        const paths = findNfoPath('/media/tv/Show/Season 01/S01E01.mkv');
        expect(paths[0]).toBe('/media/tv/Show/Season 01/S01E01.nfo');
        expect(paths[1]).toBe('/media/tv/Show/Season 01/movie.nfo');
    });
});

describe('music NFO identity text normalization', () => {
    it.each(['Source &amp; Album &#50;', '<![CDATA[Source & Album 2]]>'])(
        'normalizes album identity %s',
        (title) => {
            expect(
                parseAlbumNfoContent(
                    `<album><!-- <title>Unrelated</title> --><title>${title}</title></album>`,
                ).title,
            ).toBe('Source & Album 2');
        },
    );
    it.each(['Source &amp; Artist &#x32;', '<![CDATA[Source & Artist 2]]>'])(
        'normalizes artist identity %s',
        (name) => {
            expect(
                parseArtistNfoContent(
                    `<artist><!-- <name>Unrelated</name> --><name>${name}</name></artist>`,
                ).name,
            ).toBe('Source & Artist 2');
        },
    );
});

describe('parseNfoContent — content rating', () => {
    it.each([
        ['<movie><title>X</title><mpaa>Rated PG-13</mpaa></movie>', 'Rated PG-13'],
        ['<movie><mpaa><![CDATA[FSK 12]]></mpaa></movie>', 'FSK 12'],
        ['<movie><certification>Germany:FSK 12</certification></movie>', 'Germany:FSK 12'],
        [
            '<movie><certification><![CDATA[US:PG-13 / Germany:12]]></certification></movie>',
            'US:PG-13 / Germany:12',
        ],
        [
            '<movie><mpaa>Rated R</mpaa><certification>Germany:FSK 16</certification></movie>',
            'Rated R / Germany:FSK 16',
        ],
        [
            '<movie><certification>DE:12</certification><certification>US:PG</certification></movie>',
            'DE:12 / US:PG',
        ],
    ])('extracts the rating from %s', (xml, expected) => {
        expect(parseNfoContent(xml).certification).toBe(expected);
    });

    it('ignores empty and commented-out rating tags', () => {
        expect(parseNfoContent('<movie><mpaa></mpaa></movie>').certification).toBeUndefined();
        expect(
            parseNfoContent('<movie><!-- <mpaa>R</mpaa> --><title>X</title></movie>')
                .certification,
        ).toBeUndefined();
    });
});
