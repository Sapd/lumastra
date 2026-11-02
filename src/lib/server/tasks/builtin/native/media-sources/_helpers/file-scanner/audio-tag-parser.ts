// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audio Tag Parser
 *
 * Parses audio file tags using the music-metadata library.
 * Supports ID3 (MP3), Vorbis (FLAC/OGG/OPUS), and MP4/AAC container tags.
 *
 * Gracefully handles missing or partial tags — all fields are optional.
 */

import path from 'node:path';
import { parseFile } from 'music-metadata';
import type { IAudioMetadata, ILyricsTag } from 'music-metadata';
import { withFsGuard } from '$lib/server/utils/safe-fs.js';
import { clampTagText } from '$lib/server/utils/tag-text.js';
import { readFlacVorbisCommentsRaw } from './vorbis-raw-reader.js';
import { mergeSlashSplitCredits } from './artist-credit.js';
import {
    parseArtistTitleFromFilename,
    normalizeUnderscoreStem,
    cleanUnderscoreSeparators,
    spaceUnderscoreWords,
    stripTrackNumberFromArtistTag,
} from '../../../../../../utils/music-scanner-utils.js';

export interface AudioTagResult {
    title?: string;
    /**
     * True when `title` is NOT the file's own title tag but was derived from the
     * file name (`deriveFromFilename`: the `{Artist} - {Title}` split or the
     * track-number-stripped stem). Read it through {@link trackTitleSource},
     * which also covers the scanner's own blank-title fallback.
     */
    titleFromFilename?: boolean;
    artist?: string;
    albumArtist?: string;
    compilation?: boolean;
    musicbrainzAlbumArtistIds?: string[];
    /**
     * Populated when the underlying parseFile call could not complete — the
     * tag parser hit our 30s timeout, threw on a corrupt file, or the scan
     * was cancelled mid-parse. Callers MUST check this before creating a
     * track row, because the other fields will be filename-derived
     * fallbacks ("14-artist-title.flac" → title="14-artist-title") that
     * masquerade as real metadata. Creating tracks from those fallbacks
     * floods the catalog with garbage that orphan cleanup then dismisses
     * on every subsequent scan — observed on preprod with 417 duplicate
     * "secal-désenchantée" rows from a single FLAC that timed out.
     *
     * `'aborted'` means cancel — the file was not actually problematic;
     * `'timeout'` and `'corrupt'` indicate the file itself is broken
     * relative to the music-metadata parser.
     */
    parseError?: 'timeout' | 'corrupt' | 'aborted';
    /**
     * Artist name extracted from a `{Artist} - {Title}` (or `_`-separated)
     * filename split when no embedded ID3/Vorbis artist tag was present.
     * Lets the scanner populate per-track artist linkage on tag-less
     * compilation albums where each filename carries the real artist.
     */
    artistFromFilename?: string;
    /**
     * Multi-value track artist tag (Vorbis multiple ARTIST entries, ID3v2.4
     * null-separated TPE1, etc.). Set only when the tag actually carries more
     * than one entry — single-value tags stay on `artist` so callers can apply
     * the comma-split fallback.
     */
    artists?: string[];
    /** Multi-value album-artist tag — same rules as `artists`. */
    albumArtists?: string[];
    album?: string;
    barcode?: string;
    catalogueNumber?: string;
    trackNumber?: number;
    discNumber?: number;
    /**
     * Total disc count for the release (music-metadata `common.disk.of`). Only
     * surfaced when the tag carries a positive value — most single-disc rips
     * omit it. Persisted alongside `discNumber` so a future "Disc 1 of 2"
     * display doesn't need a re-scan; the AlbumModal disc headers themselves
     * only need `discNumber`.
     */
    discTotal?: number;
    year?: number;
    genre?: string[];
    duration?: number; // seconds
    codec?: string;
    sampleRate?: number;
    bitrate?: number;
    channels?: number;
    embeddedArt?: { format: string; data: Buffer } | undefined;
    lyrics?: string; // embedded lyrics (USLT/SYLT for MP3, LYRICS for FLAC)
    /**
     * MusicBrainz RECORDING id (not the release-track id — music-metadata
     * exposes that separately as `musicbrainz_trackid`). Sourced from FLAC
     * Vorbis `MUSICBRAINZ_TRACKID` / ID3v2 TXXX "MusicBrainz Track Id", both
     * of which music-metadata normalizes to `common.musicbrainz_recordingid`.
     * Lowercased and validated as a UUID shape before being surfaced here —
     * absent or malformed tag values are omitted entirely.
     */
    recordingMbid?: string;
    /** File-tag release evidence, kept separate from recording and release-group IDs. */
    releaseMbid?: string;
    releaseGroupMbid?: string;
    musicbrainzArtistIds?: string[];
    rawArtistTags?: {
        source: 'file';
        artist?: string;
        artists?: string[];
        album_artist?: string;
        album_artists?: string[];
        musicbrainz_artist_ids?: string[];
    };
}

