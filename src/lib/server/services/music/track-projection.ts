// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * track-projection.ts — shared `toMusicTrack` + `extractAudioFeatures`.
 *
 * Single authoritative implementation of the DB row → `MusicTrack` projection
 * shared across all callers.
 *
 * Callers:
 *   - src/lib/server/services/music/recommendations.service.ts (QueueCandidateRow)
 *   - src/lib/server/api/defs/music/recommendations.ts (QueueCandidateRow)
 *   - src/routes/api/music/tracks/[id]/+server.ts     (TrackDetailRow)
 *   - src/lib/server/api/defs/music/sessions.ts       (v1 sessions def)
 *
 * The input type is intentionally loose (`Record<string, unknown>`) so this
 * module does not create a circular import chain through the query layer.
 * Type safety is enforced by the schema-validated output (`MusicTrack`).
 */

import type { MusicTrack } from '$lib/schemas/music.js';
import type {
    TrackAudioFeatures as AudioFeatures,
    Artist,
    ArtistSummary,
    Album,
    AlbumSummary,
} from '$lib/schemas/api-music-dto.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { LyricsSchema } from '$lib/schemas/music-metadata.js';
import {
    artistEnrichmentDisplay,
    projectDiscogsAttribution,
    validDiscogsCatalogueUrl,
} from '$lib/shared/music-provenance.js';
import { parseMusicChapters } from '$lib/utils/music-track-metadata.js';
import { effectiveArtistKey, primaryCreditArtistName } from '$lib/server/utils/music-artist-key.js';

// ---------------------------------------------------------------------------
// Essentia extraction
// ---------------------------------------------------------------------------

/**
 * Pull the Essentia block out of `custom_metadata` and cast it to a typed
 * `AudioFeatures` object.  Returns `undefined` when no audio analysis data
 * is present (cold start / not yet analyzed).
 *
 * The `ess.beat_grid` / `ess.energy_curve` / `ess.vocal_*` fields intentionally
 * include ALL fields defined in `AudioFeaturesSchema` — previously the queue
 * path silently dropped `beat_grid`, `energy_curve`, `vocal_instrumental`,
 * `dj_intro_end_ms`, `outro_source`, and `intro_end_ms`.
 */
export function extractAudioFeatures(
    customMetadata: Record<string, unknown> | null | undefined,
): AudioFeatures | undefined {
    if (!customMetadata) return undefined;
    const raw = customMetadata.essentia;
    if (!raw || typeof raw !== 'object') return undefined;
    const ess = raw as Record<string, unknown>;

    const rawBpm = ess.bpm;
    const bpm: number | undefined =
        typeof rawBpm === 'number'
            ? rawBpm
            : typeof rawBpm === 'string'
              ? parseFloat(rawBpm) || undefined
              : undefined;

    const hasAnyAudioData =
        bpm !== undefined ||
        ess.key !== undefined ||
        ess.energy !== undefined ||
        ess.mood_tags !== undefined;

    if (!hasAnyAudioData) return undefined;

    const numberOrUndefined = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const numberArrayOrUndefined = (value: unknown): number[] | undefined =>
        Array.isArray(value)
            ? value.filter((item): item is number => typeof item === 'number')
            : undefined;
    const stringArrayOrUndefined = (value: unknown): string[] | undefined =>
        Array.isArray(value)
            ? value.filter((item): item is string => typeof item === 'string')
            : undefined;

    return {
        bpm,
        key: typeof ess.key === 'string' ? ess.key : undefined,
        energy: numberOrUndefined(ess.energy),
        danceability: numberOrUndefined(ess.danceability),
        loudnessLufs: numberOrUndefined(ess.loudness_lufs),
        beatGrid: numberArrayOrUndefined(ess.beat_grid),
        downbeats: numberArrayOrUndefined(ess.downbeats),
        introEndMs: numberOrUndefined(ess.intro_end_ms),
        outroStartMs: numberOrUndefined(ess.outro_start_ms),
        outroSource:
            ess.outro_source === 'downbeat' ||
            ess.outro_source === 'percentage' ||
            ess.outro_source === 'fade' ||
            ess.outro_source === 'dj-outro'
                ? ess.outro_source
                : undefined,
        energyCurve: numberArrayOrUndefined(ess.energy_curve),
        moodTags: stringArrayOrUndefined(ess.mood_tags),
        vocalInstrumental:
            ess.vocal_instrumental === 'voice' || ess.vocal_instrumental === 'instrumental'
                ? ess.vocal_instrumental
                : undefined,
        vocalConfidence: numberOrUndefined(ess.vocal_confidence),
        djIntroEndMs: numberOrUndefined(ess.dj_intro_end_ms),
        firstVocalStartMs: numberOrUndefined(ess.first_vocal_start_ms),
        lastVocalEndMs: numberOrUndefined(ess.last_vocal_end_ms),
    };
}

