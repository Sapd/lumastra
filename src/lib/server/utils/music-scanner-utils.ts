// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Music Scanner Utilities
 *
 * Lightweight shared helpers for the music file scanner.
 * NO heavy dependencies (no music-metadata, no scanner internals).
 * Safe to import from post-scan generator, API routes, and the scanner.
 */

import path from 'node:path';
import { writeFile as fsWriteFile } from 'node:fs/promises';
import { config } from '$lib/server/config.js';
import { parseLRC } from './lrc-parser.js';
import { safeMkdir, safeStat, withFsGuard } from './safe-fs.js';
import { readContainedFile } from './contained-fs.js';
import {
    resolveWritePath,
    resolveReadPath,
} from '$lib/server/services/metadata-storage.service.js';

export const DISC_FOLDER_PATTERN = /^(?:cd|disc|disk|vol(?:ume)?\.?|part)\s*(\d+)$/i;

export interface DiscSuffix {
    title: string;
    disc: number | null;
}

/**
 * Split a trailing CD/Disc/Disk ordinal, never a volume/part or a disc count.
 * Count markers (2CD, [2CD], (2CD)) are left unchanged with disc=null.
 * A marker must follow a separate, nonempty title; matching brackets are required.
 * Ordinals are limited to 1..20. Bare Disc/Disk needs local folder evidence;
 * explicit CD, bracketed markers and separated markers can supply disc metadata.
 */
export function splitDiscSuffix(title: string, folderEvidence = false): DiscSuffix {
    // Bound regex work, and remove trailing whitespace before looking for a marker.
    if (title.length > 500) return { title, disc: null };
    // A trailing release year may hide the marker. Drop it only if the
    // remaining string actually ends in a valid disc ordinal.
    const trimmed = title.trimEnd().replace(/\s+\((?:19|20)\d{2}\)$/, '');
    const match = trimmed.match(
        /(?:\s+[-–—]\s+|\s*[:,]\s*|\s+)(?:((?:cd|disc|disk)\s*\d+(?:\s+of\s+\d+)?)|\(((?:cd|disc|disk)\s*\d+(?:\s+of\s+\d+)?)\)|\[((?:cd|disc|disk)\s*\d+(?:\s+of\s+\d+)?)\])$/i,
    );
    if (!match || match.index === undefined) return { title, disc: null };
    const base = trimmed.slice(0, match.index).trim();
    const marker = match[1] ?? match[2] ?? match[3];
    const disc = Number(marker.match(/\d+/)?.[0]);
    const bareWord = Boolean(match[1]) && /^\s+(?:disc|disk)/i.test(match[0]);
    if (
        !base ||
        !Number.isSafeInteger(disc) ||
        disc < 1 ||
        disc > 20 ||
        (bareWord && !folderEvidence)
    )
        return { title, disc: null };
    return { title: base, disc };
}

/** Different ordinals for the same cleaned base, from other files in this folder. */
export function hasMatchingDiscTitles(title: string, otherTitles: Iterable<unknown>): boolean {
    const incoming = splitDiscSuffix(cleanAlbumTitle(title), true);
    if (incoming.disc === null) return false;
    const key = (value: string): string =>
        value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
    for (const other of otherTitles) {
        if (typeof other !== 'string') continue;
        const candidate = splitDiscSuffix(cleanAlbumTitle(other), true);
        if (
            candidate.disc !== null &&
            candidate.disc !== incoming.disc &&
            key(candidate.title) === key(incoming.title)
        )
            return true;
    }
    return false;
}

/** Clean scene tails first; only folder evidence may remove an identity marker. */
export function folderAlbumTitle(title: string, discEvidence = false, artistName?: string): string {
    const cleaned = cleanAlbumTitle(title, artistName);
    return discEvidence ? splitDiscSuffix(cleaned, true).title : cleaned;
}

/** Central directory for lyrics mirroring the track's directory structure. */
function lyricsCentralDir(trackFilePath: string): string {
    // Mirror the track's parent directory under {BASE_PATH}/metadata/lyrics/
    const baseDir = config.BASE_PATH || '/config';
    const dir = path.dirname(trackFilePath);
    // Strip leading slash to avoid double-slash in join
    const relative = dir.startsWith('/') ? dir.slice(1) : dir;
    return path.join(baseDir, 'metadata', 'lyrics', relative);
}

function getErrorCode(err: unknown): string | undefined {
    return err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: unknown }).code)
        : undefined;
}

export function parseDiscFolder(folderName: string): number | null {
    const match = folderName.match(DISC_FOLDER_PATTERN);
    return match ? parseInt(match[1], 10) : null;
}

