// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * NFO Sidecar Parser
 *
 * Reads and parses Kodi/Plex/Emby NFO files that sit alongside video files.
 * NFO files contain authoritative provider IDs (IMDB, TMDB) for the media item.
 *
 * Uses regex — no XML library needed for this well-structured format.
 * NFO files are small and well-structured enough for targeted regex matching.
 *
 * Pure parsing functions are synchronous; file I/O is async.
 */

import { dirname, basename, extname, join } from 'node:path';
import { readSidecarText } from './sidecar-text.js';

export interface NfoData {
    imdbId?: string;
    tmdbId?: string;
    title?: string;
    year?: number;
    /**
     * The `<plot>` (or `<outline>`) sidecar description. Used as the item's
     * `overview` fallback for local media that carries no provider id — a
     * Coldmirror-style fan edit, a home movie, or anything not in TMDB — where
     * there is no metadata-sync source to fill the description otherwise.
     */
    plot?: string;
    /**
     * The `<mpaa>` and `<certification>` values (CDATA unwrapped), joined with " / "
     * when both exist. Forms seen: "PG-13", "Rated R", "FSK 12", "Germany:FSK 12",
     * "US:PG-13 / DE:12". Pick the one for a country with `pickCertificationForCountry`.
     */
    certification?: string;
    season?: number;
    episode?: number;
    /**
     * Root element of the NFO file, detected from the XML root tag.
     * - 'episode' — <episodedetails> (episode-scoped IMDB ID, not series-level)
     * - 'series'  — <tvshow>
     * - 'movie'   — <movie>
     * - undefined — root tag not recognised or NFO was not found
     */
    kind?: 'episode' | 'series' | 'movie';
}

/**
 * Whole-file scans below are `indexOf`/sticky-regex based on purpose: the lazy
 * `[\s\S]*?` and `[^>]+...` forms they replace rescan to the end of the file for
 * every unterminated opener, so a file of repeated openers costs quadratic
 * time. Each helper stops as soon as a closer cannot exist any more.
 */

/** Remove every `open ... close` span; an unterminated opener ends the scan. */
function stripSpans(s: string, open: string, close: string): string {
    let out = '';
    let pos = 0;
    for (;;) {
        const a = s.indexOf(open, pos);
        if (a === -1) break;
        const b = s.indexOf(close, a + open.length);
        if (b === -1) break;
        out += s.slice(pos, a);
        pos = b + close.length;
    }
    return pos === 0 ? s : out + s.slice(pos);
}

/** Body of the first `<name>...</name>` (case-insensitive), or undefined. */
function tagBody(s: string, name: string): string | undefined {
    const open = new RegExp(`<${name}>`, 'i').exec(s);
    if (!open) return undefined;
    const closeRe = new RegExp(`</${name}>`, 'gi');
    const bodyStart = open.index + open[0].length;
    closeRe.lastIndex = bodyStart;
    const close = closeRe.exec(s);
    return close ? s.slice(bodyStart, close.index) : undefined;
}

/**
 * Value of the first `<uniqueid type="<type>" ...>VALUE</uniqueid>` whose value
 * matches `valuePattern` (attribute order may vary).
 */
function uniqueIdValue(
    xml: string,
    type: 'imdb' | 'tmdb',
    valuePattern: string,
): string | undefined {
    const openRe = /<uniqueid/gi;
    const typeRe = new RegExp(`(?<=[\\s\\S])type=["']${type}["']`, 'i');
    const valueRe = new RegExp(`(${valuePattern})</uniqueid>`, 'iy');
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(xml)) !== null) {
        const attrsStart = m.index + m[0].length;
        const tagEnd = xml.indexOf('>', attrsStart);
        // No `>` left: no later opener can close either.
        if (tagEnd === -1) return undefined;
        // Every opener before `tagEnd` shares this tag end; the first one has the
        // longest attribute text, so checking it alone decides them all.
        openRe.lastIndex = tagEnd;
        if (!typeRe.test(xml.slice(attrsStart, tagEnd))) continue;
        valueRe.lastIndex = tagEnd + 1;
        const v = valueRe.exec(xml);
        if (v) return v[1];
    }
    return undefined;
}

