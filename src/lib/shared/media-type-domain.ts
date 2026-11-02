// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * THE media-type domain. One module owns the vocabulary, one module owns every
 * mapping between vocabularies.
 *
 * ## Why this module exists
 *
 * Media-type narrowing used to be **lossy, total, and silent**. Every converter
 * in the codebase had this shape:
 *
 * ```ts
 * if (isEpisode(x)) return 'episode';
 * if (isSeries(x))  return 'tv';
 * return 'movie';          // "I don't know" spelled 'movie'
 * ```
 *
 * That shape produced three production bugs in a single afternoon:
 *
 * 1. **Unknown became a confident wrong answer.** No union member meant
 *    "unrepresentable", so every unmapped type became a movie. Audiobooks
 *    rendered as movie cards, opened the movie modal, and offered "Watch Movie".
 * 2. **Adding a media type was invisible.** Nothing failed at compile time —
 *    `audiobook` quietly became `movie` in ~30 places.
 * 3. **Downstream guards became dead code.** `isAudiobook(normalizeMediaType(x))`
 *    type-checks and can never be true, because the normalizer already returned
 *    `'movie'`. This is the dangerous one: it is unreviewable locally, and it is
 *    why an earlier fix that read correctly at the point of inspection changed
 *    nothing in production.
 *
 * ## The three rules this module enforces
 *
 * 1. **{@link MediaTypeInternal} is the single source of truth** for what a
 *    `media_items.media_type` can be. It is derived from the DB CHECK constraint
 *    `media_items_media_type_check` — see {@link INTERNAL_MEDIA_TYPES}. A unit
 *    test parses the constraint out of the base schema and asserts set equality,
 *    so the union cannot drift from the database.
 *
 * 2. **Every mapping is a `Record<MediaTypeInternal, X | null>` lookup table,
 *    never an if/else chain and never a `switch` with a `default:` arm.** Adding
 *    a member to {@link INTERNAL_MEDIA_TYPES} is therefore a **compile error at
 *    every mapping table in this file** until somebody decides what it maps to.
 *    That is the entire point: the decision is forced, not defaulted.
 *
 * 3. **Narrowing returns `| null`. No converter invents a fallback.** `null`
 *    means "this type is not representable in the target vocabulary". Callers
 *    choose explicitly: drop the item, or substitute with a documented reason.
 *    Per the repo's existing precedent, dropping is usually right — *a card the
 *    client cannot open is worse than no card*.
 *
 * ## Adding a new media type — the checklist
 *
 * 1. Widen the DB CHECK constraint in a migration (and register it in
 *    `migrate-schema.ts`).
 * 2. Add the value to {@link INTERNAL_MEDIA_TYPES}.
 * 3. `npm run typecheck` — every table below now errors. Fill each one in.
 *    A `null` is a legitimate answer and means "not representable here".
 * 4. If you gave it a non-null public / universal / api mapping, widen the
 *    corresponding Zod mirror **in the same change** (`publicMediaTypeSchema`,
 *    `UniversalMediaTypeSchema`, `ApiMediaTypeSchema` — all in `$lib/schemas/`),
 *    or the value will fail response validation at runtime.
 *
 * This module is client-safe: pure string/table work, no server imports.
 */

import type { PublicMediaType } from '$lib/schemas/common';
import type { ApiMediaType } from '$lib/schemas/api-common-responses';
import type { UniversalMediaType } from '$lib/schemas/api-responses';

// =============================================================================
// THE CANONICAL INTERNAL VOCABULARY
// =============================================================================

/**
 * Every value `media_items.media_type` may hold.
 *
 * **Source of truth: the DB CHECK constraint `media_items_media_type_check`.**
 * Do not add a value here that the constraint would reject, and do not widen the
 * constraint without adding the value here — `media-type-domain.test.ts` parses
 * the constraint out of `base-schema-sql.ts` and fails on any divergence.
 *
 * Stored values are always **lowercase**. Jellyfin PascalCase (`'Movie'`,
 * `'Series'`), legacy UPPERCASE (`'MOVIE'`), and colloquial aliases (`'show'`,
 * `'film'`, `'song'`) are *input* conventions — run them through
 * {@link toInternalMediaType} first.
 *
 * Grouped for reading only; order is not semantic.
 */