export function resolveAlbumDir(trackFilePath: string): {
    albumDir: string;
    discNumber: number | null;
} {
    const parentDir = path.dirname(trackFilePath);
    const parentName = path.basename(parentDir);
    const disc = parseDiscFolder(parentName);
    if (disc !== null) {
        return { albumDir: path.dirname(parentDir), discNumber: disc };
    }
    return { albumDir: parentDir, discNumber: null };
}

/**
 * Per-album metadata storage path for cover art.
 *
 * Used for albums whose track folder is shared (e.g. a "Various Artists"
 * folder containing tracks from many different albums). Writing the cover
 * next to tracks in such folders collides with other albums in the same
 * directory, so we store it under the central config dir keyed by album id.
 */
export function albumCoverMetadataPath(albumId: string, extensionWithDot: string): string {
    const baseDir = config.BASE_PATH || '/config';
    return path.join(baseDir, 'metadata', 'music', 'album-covers', `${albumId}${extensionWithDot}`);
}

export function extractYearFromFolder(folderName: string): number | null {
    const currentYear = new Date().getFullYear();
    for (const match of folderName.matchAll(/\((\d{4})\)/g)) {
        const year = parseInt(match[1], 10);
        if (year >= 1900 && year <= currentYear + 1) return year;
    }
    return null;
}

// Scene-release suffix tokens that commonly leak into folder names or ID3 album
// tags (e.g. "Whiteline Fever-WEB"). Order matters: multi-part tokens like
// "WEB-DL" must precede "WEB" so they match first.
//
// This list is only used with a `-`, `.` or `_` separator. After a space or in
// brackets only the narrower lists below apply, so "Route 192", "Mario Kart
// V2", "Some CD", "Halo Promo" and "Abbey Road (Remastered)" survive.
const SCENE_TAG_ALTERNATION =
    'WEB-DL|WEBRIP|WEBDL|WEB|CDM|CDS|\\d*CD|VINYL|SACD|DVDA|HDTRACKS|MQA|' +
    'FLAC|MP3|AAC|ALAC|WAV|DSD|320|256|192|V0|V2|16BIT|24BIT|' +
    'PROPER|REPACK|RETAIL|PROMO|REMASTERED|REMASTER';
const TRAILING_SCENE_TAG = new RegExp(`[._-]+(?:${SCENE_TAG_ALTERNATION})\\s*$`, 'i');
// A full scene tail: a recognized tag, any further dash/dot tokens, a release
// year and an optional group — "-16BIT-44-KHZ-WEB-FLAC-2020-WALKMAN". The year
// is required so an ordinary dashed title is never mistaken for one.
const SCENE_TAIL = new RegExp(
    `[._-](?:${SCENE_TAG_ALTERNATION})(?:[._-][^\\s._-]+)*?[._-](?:19|20)\\d{2}(?:[._-][^\\s._-]+)?\\s*$`,
    'i',
);

// Scene rippers also write the tag into the ID3 album with a plain space
// ("Sucker WEB", "Encore CDS"). After a space only tokens that are no ordinary
// word are stripped in any case; WEB, VINYL, MP3 and FLAC only in upper case
// and only when the rest of the title is not upper case too, so "Into The Web",
// "Black Vinyl" and "SPIDER WEB" survive. `(?<!\s)` lets a whitespace run start
// one match attempt, not one per character (a long run would be quadratic).
const SPACED_SCENE_TAG = /(?<!\s)\s+(?:WEB-DL|WEBRIP|CDM|CDS)\s*$/i;
const SPACED_UPPER_SCENE_TAG = /(?<!\s)\s+(?:WEB|VINYL|MP3|FLAC)\s*$/;
// A trailing "(Promo CDS)", "(WEB)" or "[Vinyl]": matched brackets holding
// format/source tags only. PROMO counts only next to one of them; edition
// words ("Remastered", "Retail"), bitrates and "V2" are never stripped here.
const BRACKET_TAG = 'WEB-DL|WEBRIP|WEBDL|WEB|CDM|CDS|\\d*CD|VINYL|MP3|FLAC';
const BRACKET_BODY = `(?:PROMO[\\s,/&+._-]+)?(?:${BRACKET_TAG})(?:[\\s,/&+._-]+(?:${BRACKET_TAG}|PROMO))*`;
const BRACKETED_SCENE_TAGS = new RegExp(
    `(?<!\\s)\\s*(?:\\(\\s*${BRACKET_BODY}\\s*\\)|\\[\\s*${BRACKET_BODY}\\s*\\])\\s*$`,
    'i',
);
// A spaced or bracketed strip must not leave a dangling word or separator:
// "Into The WEB" stays, "Album - WEB" becomes "Album".
const DANGLING_WORD = /(?:^|\s)(?:the|a|an|of|in|on|to|and|with|for|der|die|das|le|la|el)$/i;
const DANGLING_SEPARATOR = /[\s,;:\u2013\u2014-]+$/;

