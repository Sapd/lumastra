// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect } from 'vitest';
import {
    jellyfinToPlaylistEntryId,
    parseJellyfinPlaylistId,
    uuidToPlaylistId,
    playlistEntryIdToJellyfin,
    playlistIdToUuid,
} from './playlist-id';

describe('parseJellyfinPlaylistId', () => {
    it('accepts the dashed, dashless and upper-case forms and a bare integer', () => {
        const uuid = playlistIdToUuid(42);
        expect(parseJellyfinPlaylistId(uuid)).toBe(42);
        expect(parseJellyfinPlaylistId(uuid.replace(/-/g, ''))).toBe(42);
        expect(parseJellyfinPlaylistId(uuid.toUpperCase())).toBe(42);
        expect(parseJellyfinPlaylistId('42')).toBe(42);
    });

    it('rejects everything else', () => {
        expect(parseJellyfinPlaylistId(undefined)).toBeNull();
        expect(parseJellyfinPlaylistId('')).toBeNull();
        expect(parseJellyfinPlaylistId('0')).toBeNull();
        expect(parseJellyfinPlaylistId('abc')).toBeNull();
        expect(parseJellyfinPlaylistId('11111111-2222-4333-8444-555555555555')).toBeNull();
        // An entry id is never a playlist id.
        expect(parseJellyfinPlaylistId(playlistEntryIdToJellyfin(42))).toBeNull();
    });
});

describe('playlist entry ids (PlaylistItemId)', () => {
    it('round-trips as a dashless 32-hex GUID', () => {
        const encoded = playlistEntryIdToJellyfin(1234);
        expect(encoded).toMatch(/^[0-9a-f]{32}$/);
        expect(jellyfinToPlaylistEntryId(encoded)).toBe(1234);
    });

    it('accepts the dashed and upper-case forms and a bare integer', () => {
        const encoded = playlistEntryIdToJellyfin(7);
        const dashed = `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20)}`;
        expect(jellyfinToPlaylistEntryId(dashed)).toBe(7);
        expect(jellyfinToPlaylistEntryId(encoded.toUpperCase())).toBe(7);
        expect(jellyfinToPlaylistEntryId('7')).toBe(7);
    });

    it('rejects playlist ids and garbage', () => {
        expect(jellyfinToPlaylistEntryId(playlistIdToUuid(7))).toBeNull();
        expect(jellyfinToPlaylistEntryId('0000000000004000a000000000000000')).toBeNull();
        expect(jellyfinToPlaylistEntryId('zz')).toBeNull();
        expect(jellyfinToPlaylistEntryId(null)).toBeNull();
    });
});

describe('ids above int4 (SERIAL)', () => {
    it('are null in every parser, so routes never send them to Postgres', () => {
        expect(uuidToPlaylistId(playlistIdToUuid(2_147_483_647))).toBe(2_147_483_647);
        expect(uuidToPlaylistId(playlistIdToUuid(2_147_483_648))).toBeNull();
        expect(uuidToPlaylistId('00000000-0000-4000-8000-ffffffffffff')).toBeNull();
        expect(parseJellyfinPlaylistId('00000000000040008000ffffffffffff')).toBeNull();
        expect(parseJellyfinPlaylistId('2147483648')).toBeNull();
        expect(parseJellyfinPlaylistId('2147483647')).toBe(2_147_483_647);
        expect(jellyfinToPlaylistEntryId('0000000000004000a000ffffffffffff')).toBeNull();
        expect(jellyfinToPlaylistEntryId(playlistEntryIdToJellyfin(2_147_483_648))).toBeNull();
        expect(jellyfinToPlaylistEntryId('999999999999')).toBeNull();
        expect(jellyfinToPlaylistEntryId(playlistEntryIdToJellyfin(2_147_483_647))).toBe(
            2_147_483_647,
        );
    });
});
