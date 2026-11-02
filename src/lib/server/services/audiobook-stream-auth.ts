// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Authorize audiobook bytes with an item-bound grant or an authenticated account.
 * Every request resolves the listener's own upstream credential; HLS/remux also
 * verifies that the upstream session belongs to this listener and book.
 */

import type postgres from 'postgres';
import type { UserContext } from '$lib/server/types';
import { checkMediaAccess } from '../middleware/media-access.js';
import { playbackGrantUserContext, validatePlaybackGrant } from './playback-grant.js';
import { getUserByUsername } from '../database/queries/users.queries.js';
import {
    AUDIOBOOKSHELF_PROVIDER,
    AUDIOBOOK_MEDIA_TYPE,
} from '../database/queries/audiobooks.queries.js';
import { resolveUserApiKey, type AbsCredentialDeps } from './audiobookshelf-credentials.service.js';
import { PluginSecrets } from '../tasks/secrets.js';
import { Logger } from '../utils/logger.js';
import { getConfigState } from '../config/config.service.js';

const logger = Logger.for('AudiobookStreamAuth');

/**
 * Per-user ABS key cache.
 *
 * Deliberately short: a revoked ABS key must stop working within a minute, and
 * an unlink must not leave a listener streaming for an hour. Long enough that a
 * 6-second HLS segment cadence hits it rather than the DB.
 */
const KEY_CACHE_TTL_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyCache = new Map<string, { key: string; expiresAt: number }>();

/**
 * Drop a cached key immediately.
 *
 * Currently only tests call this. Deliberately noted rather than implied: the
 * watch-sync unlink/forget paths do NOT reach into this cache, so a key revoked
 * upstream keeps being presented for up to {@link KEY_CACHE_TTL_MS}, after
 * which ABS 401s and the next sync cycle re-mints. The cache is per-process
 * anyway, so a cross-replica invalidation was never available here — the short
 * TTL is the bound, not this function.
 */
export function invalidateAudiobookKeyCache(userId?: string): void {
    if (userId) keyCache.delete(userId);
    else keyCache.clear();
}

export interface AudiobookStreamPrincipal {
    /** Lumastra `users.id`. */
    userId: string;
    username: string;
    /** `media_items.id` the token is pinned to. */
    mediaId: string;
    /** AudiobookShelf library-item id. */
    absItemId: string;
    /** That user's ABS API key. */
    absApiKey: string;
    /**
     * `play_sessions.id` of the row that proved {@link AuthenticateOpts.absSessionId}
     * belongs to this listener — present only when one was supplied.
     *
     * Returned from the ownership check rather than re-queried by the caller so
     * there is no second, unguarded way to obtain it: the only play session id a
     * handler can reach is one that just passed the check. The remux path needs
     * it to attach its `active_transcode_jobs` row.
     */
    playSessionId?: string;
    /**
     * `play_sessions.device_id` of that same row.
     *
     * Carried alongside because the remux job row needs a device and taking it
     * from the request would let a client label another device's transcode.
     */
    playSessionDeviceId?: string;
}

export type AudiobookStreamAuthFailure =
    | { ok: false; status: 401; reason: 'missing_token' | 'invalid_token' }
    | { ok: false; status: 404; reason: 'not_an_audiobook' | 'unknown_session' }
    | { ok: false; status: 403; reason: 'no_abs_link' | 'scope_required' }
    | { ok: false; status: 503; reason: 'database_unavailable' | 'abs_unavailable' };

export type AudiobookStreamAuthResult =
    ({ ok: true } & AudiobookStreamPrincipal) | AudiobookStreamAuthFailure;

export interface AuthenticateOpts {
    sql: postgres.Sql;
    /** The `stream_…` credential, from the URL path or the query string. */
    token: string | null | undefined;
    /** `media_items.id` from the route. */
    mediaId: string;
    clientIp: string;
    /**
     * AudiobookShelf transcode-session id, for the HLS path only.
     *
     * MUST be supplied whenever the request will be turned into a `/hls/:sid/…`
     * upstream fetch. The stream token pins the MEDIA id, not the session, and
     * ABS serves `/hls/:sid/*` with no authentication of its own — so without
     * this check a listener holding a valid token for a book they may read
     * could name any other user's in-flight session id and pull that book's
     * audio, defeating the library/age gate entirely.
     */
    absSessionId?: string;
    /** Injected in tests so the ABS calls are not made for real. */
    credentialDeps?: AbsCredentialDeps;
    /** Account identity already authenticated by forward-auth (Bearer/cookie). */
    authenticatedUser?: UserContext;
    liveUser?: UserContext;
    playbackSessionId?: string;
}

