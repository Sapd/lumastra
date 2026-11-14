// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { createHash } from 'node:crypto';
import type { UserId } from '$lib/shared/user-id';
import { ticksToMs } from './constants';
import {
    findActiveSession,
    createPlaySession,
    type ActivePlaySessionRow,
    type CreateSessionParams,
} from '$lib/server/database/queries/play-sessions.queries';
import {
    enforceStreamPolicy,
    isPolicyError,
    type PolicyError,
} from '$lib/server/services/play-sessions.service';
import { readBoundedJson, isPayloadTooLargeError } from '$lib/server/utils/bounded-body-reader';

/** Playback reports are small; 1 MiB leaves ample room. */
const MAX_PLAYBACK_BODY_BYTES = 1024 * 1024;
import { reportDeviceName } from '$lib/server/services/user-devices.service.js';
import { reportMusicSessionStart } from '$lib/server/services/play-session-lifecycle.service.js';

/** Reserved prefix for the per-user fallback id; clients may not claim it. */
const SYNTHETIC_PREFIX = 'jellyfin-compat-';

/**
 * The `play_sessions.device_id` a /j request is attributed to.
 *
 * MUST be used by every site that writes or reads that value. The stream-policy
 * ghost exclusion is `NOT (device_id = X AND media_id = Y)`, so if the manifest
 * route computes a different id than the one the session was stored with, a user
 * on a one-stream limit is counted against themselves and gets a 429 on their own
 * single stream. One helper, two call sites, no way to drift.
 *
 * Real Jellyfin clients send a stable `DeviceId`, so each app on each box becomes
 * its own device. The synthetic per-user fallback covers clients that send none
 * and PAT-authenticated requests, which have no session to read it from.
 *
 * The raw client id is stored deliberately, un-namespaced: `/j/Sessions` serializes
 * `device_id` straight back to clients, which they match against their own
 * DeviceId. Prefixing it would break that. The one exception is a client that
 * claims the reserved fallback prefix — see below. Collisions are otherwise only
 * possible within one user's own rows, because uniqueness is `(user_id, device_id)`.
 */
export function jellyfinCompatDeviceId(
    deviceId: string | null | undefined,
    userId: string,
): string {
    const claimed = deviceId?.trim();
    if (!claimed) return `${SYNTHETIC_PREFIX}${userId}`;

    // A client must not be able to claim the reserved fallback id. The
    // stream-policy ghost exclusion matches on device_id, so a client that
    // reported `jellyfin-compat-<its own userId>` would share an exclusion key
    // with its other streams and could run two concurrent streams inside a
    // one-stream limit. Namespace an impostor rather than rejecting it, so a
    // client picking the string by accident still gets a stable identity.
    if (claimed.startsWith(SYNTHETIC_PREFIX)) return `client:${claimed}`;

    return claimed;
}

/**
 * Upper bound on a client-supplied `DeviceId` at session mint.
 *
 * `DeviceId` is deliberately exempt from the display-name sanitiser (it is an
 * identity key, not text, and must round-trip byte-for-byte) — but that also
 * exempts it from the sanitiser's length cap. Since it becomes a permanent,
 * indexed key in `user_devices (user_id, device_id)` and in every
 * `play_sessions` row, it needs its own bound. Real Jellyfin device ids are
 * well under 64 chars.
 *
 * Cardinality is not capped: a client could still mint a fresh id per login. That
 * is bounded by the auth rate limit and is self-scoped (uniqueness is per user),
 * so it is accepted rather than guarded.
 */
export const MAX_JELLYFIN_DEVICE_ID_LENGTH = 128;

/**
 * Clamp a client-supplied DeviceId at the session-mint boundary.
 *
 * A bare truncation would merge two devices whose ids share a long prefix into
 * one, silently — so an over-long id keeps a short digest of the full value,
 * making the clamped form injective in practice.
 */
export function clampJellyfinDeviceId(raw: string | null | undefined): string {
    const value = raw ?? '';
    if (value.length <= MAX_JELLYFIN_DEVICE_ID_LENGTH) return value;

    const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
    return `${value.slice(0, MAX_JELLYFIN_DEVICE_ID_LENGTH - digest.length - 1)}~${digest}`;
}

