// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Section Builder
 *
 * Constructs PageSection[] for the music home dashboard using the
 * server-driven UI system. Transforms music-specific query results
 * into UniversalMediaItem arrays for rendering via SectionRenderer.
 *
 * @module utils/music-section-builder
 */

import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
import type {
    MusicAlbumRow,
    RecentTrackRow,
    GenreTrackRow,
} from '$lib/server/database/queries/music.queries';
import type { TaggedTrack } from '$lib/server/services/music/quick-picks.service';
import type {
    BecauseYouListenedRow,
    SmartMixRow,
    NewForYouRow,
    MoodRecommendationRow,
} from '$lib/server/database/queries/music-recommendations.queries';
import type { PlaylistRow } from '$lib/server/database/queries/playlists.queries';
import type { MusicTrack } from '$lib/schemas/music';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import type { MoodChip } from '$lib/constants/music-moods';
import { getCatalogPosterUrl } from '$lib/utils/image-utils.js';
import { entityImageUrl, type ApiSurface } from '$lib/shared/api-urls.js';
import * as m from '$lib/paraglide/messages';

// Always route through the catalog image proxy — never expose an external
// URL (TheAudioDB, Discogs, Jellyfin, etc.) to the browser. CSP `img-src`
// blocks third-party hosts, and routing through the proxy also shields
// the user's IP from those services. The proxy walks the parent chain,
// so a track with no own poster inherits its album's cover.
// `surface` defaults to 'internal', which is exactly what getCatalogPosterUrl
// hardcodes — so every existing caller keeps byte-identical URLs. Defs mounted
// on v1 must pass ctx.surface: a bearer client handed an /api/media/... URL is
// rejected by the internal surface's auth gates.
function resolveMusicImage(id: string, surface: ApiSurface = 'internal'): string {
    return surface === 'internal'
        ? getCatalogPosterUrl(id, { size: 'thumb' })
        : entityImageUrl(id, 'poster', surface, { size: 'thumb' });
}

/**
 * `image` for an item whose ImageSet was resolved for the request surface:
 * the thumb variant, else the primary href, else empty (the card's placeholder).
 */
function primaryThumbUrl(images: ImageSet | undefined): string {
    return images?.primary?.variants?.thumb ?? images?.primary?.href ?? '';
}

// =============================================================================
// Transformers: DB rows → UniversalMediaItem
// =============================================================================

/** Shared defaults for music items (no request system, always available) */
const MUSIC_DEFAULTS = {
    externalIds: {},
    canRequest: false,
    isAvailable: true,
    aspectRatio: 'square' as const,
} as const;

/** Shared section meta for music (no hover popups, no similar/request buttons) */
const MUSIC_SECTION_META = {
    hoverPopupEnabled: false,
    showMoreButton: false,
} as const;

function albumToMediaItem(
    album: MusicAlbumRow,
    prefix = 'album',
    surface: ApiSurface = 'internal',
): UniversalMediaItem {
    const subtitle = [
        album.artist_title ?? m.music_unknown_artist(),
        album.year ? String(album.year) : null,
    ]
        .filter(Boolean)
        .join(' \u00b7 ');

    return {
        ...MUSIC_DEFAULTS,
        itemKey: `${prefix}:${album.id}`,
        id: album.id,
        title: album.title,
        subtitle,
        image: resolveMusicImage(album.id, surface),
        mediaType: 'album',
        clickData: {
            ...(album.artist_id ? { artistId: album.artist_id } : {}),
        },
    };
}

function recentTrackToMediaItem(
    track: RecentTrackRow,
    prefix = 'recent',
    surface: ApiSurface = 'internal',
): UniversalMediaItem {
    return {
        ...MUSIC_DEFAULTS,
        itemKey: `${prefix}:${track.id}`,
        id: track.id,
        title: track.title,
        subtitle: track.artist_title ?? m.music_unknown_artist(),
        image: resolveMusicImage(track.id, surface),
        mediaType: 'track',
        clickData: {
            ...(track.artist_id ? { artistId: track.artist_id } : {}),
            ...(track.album_id ? { albumId: track.album_id } : {}),
        },
    };
}