// ---------------------------------------------------------------------------
// Row shape accepted by toMusicTrack
// ---------------------------------------------------------------------------

/**
 * Minimal DB row shape accepted by `toMusicTrack`.
 *
 * The three different row types (QueueCandidateRow, TrackDetailRow, SonicRow)
 * all satisfy this interface so `toMusicTrack` handles all of them.
 */
export interface MusicTrackRow {
    id: string;
    title: string;
    custom_metadata: Record<string, unknown> | null;
    /** Resolved artist title (from the artist media_items row) */
    artist_title?: string | null;
    /** Resolved artist UUID */
    artist_id?: string | null;
    /** Resolved album title */
    album_title?: string | null;
    /** Parent media_items id (album for tracks, artist for albums) */
    parent_id?: string | null;
    /** Track runtime in seconds */
    runtime_seconds?: number | null;
    /** Legacy resolved_artist field (QueueCandidateRow / SonicQueueCandidateRow) */
    resolved_artist?: string | null;
    /** Legacy resolved_artist_id field */
    resolved_artist_id?: string | null;
    /** Album id resolved from parent chain (TrackDetailRow) */
    album_id?: string | null;
    /** Release year off the parent album row (TrackDetailRow). */
    album_year?: number | null;
    /** Structured track artists in display order. */
    track_artist_id?: string | null;
    track_artist_title?: string | null;
    year?: number | null;
    sort_order?: number | null;
    media_type?: string;
    album_artist_id?: string | null;
    album_artist_title?: string | null;
    custom_poster_url?: string | null;
    own_custom_poster_url?: string | null;
    custom_backdrop_url?: string | null;
    album_custom_poster_url?: string | null;
    remixer_artists?: Array<{ id: string | null; title: string }> | null;
    track_artists?: Array<{ id: string | null; title: string }> | null;
}

// ---------------------------------------------------------------------------
// Genre / year
// ---------------------------------------------------------------------------

/**
 * Earliest plausible release year.
 *
 * Not paranoia: 166 prod tracks carry a literal `year: 1` from a tag-parse
 * artifact, and 20 albums are similarly out of range. Emitting those would
 * put "1" on a client's track detail screen, which reads as a bug in the
 * client rather than bad metadata. Anything outside the window is treated as
 * absent, so the client falls back to showing no year at all.
 */
const MIN_PLAUSIBLE_YEAR = 1860;

/**
 * Years ahead of the current one that a tag may name. Pre-release and
 * forward-dated albums carry tags like `2030`; a bare `+1` window dropped them
 * on the album and track DTOs. Same allowance as the search-hint year window.
 * A far-future typo (e.g. `9999`) is still dropped.
 */
const FUTURE_YEARS = 5;

function maxPlausibleYear(): number {
    return new Date().getUTCFullYear() + FUTURE_YEARS;
}

function plausibleYear(value: unknown): number | undefined {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(n)) return undefined;
    const year = Math.trunc(n);
    return year >= MIN_PLAUSIBLE_YEAR && year <= maxPlausibleYear() ? year : undefined;
}

/**
 * Release year for a track: the track's own tag wins over the album's.
 *
 * A track-level year is the more specific claim — compilations and
 * soundtracks routinely carry per-track years that differ from the album's
 * release. The album year is the fallback, which is what covers the ~6% of
 * tracks with no year tag of their own.
 */
function extractYear(
    meta: Record<string, unknown>,
    albumYear: number | null | undefined,
): number | undefined {
    return plausibleYear(meta.year) ?? plausibleYear(albumYear);
}

/**
 * Genre tags for a track.
 *
 * `custom_metadata.genre` is a JSON array of strings for every track in the
 * corpus that has one. A bare string is still accepted and promoted to a
 * one-element array — tags come from files, and a scanner or a hand-edited
 * row can produce either — because emitting a string where the schema
 * declares `string[]` would fail the whole response decode on a strict
 * client.
 */
