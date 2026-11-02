// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { userAllowsLiveTv } from '$lib/server/auth/livetv-user-policy.js';
import { playbackGrantSessionUsable } from '../database/queries/play-sessions.queries.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { Database } from '../database/connection';
import type { UserContext } from '../types';
import { checkMediaAccess } from '../middleware/media-access';
import { resolveTokenUserAccess } from '../auth/resolve-token-user-access';
import { toUserId } from '$lib/shared/user-id';
import { withTx } from '../database/with-tx';
import { config } from '../config';
import { apiUrl, type ApiSurface } from '$lib/shared/api-urls';
import {
    STREAM_TOKEN_PREFIX,
    WILDCARD_IP,
    type StreamingSessionRecord,
    type ValidatedStreamingSession,
} from '../oauth/streaming-session.service';
import { isDeviceSessionTombstoned } from '../oauth/device-session-liveness';
import type { PlaybackGrantRoute } from './playback-grant-routes';
export {
    resolvePlaybackGrantRoute,
    getLivetvPlaybackSession,
    registerPlaybackGrantRoute,
} from './playback-grant-routes';
export type {
    PlaybackGrantRoute,
    LivetvPlaybackSession,
    LivetvPlaybackSessionResolver,
} from './playback-grant-routes';

export type PlaybackGrantKind = 'video' | 'music' | 'audiobook' | 'live' | 'preview';
export const PLAYBACK_GRANT_CEILINGS_MS: Readonly<Record<PlaybackGrantKind, number>> = {
    preview: 60 * 60 * 1000,
    video: 24 * 60 * 60 * 1000,
    audiobook: 24 * 60 * 60 * 1000,
    music: 6 * 60 * 60 * 1000,
    live: 6 * 60 * 60 * 1000,
};
const ABSOLUTE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const UNPINNED_CEILING_MS = 6 * 60 * 60 * 1000;
const RENEW_AHEAD_MS = 5 * 60 * 1000;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export interface PlaybackGrant {
    id: string;
    userId: string;
    mediaId: string;
    playbackSessionId: string | null;
    kind: PlaybackGrantKind;
    clientIp: string;
    ipPinned: boolean;
    deviceSessionId: string | null;
    createdAt: Date;
    expiresAt: Date;
    renewAfter: Date;
    renewHref: string;
    param: 'grant';
}
export interface MintedPlaybackGrant extends PlaybackGrant {
    token: string;
}
export type RenewedPlaybackGrant = MintedPlaybackGrant;
export interface MintPlaybackGrantParams {
    userId: string;
    mediaId: string;
    playbackSessionId: string | null;
    kind: PlaybackGrantKind;
    clientIp: string;
    deviceSessionId?: string | null;
    /** Explicit cast/handoff request; unpinning is subject to admin policy. */
    castTarget?: boolean;
    /** Requested lifetime in milliseconds, clamped to the media-kind ceiling. */
    ttl?: number;
    parentTokenHash?: string | null;
    mintedByAdmin?: boolean;
    surface?: ApiSurface;
    /**
     * The grant belongs to an offline DOWNLOAD session (audiobooks only): the client
     * hands its URLs to a background transfer that may run for days and sends no
     * reports, so it gets the configured download lifetime (up to seven days) instead
     * of the media-kind ceiling, and the 6 h cap on unpinned (cast) grants does not
     * apply. Everything else about the grant is unchanged: it stays bound to the user,
     * the media item and the session, honours the IP pin when it has one, and ends
     * when the session does.
     */
    download?: boolean;
}

