// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Walk Directory Utility
 *
 * Recursively walks a directory and returns absolute paths of all media files.
 * Used by the file scanner plugin to discover video files in library paths.
 *
 * Exclusion rules (applied in order):
 *   1. Folders in EXCLUDED_FOLDER_NAMES are skipped entirely (extras, samples, VIDEO_TS…)
 *   2. Files with "sample" in the name are skipped
 *   3. Ignore files are applied (gitignore-style, per-directory). Two conventions
 *      are honored: `.lumastraignore` (Lumastra-native) and `.ignore`
 *      (Jellyfin/Emby). An EMPTY `.ignore` file skips the whole folder + subtree;
 *      a non-empty one is treated as gitignore-style patterns, like `.lumastraignore`.
 *
 * Returns empty array if the directory does not exist or cannot be read.
 * Non-media files (NFOs, images, subtitles) are silently ignored.
 */

import type { Dirent } from 'node:fs';
import { safeLstat, safeReaddir, safeRealpath, safeStat, FsTimeoutError } from './safe-fs.js';
import {
    ContainmentError,
    readContainedFile,
    resolveContainedFile,
    resolveContainedMediaFile,
} from './contained-fs.js';
import {
    join,
    extname,
    relative,
    basename,
    isAbsolute,
    sep,
    resolve as resolvePath,
} from 'node:path';
import { Logger } from './logger.js';
import {
    EXTRAS_FOLDER_MAP,
    ARTWORK_EXTENSIONS,
    artworkTypeFromStem,
    artworkStemRank,
    seasonArtworkFromStem,
    extraTypeFromFilename,
    parseExtraFilename,
} from './media-extras.js';
import type { ExtraType, ArtworkType } from './media-extras.js';

import {
    SUBTITLE_EXTENSIONS,
    LYRICS_SIDECAR_EXTENSIONS,
    AUDIO_EXTENSIONS,
    MEDIA_EXTENSIONS,
    isVendorExcludedName,
    isAppleDoubleSidecar,
    EXCLUDED_FOLDER_NAMES,
    SAMPLE_PATTERN,
    LUMASTRA_IGNORE_FILE,
    JELLYFIN_IGNORE_FILE,
    MAX_IGNORE_FILE_BYTES,
    MAX_IGNORE_PATTERN_LENGTH,
    MAX_IGNORE_PATTERNS_PER_FILE,
    MAX_ACCUMULATED_PATTERNS,
} from './media-file-kinds.js';

export {
    SUBTITLE_EXTENSIONS,
    LYRICS_SIDECAR_EXTENSIONS,
    isLyricsSidecar,
    AUDIO_EXTENSIONS,
    isAudioFile,
    MEDIA_EXTENSIONS,
    isAppleDoubleSidecar,
} from './media-file-kinds.js';

const logger = Logger.for('walkDirectory');

/** Maximum time to wait for a readdir call before giving up (e.g. stalled NFS/SMB mount). */
const READDIR_TIMEOUT_MS = 30_000;

/**
 * readdir with a timeout guard for network shares that may stall indefinitely.
 * Returns the directory entries on success, or throws on timeout/error.
 */
async function readdirWithTimeout(
    dirPath: string,
    options: { withFileTypes: true },
): Promise<Dirent[]> {
    // Route through the global fs guard so the walk is BOTH timeout-bounded AND
    // counted against the process-wide concurrency cap — a deep parallel walk over
    // a slow NFS mount can no longer fan out unbounded readdir/stat calls and
    // saturate the libuv threadpool (which would starve DNS/DB → CONNECT_TIMEOUT).
    void options; // entry types always returned by safeReaddir
    try {
        return await safeReaddir(dirPath, READDIR_TIMEOUT_MS);
    } catch (err) {
        // Preserve the legacy "readdir timeout:" sentinel that callers below
        // string-match on to mark the walk incomplete (hadErrors).
        if (err instanceof FsTimeoutError) {
            throw new Error(`readdir timeout: ${dirPath}`, { cause: err });
        }
        throw err;
    }
}

/**
 * Folder names every walker prunes without touching the filesystem: the fixed
 * set above plus vendor/junk/trickplay names. The artwork, subtitle and extras
 * passes must prune exactly like the main walk — they used to descend into all
 * ~72k Jellyfin trickplay folders of a TV library too.
 */
function isPrunedFolderName(name: string): boolean {
    return EXCLUDED_FOLDER_NAMES.has(name.toLowerCase()) || isVendorExcludedName(name);
}

/**
 * True when `name` is a primary video file — a media video that is neither a
 * sample nor a filename-suffix extra. Used to decide whether a folder's
 * filename-suffix extras (`Film-trailer.mkv`, `trailer.mp4`, …) actually have a
 * primary item to attach to. A folder holding ONLY suffix-named files (e.g. a
 * lone `MyFilm-short.mkv`) has no parent, so those files must NOT be treated as
 * extras — otherwise they'd be dropped from the main walk yet never linked.
 */
function isPrimaryVideoName(name: string): boolean {
    const ext = extname(name).toLowerCase();
    return (
        MEDIA_EXTENSIONS.has(ext) &&
        !SAMPLE_PATTERN.test(name) &&
        extraTypeFromFilename(name) === null
    );
}

/** True when any direct file entry in the folder is a primary video. Symlinks
 *  are counted by name — the main walk resolves symlinked media files, so the
 *  two passes must agree on what counts as a primary. */
function folderHasPrimaryVideo(entries: Dirent[]): boolean {
    return entries.some((e) => (e.isFile() || e.isSymbolicLink()) && isPrimaryVideoName(e.name));
}

/**
 * Among the folder's primary videos, pick the one a filename-suffix extra
 * belongs to: the primary whose stem is the LONGEST prefix of the extra's base
 * name (`B-trailer` → base `B` → `B.mkv`; `Best Movie (2019)-behindthescenes` →
 * `Best Movie (2019).mkv`). Returns the primary's file NAME, or undefined when
 * the base is empty (standalone `trailer.mp4`) or nothing matches.
 */
function matchPrimaryForExtra(entries: Dirent[], extraBaseName: string): string | undefined {
    const target = extraBaseName.toLowerCase();
    if (!target) return undefined;
    let best: { name: string; len: number } | undefined;
    for (const e of entries) {
        if (!(e.isFile() || e.isSymbolicLink()) || !isPrimaryVideoName(e.name)) continue;
        const stem = e.name.slice(0, e.name.length - extname(e.name).length).toLowerCase();
        if (stem && target.startsWith(stem) && (!best || stem.length > best.len)) {
            best = { name: e.name, len: stem.length };
        }
    }
    return best?.name;
}