function extractGenre(meta: Record<string, unknown>): string[] | undefined {
    const raw = meta.genre ?? meta.genres;
    if (typeof raw === 'string') {
        const one = raw.trim();
        return one.length > 0 ? [one] : undefined;
    }
    if (!Array.isArray(raw)) return undefined;
    const tags = raw
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
    return tags.length > 0 ? tags : undefined;
}

// ---------------------------------------------------------------------------
// Main projection
// ---------------------------------------------------------------------------

function secondsToMs(seconds: number | null | undefined): number | null {
    return seconds == null ? null : Math.round(seconds * 1000);
}

/**
 * Project a DB row onto the public `MusicTrack` shape.
 *
 * Single authoritative implementation shared across all callers.
 *
 * @param images Artwork resolved in one batch by the async caller. Passed through unchanged.
 */
export function toMusicTrack(row: MusicTrackRow, images: ImageSet): MusicTrack {
    const meta = row.custom_metadata ?? {};

    // Prefer hierarchical artist/album fields (from joins in TrackDetailRow);
    // fall back to flat custom_metadata for queue rows that lack the join.
    const artistTitle =
        row.track_artist_title ??
        row.artist_title ??
        row.resolved_artist ??
        (typeof meta.artist === 'string' ? meta.artist : undefined) ??
        (typeof meta.album_artist === 'string' ? meta.album_artist : undefined) ??
        'Unknown Artist';

    const albumTitle = row.album_title ?? (typeof meta.album === 'string' ? meta.album : undefined);

    // An EMPTY credit list is "no canonical credits" (e.g. a file with only an
    // ALBUMARTIST tag): it falls back to the album artist like a missing key.
    const hasCanonicalCredits =
        (Array.isArray(meta.track_artist_credits) && meta.track_artist_credits.length > 0) ||
        Array.isArray(row.track_artists);
    const metadataArtists = Array.isArray(meta.artists)
        ? meta.artists
              .filter((artist): artist is string => typeof artist === 'string')
              .map((title) => ({ id: null, title }))
        : [];
    // An empty reconciled list means no performer was resolved. Legacy tags
    // and album ownership must not silently turn back into performer credits.
    const artistCandidates = hasCanonicalCredits
        ? (row.track_artists ?? [])
        : row.track_artists?.length
          ? row.track_artists
          : metadataArtists;
    const artists = artistCandidates
        .filter((artist) => artist.title.trim().length > 0)
        .map((artist) => ({
            id: artist.id ?? null,
            title: artist.title,
        }));

    // Same rule as `trackArtistIdSql`, applied on this side of the wire.
    //
    // `artists` comes from `trackArtistsSql`, which has NO name-match guard —
    // it returns every credited artist in tag order, and on a remix the first
    // of those is the remixer while `artistTitle` stays the original artist.
    // So taking `artists[0].id` reintroduces exactly the id/name disagreement
    // the SQL fragment removes, one layer up: measured on the production
    // library, 34 rows where the fragment now correctly yields NULL would come
    // back through here pointing somewhere the card never names
    // (Various Artists -> Tiesto, Various Artists -> Linden Vale).
    //
    // Normalisation mirrors the SQL: strip everything that is neither
    // alphanumeric nor a space, in a way that does not erase non-Latin
    // scripts, and refuse an empty needle — an empty string is contained in
    // every string, so an artist whose title normalises away would otherwise
    // match anything.
    const normalizeForNameMatch = (value: string): string =>
        value.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
    const shownNormalized = normalizeForNameMatch(artistTitle);
    const firstArtistId = artists.find((artist) => {
        if (!artist.id) return false;
        const candidate = normalizeForNameMatch(artist.title);
        return candidate.length > 0 && shownNormalized.includes(candidate);
    })?.id;
    const artistId = hasCanonicalCredits
        ? (artists[0]?.id ?? undefined)
        : (row.track_artist_id ??
          row.artist_id ??
          row.resolved_artist_id ??
          firstArtistId ??
          undefined);

    const albumId = row.album_id ?? row.parent_id ?? undefined;

    const genre = extractGenre(meta);
    const year = extractYear(meta, row.album_year ?? row.year);

    return {
        id: row.id,
        title: row.title,
        type: 'track' as const,
        artists:
            hasCanonicalCredits || artists.length > 0
                ? artists
                : [{ id: artistId ?? null, title: artistTitle }],
        ...(row.remixer_artists?.length ? { remixerArtists: row.remixer_artists } : {}),
        albumArtist:
            row.album_artist_id || row.album_artist_title || meta.album_artist
                ? {
                      id: row.album_artist_id ?? null,
                      title: row.album_artist_title ?? String(meta.album_artist ?? artistTitle),
                  }
                : null,
        album: albumId ? { id: albumId, title: albumTitle ?? 'Unknown Album' } : null,
        trackNumber: parseTagPosition(meta.track_number) ?? parseTagPosition(row.sort_order),
        discNumber: parseTagPosition(meta.disc_number),
        durationMs: secondsToMs(
            row.runtime_seconds ??
                (typeof meta.duration_seconds === 'number' ? meta.duration_seconds : null),
        ),
        genres: genre ?? [],
        year: year ?? null,
        images,
        isRadio: row.media_type === 'radio',
        lyrics: LyricsSchema.safeParse(meta.lyrics).success
            ? LyricsSchema.parse(meta.lyrics)
            : undefined,
        audioFeatures: extractAudioFeatures(meta),
        chapters: parseMusicChapters(meta.chapters),
    };
}