/**
 * Validate the stream token and resolve everything the proxy needs upstream.
 *
 * Wildcard (music) tokens are rejected: they are minted unscoped for the music
 * player, so honouring one here would let any music session pull any audiobook.
 */
export async function authenticateAudiobookStream(
    opts: AuthenticateOpts,
): Promise<AudiobookStreamAuthResult> {
    const { sql, token, mediaId, clientIp } = opts;

    if (!token && !opts.authenticatedUser)
        return { ok: false, status: 401, reason: 'missing_token' };

    // Guard the `::uuid` casts below. `checkMediaAccess` fails OPEN for admins
    // on a cast error, so an admin can mint a token for a non-UUID mediaId; the
    // route would then 500 inside Postgres rather than 404.
    if (!UUID_RE.test(mediaId)) return { ok: false, status: 404, reason: 'not_an_audiobook' };

    const session = opts.authenticatedUser
        ? { userId: opts.authenticatedUser.userId, username: opts.authenticatedUser.username }
        : token
          ? await validatePlaybackGrant(token, {
                clientIp,
                route: {
                    kind: 'audiobook',
                    mediaId,
                    playbackSessionId: opts.playbackSessionId,
                    audiobookSessionId: opts.absSessionId,
                },
            })
          : null;
    if (!session || 'reason' in session || ('isWildcard' in session && session.isWildcard)) {
        return { ok: false, status: 401, reason: 'invalid_token' };
    }
    const user =
        opts.authenticatedUser ??
        opts.liveUser ??
        (await playbackGrantUserContext({
            username: session.username,
            user_id: session.userId,
            minted_by_admin: 'mintedByAdmin' in session && session.mintedByAdmin === true,
        }));
    if (!user || !(await checkMediaAccess(sql, mediaId, user))) {
        return { ok: false, status: 404, reason: 'not_an_audiobook' };
    }

    // `status`/`is_dismissed` are re-checked on every byte, not just at mint: a
    // stream token lives for hours, so a book withdrawn or dismissed mid-listen
    // would otherwise keep streaming until the token expired.
    //
    // The live UserContext has passed checkMediaAccess above; this query additionally
    // verifies the current catalog state and the AudiobookShelf source identity.
    const [row] = await sql<Array<{ abs_item_id: string }>>`
        SELECT ei.external_id AS abs_item_id
          FROM media_items mi
          JOIN external_ids ei
            ON ei.media_id   = mi.id
           AND ei.provider   = ${AUDIOBOOKSHELF_PROVIDER}
           AND ei.media_type = ${AUDIOBOOK_MEDIA_TYPE}
         WHERE mi.id           = ${mediaId}::uuid
           AND mi.media_type   = ${AUDIOBOOK_MEDIA_TYPE}
           AND mi.status       = 'active'
           AND mi.is_dismissed = FALSE
         LIMIT 1
    `;
    if (!row) return { ok: false, status: 404, reason: 'not_an_audiobook' };

    let ownSession: { id: string; device_id: string } | undefined;
    if (opts.absSessionId !== undefined) {
        ownSession = await resolveOwnAbsSession(sql, {
            absSessionId: opts.absSessionId,
            userId: session.userId,
            mediaId,
        });
        if (
            !ownSession ||
            ('playbackSessionId' in session &&
                session.playbackSessionId &&
                session.playbackSessionId !== ownSession.id)
        ) {
            return { ok: false, status: 404, reason: 'unknown_session' };
        }
    }

    let absApiKey: string | null;
    try {
        absApiKey = await resolveAbsKey(sql, session.username, opts.credentialDeps);
    } catch {
        // Transport failure reaching ABS. Distinct from "this account has no ABS
        // counterpart": 403 tells a player to stop, 503 tells it to retry, and a
        // brief ABS blip must not look like a permanent authorization failure.
        return { ok: false, status: 503, reason: 'abs_unavailable' };
    }
    if (!absApiKey) return { ok: false, status: 403, reason: 'no_abs_link' };

    return {
        ok: true,
        userId: session.userId,
        username: session.username,
        mediaId,
        absItemId: row.abs_item_id,
        absApiKey,
        ...(ownSession !== undefined
            ? { playSessionId: ownSession.id, playSessionDeviceId: ownSession.device_id }
            : {}),
    };
}