// ---------------------------------------------------------------------------
// Ignore-file support (.lumastraignore + Jellyfin/Emby .ignore)
// ---------------------------------------------------------------------------

/**
 * Read an ignore file and return its meaningful lines — trimmed, with blank
 * lines and `#` comments removed. Returns [] when the file is absent or has no
 * meaningful lines.
 *
 * Pattern rules (subset of gitignore):
 *   - Lines starting with # are comments
 *   - * matches any sequence of characters within a path segment
 *   - Patterns without / are matched against the filename only
 *   - Patterns with / are matched against the path relative to the ignore file
 */
async function readIgnoreLines(
    filePath: string,
    rootPath: string,
): Promise<{ lines: string[]; meaningful: number } | null> {
    try {
        const content = (
            await readContainedFile(filePath, {
                extraRoots: [rootPath],
                maxBytes: MAX_IGNORE_FILE_BYTES,
            })
        ).toString('utf-8');
        const meaningfulLines = content
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'));
        // `meaningful` is counted BEFORE the length/count caps: a file holding
        // only over-long lines is not an empty `.ignore` skip marker.
        const kept = meaningfulLines
            .filter((l) => l.length <= MAX_IGNORE_PATTERN_LENGTH)
            .slice(0, MAX_IGNORE_PATTERNS_PER_FILE);
        if (kept.length < meaningfulLines.length) {
            logger.warn(
                `walkDirectory: ignore file "${filePath}" exceeds the pattern limits; ${meaningfulLines.length - kept.length} line(s) dropped`,
            );
        }
        return { lines: kept, meaningful: meaningfulLines.length };
    } catch (err) {
        // Fail CLOSED: a refused or unreadable ignore file (oversize, symlink out
        // of the library, FIFO, I/O error) must not silently expose what the
        // operator meant to hide; the caller skips the directory.
        logger.warn(
            `walkDirectory: cannot use ignore file "${filePath}" - skipping its directory`,
            { reason: err instanceof ContainmentError ? err.message : String(err) },
        );
        return null;
    }
}

interface DirIgnore {
    /** Accumulated gitignore-style patterns contributed by this directory's ignore files. */
    patterns: string[];
    /**
     * True when a Jellyfin-style empty `.ignore` marker is present in this
     * directory — the whole directory and its subtree must be skipped.
     */
    skipEntireDir: boolean;
    /** True when an ignore file could not be read: the directory is skipped (fail closed). */
    refused: boolean;
}

/**
 * Read the ignore files present in `dirPath` and return the patterns they
 * contribute plus whether the directory should be skipped wholesale.
 *
 * `presentNames` is the directory's file listing so we only attempt to read
 * ignore files that actually exist — avoiding a failed open() per directory on
 * large libraries / slow network mounts.
 *
 * Semantics:
 *   - `.lumastraignore` — pattern file only. Empty ⇒ no effect.
 *   - `.ignore`         — Jellyfin/Emby. Empty (no meaningful lines) ⇒
 *                          `skipEntireDir = true`; non-empty ⇒ its lines are
 *                          treated as gitignore-style patterns, same as
 *                          `.lumastraignore`.
 */
async function readDirIgnore(
    dirPath: string,
    presentNames: Set<string>,
    rootPath: string,
): Promise<DirIgnore> {
    const patterns: string[] = [];
    let skipEntireDir = false;
    let refused = false;

    if (presentNames.has(LUMASTRA_IGNORE_FILE)) {
        const read = await readIgnoreLines(join(dirPath, LUMASTRA_IGNORE_FILE), rootPath);
        if (read === null) refused = true;
        else patterns.push(...read.lines);
    }

    if (presentNames.has(JELLYFIN_IGNORE_FILE)) {
        const read = await readIgnoreLines(join(dirPath, JELLYFIN_IGNORE_FILE), rootPath);
        if (read === null) {
            refused = true;
        } else if (read.meaningful === 0) {
            // Empty (or comment/blank-only) `.ignore` marker → skip the folder.
            skipEntireDir = true;
        } else {
            patterns.push(...read.lines);
        }
    }

    return { patterns, skipEntireDir, refused };
}

type DirIgnoreOutcome =
    { action: 'refused' } | { action: 'skip' } | { action: 'walk'; local: string[] };

/**
 * What the walk does with a directory given its ignore files: fail closed on
 * an unreadable ignore file, skip a directory carrying an empty `.ignore`
 * marker, but never honor that marker at the library root (an empty marker
 * there would read as "every file was deleted" to stale cleanup).
 */
async function evaluateDirIgnore(
    dirPath: string,
    rootPath: string,
    presentNames: Set<string>,
): Promise<DirIgnoreOutcome> {
    const local = await readDirIgnore(dirPath, presentNames, rootPath);
    if (local.refused) return { action: 'refused' };
    if (local.skipEntireDir) {
        if (dirPath === rootPath) {
            logger.warn(
                `walkDirectory: refusing empty ".ignore" marker at library root "${dirPath}" - would exclude the entire library`,
            );
        } else {
            return { action: 'skip' };
        }
    }
    return { action: 'walk', local: local.patterns };
}

/**
 * Case-insensitive glob match where `*` matches any run of characters except
 * `/`, `?` matches exactly one character other than `/`, and every other
 * character is literal. Iterative with a single
 * backtrack point (the last `*`), so it is O(pattern x text) in the worst case
 * instead of the exponential blowup a `[^/]*` regex gets on `*a*a*a*b`.
 */
export function globMatches(pattern: string, text: string): boolean {
    const pat = pattern.toLowerCase();
    const str = text.toLowerCase();
    let p = 0;
    let t = 0;
    let starP = -1;
    let starT = 0;
    while (t < str.length) {
        if (p < pat.length && pat[p] === '*') {
            starP = p++;
            starT = t;
        } else if (p < pat.length && (pat[p] === str[t] || (pat[p] === '?' && str[t] !== '/'))) {
            p++;
            t++;
        } else if (starP >= 0 && str[starT] !== '/') {
            p = starP + 1;
            t = ++starT;
        } else {
            return false;
        }
    }
    while (p < pat.length && pat[p] === '*') p++;
    return p === pat.length;
}

/**
 * Returns true if the entry should be excluded based on the accumulated ignore patterns.
 * @param name     - bare filename or directory name
 * @param relPath  - path relative to the library root
 * @param patterns - accumulated patterns from all ignore files above this entry
 */
