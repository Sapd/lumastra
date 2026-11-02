// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Playlist rows use SERIAL integer PKs, but Jellyfin clients strictly require
// UUID-shaped IDs. We encode/decode playlist IDs as deterministic UUIDs so
// the SDK never sees a bare integer.
//
// Format: 00000000-0000-4000-8000-{id as 12 lowercase hex digits}
// The version nibble (4) and variant bits (8) keep it valid UUID v4 shape.

const PREFIX = '00000000-0000-4000-8000-';

/**
 * Largest SERIAL (int4) value. The 12-hex-digit id field holds up to 2^48-1;
 * anything above this cannot be a row, and passing it to Postgres as an int
 * fails the query (22003) — so the parsers below answer null for it.
 */
export const MAX_SERIAL_ID = 2_147_483_647;

/** A parsed id when it can be a SERIAL row id, else null. */
function serialId(id: number): number | null {
    return Number.isSafeInteger(id) && id > 0 && id <= MAX_SERIAL_ID ? id : null;
}
const PLAYLIST_UUID_RE = /^00000000-0000-4000-8000-([0-9a-f]{12})$/;

export function playlistIdToUuid(id: number): string {
    return PREFIX + id.toString(16).padStart(12, '0');
}

export function uuidToPlaylistId(uuid: string): number | null {
    const match = PLAYLIST_UUID_RE.exec(uuid);
    if (!match) return null;
    return serialId(parseInt(match[1], 16));
}

const PLAYLIST_UUID_DASHLESS_RE = /^00000000000040008000([0-9a-f]{12})$/;

/**
 * Parse a playlist id as a Jellyfin client sends it back: the dashed UUID we
 * emit, its dashless "N" form (Jellyfin's own GUID formatting, which several
 * clients normalise to), or a bare integer (accepted by the sibling routes).
 * Case-insensitive. Returns null for anything else, and for an id above
 * MAX_SERIAL_ID.
 */
export function parseJellyfinPlaylistId(raw: string | undefined | null): number | null {
    if (!raw) return null;
    const value = raw.trim().toLowerCase();
    if (/^\d{1,12}$/.test(value)) return serialId(parseInt(value, 10));
    const dashless = PLAYLIST_UUID_DASHLESS_RE.exec(value);
    if (dashless) return uuidToPlaylistId(PREFIX + dashless[1]);
    return uuidToPlaylistId(value);
}

// Playlist ENTRY ids (`playlist_items.id`, also SERIAL) become Jellyfin's
// `PlaylistItemId`. Jellyfin emits that as a dashless "N"-format GUID, so we do
// the same, with variant nibble `a` instead of `8` so an entry id can never be
// mistaken for a playlist id (or vice versa) when a client echoes it back.
const ENTRY_PREFIX = '0000000000004000a000';
const ENTRY_ID_RE = /^0000000000004000a000([0-9a-f]{12})$/;

export function playlistEntryIdToJellyfin(id: number): string {
    return ENTRY_PREFIX + id.toString(16).padStart(12, '0');
}

/**
 * Decode a `PlaylistItemId` (dashed or dashless, any case) back to the
 * `playlist_items.id`. A bare integer is accepted too. Returns null otherwise,
 * and for an id above MAX_SERIAL_ID.
 */
export function jellyfinToPlaylistEntryId(raw: string | undefined | null): number | null {
    if (!raw) return null;
    const value = raw.trim().toLowerCase().replace(/-/g, '');
    if (/^\d{1,12}$/.test(value)) return serialId(parseInt(value, 10));
    const match = ENTRY_ID_RE.exec(value);
    if (!match) return null;
    return serialId(parseInt(match[1], 16));
}