function becauseYouListenedToMediaItem(
    row: BecauseYouListenedRow,
    images: ImageSet | undefined,
): UniversalMediaItem {
    return {
        ...MUSIC_DEFAULTS,
        itemKey: `byl:${row.id}`,
        id: row.id,
        title: row.title,
        subtitle: row.artist_title || m.music_unknown_artist(),
        image: primaryThumbUrl(images),
        images: images ?? {},
        mediaType: 'track',
        similarityScore: row.similarity,
        clickData: {
            ...(row.artist_id ? { artistId: row.artist_id } : {}),
            ...(row.album_id ? { albumId: row.album_id } : {}),
        },
    };
}

function newForYouTrackToMediaItem(
    track: NewForYouRow,
    images: ImageSet | undefined,
): UniversalMediaItem {
    return {
        ...MUSIC_DEFAULTS,
        itemKey: `nfy:${track.id}`,
        id: track.id,
        title: track.title,
        subtitle: track.artist_title || m.music_unknown_artist(),
        image: primaryThumbUrl(images),
        images: images ?? {},
        mediaType: 'track',
        clickData: {
            ...(track.artist_id ? { artistId: track.artist_id } : {}),
            ...(track.album_id ? { albumId: track.album_id } : {}),
        },
    };
}

function moodShelfTrackToMediaItem(
    moodGenre: string,
    row: MoodRecommendationRow,
    images: ImageSet | undefined,
): UniversalMediaItem {
    return {
        ...MUSIC_DEFAULTS,
        itemKey: `mood:${moodGenre}:${row.id}`,
        id: row.id,
        title: row.title,
        subtitle: row.artist_title || m.music_unknown_artist(),
        image: primaryThumbUrl(images),
        images: images ?? {},
        mediaType: 'track',
        similarityScore: row.similarity,
        clickData: {
            ...(row.artist_id ? { artistId: row.artist_id } : {}),
            ...(row.album_id ? { albumId: row.album_id } : {}),
        },
    };
}

/**
 * Localized display label for a mood chip — mirrors the mapping used by the
 * static mood chip row in /music/+page.svelte so a lazy-loaded mood shelf's
 * title matches what the chip itself displays. Falls back to the chip's
 * English label for any genre without a dedicated message key.
 */
function moodChipDisplayLabel(chip: MoodChip): string {
    switch (chip.genre) {
        case 'chill':
            return m.music_mood_chill();
        case 'workout':
            return m.music_mood_workout();
        case 'focus':
            return m.music_mood_focus();
        case 'party':
            return m.music_mood_party();
        case 'energetic':
            return m.music_mood_energetic();
        case 'sad':
            return m.music_mood_sad();
        case 'happy':
            return m.music_mood_happy();
        case 'romantic':
            return m.music_mood_romantic();
        default:
            return chip.label;
    }
}

function smartMixTrackToMediaItem(
    track: SmartMixRow['tracks'][number],
    images: ImageSet | undefined,
): UniversalMediaItem {
    return {
        ...MUSIC_DEFAULTS,
        itemKey: `mix:${track.id}`,
        id: track.id,
        title: track.title,
        subtitle: track.artist_title || m.music_unknown_artist(),
        image: primaryThumbUrl(images),
        images: images ?? {},
        mediaType: 'track',
        clickData: {
            ...(track.artist_id ? { artistId: track.artist_id } : {}),
            ...(track.album_id ? { albumId: track.album_id } : {}),
        },
    };
}

// =============================================================================
// Section Builders
// =============================================================================

export function buildRecentlyPlayedSection(
    tracks: RecentTrackRow[],
    surface: ApiSurface = 'internal',
): PageSection | null {
    if (tracks.length === 0) return null;

    return {
        id: 'music-recently-played',
        type: 'carousel',
        title: m.music_recently_played(),
        // Wrapped, not point-free: recentTrackToMediaItem takes an optional
        // `prefix` second arg, which .map would otherwise fill with the index.
        items: tracks.map((t) => recentTrackToMediaItem(t, 'recent', surface)),
        meta: {
            ...MUSIC_SECTION_META,
            icon: 'play-circle',
            iconColor: 'text-green-400',
            accentColor: 'green',
        },
    };
}

/**
 * Recently-added rail of ALBUMS, newest first — shared by the SSR music page
 * and the /api/music + /api/v1/music home feed.
 *
 * Albums, not tracks: the feed used to list the newest TRACKS, so a single
 * large album imported at once filled the whole rail with the same cover
 * (one 23-track album took 14 of 20 slots on preprod).
 */