function unwrapCdata(s: string): string {
    let out = '';
    let pos = 0;
    for (;;) {
        const a = s.indexOf('<![CDATA[', pos);
        if (a === -1) break;
        const b = s.indexOf(']]>', a + 9);
        if (b === -1) break;
        out += s.slice(pos, a) + s.slice(a + 9, b);
        pos = b + 3;
    }
    return pos === 0 ? s : out + s.slice(pos);
}

/**
 * Parse NFO XML content and extract provider IDs and episode metadata.
 * Returns empty object if no recognisable content is found.
 */
export function parseNfoContent(xml: string): NfoData {
    const result: NfoData = {};

    // Detect root element kind — must skip XML comments and the <?xml?>
    // declaration before regex-matching, otherwise a commented-out tag like
    // `<!-- <movie>...</movie> -->` falsely classifies an episode NFO as a
    // movie. Strip comments and the XML declaration before the root scan.
    const stripped = stripSpans(stripSpans(xml, '<!--', '-->'), '<?xml', '?>');
    // Allow an optional namespace prefix (e.g. `<ns:tvshow>`) — capture only
    // the local name so kind detection sees `tvshow`, not `ns:tvshow`.
    const rootMatch = stripped.match(/<\s*(?:[\w-]+:)?([a-zA-Z][\w-]*)/);
    if (rootMatch) {
        const rootTag = rootMatch[1].toLowerCase();
        if (rootTag === 'episodedetails') result.kind = 'episode';
        else if (rootTag === 'tvshow') result.kind = 'series';
        else if (rootTag === 'movie') result.kind = 'movie';
    }

    // <uniqueid type="imdb" ...>tt0133093</uniqueid>  (attribute order may vary)
    const imdbUniqueId = uniqueIdValue(xml, 'imdb', 'tt\\d{7,8}');
    if (imdbUniqueId) result.imdbId = imdbUniqueId.toLowerCase();

    // <uniqueid type="tmdb" ...>603</uniqueid>
    const tmdbUniqueId = uniqueIdValue(xml, 'tmdb', '\\d+');
    if (tmdbUniqueId) result.tmdbId = tmdbUniqueId;

    // Legacy: <imdbid>tt0133093</imdbid>
    if (!result.imdbId) {
        const legacyImdb = xml.match(/<imdbid>(tt\d{7,8})<\/imdbid>/i);
        if (legacyImdb) result.imdbId = legacyImdb[1].toLowerCase();
    }

    // Last resort: bare tt ID anywhere in the document
    if (!result.imdbId) {
        const bare = xml.match(/\b(tt\d{7,8})\b/i);
        if (bare) result.imdbId = bare[1].toLowerCase();
    }

    // Episode metadata
    const season = xml.match(/<season>(\d+)<\/season>/i);
    if (season) result.season = parseInt(season[1], 10);

    const episode = xml.match(/<episode>(\d+)<\/episode>/i);
    if (episode) result.episode = parseInt(episode[1], 10);

    // Local content metadata (title / year / plot). These make a provider-less
    // local movie self-sufficient — the file scanner applies them as the item's
    // title/year/overview when no TMDB/Jellyfin match is found.
    //
    // Matched against `stripped` (comments + <?xml?> already removed) so a
    // commented-out <plot>/<title>/<year> can't shadow the real tag.
    const title = tagBody(stripped, 'title');
    if (title !== undefined) {
        const t = normalizeNfoText(title);
        if (t) result.title = t;
    }

    const year = stripped.match(/<year>\s*(\d{4})\s*<\/year>/i);
    if (year) {
        const y = parseInt(year[1], 10);
        // Reject <year>0000</year> and other zero/garbage values so they don't
        // land as year=0 / a "0000-01-01" release date downstream.
        if (y > 0) result.year = y;
    }

    // <plot> is the primary description; <outline> is a shorter fallback some
    // exporters use. Fall through to <outline> when <plot> is absent OR empty
    // (an empty <plot></plot> must not shadow a real <outline>).
    let plotText = '';
    const plot = tagBody(stripped, 'plot');
    if (plot !== undefined) plotText = normalizeNfoText(plot);
    if (!plotText) {
        const outline = tagBody(stripped, 'outline');
        if (outline !== undefined) plotText = normalizeNfoText(outline);
    }
    if (plotText) result.plot = plotText;

    // Content rating. Kodi writes <mpaa>; Emby/Jellyfin/Plex exporters write
    // <certification> (possibly several, one per country).
    const certifications: string[] = [];
    for (const tag of ['mpaa', 'certification']) {
        const openRe = new RegExp(`<${tag}>`, 'gi');
        let guard = 0;
        while (openRe.exec(stripped) !== null && guard++ < 8) {
            const body = tagBody(stripped.slice(openRe.lastIndex - tag.length - 2), tag);
            const text = body === undefined ? '' : normalizeNfoText(body);
            if (text && !certifications.includes(text)) certifications.push(text);
        }
    }
    if (certifications.length > 0) result.certification = certifications.join(' / ');

    return result;
}

