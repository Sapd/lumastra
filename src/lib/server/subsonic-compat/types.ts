// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Wire types
// Plain TypeScript interfaces matching the Subsonic/OpenSubsonic JSON/XML
// response shapes. These are output-only; they do not validate input.

import type { RequestEvent } from '@sveltejs/kit';
import type { UserId } from '$lib/shared/user-id';
import type postgres from 'postgres';

export type SubsonicFormat = 'json' | 'xml';
export type SubsonicStatus = 'ok' | 'failed';

export interface SubsonicError {
    code: number;
    message: string;
}

// Artist (ID3 mode)
export interface SubsonicArtist {
    id: string;
    name: string;
    coverArt?: string;
    albumCount?: number;
    songCount?: number;
    starred?: string; // ISO date if starred
}

export interface SubsonicArtistIndex {
    name: string; // first letter or "#"
    artist: SubsonicArtist[];
}

export interface SubsonicArtists {
    ignoredArticles: string;
    index: SubsonicArtistIndex[];
}

// Album (ID3 mode)
export interface SubsonicAlbum {
    id: string;
    name: string;
    artist?: string;
    artistId?: string;
    coverArt?: string;
    songCount: number;
    duration: number;
    year?: number;
    genre?: string;
    starred?: string;
    created?: string;
    // OpenSubsonic extension
    bpm?: number;
}

export interface SubsonicAlbumWithSongs extends SubsonicAlbum {
    song: SubsonicSong[];
}

/** OpenSubsonic ReplayGain data, expressed in dB. */
export interface SubsonicReplayGain {
    /** Gain to apply for this track. */
    trackGain?: number;
    /** Fallback gain when a client cannot use track or album gain. */
    fallbackGain?: number;
    /** Embedded container-level gain, when available. */
    baseGain?: number;
    /** Track peak, when available. */
    trackPeak?: number;
    /** Album gain, when available. */
    albumGain?: number;
    /** Album peak, when available. */
    albumPeak?: number;
}

// Song
export interface SubsonicSong {
    id: string;
    parent?: string;
    title: string;
    isDir: false;
    album?: string;
    albumId?: string;
    artist?: string;
    artistId?: string;
    track?: number;
    discNumber?: number;
    year?: number;
    genre?: string;
    coverArt?: string;
    size?: number;
    contentType?: string;
    suffix?: string;
    duration?: number; // seconds
    bitRate?: number;
    playCount?: number;
    played?: string; // ISO date
    starred?: string; // ISO date
    userRating?: number; // 1-5
    created?: string;
    type?: 'music';
    isVideo?: false;
    // OpenSubsonic extensions
    bpm?: number;
    comment?: string;
    musicBrainzId?: string;
    replayGain?: SubsonicReplayGain;
}

// OpenSubsonic structured lyrics (getLyricsBySongId)
export interface SubsonicLyricLine {
    value: string;
    start?: number; // ms offset, present only for synced lyrics
}

export interface SubsonicStructuredLyrics {
    lang: string; // ISO 639-2 (3-char) or "xxx" if unknown
    synced: boolean;
    displayArtist?: string;
    displayTitle?: string;
    offset?: number; // ms adjustment for the whole block
    line: SubsonicLyricLine[];
}

export interface SubsonicLyricsList {
    structuredLyrics: SubsonicStructuredLyrics[];
}

// Genre
export interface SubsonicGenre {
    songCount: number;
    albumCount: number;
    value: string; // genre name (XML text content; JSON field)
}

// Playlist
export interface SubsonicPlaylist {
    id: string;
    name: string;
    comment?: string;
    owner?: string;
    public?: boolean;
    songCount: number;
    duration: number; // total seconds
    created?: string;
    changed?: string;
    coverArt?: string;
}

export interface SubsonicPlaylistWithSongs extends SubsonicPlaylist {
    entry: SubsonicSong[];
}

// Play queue (cross-device sync)
export interface SubsonicPlayQueue {
    entry?: SubsonicSong[];
    current?: string; // song id
    position?: number; // ms
    username?: string;
    changed?: string; // ISO date
    changedBy?: string; // client name
}

// Search results (search3 — ID3 mode)
export interface SubsonicSearchResult3 {
    artist: SubsonicArtist[];
    album: SubsonicAlbum[];
    song: SubsonicSong[];
}

// User info
export interface SubsonicUser {
    username: string;
    email?: string;
    scrobblingEnabled: boolean;
    adminRole: boolean;
    settingsRole: boolean;
    downloadRole: boolean;
    uploadRole: boolean;
    playlistRole: boolean;
    coverArtRole: boolean;
    commentRole: boolean;
    podcastRole: boolean;
    streamRole: boolean;
    jukeboxRole: boolean;
    shareRole: boolean;
    videoConversionRole: boolean;
    folder: number[];
}

// Internal auth context passed to handlers after parseSubsonicAuth.
//
// `userGroups`, `maxAgeRating`, and `isAgeRestricted` are required by the
// shared media-access helpers (library-group + age-rating gate). They are
// derived from the user row at auth time via `buildUserPermissions`.
export interface SubsonicAuthContext {
    /** Stable users.id UUID (from subsonic_client_passwords.user_id FK). Data key. */
    userId: UserId;
    username: string;
    ownerIsAdmin: boolean;
    displayName: string | null;
    clientName: string;
    format: SubsonicFormat;
    userGroups: string[];
    maxAgeRating: number | null;
    isAgeRestricted: boolean;
}

export type SubsonicHandler = (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
) => Promise<Response>;