export function buildRecentlyAddedAlbumsSection(
    albums: MusicAlbumRow[],
    surface: ApiSurface = 'internal',
): PageSection | null {
    if (albums.length === 0) return null;

    return {
        id: 'music-recently-added',
        type: 'carousel',
        title: m.music_recently_added(),
        items: albums.map((a) => albumToMediaItem(a, 'new', surface)),
        meta: {
            ...MUSIC_SECTION_META,
            icon: 'sparkles',
            iconColor: 'text-purple-400',
            accentColor: 'purple',
        },
    };
}

/**
 * A genre rail of ALBUMS (getMusicByGenre returns MusicAlbumRow, not tracks).
 *
 * Caller supplies id and title because the home feed keys its rails on the
 * ranker's NORMALISED genre key — not the display title, which can flip as the
 * library grows — and renders discovery rails under a different id prefix and
 * heading than proven-taste ones.
 */
export function buildGenreAlbumSection(
    albums: MusicAlbumRow[],
    options: { id: string; title: string },
    surface: ApiSurface = 'internal',
): PageSection | null {
    if (albums.length === 0) return null;

    return {
        id: options.id,
        type: 'carousel',
        title: options.title,
        items: albums.map((a) => albumToMediaItem(a, 'genre', surface)),
        meta: {
            ...MUSIC_SECTION_META,
            accentColor: 'primary',
        },
    };
}

/**
 * `images` is the per-recommendation ImageSet resolved by the async caller for
 * its API surface (resolveImageSets with ctx.surface). Items carry it as
 * `images`, and `image` is derived from the same descriptor.
 */
export function buildBecauseYouListenedSection(
    sourceTrack: { title: string; artist: string; imageUrl?: string },
    recommendations: BecauseYouListenedRow[],
    images: ReadonlyMap<string, ImageSet>,
): PageSection | null {
    if (recommendations.length === 0) return null;

    return {
        id: `music-byl-${sourceTrack.title
            .slice(0, 20)
            .replace(/[^a-zA-Z0-9-]/g, '-')
            .replace(/-+/g, '-')}`,
        type: 'carousel',
        title: m.music_because_you_listened({ title: sourceTrack.title }),
        items: recommendations.map((row) => becauseYouListenedToMediaItem(row, images.get(row.id))),
        meta: {
            ...MUSIC_SECTION_META,
            accentColor: 'violet',
            sourceImage: sourceTrack.imageUrl,
            sourceTitle: sourceTrack.title,
            showSourceLabel: true,
        },
    };
}

/** `images`: per-track ImageSet resolved for the request surface; see buildNewForYouSection. */
export function buildSmartMixSection(
    mix: SmartMixRow,
    images: ReadonlyMap<string, ImageSet>,
): PageSection | null {
    if (mix.tracks.length === 0) return null;

    const genreLabel = mix.genre.charAt(0).toUpperCase() + mix.genre.slice(1);

    return {
        id: `music-mix-${mix.genre}`,
        type: 'carousel',
        title: m.music_genre_mix({ genre: genreLabel }),
        items: mix.tracks.map((t) => smartMixTrackToMediaItem(t, images.get(t.id))),
        meta: {
            ...MUSIC_SECTION_META,
            accentColor: 'cyan',
            icon: 'musical-note',
            iconColor: 'text-cyan-400',
        },
    };
}

/**
 * A genre rail of TRACKS.
 *
 * `options` exists for the feed (`/api/v1/music`), which must NOT derive the
 * section id from the display name the way the dashboard's own genre route
 * does. The feed keys ids on the ranker's NORMALISED genre key, because the
 * dominant spelling of a tag can flip as a library grows and a section id that
 * moves with it breaks client state — and because the discovery rail needs its
 * own `music-genre-discovery-` prefix and "New to You: X" title while carrying
 * the same items. Omit it and the id/title are derived from `genre`, which is
 * what the dashboard route wants.
 *
 * `images` is the per-track ImageSet resolved by the async caller for its API
 * surface (resolveImageSets with ctx.surface): this def is mounted on both
 * `/api/music` and `/api/v1/music`, and an image href built for the wrong
 * surface is unfetchable by the caller.
 */
