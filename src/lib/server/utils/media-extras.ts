// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared constants for extras folders and local artwork file naming.
 * Used by walk-directory and the file scanner plugin.
 */

import path from 'node:path';

export type ExtraType =
    | 'trailer'
    | 'behind_the_scenes'
    | 'featurette'
    | 'deleted_scene'
    | 'interview'
    | 'scene'
    | 'short'
    | 'extra';

export type ArtworkType = 'poster' | 'backdrop' | 'logo' | 'thumb' | 'banner';
export type ArtworkSource = 'local' | 'remote';

/**
 * Map from lowercase folder name → ExtraType.
 * These are the same folder names previously in EXCLUDED_FOLDER_NAMES.
 */
export const EXTRAS_FOLDER_MAP: Record<string, ExtraType> = {
    'behind the scenes': 'behind_the_scenes',
    trailers: 'trailer',
    featurettes: 'featurette',
    'deleted scenes': 'deleted_scene',
    interviews: 'interview',
    scenes: 'scene',
    shorts: 'short',
    extras: 'extra',
    bonus: 'extra',
    'bonus disc': 'extra',
};

/**
 * Extras keywords that Jellyfin recognises as a HYPHEN-separated filename suffix
 * (e.g. "Making Of-behindthescenes.mkv"). A hyphen is required so ordinary
 * titles like "Crime Scene.mkv" or "Extra Innings.mkv" are never misclassified.
 * `trailer` is handled separately (it also accepts `.`/`_`/space and standalone).
 * `sample` is intentionally absent — sample files stay filtered by the scanner's
 * sample skip rather than ingested as extras.
 */
const HYPHEN_EXTRA_SUFFIX_MAP: Record<string, ExtraType> = {
    behindthescenes: 'behind_the_scenes',
    deleted: 'deleted_scene',
    deletedscene: 'deleted_scene',
    featurette: 'featurette',
    interview: 'interview',
    scene: 'scene',
    clip: 'extra',
    short: 'short',
    other: 'extra',
    extra: 'extra',
};

export interface ParsedExtraName {
    extraType: ExtraType;
    /**
     * The stem before the recognized suffix — used to attach the extra to the
     * correct sibling primary when a folder holds several ("B-trailer.mkv" → "B",
     * "Best Movie (2019)-behindthescenes.mkv" → "Best Movie (2019)"). Empty for a
     * standalone extra ("trailer.mp4"), which has no specific sibling to match.
     */
    baseName: string;
}

/**
 * Parse a Jellyfin filename-suffix / single-file extra that sits DIRECTLY in a
 * media folder (not inside a named extras subfolder like `trailers/`) into its
 * type and base name.
 *
 * Jellyfin rules:
 *   - `trailer` matches standalone ("trailer.mp4") and after a `-`, `.`, `_` or
 *     space ("Preview.trailer.mkv", "Making Of trailer.mkv").
 *   - every other keyword (`-behindthescenes`, `-deleted`, `-deletedscene`,
 *     `-featurette`, `-interview`, `-scene`, `-clip`, `-short`, `-other`,
 *     `-extra`) requires a HYPHEN separator, so ordinary titles like
 *     "Crime Scene.mkv" are never misclassified.
 *
 * Returns null when the file is a normal media file.
 */
export function parseExtraFilename(filename: string): ParsedExtraName | null {
    const stem = basename(filename).trim();
    if (stem.toLowerCase() === 'trailer') return { extraType: 'trailer', baseName: '' };
    // Trailer: -/./_/space separator; base is everything before it.
    const trailerMatch = stem.match(/^(.*)[-._ ]trailer$/i);
    if (trailerMatch) return { extraType: 'trailer', baseName: trailerMatch[1].trim() };
    // Other keywords: hyphen separator only.
    const m = stem.match(/^(.*)-([a-z]+)$/i);
    if (m) {
        const type = HYPHEN_EXTRA_SUFFIX_MAP[m[2].toLowerCase()];
        if (type) return { extraType: type, baseName: m[1].trim() };
    }
    return null;
}

/**
 * Recognise a filename-suffix / single-file extra, returning just its ExtraType
 * (or null). Thin wrapper over {@link parseExtraFilename}.
 */
export function extraTypeFromFilename(filename: string): ExtraType | null {
    return parseExtraFilename(filename)?.extraType ?? null;
}