function sqlConnection(): Sql {
    return new Database().getSql();
}
function hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
function newToken(): string {
    return STREAM_TOKEN_PREFIX + randomBytes(32).toString('hex');
}
/** Restrict pre-migration rows too, including positive-cache entries during rollout. */
function grantKind(row: StreamingSessionRecord): PlaybackGrantKind {
    return row.grant_kind === 'video' && row.play_session_id?.startsWith('preview-')
        ? 'preview'
        : (row.grant_kind ?? 'video');
}
function metadata(row: StreamingSessionRecord, surface: ApiSurface = 'v1'): PlaybackGrant {
    const expiresAt = new Date(row.expires_at);
    const ttl = Math.min(
        Number(row.grant_ttl_ms ?? PLAYBACK_GRANT_CEILINGS_MS[grantKind(row)]),
        PLAYBACK_GRANT_CEILINGS_MS[grantKind(row)],
    );
    return {
        id: row.id,
        userId: row.user_id,
        mediaId: row.media_item_id!,
        playbackSessionId: row.play_session_id ?? null,
        kind: grantKind(row),
        clientIp: row.client_ip,
        ipPinned: row.client_ip !== WILDCARD_IP,
        deviceSessionId: row.device_session_id,
        createdAt: new Date(row.created_at),
        expiresAt,
        renewAfter: new Date(expiresAt.getTime() - Math.min(RENEW_AHEAD_MS, ttl / 2)),
        renewHref: apiUrl(surface, `/playback/grants/${row.id}/renew`),
        param: 'grant',
    };
}

export async function mintPlaybackGrant(
    params: MintPlaybackGrantParams,
): Promise<MintedPlaybackGrant> {
    if (!params.mediaId || params.mediaId === '*' || params.mediaId === 'wildcard') {
        throw new Error('Playback grants require a specific media item');
    }
    if (params.kind === 'preview' && !params.playbackSessionId) {
        throw new Error('Preview grants require a preview session');
    }
    const clientIp =
        params.castTarget === true && config.STREAM_TOKEN_WILDCARD_IP !== false
            ? WILDCARD_IP
            : params.clientIp;
    if (params.download && (params.kind !== 'audiobook' || !params.playbackSessionId)) {
        throw new Error('Download grants require an audiobook download session');
    }
    const ceiling = params.download
        ? Math.min(config.DOWNLOAD_SESSION_GRANT_HOURS * 60 * 60 * 1000, ABSOLUTE_LIFETIME_MS)
        : Math.min(
              PLAYBACK_GRANT_CEILINGS_MS[params.kind],
              clientIp === WILDCARD_IP ? UNPINNED_CEILING_MS : Infinity,
          );
    if (
        !ceiling ||
        (params.ttl !== undefined && (!Number.isFinite(params.ttl) || params.ttl <= 0))
    ) {
        throw new Error('Invalid playback grant kind or ttl');
    }
    const ttl = Math.max(1, Math.floor(Math.min(params.ttl ?? ceiling, ceiling)));
    if (params.deviceSessionId && isDeviceSessionTombstoned(params.deviceSessionId)) {
        throw new Error('Device session has been revoked');
    }
    const token = newToken();
    const expiresAt = new Date(Date.now() + ttl);
    // The column is CHECKed to the media-kind ceiling (24 h): it is the renewal window.
    // A download's longer life is carried by expires_at alone.
    const grantTtlMs = Math.min(ttl, PLAYBACK_GRANT_CEILINGS_MS[params.kind]);
    const sql = sqlConnection();
    const rows = await sql<StreamingSessionRecord[]>`
        INSERT INTO hls_playback_tokens (
            token_hash, username, user_id, media_item_id, is_wildcard,
            play_session_id, grant_kind, grant_ttl_ms, client_ip,
            device_session_id, expires_at, parent_token_hash, minted_by_admin
        ) SELECT ${hash(token)}, u.username, u.id, ${params.mediaId}, false,
            ${params.playbackSessionId}, ${params.kind}, ${grantTtlMs}, ${clientIp},
            ${params.deviceSessionId ?? null}, ${expiresAt},
            ${params.parentTokenHash ?? null}, ${params.mintedByAdmin ?? false}
        FROM users u WHERE u.id = ${params.userId} AND u.disabled_at IS NULL
            AND (${params.kind} <> 'live' OR u.allow_live_tv IS DISTINCT FROM false)
        RETURNING *
    `;
    if (!rows[0]) throw new Error('Playback grant owner not found');
    // Close mint-after-revoke races just as the legacy store does.
    if (params.deviceSessionId && isDeviceSessionTombstoned(params.deviceSessionId)) {
        await revokePlaybackGrant(rows[0].id, params.userId);
        throw new Error('Device session has been revoked');
    }
    return { ...metadata(rows[0], params.surface), token };
}