export const INTERNAL_MEDIA_TYPES = [
    // Video entertainment
    'movie',
    'tv',
    'episode',
    'season',
    'extra',
    // Books / spoken word
    'audiobook',
    'book',
    'manga',
    'comic',
    'podcast',
    // Music hierarchy
    'artist',
    'album',
    'track',
    'audio',
    'music',
    // Live
    'tvchannel',
    'radio',
    // Non-entertainment library types (no provider matching)
    'home_video',
    'training',
    'educational',
    'personal',
    'product',
    // Storage-only / provider-leaked bookkeeping rows
    'anfragen',
    'sonarr',
    'radarr',
] as const;

/** The canonical internal media type — what the database stores. */
export type MediaTypeInternal = (typeof INTERNAL_MEDIA_TYPES)[number];

/** External-ID composite-key write contract. */
export type MediaTypeProvider =
    'movie' | 'tv' | 'episode' | 'season' | 'artist' | 'album' | 'track' | 'audiobook';

/**
 * TMDB's binary vocabulary. TMDB has exactly two entity namespaces; anything
 * that is not one of them has **no** TMDB representation, which is why every
 * conversion into this type is nullable.
 */
declare const MOVIE_OR_SERIES_BRAND: unique symbol;
declare const TMDB_MEDIA_TYPE_BRAND: unique symbol;
declare const API_MEDIA_TYPE_BRAND: unique symbol;
declare const DETAIL_MEDIA_TYPE_BRAND: unique symbol;
declare const PROVIDER_MEDIA_TYPE_BRAND: unique symbol;

/**
 * A raw comparator input excludes values that have already been projected into
 * a narrower vocabulary. The optional `never` properties keep ordinary
 * strings assignable while making branded projections incompatible.
 */
export type RawMediaTypeComparatorInput = string & {
    readonly [MOVIE_OR_SERIES_BRAND]?: never;
    readonly [TMDB_MEDIA_TYPE_BRAND]?: never;
    readonly [API_MEDIA_TYPE_BRAND]?: never;
    readonly [DETAIL_MEDIA_TYPE_BRAND]?: never;
    readonly [PROVIDER_MEDIA_TYPE_BRAND]?: never;
};

/** TMDB's binary vocabulary, branded after projection from an internal type. */
export type MediaTypeTmdb = ('movie' | 'tv') & {
    readonly [TMDB_MEDIA_TYPE_BRAND]: 'tmdb';
};

/**
 * The discriminators a "media detail" surface can carry — the two video kinds
 * plus `'audiobook'`. Matches `MediaDetailSchema`'s discriminated union
 * (`MovieDetail | TvDetail | AudiobookDetail`).
 */
export type MediaTypeDetail = ('movie' | 'series' | 'audiobook') & {
    readonly [DETAIL_MEDIA_TYPE_BRAND]: 'detail';
};

/**
 * The binary public discriminator used by surfaces that genuinely only carry
 * movies and series.
 */
/** The binary movie/series vocabulary, branded after projection from an internal type. */
export type MediaTypeMovieOrSeries = ('movie' | 'series') & {
    readonly [MOVIE_OR_SERIES_BRAND]: 'movie-or-series';
};

/** API media-key discriminator, branded after projection from an internal type. */
export type MediaTypeApi = ApiMediaType & {
    readonly [API_MEDIA_TYPE_BRAND]: 'api';
};

type MediaTypeProviderValue =
    'movie' | 'tv' | 'episode' | 'season' | 'artist' | 'album' | 'track' | 'audiobook';

/** External-ID composite-key discriminator, branded after projection. */
export type MediaTypeProviderProjection = MediaTypeProviderValue & {
    readonly [PROVIDER_MEDIA_TYPE_BRAND]: 'provider';
};