/**
 * Loose UUID shape check (8-4-4-4-12 hex, case-insensitive) — not a strict
 * version/variant check, since MusicBrainz MBIDs are UUIDs but taggers don't
 * always preserve variant bits faithfully. Used to reject junk tag values.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract and validate the MusicBrainz recording id from music-metadata's
 * normalized `common.musicbrainz_recordingid` field. Handles both the
 * documented scalar shape and a defensive array shape (some taggers/parsers
 * emit multiple instances of the underlying tag). Returns the first
 * UUID-shaped, lowercased value, or undefined when absent/invalid.
 */
function extractRecordingMbid(raw: string | string[] | undefined): string | undefined {
    const candidates = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
    for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const trimmed = candidate.trim();
        if (UUID_SHAPE.test(trimmed)) return trimmed.toLowerCase();
    }
    return undefined;
}

/**
 * Strip a leading track number prefix from a filename stem.
 * Handles patterns like "01 - Title", "01. Title", "01 Title", "1 - Title".
 */
function stripTrackNumberPrefix(stem: string): string {
    return stem
        .replace(/^\d{1,3}\s*[-._]\s*/, '') // "01 - ", "01. ", "01_ "
        .replace(/^\d{1,3}\s+/, '') // "01 Title"
        .trim();
}

/**
 * Derive a display title (and possibly an artist) from a file path when no
 * tag is present. Tries the `{Artist} - {Title}` filename split first so the
 * artist isn't silently swallowed into the title; falls back to the
 * track-number-stripped stem when there's no usable split.
 */
function deriveFromFilename(filePath: string): {
    title: string;
    artist?: string;
} {
    const split = parseArtistTitleFromFilename(filePath);
    if (split) {
        return {
            title: spaceUnderscoreWords(split.right),
            artist: spaceUnderscoreWords(split.left),
        };
    }
    const ext = path.extname(filePath);
    // Normalize a stem where spaces were encoded as underscores before stripping
    // a track-number prefix, so a tag-less title reads with real spaces.
    const stem = normalizeUnderscoreStem(path.basename(filePath, ext));
    return { title: stripTrackNumberPrefix(stem) || stem };
}

/**
 * Where a scanned track's title came from — the value the scanner stores in
 * `media_items.title_source` next to every track title it writes.
 *
 * `'tag'` only when the file carried a non-blank title tag. Anything else is a
 * filename fallback: `deriveFromFilename` here, or the scanner's own fallbacks
 * when this parser hands back a blank title (the insert path's
 * `normalizeUnderscoreStem` stem, the re-scan's bare basename).
 */
export function trackTitleSource(
    tags: Pick<AudioTagResult, 'title' | 'titleFromFilename'>,
): 'tag' | 'filename' {
    return tags.title?.trim() && tags.titleFromFilename !== true ? 'tag' : 'filename';
}

