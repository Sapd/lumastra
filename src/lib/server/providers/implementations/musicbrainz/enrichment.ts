// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MusicBrainz Music Enrichment Functions
 *
 * Album / artist lookups against the MusicBrainz web service, with Cover Art
 * Archive URLs. Track-level fingerprint matching lives in `./acoustid.ts` and
 * runs only from the `acoustid-fingerprint` background task.
 */

import { searchRecording, getRelease, getArtist } from './api-client.js';
import { getAlbumArtUrl } from './cover-art.js';
import { extractGenres, primaryArtistName, releaseYear } from './music-shapes.js';

// =============================================================================
// Music-Specific Metadata Types
// =============================================================================
// Result shapes are the single-source-of-truth in ./music-shapes.js. Re-exported
// here so the barrel (index.ts → `export * from './enrichment.js'`) and existing
// consumers keep importing them from this module unchanged.

export type {
    MusicAlbumCandidate,
    MusicAlbumDetail,
    MusicTrackStub,
    MusicArtistDetail,
} from './music-shapes.js';
import type {
    MusicAlbumCandidate,
    MusicAlbumDetail,
    MusicTrackStub,
    MusicArtistDetail,
} from './music-shapes.js';

// =============================================================================
// Public Music-Specific Functions
// =============================================================================

/**
 * Search for albums matching a title and optional artist.
 */
export async function searchAlbum(title: string, artist?: string): Promise<MusicAlbumCandidate[]> {
    const recordings = await searchRecording(title, artist ?? '');

    const seen = new Set<string>();
    const candidates: MusicAlbumCandidate[] = [];

    for (const rec of recordings) {
        for (const release of rec.releases ?? []) {
            if (seen.has(release.id)) continue;
            seen.add(release.id);

            const confidence = (rec.score ?? 50) / 100;
            candidates.push({
                mbid: release.id,
                title: release.title,
                artistName: primaryArtistName(rec['artist-credit']),
                year: releaseYear(release.date),
                releaseGroupMbid: release['release-group']?.id,
                primaryType: release['release-group']?.['primary-type'],
                confidence,
                coverArtUrl: getAlbumArtUrl(release.id),
            });
        }
    }

    return candidates.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Fetch full album detail by MusicBrainz release MBID.
 */
export async function getAlbumDetail(mbid: string): Promise<MusicAlbumDetail | null> {
    const release = await getRelease(mbid);
    if (!release) return null;

    const rg = release['release-group'];
    const rgGenres = extractGenres(rg);
    const releaseGenres = extractGenres(release);
    const allGenres = [...new Set([...rgGenres, ...releaseGenres])];

    const artistCredit = release['artist-credit']?.[0];
    const tracks: MusicTrackStub[] = [];

    for (const medium of release.media ?? []) {
        for (const track of medium.tracks ?? []) {
            tracks.push({
                position: track.position,
                title: track.title,
                durationMs: track.length ?? track.recording?.length,
                recordingMbid: track.recording?.id,
            });
        }
    }

    const labelInfo = release['label-info']?.[0];

    return {
        mbid: release.id,
        title: release.title,
        artistName: artistCredit?.artist?.name ?? 'Unknown Artist',
        artistMbid: artistCredit?.artist?.id,
        year: releaseYear(release.date),
        label: labelInfo?.label?.name,
        catalogNumber: labelInfo?.['catalog-number'],
        primaryType: rg?.['primary-type'],
        genres: allGenres,
        tags: allGenres,
        tracks,
        coverArtUrl: getAlbumArtUrl(mbid),
        releaseGroupMbid: rg?.id,
    };
}

/**
 * Fetch full artist detail by MusicBrainz artist MBID.
 */
export async function getArtistDetail(mbid: string): Promise<MusicArtistDetail | null> {
    const artist = await getArtist(mbid);
    if (!artist) return null;

    const genres = extractGenres(artist);

    const releaseGroups = (artist['release-groups'] ?? []).map((rg) => ({
        mbid: rg.id,
        title: rg.title,
        primaryType: rg['primary-type'],
        year: releaseYear(rg['first-release-date']),
    }));

    return {
        mbid: artist.id,
        name: artist.name,
        sortName: artist['sort-name'],
        type: artist.type,
        country: artist.country,
        beginDate: artist['life-span']?.begin,
        endDate: artist['life-span']?.end,
        genres,
        tags: genres,
        releaseGroups,
    };
}
