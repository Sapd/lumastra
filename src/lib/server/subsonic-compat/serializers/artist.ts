// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Artist Serializers

import type { MusicArtistRow } from '$lib/server/database/queries/music.queries.js';
import type { SubsonicArtist, SubsonicArtistIndex, SubsonicArtists } from '../types.js';

const IGNORED_ARTICLES = 'The El La Los Las Le Les';

/**
 * Convert one artist DB row to a SubsonicArtist wire object.
 * coverArt uses the artist UUID directly — getCoverArt resolves it.
 */
export function serializeArtist(row: MusicArtistRow): SubsonicArtist {
    const result: SubsonicArtist = {
        id: row.id,
        name: row.title,
        albumCount: row.album_count,
        songCount: row.track_count,
    };

    if (row.custom_poster_url) {
        result.coverArt = row.id;
    }

    return result;
}

/**
 * Group a flat artist list into alphabetical indexes for the getArtists
 * response. Non-letter starts are grouped under "#".
 *
 * Sort order: "#" first, then A–Z.
 * Within each bucket: artists sorted by name ascending.
 */
export function groupArtistsByIndex(artists: MusicArtistRow[]): SubsonicArtists {
    const buckets = new Map<string, MusicArtistRow[]>();

    for (const artist of artists) {
        const first = artist.title.charAt(0).toUpperCase();
        const bucket = /^[A-Z]$/.test(first) ? first : '#';
        const existing = buckets.get(bucket);
        if (existing) {
            existing.push(artist);
        } else {
            buckets.set(bucket, [artist]);
        }
    }

    // Sort keys: # first, then A-Z
    const sortedKeys = [...buckets.keys()].sort((a, b) => {
        if (a === '#') return -1;
        if (b === '#') return 1;
        return a.localeCompare(b);
    });

    const index: SubsonicArtistIndex[] = sortedKeys.map((key) => {
        const bucket = buckets.get(key)!;
        bucket.sort((a, b) => a.title.localeCompare(b.title));
        return {
            name: key,
            artist: bucket.map(serializeArtist),
        };
    });

    return {
        ignoredArticles: IGNORED_ARTICLES,
        index,
    };
}