/** Comparator inputs whose projections can still represent movie or series. */
export type VideoMediaTypeComparatorInput =
    | RawMediaTypeComparatorInput
    | MediaTypeMovieOrSeries
    | MediaTypeTmdb
    | MediaTypeApi
    | MediaTypeDetail
    | MediaTypeProviderProjection;

/** Comparator inputs whose projections can still represent an episode. */
export type EpisodeMediaTypeComparatorInput =
    RawMediaTypeComparatorInput | MediaTypeApi | MediaTypeProviderProjection;

/** Comparator inputs whose projections can still represent a season. */
export type SeasonMediaTypeComparatorInput =
    RawMediaTypeComparatorInput | MediaTypeApi | MediaTypeProviderProjection;

/** Comparator inputs whose projections can still represent an audiobook. */
export type AudiobookMediaTypeComparatorInput =
    RawMediaTypeComparatorInput | MediaTypeDetail | MediaTypeProviderProjection;

const brandMovieOrSeries = (value: 'movie' | 'series'): MediaTypeMovieOrSeries =>
    value as MediaTypeMovieOrSeries;

const brandTmdbMediaType = (value: 'movie' | 'tv'): MediaTypeTmdb => value as MediaTypeTmdb;
const brandApiMediaType = (value: ApiMediaType): MediaTypeApi => value as MediaTypeApi;
const brandDetailMediaType = (value: 'movie' | 'series' | 'audiobook'): MediaTypeDetail =>
    value as MediaTypeDetail;
const brandProviderMediaType = (value: MediaTypeProviderValue): MediaTypeProviderProjection =>
    value as MediaTypeProviderProjection;

// =============================================================================
// EXHAUSTIVENESS
// =============================================================================

/**
 * Compile-time exhaustiveness guard. Reaching this at runtime means a value
 * escaped the type system (unvalidated external input, a stale cache, a DB row
 * written before a CHECK widening).
 *
 * Use INSTEAD of a `default:` arm. A `default:` arm silently absorbs new union
 * members; this one is a build error the moment a member is unhandled.
 *
 * ```ts
 * switch (kind) {
 *   case 'a': return 1;
 *   case 'b': return 2;
 *   default: return assertNever(kind, 'kind');   // errors if a case is missing
 * }
 * ```
 */
export function assertNever(value: never, context: string): never {
    throw new Error(`${context}: unhandled value ${JSON.stringify(value)}`);
}

// =============================================================================
// PARSING: arbitrary string → canonical internal type
// =============================================================================

const CANONICAL_LOOKUP: ReadonlySet<string> = new Set<string>(INTERNAL_MEDIA_TYPES);

/**
 * Type predicate for "this string is already a canonical internal media type".
 * Lowercase-sensitive — normalize first, or use {@link toInternalMediaType}.
 */
export function isInternalMediaType(value: string): value is MediaTypeInternal {
    return CANONICAL_LOOKUP.has(value);
}

/**
 * Foreign vocabularies folded onto the canonical internal type.
 *
 * Keys are **already lowercased**; the canonical values are matched before this
 * table is consulted, so a key that collides with a canonical value is dead.
 * That is deliberate for `'audio'`: Jellyfin's `Audio` item type means "a
 * track", and `'audio'` is *also* a canonical CHECK member, so the two cannot be
 * distinguished from the string alone. `'audio'` therefore stays canonical and
 * every table below maps it exactly like `'track'` — which is what the existing
 * `isAudio()` / `isAudioTrack()` guards already assumed.
 *
 * This table is EXACTLY the union of what the four deleted `normalizeMediaType`
 * implementations plus the old `toTmdbType` accepted — nothing was added while
 * consolidating them. Widening it widens what every boundary in the app will
 * swallow (including `media-key-parser`, which parses user-supplied route
 * params), so a new alias needs a caller that actually sends it.
 */