export function buildGenreTrackSection(
    genre: string,
    tracks: GenreTrackRow[],
    images: ReadonlyMap<string, ImageSet>,
    options?: { id?: string; title?: string },
): PageSection | null {
    if (tracks.length === 0) return null;

    return {
        id: options?.id ?? `music-genre-${genre.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
        type: 'carousel',
        title: options?.title ?? genre,
        items: tracks.map((t) => ({
            ...MUSIC_DEFAULTS,
            itemKey: `genre-${genre}:${t.id}`,
            id: t.id,
            title: t.title,
            subtitle: t.artist_title ?? m.music_unknown_artist(),
            image: primaryThumbUrl(images.get(t.id)),
            images: images.get(t.id) ?? {},
            mediaType: 'track' as const,
            clickData: {
                ...(t.artist_id ? { artistId: t.artist_id } : {}),
                ...(t.album_id ? { albumId: t.album_id } : {}),
            },
        })),
        meta: {
            ...MUSIC_SECTION_META,
            accentColor: 'primary',
            rows: 2,
            cardWidthOverride: 'w-28',
            // No `viewAllHref`: the genre carousel expands inline via "Load more"
            // (infinite-scroll + button, wired by LazySection) instead of linking
            // out to the A-Z genre page.
        },
    };
}

export function buildTopArtistsSection(
    artists: Array<{
        id: string;
        title: string;
        custom_poster_url: string | null;
        album_count: number;
    }>,
    options?: { title?: string; id?: string },
): PageSection | null {
    if (artists.length === 0) return null;

    return {
        id: options?.id ?? 'music-top-artists',
        type: 'carousel',
        title: options?.title ?? m.music_your_top_artists(),
        items: artists.map((a) => ({
            ...MUSIC_DEFAULTS,
            itemKey: `artist:${a.id}`,
            id: a.id,
            title: a.title,
            subtitle:
                a.album_count === 1
                    ? m.music_album_one()
                    : m.music_album_many({ count: String(a.album_count) }),
            image: resolveMusicImage(a.id),
            mediaType: 'artist' as const,
        })),
        meta: {
            ...MUSIC_SECTION_META,
            accentColor: 'pink',
            icon: 'user-group',
            iconColor: 'text-pink-400',
        },
    };
}

export function buildUserPlaylistsSection(playlists: PlaylistRow[]): PageSection | null {
    if (playlists.length === 0) return null;

    return {
        id: 'music-your-playlists',
        type: 'carousel',
        title: m.music_your_playlists(),
        items: playlists.map((p) => {
            // Route cover_items through the catalog proxy by internal_id so we
            // never leak external URLs to the browser (CSP blocks them anyway).
            const coverImages = (p.cover_items ?? [])
                .map((ci) => (ci.internal_id ? resolveMusicImage(ci.internal_id) : null))
                .filter((url): url is string => !!url);
            // UniversalMediaCard only renders the mosaic when `image` is
            // falsy, so leave it empty when we have ≥4 covers. Single-image
            // fallback only kicks in when we don't have enough for a mosaic.
            const useMosaic = coverImages.length >= 4 && !p.cover_image;
            return {
                ...MUSIC_DEFAULTS,
                itemKey: `playlist:${p.id}`,
                id: String(p.id),
                title: p.name,
                subtitle:
                    Number(p.item_count) === 1
                        ? m.music_track_one()
                        : m.music_track_many({ count: String(p.item_count) }),
                image: useMosaic ? '' : (p.cover_image ?? coverImages[0] ?? ''),
                ...(useMosaic ? { images: coverImages.slice(0, 4) } : {}),
                mediaType: 'playlist' as const,
            };
        }),
        meta: {
            ...MUSIC_SECTION_META,
            icon: 'queue-list',
            iconColor: 'text-blue-400',
            accentColor: 'blue',
        },
    };
}

export function buildQuickPicksSection(
    tracks: TaggedTrack[],
    surface: ApiSurface = 'internal',
): PageSection | null {
    if (tracks.length === 0) return null;

    return {
        id: 'music-quick-picks',
        type: 'carousel',
        title: m.music_quick_picks(),
        items: tracks.map((t) => ({
            ...MUSIC_DEFAULTS,
            itemKey: `qp:${t.bucket}:${t.id}`,
            id: t.id,
            title: t.title,
            subtitle: t.artist_title ?? m.music_unknown_artist(),
            image: entityImageUrl(t.id, 'poster', surface, { size: 'thumb' }),
            mediaType: 'track' as const,
            clickData: {
                ...(t.artist_id ? { artistId: t.artist_id } : {}),
                ...(t.album_id ? { albumId: t.album_id } : {}),
            },
        })),
        meta: {
            ...MUSIC_SECTION_META,
            icon: 'sparkles',
            iconColor: 'text-yellow-400',
            accentColor: 'yellow',
            rows: 2,
            cardWidthOverride: 'w-28',
        },
    };
}

/**
 * `images` is the per-track ImageSet resolved by the async caller for its API
 * surface (resolveImageSets with ctx.surface). Items carry it as `images`, and
 * `image` is derived from the same descriptor.
 */
export function buildNewForYouSection(
    tracks: NewForYouRow[],
    images: ReadonlyMap<string, ImageSet>,
): PageSection | null {
    if (tracks.length === 0) return null;

    return {
        id: 'music-new-for-you',
        type: 'carousel',
        title: m.music_new_for_you(),
        items: tracks.map((t) => newForYouTrackToMediaItem(t, images.get(t.id))),
        meta: {
            ...MUSIC_SECTION_META,
            icon: 'gift',
            iconColor: 'text-emerald-400',
            accentColor: 'emerald',
        },
    };
}

/** `images`: per-track ImageSet resolved for the request surface; see buildNewForYouSection. */
export function buildMoodShelfSection(
    chip: MoodChip,
    tracks: MoodRecommendationRow[],
    images: ReadonlyMap<string, ImageSet>,
): PageSection | null {
    if (tracks.length === 0) return null;

    return {
        id: `music-mood-${chip.genre}`,
        type: 'carousel',
        title: moodChipDisplayLabel(chip),
        items: tracks.map((t) => moodShelfTrackToMediaItem(chip.genre, t, images.get(t.id))),
        meta: {
            ...MUSIC_SECTION_META,
            icon: 'bolt',
            iconColor: 'text-rose-400',
            accentColor: 'rose',
        },
    };
}

// =============================================================================
// Sonic Fingerprint Section
// =============================================================================

/**
 * Build the "Your Sonic Fingerprint" server-driven section from an array of
 * MusicTrack objects returned by the /api/music/sonic-fingerprint endpoint.
 *
 * Returns null when the tracks array is empty (feature off or no history yet).
 *
 * The async caller resolves artwork for its API surface before calling this builder.
 * Preserve the owner URL and revision when projecting it into the carousel image field.
 */
export function buildSonicFingerprintSection(tracks: MusicTrack[]): PageSection | null {
    if (tracks.length === 0) return null;

    return {
        id: 'music-sonic-fingerprint',
        type: 'carousel',
        title: m.music_sonic_fingerprint_title(),
        items: tracks.map((t): UniversalMediaItem => ({
            ...MUSIC_DEFAULTS,
            itemKey: `sfp:${t.id}`,
            id: t.id,
            title: t.title,
            subtitle: (t.artists ?? []).map((a) => a.title).join(', ') || m.music_unknown_artist(),
            image: t.images.primary?.variants?.thumb ?? t.images.primary?.href ?? '',
            mediaType: 'track' as const,
            // Structured artists so the card can linkify remixer credits
            // in the title (same contract as search cards).
            artists: (t.artists ?? []).map((artist) => ({
                ...artist,
                id: artist.id ?? undefined,
            })),
            remixerArtists: t.remixerArtists?.map((a) => ({ ...a, id: a.id ?? undefined })),
            clickData: {
                ...(t.album?.id ? { albumId: t.album?.id } : {}),
                // Clickable artist subtitle — every sibling section
                // transformer sets this; its absence left the Sonic
                // Fingerprint rail's artist line inert.
                ...(t.artists?.[0]?.id ? { artistId: t.artists?.[0]?.id } : {}),
            },
        })),
        meta: {
            ...MUSIC_SECTION_META,
            icon: 'finger-print',
            iconColor: 'text-indigo-400',
            accentColor: 'indigo',
        },
    };
}
