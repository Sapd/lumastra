// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider-agnostic popularity types.
 *
 * The PopularityProvider interface intentionally returns provider-native data
 * (title strings, provider-specific MBIDs). Library matching is done by the
 * orchestrator, so providers stay oblivious to our internal UUIDs and can be
 * unit-tested against recorded provider responses.
 */

export type PopularitySource = 'lastfm' | 'listenbrainz' | 'local';

export type ScoreContext = 'artist_global' | 'track_in_artist' | 'album_global';

/**
 * Input given to a provider when asking for artist popularity.
 */
export interface ArtistPopularityRequest {
    title: string;
    /** MusicBrainz artist ID, if we have one. Providers prefer this. */
    mbid?: string;
}

/**
 * A single track as returned by the provider's top-tracks endpoint.
 * No library UUIDs here — the orchestrator does matching.
 */
export interface ProviderTopTrack {
    providerTitle: string;
    providerMbid?: string;
    /** 1-based rank within this artist's top-tracks list. */
    rank: number;
    rawListeners?: number;
    rawPlaycount?: number;
    providerUrl: string;
}

/**
 * Provider response for an artist. Contains artist-level stats and a list of
 * top tracks in provider-native form.
 */
export interface ProviderArtistPopularity {
    artist: {
        rawListeners?: number;
        rawPlaycount?: number;
        providerUrl: string;
        /** Free-form extras the provider returned (tags, similar artists, bio). */
        rawMetadata?: Record<string, unknown>;
    };
    topTracks: ProviderTopTrack[];
}

/**
 * A PopularityProvider fetches provider-native popularity data. It knows
 * nothing about our database, UUIDs, or matching — those concerns live in the
 * orchestrator. This keeps providers drop-in replaceable.
 */
export interface PopularityProvider {
    readonly id: PopularitySource;
    readonly displayName: string;
    /** Short human-readable attribution ("Data from Last.fm"). */
    readonly attributionText: string;
    /** URL shown when the attribution tooltip is clicked. */
    readonly attributionUrl: string;

    /** True when credentials/config are present for this provider. */
    isConfigured(): boolean;

    /**
     * Fetch popularity for an artist.
     *
     * `options.signal` — when supplied, aborts in-flight HTTP calls so the
     * sync drain's soft-budget pre-emption (or an admin-triggered stop)
     * propagates into the provider immediately. Providers may ignore the
     * signal — the contract is best-effort, not mandatory — but every
     * built-in should honor it for responsiveness.
     */
    fetchArtistPopularity(
        input: ArtistPopularityRequest,
        options?: { signal?: AbortSignal },
    ): Promise<ProviderArtistPopularity | null>;
}

/**
 * Row shape written into the media_popularity table.
 * Keyed by (media_id, source); presence of a row = "we fetched this".
 */
export interface PopularityRow {
    mediaId: string;
    source: PopularitySource;
    scoreContext: ScoreContext;
    rawListeners: number | null;
    rawPlaycount: number | null;
    normalizedScore: number;
    rankInArtist: number | null;
    providerUrl: string | null;
    rawMetadata: Record<string, unknown> | null;
    fetchedAt: Date;
}

/**
 * Attribution surfaced to the UI so tooltips/links can be rendered without
 * the frontend knowing which provider produced the data.
 */
export interface PopularityAttribution {
    source: PopularitySource;
    text: string;
    url: string;
}

/**
 * Compact popularity summary returned alongside artist/album/track API
 * responses. The UI uses this to render listener counts, stars on popular
 * tracks, and the attribution tooltip.
 */
export interface PopularitySummary {
    listeners: number | null;
    playcount: number | null;
    rankInArtist: number | null;
    /** 0–1 normalized score, whose meaning depends on scoreContext. */
    score: number;
    scoreContext: ScoreContext;
    attribution: PopularityAttribution;
}