function stripSpacedTag(title: string, tag: RegExp): string {
    if (!tag.test(title)) return title;
    const rest = title.replace(tag, '').replace(DANGLING_SEPARATOR, '').trim();
    if (!rest || DANGLING_WORD.test(rest)) return title;
    // "SPIDER WEB": an all-caps title ends in a real word, not a tag.
    if (tag === SPACED_UPPER_SCENE_TAG && rest === rest.toUpperCase()) return title;
    return rest;
}

// A run of 2+ underscores between words: the filesystem-substituted stand-in
// for a ":", " - " or " (" in a scene/ripper name ("Hypnotic Tango__Club Mix").
const UNDERSCORE_SEPARATOR = /(?<=[^\s_])\s*_{2,}\s*(?=[^\s_])/;

function joinUnderscoreSegments(segments: string[], convertSingles: boolean): string {
    return segments
        .map((seg) =>
            convertSingles && !/\s/.test(seg) && seg.includes('_')
                ? seg.replace(/_+/g, ' ').trim()
                : seg,
        )
        .reduce(
            (acc, seg) => (acc === '' ? seg : `${acc}${/^[([]/.test(seg) ? ' ' : ' - '}${seg}`),
            '',
        );
}

/**
 * Undo `__` separator substitution in a title: "Hypnotic Tango__Club Mix" ->
 * "Hypnotic Tango - Club Mix", "MARRY THE NIGHT__(RADIO EDIT)" -> "MARRY THE
 * NIGHT (RADIO EDIT)". A segment that has no spaces at all also gets its single
 * underscores turned back into spaces. Titles without a `__` between words
 * (including "lo_fi" and "__init__") are returned unchanged.
 */
export function cleanUnderscoreSeparators(title: string): string {
    const segments = title.split(new RegExp(UNDERSCORE_SEPARATOR, 'g'));
    return segments.length > 1 ? joinUnderscoreSegments(segments, true) : title;
}

/**
 * A tag value with no whitespace at all and an underscore between two other
 * characters: "Corin_Vale", "Hold_The_Signal". Leading/trailing-only
 * underscores ("__init__", "_ensnare_") do not count. The SQL rendering
 * (`UNDERSCORE_FOR_SPACE_SQL`) must stay the same pattern.
 */
const UNDERSCORE_FOR_SPACE = /^\S*[^\s_]_+[^\s_]\S*$/;
export const UNDERSCORE_FOR_SPACE_SQL = '^\\S*[^\\s_]_+[^\\s_]\\S*$';
const INNER_UNDERSCORES = /(?<=[^\s_])_+(?=[^\s_])/g;

/**
 * Undo `_`-for-space substitution in a tag or folder name: "Corin_Vale" ->
 * "Corin Vale", "Hold_The_Signal" -> "Hold The Signal",
 * "NVX_feat_Orrin" -> "NVX feat Orrin" (which the credit splitter then splits).
 * A `__` between words is a separator as in {@link cleanUnderscoreSeparators}
 * ("sky__acoustic_mix" -> "sky - acoustic mix").
 *
 * Only a value with NO whitespace is touched: one real space means the
 * underscores are deliberate ("Mara Feat_ Tessa" stays). Underscores at
 * the edges stay ("_ensnare_", "__init__"), and so does a lower-case pair
 * joined by ONE underscore ("lo_fi"), the shape of a deliberate handle.
 * Every other underscore-joined artist and album on prod (89 of 90,
 * 2026-10-15) was a substitution; the pair rule keeps one lower-case duo
 * name there as it is.
 */
export function spaceUnderscoreWords(value: string): string {
    if (!UNDERSCORE_FOR_SPACE.test(value)) return value;
    const separated = cleanUnderscoreSeparators(value);
    if (separated !== value) return separated;
    const gaps = value.match(INNER_UNDERSCORES) ?? [];
    if (gaps.length === 1 && value === value.toLowerCase()) return value;
    return value.replace(INNER_UNDERSCORES, ' ');
}

const TRACK_PREFIXED_NAME = /^(\d{1,3})-(?=\S)/;
const FILENAME_TRACK_SEGMENT = /\s-\s(\d{1,3})(?=\s-\s)/g;

/**
 * Infer a missing track tag from explicit filename numbering. Interior track
 * segments win over ripper prefixes; conflicting segments are ambiguous.
 * Like stripTrackNumberFromArtistTag, disc+track uses a one-digit disc prefix,
 * but only a known matching disc permits interpreting it here.
 */