// ---------------------------------------------------------------------------
// Raw-row projection (album/artist detail responses)
// ---------------------------------------------------------------------------

/**
 * `custom_metadata` keys the album/artist detail responses are allowed to carry
 * verbatim. Mirrors `JsonMetadataSchema` in `$lib/schemas/api-music-responses.ts`,
 * minus `essentia` which is narrowed separately below.
 *
 * The client strips everything else at parse time regardless, so shipping it
 * only inflates the response: a 162-track compilation carried ~630 KB of
 * `essentia.beat_grid`, ~110 KB of `downbeats` and ~116 KB of `lyrics` that Zod
 * discarded on arrival (978 KB → 37 KB once dropped).
 */
const CLIENT_METADATA_KEYS = [
    'chapters',
    'album',
    'artist',
    'artists',
    'album_artist',
    'genre',
    'disc_number',
    'featuring_artists',
] as const;

/**
 * Essentia fields available in full-mode projection (16 fields).
 * Never includes `energy_curve` or `essentia_analyzed`.
 */
const FULL_ESSENTIA_KEYS = [
    'bpm',
    'key',
    'energy',
    'danceability',
    'loudness_lufs',
    'beat_grid',
    'downbeats',
    'intro_end_ms',
    'outro_start_ms',
    'mood_tags',
    'vocal_instrumental',
    'vocal_confidence',
    'outro_source',
    'dj_intro_end_ms',
    'first_vocal_start_ms',
    'last_vocal_end_ms',
] as const;

/**
 * Narrow a track's `custom_metadata` to the keys the client actually reads.
 *
 * `essentia` is reduced to `{bpm, loudness_lufs}` by default (narrow mode) —
 * the two fields AlbumModal can display. The full analysis block (beat_grid/
 * downbeats/energy_curve)
 * is NOT needed here: the player re-fetches it per track from
 * `/api/music/tracks/[id]` when a track becomes current, and
 * `hasCompleteTrackMetadata` requires `downbeats` to be populated, so an
 * album-modal row can never short-circuit that fetch.
 *
 * When `options.fullAudioFeatures` is true, returns all 16 Essentia fields
 * except `energy_curve` and `essentia_analyzed`.
 */