/**
 * Normalize raw genre tag strings into clean individual genre names.
 *
 * ID3 genre tags are notoriously inconsistent across taggers:
 * - Semicolon-delimited: "Electronic;Trance;House"
 * - Slash-delimited:     "Rock / Metal"
 * - Comma-delimited:     "Pop, Dance, Synth-Pop"
 * - Null-byte separated: "Electronic\0Trance"  (old taggers)
 * - ID3v1 numeric codes: "(52)Electronic" or "(52)"
 * - Mixed:               "Rock;(52)Electronic / House"
 *
 * Returns deduplicated, trimmed genre names or undefined if none remain.
 */
function normalizeGenreTags(raw: string[]): string[] | undefined {
    const genres = raw
        .filter(Boolean)
        // Split on common delimiters: semicolons, slashes, commas, null bytes
        .flatMap((g) => g.split(/[;/,\0]/))
        .map((g) => g.trim())
        // Strip ID3v1 numeric genre codes like "(52)" prefix
        .map((g) => g.replace(/^\(\d+\)\s*/, ''))
        .map((g) => g.trim())
        .filter(Boolean);

    // Deduplicate (case-insensitive, keep first occurrence's casing)
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const g of genres) {
        const key = g.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(g);
        }
    }

    return unique.length > 0 ? unique : undefined;
}

/**
 * Split a tag value on NUL into trimmed, non-empty parts.
 *
 * ID3v2.3 has no multi-value frames, so taggers such as Mp3tag write several
 * values into one frame separated by NUL. music-metadata only splits those
 * for ID3v2.4, so v2.3 values reach us with raw NULs, and Postgres rejects
 * 0x00 in text (error 22021). Splitting here gives v2.3 the same shape v2.4
 * already has. Each UTF-16 part carries its own BOM at its start; trim()
 * strips it (U+FEFF is ECMAScript whitespace).
 */
function splitNulValues(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split('\0')
        .map((part) => part.trim())
        .filter(Boolean);
}

/** First non-empty NUL-separated part of a scalar tag (ID3v2.4 semantics). */
function firstNulValue(value: string | undefined): string | undefined {
    return splitNulValues(value)[0];
}

/**
 * Scalar credit plus its array: all NUL-split parts. The scalar joins the
 * list only when it was itself NUL-separated; a plain scalar is the joined
 * display form of the array ("A & B") and would add a bogus extra entry.
 * Pieces of a name music-metadata cut at an ID3v2.3 "/" are re-joined
 * (`mergeSlashSplitCredits`).
 */
function splitCreditValues(
    scalar: string | undefined,
    array: string[] | undefined,
): { first: string | undefined; all: string[] } {
    const scalarParts = splitNulValues(scalar);
    const splitParts = (array ?? []).flatMap((v) => splitNulValues(v));
    const arrayParts = mergeSlashSplitCredits(splitParts);
    // ID3v2.3 slash split: the scalar is the first piece, so it was cut too.
    const first =
        scalarParts.length === 1 &&
        arrayParts.length < splitParts.length &&
        scalarParts[0] === splitParts[0]
            ? arrayParts[0]
            : scalarParts[0];
    return {
        first,
        all: scalarParts.length > 1 ? [...scalarParts, ...arrayParts] : arrayParts,
    };
}

/**
 * Trim, drop empties, and dedupe (case-insensitive) a multi-value tag array.
 * Returns undefined when fewer than two entries survive — single entries are
 * already covered by the scalar tag fields.
 */
function pickMultiValueTag(raw: string[] | undefined): string[] | undefined {
    if (!raw || raw.length === 0) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
    }
    return out.length > 1 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Mojibake recovery for FLAC tags
// ---------------------------------------------------------------------------

const REPLACEMENT_CHAR = '�';

export function hasReplacementChar(value: unknown): boolean {
    return typeof value === 'string' && value.includes(REPLACEMENT_CHAR);
}