function isIgnored(name: string, relPath: string, patterns: string[]): boolean {
    const limit = Math.min(patterns.length, MAX_ACCUMULATED_PATTERNS);
    for (let i = 0; i < limit; i++) {
        const pattern = patterns[i];
        // Path-relative patterns match the path from the library root; the
        // rest match just the bare name.
        if (globMatches(pattern, pattern.includes('/') ? relPath : name)) return true;
    }
    return false;
}

type FileNameVerdict =
    | { ok: true; kind: 'media' | 'lyrics' }
    | { ok: false; reason: 'apple-double' | 'extension' | 'sample' | 'ignored' };

/** Name-only file rules shared by the bulk walk and {@link checkScannerEligibility}. */
function classifyFileName(name: string, relPath: string, patterns: string[]): FileNameVerdict {
    if (isAppleDoubleSidecar(name)) return { ok: false, reason: 'apple-double' };
    const ext = extname(name).toLowerCase();
    const isMedia = MEDIA_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext);
    const isLyrics = LYRICS_SIDECAR_EXTENSIONS.has(ext);
    if (!isMedia && !isLyrics) return { ok: false, reason: 'extension' };
    if (SAMPLE_PATTERN.test(name)) return { ok: false, reason: 'sample' };
    if (isIgnored(name, relPath, patterns)) return { ok: false, reason: 'ignored' };
    return { ok: true, kind: isLyrics ? 'lyrics' : 'media' };
}

/**
 * A symlinked FILE must stay inside the library (or another configured
 * library root): otherwise `01.mp3 -> /config/master.key` gets ingested and
 * served. Media may be linked to a mount outside the library (debrid/rclone);
 * sidecars (lyrics, ...) must stay inside a library root.
 */
async function symlinkedFileAllowed(
    fullPath: string,
    name: string,
    rootCanonical: string,
): Promise<boolean> {
    const linkExt = extname(name).toLowerCase();
    const resolveLink =
        MEDIA_EXTENSIONS.has(linkExt) || AUDIO_EXTENSIONS.has(linkExt)
            ? resolveContainedMediaFile
            : resolveContainedFile;
    return (await resolveLink(fullPath, [rootCanonical])) !== null;
}

/** True when `canonical` is the root's canonical path or lies under it. */
function withinCanonicalRoot(canonical: string, rootCanonical: string): boolean {
    const canonResolved = resolvePath(canonical);
    const rootResolved = resolvePath(rootCanonical);
    const rootPrefix = rootResolved.endsWith('/') ? rootResolved : rootResolved + '/';
    return canonResolved === rootResolved || canonResolved.startsWith(rootPrefix);
}

/**
 * Node's readdir turns bytes that are not valid UTF-8 into U+FFFD, and the
 * resulting name no longer exists on disk. Such entries are skipped and counted.
 */