export function projectTrackMetadataForClient(
    customMetadata: Record<string, unknown> | null | undefined,
    options: { fullAudioFeatures?: boolean } = {},
): Record<string, unknown> {
    if (!customMetadata) return {};

    const out: Record<string, unknown> = {};
    for (const key of CLIENT_METADATA_KEYS) {
        if (customMetadata[key] !== undefined) out[key] = customMetadata[key];
    }

    const raw = customMetadata.essentia;
    if (raw && typeof raw === 'object') {
        const ess = raw as Record<string, unknown>;
        if (options.fullAudioFeatures) {
            const essentia: Record<string, unknown> = {};
            for (const key of FULL_ESSENTIA_KEYS) {
                // `null` must be skipped, not passed through. storeAnalysis()
                // writes dj_intro_end_ms / first_vocal_start_ms /
                // last_vocal_end_ms as `number | null`, and they are frequently
                // null in real data — but JsonMetadataSchema declares them
                // `z.number().int().optional()`, which rejects null. A null on
                // the wire fails mount()'s response-conformance check, which
                // silently DISABLES the stripping guard for that response.
                // Same "null and undefined both become absent" semantics as
                // extractAudioFeatures()'s numberOrUndefined() above, so a
                // client sees the identical absent-vs-present convention on
                // album/artist detail and on track detail.
                if (ess[key] !== undefined && ess[key] !== null) essentia[key] = ess[key];
            }
            if (Object.keys(essentia).length > 0) out.essentia = essentia;
        } else {
            const essentia: Record<string, number> = {};
            if (typeof ess.bpm === 'number') essentia.bpm = ess.bpm;
            if (typeof ess.loudness_lufs === 'number') {
                essentia.loudness_lufs = ess.loudness_lufs;
            }
            if (Object.keys(essentia).length > 0) out.essentia = essentia;
        }
    }

    return out;
}

interface ProjectableTrackRow {
    custom_metadata: Record<string, unknown>;
    file_path?: string | null;
}

/**
 * Project a raw track row for a client response: drop `file_path` and narrow
 * `custom_metadata`.
 *
 * `file_path` is selected by the query because the Subsonic compat layer needs
 * it to stream (`subsonic-compat/serializers/song.ts`, `handlers/stream.ts`),
 * but it must not leave the server on a browser-facing response — it is an
 * absolute host path, and the client schema never declared it.
 */

export function projectTrackRowForClient<T extends ProjectableTrackRow>(
    row: T,
    options: { fullAudioFeatures?: boolean } = {},
): Omit<T, 'file_path'> & { disc_number: number | null; track_number: number | null } {
    const { file_path: _filePath, ...rest } = row;
    return {
        ...rest,
        custom_metadata: projectTrackMetadataForClient(row.custom_metadata, options),
        disc_number: parseTagPosition(row.custom_metadata.disc_number),
        track_number: parseTagPosition(row.custom_metadata.track_number),
    };
}

/**
 * Normalise a disc/track tag to a positive integer, or null.
 *
 * `custom_metadata` is freeform jsonb: the scanner writes numbers, but older
 * ingests and admin bulk-metadata edits can leave strings, including the
 * ID3 "position/total" form ("2/3"). Only the leading position is kept.
 */