/**
 * Decode a buffer using the Windows-1252 codepage. Every byte 0x00-0xFF maps
 * to a printable codepoint, so this never produces U+FFFD — the recovered
 * string may not match the artist's intent if the original encoding was
 * something else (Shift_JIS, etc.), but it's a strict improvement over
 * persisting the question-mark glyph.
 */
function decodeAsCp1252(buf: Buffer): string {
    return new TextDecoder('windows-1252', { fatal: false }).decode(buf);
}

/**
 * If `parsed` contains the U+FFFD replacement character, attempt to recover
 * the original text by re-decoding the corresponding raw Vorbis bytes as
 * Windows-1252. Returns the parsed value unchanged when no recovery is
 * needed or possible.
 *
 * Why: Vorbis comments are required to be UTF-8 by spec, but old Windows-
 * based rippers (early-2010s dBpoweramp / EAC presets) wrote raw CP-1252
 * bytes anyway. music-metadata's strict UTF-8 decoder substitutes U+FFFD
 * for every invalid byte, losing the original. Re-reading the raw block
 * bytes lets us decode the offending fields as CP-1252 and recover them.
 */
function recoverField(
    parsed: string | undefined,
    rawBytes: Buffer[] | undefined,
): string | undefined {
    if (!hasReplacementChar(parsed)) return parsed;
    if (!rawBytes || rawBytes.length === 0) return parsed;
    // Scalar recovery uses the first instance — covers the common case where
    // music-metadata's scalar field surfaces only the first multi-value entry.
    // A NUL-packed value ("A\0B") keeps its first part, matching the parsed
    // path; Postgres rejects text containing 0x00, which would crash the scan
    // if the recovered value reached an UPDATE.
    const recovered = firstNulValue(decodeAsCp1252(rawBytes[0]));
    if (!recovered || hasReplacementChar(recovered)) return parsed;
    return recovered;
}

interface RecoverableFields {
    title?: string;
    artist?: string;
    albumArtist?: string;
    album?: string;
    artists?: string[];
    albumArtists?: string[];
}

/**
 * Walks a set of parsed text fields, re-reading raw Vorbis bytes for any
 * that contain U+FFFD. No-op for non-FLAC files (OGG/OPUS use the same
 * Vorbis comment structure but inside Ogg pages — extend later if needed).
 */
async function recoverMojibakeFromFlac(
    filePath: string,
    fields: RecoverableFields,
): Promise<RecoverableFields> {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.flac') return fields;

    const needsRecovery =
        hasReplacementChar(fields.title) ||
        hasReplacementChar(fields.artist) ||
        hasReplacementChar(fields.albumArtist) ||
        hasReplacementChar(fields.album) ||
        fields.artists?.some(hasReplacementChar) ||
        fields.albumArtists?.some(hasReplacementChar);
    if (!needsRecovery) return fields;

    const raw = await readFlacVorbisCommentsRaw(filePath);
    if (!raw) return fields;

    // Decode each Vorbis comment instance independently so multi-valued tags
    // survive mojibake recovery. Also splits on NUL inside a single instance
    // — older taggers sometimes pack a multi-value list into one comment
    // separated by NUL bytes rather than emitting separate instances.
    const recoverList = (
        values: string[] | undefined,
        rawBytesForKey: Buffer[] | undefined,
    ): string[] | undefined => {
        if (!values) return values;
        if (!values.some(hasReplacementChar)) return values;
        if (!rawBytesForKey || rawBytesForKey.length === 0) return values;
        const recovered: string[] = [];
        for (const buf of rawBytesForKey) {
            const decoded = decodeAsCp1252(buf).trim();
            if (!decoded || hasReplacementChar(decoded)) continue;
            for (const part of decoded
                .split('\0')
                .map((s) => s.trim())
                .filter(Boolean)) {
                recovered.push(part);
            }
        }
        return recovered.length > 0 ? recovered : values;
    };

    return {
        title: recoverField(fields.title, raw.get('TITLE')),
        artist: recoverField(fields.artist, raw.get('ARTIST')),
        albumArtist: recoverField(fields.albumArtist, raw.get('ALBUMARTIST')),
        album: recoverField(fields.album, raw.get('ALBUM')),
        artists: recoverList(fields.artists, raw.get('ARTIST')),
        albumArtists: recoverList(fields.albumArtists, raw.get('ALBUMARTIST')),
    };
}