export async function getPlaybackGrant(
    id: string,
    ownerUserId: string,
    surface: ApiSurface = 'v1',
): Promise<PlaybackGrant | null> {
    if (!UUID.test(id)) return null;
    const sql = sqlConnection();
    const rows = await sql<StreamingSessionRecord[]>`
        SELECT * FROM hls_playback_tokens
        WHERE id = ${id} AND user_id = ${ownerUserId}
            AND is_active = true AND expires_at > NOW() AND is_wildcard = false
            AND grant_kind IS NOT NULL
            AND (play_session_id IS NULL OR grant_kind IN ('live', 'preview') OR play_session_id LIKE 'preview-%' OR EXISTS (
                SELECT 1 FROM play_sessions ps WHERE ps.id = CASE WHEN hls_playback_tokens.play_session_id ~* ${UUID.source}
                    THEN hls_playback_tokens.play_session_id::uuid END
                    AND ps.status IN ('ACTIVE', 'PAUSED') AND ${playbackGrantSessionUsable(sql)}
            ))
    `;
    if (rows[0]?.grant_kind === 'live' && !(await userAllowsLiveTv(rows[0].username))) return null;
    return rows[0] && (await previewBindingActive(rows[0])) ? metadata(rows[0], surface) : null;
}

/** The Live TV session store (Valkey) cannot be consulted; the caller should answer 503. */
export class PlaybackGrantStoreUnavailableError extends Error {
    constructor(cause?: unknown) {
        super('Live TV session store unavailable', { cause });
        this.name = 'PlaybackGrantStoreUnavailableError';
    }
}