export function trackNumberFromFilename(
    filePath: string,
    discNumber: number | null,
): number | null {
    const stem = path.basename(filePath, path.extname(filePath));
    const segments = [...stem.matchAll(FILENAME_TRACK_SEGMENT)].map((match) => match[1]!);
    if (new Set(segments.map(Number)).size > 1) return null;
    // A lone prefix is weaker evidence than a " - NN - " segment: it must be
    // two digits ("01 - ", "07_"), or three when the first digit is the known
    // disc ("301. "). "2-Unlimited", "666 - Song" and "1999 - Prince" stay
    // unnumbered.
    const prefix = segments.length
        ? undefined
        : /^(\d{2,3})(?: - |\. |-(?=[^\d\s])|_)(?=\S)/.exec(stem)?.[1];
    const candidate = segments[0] ?? prefix;
    if (candidate === undefined) return null;
    let number = Number(candidate);
    if (candidate.length === 3 && Number(candidate[0]) === discNumber) {
        number = Number(candidate.slice(1));
    } else if (prefix !== undefined && prefix.length === 3) {
        return null;
    }
    return number > 0 ? number : null;
}

/** Lower-cased, `_` as space, whitespace collapsed: raw tag and stored copy compare equal. */
function foldForCompare(value: string): string {
    return value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Drop the track-number prefix a scene ripper wrote into an artist tag
 * ("09-Corin_Vale" for track 9 of a compilation, prod: 40 artists).
 *
 * "NN-" at the start proves nothing alone ("2-4 Grooves", "50-50", "4 Strings"
 * has no hyphen at all). It is stripped only when the FILE says so too:
 *  - the file name starts with the whole tag followed by " - "
 *    ("09-Corin_Vale - Album - 09 - Title.mp3"), and
 *  - the file name carries the prefix number as its " - NN - " track segment
 *    (also as disc+track, "206" for track 06). The track tag alone is no
 *    proof, and a one-digit prefix ("2-4 Grooves", "4-Non Blondes") never is.
 * Returns the value unchanged when either proof is missing.
 */
export function stripTrackNumberFromArtistTag(tag: string, evidence: { filePath: string }): string {
    const value = tag.trim();
    const match = TRACK_PREFIXED_NAME.exec(value);
    // Rippers zero-pad ("09-"); "2-4 Grooves" / "4-Non Blondes" are names.
    if (!match?.[1] || match[1].length < 2) return value;
    const rest = value.slice(match[0].length).trim();
    // "50-50": nothing but digits left is a name, not an artist.
    if (rest.length === 0 || /^\d+$/.test(rest)) return value;
    const stem = foldForCompare(path.basename(evidence.filePath, path.extname(evidence.filePath)));
    if (!stem.startsWith(`${foldForCompare(value)} - `)) return value;
    for (const seg of stem.matchAll(FILENAME_TRACK_SEGMENT)) {
        const n = seg[1] ?? '';
        // "09", or disc+track "209" (one digit of disc in front).
        if (n === match[1] || (n.length === 3 && n.slice(1) === match[1])) return rest;
    }
    return value;
}

/**
 * Strip trailing scene-release suffix tokens from an album title.
 *
 * Handles folder names like "Whiteline Fever-WEB" or tag values like
 * "Album Name.FLAC.REMASTERED" by repeatedly trimming recognized tokens from
 * the end, and a full scene tail ("-16BIT-44-KHZ-WEB-FLAC-2020-WALKMAN"). Uses
 * a conservative allowlist so legitimate album names are not mangled ("Live at
 * Wembley" stays intact; "Live" is not in the list).
 *
 * Also undoes filesystem underscore substitution (see
 * {@link cleanUnderscoreSeparators}); on a scene release with no spaces at all
 * every `_` becomes a space. When `artistName` is given, a scene release's
 * "Artist-" prefix is dropped ("Monrose-Strictly Physical-…" -> "Strictly
 * Physical").
 *
 * Never returns an empty string — if stripping would consume the whole title,
 * the original trimmed input is returned instead.
 */
export function cleanAlbumTitle(title: string, artistName?: string): string {
    const original = title.trim();
    let result = original.replace(SCENE_TAIL, '').trim();
    let prev: string;
    let dashTagStripped = result !== original;
    do {
        prev = result;
        const undashed = result.replace(TRAILING_SCENE_TAG, '').trim();
        if (undashed && undashed !== result) dashTagStripped = true;
        result = undashed || result;
        for (const tag of [SPACED_SCENE_TAG, SPACED_UPPER_SCENE_TAG, BRACKETED_SCENE_TAGS]) {
            result = stripSpacedTag(result, tag);
        }
    } while (result !== prev);
    if (result.length === 0) return original;
    const wasSceneRelease = result !== original;

    // Only a dash/dot scene name carries an "Artist-" prefix; "Muse-Muse WEB" keeps it.
    const artist = artistName?.trim();
    if (dashTagStripped && artist) {
        const prefix = result.slice(0, artist.length + 1);
        const rest = result.slice(artist.length + 1).trim();
        if (rest && prefix.toLowerCase() === `${artist.toLowerCase()}-`) result = rest;
    }

    const segments = result.split(new RegExp(UNDERSCORE_SEPARATOR, 'g'));
    return spaceUnderscoreWords(
        joinUnderscoreSegments(segments, wasSceneRelease || segments.length > 1),
    );
}

// ---------------------------------------------------------------------------
// Various Artists handling
// ---------------------------------------------------------------------------

// The canonical label and matcher live in src/lib/shared/ so client code
// (e.g. AlbumModal) can use them without dragging in server-only deps.
// Re-export here so server callers keep their existing import paths, and
// import them locally for use further down in this file.
import { VARIOUS_ARTISTS_LABEL, isVariousArtistsName } from '$lib/shared/various-artists.js';
export { VARIOUS_ARTISTS_LABEL, isVariousArtistsName };

const VA_FOLDER_PATTERN = /^(va|various(?:\s+artists?)?)\s*[-_]+\s*(.+)$/i;

/**
 * Detects folder names like "Various - Album Title" or "VA - Album Title" and
 * returns a canonical artist + cleaned album name. Returns null if not a VA
 * pattern. Only intended as a fallback when ID3 tags are absent.
 */
export function parseVAFolderPattern(
    folderBasename: string,
    discEvidence = false,
): { artist: string; album: string } | null {
    const match = folderBasename.match(VA_FOLDER_PATTERN);
    if (!match) return null;
    return {
        artist: VARIOUS_ARTISTS_LABEL,
        album: folderAlbumTitle(match[2].trim(), discEvidence),
    };
}

// ---------------------------------------------------------------------------
// Artist name derivation (tag → filename → folder)
// ---------------------------------------------------------------------------

/** "01 - " / "01. " / "01 " / "01-" prefixes commonly used for track numbers. */
const TRACK_NUMBER_PREFIX = /^\d{1,3}(?:\s*[-._)]\s*|\s+)/;
/**
 * Artist/title separator: hyphen, en-dash, em-dash, or underscore, flanked by
 * spaces. Underscore is included for rippers/scene releases that substitute
 * `_` for `-` (filesystem-reserved char or stylistic). The space-flanking
 * requirement keeps inline `file_name_with_underscores` patterns from being
 * misinterpreted as artist/title splits.
 */