// The value type includes `undefined` on purpose. `noUncheckedIndexedAccess` is
// off in this project, so a plain `Record<string, MediaTypeInternal>` would make
// TypeScript believe every possible string is a key — and the `?? null` below,
// which is the entire safety net, would look like dead code to a reader and to
// any lint rule that flags unnecessary nullish coalescing.
const INPUT_ALIASES: Readonly<Record<string, MediaTypeInternal | undefined>> = {
    // Movie
    film: 'movie',
    // Series — Jellyfin 'Series', colloquial 'show', legacy library labels
    series: 'tv',
    show: 'tv',
    tvseries: 'tv',
    tvshows: 'tv',
    anime: 'tv',
    // Music — Jellyfin 'MusicAlbum'/'MusicArtist', music-UI 'song'
    song: 'track',
    musicalbum: 'album',
    musicartist: 'artist',
    // Live TV
    channel: 'tvchannel',
    livetv: 'tvchannel',
    // Requests
    request: 'anfragen',
};

/**
 * Parse ANY media-type-shaped string into the canonical internal type.
 *
 * Accepts every case convention (`'Movie'`, `'MOVIE'`, `'movie'`) and the
 * documented aliases in {@link INPUT_ALIASES}. Returns `null` for anything
 * unrecognised — an unknown string is **not** a movie.
 *
 * This replaces the four independent `normalizeMediaType()` implementations that
 * used to live in `api-transforms.ts`, `media-transformer.service.ts`,
 * `data-normalization.service.ts` and `tasks/context-primitives.ts`. Fixing one
 * of them never fixed the others — that duplication is a large part of why this
 * bug class kept shipping.
 *
 * @example
 *   toInternalMediaType('Series')    // 'tv'
 *   toInternalMediaType('AUDIOBOOK') // 'audiobook'
 *   toInternalMediaType('song')      // 'track'
 *   toInternalMediaType('nonsense')  // null
 */
export function toInternalMediaType(value: string | null | undefined): MediaTypeInternal | null {
    if (!value) return null;
    const lower = value.trim().toLowerCase();
    if (lower === '') return null;
    if (isInternalMediaType(lower)) return lower;
    return INPUT_ALIASES[lower] ?? null;
}

// =============================================================================
// MAPPING TABLES — exhaustive by construction
// =============================================================================
//
// Every table below is a `Record<MediaTypeInternal, … | null>`. Adding a member
// to INTERNAL_MEDIA_TYPES makes each of these a compile error ("Property 'x' is
// missing") until it is filled in. `null` = not representable in that
// vocabulary; the caller decides drop-vs-substitute.
//
// Do NOT rewrite any of these as a switch or an if/else chain. The whole
// guarantee lives in the object-literal completeness check.

/**
 * internal → {@link PublicMediaType} (`publicMediaTypeSchema`).
 *
 * `'tv'` is promoted to `'series'`: the stored token is never emitted publicly.
 * Storage-only and provider-leaked rows are `null` — they are not part of the
 * public API contract and must not appear in responses.
 */
const TO_PUBLIC: Readonly<Record<MediaTypeInternal, PublicMediaType | null>> = {
    movie: 'movie',
    tv: 'series',
    episode: 'episode',
    season: 'season',
    // An extra (trailer / featurette) is a child asset, not a catalog entity.
    extra: null,
    audiobook: 'audiobook',
    // Text books have no public reader surface yet.
    book: null,
    manga: null,
    comic: null,
    podcast: null,
    artist: 'artist',
    album: 'album',
    track: 'track',
    // See INPUT_ALIASES: 'audio' is a track by every other name.
    audio: 'track',
    // 'music' is a LIBRARY ROOT marker, not a playable entity.
    music: null,
    tvchannel: null,
    radio: null,
    home_video: null,
    training: null,
    educational: null,
    personal: null,
    product: null,
    anfragen: null,
    sonarr: null,
    radarr: null,
};