export async function renewPlaybackGrant(
    id: string,
    ownerUserId: string,
    surface: ApiSurface = 'v1',
    token?: string,
): Promise<RenewedPlaybackGrant | null> {
    if (!UUID.test(id)) return null;
    const sql = sqlConnection();
    // Coordination-store liveness is checked without holding a row lock.
    // Repeat the locked credential checks before extending a verified binding.
    type Attempt = RenewedPlaybackGrant | { storeCheck: StreamingSessionRecord } | null;
    const attempt = (bindingVerified: boolean) =>
        withTx<Attempt>(sql, async (tx) => {
            const rows = await tx<(StreamingSessionRecord & { is_download: boolean })[]>`
                SELECT t.*, EXISTS (
                    SELECT 1 FROM play_sessions dl WHERE dl.id = CASE WHEN t.play_session_id ~* ${UUID.source}
                        THEN t.play_session_id::uuid END AND dl.purpose = 'download'
                ) AS is_download
                FROM hls_playback_tokens t
                JOIN users u ON u.id = t.user_id
                WHERE t.id = ${id} AND t.user_id = ${ownerUserId}
                    AND t.is_active = true AND t.expires_at > NOW()
                    AND t.is_wildcard = false AND t.grant_kind IS NOT NULL AND u.disabled_at IS NULL AND u.deleted_at IS NULL
                    AND (t.play_session_id IS NULL OR t.grant_kind IN ('live', 'preview') OR t.play_session_id LIKE 'preview-%' OR EXISTS (
                        SELECT 1 FROM play_sessions ps WHERE ps.id = CASE WHEN t.play_session_id ~* ${UUID.source}
                            THEN t.play_session_id::uuid END
                            AND ps.status IN ('ACTIVE', 'PAUSED') AND ${playbackGrantSessionUsable(sql)}
                    ))
                    AND (t.parent_token_hash IS NULL OR NOT EXISTS (
                        SELECT 1 FROM personal_access_tokens p
                        WHERE p.token_hash = t.parent_token_hash AND p.revoked_at IS NOT NULL
                    ))
                    AND (t.device_session_id IS NULL OR NOT EXISTS (
                        SELECT 1 FROM oauth_refresh_tokens r WHERE r.device_session_id = t.device_session_id
                    ) OR EXISTS (
                        SELECT 1 FROM oauth_refresh_tokens r
                        WHERE r.device_session_id = t.device_session_id AND r.revoked_at IS NULL
                    ))
                FOR UPDATE OF t
            `;
            const row = rows[0];
            if (
                !row ||
                (row.device_session_id && isDeviceSessionTombstoned(row.device_session_id))
            ) {
                return null;
            }
            if (!token || hash(token) !== row.token_hash || !row.grant_kind) return null;
            const user = await playbackGrantUserContext(row);
            if (
                !user ||
                (row.grant_kind === 'live' && !user.hasLiveTvPermission) ||
                !(await checkMediaAccess(tx, row.media_item_id!, user))
            )
                return null;
            if (!bindingVerified && (row.grant_kind === 'live' || grantKind(row) === 'preview'))
                return { storeCheck: row };
            const kind = grantKind(row);
            const ttl = Math.min(
                Number(row.grant_ttl_ms ?? PLAYBACK_GRANT_CEILINGS_MS[kind]),
                PLAYBACK_GRANT_CEILINGS_MS[kind],
            );
            const created = new Date(row.created_at).getTime();
            // A download grant is not held to the unpinned cap, is never shortened by a
            // renewal (it was minted for up to seven days), and still ends at the absolute
            // lifetime.
            const expiresAt = row.is_download
                ? new Date(
                      Math.max(
                          new Date(row.expires_at).getTime(),
                          Math.min(Date.now() + ttl, created + ABSOLUTE_LIFETIME_MS),
                      ),
                  )
                : new Date(
                      Math.min(
                          Date.now() + ttl,
                          Date.now() +
                              (row.client_ip === WILDCARD_IP ? UNPINNED_CEILING_MS : Infinity),
                          created + ABSOLUTE_LIFETIME_MS,
                      ),
                  );
            if (expiresAt.getTime() <= Date.now()) return null;
            const updated = await tx<StreamingSessionRecord[]>`
                UPDATE hls_playback_tokens SET expires_at = ${expiresAt}
                WHERE id = ${id} RETURNING *
            `;
            return { ...metadata(updated[0], surface), token };
        });
    let result = await attempt(false);
    if (result && 'storeCheck' in result) {
        if (
            !(await previewBindingActive(result.storeCheck)) ||
            !(await liveBindingActive(result.storeCheck))
        )
            return null;
        result = await attempt(true);
    }
    const renewed = result && 'token' in result ? result : null;
    if (renewed) invalidatePlaybackGrantCache(id);
    return renewed;
}

export async function revokePlaybackGrant(id: string, ownerUserId: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const sql = sqlConnection();
    const rows = await sql<{ id: string }[]>`
        UPDATE hls_playback_tokens t SET is_active = false, ended_reason = 'client_request'
        WHERE t.id = ${id} AND t.user_id = ${ownerUserId}
            AND (t.is_active = true OR (
                -- A reaped restart grant still signals recoverable expiry.
                -- An explicit owner revocation must make that denial terminal.
                t.ended_reason = 'reaped' AND t.grant_kind = 'video'
                AND t.expires_at > NOW() AND EXISTS (
                    SELECT 1 FROM play_sessions ps WHERE ps.id = CASE WHEN t.play_session_id ~* ${UUID.source}
                    THEN t.play_session_id::uuid END
                        AND ps.status = 'CRASHED' AND ps.stop_reason = 'server_restart')
            ))
        RETURNING t.id
    `;
    invalidatePlaybackGrantCache(id);
    return rows.length > 0;
}