/**
 * Default timeout for the underlying `parseFile` call. NFS reads can stall
 * indefinitely when the mount loses its server; without a hard ceiling the
 * promise never resolves and the worker job's heartbeat goes dark. The
 * timeout reaches into the catch path of `parseAudioTags`, which already
 * treats parse failures as "empty result" + filename-derived fallback —
 * exactly the right outcome when a file can't be read.
 */
export const PARSE_FILE_TIMEOUT_MS = 30_000;

export interface SafeParseFileOptions {
    skipCovers?: boolean;
    /** Override the timeout (ms). Used by tests to assert timeout behavior. */
    timeoutMs?: number;
    /** Abort the parse early if the surrounding task is cancelled. */
    signal?: AbortSignal;
}

/**
 * Wrapper around music-metadata's parseFile that normalises every failure
 * mode into a single rejection and enforces a hard timeout so a stalled FS
 * read can't wedge the worker.
 *
 * Corrupt audio files can trigger a RangeError in strtok3's tokenizer
 * ("ignore length must be ≥ 0 bytes"). On the currently pinned music-metadata
 * (11.x) / strtok3 (10.x), `parseFile` reads via the random-access `fromFile`
 * tokenizer and that RangeError is thrown from an `async` method
 * (`AbstractTokenizer.ignore`), so it surfaces as a normal PROMISE REJECTION —
 * caught locally by the `.catch` below and turned into a rejection here. It
 * never escapes to the process.
 *
 * Historical note: an older strtok3 stream path let this RangeError escape as
 * a process-global `uncaughtException`, crashing the worker, so this wrapper
 * used to install a per-call `uncaughtException` listener to intercept it.
 * That listener was removed because it was (a) redundant — the error now
 * rejects normally and is caught locally; (b) redundant with the process-level
 * `uncaughtException` backstop in `hooks.server.ts` (log-and-continue), which
 * did not exist when the listener was first added; and (c) racy — being
 * process-global rather than call-scoped, under CONCURRENT parses one file's
 * escaped error could settle a DIFFERENT parse's promise. If a future
 * dependency bump reintroduces an escaping uncaught error, the hooks.server.ts
 * backstop still prevents the crash and the timeout below bounds the stall
 * (callers then take the empty-tag fallback) — no mis-routing, no crash.
 *
 * Timeout / abort behavior: rejects with `Error` if `parseFile` takes longer
 * than `timeoutMs` (default `PARSE_FILE_TIMEOUT_MS`) or if `signal` aborts.
 * Callers (`parseAudioTags`) already swallow rejections into the empty-tag
 * fallback path.
 */