/**
 * Is this ABS transcode session one Lumastra opened, for THIS user and THIS
 * book? Returns the `play_sessions.id` that proves it, or undefined.
 *
 * Answered from our own `play_sessions` rows — the same rows the watch-sync
 * connector reads to exempt its own sessions from the position freeze — rather
 * than from ABS's session list. Two reasons: it is authoritative about who
 * asked us to start the transcode (ABS's list would only tell us the session
 * exists), and it costs no upstream round trip on a path that runs once per
 * six-second segment.
 *
 * The consequence for the player: starting a transcode MUST write a
 * `play_sessions` row with `source = 'audiobookshelf'` and the ABS session id
 * in `source_session_id` before any segment is requested. That row is already
 * required by the sync connector, so this adds no new bookkeeping — it just
 * makes the omission fail loudly instead of silently widening access.
 */
async function resolveOwnAbsSession(
    sql: postgres.Sql,
    args: { absSessionId: string; userId: string; mediaId: string },
): Promise<{ id: string; device_id: string } | undefined> {
    const rows = await sql<Array<{ id: string; device_id: string }>>`
        SELECT id, device_id
          FROM play_sessions
         WHERE source            = ${AUDIOBOOKSHELF_PROVIDER}
           AND source_session_id = ${args.absSessionId}
           AND user_id           = ${args.userId}::uuid
           AND media_id          = ${args.mediaId}::uuid
           AND status IN ('ACTIVE', 'PAUSED')
         LIMIT 1
    `;
    return rows[0];
}

/** Throws on a transport failure reaching ABS; returns null when unlinked. */
async function resolveAbsKey(
    sql: postgres.Sql,
    username: string,
    deps?: AbsCredentialDeps,
): Promise<string | null> {
    const user = await getUserByUsername(sql, username);
    if (!user) return null;

    const cached = keyCache.get(user.id);
    if (cached && cached.expiresAt > Date.now()) return cached.key;

    const credentialDeps = deps ?? (await defaultCredentialDeps());
    let key: string | null;
    try {
        key = await resolveUserApiKey({
            secrets: new PluginSecrets(sql),
            deps: credentialDeps,
            userId: user.id,
            username: user.username,
            reenablePull: true,
            // Same rationale as the session path: a listener is mid-playback.
            autoCreate: autoCreateAbsUsers(),
        });
    } catch (error) {
        // Transport failure against ABS. Do NOT cache, and do NOT flatten to
        // null — the caller turns null into a 403 ("no link"), which tells a
        // player to give up. Rethrow so it becomes a retryable 503.
        logger.warn('Could not reach AudiobookShelf to resolve a listener key', {
            username,
            error: String(error),
        });
        throw error;
    }

    if (key) {
        pruneExpiredKeys();
        keyCache.set(user.id, { key, expiresAt: Date.now() + KEY_CACHE_TTL_MS });
    }
    return key;
}

/**
 * Drop entries whose TTL has passed.
 *
 * Without this the map only ever shrinks when the SAME user is looked up again,
 * so in a long-running process every user who ever streamed once keeps a live
 * entry. Cheap because the map is bounded by "users who listened in the last
 * minute", and it runs only on a cache miss.
 */
function pruneExpiredKeys(): void {
    const now = Date.now();
    for (const [userId, entry] of keyCache) {
        if (entry.expiresAt <= now) keyCache.delete(userId);
    }
}

/**
 * The ABS client is imported lazily: it builds its singleton at module scope
 * from `config.AUDIOURL`, and a static import here would drag that construction
 * into every test that touches a route on this surface (the same reason the
 * Active Streams merge imports it lazily).
 */
/**
 * Whether to provision an ABS account for a listener who has none.
 *
 * `getConfigState()` rather than `get()` for the same reason the sibling session service uses it: config.ts falls back to env-only config outside a full
 * SvelteKit context, where `get()` throws. The schema default here is ON, so
 * "config did not load" and "config loaded with the default" must behave
 * identically.
 */
function autoCreateAbsUsers(): boolean {
    const state = getConfigState();
    return state ? state.values['AUDIOBOOK_AUTO_CREATE_USERS'] !== false : true;
}

async function defaultCredentialDeps(): Promise<AbsCredentialDeps> {
    const { audiobookshelfClient } = await import('../audiobookshelf.js');
    return {
        listUsers: () => audiobookshelfClient.listUsers(),
        createApiKey: (input) => audiobookshelfClient.createApiKey(input),
        deactivateApiKey: (id) => audiobookshelfClient.deactivateApiKey(id),
        createUser: (input) => audiobookshelfClient.createUser(input),
    };
}

/** Read the media URL credential; account Bearer auth belongs to middleware. */
export function extractStreamToken(
    _request: Request,
    url: URL,
    _pathToken?: string,
): string | null {
    // Path-carried credentials and stream_token are retired; manifests carry grant
    // explicitly on every URI. Account Bearer credentials are resolved by middleware.
    const grant = url.searchParams.get('grant');
    return grant || null;
}