/**
 * Unwrap `<![CDATA[ … ]]>` sections, decode XML entities, and trim. NFO text
 * fields (plot/title) are displayed verbatim, so both the CDATA wrapper and an
 * un-decoded `&amp;` would otherwise surface as literal markup in the UI. Kodi/
 * Emby commonly CDATA-wrap plots.
 */
function normalizeNfoText(s: string): string {
    return decodeXmlEntities(unwrapCdata(s)).trim();
}

/**
 * Decode the handful of XML entities Kodi/Plex/Emby exporters emit in text
 * fields (`&amp; &lt; &gt; &quot; &apos;` + numeric refs). NFO plot/title text
 * is otherwise displayed verbatim, so an un-decoded `&amp;` would surface as
 * literal `&amp;` in the UI.
 */
function decodeXmlEntities(s: string): string {
    return s
        .replace(/&#x([0-9a-fA-F]+);/g, (m, h: string) => codePointOr(parseInt(h, 16), m))
        .replace(/&#(\d+);/g, (m, d: string) => codePointOr(parseInt(d, 10), m))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * Resolve a numeric character reference, returning the original literal on an
 * out-of-range code point (e.g. `&#xFFFFFFFF;`). Without this guard,
 * String.fromCodePoint would throw a RangeError and abort the whole
 * parseNfoContent call — discarding any provider id parsed from the same NFO.
 */
function codePointOr(n: number, original: string): string {
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return original;
    try {
        return String.fromCodePoint(n);
    } catch {
        return original;
    }
}

/**
 * Return candidate NFO file paths to check, in priority order.
 *
 * For /media/movies/The.Lantern.1999.mkv returns:
 *   ['/media/movies/The.Lantern.1999.nfo', '/media/movies/movie.nfo']
 */
export function findNfoPath(videoFilePath: string): string[] {
    const dir = dirname(videoFilePath);
    const base = basename(videoFilePath, extname(videoFilePath));
    return [join(dir, `${base}.nfo`), join(dir, 'movie.nfo')];
}

/**
 * Try to read and parse an NFO sidecar for the given video file.
 * Checks candidates in priority order and returns the first one with useful data.
 * Returns empty NfoData if no NFO found or no useful data could be parsed.
 */
export async function readNfoForVideo(videoFilePath: string): Promise<NfoData> {
    const candidates = findNfoPath(videoFilePath);
    // Prefer a candidate carrying an authoritative provider id (drives identity)
    // or a plot (the description) over a merely title/year-only one — otherwise a
    // sparse sibling `<file>.nfo` (just a <title>) would shadow a richer
    // `movie.nfo` holding the real plot/id. Fall back to the first candidate with
    // ANY useful field so a provider-less local movie still stands on its own
    // (this path used to return {} unless a provider id was present, silently
    // discarding an NFO's plot/title/year for a movie not in TMDB).
    let fallback: NfoData | undefined;
    for (const nfoPath of candidates) {
        try {
            const content = await readSidecarText(nfoPath);
            const data = parseNfoContent(content);
            if (data.imdbId ?? data.tmdbId ?? data.plot) {
                return data;
            }
            if (!fallback && (data.title ?? data.year ?? data.certification)) {
                fallback = data;
            }
        } catch {
            // File doesn't exist or unreadable — try next
        }
    }
    return fallback ?? {};
}

// ---------------------------------------------------------------------------
// Music NFO Types
// ---------------------------------------------------------------------------

export interface AlbumNfoData {
    title?: string;
    year?: number;
    genre?: string[];
    musicbrainzAlbumId?: string;
    musicbrainzReleaseGroupId?: string;
    review?: string;
}

export interface ArtistNfoData {
    name?: string;
    musicbrainzArtistId?: string;
    biography?: string;
    genre?: string[];
}

// ---------------------------------------------------------------------------
// Music NFO Parsers
// ---------------------------------------------------------------------------

export function parseAlbumNfoContent(xml: string): AlbumNfoData {
    const result: AlbumNfoData = {};

    const title = tagBody(stripSpans(xml, '<!--', '-->'), 'title');
    if (title !== undefined) {
        const text = normalizeNfoText(title);
        if (text) result.title = text;
    }

    const year = xml.match(/<year>(\d{4})<\/year>/i);
    if (year) result.year = parseInt(year[1], 10);

    const genres: string[] = [];
    const genreRe = /<genre>([^<]+)<\/genre>/gi;
    let genreMatch;
    while ((genreMatch = genreRe.exec(xml)) !== null) {
        genres.push(genreMatch[1].trim());
    }
    if (genres.length > 0) result.genre = genres;

    const mbAlbumId = xml.match(/<musicbrainzalbumid>([^<]+)<\/musicbrainzalbumid>/i);
    if (mbAlbumId) result.musicbrainzAlbumId = mbAlbumId[1].trim();

    const mbReleaseGroupId = xml.match(
        /<musicbrainzreleasegroupid>([^<]+)<\/musicbrainzreleasegroupid>/i,
    );
    if (mbReleaseGroupId) result.musicbrainzReleaseGroupId = mbReleaseGroupId[1].trim();

    const review = tagBody(xml, 'review');
    if (review !== undefined) result.review = review.trim();

    return result;
}

export function parseArtistNfoContent(xml: string): ArtistNfoData {
    const result: ArtistNfoData = {};

    const name = tagBody(stripSpans(xml, '<!--', '-->'), 'name');
    if (name !== undefined) {
        const text = normalizeNfoText(name);
        if (text) result.name = text;
    }

    const mbId = xml.match(/<musicbrainzartistid>([^<]+)<\/musicbrainzartistid>/i);
    if (mbId) result.musicbrainzArtistId = mbId[1].trim();

    const bio = tagBody(xml, 'biography');
    if (bio !== undefined) result.biography = bio.trim();

    const genres: string[] = [];
    const genreRe = /<genre>([^<]+)<\/genre>/gi;
    let genreMatch;
    while ((genreMatch = genreRe.exec(xml)) !== null) {
        genres.push(genreMatch[1].trim());
    }
    if (genres.length > 0) result.genre = genres;

    return result;
}

export async function readAlbumNfo(albumDir: string): Promise<AlbumNfoData> {
    try {
        const content = await readSidecarText(join(albumDir, 'album.nfo'));
        return parseAlbumNfoContent(content);
    } catch {
        return {};
    }
}

export async function readArtistNfo(artistDir: string): Promise<ArtistNfoData> {
    try {
        const content = await readSidecarText(join(artistDir, 'artist.nfo'));
        return parseArtistNfoContent(content);
    } catch {
        return {};
    }
}
