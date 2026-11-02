// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Signed ImageTags for library (CollectionFolder) artwork on `/j`.
 *
 * `/j/Items/{id}/Images/{type}` is a public, credential-free image proxy:
 * Jellyfin clients load artwork without auth (jellyfin-androidtv's Coil client
 * sends no header and the SDK's image URLs carry no api_key). It therefore
 * cannot ask "may this caller see this library?", which is why it stopped
 * serving the library mosaic on 2026-09-17 (C10) and every library tile fell
 * back to the client's placeholder.
 *
 * The tag is the capability instead. `/j/UserViews` — authenticated, and
 * listing only the groups the user is not denied — hands each library an
 * ImageTag that is an HMAC over the group id and an expiry. Clients echo the
 * tag back on the image request (`?tag=…`), and the image route serves the
 * mosaic only when the tag verifies for that exact id. An unauthenticated
 * caller who merely knows a group's UUID gets the same placeholder as before.
 *
 * The expiry is bucketed by week so the tag (and with it the client's image
 * cache key) stays stable across UserViews calls: a tag minted in week N
 * expires at the end of week N+1, i.e. it is valid for 7–14 days. That is also
 * how long a user removed from a library could keep loading its mosaic with a
 * tag they already hold — the same exposure as an image they already cached.
 *
 * Format: 8 hex chars expiry (unix seconds) + 32 hex chars HMAC-SHA256 prefix —
 * 40 lowercase hex chars, the shape clients expect of a Jellyfin tag.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '$lib/server/config';

const PURPOSE = 'jf-library-image:v1';
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const TAG_PATTERN = /^[0-9a-f]{40}$/;

function signature(secret: string, libraryGroupId: string, expires: number): string {
    return createHmac('sha256', secret)
        .update(`${PURPOSE}:${libraryGroupId.toLowerCase()}:${expires}`)
        .digest('hex')
        .slice(0, 32);
}

/** Library ids arrive dashed from our own responses and dashless from some clients. */
export function canonicalGroupId(id: string): string {
    const hex = id.replace(/-/g, '').toLowerCase();
    return hex.length === 32
        ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
        : id.toLowerCase();
}

/**
 * The ImageTag to advertise for a library the caller may see, or undefined when
 * no signing secret is configured (the tile then keeps the client placeholder).
 */
export function libraryImageTag(libraryGroupId: string, nowMs = Date.now()): string | undefined {
    const secret = config.JWT_SECRET;
    if (!secret) return undefined;
    const week = Math.floor(nowMs / 1000 / WEEK_SECONDS);
    const expires = (week + 2) * WEEK_SECONDS;
    const expiresHex = expires.toString(16).padStart(8, '0');
    return expiresHex + signature(secret, canonicalGroupId(libraryGroupId), expires);
}

/** True when `tag` was minted by `libraryImageTag` for this id and has not expired. */
export function verifyLibraryImageTag(
    libraryGroupId: string,
    tag: string | null | undefined,
    nowMs = Date.now(),
): boolean {
    if (!tag) return false;
    const normalized = tag.trim().toLowerCase();
    if (!TAG_PATTERN.test(normalized)) return false;
    const secret = config.JWT_SECRET;
    if (!secret) return false;

    const expires = Number.parseInt(normalized.slice(0, 8), 16);
    if (expires * 1000 <= nowMs) return false;

    const expected = Buffer.from(signature(secret, canonicalGroupId(libraryGroupId), expires));
    const given = Buffer.from(normalized.slice(8));
    return expected.length === given.length && timingSafeEqual(expected, given);
}
