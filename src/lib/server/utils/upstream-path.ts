// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Encode a value as exactly one URL path segment of an outbound integration
 * request (Jellyfin, Audiobookshelf, Sonarr, ...). Those requests carry a
 * server credential, so an id taken from a request param, the DB or a provider
 * response must never be able to add `/`, `?`, `#` or `..` and steer the
 * request to a different upstream endpoint.
 *
 * encodeURIComponent already escapes `/ ? # %`, but leaves `.` alone and the
 * WHATWG URL parser collapses `.`/`..` (and `%2e`) segments, so those two are
 * refused outright.
 */
export function encodePathSegment(value: string | number): string {
    if (!isSafePathSegment(value)) {
        throw new Error('Invalid upstream path segment');
    }
    return encodeURIComponent(String(value));
}

/**
 * Non-throwing check for batch loops over external data: skip the one item
 * whose id `encodePathSegment` would refuse instead of aborting the run.
 */
export function isSafePathSegment(value: string | number): boolean {
    const s = String(value);
    return s !== '' && s !== '.' && s !== '..';
}