export function parseTagPosition(value: unknown): number | null {
    const n =
        typeof value === 'number'
            ? value
            : typeof value === 'string'
              ? Number.parseInt(value.trim(), 10)
              : Number.NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Diversity key helper (used by queue scoring for artist-cap logic)
// ---------------------------------------------------------------------------

/**
 * Stable artist diversity key for autoplay artist-cap enforcement.
 *
 * Uses lowercased artist name only — NOT the resolved_artist_id — so that
 * orphan tracks (artist_id NULL) land in the same key space as hierarchical
 * tracks when compared against `currentArtist`. Mixing UUID and name keys
 * silently bypasses the same-artist exclusion filter.
 */
export function musicArtistDiversityKey(row: MusicTrackRow): string {
    const meta = row.custom_metadata;
    const metaArtist =
        (meta?.artist as string | undefined) ?? (meta?.album_artist as string | undefined);
    return effectiveArtistKey({
        id: row.id,
        // Structured credit list first — see primaryCreditArtistName. The
        // display string is combined by design ("Eloren Ft 50 Sparks & Dr. Vale"),
        // which would give every credit line its own cap bucket.
        artistName:
            primaryCreditArtistName(row.track_artists) ??
            row.resolved_artist ??
            row.artist_title ??
            metaArtist,
        fallbackId: row.parent_id ?? undefined,
    });
}

/** DB vocabulary ends here. Explicit allowlists prevent storage fields leaking into JSON. */
interface MusicEntityRow {
    id: string;
    title: string;
    overview?: string | null;
    custom_metadata?: Record<string, unknown> | null;
    custom_poster_url?: string | null;
    own_custom_poster_url?: string | null;
    inherited_poster_credit_url?: string | null;
    custom_backdrop_url?: string | null;
    custom_logo_url?: string | null;
    album_count?: number;
    track_count?: number;
    is_various_artists?: boolean;
    artist_id?: string | null;
    artist_title?: string | null;
    parent_id?: string | null;
    year?: number | null;
    total_duration?: number | null;
    created_at?: string | Date | null;
}

export function toArtistSummary<T extends MusicEntityRow>(row: T, images: ImageSet): ArtistSummary {
    return {
        id: row.id,
        type: 'artist',
        title: row.title,
        images,
        albumCount: row.album_count ?? 0,
        trackCount: row.track_count ?? 0,
        isVariousArtists: row.is_various_artists ?? false,
    };
}

export function toArtist<T extends MusicEntityRow>(row: T, images: ImageSet): Artist {
    const meta = row.custom_metadata ?? {};
    const display = artistEnrichmentDisplay(meta, row.overview ?? null);
    const enrichment =
        meta.artist_enrichment && typeof meta.artist_enrichment === 'object'
            ? (meta.artist_enrichment as Record<string, unknown>)
            : {};
    const country = meta.country_code ?? meta.country ?? enrichment.country_code;
    return {
        ...toArtistSummary(row, images),
        discogsAttribution: projectDiscogsAttribution(meta, 'artist_enrichment', {
            biography: display.creditedBiography,
            genre: display.creditedGenre,
            country_code: meta.country_code || meta.country ? null : country,
            poster: row.custom_poster_url,
            backdrop: row.custom_backdrop_url,
            logo: row.custom_logo_url,
        }),
        biography: display.biography,
        genres: display.genres,
        countryCode: typeof country === 'string' ? country : null,
        addedAt: toIsoTimestamp(row.created_at),
    };
}

export function toAlbumSummary<T extends MusicEntityRow>(row: T, images: ImageSet): AlbumSummary {
    return {
        id: row.id,
        type: 'album',
        title: row.title,
        images,
        artist: {
            id: row.artist_id ?? row.parent_id ?? null,
            title: row.artist_title ?? 'Unknown Artist',
        },
        year: plausibleYear(row.year ?? row.custom_metadata?.year) ?? null,
        trackCount: row.track_count ?? 0,
        durationMs: secondsToMs(row.total_duration),
    };
}

/**
 * Normalise a DB timestamp to ISO 8601 for a public `…At` field.
 *
 * Queries select `created_at::text`, which Postgres renders as
 * "2026-09-12 15:03:43+02" (space separator, two-digit offset). Driver Date
 * values are passed through. Anything that does not parse becomes null rather
 * than leaking raw database text.
 */
export function toIsoTimestamp(value: string | Date | null | undefined): string | null {
    if (value == null) return null;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    const trimmed = value.trim();
    if (!trimmed) return null;
    // "2026-09-12 15:03:43+02" -> "2026-09-12T15:03:43+02:00" (ECMAScript needs the T and minutes)
    // Only a time part may carry an offset; a date-only value stays as is (UTC midnight).
    // A timestamp without an offset is UTC (never the server's local zone).
    let isoLike = trimmed;
    if (/\d{2}:\d{2}/.test(trimmed)) {
        isoLike = trimmed.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})?$/, (_m, h, mm) => `${h}:${mm ?? '00'}`);
        if (!/(Z|[+-]\d{2}:\d{2})$/i.test(isoLike)) isoLike += 'Z';
    }
    const date = new Date(isoLike);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toAlbum<T extends MusicEntityRow>(row: T, images: ImageSet): Album {
    const meta = row.custom_metadata ?? {};
    const attribution = projectDiscogsAttribution(meta, 'album_enrichment', {
        overview: row.overview,
        genre: typeof meta.genre === 'string' ? meta.genre : undefined,
        poster: row.custom_poster_url,
        backdrop: row.custom_backdrop_url,
        logo: row.custom_logo_url,
    });
    const inherited =
        images.primary?.source === 'artist' &&
        !row.custom_poster_url &&
        validDiscogsCatalogueUrl(row.inherited_poster_credit_url)
            ? row.inherited_poster_credit_url
            : undefined;
    return {
        ...toAlbumSummary(row, images),
        discogsAttribution: inherited ? { ...attribution, poster: inherited } : attribution,
        overview: row.overview ?? null,
        genres: extractGenre(row.custom_metadata ?? {}) ?? [],
        addedAt: toIsoTimestamp(row.created_at),
    };
}
