// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Media access gate
//
// Subsonic clients authenticate per-request with a token, not via the
// standard forward-auth flow that produces locals.user. The shared
// `checkMediaAccess` helper expects a UserContext-shaped object, so this
// module adapts the SubsonicAuthContext to the same shape and forwards.
//
// Use it on every track-, album-, artist-id-keyed handler before returning
// or streaming media data. List queries (browse, search, getRandomSongs)
// must instead filter at the SQL layer via `deniedGroupIds` and the
// `AgeRatingFilterParams`-style options on the underlying query modules.

import type { Sql } from 'postgres';
import { checkMediaAccess } from '$lib/server/middleware/media-access';
import type { UserContext } from '$lib/server/types';
import { toUserId } from '$lib/shared/user-id.js';
import type { SubsonicAuthContext } from './types';
import {
    getAlbumWithTracks,
    getArtistWithAlbums,
    type ArtistWithAlbumsRow,
} from '$lib/server/database/queries/music.queries.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';
import { config } from '$lib/server/config.js';
import type { AgeRatingFilterParams } from '$lib/server/database/queries/builders/age-rating.builder.js';
import {
    isUnrestricted,
    restrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';

/**
 * Derive the age-rating SQL filter params for a Subsonic caller, or `null` when
 * the caller is unrestricted. List queries receive this and emit an age
 * predicate ONLY when it is non-null, so unrestricted callers (the common case)
 * produce byte-identical SQL — no added cost, and no result cache exists to
 * fragment. Shared by the search and browse handlers.
 */
export function ageRatingFromAuth(auth: SubsonicAuthContext): AgeRatingFilterParams | null {
    if (!auth.isAgeRestricted) return null;
    return {
        // Every auth path sets isAgeRestricted = (maxAgeRating !== null); if
        // that ever breaks, fail closed like checkAgeGate (`maxAgeRating ?? 0`)
        // rather than collapsing to an unrestricted boundary.
        maxAgeRating: auth.maxAgeRating ?? 0,
        allowUnrated: config.UNRATED_CONTENT_VISIBLE,
    };
}

/**
 * Build a required-by-shape {@link MediaAccessBoundary} for a Subsonic list
 * query from the raw `(deniedGroupIds, age)` pair the compat layer produces.
 *
 * Mechanical replacement for the deleted `fromLegacyAccess` adapter: a
 * null/empty deny-list collapses to `library: all` and a null age to
 * `age: any`, so unrestricted callers emit byte-identical SQL to before.
 */
export function subsonicBoundary(
    deniedGroupIds: readonly string[] | null,
    age: AgeRatingFilterParams | null,
): MediaAccessBoundary {
    return restrictedAccess({
        deniedGroupIds: deniedGroupIds ?? [],
        maxAgeRating: age?.maxAgeRating ?? null,
        allowUnrated: age?.allowUnrated ?? false,
    });
}

/** The Subsonic caller's own {@link MediaAccessBoundary} (library groups + age limit). */
export async function subsonicAccessBoundary(
    sql: Sql,
    auth: SubsonicAuthContext,
): Promise<MediaAccessBoundary> {
    const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(auth));
    return subsonicBoundary(denied, ageRatingFromAuth(auth));
}

/**
 * `album` with songCount/duration recounted over the tracks the caller may
 * see. {@link getAlbumWithTracks} counts every track, so a partly hidden album
 * would otherwise report its hidden tracks in songCount/duration while the
 * song list itself is filtered.
 */
export function withVisibleTrackCounts<
    A extends { track_count: number; total_duration: number | null },
>(album: A, visibleTracks: readonly { runtime_seconds: number | null }[]): A {
    return {
        ...album,
        track_count: visibleTracks.length,
        total_duration: visibleTracks.reduce((sum, t) => sum + (t.runtime_seconds ?? 0), 0),
    };
}

/**
 * Load an artist and the albums the caller may see, or `null` when the caller
 * may not see the artist at all. Shared by every artist-id-keyed handler
 * (getArtist, getMusicDirectory, getArtistInfo*, getStarred*).
 *
 * The query runs under the caller's boundary, so the artist's album/song
 * counts and each album's songCount/duration count only what the caller can
 * play. These used to be computed with `unrestrictedAccess()` and only the
 * album LIST was filtered afterwards, so a group-denied or age-limited user
 * learned how many hidden albums and tracks an artist has.
 *
 * `null` when: the id is not an artist; the artist row itself fails the gate
 * (C14, 2026-09-16 security review 3 — a file-less artist naming a denied
 * group); or a restricted caller can see none of its albums (as getArtists,
 * which lists an artist only while one of its tracks is playable for them).
 */