export async function parsePlaybackBody(request: Request): Promise<{
    itemId: string | undefined;
    positionMs: number;
    playSessionId: string | undefined;
    mediaSourceId: string | undefined;
    isPaused: boolean;
}> {
    let body: Record<string, unknown> = {};
    try {
        // An over-cap body is a 413 for the caller, not an empty report. An empty
        // or malformed body (SyntaxError) falls through to the empty default.
        body = ((await readBoundedJson(request, MAX_PLAYBACK_BODY_BYTES)) ?? {}) as Record<
            string,
            unknown
        >;
    } catch (err) {
        if (isPayloadTooLargeError(err)) throw err;
        // Empty or malformed body
    }

    const itemId = (body.ItemId ?? body.itemId) as string | undefined;
    const positionTicks =
        typeof body.PositionTicks === 'number'
            ? body.PositionTicks
            : typeof body.positionTicks === 'number'
              ? body.positionTicks
              : 0;
    const playSessionId = (body.PlaySessionId ?? body.playSessionId) as string | undefined;
    const mediaSourceId = (body.MediaSourceId ?? body.mediaSourceId) as string | undefined;
    const isPaused = Boolean(body.IsPaused ?? body.isPaused ?? false);

    return {
        itemId,
        positionMs: ticksToMs(positionTicks),
        playSessionId,
        mediaSourceId,
        isPaused,
    };
}

/** A query value under any of Jellyfin's spellings (`PositionTicks`, `positionTicks`, `positionticks`). */
function queryValue(url: URL, name: string): string | undefined {
    const wanted = name.toLowerCase();
    for (const [key, value] of url.searchParams) {
        if (key.toLowerCase() === wanted && value.trim() !== '') return value.trim();
    }
    return undefined;
}

/**
 * A playback report for the legacy `PlayingItems` routes
 * (`POST|DELETE /PlayingItems/{itemId}`, `…/Progress`, and their
 * `/Users/{userId}/…` twins).
 *
 * Jellyfin's PlaystateController binds every value of these routes from the
 * QUERY (`?positionTicks=…&isPaused=…&playSessionId=…`); they carry no body.
 * Reading the body only recorded position 0 on every stop and never saw a
 * pause. The query wins field by field; a JSON body (what older Lumastra
 * clients and tests send) still fills whatever the query leaves out.
 */
export async function parsePlaybackReport(
    url: URL,
    request: Request,
): Promise<{
    positionMs: number;
    playSessionId: string | undefined;
    mediaSourceId: string | undefined;
    isPaused: boolean;
}> {
    const body = await parsePlaybackBody(request);
    const ticksRaw = queryValue(url, 'PositionTicks');
    const ticks = ticksRaw !== undefined && /^\d+$/.test(ticksRaw) ? Number(ticksRaw) : undefined;
    const pausedRaw = queryValue(url, 'IsPaused')?.toLowerCase();
    return {
        positionMs: ticks !== undefined ? ticksToMs(ticks) : body.positionMs,
        playSessionId: queryValue(url, 'PlaySessionId') ?? body.playSessionId,
        mediaSourceId: queryValue(url, 'MediaSourceId') ?? body.mediaSourceId,
        isPaused: pausedRaw === 'true' ? true : pausedRaw === 'false' ? false : body.isPaused,
    };
}

/**
 * Atomically find or create a play session for a Jellyfin compat request.
 * Wraps the check+create in a transaction to prevent duplicate sessions
 * from concurrent requests (e.g., Symfonium sending PlaybackStarted and
 * Progress nearly simultaneously on app launch).
 *
 * Enforces stream policy (concurrent limits, IP restriction, play_method)
 * on session creation. Returns PolicyError if the policy blocks the session.
 *
 * Reports carrying PlaySessionId identify one client playback, including across
 * track switches. Reports without one retain the legacy (user, item) lookup.
 */
