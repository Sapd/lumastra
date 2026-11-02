// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Pure filename classifications shared by scanner walks and the isolated watcher. */

/** Subtitle file extensions that the scanner recognises. */
export const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub', '.sup']);

/**
 * Lyrics sidecar extensions the scanner ingests next to an audio track.
 * `.lrc` is always synced LRC; `.txt` is auto-detected (synced if it carries
 * `[mm:ss.xx]` timestamps, otherwise plain). Kept here next to the other
 * extension sets so the walk can collect them in the same pass.
 */
export const LYRICS_SIDECAR_EXTENSIONS = new Set(['.lrc', '.txt']);

/** Returns true when the given lowercase extension is a lyrics sidecar. */
export function isLyricsSidecar(ext: string): boolean {
    return LYRICS_SIDECAR_EXTENSIONS.has(ext);
}

/** Audio file extensions that the file scanner recognises. */
export const AUDIO_EXTENSIONS = new Set([
    '.flac',
    '.mp3',
    '.m4a',
    '.opus',
    '.ogg',
    '.wav',
    '.wma',
    '.aac',
    '.alac',
]);

/** Returns true when the given lowercase extension is an audio file. */
export function isAudioFile(ext: string): boolean {
    return AUDIO_EXTENSIONS.has(ext);
}

/** Video file extensions that the file scanner recognises. */
export const MEDIA_EXTENSIONS = new Set([
    '.mkv',
    '.mp4',
    '.avi',
    '.m4v',
    '.mov',
    '.wmv',
    '.ts',
    '.m2ts',
    '.webm',
    '.ogv',
    '.flv',
    '.3gp',
    '.mpg',
    '.mpeg',
]);

/**
 * Hidden-folder names that are junk wherever they appear — tool metadata, trash,
 * snapshots. The ONLY dot-led folders any walker prunes (see isVendorExcludedName).
 */
const HIDDEN_JUNK_FOLDER_NAMES = new Set([
    '.trickplay', // Jellyfin trickplay tiles (older layout)
    '.subtitle-cache', // our own extracted/rendered bitmap subtitles (.sup/.sub)
    '.actors', // Kodi/Jellyfin actor images
    '.snapshot', // NetApp/NFS snapshots
    '.snapshots', // btrfs/snapper
    '.zfs', // ZFS snapshot dir
    '.wd_tv', // WD TV metadata
    '.grab', // Jellyfin/ffmpeg thumbnail grabs
    '.appledouble', // macOS resource forks over SMB/AFP
    '.trashes', // macOS trash
    '.@__thumb', // QNAP thumbnails
    '.thumbnails', // generic thumbnail cache
    '.spotlight-v100', // macOS Spotlight index
    '.fseventsd', // macOS FSEvents log
    '.temporaryitems', // macOS temp
    '.recycle', // Samba recycle bin
    '.deletedbytmm', // tinyMediaManager recycle bin
]);

const VENDOR_DIRECTORY_PREFIXES = ['.trash-', '@'];
const VENDOR_DIRECTORY_SUFFIXES = ['.trickplay'];
const ADDITIONAL_JUNK_NAMES = ['#recycle', '#snapshot'];
const APPLE_DOUBLE_PREFIX = '._';

/**
 * Returns true if the folder should be excluded as vendor/tool junk.
 *
 * Hidden (dot-led) names are pruned ONLY from the explicit junk list above,
 * at every depth. A blanket `.*` rule (Jellyfin's) is not safe here: titles
 * start with a dot at the library root (`anime/.harbor Sign`), albums do one
 * level down (`music/Slipknot/.5 The Gray Chapter`), and so do titles in
 * collection folders. A pruned folder's files vanish from the walk, and
 * file-reconcile then deletes their items and watch state.
 *
 * `#…` likewise only from a list: `#Alive (2020)` and `#1 Record` are titles.
 * `@…` stays generic (Synology/QNAP system dirs), and `<video>.trickplay` is
 * pruned everywhere — that rule alone carries the scan speedup.
 */
export function isVendorExcludedName(name: string): boolean {
    const lower = name.toLowerCase();
    return (
        HIDDEN_JUNK_FOLDER_NAMES.has(lower) ||
        ADDITIONAL_JUNK_NAMES.includes(lower) ||
        VENDOR_DIRECTORY_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
        VENDOR_DIRECTORY_SUFFIXES.some((suffix) => lower.endsWith(suffix))
    );
}

/**
 * True when `name` is a macOS AppleDouble resource-fork sidecar (`._Song.flac`
 * alongside `Song.flac`). macOS writes one of these next to every real file
 * whenever the volume isn't HFS+ — SMB/NFS shares, USB drives, and most NAS
 * setups all qualify, so a self-hosted library can easily be full of them.
 *
 * These sidecars matter here because, unlike other vendor junk, they inherit
 * the real file's extension — `._Song.flac` passes the same `AUDIO_EXTENSIONS`
 * check as `Song.flac` and gets tag-parsed as a second, broken copy. Other
 * vendor files named by the task that prompted this check don't need a
 * parallel entry: `.DS_Store` / `desktop.ini` have no extension `fs.extname`
 * recognises (and `Thumbs.db`'s `.db` isn't a media extension either), so the
 * existing extension filter already drops them; `@eaDir` is a directory and
 * is covered by the vendor folder rules.
 *
 * Deliberately narrow: only the exact `._` prefix matches, so a real file
 * that happens to start with a dot (a legitimately dot-prefixed directory) or
 * merely contains an underscore is untouched.
 */