/**
 * True when an absolute (or root-relative) file path lives inside a named
 * extras subfolder (`trailers/`, `behind the scenes/`, …) or is itself a
 * Jellyfin filename-suffix / single-file extra (`Film-trailer.mkv`, standalone
 * `trailer.mp4`).
 *
 * Single source of truth for "is this path an extras path" across every
 * candidate-selection choke point that must never claim an extra as a primary
 * file/version: the disk walk (`walk-directory.ts`), file-reconcile's diff
 * (`file-reconcile.ts`'s `isExtrasPath`, which delegates here), the scanner's
 * DB-driven triage of known-but-unlinked `media_files` rows (`shared.ts`'s
 * `triageFiles`), and `processVideoFile`'s existing-file-unlinked fallthrough
 * (`video-processor.ts`) — each of those independently decides whether a path
 * is "new" to process, and any of them re-attaching an extra as a primary
 * version is the same bug class regardless of which one does it. A path that
 * matches is left for the dedicated `walkExtras` → `processExtra` pass, which
 * has the folder-listing context (sibling primary match) this cheap check
 * lacks. Pure — unit-testable. Pass `libraryRoot` whenever the caller knows it,
 * so the root's own path never counts.
 */
export function isExtrasFilePath(filePath: string, libraryRoot?: string): boolean {
    // Only the segments BELOW the library root say anything about extras: a
    // library at `/media/Shorts` or `/mnt/Extras/tv` holds primaries.
    let relative = filePath;
    if (libraryRoot) {
        const rel = path.relative(path.resolve(libraryRoot), path.resolve(filePath));
        if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) relative = rel;
    }
    const segments = relative.split(/[/\\]/).filter(Boolean);
    if (segments.some((seg) => EXTRAS_FOLDER_MAP[seg.toLowerCase()] !== undefined)) {
        return true;
    }
    const name = segments[segments.length - 1] ?? '';
    return extraTypeFromFilename(name) !== null;
}

/**
 * Folder names holding Jellyfin/Emby THEME assets — audio played while browsing
 * an item. Not media, not extras.
 */
const THEME_FOLDER_NAMES = new Set(['theme-music', 'theme music']);

/**
 * Whether a path is a Jellyfin/Emby theme asset: `theme.<ext>` beside an item,
 * or anything inside a `theme-music/` folder.
 *
 * These are a third category the scanner had no name for. They are not primary
 * media — nothing plays them from the library — and they are not extras, so the
 * extras pass never claimed them either. Owned by nobody, they made file-reconcile
 * loop forever: reconcile saw 76 `theme.mp3` on disk, found none of them in
 * `media_files`, handed them to file-delta-ingest, which reported them
 * "upserted" while persisting nothing — so the next cycle 5 minutes later found
 * the same 76 again. That ran every 5 minutes indefinitely on prod.
 *
 * Deliberately narrow. Video backdrops (`backdrops/`) are a separate concept and
 * are left alone here rather than folded in on the assumption they behave the same.
 */
export function isThemeAssetPath(filePath: string): boolean {
    const segments = filePath.split(/[/\\]/).filter(Boolean);
    if (segments.some((seg) => THEME_FOLDER_NAMES.has(seg.toLowerCase()))) return true;
    const name = (segments[segments.length - 1] ?? '').toLowerCase();
    return /^theme\.[a-z0-9]+$/.test(name);
}

/** Image extensions recognised for artwork scanning. */
export const ARTWORK_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

const STRONG_ALBUM_POSTER_TOKENS = new Set(['poster', 'cover', 'folder', 'front']);
const SUPPORTING_ALBUM_POSTER_TOKENS = new Set(['album', 'artwork', 'art', 'sleeve']);
const NON_POSTER_TOKENS = new Set([
    'back',
    'rear',
    'disc',
    'disk',
    'cd',
    'dvd',
    'booklet',
    'inlay',
    'inside',
    'tray',
    'label',
    'scan',
    'scans',
]);

function extname(filename: string): string {
    const dot = filename.lastIndexOf('.');
    return dot > 0 ? filename.slice(dot).toLowerCase() : '';
}

function basename(filename: string): string {
    const dot = filename.lastIndexOf('.');
    return dot > 0 ? filename.slice(0, dot) : filename;
}

