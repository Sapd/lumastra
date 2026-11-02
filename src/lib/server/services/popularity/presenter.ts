// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Popularity presentation helpers.
 *
 * Converts raw query readouts into the `PopularitySummary` shape surfaced by
 * the API. Keeps routes thin and ensures attribution is always attached — the
 * UI needs it to render the required-by-ToS tooltip.
 */

import type {
    ArtistPopularityReadout,
    TrackPopularityReadout,
} from '../../database/queries/popularity.queries.js';
import type { PopularityAttribution, PopularitySource, PopularitySummary } from './types.js';
import * as m from '$lib/paraglide/messages';

/**
 * Static attribution per provider. Kept here rather than on the provider
 * instance so routes can build summaries without instantiating providers
 * (which would require credentials). Updating a provider's attribution
 * requires updating both this table and the provider factory.
 */
const ATTRIBUTIONS: Record<PopularitySource, PopularityAttribution> = {
    lastfm: {
        source: 'lastfm',
        text: m.attribution_lastfm(),
        url: 'https://www.last.fm/',
    },
    listenbrainz: {
        source: 'listenbrainz',
        text: m.attribution_listenbrainz(),
        url: 'https://listenbrainz.org/',
    },
    local: {
        source: 'local',
        text: m.attribution_local(),
        url: '',
    },
};

export function attributionForSource(
    source: PopularitySource,
    providerUrl?: string | null,
): PopularityAttribution {
    const attribution = { ...ATTRIBUTIONS[source] };
    if (source === 'lastfm') attribution.url = lastfmCatalogueUrl(providerUrl) ?? attribution.url;
    return attribution;
}

export function lastfmCatalogueUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        if (
            url.protocol !== 'https:' ||
            url.hostname !== 'www.last.fm' ||
            url.port ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
        )
            return null;
        // Artist (/music/name) or track (/music/artist/_/title), never arbitrary Last.fm pages.
        if (!/^\/music\/[^/]+(?:\/_\/[^/]+)?\/?$/.test(url.pathname)) return null;
        // Validate original segments before URL normalizes dot-segment traversal.
        const rawPath = value.match(/^https:\/\/[^/?#]+(\/[^?#]*)/)?.[1];
        if (!rawPath || !/^\/music\/[^/]+(?:\/_\/[^/]+)?\/?$/.test(rawPath)) return null;
        const slugs = rawPath
            .split('/')
            .filter(Boolean)
            .filter((_, index) => index === 1 || index === 3);
        for (const slug of slugs) {
            const decoded = decodeURIComponent(slug);
            if (
                [...decoded].some(
                    (character) =>
                        character === '\\' ||
                        character.charCodeAt(0) < 32 ||
                        character.charCodeAt(0) === 127,
                ) ||
                decoded.split('/').some((segment) => segment === '.' || segment === '..')
            )
                return null;
        }
        return url.href;
    } catch {
        return null;
    }
}

export function buildArtistPopularitySummary(
    readout: ArtistPopularityReadout,
    source: PopularitySource,
): PopularitySummary {
    return {
        listeners: readout.listeners,
        playcount: readout.playcount,
        rankInArtist: null,
        score: readout.score,
        scoreContext: 'artist_global',
        attribution: attributionForSource(source, readout.providerUrl),
    };
}

export function buildTrackPopularitySummary(
    readout: TrackPopularityReadout,
    source: PopularitySource,
): PopularitySummary {
    return {
        listeners: readout.listeners,
        playcount: readout.playcount,
        // rank=0 means "no rank" — the DB stores null but the readout
        // normalizes to 0, so translate back for the API.
        rankInArtist: readout.rank > 0 ? readout.rank : null,
        score: readout.score,
        scoreContext: 'track_in_artist',
        attribution: attributionForSource(source, readout.providerUrl),
    };
}