/**
 * internal → {@link UniversalMediaType} (`UniversalMediaTypeSchema`), the
 * client-side card/section vocabulary consumed by `UniversalMediaCard`.
 *
 * Emits `'series'` (not the legacy `'tv'`, which the schema still accepts) so
 * server-driven UI payloads carry one spelling. Note the union has **no member
 * for `season`** and none for the non-entertainment types — those are `null`,
 * and a card the client cannot open is worse than no card.
 */
const TO_UNIVERSAL: Readonly<Record<MediaTypeInternal, UniversalMediaType | null>> = {
    movie: 'movie',
    tv: 'series',
    episode: 'episode',
    // UniversalMediaType has no 'season' member.
    season: null,
    extra: null,
    audiobook: 'audiobook',
    book: null,
    manga: null,
    comic: null,
    podcast: null,
    artist: 'artist',
    album: 'album',
    track: 'track',
    audio: 'track',
    music: 'music',
    tvchannel: 'tvchannel',
    radio: null,
    home_video: null,
    training: null,
    educational: null,
    personal: null,
    product: null,
    anfragen: null,
    sonarr: null,
    radarr: null,
};

/**
 * internal → {@link MediaTypeMovieOrSeries}.
 *
 * This replaces `toPublicMovieOrSeries()`, whose `isSeries(x) ? 'series' :
 * 'movie'` body is the exact anti-pattern this module removes: it answered
 * `'movie'` for audiobooks, tracks, channels and home videos alike.
 *
 * **Episodes and seasons are `null` here, not `'series'`.** A surface asking
 * "movie or series?" wants a catalog-level entity; handing it an episode
 * mislabels a single episode as a whole show. Surfaces that must represent
 * episodes use {@link toPublicMediaType}.
 */
const TO_MOVIE_OR_SERIES: Readonly<Record<MediaTypeInternal, MediaTypeMovieOrSeries | null>> = {
    movie: brandMovieOrSeries('movie'),
    tv: brandMovieOrSeries('series'),
    episode: null,
    season: null,
    extra: null,
    audiobook: null,
    book: null,
    manga: null,
    comic: null,
    podcast: null,
    artist: null,
    album: null,
    track: null,
    audio: null,
    music: null,
    tvchannel: null,
    radio: null,
    home_video: null,
    training: null,
    educational: null,
    personal: null,
    product: null,
    anfragen: null,
    sonarr: null,
    radarr: null,
};

/**
 * internal → {@link MediaTypeDetail}, the `MediaDetailSchema` discriminator.
 *
 * ⚠️ Feed this the RAW `media_items.media_type`. Classifying an
 * already-normalized value is how the audiobook branch became unreachable code.
 */
const TO_DETAIL: Readonly<Record<MediaTypeInternal, MediaTypeDetail | null>> = {
    movie: brandDetailMediaType('movie'),
    tv: brandDetailMediaType('series'),
    // An episode/season detail is served by the series surface, not this one.
    episode: null,
    season: null,
    extra: null,
    audiobook: brandDetailMediaType('audiobook'),
    book: null,
    manga: null,
    comic: null,
    podcast: null,
    artist: null,
    album: null,
    track: null,
    audio: null,
    music: null,
    tvchannel: null,
    radio: null,
    home_video: null,
    training: null,
    educational: null,
    personal: null,
    product: null,
    anfragen: null,
    sonarr: null,
    radarr: null,
};

/**
 * internal → {@link ApiMediaType} (`ApiMediaTypeSchema`: movie | series |
 * episode | season). The `MediaKey` / composite-key token vocabulary.
 */
const TO_API: Readonly<Record<MediaTypeInternal, MediaTypeApi | null>> = {
    movie: brandApiMediaType('movie'),
    tv: brandApiMediaType('series'),
    episode: brandApiMediaType('episode'),
    season: brandApiMediaType('season'),
    extra: null,
    // ApiMediaType has no audiobook member — audiobooks are addressed by UUID.
    audiobook: null,
    book: null,
    manga: null,
    comic: null,
    podcast: null,
    artist: null,
    album: null,
    track: null,
    audio: null,
    music: null,
    tvchannel: null,
    radio: null,
    home_video: null,
    training: null,
    educational: null,
    personal: null,
    product: null,
    anfragen: null,
    sonarr: null,
    radarr: null,
};