export async function revokeGrantsForPlaySession(
    playbackSessionId: string,
    sql: Sql = sqlConnection(),
    reason: 'stopped' | 'reaped' | 'superseded' | 'admin_kill' = 'stopped',
): Promise<number> {
    const rows = await sql<{ id: string }[]>`
        UPDATE hls_playback_tokens SET is_active = false, ended_reason = ${reason}
        WHERE play_session_id = ${playbackSessionId} AND is_active = true RETURNING id
    `;
    invalidatePlaybackGrantCache(undefined, playbackSessionId);
    return rows.length;
}

export type PlaybackGrantFailureReason =
    | 'expired'
    | 'revoked'
    | 'ip_mismatch'
    | 'wrong_scope'
    | 'session_ended'
    | 'session_restarted'
    | 'invalid';
export interface PlaybackGrantFailure {
    reason: PlaybackGrantFailureReason;
    grantId?: string;
}
interface CachedGrant {
    row: StreamingSessionRecord & { is_music_prefetch?: boolean };
    until: number;
}
// Local invalidation is immediate. Other processes may accept a revoked grant for <=5 s.
const positiveCache = new Map<string, CachedGrant>();
const activityWrites = new Map<string, number>();
const liveHeartbeats = new Map<string, number>();
let cacheGeneration = 0;
export function invalidatePlaybackGrantCache(id?: string, sessionId?: string): void {
    cacheGeneration++;
    if (sessionId) liveHeartbeats.delete(sessionId);
    else if (!id) liveHeartbeats.clear();
    for (const [key, entry] of positiveCache) {
        if ((!id && !sessionId) || entry.row.id === id || entry.row.play_session_id === sessionId)
            positiveCache.delete(key);
    }
    if (id) activityWrites.delete(id);
    else activityWrites.clear();
}

/** Fresh owner permissions, preserving the minting credential's admin ceiling. */
export async function playbackGrantUserContext(
    row: Pick<StreamingSessionRecord, 'username' | 'user_id' | 'minted_by_admin' | 'grant_kind'>,
): Promise<UserContext | null> {
    const access = await resolveTokenUserAccess(row.username, { freshGroups: true });
    if (!access || access.disabled || access.deleted) return null;
    const admin = row.minted_by_admin === true && access.permissions.ownerIsAdmin;
    const maxAge = admin ? access.permissions.maxAgeRating : access.nonAdminMaxAgeRating;
    return {
        userId: toUserId(row.user_id),
        username: row.username,
        groups: access.userGroups.join('|'),
        userGroups: access.userGroups,
        hasWatchPermission: true,
        hasLiveTvPermission:
            (row.grant_kind !== 'live' || access.permissions.hasLiveTvPermission) &&
            (await userAllowsLiveTv(row.username)),
        hasRequestPermission: true,
        ownerIsAdmin: access.permissions.ownerIsAdmin,
        mediaAccessIsAdmin: admin,
        maxAgeRating: maxAge,
        isAgeRestricted: maxAge !== null,
        isModerator: access.permissions.isModerator,
        liveTvPriority: 'low',
    };
}
/** Renewal checks Live liveness without refreshing or rejoining the viewer. */
async function liveBindingActive(row: StreamingSessionRecord): Promise<boolean> {
    if (row.grant_kind !== 'live') return true;
    if (!row.play_session_id || !(await userAllowsLiveTv(row.username))) return false;
    const { getLiveTvSessionService } = await import('./livetv/livetv-session.service.js');
    // Read-only: getPlaybackSession would end the session and revoke grants as a side effect.
    let session;
    try {
        session = await getLiveTvSessionService().peekPlaybackSession(row.play_session_id);
    } catch (error) {
        throw new PlaybackGrantStoreUnavailableError(error);
    }
    return !!session && session.state === 'active' && session.username === row.username;
}