export async function safeParseFile(
    filePath: string,
    options: SafeParseFileOptions = {},
): Promise<IAudioMetadata> {
    const timeoutMs = options.timeoutMs ?? PARSE_FILE_TIMEOUT_MS;
    const signal = options.signal;

    return new Promise<IAudioMetadata>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let abortListener: (() => void) | null = null;

        const cleanup = (): void => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (abortListener && signal) {
                signal.removeEventListener('abort', abortListener);
                abortListener = null;
            }
        };

        const settle = (err: Error | null, value?: IAudioMetadata): void => {
            if (settled) return;
            settled = true;
            cleanup();
            if (err) reject(err);
            else resolve(value as IAudioMetadata);
        };

        // Honor pre-aborted signals before scheduling the timer or call.
        if (signal?.aborted) {
            settle(new Error('parseFile aborted'));
            return;
        }

        timer = setTimeout(() => {
            settle(new Error(`parseFile timed out after ${timeoutMs}ms: ${filePath}`));
        }, timeoutMs);

        if (signal) {
            abortListener = (): void => {
                settle(new Error('parseFile aborted'));
            };
            signal.addEventListener('abort', abortListener, { once: true });
        }

        // Route parseFile through the global fs guard: music-metadata reads the
        // file (raw fs internally) so a stalled NFS read here used to pin a libuv
        // threadpool thread UNCOUNTED by safe-fs — enough concurrent stalled
        // parses starved getaddrinfo/DB and reproduced the CONNECT_TIMEOUT wedge
        // (F1). The guard holds its permit until parseFile truly settles, so at
        // most `LUMASTRA_FS_MAX_CONCURRENCY` parses can occupy threads at once,
        // and the hand-rolled timer/abort above still fails the caller fast.
        withFsGuard(
            () =>
                parseFile(filePath, {
                    duration: true,
                    skipCovers: options.skipCovers ?? false,
                    includeChapters: false,
                }),
            'parseFile',
            filePath,
            timeoutMs,
        )
            .then((result) => settle(null, result))
            .catch((err: unknown) => settle(err instanceof Error ? err : new Error(String(err))));
    });
}

export interface ParseAudioTagsOptions {
    skipCovers?: boolean;
    /**
     * Forward the task's abort signal into the underlying `parseFile` call so a
     * cancelled scan stops waiting on a stalled NFS read. Optional — omitting
     * preserves the original blocking behavior, but task callers should pass
     * `ctx.signal` so the worker can exit cleanly on cancel.
     */
    signal?: AbortSignal;
}

/**
 * Parse audio file tags from the given path.
 *
 * Returns an AudioTagResult with all available metadata.
 * Never throws — errors are returned as an empty result.
 */