async function isNonUtf8Name(name: string, fullPath: string): Promise<boolean> {
    if (!name.includes('\uFFFD')) return false;
    try {
        await safeLstat(fullPath);
        return false;
    } catch (err) {
        return (err as { code?: string } | null)?.code === 'ENOENT';
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result of a directory walk that distinguishes "clean" runs from runs where
 * some subtree could not be read. Stale-cleanup callers MUST refuse cleanup
 * when `hadErrors === true` — otherwise a failed subdirectory readdir would
 * look like "file vanished" and trigger cascade deletes.
 */
export interface WalkResult {
    /**
     * All absolute paths of media files discovered, returned verbatim from
     * `fs.readdir`. We do NOT Unicode-normalize because the bytes on disk
     * are the source of truth — passing an NFC-normalized form back to
     * `fs.open` yields ENOENT on Linux when the on-disk filename uses NFD
     * (observed on preprod with FLAC files that contained `é` as
     * `e U+0301`). Linux/Docker do not normalize at the syscall layer; the
     * macOS-migration concern that motivated the historical normalization
     * is handled by a one-time dedupe pass instead.
     */
    files: string[];
    /**
     * Absolute paths of lyrics sidecar files (`.lrc`/`.txt`) discovered in the
     * same pass. Collected separately from `files` so the scanner can detect a
     * newly-dropped or edited sidecar next to an otherwise-unchanged audio
     * track (which triage would normally skip). Includes every matching
     * extension — non-lyrics `.txt` files are filtered downstream by matching
     * the stem against a known audio track.
     */
    lyricsSidecars: string[];
    /**
     * True when at least one readdir/stat call failed inside the walk (timeout,
     * EACCES, EIO, etc.). Callers that compare the walk's output against DB
     * state must treat `hadErrors` as "walk was incomplete; do not assume
     * missing files were deleted".
     */
    hadErrors: boolean;
    /** First few paths where the walk could not read the directory — for logging. */
    errorPaths: string[];
}

/**
 * Recursively walk a directory and return absolute paths of all media files.
 * Returns empty array if the directory does not exist or cannot be read.
 *
 * **Wrapper that preserves the historic return type for callers (watcher,
 * tests) that don't need the error flag.** Scanners doing stale cleanup
 * should use {@link walkDirectoryWithResult} instead so they can refuse
 * cleanup when the walk was incomplete.
 */
export async function walkDirectory(dirPath: string): Promise<string[]> {
    const result = await walkDirectoryWithResult(dirPath);
    return result.files;
}

/**
 * Recursively walk a directory and return media files + error state.
 *
 * File paths are returned verbatim from `fs.readdir`. Earlier versions of
 * this code Unicode-NFC normalized every path on the theory that macOS
 * sometimes stores NFD forms on HFS+ while Linux presents NFC — that turned
 * out to be wrong. Linux/Docker do not normalize at the syscall layer; the
 * bytes on disk are what they are. Passing an NFC string back to `fs.open`
 * yields ENOENT whenever the on-disk filename was actually NFD. Observed
 * on preprod with a FLAC file whose name contained `é` as `e U+0301` —
 * `parseFile()` failed in 0 ms with ENOENT, the scanner fell back to a
 * filename-derived title, and the resulting dummy track was soft-dismissed
 * on every subsequent scan (417 dups accumulated over 3 weeks).
 *
 * @param onProgress - Optional callback invoked (throttled every 250 files)
 *   as media files are discovered. Receives the current discovered count.
 *   Callers use this to surface a "Discovering files…" counter before the
 *   walk completes.
 */
export async function walkDirectoryWithResult(
    dirPath: string,
    onProgress?: (filesFound: number) => void,
): Promise<WalkResult> {
    const results: string[] = [];
    const lyricsSidecars: string[] = [];
    const errorPaths: string[] = [];
    // Resolve the library root once so symlink-loop detection can reject
    // targets that escape the library, and so the visited-set uses canonical
    // inode keys.
    const rootCanonical = await resolveCanonical(dirPath);
    const visited = new Set<string>();
    if (rootCanonical.path) {
        visited.add(rootCanonical.key);
    }
    const errorState: WalkErrorState = { hadErrors: false, refusedSymlinks: 0 };
    // Ignore files (including the root's) are read inside walkRecursive from the
    // directory listing it already fetched — the root starts with no inherited
    // patterns.
    await walkRecursive(
        dirPath,
        dirPath,
        rootCanonical.path ?? dirPath,
        [],
        results,
        lyricsSidecars,
        visited,
        errorState,
        errorPaths,
        onProgress,
    );
    if (errorState.refusedSymlinks) {
        logger.warn(
            `walkDirectory: ${errorState.refusedSymlinks} file symlink(s) under "${dirPath}" skipped (target outside library roots or in a sensitive location)`,
        );
    }
    if (errorState.nonUtf8Skipped) {
        logger.debug(
            `walkDirectory: ${errorState.nonUtf8Skipped} entries with non-UTF-8 names skipped under "${dirPath}"`,
        );
    }
    return {
        files: results,
        lyricsSidecars,
        hadErrors: errorState.hadErrors,
        errorPaths,
    };
}

interface Canonical {
    /** Absolute, symlink-resolved path — or null when the target is unreachable. */
    path: string | null;
    /** Inode-based key for the visited-set, `dev:ino`. Stable across symlink aliases. */
    key: string;
}

async function resolveCanonical(p: string): Promise<Canonical> {
    try {
        const rp = await safeRealpath(p);
        const st = await safeStat(rp);
        // Prefer dev+ino as the visited-key (stable across symlink aliases /
        // bind mounts). BUT only when a real inode is present: some filesystems
        // (certain overlayfs/tmpfs/virtual mounts, Windows) report `ino === 0`
        // for every entry, which would collapse ALL such directories onto the
        // single key "0:0" — the visited-set would then treat distinct dirs as
        // already-walked and silently skip whole subtrees. Fall back to the
        // canonical realpath string (unique per directory) in that case.
        const hasInode = typeof st.dev === 'number' && typeof st.ino === 'number' && st.ino > 0;
        const key = hasInode ? `${st.dev}:${st.ino}` : rp;
        return { path: rp, key };
    } catch {
        // best-effort: realpath/stat failure → fall back to the raw path as the visited-key identity.
        return { path: null, key: p };
    }
}

export interface ExtraEntry {
    filePath: string;
    extraType: ExtraType;
    /**
     * The media folder this extra belongs to — the folder whose primary item is
     * this extra's parent. For extras inside a named subfolder (`Film/trailers/x`)
     * this is the folder above the extras subfolder; for a filename-suffix extra
     * sitting beside the movie (`Film/Film-trailer.mkv`) it is the movie folder
     * itself.
     */
    parentFolder: string;
    /**
     * For a filename-suffix extra, the exact sibling primary file it belongs to,
     * matched by name (`B-trailer.mkv` → `B.mkv`). Lets the processor attach to
     * the right item when a folder holds several primaries. Undefined when there
     * is no specific match (standalone `trailer.mp4`, or subfolder extras) — the
     * processor then falls back to the folder's primary item.
     */
    primaryFilePath?: string;
}

export interface ArtworkEntry {
    filePath: string;
    artworkType: ArtworkType;
    /**
     * Set only for the FLAT season convention (`Show/season01-poster.jpg`),
     * which Sonarr/Kodi/Jellyfin write into the SERIES root. Present means
     * "this file names one specific season of the series that owns this
     * folder" — `processArtwork` routes on it and must NOT fall back to the
     * generic folder resolution, which would attach it to the series.
     */
    seasonNumber?: number;
}

/**
 * Album-cover candidates from a `walkArtwork` sweep of an album directory.
 *
 * Exists because `walkArtwork` also emits SEASON-scoped entries
 * (`season01-poster.jpg`) since the flat-convention read support landed. Those
 * carry `artworkType: 'poster'` but name a TV season, so a bare
 * `artworkType === 'poster'` filter in the music scanner could pick one as an
 * album cover. Every album-art callsite goes through this helper instead.
 */
export function albumPosterCandidates(entries: ArtworkEntry[]): ArtworkEntry[] {
    return entries.filter((e) => e.artworkType === 'poster' && e.seasonNumber === undefined);
}

/**
 * Walk extras under dirPath. Collects two shapes of local extras:
 *   1. Video files inside a named extras subfolder (`trailers/`, `behind the
 *      scenes/`, …) — one level deep, tagged from EXTRAS_FOLDER_MAP.
 *   2. Filename-suffix / single-file extras sitting directly beside the media
 *      (`Film-trailer.mkv`, `Making of-behindthescenes.mkv`, `trailer.mp4`) —
 *      Jellyfin's suffix convention, tagged via extraTypeFromFilename.
 * Each entry carries the media folder its parent item lives in (`parentFolder`).
 *
 * Honors the same ignore files as the main walk (`.ignore` / `.lumastraignore`),
 * so a file the operator ignored is not resurrected here as an extra, and an
 * empty `.ignore` marker skips the subtree (refused at the library root, like
 * the main walk). `rootPath`/`inheritedPatterns` thread the accumulated ignore
 * patterns through the recursion; callers pass only `dirPath`.
 */
export async function walkExtras(
    dirPath: string,
    rootPath: string = dirPath,
    inheritedPatterns: string[] = [],
): Promise<ExtraEntry[]> {
    const results: ExtraEntry[] = [];
    let entries;
    try {
        entries = await readdirWithTimeout(dirPath, { withFileTypes: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('readdir timeout:')) {
            logger.warn(`walkDirectory: readdir timed out for "${dirPath}" (extras) — skipping`);
        }
        return results;
    }

    // Accumulate this folder's ignore files (same semantics as the main walk).
    const presentNames = new Set<string>();
    for (const entry of entries) {
        if (entry.isFile() || entry.isSymbolicLink()) presentNames.add(entry.name);
    }
    const localIgnore = await readDirIgnore(dirPath, presentNames, rootPath);
    // Fail closed, like the main walk.
    if (localIgnore.refused) return results;
    // Empty `.ignore` marker skips the whole subtree — but never the library root
    // (matches walkDirectory's root refusal).
    if (localIgnore.skipEntireDir && dirPath !== rootPath) return results;
    const patterns = localIgnore.patterns.length
        ? [...inheritedPatterns, ...localIgnore.patterns]
        : inheritedPatterns;

    // Only collect sibling suffix-extras when a primary video shares the folder
    // to be their parent — mirrors the main walk's exclusion gate so the two
    // passes agree (a lone suffix file stays a main item; it is neither dropped
    // nor collected here).
    const hasPrimaryVideo = folderHasPrimaryVideo(entries);

    for (const entry of entries) {
        const ext = extname(entry.name).toLowerCase();
        // Filename-suffix / single-file extras sitting directly in this folder.
        // Their parent is whatever primary item lives in the same folder.
        // Symlinked media files are treated like the main walk (which resolves
        // symlink targets), so a symlinked trailer is collected, not dropped.
        if ((entry.isFile() || entry.isSymbolicLink()) && MEDIA_EXTENSIONS.has(ext)) {
            if (!hasPrimaryVideo) continue;
            if (
                entry.isSymbolicLink() &&
                !(await resolveContainedMediaFile(join(dirPath, entry.name), [rootPath]))
            ) {
                continue;
            }
            if (isAppleDoubleSidecar(entry.name)) continue;
            if (SAMPLE_PATTERN.test(entry.name)) continue;
            if (isIgnored(entry.name, relative(rootPath, join(dirPath, entry.name)), patterns)) {
                continue;
            }
            const parsedExtra = parseExtraFilename(entry.name);
            if (parsedExtra) {
                // Match the specific sibling primary by name so the extra attaches
                // to the right item when the folder holds several primaries.
                const primaryName = matchPrimaryForExtra(entries, parsedExtra.baseName);
                results.push({
                    filePath: join(dirPath, entry.name),
                    extraType: parsedExtra.extraType,
                    parentFolder: dirPath,
                    primaryFilePath: primaryName ? join(dirPath, primaryName) : undefined,
                });
            }
            continue;
        }

        if (!entry.isDirectory()) continue;
        const extraType = EXTRAS_FOLDER_MAP[entry.name.toLowerCase()];
        if (!extraType) continue;
        // An extras subfolder can itself be ignored.
        if (isIgnored(entry.name, relative(rootPath, join(dirPath, entry.name)), patterns)) {
            continue;
        }

        const subDir = join(dirPath, entry.name);
        let subEntries;
        try {
            subEntries = await readdirWithTimeout(subDir, {
                withFileTypes: true,
            });
        } catch {
            continue;
        }

        for (const sub of subEntries) {
            if (!sub.isFile() && !sub.isSymbolicLink()) continue;
            const subExt = extname(sub.name).toLowerCase();
            if (!MEDIA_EXTENSIONS.has(subExt)) continue;
            if (
                sub.isSymbolicLink() &&
                !(await resolveContainedMediaFile(join(subDir, sub.name), [rootPath]))
            ) {
                continue;
            }
            if (isAppleDoubleSidecar(sub.name)) continue;
            if (SAMPLE_PATTERN.test(sub.name)) continue;
            if (isIgnored(sub.name, relative(rootPath, join(subDir, sub.name)), patterns)) continue;
            // Parent is the folder ABOVE the extras subfolder — i.e. dirPath.
            results.push({ filePath: join(subDir, sub.name), extraType, parentFolder: dirPath });
        }
    }

    // Recurse into non-extras subdirectories (e.g. Season 01 for TV)
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (EXTRAS_FOLDER_MAP[entry.name.toLowerCase()]) continue; // already processed
        if (isPrunedFolderName(entry.name)) continue;
        if (isIgnored(entry.name, relative(rootPath, join(dirPath, entry.name)), patterns)) {
            continue;
        }
        const sub = await walkExtras(join(dirPath, entry.name), rootPath, patterns);
        results.push(...sub);
    }

    return results;
}

/**
 * Walk dirPath (non-recursive into extras folders) collecting image files
 * that match known artwork filenames (folder.jpg, backdrop.jpg, logo.png, etc.).
 *
 * AT MOST ONE entry per (directory, artwork type, season) is returned.
 *
 * The conflict key on media_artwork is (item, type, source, language), so a
 * directory holding `backdrop.jpg`, `backdrop1.jpg` and `landscape.jpg` was
 * offering three candidates for ONE row. Each upsert re-pointed the row away
 * from the previous one's path, so all three wrote on every scan cycle, forever
 * — 3,426 such directories on production, 1,600 of them holding exactly that
 * three-way set. Three further consequences beyond the writes: the admin scan
 * table showed a permanent non-zero "updated" on libraries where nothing had
 * changed, so "no changes" was unreachable; and each tagless re-point takes the
 * ELSE branch of the `remote_url` CASE, NULLing the provenance tag that
 * `isManagedArtworkFile` reads — so a materialized file caught in a pair lost
 * its tag every cycle and became indistinguishable from a user's own sidecar.
 *
 * Fixed HERE rather than in the upsert guard: the guard is right — those really
 * were different values — the INPUT was duplicated. {@link artworkStemRank}
 * picks the winner and documents the ordering.
 *
 * Scoped per DIRECTORY, deliberately. Subdirectory results are merged in
 * untouched: `Show/backdrop.jpg` and `Show/Season 01/backdrop.jpg` resolve to
 * DIFFERENT media items (series vs season), so deduping them against each other
 * would silently drop the season's artwork. Within one directory every
 * candidate of the same type and season resolves to the same target, which is
 * what makes the directory the right scope.
 */
export async function walkArtwork(dirPath: string): Promise<ArtworkEntry[]> {
    const results: ArtworkEntry[] = [];
    let entries;
    try {
        entries = await readdirWithTimeout(dirPath, { withFileTypes: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('readdir timeout:')) {
            logger.warn(`walkDirectory: readdir timed out for "${dirPath}" (artwork) — skipping`);
        }
        return results;
    }

    // This directory's own candidates, best-ranked kept per (type, season).
    const own = new Map<string, { entry: ArtworkEntry; rank: number; name: string }>();
    const keep = (entry: ArtworkEntry, stem: string, name: string): void => {
        const key = `${entry.artworkType}\u0000${entry.seasonNumber ?? ''}`;
        const rank = artworkStemRank(stem);
        const current = own.get(key);
        // Filename breaks a rank tie (`folder.jpg` vs `folder.webp`). Arbitrary,
        // but TOTAL and STABLE — stability is the property that stops the
        // flapping, not which extension happens to win.
        if (!current || rank < current.rank || (rank === current.rank && name < current.name)) {
            own.set(key, { entry, rank, name });
        }
    };

    for (const entry of entries) {
        if (entry.isDirectory()) {
            // Skip extras folders — their images are not the parent's artwork
            if (EXTRAS_FOLDER_MAP[entry.name.toLowerCase()]) continue;
            if (isPrunedFolderName(entry.name)) continue;
            // Recurse into regular subdirs (e.g. Season 01)
            const sub = await walkArtwork(join(dirPath, entry.name));
            results.push(...sub);
            continue;
        }
        if (!entry.isFile()) continue;
        if (isAppleDoubleSidecar(entry.name)) continue;
        const ext = extname(entry.name).toLowerCase();
        if (!ARTWORK_EXTENSIONS.has(ext)) continue;
        const stem = basename(entry.name, ext);
        const artworkType = artworkTypeFromStem(stem);
        if (artworkType) {
            keep({ filePath: join(dirPath, entry.name), artworkType }, stem, entry.name);
            continue;
        }
        // Second chance: the flat season convention (`season01-poster.jpg`),
        // which the primary classifier deliberately does not recognise. Only
        // consulted when the primary returns null, so nothing it already
        // matched can change meaning.
        const season = seasonArtworkFromStem(stem);
        if (!season) continue;
        keep(
            {
                filePath: join(dirPath, entry.name),
                artworkType: season.artworkType,
                seasonNumber: season.seasonNumber,
            },
            // Rank on the SUFFIX, not the resolved type: `season01-folder` and
            // `season01-poster` both resolve to poster, and ranking by type
            // would score them equal and let the filename tiebreak pick folder.
            season.suffix,
            entry.name,
        );
    }

    for (const { entry } of own.values()) results.push(entry);
    return results;
}

/**
 * Walk dirPath recursively collecting external subtitle files.
 * Returns absolute paths of all subtitle files found.
 */
export async function walkSubtitles(dirPath: string): Promise<string[]> {
    const results: string[] = [];
    let entries;
    try {
        entries = await readdirWithTimeout(dirPath, { withFileTypes: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('readdir timeout:')) {
            logger.warn(`walkDirectory: readdir timed out for "${dirPath}" (subtitles) — skipping`);
        }
        return results;
    }

    for (const entry of entries) {
        if (entry.isDirectory()) {
            // Skip extras folders — their subtitles are not the parent's subtitles
            if (EXTRAS_FOLDER_MAP[entry.name.toLowerCase()]) continue;
            if (isPrunedFolderName(entry.name)) continue;
            // Recurse into regular subdirs (e.g. Season 01)
            const sub = await walkSubtitles(join(dirPath, entry.name));
            results.push(...sub);
            continue;
        }
        if (!entry.isFile()) continue;
        if (isAppleDoubleSidecar(entry.name)) continue;
        const ext = extname(entry.name).toLowerCase();
        if (!SUBTITLE_EXTENSIONS.has(ext)) continue;
        results.push(join(dirPath, entry.name));
    }

    return results;
}

interface WalkErrorState {
    hadErrors: boolean;
    /** File symlinks refused by containment during this walk (logged once at the end). */
    refusedSymlinks?: number;
    /** Entries with non-UTF-8 names skipped during this walk (logged once at the end). */
    nonUtf8Skipped?: number;
}

/** Error paths a walk records; a walk with more reports exactly this many. */
export const MAX_WALK_ERROR_PATHS = 20;
const MAX_ERROR_PATHS = MAX_WALK_ERROR_PATHS;

function recordWalkError(state: WalkErrorState, errorPaths: string[], dirPath: string): void {
    state.hadErrors = true;
    if (errorPaths.length < MAX_ERROR_PATHS) {
        errorPaths.push(dirPath);
    }
}

/**
 * Decide whether a filesystem entry should be treated as a directory / file
 * for the walker. Consolidates the "regular entry" branch and the "follow a
 * symlink" branch. Returns null when the entry is something exotic (socket,
 * fifo, device file) that should be skipped silently.
 */
async function classifyEntry(
    entry: Dirent,
    fullPath: string,
    rootCanonical: string,
): Promise<
    | { kind: 'directory'; canonicalPath: string; canonicalKey: string }
    | { kind: 'file'; name: string }
    | { kind: 'skip-silent' }
    | { kind: 'refused-symlink' }
    | { kind: 'error' }
> {
    if (entry.isSymbolicLink()) {
        // Resolve the link target; if unreachable, record as error so callers
        // don't mistake "unavailable symlink target" for "file deleted".
        const canon = await resolveCanonical(fullPath);
        if (!canon.path) return { kind: 'error' };
        try {
            const st = await safeStat(canon.path);
            if (st.isDirectory()) {
                return {
                    kind: 'directory',
                    canonicalPath: canon.path,
                    canonicalKey: canon.key,
                };
            }
            if (st.isFile()) {
                if (!(await symlinkedFileAllowed(fullPath, entry.name, rootCanonical))) {
                    return { kind: 'refused-symlink' };
                }
                // For files, return the entry name; regular extension/sample
                // filters apply using the symlink's own name (the convention
                // users expect). Recording under `fullPath` is fine — nothing
                // upstream cares about the link target path for files.
                return { kind: 'file', name: entry.name };
            }
            return { kind: 'skip-silent' };
        } catch {
            return { kind: 'error' };
        }
    }
    if (entry.isDirectory()) {
        // Resolve once so the visited-set key is canonical. Non-symlinked
        // dirs still need realpath to handle bind mounts + duplicated-inode
        // setups. Errors here are non-fatal — fall back to the raw path.
        const canon = await resolveCanonical(fullPath);
        return {
            kind: 'directory',
            canonicalPath: canon.path ?? fullPath,
            canonicalKey: canon.key,
        };
    }
    if (entry.isFile()) return { kind: 'file', name: entry.name };
    return { kind: 'skip-silent' };
}

async function walkRecursive(
    dirPath: string,
    rootPath: string,
    rootCanonical: string,
    inheritedPatterns: string[],
    results: string[],
    lyricsSidecars: string[],
    visited: Set<string>,
    errorState: WalkErrorState,
    errorPaths: string[],
    onProgress?: (filesFound: number) => void,
): Promise<void> {
    let entries;
    try {
        entries = await readdirWithTimeout(dirPath, { withFileTypes: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordWalkError(errorState, errorPaths, dirPath);
        if (msg.startsWith('readdir timeout:')) {
            logger.warn(
                `walkDirectory: readdir timed out for "${dirPath}" — skipping (network share stall?)`,
            );
        } else {
            logger.debug(`walkDirectory: cannot read ${dirPath}: ${msg}`);
        }
        return;
    }

    // Read this directory's ignore files (.lumastraignore + .ignore) straight
    // from the listing we already have, so we never open() a file that isn't
    // there.
    const presentNames = new Set<string>();
    for (const entry of entries) {
        // Include symlinks — safeReadFile follows them, so a symlinked ignore
        // file must still be read.
        if (entry.isFile() || entry.isSymbolicLink()) presentNames.add(entry.name);
    }
    const ignoreOutcome = await evaluateDirIgnore(dirPath, rootPath, presentNames);
    if (ignoreOutcome.action === 'refused') {
        // Fail closed (see readIgnoreLines). Recorded as a walk error so stale
        // cleanup does not read the missing subtree as "files deleted".
        recordWalkError(errorState, errorPaths, dirPath);
        return;
    }
    if (ignoreOutcome.action === 'skip') {
        logger.debug(
            `walkDirectory: ".ignore" marker - skipping folder "${relative(rootPath, dirPath)}"`,
        );
        return;
    }

    const patterns = ignoreOutcome.local.length
        ? [...inheritedPatterns, ...ignoreOutcome.local]
        : inheritedPatterns;

    // A filename-suffix extra is only routed to the extras pass when a primary
    // video sits in the same folder to be its parent. A lone suffix-named file
    // (no sibling primary) stays a normal item so it is never silently dropped.
    const hasPrimaryVideo = folderHasPrimaryVideo(entries);

    let warnedNonUtf8 = false;
    for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);
        const relPath = relative(rootPath, fullPath);

        if (await isNonUtf8Name(entry.name, fullPath)) {
            errorState.nonUtf8Skipped = (errorState.nonUtf8Skipped ?? 0) + 1;
            const message = `walkDirectory: non-UTF-8 name skipped in "${dirPath}": "${entry.name}"`;
            if (warnedNonUtf8) {
                logger.debug(message);
            } else {
                logger.warn(message);
                warnedNonUtf8 = true;
            }
            continue;
        }

        // Exclude vendor/system folders by name first — avoids touching the
        // filesystem at all for `@eaDir`, `#recycle`, etc.
        // Not logged: a Jellyfin-managed library has one `….trickplay` folder
        // per video, so a line per folder was ~3,400 debug lines every
        // 5-minute scan on prod — enough to rotate the container log in hours.
        if (entry.isDirectory() && isPrunedFolderName(entry.name)) {
            continue;
        }

        const classified = await classifyEntry(entry, fullPath, rootCanonical);

        // A symlink is only pruned by name once it is known to be a DIRECTORY:
        // debrid/rclone libraries are made of symlinked FILES, and one named
        // like a vendor folder (`@…`, `….trickplay`) must still be ingested.
        if (
            classified.kind === 'directory' &&
            entry.isSymbolicLink() &&
            isPrunedFolderName(entry.name)
        ) {
            logger.debug(`walkDirectory: skipping excluded folder "${entry.name}"`);
            continue;
        }

        if (classified.kind === 'error') {
            // Symlink target unreachable or stat failed. Record so the caller
            // doesn't misinterpret missing files as deletions.
            recordWalkError(errorState, errorPaths, fullPath);
            continue;
        }

        if (classified.kind === 'refused-symlink') {
            errorState.refusedSymlinks = (errorState.refusedSymlinks ?? 0) + 1;
            continue;
        }

        if (classified.kind === 'skip-silent') continue;

        if (classified.kind === 'directory') {
            if (isIgnored(entry.name, relPath, patterns)) {
                logger.debug(`walkDirectory: ignore-file excluded folder "${relPath}"`);
                continue;
            }
            // Symlink-loop guard: reject canonical paths we've already walked
            // (the same directory reachable via multiple links) and reject
            // targets that resolve outside the library root — following them
            // would scan arbitrary parts of the filesystem.
            if (visited.has(classified.canonicalKey)) {
                logger.debug(
                    `walkDirectory: skipping already-visited path "${fullPath}" (symlink loop or bind-mount)`,
                );
                continue;
            }
            // Escape detection: check whether the canonical path is inside
            // the library root. `resolve` normalizes both so the prefix
            // comparison is safe.
            if (!withinCanonicalRoot(classified.canonicalPath, rootCanonical)) {
                logger.warn(`walkDirectory: symlink target outside library root - skipping`, {
                    link: fullPath,
                    target: resolvePath(classified.canonicalPath),
                });
                continue;
            }
            visited.add(classified.canonicalKey);
            await walkRecursive(
                fullPath,
                rootPath,
                rootCanonical,
                patterns,
                results,
                lyricsSidecars,
                visited,
                errorState,
                errorPaths,
                onProgress,
            );
            continue;
        }

        // classified.kind === 'file'
        const verdict = classifyFileName(classified.name, relPath, patterns);
        if (!verdict.ok) {
            if (verdict.reason !== 'extension') {
                logger.debug(`walkDirectory: skipping ${verdict.reason} file "${relPath}"`);
            }
            continue;
        }
        const ext = extname(classified.name).toLowerCase();
        const isLyrics = verdict.kind === 'lyrics';
        // Filename-suffix / single-file extras (`Film-trailer.mkv`, standalone
        // `trailer.mp4`, `Making of-behindthescenes.mkv`, …) are NOT standalone
        // library items — the walkExtras pass collects them and links them to the
        // folder's primary item. Exclude them here (video only, and only when a
        // sibling primary exists) so a stray trailer beside a movie doesn't become
        // a bogus top-level card, while a lone suffix-named file with no primary is
        // still ingested normally. Audio is left alone: extras are a video concept.
        if (
            hasPrimaryVideo &&
            MEDIA_EXTENSIONS.has(ext) &&
            extraTypeFromFilename(classified.name)
        ) {
            logger.debug(`walkDirectory: routing suffix-extra to extras pass "${classified.name}"`);
            continue;
        }
        // Lyrics sidecars are collected separately from media files — they are
        // not standalone library items, only signals that an existing track's
        // lyrics may need (re-)ingesting.
        if (isLyrics) {
            lyricsSidecars.push(fullPath);
            continue;
        }
        results.push(fullPath);
        // Throttle: fire the progress callback every 250 media files so
        // callers can surface a climbing "Discovering files…" count without
        // paying the cost of a Valkey write on every single file.
        if (onProgress && results.length % 250 === 0) {
            onProgress(results.length);
        }
    }
}

// ---------------------------------------------------------------------------
// Single-path eligibility (second line of defence for watcher/delta ingest)
// ---------------------------------------------------------------------------

export type ScannerEligibility =
    { eligible: true; kind: 'media' | 'lyrics' } | { eligible: false; reason: string };

/**
 * Caches below are keyed on what they were computed from (directory mtime,
 * ignore-file mtime/size/inode), and that signature is re-stat'ed on every
 * call, so a changed directory or ignore file is seen immediately. Canonical
 * paths are never cached: containment is decided on a fresh realpath.
 */
const MAX_ELIGIBILITY_CACHE_ENTRIES = 4096;
const dirIgnoreCache = new Map<string, DirIgnoreOutcome>();
const dirListingCache = new Map<string, Dirent[]>();

/** Test hook: drop the eligibility caches. */
export function resetScannerEligibilityCache(): void {
    dirIgnoreCache.clear();
    dirListingCache.clear();
}

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
    if (cache.size >= MAX_ELIGIBILITY_CACHE_ENTRIES) cache.clear();
    cache.set(key, value);
}

async function dirSignature(dir: string): Promise<string | null> {
    try {
        const st = await safeStat(dir);
        return `${st.mtimeMs}:${st.ino}`;
    } catch {
        return null;
    }
}

async function dirListing(dir: string): Promise<Dirent[] | null> {
    const sig = await dirSignature(dir);
    const key = sig === null ? null : `${dir}\0${sig}`;
    if (key !== null) {
        const hit = dirListingCache.get(key);
        if (hit) return hit;
    }
    try {
        const entries = await readdirWithTimeout(dir, { withFileTypes: true });
        if (key !== null) remember(dirListingCache, key, entries);
        return entries;
    } catch {
        return null;
    }
}

/** Ignore files present in `dir`, found by lstat so a huge directory is not listed per file. */
async function dirIgnoreOutcome(dir: string, rootPath: string): Promise<DirIgnoreOutcome> {
    const present = new Set<string>();
    const parts: string[] = [(await dirSignature(dir)) ?? 'nodir'];
    let cacheable = true;
    for (const name of [LUMASTRA_IGNORE_FILE, JELLYFIN_IGNORE_FILE]) {
        try {
            const st = await safeLstat(join(dir, name));
            if (st.isFile() || st.isSymbolicLink()) present.add(name);
            // A symlink's own mtime says nothing about its target: always re-read.
            if (st.isSymbolicLink()) cacheable = false;
            parts.push(`${name}:${st.mtimeMs}:${st.size}:${st.ino}`);
        } catch {
            parts.push(`${name}:absent`);
        }
    }
    const key = `${rootPath}\0${dir}\0${parts.join('|')}`;
    if (cacheable) {
        const hit = dirIgnoreCache.get(key);
        if (hit) return hit;
    }
    const outcome = await evaluateDirIgnore(dir, rootPath, present);
    if (cacheable) remember(dirIgnoreCache, key, outcome);
    return outcome;
}

const no = (reason: string): ScannerEligibility => ({ eligible: false, reason });

/**
 * Would a bulk walk of `rootPath` report `absPath`? Applies the walk's rules to
 * one path: lexical containment, every directory below the root (pruned names,
 * ignore patterns, canonical containment, loops, ignore files with the same
 * fail-closed and root-marker semantics) and the file rules (AppleDouble,
 * extension, sample, ignore patterns, symlink containment, filename-suffix
 * extras beside a primary video).
 *
 * A directory symlink to a sibling directory inside the root is accepted: the
 * walk visits such a target through whichever path it meets first, which
 * depends on readdir order.
 */
export async function checkScannerEligibility(
    rootPath: string,
    absPath: string,
): Promise<ScannerEligibility> {
    const root = resolvePath(rootPath);
    const rel = relative(root, resolvePath(absPath));
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
        return no('outside library root');
    }
    const parts = rel.split(sep);
    const fileName = parts[parts.length - 1];

    const rootCanon = await resolveCanonical(root);
    const rootCanonical = rootCanon.path ?? root;
    const seen = new Set<string>([rootCanon.key]);

    let dir = root;
    let patterns: string[] = [];
    for (let i = 0; i < parts.length; i++) {
        // i === 0 evaluates the root's own ignore files; i >= 1 enters parts[i - 1].
        if (i > 0) {
            const name = parts[i - 1];
            const child = join(dir, name);
            const relChild = relative(root, child);
            if (isPrunedFolderName(name)) return no(`pruned directory "${name}"`);
            if (isIgnored(name, relChild, patterns)) return no(`ignored directory "${relChild}"`);
            if (await isNonUtf8Name(name, child)) return no('non-UTF-8 name');
            const canon = await resolveCanonical(child);
            if (!canon.path) return no(`cannot resolve directory "${relChild}"`);
            try {
                if (!(await safeStat(canon.path)).isDirectory()) return no('not a directory');
            } catch {
                return no(`cannot resolve directory "${relChild}"`);
            }
            if (!withinCanonicalRoot(canon.path, rootCanonical)) {
                return no(`directory "${relChild}" resolves outside the library root`);
            }
            if (seen.has(canon.key)) return no(`directory "${relChild}" is a symlink loop`);
            seen.add(canon.key);
            dir = child;
        }
        const outcome = await dirIgnoreOutcome(dir, root);
        if (outcome.action === 'refused') return no('unreadable ignore file');
        if (outcome.action === 'skip') return no(`".ignore" marker in "${relative(root, dir)}"`);
        if (outcome.local.length) patterns = [...patterns, ...outcome.local];
    }

    const fullPath = join(dir, fileName);
    let lst;
    try {
        lst = await safeLstat(fullPath);
    } catch {
        return no(fileName.includes('�') ? 'non-UTF-8 name' : 'file not found');
    }
    const verdict = classifyFileName(fileName, rel, patterns);
    if (!verdict.ok) return no(`${verdict.reason} file`);

    if (lst.isSymbolicLink()) {
        const canon = await resolveCanonical(fullPath);
        if (!canon.path) return no('unresolvable symlink');
        try {
            const st = await safeStat(canon.path);
            if (!st.isFile()) return no('symlink target is not a file');
        } catch {
            return no('unresolvable symlink');
        }
        if (!(await symlinkedFileAllowed(fullPath, fileName, rootCanonical))) {
            return no('symlink target outside library roots or in a sensitive location');
        }
    } else if (!lst.isFile()) {
        return no('not a regular file');
    }

    if (MEDIA_EXTENSIONS.has(extname(fileName).toLowerCase()) && extraTypeFromFilename(fileName)) {
        const entries = await dirListing(dir);
        if (!entries) return no('cannot list directory');
        if (folderHasPrimaryVideo(entries))
            return no('filename-suffix extra beside a primary video');
    }
    return { eligible: true, kind: verdict.kind };
}