function artworkStemTokens(stem: string): string[] {
    return stem
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function isNonPosterToken(token: string): boolean {
    return NON_POSTER_TOKENS.has(token.replace(/\d+$/, ''));
}

function scoreAlbumPosterFallback(filename: string): number | null {
    const stem = basename(filename);
    const tokens = artworkStemTokens(stem);
    const compact = tokens.join('');
    if (tokens.some(isNonPosterToken)) return null;

    let score = 0;
    if (
        tokens.some((token) => STRONG_ALBUM_POSTER_TOKENS.has(token)) ||
        compact.includes('frontcover') ||
        compact.includes('coverfront') ||
        compact.includes('albumcover') ||
        compact.includes('coverart')
    ) {
        score = 100;
    } else if (
        tokens.some((token) => SUPPORTING_ALBUM_POSTER_TOKENS.has(token)) ||
        compact.includes('albumart') ||
        compact.includes('artwork')
    ) {
        score = 60;
    }

    return score;
}

export function isArtworkImageName(filename: string): boolean {
    return ARTWORK_EXTENSIONS.has(extname(filename));
}

/**
 * Pick a direct album-folder image when no known poster filename was found.
 *
 * The scanner should self-heal common release layouts without turning random
 * booklet/disc/back scans into album posters. Accept only one uniquely
 * best-ranked candidate with cover/artwork naming hints.
 */
export function pickFallbackAlbumPosterImageName(filenames: string[]): string | null {
    const imageNames = filenames
        .filter(isArtworkImageName)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    if (imageNames.length === 0) return null;

    const scored = imageNames.flatMap((name) => {
        const score = scoreAlbumPosterFallback(name);
        return score === null ? [] : [{ name, score }];
    });
    if (scored.length === 0) return null;

    const bestScore = Math.max(...scored.map((candidate) => candidate.score));
    const best = scored.filter((candidate) => candidate.score === bestScore);
    if (best.length !== 1) return null;
    if (bestScore > 0) return best[0].name;
    return null;
}

/**
 * Derive ArtworkType from a filename stem (without extension).
 * Returns null for unrecognised stems.
 *
 * Covers the Jellyfin/Kodi/Plex local-artwork filename conventions, mapped onto
 * the five artwork types we store. `fanart`/`background`/`art` are Kodi-standard
 * backdrop aliases; `default`/`movie`/`show`/`jacket` are poster aliases;
 * `clearlogo` is a logo alias. (Jellyfin's `disc`/`clearart`/`discart` have no
 * matching stored type and are official-client-unused, so they stay unrecognised.)
 *
 * Examples:
 *   'folder'    → 'poster'
 *   'fanart'    → 'backdrop'
 *   'backdrop1' → 'backdrop'
 *   'clearlogo' → 'logo'
 *   'landscape' → 'backdrop'
 *   'banner'    → 'banner'
 */
/** Iteration order for the materializable types (stable; used by admin reports). */
export const MATERIALIZABLE_ARTWORK_TYPES: ReadonlyArray<MaterializableArtworkType> = [
    'poster',
    'backdrop',
    'logo',
    'thumb',
];

/**
 * artwork_type -> the two JSONB keys that carry its path in
 * `provider_metadata.metadata`.
 *
 * NOT a `${type}_path` template: `thumb` maps to `still_path` /
 * `artwork->>'still'`. Mirrors `catalog-operations.queries.ts:388-394` exactly.
 * SQL usage is always:
 *   COALESCE(pm.metadata->>'<pathKey>', pm.metadata->'artwork'->>'<artworkKey>')
 */
export const ARTWORK_TYPE_TO_PROVIDER_KEYS: Readonly<
    Record<MaterializableArtworkType, { readonly pathKey: string; readonly artworkKey: string }>
> = {
    poster: { pathKey: 'poster_path', artworkKey: 'poster' },
    backdrop: { pathKey: 'backdrop_path', artworkKey: 'backdrop' },
    logo: { pathKey: 'logo_path', artworkKey: 'logo' },
    thumb: { pathKey: 'still_path', artworkKey: 'still' },
};

/**
 * TMDB CDN size token used when building the absolute URL to fetch. Only the
 * PATH is stored in `provider_metadata`; the size is a per-request decision
 * (cf. `getImageSize`, `tmdb.provider.ts:652`).
 */
export const ARTWORK_TYPE_TO_TMDB_SIZE: Readonly<Record<MaterializableArtworkType, string>> = {
    poster: 'w342',
    backdrop: 'w780',
    logo: 'w300',
    thumb: 'w300',
};

/**
 * THE provenance convention for provider-materialized artwork.
 *
 * `isManagedArtworkFile` (media-image-storage.service.ts:79-89) recognises exactly
 * three prefixes: 'admin:', 'provider:', 'generated:'. A tag like 'tmdb:season' is
 * classified UNMANAGED, so admin "Remove" tombstones the row and leaves our file in
 * the user's media folder forever. Every write from this feature uses this helper.
 *
 * `providerName` is the `provider` column value of the provider_metadata row the
 * path was read from (e.g. 'aggregated', 'tmdb', 'tvdb') — NOT a hardcoded 'tmdb'.
 */
export function providerSourceTag(
    providerName: string,
    artworkType: MaterializableArtworkType,
): string {
    return `provider:${providerName}:${artworkType}`;
}

/**
 * The season/series filename-collision rule.
 *
 * When a season's resolved write directory equals its series' resolved write
 * directory (a season-folderless layout, `Show/S01E01.mkv`), both would land on
 * `poster.jpg` and the second write would clobber the first. The season takes a
 * qualified name instead — the same Sonarr/Kodi/Jellyfin convention
 * `seasonArtworkFromStem` parses, so the format round-trips.
 *
 * seasonNumber 0 -> 'season-specials-poster.jpg'; 1 -> 'season01-poster.jpg'.
 */
export function seasonArtworkFileName(
    artworkType: MaterializableArtworkType,
    seasonNumber: number,
    ext: string,
): string {
    const label =
        seasonNumber === 0 ? 'season-specials' : `season${String(seasonNumber).padStart(2, '0')}`;
    return `${label}-${artworkType}${ext}`;
}

/**
 * Stem -> artwork type, in PREFERENCE ORDER within each type.
 *
 * ONE ordered table drives two answers that must never disagree:
 * {@link artworkTypeFromStem} returns the type of the first entry that matches,
 * and {@link artworkStemRank} returns that entry's index. Two separate lists —
 * one classifying, one ranking — is exactly the drift this avoids: a stem added
 * to the classifier but forgotten by the ranker would silently sort last and
 * quietly change which file a directory's artwork resolves to.
 *
 * WITHIN a type the order is a real decision, because the conflict key on
 * media_artwork is (item, type, source, language): a directory holding two
 * stems of one type has two candidates for ONE row, and whichever the walker
 * offers last wins. Production carries 3,426 such directories across five
 * libraries — 1,600 of them holding all three of backdrop/backdrop1/landscape.
 *
 * The stem that EQUALS the type name is always first, for a concrete reason:
 * that is the filename this application writes when it materializes provider
 * artwork (`${artworkType}${ext}`, media-image-storage.service.ts:796). Ranking
 * it first keeps our own managed file the chosen one, so its `provider:` tag
 * survives and `isManagedArtworkFile` keeps classifying it correctly. Losing
 * that tag is what lets admin "Remove" strand a materialized file in the user's
 * media folder forever.
 *
 * After it come the well-known foreign primaries (Kodi's `fanart`, Windows'
 * `folder`), and last the NUMBERED variants — `fanart1`/`backdrop2` are
 * *additional* images by convention, never the primary, so they must never beat
 * a primary of any spelling.
 *
 * ACROSS types the order is load-bearing in one place only: the `poster` prefix
 * catch-all must stay last in its type so exact matches win, and no other type
 * owns a poster-prefixed stem. Reordering entries WITHIN a type cannot change
 * what {@link artworkTypeFromStem} returns — they all map to the same type — so
 * the music callsites locked by media-extras.test.ts are unaffected.
 */
const ARTWORK_STEM_RULES: ReadonlyArray<{
    readonly match: (lower: string) => boolean;
    readonly type: ArtworkType;
}> = [
    // poster — `poster` first: what we materialize.
    { match: (l) => l === 'poster', type: 'poster' },
    { match: (l) => l === 'folder', type: 'poster' },
    { match: (l) => l === 'cover', type: 'poster' },
    { match: (l) => l === 'front', type: 'poster' },
    { match: (l) => l === 'default', type: 'poster' },
    { match: (l) => l === 'movie', type: 'poster' },
    { match: (l) => l === 'show', type: 'poster' },
    { match: (l) => l === 'jacket', type: 'poster' },
    // Catch-all for `poster-en`, `poster2`, … — must stay last among posters.
    { match: (l) => l.startsWith('poster'), type: 'poster' },

    // backdrop — `backdrop` first: what we materialize.
    { match: (l) => l === 'backdrop', type: 'backdrop' },
    { match: (l) => l === 'fanart', type: 'backdrop' },
    { match: (l) => l === 'background', type: 'backdrop' },
    { match: (l) => l === 'art', type: 'backdrop' },
    { match: (l) => l === 'landscape', type: 'backdrop' },
    // Numbered variants are additional art by convention, never the primary.
    { match: (l) => /^backdrop\d+$/.test(l), type: 'backdrop' },
    { match: (l) => /^fanart\d+$/.test(l), type: 'backdrop' },

    { match: (l) => l === 'logo', type: 'logo' },
    { match: (l) => l === 'clearlogo', type: 'logo' },

    { match: (l) => l === 'thumb', type: 'thumb' },
    { match: (l) => l === 'banner', type: 'banner' },
];

export function artworkTypeFromStem(stem: string): ArtworkType | null {
    const lower = stem.toLowerCase();
    return ARTWORK_STEM_RULES.find((r) => r.match(lower))?.type ?? null;
}

/**
 * How strongly this stem should be preferred when a directory offers several
 * files of the SAME artwork type. Lower wins; an unrecognised stem sorts last.
 *
 * Only meaningful between stems of one type — see {@link ARTWORK_STEM_RULES}.
 */
export function artworkStemRank(stem: string): number {
    const lower = stem.toLowerCase();
    const i = ARTWORK_STEM_RULES.findIndex((r) => r.match(lower));
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/**
 * The four artwork types this codebase can materialize from a provider path.
 * `banner` is deliberately excluded: it has no provider metadata key and no
 * `custom_*_url` column on `media_items`.
 */
export type MaterializableArtworkType = Extract<
    ArtworkType,
    'poster' | 'backdrop' | 'logo' | 'thumb'
>;

/**
 * `season01-poster` / `season-specials-poster` — the FLAT season-artwork
 * convention Sonarr, Kodi and Jellyfin write into the SERIES root rather than
 * into a season folder.
 *
 * Deliberately a SEPARATE classifier from `artworkTypeFromStem`, not a widening
 * of it: that function is also called on album image names by the music scanner
 * (`findSingleDirectAlbumImage` in `audio-processor.ts` and
 * `albumDirHasDirectArtworkCandidate` in `file-scanner.ts`), and coupling the
 * season convention to those callsites buys nothing.
 *
 * Shape: `season` + optional separator + (`NN` | `specials`) + `-` + a stem the
 * primary classifier recognises. The suffix is delegated to `artworkTypeFromStem`
 * so the Kodi aliases (`fanart` -> backdrop, `clearlogo` -> logo, …) work here
 * for free and the two classifiers can never disagree about a type name.
 * `banner` is rejected because it is not a `MaterializableArtworkType`, so a
 * `season01-banner.jpg` stays unrecognised exactly as it is today.
 *
 * Examples:
 *   'season01-poster'         -> { artworkType: 'poster',   seasonNumber: 1 }
 *   'season-specials-poster'  -> { artworkType: 'poster',   seasonNumber: 0 }
 *   'season00-poster'         -> { artworkType: 'poster',   seasonNumber: 0 }
 *   'season12-fanart'         -> { artworkType: 'backdrop', seasonNumber: 12 }
 *   'season-all-poster'       -> null   (names no single season)
 *   'season01-banner'         -> null
 *   'poster'                  -> null   (handled by artworkTypeFromStem)
 */
const SEASON_ARTWORK_STEM_RE = /^season[-_ ]?(\d{1,3}|specials)-(.+)$/i;

export function seasonArtworkFromStem(stem: string): {
    artworkType: MaterializableArtworkType;
    seasonNumber: number;
    /**
     * The part after the season label — `poster` in `season01-poster`.
     *
     * Returned because the suffix accepts every alias the plain form does
     * (`season01-folder` classifies as a poster too), so a directory can hold
     * two season files competing for ONE row exactly as the plain forms can.
     * The walker ranks on this with {@link artworkStemRank}; ranking on the
     * resolved TYPE instead would score every alias identically and let the
     * filename tiebreak pick `folder` over `poster`.
     */
    suffix: string;
} | null {
    const match = SEASON_ARTWORK_STEM_RE.exec(stem.trim());
    if (!match) return null;
    const [, label, suffix] = match;
    const seasonNumber = label.toLowerCase() === 'specials' ? 0 : Number.parseInt(label, 10);
    const artworkType = artworkTypeFromStem(suffix);
    // `banner` has no place in this feature (no provider key, no custom_*_url).
    if (!artworkType || artworkType === 'banner') return null;
    return { artworkType, seasonNumber, suffix };
}