export async function getVisibleArtistWithAlbums(
    sql: Sql,
    artistId: string,
    auth: SubsonicAuthContext,
): Promise<ArtistWithAlbumsRow | null> {
    const access = await subsonicAccessBoundary(sql, auth);
    const result = await getArtistWithAlbums(sql, artistId, access);
    if (!result) return null;
    if (!(await checkSubsonicMediaAccess(sql, artistId, auth))) return null;
    // Defence in depth: the per-item gate on top of the SQL boundary.
    const albums = await filterAccessibleAlbums(sql, result.albums, auth);
    if (albums.length === 0 && !isUnrestricted(access)) return null;
    return { artist: result.artist, albums };
}

/**
 * Convert a SubsonicAuthContext to the minimal UserContext shape required by
 * the shared media-access helpers. Subsonic auth never exposes the watch /
 * livetv / request / moderator role flags, but those are not consulted by
 * checkMediaAccess — only username, isAdmin, userGroups, maxAgeRating, and
 * isAgeRestricted are used.
 */
export function toUserContext(auth: SubsonicAuthContext): UserContext {
    return {
        // auth.userId is subsonic_client_passwords.user_id, which FKs users(id) —
        // the stable users.id UUID (see getTokenByValue JOIN).
        userId: toUserId(auth.userId),
        username: auth.username,
        groups: '',
        userGroups: auth.userGroups,
        hasWatchPermission: false,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        ownerIsAdmin: auth.ownerIsAdmin,
        maxAgeRating: auth.maxAgeRating,
        isAgeRestricted: auth.isAgeRestricted,
        isModerator: false,
        liveTvPriority: 'low',
    };
}

/**
 * Filter a pre-loaded track list to only those the caller can access.
 * Checks library and age access for each track with a separate DB query.
 */
export async function filterAccessibleTracks<T extends { id: string }>(
    sql: Sql,
    tracks: T[],
    auth: SubsonicAuthContext,
): Promise<T[]> {
    const result: T[] = [];
    for (const t of tracks) {
        if (await checkSubsonicMediaAccess(sql, t.id, auth)) result.push(t);
    }
    return result;
}

/**
 * Filter a list of albums (by ID) to those with at least one accessible track.
 * Trackless or unresolved albums are checked by album ID.
 * After resolving denied groups, skips per-album checks only for callers
 * with no denied library groups and no age restriction.
 */
export async function filterAccessibleAlbums<T extends { id: string }>(
    sql: Sql,
    albums: T[],
    auth: SubsonicAuthContext,
): Promise<T[]> {
    const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(auth));
    // Skip all work only when the caller is FULLY unrestricted — no denied
    // library groups AND not age-restricted. The previous guard short-circuited
    // on library groups alone, so an age-restricted user with no library denial
    // received every album unfiltered (an age-gate bypass for the artist /
    // music-directory views). checkSubsonicMediaAccess below applies both the
    // library and age gates, so age-restricted callers must fall through.
    if ((!denied || denied.length === 0) && !auth.isAgeRestricted) return albums;
    const result: T[] = [];
    for (const a of albums) {
        const r = await getAlbumWithTracks(sql, a.id);
        if (!r || r.tracks.length === 0) {
            // C14 (2026-09-16 security review 3): a track-less album (or one
            // whose id no longer resolves) used to be pushed unconditionally,
            // skipping both the library and age gate for a row that can still
            // carry a name/year/cover tagged to a denied group. Gate it on the
            // ALBUM id through the same primitive every id-keyed handler uses.
            if (await checkSubsonicMediaAccess(sql, a.id, auth)) result.push(a);
            continue;
        }
        for (const t of r.tracks) {
            if (await checkSubsonicMediaAccess(sql, t.id, auth)) {
                result.push(a);
                break;
            }
        }
    }
    return result;
}

/**
 * Returns true if the Subsonic-authenticated user is allowed to access the
 * media item (passes both the library-group gate and the age gate).
 *
 * Pass the internal media_items UUID. For Subsonic id formats that wrap a
 * UUID (the standard case), pass the unwrapped value.
 */
export async function checkSubsonicMediaAccess(
    sql: Sql,
    mediaId: string,
    auth: SubsonicAuthContext,
): Promise<boolean> {
    return checkMediaAccess(sql, mediaId, toUserContext(auth));
}