/** Preview IDs bind to the preview store, never the UUID play_sessions table. */
async function previewBindingActive(row: StreamingSessionRecord): Promise<boolean> {
    if (grantKind(row) !== 'preview') return !row.play_session_id?.startsWith('preview-');
    if (!row.play_session_id) return false;
    const { getPreviewSession } = await import('./preview-session.service');
    const preview = await getPreviewSession(row.play_session_id, { requireLive: true });
    return (
        !!preview &&
        preview.userId === row.user_id &&
        preview.itemId.toLowerCase() === row.media_item_id?.toLowerCase()
    );
}

export async function validatePlaybackGrant(
    secret: string,
    { clientIp, route }: { clientIp: string; route: PlaybackGrantRoute },
): Promise<ValidatedStreamingSession | PlaybackGrantFailure> {
    if (!secret.startsWith(STREAM_TOKEN_PREFIX)) return { reason: 'invalid' };
    const sql = sqlConnection();
    const tokenHash = hash(secret);
    const now = Date.now();
    const generation = cacheGeneration;
    const cached = positiveCache.get(tokenHash);
    // An unpromoted deck depends on another live session: recheck it on every request.
    let row =
        cached && cached.until > now && !cached.row.is_music_prefetch ? cached.row : undefined;
    let sessionRestarted = false;
    if (!row) {
        positiveCache.delete(tokenHash);
        const rows = await sql<
            (StreamingSessionRecord & {
                failure_reason?: PlaybackGrantFailureReason;
                is_music_prefetch: boolean;
            })[]
        >`
            SELECT t.*, (t.grant_kind = 'music' AND EXISTS (
                SELECT 1 FROM play_sessions ps WHERE ps.id = CASE
                    WHEN t.play_session_id ~* ${UUID.source} THEN t.play_session_id::uuid END
                    AND ps.purpose = 'prefetch'
            )) AS is_music_prefetch, CASE
                WHEN u.disabled_at IS NOT NULL OR u.deleted_at IS NOT NULL THEN 'revoked'
                WHEN t.parent_token_hash IS NOT NULL AND EXISTS (
                    SELECT 1 FROM personal_access_tokens p WHERE p.token_hash = t.parent_token_hash
                        AND p.revoked_at IS NOT NULL) THEN 'revoked'
                WHEN t.device_session_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM oauth_refresh_tokens r WHERE r.device_session_id = t.device_session_id)
                    AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r
                        WHERE r.device_session_id = t.device_session_id AND r.revoked_at IS NULL)
                    THEN 'revoked'
                -- Only restart-orphaned video playback is recoverable. An
                -- explicit stop/kill/revocation must never mint a replacement.
                WHEN t.grant_kind = 'video' AND (t.is_active OR t.ended_reason = 'reaped')
                    AND t.expires_at > NOW() AND EXISTS (
                        SELECT 1 FROM play_sessions ps WHERE ps.id = CASE WHEN t.play_session_id ~* ${UUID.source}
                        THEN t.play_session_id::uuid END
                            AND ps.status = 'CRASHED' AND ps.stop_reason = 'server_restart')
                    THEN 'session_restarted'
                -- Ended with its playback session (completed, stopped, replaced, reaped).
                WHEN NOT t.is_active
                    AND t.ended_reason IN ('stopped', 'reaped', 'superseded', 'admin_kill')
                    THEN 'session_ended'
                -- Swept after expiry or inactivity: still "expired" to the client.
                WHEN NOT t.is_active AND t.ended_reason IN ('expired', 'inactivity') THEN 'expired'
                WHEN NOT t.is_active THEN 'revoked'
                WHEN t.expires_at <= NOW() THEN 'expired'
                WHEN t.play_session_id IS NOT NULL AND t.grant_kind NOT IN ('live', 'preview')
                    AND t.play_session_id NOT LIKE 'preview-%' AND NOT EXISTS (
                        SELECT 1 FROM play_sessions ps WHERE ps.id = CASE WHEN t.play_session_id ~* ${UUID.source}
                        THEN t.play_session_id::uuid END
                            AND ps.status IN ('ACTIVE', 'PAUSED') AND ${playbackGrantSessionUsable(sql)}) THEN 'session_ended'
                ELSE NULL END AS failure_reason
            FROM hls_playback_tokens t JOIN users u ON u.id = t.user_id
            WHERE t.token_hash = ${tokenHash} AND t.grant_kind IS NOT NULL
                AND t.is_wildcard = false
        `;
        const found = rows[0];
        if (!found) return { reason: 'invalid' };
        if (found.failure_reason && found.failure_reason !== 'session_restarted')
            return { reason: found.failure_reason, grantId: found.id };
        sessionRestarted = found.failure_reason === 'session_restarted';
        row = found;
    }
    if (row.grant_kind === 'live') {
        const access = await resolveTokenUserAccess(row.username, { freshGroups: true });
        if (
            !access ||
            access.disabled ||
            access.deleted ||
            !access.permissions.hasLiveTvPermission ||
            !(await userAllowsLiveTv(row.username, { continuation: true }))
        )
            return { reason: 'revoked', grantId: row.id };
    }
    const grantId = row.id;
    const fail = (reason: PlaybackGrantFailureReason): PlaybackGrantFailure => ({
        reason,
        grantId,
    });
    if (!row.grant_kind || row.is_wildcard) return fail('invalid');
    if (
        (!row.is_active && !sessionRestarted) ||
        (row.device_session_id && isDeviceSessionTombstoned(row.device_session_id))
    )
        return fail('revoked');
    if (new Date(row.expires_at).getTime() <= now) return fail('expired');
    let boundSessionId = route.playbackSessionId;
    if (route.kind === 'audiobook' && route.audiobookSessionId && row.play_session_id) {
        const matches = await sql<{ id: string }[]>`SELECT id FROM play_sessions
            WHERE id = ${UUID.test(row.play_session_id) ? row.play_session_id : null} AND source_session_id = ${route.audiobookSessionId}
                AND user_id = ${row.user_id} AND media_id = ${row.media_item_id}
                AND status IN ('ACTIVE', 'PAUSED')`;
        if (!matches[0] || (boundSessionId && boundSessionId !== matches[0].id))
            return fail('wrong_scope');
        boundSessionId = matches[0].id;
    }
    if (
        (!row.play_session_id && route.playbackSessionId?.startsWith('preview-')) ||
        (row.grant_kind === 'live' &&
            (!row.play_session_id ||
                route.kind !== 'live' ||
                route.playbackSessionId !== row.play_session_id)) ||
        (grantKind(row) === 'preview'
            ? !(route.kind === 'preview' || (route.kind === 'video' && route.previewDelivery))
            : row.grant_kind !== route.kind) ||
        (route.mediaId && route.mediaId.toLowerCase() !== row.media_item_id?.toLowerCase()) ||
        (row.play_session_id && row.play_session_id !== boundSessionId) ||
        (!route.mediaId &&
            (!route.playbackSessionId || route.playbackSessionId !== row.play_session_id))
    )
        return fail('wrong_scope');
    // Recheck even a positively cached grant: preview keepalive state is separate.
    if (!(await previewBindingActive(row))) return fail('session_ended');
    // The Live TV session behind this URL is over (stopped, evicted, expired).
    if (route.sessionEnded) return fail('session_ended');
    if (
        config.STREAMING_SESSION_ENFORCE_IP !== false &&
        row.client_ip !== WILDCARD_IP &&
        row.client_ip !== clientIp
    )
        return fail('ip_mismatch');
    // Scope/IP/device checks above still apply to the expired grant. The
    // client must authenticate a fresh playback start; this grants no access.
    if (sessionRestarted) return fail('session_restarted');
    if (generation === cacheGeneration && !positiveCache.has(tokenHash)) {
        if (positiveCache.size >= 5000) positiveCache.delete(positiveCache.keys().next().value!);
        positiveCache.set(tokenHash, {
            row,
            until: Math.min(now + 5000, new Date(row.expires_at).getTime()),
        });
    }
    // Delivery is a keepalive for players that cannot PUT reports. The DB predicate
    // throttles writes across replicas; the local clock also avoids redundant UPDATEs.
    if (row.grant_kind === 'live' && row.play_session_id) {
        const sessionId = row.play_session_id;
        if (now - (liveHeartbeats.get(sessionId) ?? -Infinity) >= 10_000) {
            // Reserve before awaiting so parallel segment requests share the throttle.
            if (liveHeartbeats.size >= 5000)
                liveHeartbeats.delete(liveHeartbeats.keys().next().value!);
            liveHeartbeats.set(sessionId, now);
            try {
                const { getLiveTvSessionService } =
                    await import('./livetv/livetv-session.service.js');
                const service = getLiveTvSessionService();
                const session = await service.getPlaybackSession(sessionId);
                if (!session || session.state !== 'active') {
                    liveHeartbeats.delete(sessionId);
                    return fail('session_ended');
                }
                await service.refreshPlaybackSession(session);
            } catch (error) {
                liveHeartbeats.delete(sessionId);
                throw error;
            }
        }
    }
    if (now - (activityWrites.get(row.id) ?? 0) >= 15_000) {
        if (row.grant_kind === 'live') {
            await sql`UPDATE hls_playback_tokens SET last_used_at = NOW()
                WHERE id = ${row.id} AND last_used_at <= NOW() - INTERVAL '15 seconds'`;
        } else {
            await sql`
            WITH activity AS (
                UPDATE play_sessions SET last_heartbeat_at = NOW(), last_seen_at = NOW()
                WHERE id = ${row.play_session_id && UUID.test(row.play_session_id) ? row.play_session_id : null} AND status IN ('ACTIVE', 'PAUSED')
                    AND last_heartbeat_at <= NOW() - INTERVAL '15 seconds'
                RETURNING id
            )
            UPDATE hls_playback_tokens SET last_used_at = NOW()
            WHERE id = ${row.id} AND last_used_at <= NOW() - INTERVAL '15 seconds'
        `;
        }
        if (activityWrites.size >= 5000) activityWrites.delete(activityWrites.keys().next().value!);
        activityWrites.set(row.id, now);
    }
    if (generation !== cacheGeneration) return validatePlaybackGrant(secret, { clientIp, route });
    return {
        id: row.id,
        username: row.username,
        userId: row.user_id,
        deviceSessionId: row.device_session_id,
        playbackSessionId: row.play_session_id ?? null,
        mediaItemId: row.media_item_id,
        isWildcard: false,
        clientIp: row.client_ip,
        createdAt: new Date(row.created_at),
        lastUsedAt: new Date(row.last_used_at),
        expiresAt: new Date(row.expires_at),
        mintedByAdmin: row.minted_by_admin === true,
    };
}