/**
 * internal → {@link MediaTypeTmdb}: which TMDB namespace identifies this row.
 *
 * Episodes and seasons fold onto `'tv'` — their TMDB identity IS the parent
 * series' `tv` entity, which is what every TMDB endpoint and image path needs.
 *
 * Everything TMDB does not catalog is `null`. This is the fix for
 * `toTmdbType()`'s old `return 'movie'` tail, which cheerfully sent audiobook
 * and music rows to `/3/movie/{id}`.
 */
const TO_TMDB: Readonly<Record<MediaTypeInternal, MediaTypeTmdb | null>> = {
    movie: brandTmdbMediaType('movie'),
    tv: brandTmdbMediaType('tv'),
    episode: brandTmdbMediaType('tv'),
    season: brandTmdbMediaType('tv'),
    // An extra hangs off a parent; it has no TMDB identity of its own here.
    extra: null,
    audiobook: null,
    book: null,
    manga: null,
    comic: null,
    podcast: null,
    artist: null,
    album: null,
    track: null,
    audio: null,
    music: null,
    tvchannel: null,
    radio: null,
    home_video: null,
    training: null,
    educational: null,
    personal: null,
    product: null,
    anfragen: null,
    sonarr: null,
    radarr: null,
};

/**
 * internal → {@link MediaTypeProvider}, the `external_ids.media_type` composite
 * key component.
 */
const TO_PROVIDER: Readonly<Record<MediaTypeInternal, MediaTypeProviderProjection | null>> = {
    movie: brandProviderMediaType('movie'),
    tv: brandProviderMediaType('tv'),
    episode: brandProviderMediaType('episode'),
    season: brandProviderMediaType('season'),
    extra: null,
    audiobook: brandProviderMediaType('audiobook'),
    book: null,
    manga: null,
    comic: null,
    podcast: null,
    artist: brandProviderMediaType('artist'),
    album: brandProviderMediaType('album'),
    track: brandProviderMediaType('track'),
    audio: brandProviderMediaType('track'),
    music: null,
    tvchannel: null,
    radio: null,
    home_video: null,
    training: null,
    educational: null,
    personal: null,
    product: null,
    anfragen: null,
    sonarr: null,
    radarr: null,
};

/**
 * internal → "does provider metadata matching apply to this type at all?"
 *
 * Non-entertainment library content (home videos, training material, personal
 * media, products) is deliberately never matched against TMDB and friends.
 */
const IS_PROVIDER_MATCHABLE: Readonly<Record<MediaTypeInternal, boolean>> = {
    movie: true,
    tv: true,
    episode: true,
    season: true,
    extra: false,
    audiobook: true,
    book: true,
    manga: true,
    comic: true,
    podcast: true,
    artist: true,
    album: true,
    track: true,
    audio: true,
    music: false,
    tvchannel: false,
    radio: false,
    home_video: false,
    training: false,
    educational: false,
    personal: false,
    product: false,
    anfragen: false,
    sonarr: false,
    radarr: false,
};

// =============================================================================
// TABLE ACCESSORS (internal type in — already parsed)
// =============================================================================

/** internal → public discriminator, or `null` if not publicly representable. */
export function publicTypeOf(type: MediaTypeInternal): PublicMediaType | null {
    return TO_PUBLIC[type];
}

/** internal → UniversalMediaType, or `null` if the client cannot render it. */
export function universalTypeOf(type: MediaTypeInternal): UniversalMediaType | null {
    return TO_UNIVERSAL[type];
}

/** internal → `'movie' | 'series'`, or `null` if it is neither. */
export function movieOrSeriesOf(type: MediaTypeInternal): MediaTypeMovieOrSeries | null {
    return TO_MOVIE_OR_SERIES[type];
}

/** internal → detail-surface discriminator, or `null` if it has no detail page. */
export function detailTypeOf(type: MediaTypeInternal): MediaTypeDetail | null {
    return TO_DETAIL[type];
}

