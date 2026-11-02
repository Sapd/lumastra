// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A library writer controls NFO content and every scan of the folder parses it
 * (a shared movie.nfo once per video), so each parser must stay linear on input
 * that repeats an opener with no closer.
 */

import { describe, it, expect } from 'vitest';
import * as nfo from './nfo-parser.js';

const SIZE = Number(process.env.REDOS_SIZE ?? 1_000_000);
const BUDGET_MS = 750;

function repeat(unit: string, bytes = SIZE): string {
    return unit.repeat(Math.ceil(bytes / unit.length));
}

const ADVERSARIAL: Record<string, string> = {
    'uniqueid opener x n': repeat('<uniqueid x'),
    'uniqueid opener x n, one closing >': `${repeat('<uniqueid x')}>`,
    'uniqueid imdb attr x n': repeat('<uniqueid type="imdb" '),
    'uniqueid tmdb attr, no value': repeat('<uniqueid type="tmdb"> '),
    'uniqueid imdb tags, wrong value': repeat('<uniqueid type="imdb">tt1</uniqueid>'),
    'comment opener x n': repeat('<!--'),
    'xml declaration opener x n': repeat('<?xml'),
    'title opener x n': repeat('<title>'),
    'plot opener x n': repeat('<plot>'),
    'outline opener x n': repeat('<outline>'),
    'review opener x n': repeat('<review>'),
    'biography opener x n': repeat('<biography>'),
    'plot with CDATA opener x n': `<plot>${repeat('<![CDATA[')}</plot>`,
    'plot with entity opener x n': `<plot>${repeat('&#x')}</plot>`,
    'plot with decimal entity opener x n': `<plot>${repeat('&#1')}</plot>`,
    'year with whitespace': repeat('<year>  '),
    'tt id without boundary': repeat('tt1234567890'),
    'season opener x n': repeat('<season>1'),
    'root tag with whitespace': `<${' '.repeat(SIZE)}`,
    'root tag with namespace chars': `<${'a'.repeat(SIZE)}`,
    'genre opener x n': repeat('<genre>x'),
    'musicbrainz opener x n': repeat('<musicbrainzalbumid>x'),
};

const PARSERS: Record<string, (input: string) => unknown> = {
    parseNfoContent: nfo.parseNfoContent,
    parseAlbumNfoContent: nfo.parseAlbumNfoContent,
    parseArtistNfoContent: nfo.parseArtistNfoContent,
};

/** Exported functions that do no text parsing of their own. */
const NOT_TEXT_PARSERS = ['findNfoPath', 'readNfoForVideo', 'readAlbumNfo', 'readArtistNfo'];

describe('nfo-parser stays linear on adversarial input', () => {
    it('drives every exported text parser', () => {
        const exported = Object.entries(nfo)
            .filter(([, v]) => typeof v === 'function')
            .map(([k]) => k)
            .filter((k) => !NOT_TEXT_PARSERS.includes(k))
            .sort();
        expect(Object.keys(PARSERS).sort()).toEqual(exported);
    });

    const cases = Object.entries(PARSERS).flatMap(([fn, run]) =>
        Object.entries(ADVERSARIAL).map(([name, input]) => ({ fn, run, name, input })),
    );

    it.each(cases)('$fn: $name', ({ run, input }) => {
        const started = performance.now();
        run(input);
        const elapsed = performance.now() - started;
        expect(elapsed).toBeLessThan(BUDGET_MS);
    });
});

