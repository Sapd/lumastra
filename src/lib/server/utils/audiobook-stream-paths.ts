// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The exact `/api/v1` audiobook byte paths whose auth is the in-route stream-token
 * check rather than the surface's normal bearer gate.
 *
 * Two places must agree on this set — the forward-auth branch that lets the
 * request through, and the hooks.server.ts backstop that would otherwise 401 an
 * identity-less `/api/v1` request. A tiny standalone module (no DB, no config)
 * so both can import it without dragging the streaming stack into boot, and so
 * the two can never drift apart.
 *
 * **Structural, not `includes()`.** A substring test would widen the exemption
 * far beyond these routes: `path.includes('/file/')` is also true of
 * `/api/v1/audiobook/file/bookmarks`, i.e. any future sibling endpoint reached
 * with a `{mediaId}` of the literal string `file`. That would make an
 * unrelated route unauthenticated on attacker-chosen input. The anchored
 * patterns below match the full path or nothing.
 */

/** `/api/v1/audiobooks/{mediaId}/files/{trackIndex}` */
const AUDIOBOOK_FILE_PATH = /^\/api\/v1\/audiobooks\/[^/]+\/files\/[^/]+$/;

/** `/api/v1/audiobook/{mediaId}/hls/playback/{playbackSessionId}/{file}` */
const AUDIOBOOK_HLS_PATH = /^\/api\/v1\/audiobook\/[^/]+\/hls\/[^/]+\/[^/]+\/[^/]+$/;

/**
 * `/api/v1/audiobooks/{mediaId}/remux/{trackIndex}` — the on-the-fly AAC re-encode for
 * files AudiobookShelf direct-plays but a browser cannot decode.
 *
 * Same shape and same reason as the file path: an `<audio>` element cannot set an
 * `Authorization` header, so this route's credential is the `?grant=` its
 * own handler validates. The session id and start offset ride in the query and so
 * need no pattern of their own.
 */
const AUDIOBOOK_REMUX_PATH = /^\/api\/v1\/audiobooks\/[^/]+\/remux\/[^/]+$/;

/**
 * True only for the three byte-piping sub-paths. Everything else under
 * `/api/v1/audiobooks/` or `/api/v1/audiobook/` — including anything added later — keeps the surface's
 * ordinary authentication.
 */
export function isAudiobookByteProxyPath(pathname: string): boolean {
    return (
        AUDIOBOOK_FILE_PATH.test(pathname) ||
        AUDIOBOOK_HLS_PATH.test(pathname) ||
        AUDIOBOOK_REMUX_PATH.test(pathname)
    );
}

/**
 * The singular byte paths P9 removed: `/api/v1/audiobook/{mediaId}/file/{ino}` and
 * `/api/v1/audiobook/{mediaId}/remux/{ino}`. They are not aliases; a GET or HEAD answers
 * `410 route_retired` without a credential, so a client learns the path is gone and
 * where its replacement lives, and nothing about the book or the file.
 */
const RETIRED_AUDIOBOOK_BYTE_PATH = /^\/api\/v1\/audiobook\/[^/]+\/(?:file|remux)\/[^/]+$/;

/** True only for the retired singular file and remux paths (not the HLS family). */
export function isRetiredAudiobookBytePath(pathname: string): boolean {
    return RETIRED_AUDIOBOOK_BYTE_PATH.test(pathname);
}