export function isAppleDoubleSidecar(name: string): boolean {
    return name.startsWith(APPLE_DOUBLE_PREFIX);
}

/**
 * Folder names that are always skipped during directory walking (case-insensitive).
 * Matches Plex's built-in exclusions plus standard extras subfolder names and
 * common vendor metadata/trash folders (Synology, macOS, Windows, QNAP).
 */
export const EXCLUDED_FOLDER_NAMES: ReadonlySet<string> = new Set([
    // Plex built-in exclusions
    'extras',
    'samples',
    'bonus',
    'bonus disc',
    'video_ts', // DVD structure
    'bdmv', // Blu-ray structure
    // Standard extras subfolders (Plex local extras naming convention)
    'featurettes',
    'behind the scenes',
    'deleted scenes',
    'interviews',
    'scenes',
    'shorts',
    'trailers',
    // Vendor thumbnail/metadata folders (explicit; wildcard below also catches them)
    '@eadir', // Synology indexer
    '.appledouble', // macOS resource forks over SMB/AFP
    '.trashes', // macOS trash
    '.@__thumb', // Synology thumbnails
    '@recycle', // QNAP recycle bin
    '$recycle.bin', // Windows recycle bin
    '#recycle', // Synology/other recycle bin
    '.thumbnails', // Generic thumbnail cache
]);

/** Files with "sample" as a whole word in the name are skipped. */
export const SAMPLE_PATTERN = /\bsample\b/i;

/**
 * Ignore-file names honored by the walker.
 *   - `.lumastraignore` - Lumastra-native, always a gitignore-style pattern file.
 *   - `.ignore`         - Jellyfin/Emby convention. Empty => skip the whole folder;
 *                          non-empty => gitignore-style patterns.
 */
export const LUMASTRA_IGNORE_FILE = '.lumastraignore';
export const JELLYFIN_IGNORE_FILE = '.ignore';

/**
 * Ignore files live inside the library, so whoever can write there controls
 * both the patterns and the names they are tested against. Bounds keep the
 * pattern set from becoming a CPU or memory amplifier.
 */
export const MAX_IGNORE_FILE_BYTES = 64 * 1024;
export const MAX_IGNORE_PATTERN_LENGTH = 512;
export const MAX_IGNORE_PATTERNS_PER_FILE = 1000;
/** Patterns accumulate down the tree; this caps the set one entry is tested against. */
export const MAX_ACCUMULATED_PATTERNS = 5000;

/** Protocol v2 init `policy` object; see the watcher review-fixes spec. */
export interface NativeWatcherPolicyV2 {
    mediaExtensions: string[];
    audioExtensions: string[];
    lyricsExtensions: string[];
    prunedDirectoryNames: string[];
    prunedDirectoryPrefixes: string[];
    prunedDirectorySuffixes: string[];
    ignoredFilePrefixes: string[];
    sampleWord: string;
    ignoreFiles: {
        patternFile: string;
        markerFile: string;
        maxBytes: number;
        maxPatternLength: number;
        maxPatternsPerFile: number;
        maxAccumulatedPatterns: number;
    };
    containmentRoots: string[];
    sensitivePrefixes: string[];
}

/** Serialized once into the Rust child; the same constants feed the scanner walk. */
export function nativeWatcherPolicy(opts: {
    containmentRoots: string[];
    sensitivePrefixes: string[];
}): NativeWatcherPolicyV2 {
    const names = new Set<string>();
    for (const n of [
        ...EXCLUDED_FOLDER_NAMES,
        ...HIDDEN_JUNK_FOLDER_NAMES,
        ...ADDITIONAL_JUNK_NAMES,
    ]) {
        names.add(n.toLowerCase());
    }
    return {
        mediaExtensions: [...MEDIA_EXTENSIONS],
        audioExtensions: [...AUDIO_EXTENSIONS],
        lyricsExtensions: [...LYRICS_SIDECAR_EXTENSIONS],
        prunedDirectoryNames: [...names],
        prunedDirectoryPrefixes: VENDOR_DIRECTORY_PREFIXES.map((p) => p.toLowerCase()),
        prunedDirectorySuffixes: VENDOR_DIRECTORY_SUFFIXES.map((p) => p.toLowerCase()),
        ignoredFilePrefixes: [APPLE_DOUBLE_PREFIX],
        sampleWord: 'sample',
        ignoreFiles: {
            patternFile: LUMASTRA_IGNORE_FILE,
            markerFile: JELLYFIN_IGNORE_FILE,
            maxBytes: MAX_IGNORE_FILE_BYTES,
            maxPatternLength: MAX_IGNORE_PATTERN_LENGTH,
            maxPatternsPerFile: MAX_IGNORE_PATTERNS_PER_FILE,
            maxAccumulatedPatterns: MAX_ACCUMULATED_PATTERNS,
        },
        containmentRoots: [...opts.containmentRoots],
        sensitivePrefixes: [...opts.sensitivePrefixes],
    };
}