/** internal → ApiMediaType, or `null` if the API vocabulary has no member. */
export function apiTypeOf(type: MediaTypeInternal): MediaTypeApi | null {
    return TO_API[type];
}

/** internal → TMDB namespace, or `null` if TMDB does not catalog this type. */
export function tmdbTypeOf(type: MediaTypeInternal): MediaTypeTmdb | null {
    return TO_TMDB[type];
}

/** internal → external-ID composite-key type, or `null` if not identifiable. */
export function providerTypeOf(type: MediaTypeInternal): MediaTypeProviderProjection | null {
    return TO_PROVIDER[type];
}

/** Whether provider metadata matching applies to this type. */
export function isProviderMatchable(type: MediaTypeInternal): boolean {
    return IS_PROVIDER_MATCHABLE[type];
}

// =============================================================================
// STRING-IN CONVENIENCE WRAPPERS (parse, then map)
// =============================================================================
//
// These are what most call sites want: they take a raw DB / API / Jellyfin
// string and return the target vocabulary or `null`. `null` covers BOTH
// "unparseable" and "parsed but not representable" — from the caller's point of
// view those are the same decision.

/**
 * Raw string → {@link PublicMediaType}, or `null`.
 *
 * The single canonical replacement for the ~9 ad-hoc `toPublicType` /
 * `canonicalMediaType` / `toCatalogType` copies that used to live per-route.
 *
 * @example
 *   toPublicMediaType('tv')        // 'series'
 *   toPublicMediaType('audiobook') // 'audiobook'
 *   toPublicMediaType('tvchannel') // null
 */
export function toPublicMediaType(value: string | null | undefined): PublicMediaType | null {
    const internal = toInternalMediaType(value);
    return internal === null ? null : publicTypeOf(internal);
}

/**
 * Raw string → {@link UniversalMediaType}, or `null` if the client has no card
 * for it. Drop the item on `null`.
 */
export function toUniversalMediaType(value: string | null | undefined): UniversalMediaType | null {
    const internal = toInternalMediaType(value);
    return internal === null ? null : universalTypeOf(internal);
}

/**
 * Raw string → `'movie' | 'series'`, or `null`.
 *
 * Replaces `toPublicMovieOrSeries()`. If you are reaching for `?? 'movie'` here,
 * stop and check whether the surface can actually receive an audiobook, track or
 * channel row — if it can, dropping is almost always the right answer.
 */
export function toMovieOrSeries(value: string | null | undefined): MediaTypeMovieOrSeries | null {
    const internal = toInternalMediaType(value);
    return internal === null ? null : movieOrSeriesOf(internal);
}

/**
 * Raw string → {@link MediaTypeDetail}, or `null`.
 *
 * ⚠️ Must be handed the RAW `media_items.media_type`, never an already-mapped
 * value.
 */
export function toDetailMediaType(value: string | null | undefined): MediaTypeDetail | null {
    const internal = toInternalMediaType(value);
    return internal === null ? null : detailTypeOf(internal);
}

/** Raw string → {@link ApiMediaType}, or `null`. */
export function toApiMediaType(value: string | null | undefined): MediaTypeApi | null {
    const internal = toInternalMediaType(value);
    return internal === null ? null : apiTypeOf(internal);
}

/**
 * Raw string → TMDB namespace, or `null` when TMDB has no such entity.
 *
 * Replaces the old total `toTmdbType()`. A `null` here means "do not call TMDB
 * and do not build a TMDB image path for this row".
 */
export function toTmdbMediaType(value: string | null | undefined): MediaTypeTmdb | null {
    const internal = toInternalMediaType(value);
    return internal === null ? null : tmdbTypeOf(internal);
}

/** Raw string → external-ID composite-key media type, or `null`. */
export function toProviderMediaType(
    value: string | null | undefined,
): MediaTypeProviderProjection | null {
    const internal = toInternalMediaType(value);
    return internal === null ? null : providerTypeOf(internal);
}