const FILENAME_ARTIST_TITLE_SEPARATOR = /\s[-–—_]\s/;
/**
 * A bare 4-digit year in a plausible range. When this appears on the LEFT of
 * the filename split (e.g. "1999 - Little Red Lantern.mp3"), it's almost
 * never the artist — it's a "year - title" layout. Reject to fall back to
 * folder derivation.
 */
const YEAR_ONLY_LEFT = /^\d{4}$/;

/**
 * Disc/volume identifiers that occasionally leak into a flat filename
 * convention (e.g. `CD1 - Title.mp3`, `Disc 2 _ Title.mp3`). Reject these on
 * the left side of a filename split so they don't get promoted to artist
 * names — they're nearly always disc markers, not artists.
 */
const DISC_OR_VOLUME_LEFT = /^(?:cd|disc|disk|vol(?:ume)?\.?|part)\s*\d+$/i;

/**
 * Normalize a filename stem where `_` has been substituted for spaces across
 * the WHOLE name (a common way to encode spaces in filenames), e.g.
 * `artist_name_-_song_title`.
 *
 * Only fires when the stem has NO spaces at all but DOES contain underscores —
 * that combination is a reliable signal of wholesale substitution. A stem that
 * already contains a space is returned untouched, so a deliberate inline
 * underscore (`some_word - title`) survives. All underscores are converted
 * uniformly and whitespace runs collapsed, which also turns a `_-_` artist/
 * title separator into the ` - ` that {@link parseArtistTitleFromFilename}
 * recognizes.
 */
export function normalizeUnderscoreStem(stem: string): string {
    // Any existing whitespace (space/tab/NBSP/…) means it's not a wholesale
    // substitution — leave it alone. `\s` covers unicode whitespace in JS.
    if (/\s/.test(stem) || !stem.includes('_')) return stem;
    const normalized = stem.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    // An all-underscore stem (`___`) collapses to '' — never hand back an empty
    // title; keep the original stem so callers always have something non-blank.
    return normalized || stem;
}

