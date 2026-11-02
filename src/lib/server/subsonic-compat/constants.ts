// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Constants
// Stable identifiers and cache keys for the Subsonic protocol surface.

import { createHash } from 'crypto';
import { config } from '$lib/server/config';

export const SUBSONIC_API_VERSION = '1.16.1';
export const SUBSONIC_TYPE = 'lumastra';
export const SUBSONIC_SERVER_VERSION = '1.0.0';

// Stable server ID derived from DATABASE_URL — consistent across restarts
// so OpenSubsonic clients don't think they're talking to a different server
// after a process restart. 32 hex chars (no dashes).
export const SUBSONIC_SERVER_ID = (() => {
    const hash = createHash('sha256')
        .update(config.DATABASE_URL || 'lumastra-default')
        .digest('hex');
    return hash.slice(0, 32);
})();

// Valkey cache key prefix and TTL for Subsonic auth lookups.
// Short TTL because the DB row is the source of truth — cache only smooths
// the per-request lookup cost (Subsonic auth happens on every API call).
export const TOKEN_CACHE_PREFIX = 'subsoniccompat:auth:';
export const TOKEN_CACHE_TTL = 60; // seconds

// Cross-device play queue sync (savePlayQueue / getPlayQueue).
export const PLAY_QUEUE_CACHE_PREFIX = 'subsoniccompat:playqueue:';

export const BOOKMARK_CACHE_PREFIX = 'subsonic:bookmarks:';
export const PLAY_QUEUE_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

export const MAX_STREAM_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

export const AUDIO_MIME_TYPES: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.opus': 'audio/ogg; codecs=opus',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.aac': 'audio/aac',
    '.aiff': 'audio/aiff',
    '.alac': 'audio/mp4',
};

export const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
} as const;