export async function parseAudioTags(
    filePath: string,
    options: ParseAudioTagsOptions = {},
): Promise<AudioTagResult> {
    let meta: IAudioMetadata;
    try {
        meta = await safeParseFile(filePath, {
            signal: options.signal,
            skipCovers: options.skipCovers,
        });
    } catch (err) {
        // Surface the failure reason so callers can decide whether to skip
        // the file rather than silently create a track row from the
        // filename-derived fallback. See AudioTagResult.parseError docs for
        // the why — the previous swallow-and-fallback behaviour produced
        // hundreds of duplicate rows on every scan for files that
        // music-metadata persistently fails to parse.
        const msg = err instanceof Error ? err.message : String(err);
        const parseError: AudioTagResult['parseError'] = msg.includes('aborted')
            ? 'aborted'
            : msg.includes('timed out')
              ? 'timeout'
              : 'corrupt';
        const fallback = deriveFromFilename(filePath);
        return {
            title: fallback.title,
            titleFromFilename: true,
            artistFromFilename: fallback.artist,
            parseError,
        };
    }

    const common = meta.common;
    const format = meta.format;

    // Prefer albumartist for artist identity (avoids "Various Artists" per-track fragmentation).
    // Empty / whitespace-only tag values are normalized to undefined so they
    // don't preempt the filename-derived fallback downstream — many real-world
    // taggers write blank TPE1/ARTIST frames when fields are unset, and a blank
    // string carries no usable artist data.
    const artistParts = splitCreditValues(common.artist, common.artists);
    const albumArtistParts = splitCreditValues(common.albumartist, common.albumartists);
    let artist = artistParts.first;
    let albumArtist = albumArtistParts.first;

    // Multi-value tag arrays from music-metadata. These reflect properly-tagged
    // multi-value frames (Vorbis comments with multiple ARTIST entries, ID3v2.4
    // null-separated TPE1, iTunes plists). Only surface when the array carries
    // more than one distinct, non-empty entry — single entries duplicate the
    // scalar fields and aren't useful here.
    let artists = pickMultiValueTag(artistParts.all);
    let albumArtists = pickMultiValueTag(albumArtistParts.all);
    let album = firstNulValue(common.album);
    let titleFromTag = firstNulValue(common.title);

    // MusicBrainz recording MBID — validated/lowercased; absent when the tag
    // is missing or doesn't look like a UUID.
    const recordingMbid = extractRecordingMbid(
        common.musicbrainz_recordingid as string | string[] | undefined,
    );

    // Mojibake recovery: if any text field has U+FFFD, the source file used a
    // non-UTF-8 codepage in its Vorbis comment. Re-read the raw bytes and
    // decode as Windows-1252 to recover. No-op when nothing needs recovering.
    const recovered = await recoverMojibakeFromFlac(filePath, {
        title: titleFromTag,
        artist,
        albumArtist,
        album,
        artists,
        albumArtists,
    });
    titleFromTag = recovered.title;
    artist = recovered.artist;
    albumArtist = recovered.albumArtist;
    album = recovered.album;
    artists = recovered.artists;
    albumArtists = recovered.albumArtists;

    // Tag frames can be megabytes of whitespace (and mojibake recovery re-reads
    // the raw bytes): bound every string here, once, so the regexes that split
    // credits and clean titles downstream only ever see short text.
    artist = artist && clampTagText(artist);
    albumArtist = albumArtist && clampTagText(albumArtist);
    album = album && clampTagText(album);
    titleFromTag = titleFromTag && clampTagText(titleFromTag);
    artists = artists?.map(clampTagText);
    albumArtists = albumArtists?.map(clampTagText);

    // Preserve decoded, bounded evidence before scanner cleanup changes spelling.
    const rawIds = common.musicbrainz_artistid;
    const parsedArtistIds = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : [])
        .slice(0, 64)
        .map((id) => extractRecordingMbid(id));
    // Dropping an invalid middle value would shift every subsequent identity.
    const musicbrainzArtistIds = parsedArtistIds.every((id) => id !== undefined)
        ? parsedArtistIds.filter((id): id is string => id !== undefined)
        : [];
    const rawArtistTags: NonNullable<AudioTagResult['rawArtistTags']> = {
        source: 'file',
        artist,
        artists: artists?.slice(0, 64),
        album_artist: albumArtist,
        album_artists: albumArtists?.slice(0, 64),
        musicbrainz_artist_ids: musicbrainzArtistIds,
    };

    // Rippers that write "Corin_Vale" / "Hold_The_Signal" into the tags:
    // spaces back before the credit splitter sees "NVX_feat_Orrin", and before
    // the artist/album lookup, which would otherwise make a second row next to
    // an existing "Corin Vale".
    // Scene rippers also put the track number in front of the artist
    // ("09-Corin_Vale"); the file name must confirm it (see the helper).
    const nameOf = (v: string): string =>
        spaceUnderscoreWords(stripTrackNumberFromArtistTag(v, { filePath }));
    artist = artist && nameOf(artist);
    albumArtist = albumArtist && nameOf(albumArtist);
    album = album && spaceUnderscoreWords(album);
    titleFromTag = titleFromTag && spaceUnderscoreWords(titleFromTag);
    artists = artists?.map(nameOf);
    albumArtists = albumArtists?.map(nameOf);

    // Track number: music-metadata exposes as { no, of }
    const trackNumber =
        typeof common.track?.no === 'number' && common.track.no > 0 ? common.track.no : undefined;

    const discNumber =
        typeof common.disk?.no === 'number' && common.disk.no > 0 ? common.disk.no : undefined;

    const discTotal =
        typeof common.disk?.of === 'number' && common.disk.of > 0 ? common.disk.of : undefined;

    // Duration from format stream (most reliable source)
    const duration =
        typeof format.duration === 'number' && format.duration > 0
            ? Math.round(format.duration)
            : undefined;

    // Bitrate: music-metadata returns bits/sec; convert to kbps
    const bitrate =
        typeof format.bitrate === 'number' && format.bitrate > 0
            ? Math.round(format.bitrate / 1000)
            : undefined;

    // Embedded album art — take the first picture
    let embeddedArt: AudioTagResult['embeddedArt'];
    if (common.picture && common.picture.length > 0) {
        const pic = common.picture[0];
        if (pic && pic.data && pic.format) {
            embeddedArt = {
                format: pic.format,
                data: Buffer.from(pic.data),
            };
        }
    }

    // Embedded lyrics — ILyricsTag.text holds the unsynchronised lyrics string.
    let lyrics: string | undefined;
    if (common.lyrics && common.lyrics.length > 0) {
        const firstLyric: ILyricsTag | undefined = common.lyrics[0];
        const cleaned = firstLyric?.text?.replace(/\0+/g, '\n').trim();
        if (cleaned) {
            lyrics = cleaned;
        }
    }

    // Title: use tag if present, otherwise derive from filename. The filename
    // derivation also surfaces an artist hint when the stem splits cleanly,
    // which the scanner uses to populate per-track artist linkage on tag-less
    // compilation albums.
    const fallback = titleFromTag ? null : deriveFromFilename(filePath);
    const title = cleanUnderscoreSeparators(titleFromTag || fallback?.title || '');
    const artistFromFilename = !artist && !albumArtist ? fallback?.artist : undefined;

    return {
        title,
        titleFromFilename: fallback !== null,
        artist,
        albumArtist,
        artistFromFilename,
        artists,
        albumArtists,
        album,
        trackNumber,
        discNumber,
        discTotal,
        year:
            typeof common.year === 'number' && common.year > 0
                ? common.year > 9999
                    ? parseInt(String(common.year).slice(0, 4), 10)
                    : common.year
                : undefined,
        genre:
            common.genre && common.genre.length > 0 ? normalizeGenreTags(common.genre) : undefined,
        duration,
        codec: format.codec?.replace(/\0/g, '') || undefined,
        sampleRate:
            typeof format.sampleRate === 'number' && format.sampleRate > 0
                ? format.sampleRate
                : undefined,
        bitrate,
        channels:
            typeof format.numberOfChannels === 'number' && format.numberOfChannels > 0
                ? format.numberOfChannels
                : undefined,
        barcode:
            releaseTagText(common.barcode) ?? nativeReleaseTag(meta, ['BARCODE', 'UPC', 'EAN']),
        catalogueNumber:
            releaseTagText(common.catalognumber) ??
            nativeReleaseTag(meta, ['CATALOG#', 'CATALOGNUMBER', 'CATALOGUE NUMBER', 'CATNO']),
        embeddedArt,
        lyrics,
        recordingMbid,
        releaseMbid: extractRecordingMbid(common.musicbrainz_albumid),
        releaseGroupMbid: extractRecordingMbid(common.musicbrainz_releasegroupid),
        musicbrainzArtistIds,
        compilation: common.compilation,
        musicbrainzAlbumArtistIds: common.musicbrainz_albumartistid
            ?.map((id) => id.toLowerCase())
            .filter((id) => UUID_SHAPE.test(id)),
        rawArtistTags,
    };
}

/** Keep release identifiers as text (leading zeroes and catalogue punctuation matter). */
function releaseTagText(value: unknown): string | undefined {
    if (Array.isArray(value)) {
        for (const entry of value) {
            const text = releaseTagText(entry);
            if (text) return text;
        }
        return undefined;
    }
    return typeof value === 'string'
        ? clampTagText(value).replace(/\0/g, '').trim() || undefined
        : undefined;
}
function nativeReleaseTag(meta: IAudioMetadata, names: string[]): string | undefined {
    for (const tags of Object.values(meta.native ?? {})) {
        for (const tag of tags) {
            const id = tag.id.toUpperCase().replace(/^TXXX:/, '');
            if (names.includes(id)) {
                const text = releaseTagText(tag.value);
                if (text) return text;
            }
        }
    }
    return undefined;
}