/**
 * Parse `{Artist} - {Title}` from a filename stem.
 *
 * Strips a leading track-number prefix (e.g. "01 - ") before splitting on the
 * first space-flanked dash/en-dash/em-dash/underscore. Returns null when no
 * usable split exists — callers fall back to folder-based derivation. Also
 * rejects two left-side patterns that would otherwise produce nonsense
 * artists: an isolated 4-digit year (`YYYY - Title` layout) and disc/volume
 * markers (`CD1 - Title`, `Disc 2 _ Title`).
 *
 * The matched separator character is returned so callers can apply
 * confidence-based behavior — `_` is more ambiguous than `-` (it shows up
 * inside titles more often), so `deriveArtistName` prefers a folder match
 * over a `_`-split when the folder is present and doesn't confirm either side.
 */
export function parseArtistTitleFromFilename(
    filePath: string,
): { left: string; right: string; separator: string } | null {
    return parseArtistTitleFromStem(path.basename(filePath, path.extname(filePath)));
}

/**
 * Stem-level core of {@link parseArtistTitleFromFilename}. Operates on a bare
 * name string (extension already stripped, or an existing DB `title` that was
 * filename-derived by an earlier scan) so callers with a raw title — e.g. the
 * underscore-title backfill — don't route it through `path.extname`, which
 * would wrongly lop off a trailing `.v2`-style token.
 */
function parseArtistTitleFromStem(
    rawStem: string,
): { left: string; right: string; separator: string } | null {
    const stem = normalizeUnderscoreStem(rawStem);
    const cleaned = stem.replace(TRACK_NUMBER_PREFIX, '').trim();
    const match = cleaned.match(FILENAME_ARTIST_TITLE_SEPARATOR);
    if (!match || match.index === undefined || match.index === 0) return null;
    const left = cleaned.slice(0, match.index).trim();
    const right = cleaned.slice(match.index + match[0].length).trim();
    if (!left || !right) return null;
    if (YEAR_ONLY_LEFT.test(left)) {
        const year = parseInt(left, 10);
        const currentYear = new Date().getFullYear();
        if (year >= 1900 && year <= currentYear + 1) return null;
    }
    if (DISC_OR_VOLUME_LEFT.test(left)) return null;
    // match[0] is " - " / " _ " / " – " / " — "; trim to the separator char.
    const separator = match[0].trim();
    return { left, right, separator };
}

/**
 * Derive a display title (and, when available, an artist) from a bare filename
 * stem — the extension-stripped basename, or an existing DB `title` that was
 * itself filename-derived by an earlier scan.
 *
 * Prefers the `{Artist} - {Title}` split so the artist isn't swallowed into the
 * title; otherwise returns the underscore-normalized, track-number-stripped
 * stem. This is the single shared derivation used by both the scanner's tag
 * fallback and the underscore-title backfill so the two never drift.
 */
export function deriveDisplayFromStem(stem: string): { title: string; artist?: string } {
    const split = parseArtistTitleFromStem(stem);
    if (split) return { title: split.right, artist: split.left };
    const normalized = normalizeUnderscoreStem(stem);
    const stripped = normalized.replace(TRACK_NUMBER_PREFIX, '').trim();
    return { title: stripped || normalized };
}

/**
 * Derive the primary artist name for an audio file, with graceful fallback.
 *
 * Priority:
 *   1. ID3 `albumArtist` tag
 *   2. ID3 `artist` tag
 *   3. Filename `{Artist} - {Title}` — used only when the folder parent does
 *      NOT match either side (indicating a compilation folder like
 *      `/Music/UserName/MixedPlaylist/...`).
 *   4. Folder parent of the album directory (standard `/Artist/Album/Track`
 *      convention — the Plex/Jellyfin layout).
 *   5. `'Unknown Artist'` — last resort.
 *
 * When the filename splits AND the folder matches one side, the folder wins
 * (high confidence: the folder IS the artist folder; the filename repeats
 * the same info). When the folder matches neither side, the folder is likely
 * not an artist at all, so the filename's first part is used instead.
 */
/**
 * Ingest-side check: like `isVariousArtistsName` but ALSO returns true for
 * empty/whitespace-only names. Used during scanning to avoid creating bogus
 * artist rows when a tag is missing entirely (treated as "unknown / probably
 * compilation"). Runtime/recommendation paths should use `isVariousArtistsName`.
 */
export function isCompilationArtistName(name: string): boolean {
    const trimmed = name.trim();
    if (trimmed.length === 0) return true;
    return isVariousArtistsName(trimmed);
}