export async function findOrCreateJellyfinSession(
    sql: postgres.Sql,
    params: {
        userId: UserId;
        /**
         * Security fix P5 (2026-09-16): the login handle, used as the
         * `user_stream_policies` lookup key (an intentional TEXT exception,
         * mig 16.46.0 — that table is keyed on username, not the UUID).
         * Every `/j` call site already resolves this alongside `userId`
         * under the same auth guard; there was never a genuine case where
         * only the UUID was available — a prior comment here claiming
         * otherwise was stale and has been removed.
         */
        username: string;
        itemId: string;
        positionMs: number;
        playSessionId?: string;
        ipAddress: string;
        /** From `locals.jfDevice` — absent on PAT-auth requests. */
        device?: { deviceId: string | null; deviceName: string | null; clientName: string | null };
    },
): Promise<ActivePlaySessionRow | PolicyError> {
    // Check outside transaction first — fast path for existing sessions
    const existing = await findActiveSession(sql, {
        userId: params.userId,
        itemId: params.itemId,
        playSessionId: params.playSessionId,
    });
    if (existing) return existing;

    // Set only on the branch that actually INSERTS — a reused session must not
    // count a second play. Read after the transaction commits.
    let createdMediaType: string | null = null;

    // No active session found — create one atomically.
    // No /j concurrent-stream cap here or anywhere: Lumastra has no paid tier.
    const result = await sql.begin(async (rawTxSql) => {
        const txSql = rawTxSql as unknown as postgres.Sql;

        // Serialize concurrent create attempts for this user so the recheck below
        // actually prevents the race. A plain SELECT recheck under READ COMMITTED
        // does NOT — two concurrent progress/start reports for the same (user,item)
        // would both find nothing and both insert a duplicate ACTIVE session.
        // Transaction-scoped advisory lock keyed on the user (same key as
        // enforceStreamPolicy, so they never deadlock); released at commit/rollback.
        await txSql`SELECT pg_advisory_xact_lock(hashtextextended(${params.userId}::text, 0))`;

        // Re-check under transaction (now serialized) to prevent race
        const rechecked = await findActiveSession(txSql, {
            userId: params.userId,
            itemId: params.itemId,
            playSessionId: params.playSessionId,
        });
        if (rechecked) return rechecked;

        // Enforce stream policy before creating. policyKey is the USERNAME
        // (security fix P5) so an admin-set per-user user_stream_policies
        // row actually applies on this path — see the params doc above.
        const policyError = await enforceStreamPolicy(
            txSql,
            params.userId,
            params.username,
            params.ipAddress,
            'direct',
        );
        if (policyError) return policyError;

        // Coalesce media_items.runtime_seconds with the longest media_files.duration_seconds
        // for this media_item — see play-sessions.service.ts for the rationale.
        const [mediaRow] = await txSql<{ runtime_ms: string | null; media_type: string }[]>`
            SELECT mi.media_type, COALESCE(
                mi.runtime_seconds * 1000,
                (
                    SELECT ROUND(mf.duration_seconds * 1000)::bigint
                    FROM media_files mf
                    JOIN media_file_items mfi ON mfi.file_id = mf.id
                    WHERE mfi.media_item_id = mi.id
                      AND mf.duration_seconds IS NOT NULL
                      AND mf.duration_seconds > 0
                    ORDER BY mf.duration_seconds DESC
                    LIMIT 1
                )
            )::bigint AS runtime_ms
            FROM media_items mi
            WHERE mi.id = ${params.itemId}::uuid
        `;
        const runtimeMs = mediaRow?.runtime_ms ? Number(mediaRow.runtime_ms) : undefined;
        createdMediaType = mediaRow?.media_type ?? null;

        const createParams: CreateSessionParams = {
            // Literal, not derived: /j authenticates its own way and has no
            // Principal in scope. Every session created here IS the compat
            // surface by construction.
            surface: 'jellyfin_compat',
            jellyfin_play_session_id: params.playSessionId,
            media_id: params.itemId,
            user_id: params.userId,
            // Real per-client identity when the client sent one; see
            // jellyfinCompatDeviceId() for why this must never be computed inline.
            device_id: jellyfinCompatDeviceId(params.device?.deviceId, params.userId),
            client_name: params.device?.clientName || 'Jellyfin Client',
            ip_address: params.ipAddress,
            play_method: 'direct',
            position_ms: params.positionMs,
            runtime_ms: runtimeMs,
        };
        const created = await createPlaySession(txSql, createParams);

        // Register the device. This surface calls the query module directly rather
        // than going through startPlaySession(), so it does not inherit the device
        // registration that lives there — without this, /j clients never get a
        // user_devices row and every one of them shows as "Unknown" in the admin
        // playback-health view. Shares the transaction so the session and its device
        // land together.
        //
        // Jellyfin clients send a stable DeviceId and device name, so each app on
        // each box is its own device with its own label, the same way Jellyfin's own
        // Devices dashboard behaves. Clients that send no DeviceId (and PAT-auth
        // requests, which carry no session) fall back to one synthetic row per user.
        await reportDeviceName(txSql, {
            userId: params.userId,
            deviceId: createParams.device_id,
            name: params.device?.deviceName ?? null,
            clientId: createParams.client_name,
            source: 'play-session',
        });
        return {
            id: created.id,
            media_id: created.media_id,
            user_id: created.user_id,
            play_method: created.play_method,
            status: created.status,
            position_ms: created.position_ms,
            bitrate_kbps: created.bitrate_kbps,
            video_codec: created.video_codec,
            audio_codec: created.audio_codec,
            resolution: created.resolution,
        };
    });

    // A music session counts its play at START — see `reportMusicSessionStart`.
    // /j clients never call /music/progress/start, so without this a track
    // played from Streamyfin/Finamp/Moonfin moved total_listen_ms and
    // complete_count at stop while play_count and last_played_at stayed frozen.
    if (!isPolicyError(result)) {
        await reportMusicSessionStart({
            userId: params.userId,
            mediaId: params.itemId,
            mediaType: createdMediaType,
            playbackSessionId: result.id,
        });
    }

    return result;
}

export { isPolicyError, type PolicyError };