export function buildGrantedHref(
    grant: Pick<MintedPlaybackGrant, 'token'> &
        Partial<Pick<MintedPlaybackGrant, 'playbackSessionId'>>,
    path: string,
    query?: URLSearchParams | Record<string, string | number | boolean | null | undefined>,
): string {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
        throw new Error('Granted href must use a base-relative path');
    }
    const url = new URL(path, 'https://playback.invalid');
    if (query) {
        const entries = query instanceof URLSearchParams ? query.entries() : Object.entries(query);
        for (const [key, value] of entries) {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        }
    }
    url.searchParams.delete('api_key');
    url.searchParams.delete('stream_token');
    url.searchParams.set('grant', grant.token);
    if (grant.playbackSessionId) url.searchParams.set('PlaySessionId', grant.playbackSessionId);
    return `${url.pathname}${url.search}${url.hash}`;
}

/** Revoke only Live TV credentials; video/music/audiobook playback is unaffected. */
export async function revokeLiveGrantsForUser(sql: Sql, username: string): Promise<void> {
    await sql`UPDATE hls_playback_tokens t SET is_active = false, ended_reason = 'admin_kill'
        FROM users u WHERE t.user_id = u.id AND u.username = ${username}
            AND t.grant_kind = 'live' AND t.is_active = true`;
    invalidatePlaybackGrantCache();
}