/** True when `dir` lies strictly below `libraryRoot` (always true without a root). */
function isInsideLibraryRoot(dir: string, libraryRoot: string | undefined): boolean {
    if (!libraryRoot) return true;
    const root = path.resolve(libraryRoot);
    const rel = path.relative(root, path.resolve(dir));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function deriveArtistName(params: {
    tagAlbumArtist?: string | null;
    tagArtist?: string | null;
    filePath: string;
    albumDir: string;
    /**
     * The library path the file is under. A folder at or above it is never
     * an artist folder: without this, `/music/Album/01.mp3` became artist
     * "music". Omit only where no library root is known.
     */
    libraryRoot?: string;
}): string {
    // Album-artist tag is the canonical album-level artist when present.
    const albumArtistTag = params.tagAlbumArtist?.trim();
    if (albumArtistTag) {
        return isVariousArtistsName(albumArtistTag) ? VARIOUS_ARTISTS_LABEL : albumArtistTag;
    }

    // Folder convention: /<library>/<Artist>/<Album>/<Track> puts the
    // album-level artist (or compilation curator) one level above the album
    // dir. Trust it over per-track ARTIST tags and filename splits — on
    // compilations those vary track-to-track and would fragment the album
    // into one hierarchy per track artist. Each track's own ARTIST tag is
    // still captured separately by `ensureTrackArtistLinks` →
    // `custom_metadata.additional_artist_ids` so the track still surfaces
    // when browsing the per-track artist.
    const artistDir = path.dirname(params.albumDir);
    const folderArtist = isInsideLibraryRoot(artistDir, params.libraryRoot)
        ? spaceUnderscoreWords(path.basename(artistDir).trim()) || null
        : null;
    if (folderArtist) {
        return isVariousArtistsName(folderArtist) ? VARIOUS_ARTISTS_LABEL : folderArtist;
    }

    // No folder context (file at library root with no /Artist/ subfolder).
    // Fall back to per-track ARTIST tag, then filename split, then unknown.
    const artistTag = params.tagArtist?.trim();
    if (artistTag) {
        return isVariousArtistsName(artistTag) ? VARIOUS_ARTISTS_LABEL : artistTag;
    }

    const filenameParts = parseArtistTitleFromFilename(params.filePath);
    if (filenameParts) {
        const left = spaceUnderscoreWords(filenameParts.left);
        return isVariousArtistsName(left) ? VARIOUS_ARTISTS_LABEL : left;
    }

    return 'Unknown Artist';
}

const LRC_TIMESTAMP_PATTERN = /^\[\d{1,3}:\d{2}(?:\.\d{2,3})?\]/m;

export interface SidecarLyricsResult {
    plain: string | null;
    synced: string | null;
    format: 'lrc' | 'plain';
    source: 'file';
    /**
     * Absolute path of the sidecar file that was read. Persisted so a later
     * scan can detect an in-place edit (mtime change) of the same file, and
     * tell an alongside sidecar apart from a central-dir one.
     */
    sidecarPath: string;
    /** mtime of {@link sidecarPath} in epoch milliseconds at read time. */
    sidecarMtimeMs: number;
}

/**
 * stat() a sidecar file for its mtime in epoch ms. Returns 0 when the file
 * can't be stat'd (raced away, permission) — a 0 marker forces the next scan
 * to treat the stored path as needing a refresh rather than silently trusting
 * a missing mtime.
 */
async function sidecarMtimeMs(filePath: string): Promise<number> {
    try {
        return Math.floor((await safeStat(filePath)).mtimeMs);
    } catch {
        return 0;
    }
}

/**
 * Discover and parse sidecar lyrics files (.lrc or .txt).
 *
 * Probes both alongside-media and central locations regardless of the
 * METADATA_STORAGE_LOCATION setting, so lyrics are always found even if
 * the strategy changes.
 *
 * Checks .lrc first (always treated as synced LRC format), then falls
 * back to .txt (auto-detected as LRC if it contains timestamp tags).
 *
 * @param trackFilePath - Absolute path to the audio track file
 * @returns Parsed lyrics result or null if no sidecar file is found
 */
/** Lyrics are text; a larger sidecar is not lyrics. */
const MAX_LYRICS_SIDECAR_BYTES = 2 * 1024 * 1024;

export async function findSidecarLyrics(
    trackFilePath: string,
): Promise<SidecarLyricsResult | null> {
    const stem = path.basename(trackFilePath, path.extname(trackFilePath));
    const central = lyricsCentralDir(trackFilePath);

    // Try .lrc first (probing both locations)
    const lrcPath = await resolveReadPath({
        mediaFilePath: trackFilePath,
        centralDir: central,
        fileName: `${stem}.lrc`,
    });
    if (lrcPath) {
        try {
            const content = (
                await readContainedFile(lrcPath, { maxBytes: MAX_LYRICS_SIDECAR_BYTES })
            )
                .toString('utf-8')
                // Postgres rejects 0x00 in jsonb text (22021).
                .replace(/\0/g, '');
            if (content.trim()) {
                const parsed = parseLRC(content);
                const syncedText = parsed.lines.length > 0 ? content : null;
                const plainText = parsed.lines.map((l) => l.text).join('\n') || content;
                return {
                    plain: plainText,
                    synced: syncedText,
                    format: 'lrc',
                    source: 'file',
                    sidecarPath: lrcPath,
                    sidecarMtimeMs: await sidecarMtimeMs(lrcPath),
                };
            }
        } catch {
            // File disappeared between exists check and read — fall through
        }
    }

    // Try .txt (probing both locations)
    const txtPath = await resolveReadPath({
        mediaFilePath: trackFilePath,
        centralDir: central,
        fileName: `${stem}.txt`,
    });
    if (txtPath) {
        try {
            const content = (
                await readContainedFile(txtPath, { maxBytes: MAX_LYRICS_SIDECAR_BYTES })
            )
                .toString('utf-8')
                // Postgres rejects 0x00 in jsonb text (22021).
                .replace(/\0/g, '');
            if (content.trim()) {
                const mtimeMs = await sidecarMtimeMs(txtPath);
                if (LRC_TIMESTAMP_PATTERN.test(content)) {
                    const parsed = parseLRC(content);
                    const syncedText = parsed.lines.length > 0 ? content : null;
                    const plainText = parsed.lines.map((l) => l.text).join('\n') || content;
                    return {
                        plain: plainText,
                        synced: syncedText,
                        format: 'lrc',
                        source: 'file',
                        sidecarPath: txtPath,
                        sidecarMtimeMs: mtimeMs,
                    };
                }
                return {
                    plain: content,
                    synced: null,
                    format: 'plain',
                    source: 'file',
                    sidecarPath: txtPath,
                    sidecarMtimeMs: mtimeMs,
                };
            }
        } catch {
            // File disappeared between exists check and read — fall through
        }
    }

    return null;
}

/**
 * Write lyrics as a sidecar file.
 * Respects METADATA_STORAGE_LOCATION for where to write.
 * Writes .lrc if synced lyrics are available, .txt for plain-only.
 * Does NOT overwrite existing files (checks both locations).
 */
export async function writeLyricsSidecar(
    trackFilePath: string,
    lyrics: { synced?: string | null; plain?: string | null },
): Promise<string | null> {
    const stem = path.basename(trackFilePath, path.extname(trackFilePath));
    const central = lyricsCentralDir(trackFilePath);

    if (lyrics.synced) {
        // Don't overwrite if .lrc exists in either location
        if (
            await resolveReadPath({
                mediaFilePath: trackFilePath,
                centralDir: central,
                fileName: `${stem}.lrc`,
            })
        ) {
            return null;
        }
        const result = await resolveWritePath({
            mediaFilePath: trackFilePath,
            centralDir: central,
            fileName: `${stem}.lrc`,
        });
        await safeMkdir(path.dirname(result.filePath), { recursive: true });
        try {
            // safe-fs has no `flag: 'wx'` (exclusive-create) wrapper, so route this
            // raw write through withFsGuard directly — same pattern as
            // audio-tag-parser.ts's parseFile call — to keep it under the global
            // fs concurrency cap/timeout without adding a one-off safe-fs export.
            await withFsGuard(
                () =>
                    fsWriteFile(result.filePath, lyrics.synced!, { encoding: 'utf-8', flag: 'wx' }),
                'writeFile',
                result.filePath,
            );
            return result.filePath;
        } catch (err) {
            if (getErrorCode(err) === 'EEXIST') return null;
            throw err;
        }
    }

    if (lyrics.plain) {
        // Don't write .txt if .lrc already exists in either location
        if (
            await resolveReadPath({
                mediaFilePath: trackFilePath,
                centralDir: central,
                fileName: `${stem}.lrc`,
            })
        ) {
            return null;
        }
        // Don't overwrite if .txt exists in either location
        if (
            await resolveReadPath({
                mediaFilePath: trackFilePath,
                centralDir: central,
                fileName: `${stem}.txt`,
            })
        ) {
            return null;
        }
        const result = await resolveWritePath({
            mediaFilePath: trackFilePath,
            centralDir: central,
            fileName: `${stem}.txt`,
        });
        await safeMkdir(path.dirname(result.filePath), { recursive: true });
        try {
            await withFsGuard(
                () =>
                    fsWriteFile(result.filePath, lyrics.plain!, { encoding: 'utf-8', flag: 'wx' }),
                'writeFile',
                result.filePath,
            );
            return result.filePath;
        } catch (err) {
            if (getErrorCode(err) === 'EEXIST') return null;
            throw err;
        }
    }

    return null;
}
