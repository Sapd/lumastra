// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    resolveArtistCredit,
    parseArtistNames,
    NO_ARTIST_CREDIT_EVIDENCE,
    type ArtistCreditEvidence,
} from './artist-credit.js';
import { VARIOUS_ARTISTS_LABEL, isVariousArtistsName } from '$lib/shared/various-artists.js';

export const VARIOUS_ARTISTS_MBID = '89ad4ac3-39f7-470e-963a-56509c546377';

export interface AlbumFileCredit {
    trackTitle?: string;
    albumTitle?: string;
    albumArtist?: string;
    albumArtists?: string[];
    primaryArtist?: string;
    /** Preserve the file value before credit splitting can truncate a copied title. */
    rawPrimaryArtist?: string;
    releaseMbid?: string;
    releaseGroupMbid?: string;
    releaseArtist?: string;
    releaseArtistIds?: string[];
    compilation?: boolean;
}

export interface AlbumArtistDecision {
    artist: string;
    various: boolean;
    locked: boolean;
    inconsistentAlbumArtists: boolean;
    source: 'lock' | 'album-tag' | 'musicbrainz' | 'compilation' | 'track-artists' | 'fallback';
}

export function normalizeAlbumArtist(value: string): string {
    return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizePerformer(value: string): string {
    return normalizeAlbumArtist(value)
        .replace(/\s+(?:feat\.?|ft\.?|featuring)\s.*$/, '')
        .replace(/(?:\s*[([][^()[\]]*[)\]])+$/g, '')
        .replace(/^the\s+/, '')
        .trim();
}

/** Album identity is independent of how many names a TRACK credit contains. */
export function resolveAlbumArtist(
    files: readonly AlbumFileCredit[],
    options: {
        locked?: boolean;
        currentArtist?: string;
        fallbackArtist?: string;
        creditEvidence?: ArtistCreditEvidence;
    } = {},
): AlbumArtistDecision {
    const credits = files.map((f) =>
        (f.albumArtists?.length ? f.albumArtists : [f.albumArtist ?? ''])
            .map((s) => s.trim())
            .filter(Boolean),
    );
    const tagged = credits.filter((c) => c.length > 0);
    const keys = tagged.map((c) => JSON.stringify(c.map(normalizeAlbumArtist)));
    const tagCounts = new Map<string, number>();
    for (const key of keys) tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
    const majorityKey = [...tagCounts].find(([, n]) => n * 2 > files.length)?.[0];
    const majority = majorityKey === undefined ? undefined : tagged[keys.indexOf(majorityKey)];
    const inconsistentAlbumArtists = tagged.length > 0 && !majority;
    const decision = (
        artist: string,
        source: AlbumArtistDecision['source'],
    ): AlbumArtistDecision => {
        const various = isVariousArtistsName(artist);
        return {
            artist: various && source !== 'lock' ? VARIOUS_ARTISTS_LABEL : artist,
            various,
            locked: source === 'lock',
            inconsistentAlbumArtists,
            source,
        };
    };
    if (options.locked) return decision(options.currentArtist ?? 'Unknown Artist', 'lock');
    if (majority) {
        const name = majority[0];
        return decision(
            majority.length > 1 || isVariousArtistsName(name)
                ? name
                : (resolveArtistCredit(
                      name,
                      options.creditEvidence ?? NO_ARTIST_CREDIT_EVIDENCE,
                  )[0] ?? name),
            'album-tag',
        );
    }
    // Release artist IDs, never recording/track artist IDs. A release ID alone
    // is not an artist credit and cannot establish an album parent.
    const mb = files.filter((f) => f.releaseArtistIds?.length);
    if (mb.some((f) => f.releaseArtistIds?.includes(VARIOUS_ARTISTS_MBID)))
        return decision(VARIOUS_ARTISTS_LABEL, 'musicbrainz');
    const mbNames = mb.map((f) => f.releaseArtist?.trim()).filter((s): s is string => Boolean(s));
    if (mbNames.length && new Set(mbNames.map(normalizeAlbumArtist)).size === 1)
        return decision(mbNames[0], 'musicbrainz');
    if (files.filter((f) => f.compilation).length * 2 > files.length)
        return decision(VARIOUS_ARTISTS_LABEL, 'compilation');
    // Compare first performers, not guest credits. Shorter names are considered
    // first so a bare artist can absorb an extended credit regardless of track order.
    const trackPerformers = files.map((file) => {
        const name = parseArtistNames(file.primaryArtist ?? '')[0];
        const key = normalizePerformer(name ?? '');
        const titleKey = normalizePerformer(file.trackTitle ?? '');
        return {
            name,
            key,
            selfTitled:
                Boolean(titleKey) &&
                (key === titleKey ||
                    normalizePerformer(file.rawPrimaryArtist ?? file.primaryArtist ?? '') ===
                        titleKey),
        };
    });
    // Copied track titles are broken tags, not distinct performers. A folder
    // dominated by these tags cannot establish any performer-based parent.
    const brokenMajority = trackPerformers.filter((p) => p.selfTitled).length * 2 > files.length;
    const performers = (brokenMajority ? [] : trackPerformers)
        .filter((p) => p.key && !p.selfTitled)
        .sort((a, b) => a.key.length - b.key.length || a.key.localeCompare(b.key));
    const counts = new Map<string, { name: string; n: number }>();
    for (const { name, key } of performers) {
        // Whole-word containment covers prefix/alias credits (e.g. an artist
        // with their band); substring matches such as Finch/Finchley do not.
        const canonical =
            [...counts.keys()].find((base) => ` ${key} `.includes(` ${base} `)) ?? key;
        const entry = counts.get(canonical) ?? { name, n: 0 };
        entry.n++;
        counts.set(canonical, entry);
    }
    const ranked = [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    // Two primary strings are too weak: a guest or spelling variation must
    // not reparent an artist album. Three normalized performers establish a
    // compilation only when no performer covers half the tracks. This also
    // protects artist albums with several guests; explicit album/MB/compilation
    // evidence above still wins.
    const releaseIds = new Set(
        files.map((f) => f.releaseMbid?.trim().toLowerCase()).filter(Boolean),
    );
    if (ranked.length >= 3 && ranked[0].n * 2 < files.length && releaseIds.size <= 1)
        return decision(VARIOUS_ARTISTS_LABEL, 'track-artists');
    if (ranked.length) return decision(ranked[0].name, 'track-artists');
    return decision(
        options.fallbackArtist ?? options.currentArtist ?? 'Unknown Artist',
        'fallback',
    );
}

/** Read only persisted file-tag evidence, never the current hierarchy as a tag. */
export function albumFileCredit(meta: Record<string, unknown>): AlbumFileCredit {
    const str = (v: unknown): string | undefined =>
        typeof v === 'string' && v.trim() ? v : undefined;
    const list = (v: unknown): string[] | undefined =>
        Array.isArray(v)
            ? v.filter((s): s is string => typeof s === 'string' && Boolean(s.trim()))
            : undefined;
    return {
        trackTitle: str(meta.title),
        albumTitle: str(meta.album),
        albumArtist: str(meta.album_artist),
        albumArtists: list(meta.album_artists),
        primaryArtist: list(meta.artists)?.[0] ?? parseArtistNames(str(meta.artist) ?? '')[0],
        rawPrimaryArtist: list(meta.artists)?.[0] ?? str(meta.artist),
        releaseMbid: str(meta.musicbrainz_album_id),
        releaseGroupMbid: str(meta.musicbrainz_releasegroup_id),
        releaseArtist: str(meta.musicbrainz_release_artist),
        releaseArtistIds: list(meta.musicbrainz_album_artist_ids),
        compilation:
            meta.compilation === true || meta.compilation === 1 || meta.compilation === '1',
    };
}