/** The pre-rewrite regex parser, kept as the oracle for parseNfoContent. */
function legacyParse(xml: string): nfo.NfoData {
    const result: nfo.NfoData = {};
    const stripped = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?xml[\s\S]*?\?>/g, '');
    const rootMatch = stripped.match(/<\s*(?:[\w-]+:)?([a-zA-Z][\w-]*)/);
    if (rootMatch) {
        const rootTag = rootMatch[1].toLowerCase();
        if (rootTag === 'episodedetails') result.kind = 'episode';
        else if (rootTag === 'tvshow') result.kind = 'series';
        else if (rootTag === 'movie') result.kind = 'movie';
    }
    const imdb = xml.match(/<uniqueid[^>]+type=["']imdb["'][^>]*>(tt\d{7,8})<\/uniqueid>/i);
    if (imdb) result.imdbId = imdb[1].toLowerCase();
    const tmdb = xml.match(/<uniqueid[^>]+type=["']tmdb["'][^>]*>(\d+)<\/uniqueid>/i);
    if (tmdb) result.tmdbId = tmdb[1];
    if (!result.imdbId) {
        const legacy = xml.match(/<imdbid>(tt\d{7,8})<\/imdbid>/i);
        if (legacy) result.imdbId = legacy[1].toLowerCase();
    }
    if (!result.imdbId) {
        const bare = xml.match(/\b(tt\d{7,8})\b/i);
        if (bare) result.imdbId = bare[1].toLowerCase();
    }
    const season = xml.match(/<season>(\d+)<\/season>/i);
    if (season) result.season = parseInt(season[1], 10);
    const episode = xml.match(/<episode>(\d+)<\/episode>/i);
    if (episode) result.episode = parseInt(episode[1], 10);
    const text = (s: string): string =>
        s
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
            .replace(/&amp;/g, '&')
            .trim();
    const title = stripped.match(/<title>([\s\S]*?)<\/title>/i);
    if (title) {
        const t = text(title[1]);
        if (t) result.title = t;
    }
    const year = stripped.match(/<year>\s*(\d{4})\s*<\/year>/i);
    if (year && parseInt(year[1], 10) > 0) result.year = parseInt(year[1], 10);
    let plotText = '';
    const plot = stripped.match(/<plot>([\s\S]*?)<\/plot>/i);
    if (plot) plotText = text(plot[1]);
    if (!plotText) {
        const outline = stripped.match(/<outline>([\s\S]*?)<\/outline>/i);
        if (outline) plotText = text(outline[1]);
    }
    if (plotText) result.plot = plotText;
    return result;
}

const TOKENS = [
    '<movie>',
    '</movie>',
    '<episodedetails>',
    '<!--',
    '-->',
    '<?xml version="1.0"?>',
    '<?xml',
    '?>',
    '<uniqueid type="imdb" default="true">',
    "<UNIQUEID TYPE='tmdb'>",
    '<uniqueid',
    '<uniqueid x',
    'type="imdb"',
    "type='tmdb'",
    'tt1234567',
    'tt12345678',
    '603',
    '</uniqueid>',
    '</UNIQUEID>',
    '<title>',
    '</title>',
    '<plot>',
    '</plot>',
    '<outline>',
    '</outline>',
    '<![CDATA[',
    ']]>',
    '<year>2001</year>',
    '<season>2</season>',
    '<imdbid>tt7654321</imdbid>',
    '&amp;',
    '>',
    '<',
    ' ',
    '\n',
    'a',
];

function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('parseNfoContent keeps output identical to the regex parser', () => {
    it('matches on random token soup', () => {
        const rnd = mulberry32(20261007);
        for (let i = 0; i < 4000; i++) {
            const n = 1 + Math.floor(rnd() * 25);
            let input = '';
            for (let j = 0; j < n; j++) input += TOKENS[Math.floor(rnd() * TOKENS.length)];
            expect(nfo.parseNfoContent(input), JSON.stringify(input)).toEqual(legacyParse(input));
        }
    });

    it('parses a real-shaped Kodi movie NFO', () => {
        const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<!-- <title>Wrong</title> -->
<movie>
  <title>Night of the Living Dead</title>
  <year>1968</year>
  <plot><![CDATA[A group of strangers &amp; a farmhouse.]]></plot>
  <uniqueid type="imdb" default="true">tt0063350</uniqueid>
  <uniqueid default="false" type="tmdb">10331</uniqueid>
</movie>`;
        expect(nfo.parseNfoContent(xml)).toEqual({
            kind: 'movie',
            title: 'Night of the Living Dead',
            year: 1968,
            plot: 'A group of strangers & a farmhouse.',
            imdbId: 'tt0063350',
            tmdbId: '10331',
        });
    });
});
