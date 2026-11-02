// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PlaybackStartRequest, PlaybackStartResponse } from '$lib/schemas/playback-start.js';
import { resolvePlaybackCapabilities } from '$lib/schemas/playback-capabilities.js';
export { playbackCapabilitiesToProfile } from '../utils/info.utils.js';
import type { LumastraInfoResponse } from '$lib/schemas/api-playback-responses.js';
import type {
    MintedPlaybackGrant,
    buildGrantedHref as BuildGrantedHref,
} from './playback-grant.js';
import type { PlaybackDeliveryPaths } from './info.service.js';
import { revokeGrantsForPlaySession } from './playback-grant.js';
import { resolveTracks, DEFAULT_LANGUAGE_PREFERENCES } from '$lib/shared/track-selection.js';

// src/lib/server/services/play-sessions.service.ts
import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import { UUID_RE_LOOSE } from '$lib/utils/id-patterns.js';
import { apiUrl, audiobookDeliveryUrl, type ApiSurface } from '$lib/shared/api-urls';
import type { PlaySurface } from '$lib/server/api/play-surface.js';
import {
    createPlaySession,
    getActiveSessionsForUser,
    stopSession,
    getEffectivePolicy as getEffectivePolicyQuery,
    upsertStreamPolicy,
    deleteStreamPolicy,
    claimStaleSessions,
    claimStaleSessionsForUser,
    getPendingStaleSessions,
    getRetryableAudiobookSessionCloses,
    markStaleSessionProcessed,
    recordStaleSessionAttempt,
    claimBootOrphanSessions,
    unmeteredSources,
    type CreateSessionParams,
    type SessionRow,
    type PolicyRow,
    musicPrefetchUsable,
    expireMusicPrefetchRowsForParent,
} from '../database/queries/play-sessions.queries.js';
import { getUsernamesByIds } from '../database/queries/users.queries.js';
import { Logger } from '../utils/logger.js';
import type { StartSessionRequest, PlayMethod } from '../../schemas/play-sessions.js';
import { isUnlimitedStreams } from '../../schemas/play-sessions.js';
import { stopSessionTranscode } from './play-session-transcode-cleanup.js';
import { killSessionUnified, cancelMusicStreamForSession } from './session-kill.service.js';
import { playbackPlanner } from './playback-planner.service.js';
import { getSessionSourceInfo } from '../database/queries/media-files.queries.js';
import type { PlaySessionEntryMode } from '../database/queries/play-sessions.queries.js';
import { notifySessionKilled, notifySessionTerminated } from './play-session-events.service.js';
import { playbackTelemetryService } from './playback-telemetry.service.js';
import {
    getPlaySessionLifecycleService,
    isMusicSessionMediaType,
} from './play-session-lifecycle.service.js';
import { playedThresholdFor } from '$lib/server/utils/watch-constants.js';
import type { AudioNegotiation } from './music-transcode/negotiation.js';
import type { PlaybackPlan, TranscodeReason } from '$lib/schemas/playback-plan.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { config } from '$lib/server/config.js';
import { reportDeviceName } from './user-devices.service.js';
import type { AudiobookSessionDeps } from './audiobook-session.service.js';
import { authorizePlaybackViaPlugins } from '$lib/server/plugins/runtime/playback-authorization.js';

const logger = Logger.for('PlaySessions');

/**
 * Map the internal play-method enum to the telemetry `play_method` vocabulary.
 *   'direct'                       → 'DirectPlay'  (no transcode, no remux)
 *   'remux'                        → 'DirectStream' (container/audio remux, codecs copied)
 *   'audio_transcode'/'full_transcode'/'audio_only' → 'Transcode'
 */
function telemetryPlayMethod(method: PlayMethod): 'DirectPlay' | 'DirectStream' | 'Transcode' {
    switch (method) {
        case 'direct':
            return 'DirectPlay';
        case 'remux':
            return 'DirectStream';
        default:
            return 'Transcode';
    }
}

/**
 * Emit the per-session server telemetry at session start (fire-and-forget).
 *
 * One `transcoding_info` event carries the play-method/codec/dimension
 * metadata consumed by `computeSessionQuality`, plus a `media_bitrate` event
 * (bits/sec) used for the bandwidth-ratio diagnosis. Both are best-effort:
 * any failure is swallowed so telemetry never affects the playback response.
 */
function emitSessionStartTelemetry(args: {
    playSessionId: string;
    userId: UserId;
    deviceId: string;
    plan: PlaybackPlan | null;
    params: CreateSessionParams;
    isLive: boolean;
}): void {
    const { playSessionId, userId, deviceId, plan, params } = args;
    try {
        const method = params.play_method;
        const playMethod = telemetryPlayMethod(method);
        const isTranscoding = method !== 'direct';
        const isVideoTranscoding = method === 'full_transcode';
        const isAudioTranscoding = method === 'audio_transcode' || method === 'full_transcode';

        // Parse "WIDTHxHEIGHT" resolution (when available) into numeric dims.
        let sourceWidth: number | undefined;
        let sourceHeight: number | undefined;
        if (params.resolution) {
            const m = /^(\d+)x(\d+)$/.exec(params.resolution);
            if (m) {
                sourceWidth = Number.parseInt(m[1], 10);
                sourceHeight = Number.parseInt(m[2], 10);
            }
        }

        // NOTE: user_agent / is_mobile are part of the telemetry metadata shape
        // but are not present on the session-start request (ClientCapabilities
        // carries no UA / device-class fields), so they are intentionally
        // omitted here — they arrive later via the client beacon's clientType.
        const metadata: Record<string, unknown> = {
            play_method: playMethod,
            is_transcoding: isTranscoding,
            is_video_transcoding: isVideoTranscoding,
            is_audio_transcoding: isAudioTranscoding,
            source_video_codec: plan?.source_video_codec ?? params.video_codec,
            output_video_codec: plan?.target_video_codec ?? params.video_codec,
            source_audio_codec: plan?.source_audio_codec ?? params.audio_codec,
            output_audio_codec: plan?.target_audio_codec ?? params.audio_codec,
            source_width: sourceWidth,
            source_height: sourceHeight,
            source_bitrate_bps:
                params.bitrate_kbps != null ? params.bitrate_kbps * 1000 : undefined,
            transcode_reasons: plan?.transcode_reasons,
            // Language-agnostic structured reasons — the analytics "Why
            // Transcoding Happens" panel aggregates on these codes so rows
            // dedupe across locales and bucket into remux/audio/video.
            transcode_reason_codes: plan?.transcode_reason_codes,
            source_container: params.container,
            is_live: args.isLive,
        };

        const options = { userId, deviceId, metadata };

        // transcoding_info: value=1, payload in metadata (matches downstream reader).
        void playbackTelemetryService
            .record(playSessionId, 'server', 'transcoding_info', 1, options)
            .catch(() => {
                /* best-effort telemetry — never affects playback */
            });

        // media_bitrate: required bitrate for the content in bits/sec.
        // Guard: only emit when the value is a finite positive number so that
        // null/NaN/negative inputs never produce garbage rows that corrupt
        // bandwidth-ratio health math.
        const bitrateKbps = params.bitrate_kbps;
        if (bitrateKbps != null && Number.isFinite(bitrateKbps) && bitrateKbps > 0) {
            void playbackTelemetryService
                .record(playSessionId, 'server', 'media_bitrate', bitrateKbps * 1000, {
                    userId,
                    deviceId,
                })
                .catch(() => {
                    /* best-effort telemetry — never affects playback */
                });
        }
    } catch {
        /* best-effort telemetry — never affects playback */
    }
}

// ─── Policy enforcement errors ────────────────────────────────────────────────

export type PolicyError =
    | { kind: 'prefetch_requires_current_session' }
    | { kind: 'stream_limit_exceeded'; active: number; limit: number }
    /** Too many prepared audiobook downloads at once (not a stream limit). */
    | { kind: 'download_limit_exceeded'; active: number; limit: number }
    | {
          kind: 'transcode_not_allowed';
          allowed_methods: string[];
          suggestion: string;
      }
    | {
          kind: 'ip_restriction';
          allowed_ip: string;
          grace_remaining_seconds: number;
      }
    | {
          kind: 'source_incompatible';
          requested: string;
          reason: string;
          suggestion: string;
      }
    | {
          kind: 'plugin_denied';
          /** The integration that refused. */
          plugin: string;
          /** Its own explanation, shown to the user. */
          reason: string;
      };

export function isPolicyError(x: unknown): x is PolicyError {
    return (
        typeof x === 'object' &&
        x !== null &&
        'kind' in x &&
        [
            'stream_limit_exceeded',
            'download_limit_exceeded',
            'transcode_not_allowed',
            'ip_restriction',
            'source_incompatible',
            'plugin_denied',
            'prefetch_requires_current_session',
        ].includes(String(x.kind))
    );
}

// ─── Effective policy (config-aware) ─────────────────────────────────────────

/**
 * Effective stream policy lookup. Wraps the pure query-module function,
 * injecting the admin-configurable `DEFAULT_MAX_CONCURRENT_STREAMS` into the
 * synthetic fallback used when neither a per-user nor a `__default__` row
 * exists in `user_stream_policies`. A per-user row or the `__default__` row
 * always wins over this fallback.
 */
export async function getEffectivePolicy(sql: postgres.Sql, policyKey: string): Promise<PolicyRow> {
    return getEffectivePolicyQuery(sql, policyKey, {
        max_concurrent_streams: config.DEFAULT_MAX_CONCURRENT_STREAMS,
    });
}

// ─── Policy enforcement (reusable) ───────────────────────────────────────────

/**
 * The `allowed_play_methods` rule on its own. `null` = every method allowed.
 * Shared by `enforceStreamPolicy` (the method the client claims at session
 * start) and the HLS manifest gate (the method the server actually runs).
 */
export function checkPlayMethodAllowed(
    policy: Pick<PolicyRow, 'allowed_play_methods'>,
    play_method: string,
): Extract<PolicyError, { kind: 'transcode_not_allowed' }> | null {
    if (policy.allowed_play_methods === null) return null;
    if (policy.allowed_play_methods.includes(play_method)) return null;
    return {
        kind: 'transcode_not_allowed',
        allowed_methods: policy.allowed_play_methods,
        suggestion: policy.allowed_play_methods[0] ?? 'direct',
    };
}

/**
 * Enforce stream policy checks within an existing transaction.
 * Must be called inside a sql.begin() block so SELECT FOR UPDATE works.
 *
 * @param txSql - Transaction-scoped SQL handle (cast to postgres.Sql)
 * @param userId - The stable users.id UUID (uuid FK on play_sessions.user_id)
 * @param policyKey - The TEXT key for user_stream_policies lookup (username).
 *   user_stream_policies.user_id is an intentional TEXT exception (mig 16.46.0).
 *   Every caller must pass the actual username here — security fix P5
 *   (2026-09-16) traced the one caller that claimed "no username available"
 *   (Jellyfin-compat's findOrCreateJellyfinSession) and found the claim was
 *   false: the username was already resolved and in scope at every one of
 *   its own callers, just never threaded through. Passing the UUID instead
 *   makes the lookup silently miss and fall back to the __default__ policy,
 *   which is exactly the bug P5 fixed — do not reintroduce it here.
 * @param ip_address - Client IP address
 * @param play_method - Requested play method ('direct', 'remux', 'audio_transcode', 'full_transcode'),
 *   or null to skip the play-method check (the caller enforces it separately)
 * @returns null if all checks pass, or a PolicyError describing the violation
 */
export async function enforceStreamPolicy(
    txSql: postgres.Sql,
    userId: UserId,
    policyKey: string,
    ip_address: string,
    play_method: string | null,
    options?: {
        session_id?: string;
        device_id?: string;
        media_id?: string;
        prefetch?: boolean;
        /**
         * The session being admitted is an offline download, not a stream: it needs no
         * stream slot, so the concurrent-stream count is skipped (the play-method and
         * IP rules still apply, and so does the stale reap above).
         */
        download?: boolean;
    },
): Promise<PolicyError | null> {
    // Use the same lock order for allocation, promotion and admission: user, then rows.
    await txSql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`;
    const policy = await getEffectivePolicy(txSql, policyKey);

    // Check play_method allowed (null = the caller checks it itself — see the
    // HLS manifest gate, which knows the real method only after the decision).
    if (play_method !== null) {
        const methodError = checkPlayMethodAllowed(policy, play_method);
        if (methodError) return methodError;
    }

    // Reap stale sessions before counting — prevents zombie sessions from
    // blocking new streams when the 1-minute cleanup tick has not run yet.
    //
    // This MUST use the same predicate as the unified reaper, so it calls the
    // shared claim rather than restating it. The previous hand-copied UPDATE
    // drifted: it still measured the PAUSED grace from `last_heartbeat_at`
    // after `staleSessionCondition` moved to `paused_at`, which is exactly how
    // a tab paused overnight (heartbeating, so never stale by that measure)
    // kept blocking its owner's streams. It also skipped `reapClaimPayload`,
    // leaving upstream AudiobookShelf sessions it crashed unfindable.
    const staleSessions = await claimStaleSessionsForUser(txSql, userId);
    for (const stale of staleSessions) {
        await revokeGrantsForPlaySession(stale.id, txSql, 'reaped');
    }

    // Kill-switch: STREAM_LIMITS_ENFORCED=false skips only the concurrent-count
    // check below (for debugging). play_method and IP-restriction checks above/
    // below still apply, and the stale-session reap above still runs — other
    // logic (e.g. the F5 reaper alignment noted above) relies on it as a
    // hygiene side effect regardless of enforcement being on or off.
    // Unlimited sentinel: skip the count entirely. Falling through would
    // evaluate `activeCount >= -1`, which is true even at zero sessions and
    // would block every stream — the exact inverse of the intent.
    // 0 deliberately still falls through: 0 means "block all streams".
    // Resolved ONCE for this enforcement pass so the concurrent-count check and
    // the IP check below can never disagree about what counts as a stream.
    const unmetered = unmeteredSources(config.TRUST_CLIENT_LOCAL_PLAYBACK);

    const unlimited = isUnlimitedStreams(policy.max_concurrent_streams);
    if (config.STREAM_LIMITS_ENFORCED && !unlimited && !options?.prefetch && !options?.download) {
        // Count active sessions with row locking to prevent races.
        //
        // Exclusion is cumulative, not either/or:
        //   - session_id excludes the reporter's own stub — it is merging into
        //     an existing transcode-created row, not opening a new stream.
        //   - device_id+media_id additionally excludes the about-to-be-superseded
        //     ghost from a player quality-restart: the client generates a NEW
        //     playSessionId while the old row for the same (device_id, media_id)
        //     is still ACTIVE — it is only superseded AFTER enforcement runs (see
        //     the supersede UPDATE in startPlaySession below). Applying only one
        //     exclusion (the previous either/or behavior) let that still-ACTIVE
        //     ghost count against the limit and falsely block a user who was
        //     already at capacity.
        // UUID-guard because the exclusion compares against a uuid column (a
        // non-UUID would raise 22P02). `session_id` is client-supplied
        // PlaySessionId (validated only by charset at the seam in
        // startHlsPlayback, which also accepts non-UUID preview- ids) reaching
        // every caller of this shared enforcement function — not just the one
        // that happened to also UUID-guard `media_id` below — so the guard
        // belongs here rather than being repeated at each call site.
        // UUID_RE_LOOSE (not UUID_RE) because a legitimate session id can be
        // dashless (e.g. the /j master.m3u8 fallback default) or uppercase.
        //
        // The fix-plan brief that asked for this guard was internally
        // contradictory: it said both "a non-UUID is a deliberate rejection,
        // not a 22P02" AND "follow the media_id shape" — but the media_id
        // shape (see playback.service.ts) drops an invalid value to
        // `undefined` rather than rejecting the whole call. Dropping to
        // `undefined` here (reviewed and confirmed 2026-09-16, fix round 1)
        // is the safe reading of the two: omitting the exclusion just makes
        // this session count against its own concurrency limit, which fails
        // CLOSED (stricter, not looser), and it avoids reintroducing a real
        // 500 on a legitimate first-use `preview-<uuid>` id that isn't a
        // dashed UUID. Do not change this to a hard rejection of the whole
        // enforceStreamPolicy call.
        const excludeSessionId =
            options?.session_id && UUID_RE_LOOSE.test(options.session_id)
                ? options.session_id
                : undefined;
        const excludeDeviceId = options?.device_id;
        const excludeMediaId = options?.media_id;

        const activeSessions = await txSql<{ count: string }[]>`
            WITH locked AS (
                SELECT id
                FROM play_sessions
                WHERE user_id = ${userId}
                  AND status IN ('ACTIVE', 'PAUSED')
                  -- A hover preview is not a stream: hovering must not use up
                  -- (or trip) the viewer's concurrent-stream limit.
                  AND NOT is_preview AND purpose = 'play'
                  -- Unmetered sources never consume a stream slot: a native
                  -- Jellyfin / Subsonic row mirrors playback on another server
                  -- we can neither enforce nor kill, and a 'local' row is a
                  -- file playing off the client's own disk. See
                  -- unmeteredSources() — 'local' is included only when the
                  -- operator trusts that (unverifiable) client claim.
                  AND COALESCE(source, 'lumastra') <> ALL(${unmetered}::text[])
                  ${excludeSessionId ? txSql`AND id != ${excludeSessionId}` : txSql``}
                  ${
                      excludeDeviceId && excludeMediaId
                          ? txSql`AND NOT (device_id = ${excludeDeviceId} AND media_id = ${excludeMediaId})`
                          : txSql``
                  }
                FOR UPDATE
            )
            SELECT COUNT(*)::text as count FROM locked
        `;
        const activeCount = parseInt(activeSessions[0]?.count ?? '0', 10);
        if (activeCount >= policy.max_concurrent_streams) {
            return {
                kind: 'stream_limit_exceeded',
                active: activeCount,
                limit: policy.max_concurrent_streams,
            };
        }
    }

    // Check IP restriction
    if (policy.require_single_ip) {
        const ipCheck = await txSql<{ ip_address: string; last_heartbeat_at: Date }[]>`
            SELECT ip_address, last_heartbeat_at
            FROM play_sessions
            WHERE user_id = ${userId}
              AND status IN ('ACTIVE', 'PAUSED')
              AND NOT is_preview AND purpose = 'play'
              -- Same exclusion as the concurrent-count check, and for the same
              -- reason: a native Jellyfin / Subsonic mirror carries the upstream
              -- server's IP, and a trusted 'local' row is someone playing off
              -- their own disk elsewhere. Neither is a second stream, so neither
              -- may trip the single-IP guard.
              AND COALESCE(source, 'lumastra') <> ALL(${unmetered}::text[])
              AND ip_address != ${ip_address}
            ORDER BY last_heartbeat_at DESC
            LIMIT 1
        `;
        if (ipCheck.length > 0) {
            const otherSession = ipCheck[0];
            const ageMs = Date.now() - otherSession.last_heartbeat_at.getTime();
            const graceMs = policy.ip_grace_period_seconds * 1000;
            if (ageMs < graceMs) {
                return {
                    kind: 'ip_restriction',
                    allowed_ip: otherSession.ip_address,
                    grace_remaining_seconds: Math.ceil((graceMs - ageMs) / 1000),
                };
            }
        }
    }

    return null;
}

// ─── Session start ─────────────────────────────────────────────────────────────

export async function createPlaybackSessionRow(
    sql: postgres.Sql,
    // The stable users.id UUID — written to play_sessions.user_id (FK, mig 16.46.0).
    userId: UserId,
    // Login handle for the TEXT-keyed stream policy (distinct from users.id).
    username: string,
    ip_address: string,
    body: StartSessionRequest,
    // Which API surface this request arrived through, already derived from the
    // caller's Principal. Passed in rather than derived here because this
    // service has no `event` — and deliberately NOT read from the body: a
    // client-settable surface would let any caller relabel its own traffic.
    surface: PlaySurface = 'unknown',
    start?: {
        positionMs?: number;
        capabilities?: unknown;
        isPreview?: boolean;
        purpose?: 'play' | 'prefetch';
        /** How the client opened the playback; only a linear entry joins a resume-handoff chain. */
        entry?: PlaySessionEntryMode;
    },
): Promise<{ session_id: string; container?: string } | PolicyError> {
    // Plugin veto, BEFORE the transaction. The host's own checks below hold
    // `SELECT … FOR UPDATE` while they count active sessions, so third-party
    // code must never run inside them — one slow gate would stall every other
    // viewer's session start. Fails open; see playback-authorization.ts.
    const verdict = await authorizePlaybackViaPlugins({
        userId: String(userId),
        username,
        mediaId: body.media_id,
        playMethod: body.requested.play_method,
        deviceId: body.device_id,
        ipAddress: ip_address,
    });
    if (!verdict.allow) {
        return {
            kind: 'plugin_denied',
            plugin: verdict.deniedBy ?? 'unknown',
            reason: verdict.reason ?? 'playback refused by a plugin',
        };
    }

    // Atomic: enforce limits and create session inside a transaction.
    //      SELECT FOR UPDATE only locks rows inside a transaction.
    //      TransactionSql omits some Sql methods but is runtime-compatible;
    //      cast once so typed query helpers can accept it.
    const txResult = await withTx(sql, async (txSql) => {
        const db = txSql as unknown as postgres.Sql;

        let prefetched: { id: string } | undefined;
        if (start?.purpose === 'play') {
            await db`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`;
            // A real start on this device adopts its prepared row and delivery resources.
            const rows = await db<{ id: string }[]>`
                SELECT ps.id FROM play_sessions ps
                WHERE user_id = ${userId} AND device_id = ${body.device_id}
                  AND ${musicPrefetchUsable(db)}
                  AND media_id = ${body.media_id}::uuid AND purpose = 'prefetch'
                  AND status IN ('ACTIVE', 'PAUSED')
                  AND started_at > now() - INTERVAL '10 minutes'
                ORDER BY started_at DESC LIMIT 1 FOR UPDATE`;
            prefetched = rows[0];
            if (prefetched) body = { ...body, session_id: prefetched.id };
        }

        // Enforce stream policy (concurrent limits, IP restriction, play_method).
        // userId (UUID) → play_sessions FK; username → user_stream_policies TEXT key.
        const policyError = await enforceStreamPolicy(
            db,
            userId,
            username,
            ip_address,
            body.requested.play_method,
            {
                session_id: body.session_id,
                device_id: body.device_id,
                media_id: body.media_id,
                prefetch: start?.purpose === 'prefetch',
            },
        );
        if (policyError) return policyError;

        let parentId: string | undefined;
        if (start?.purpose === 'prefetch') {
            const [parent] = await db<{ id: string }[]>`
                SELECT id FROM play_sessions
                WHERE user_id = ${userId} AND device_id = ${body.device_id}
                  AND purpose = 'play' AND NOT is_preview AND source = 'lumastra'
                  AND status IN ('ACTIVE', 'PAUSED')
                ORDER BY started_at DESC LIMIT 1 FOR UPDATE`;
            if (!parent) return { kind: 'prefetch_requires_current_session' } as const;
            parentId = parent.id;
        }

        // Create session.
        //
        // The session's runtime is the API's one duration source (probe-first, ms):
        // the same value GET /media/{id} shows as durationMs.
        const mediaRow = await db<{ media_type: string }[]>`
            SELECT mi.media_type FROM media_items mi WHERE mi.id = ${body.media_id}::uuid
        `;
        const { findPlaybackDurationMs } =
            await import('../database/queries/media-items.queries.js');
        const mediaType = mediaRow[0]?.media_type ?? null;
        const runtimeMs =
            mediaType === 'radio' ? 0 : ((await findPlaybackDurationMs(db, body.media_id)) ?? 0);

        // Resolve PlaybackPlan if plan_id is provided
        let plan = body.plan_id ? await playbackPlanner.getPlan(body.plan_id) : null;
        if (body.plan_id && !plan) {
            logger.warn('Plan referenced by session start not found or expired', {
                planId: body.plan_id,
                userId,
                mediaId: body.media_id,
            });
        }

        // Validate file_id belongs to media_id (prevents impossible tuples).
        let validatedFileId = body.file_id;
        if (body.file_id) {
            const ownership = await db<{ exists: boolean }[]>`
                SELECT EXISTS(
                    SELECT 1 FROM media_file_items
                    WHERE file_id = ${body.file_id}::uuid
                      AND media_item_id = ${body.media_id}::uuid
                ) AS exists
            `;
            if (!ownership[0]?.exists) {
                logger.warn('file_id does not belong to media_id — dropping file_id', {
                    fileId: body.file_id,
                    mediaId: body.media_id,
                    userId,
                });
                validatedFileId = undefined;
            }
        }

        // Validate plan belongs to the requested file (defense-in-depth).
        // On mismatch, drop the plan AND clear the caller-supplied plan_id so
        // the session row never stores an impossible (file_id, plan_id) tuple.
        // Also drop the plan when file_id was provided but rejected by the
        // ownership check — plan.file_id was chosen for that file, so it is
        // no longer trustworthy when the file is gone.
        let persistedPlanId = body.plan_id;
        if (plan && validatedFileId && plan.file_id !== validatedFileId) {
            logger.warn('Plan/file mismatch — ignoring stale plan', {
                planId: plan.plan_id,
                planFileId: plan.file_id,
                requestFileId: validatedFileId,
            });
            plan = null;
            persistedPlanId = undefined;
        } else if (plan && body.file_id && !validatedFileId) {
            logger.warn('Plan dropped — paired file_id failed ownership check', {
                planId: plan.plan_id,
                planFileId: plan.file_id,
                rejectedFileId: body.file_id,
            });
            plan = null;
            persistedPlanId = undefined;
        }

        // Pull authoritative source technicals from the DB — clients send these
        // fields as undefined, so we derive them from media_files + media_streams
        // for the validated file. Falls back to the plan's source codecs, then
        // to the client-requested values for pre-file-scan legacy sessions.
        const sourceInfo = validatedFileId
            ? await getSessionSourceInfo(db, validatedFileId, body.audio_stream_index)
            : null;
        const resolvedResolution =
            sourceInfo && sourceInfo.width !== null && sourceInfo.height !== null
                ? `${sourceInfo.width}x${sourceInfo.height}`
                : body.requested.resolution;

        const params: CreateSessionParams = {
            surface,
            id: body.session_id,
            media_id: body.media_id,
            user_id: userId,
            device_id: body.device_id,
            user_agent: body.user_agent,
            client_name: body.client_name,
            client_version: body.client_version,
            // Already a clean token list (the request schema normalises), and
            // `undefined` when the client announced nothing — which keeps the
            // column NULL rather than storing an empty-array claim.
            client_features: body.client_features,
            ip_address,
            play_method: body.requested.play_method,
            container: sourceInfo?.container ?? body.requested.container,
            audio_codec:
                sourceInfo?.audio_codec ?? plan?.source_audio_codec ?? body.requested.audio_codec,
            video_codec:
                sourceInfo?.video_codec ?? plan?.source_video_codec ?? body.requested.video_codec,
            bitrate_kbps: sourceInfo?.bitrate_kbps ?? body.requested.bitrate_kbps,
            resolution: resolvedResolution,
            position_ms: start?.positionMs ?? 0,
            device_capabilities: start?.capabilities ?? body.capabilities,
            requested_format: body.requested,
            jellyfin_media_source_id: body.jellyfin_media_source_id,
            audio_stream_index: body.audio_stream_index,
            subtitle_stream_index: body.subtitle_stream_index,
            runtime_ms: runtimeMs > 0 ? runtimeMs : undefined,
            plan_id: persistedPlanId,
            file_id: validatedFileId,
            plan_mode: plan?.method,
            plan_reasons: plan?.transcode_reasons,
            subtitle_method: plan?.subtitle_method,
            transcode_codec: plan?.target_video_codec,
            delivery_path: plan?.delivery_path,
            // The ONE place a request can influence `source`, and it is a
            // boolean → enum mapping rather than a passthrough on purpose:
            // `source` decides stream-limit accounting, so a client that could
            // name it could opt itself out of the limit. Everything else keeps
            // the column DEFAULT by leaving this undefined.
            //
            // Stamped even when the operator does not trust the claim
            // (TRUST_CLIENT_LOCAL_PLAYBACK off). Trust gates the stream-limit
            // EXEMPTION, not the label: an untrusted local session is still
            // shown as "Downloaded", still graded first-party, and still reaped
            // on the local schedule — it simply also still counts. Withholding
            // the stamp instead would hide the truth from the operator deciding
            // whether to trust it.
            source: body.is_local_playback ? 'local' : undefined,
            is_preview: start?.isPreview === true,
            purpose: start?.purpose,
            // Only a linear entry joins a resume-handoff chain (resume-handoff.service.ts).
            entry_mode: start?.entry,
        };
        const session = await createPlaySession(db, params);
        if (parentId) {
            await db`UPDATE play_sessions SET external_payload =
                jsonb_set(COALESCE(external_payload, '{}'::jsonb),
                    '{__lumastra_prefetch_parent}', to_jsonb(${parentId}::text))
                WHERE id = ${session.id}::uuid`;
        }

        // Register the device and refresh its label. This lives in the service tier
        // rather than the HTTP handler so every surface that starts a play session —
        // native, /j and /subsonic compat included — registers its device without
        // each one having to remember to. Best-effort: never fails playback start.
        await reportDeviceName(db, {
            userId,
            deviceId: body.device_id,
            name: body.device_name,
            clientId: body.client_name,
            source: 'play-session',
        });

        // Supersede prior live rows from THIS device for the same media:
        // when the same (user, media, device) starts a fresh session, the
        // earlier row is almost always a ghost — the player was closed
        // without sending a stop event. Scoping to device_id keeps
        // legitimate concurrent streams (same media on phone + laptop, or
        // a Lumastra session alongside an active Jellyfin one) untouched —
        // those have different device_ids. Stale rows from other devices
        // are still caught by the F5 reaper based on heartbeat age.
        //
        // ASSUMPTIONS this code depends on:
        //   1. Lumastra device_id is stable across launches for the same
        //      browser profile — see src/lib/components/player/device-id.ts
        //      (localStorage-backed UUID, not regenerated per launch). If a
        //      future client generates per-launch ids, ghosts from prior
        //      launches will linger until the F5 reaper.
        //   2. Lumastra and external (Jellyfin/ABS/...) device_ids live in
        //      disjoint namespaces — Lumastra uses 'dashboard-${uuid}',
        //      external pollers pass through their upstream's device id.
        //      A shared device_id between sources would let this UPDATE
        //      kill a legitimate parallel external row.
        // If either assumption breaks, narrow further by also matching on
        // (or filtering by) `source = 'lumastra'`.
        // RETURNING the killed ids so the post-tx publish loop knows which
        // owners to ping over SSE. Doing this inside the same transaction
        // means the rows are guaranteed KILLED+superseded by the time we
        // publish — no read-after-write race.
        const supersededRows = await db<{ id: string }[]>`
            UPDATE play_sessions
            SET status = 'KILLED',
                stopped_at = now(),
                stop_reason = 'superseded'
            WHERE user_id = ${userId}
              ${start?.purpose === 'prefetch' ? db`` : db`AND media_id = ${body.media_id}::uuid`}
              AND device_id = ${body.device_id}
              AND id <> ${session.id}::uuid
              AND status IN ('ACTIVE', 'PAUSED')
              AND purpose = ${start?.purpose ?? 'play'}
            RETURNING id
        `;

        for (const old of supersededRows) {
            await expireMusicPrefetchRowsForParent(db, old.id);
            await revokeGrantsForPlaySession(old.id, db, 'superseded');
        }
        const previous =
            prefetched && start?.purpose === 'play'
                ? await finishPreviousMusicRows(db, userId, body.device_id, session.id)
                : [];
        return {
            session,
            supersededIds: supersededRows.map((r) => r.id),
            previous,
            plan,
            params,
            mediaType,
        };
    });

    // If policy blocked the session, return the error
    if (isPolicyError(txResult)) {
        return txResult;
    }

    const { session, supersededIds, previous, plan, params } = txResult;
    await finalizePreviousMusicSessions(sql, previous);

    // Tell the displaced owners (other tabs / earlier launches on the same
    // device) over SSE that they've been superseded. The transaction has
    // already committed, so subscribers won't race a stale row state. Failure
    // to publish is non-fatal — the heartbeat backstop covers missed pushes.
    for (const oldId of supersededIds) {
        await expireMusicPrefetchForSession(sql, oldId);
        await stopSessionTranscode(oldId, 'superseded');
        await cancelMusicStreamForSession(sql, oldId);
        notifySessionTerminated(oldId, 'superseded');
    }

    logger.info('Play session started', {
        session_id: session.id,
        username,
        userId,
        play_method: body.requested.play_method,
        plan_id: body.plan_id,
        file_id: body.file_id,
    });

    // Emit server-side session-start telemetry post-commit so a rolled-back
    // transaction never produces telemetry. Fire-and-forget — best-effort.
    emitSessionStartTelemetry({
        playSessionId: session.id,
        userId,
        deviceId: body.device_id,
        plan,
        params,
        isLive: txResult.mediaType === 'radio',
    });

    return { session_id: session.id, container: params.container };
}

/** Close the old native deck only AFTER admission has succeeded. */
export async function finishPreviousMusicRows(
    sql: postgres.Sql,
    userId: UserId,
    deviceId: string,
    keepId: string,
): Promise<SessionRow[]> {
    const rows = await sql<(SessionRow & { heard_ms: number | null })[]>`
        UPDATE play_sessions ps SET status = 'COMPLETED', stop_reason = 'track_change', stopped_at = now()
        WHERE user_id = ${userId} AND device_id = ${deviceId} AND id <> ${keepId}::uuid
          AND status IN ('ACTIVE', 'PAUSED') AND purpose = 'play' AND NOT is_preview
          AND source = 'lumastra'
          AND EXISTS (SELECT 1 FROM media_items mi WHERE mi.id = ps.media_id AND mi.media_type = 'track')
        RETURNING ps.*, (external_payload ->> '__lumastra_music_listened_total_ms')::bigint AS heard_ms`;
    for (const row of rows) {
        const { musicInteractionManager } = await import('./music-interaction-manager.service.js');
        const heardMs = Number(row.heard_ms ?? 0);
        await musicInteractionManager.reportPlayEnd(
            userId,
            row.media_id,
            heardMs,
            row.started_at,
            Number(row.runtime_ms) > 0 ? Number(row.runtime_ms) : undefined,
            false,
            undefined,
            row.id,
            false,
            sql,
        );
        await expireMusicPrefetchRowsForParent(sql, row.id);
        await revokeGrantsForPlaySession(row.id, sql, 'superseded');
    }
    return rows;
}

export async function finalizePreviousMusicSessions(
    sql: postgres.Sql,
    rows: SessionRow[],
): Promise<void> {
    for (const row of rows) {
        await expireMusicPrefetchForSession(sql, row.id);
        await stopSessionTranscode(row.id, 'track_change');
        await cancelMusicStreamForSession(sql, row.id);
        notifySessionTerminated(row.id, 'superseded');
    }
}

/** Called with the user advisory lock and session row lock held by the report transaction. */
export async function admitMusicPrefetchInTransaction(
    tx: postgres.Sql,
    current: SessionRow,
): Promise<PolicyError | 'lost' | null> {
    const [usable] = await tx<{ id: string }[]>`
        SELECT ps.id FROM play_sessions ps WHERE ps.id = ${current.id}::uuid
          AND ${musicPrefetchUsable(tx)}`;
    if (!usable) return 'lost';
    const userId = toUserId(current.user_id);
    const names = await getUsernamesByIds(tx, [userId]);
    const policyError = await enforceStreamPolicy(
        tx,
        userId,
        names.get(userId) ?? userId,
        current.ip_address,
        current.play_method,
        { session_id: current.id },
    );
    if (policyError) return policyError;
    // Admission hygiene may itself have reaped the current deck.
    const [stillUsable] = await tx<{ id: string }[]>`
        SELECT ps.id FROM play_sessions ps WHERE ps.id = ${current.id}::uuid
          AND ${musicPrefetchUsable(tx)}`;
    return stillUsable ? null : 'lost';
}

/** Expire a prepared deck as soon as the admitted deck it belongs to ends. */
export async function expireMusicPrefetchForSession(
    sql: postgres.Sql,
    parentId: string,
): Promise<void> {
    const expired = await withTx(sql, async (tx) => {
        const [parent] = await tx<{ user_id: string }[]>`
            SELECT user_id FROM play_sessions WHERE id = ${parentId}::uuid
              AND status NOT IN ('ACTIVE', 'PAUSED')`;
        if (!parent?.user_id) return [];
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${parent.user_id}::text, 0))`;
        await expireMusicPrefetchRowsForParent(tx, parentId);
        const rows = await tx<{ id: string }[]>`
            SELECT id FROM play_sessions WHERE purpose = 'prefetch'
              AND status = 'CRASHED' AND stop_reason = 'prefetch_parent_ended'
              AND user_id = ${parent.user_id}
              AND external_payload ->> '__lumastra_prefetch_parent' = ${parentId}
              AND external_payload #>> '{__lumastra_stale_reap,state}' = 'pending'`;
        for (const row of rows) await revokeGrantsForPlaySession(row.id, tx, 'reaped');
        return rows;
    });
    for (const row of expired) {
        await stopSessionTranscode(row.id, 'prefetch_parent_ended');
        await cancelMusicStreamForSession(sql, row.id);
        notifySessionKilled(row.id, 'prefetch_parent_ended');
        await markStaleSessionProcessed(sql, row.id);
    }
}

// ─── Session stop ─────────────────────────────────────────────────────────────

export async function endPlaySession(
    sql: postgres.Sql,
    session_id: string,
    position_ms: number,
    stop_reason: string,
    userId: string,
): Promise<SessionRow | null> {
    const session = await stopSession(sql, session_id, position_ms, stop_reason);
    if (session) {
        await revokeGrantsForPlaySession(session_id, sql, 'stopped');
        if (session.purpose === 'play') await expireMusicPrefetchForSession(sql, session_id);
        await stopSessionTranscode(session_id, stop_reason);
        logger.info('Play session ended', {
            session_id,
            username: userId,
            stop_reason,
        });
    }
    return session;
}

// ─── Admin kill ───────────────────────────────────────────────────────────────

export async function adminKillSession(
    sql: postgres.Sql,
    session_id: string,
    killed_by: string,
): Promise<{ username?: string } | null> {
    return killSessionUnified(sql, session_id, killed_by);
}

// ─── Reap-time completion backstop ─────────────────────────────────────────────
//
// A session the reaper is about to close as CRASHED may have actually been
// watched to completion — the client just never got the chance to say so
// (container restart mid-episode, tab killed, network dead). Session
// recovery on the client only re-establishes the *stream* (a fresh
// play_sessions row so playback/heartbeats keep flowing); it does not retry
// a completion report against the old, already-reaped session. Without this
// backstop, is_watched/resume_position_ms stay frozen at the last
// successfully-flushed heartbeat forever, even though the user finished the
// episode. Before either reaper bulk-crashes its candidates, run them
// through the normal stop/completion pipeline so anything that already
// crossed the completion threshold gets marked watched, gets a
// watch_history row, and lands in caches correctly — identical to a client
// sending a clean 'stop' at end of playback.

/**
 * Route candidates that already crossed the completion threshold through
 * `PlaySessionLifecycleService.update()` as a synthetic COMPLETED stop, so
 * they get the full completion pipeline (markWatched, watch_history entry,
 * cache invalidation, profile rebuild) instead of being silently crashed.
 * Candidates below the threshold are left untouched for the caller's normal
 * bulk-crash update.
 */
/**
 * True when a stale candidate reached its completion threshold and should be
 * finalized as a real COMPLETED stop (markWatched + watch_history + profile
 * rebuild) rather than bulk-crashed. /j-compat episodes use Jellyfin's 0.90
 * bar via playedThresholdFor; everything else uses the runtime-tiered bar.
 */
export function candidateCrossedCompletion(candidate: SessionRow): boolean {
    // A download reports nothing, so its position is where the book was opened, never
    // evidence that anything was listened to.
    if (
        candidate.purpose === 'prefetch' ||
        candidate.purpose === 'download' ||
        candidate.media_type === 'radio'
    )
        return false;
    const runtimeMs = Number(candidate.runtime_ms);
    const positionMs = Number(candidate.position_ms);
    if (!(runtimeMs > 0)) return false;
    return positionMs / runtimeMs >= playedThresholdFor(candidate, candidate.media_type, runtimeMs);
}

/**
 * Periodic stale-heartbeat reap. Atomically claims timed-out rows as CRASHED,
 * promotes genuine completions through the lifecycle service, then closes
 * upstream audiobook sessions represented by the claimed rows.
 */
export async function reapStaleSessions(
    sql: postgres.Sql,
): Promise<{ crashed: number; completed: number }> {
    // The UPDATE is the claim. A heartbeat that revives the row before this
    // statement no longer matches the stale predicate; one arriving afterwards
    // cannot revive an audiobook row from CRASHED. Only claimed rows may trigger
    // destructive upstream cleanup.
    const claimed = await claimStaleSessions(sql);
    return drainReapBacklog(sql, claimed);
}

/**
 * Shared tail of both reapers: work the pending backlog (this cycle's claims
 * plus anything an earlier cycle could not finish) and report on the rows THIS
 * call claimed.
 *
 * Counting is deliberately restricted to `claimed`. The pending set legitimately
 * contains rows from earlier cycles, and folding those into the return value
 * would report the same session as reaped once per cycle until it drained.
 */
async function drainReapBacklog(
    sql: postgres.Sql,
    claimed: SessionRow[],
): Promise<{ crashed: number; completed: number }> {
    const pending = await getPendingStaleSessions(sql);
    for (const sessionId of new Set([...claimed, ...pending].map((candidate) => candidate.id))) {
        await revokeGrantsForPlaySession(sessionId, sql, 'reaped');
    }
    // Claims made by policy admission also land in this durable backlog. Work
    // committed rows here; never stop a process inside admission's transaction.
    for (const candidate of new Map(
        [...claimed, ...pending].map((row) => [row.id, row]),
    ).values()) {
        if (candidate.purpose === 'play') await expireMusicPrefetchForSession(sql, candidate.id);
        await stopSessionTranscode(candidate.id, candidate.stop_reason ?? 'session_reaped');
        if (candidate.purpose === 'prefetch') {
            await cancelMusicStreamForSession(sql, candidate.id);
            // Reuse the existing music kill subscription on every replica.
            notifySessionKilled(candidate.id, 'prefetch_expired');
        }
    }
    const completedIds = await processPendingStaleSessions(sql, pending);
    await drainPendingAudiobookSessionCloses(sql);
    const completed = claimed.filter((candidate) => completedIds.has(candidate.id)).length;
    // `crashed` counts rows this call transitioned to CRASHED and did NOT then
    // promote to COMPLETED. Whether their upstream cleanup succeeded is a
    // separate concern — a failed close leaves the row pending for the next
    // cycle but does not un-crash it.
    const crashed = claimed.length - completed;
    return { crashed, completed };
}

async function drainPendingAudiobookSessionCloses(sql: postgres.Sql): Promise<void> {
    try {
        const candidates = await getRetryableAudiobookSessionCloses(sql);
        if (candidates.length === 0) return;
        const usernames = await getUsernamesByIds(
            sql,
            candidates.map((candidate) => candidate.user_id),
        );
        const audiobookModule = await import('./audiobook-session.service.js');
        const deps = await audiobookModule.defaultSessionDeps();
        for (const candidate of candidates) {
            const username = usernames.get(candidate.user_id.toLowerCase());
            if (!username || !candidate.source_session_id) {
                // Nothing here can ever succeed — the listener no longer exists,
                // or the row lost the id the close needs. Burn an attempt so the
                // payload retires instead of being re-fetched every cycle forever.
                await audiobookModule.abandonAudiobookSessionClose(sql, candidate);
                continue;
            }
            await audiobookModule.retryPendingAudiobookSessionClose({
                sql,
                userId: toUserId(candidate.user_id),
                username,
                absSessionId: candidate.source_session_id,
                deps,
            });
        }
    } catch (error) {
        logger.warn('Could not drain pending AudiobookShelf session closes', {
            error: String(error),
        });
    }
}

/**
 * Keep AudiobookShelf's session list aligned with the local stale-session
 * reaper. ABS does not expire a crashed client reliably, so local cleanup must
 * close the upstream session after atomically marking the local row terminal.
 */
async function processPendingStaleSessions(
    sql: postgres.Sql,
    candidates: SessionRow[],
): Promise<Set<string>> {
    const audiobookCandidates = candidates.filter(
        (candidate) =>
            candidate.source === 'audiobookshelf' &&
            candidate.source_session_id !== null &&
            candidate.media_type === 'audiobook',
    );
    const usernames = await getUsernamesByIds(
        sql,
        audiobookCandidates.map((candidate) => candidate.user_id),
    );
    const completedIds = new Set<string>();
    let audiobookDeps: AudiobookSessionDeps | null = null;

    for (const candidate of candidates) {
        // Every `continue` below leaves the claim pending for a later cycle, so
        // each one must first burn an attempt — otherwise a row nothing can ever
        // process (deleted listener, permanently failing upstream) is re-fetched
        // and re-attempted on every reap for the lifetime of the instance.
        if (candidate.status !== 'COMPLETED' && candidateCrossedCompletion(candidate)) {
            try {
                await getPlaySessionLifecycleService().update(candidate.id, {
                    position_ms: Number(candidate.position_ms),
                    status: 'COMPLETED',
                    event_seq: candidate.last_event_seq + 1,
                    end_reason: 'completion',
                    // The reaper is server-side and holds no play-time
                    // accumulator. 0 is safe and correct here: `end_reason:
                    // 'completion'` sets `isCompletionEnd`, which persists
                    // durable state regardless of the engagement gate, and
                    // `highest_session_elapsed_ms` is ratcheted with GREATEST
                    // so a 0 can never lower an already-recorded value.
                    session_elapsed_ms: 0,
                    // A crashed music session past the completion bar has no
                    // client-reported heard time to fall back on. The last
                    // reported position is the best evidence (stored heard
                    // high-water still wins via max in handleMusicReport).
                    // Only reached past the bar, so scrub+pause never lands here.
                    ...(isMusicSessionMediaType(candidate.media_type)
                        ? { listened_ms: Number(candidate.position_ms) }
                        : {}),
                });
            } catch (err) {
                logger.warn('Failed to finalize completed stale session', {
                    sessionId: candidate.id,
                    mediaId: candidate.media_id,
                    err,
                });
                await noteStaleSessionFailure(sql, candidate, 'completion finalize failed');
                continue;
            }
        }
        if (candidateCrossedCompletion(candidate)) completedIds.add(candidate.id);

        if (
            candidate.source === 'audiobookshelf' &&
            candidate.source_session_id !== null &&
            candidate.media_type === 'audiobook'
        ) {
            try {
                const username = usernames.get(candidate.user_id.toLowerCase());
                if (!username) {
                    await noteStaleSessionFailure(sql, candidate, 'no such listener');
                    continue;
                }
                const audiobookModule = await import('./audiobook-session.service.js');
                audiobookDeps ??= await audiobookModule.defaultSessionDeps();
                const result = await audiobookModule.retryPendingAudiobookSessionClose({
                    sql,
                    userId: toUserId(candidate.user_id),
                    username,
                    absSessionId: candidate.source_session_id,
                    deps: audiobookDeps,
                });
                if (!result.processed) {
                    await noteStaleSessionFailure(sql, candidate, 'upstream close not applied');
                    continue;
                }
            } catch (error) {
                logger.warn('Failed to close stale AudiobookShelf session', {
                    sessionId: candidate.id,
                    error: String(error),
                });
                await noteStaleSessionFailure(sql, candidate, String(error));
                continue;
            }
        }

        await markStaleSessionProcessed(sql, candidate.id);
    }
    return completedIds;
}

/**
 * Record one failed processing attempt against a claimed row, and log the
 * give-up exactly once when the row retires.
 */
async function noteStaleSessionFailure(
    sql: postgres.Sql,
    candidate: SessionRow,
    reason: string,
): Promise<void> {
    try {
        const retired = await recordStaleSessionAttempt(sql, candidate.id);
        if (retired) {
            logger.warn('Giving up on stale session cleanup after repeated failures', {
                sessionId: candidate.id,
                userId: candidate.user_id,
                source: candidate.source,
                reason,
            });
        }
    } catch (error) {
        logger.warn('Could not record stale session cleanup attempt', {
            sessionId: candidate.id,
            error: String(error),
        });
    }
}

/**
 * Boot-time orphan reap. Same claim-then-process shape as `reapStaleSessions`,
 * gated by the multi-replica grace window.
 *
 * Uses `claimBootOrphanSessions` rather than a bare crash UPDATE so restart
 * orphans get the same reap stamp as heartbeat-timeout orphans. Without it an
 * audiobook session killed by a deploy would go CRASHED with no marker, and no
 * retry path could ever find it to close the AudiobookShelf side — which is the
 * single most common way these sessions die.
 */
export async function reapBootOrphanSessions(
    sql: postgres.Sql,
    graceSeconds = 0,
): Promise<{ crashed: number; completed: number }> {
    const claimed = await claimBootOrphanSessions(sql, graceSeconds);
    return drainReapBacklog(sql, claimed);
}

// Re-export for consumers that need it
export { getActiveSessionsForUser, upsertStreamPolicy, deleteStreamPolicy };

export interface PlaybackStartContext {
    mintedByAdmin?: boolean;
    surface?: ApiSurface;
    parentTokenHash?: string;
    deviceSessionId?: string;
    /** Diagnostic metadata only; never used for authentication or policy. */
    clientName?: string;
    clientVersion?: string;
    userAgent?: string;
}
export interface PlaybackStartFailure {
    status: number;
    message: string;
}

/** Public start: owns row creation, the delivery decision and its scoped credential. */
export async function startPlaySession(
    sql: postgres.Sql,
    userId: UserId,
    username: string,
    clientIp: string,
    body: PlaybackStartRequest,
    surface: PlaySurface = 'unknown',
    context: PlaybackStartContext = {},
): Promise<PlaybackStartResponse | PolicyError | PlaybackStartFailure> {
    const diagnosticValue = (value: string | undefined): string | undefined =>
        value?.trim().slice(0, 200) || undefined;
    body = {
        ...body,
        mediaId: body.mediaId.toLowerCase(),
        fileId: body.fileId?.toLowerCase(),
        clientInfo: {
            ...body.clientInfo,
            client: diagnosticValue(body.clientInfo?.client) ?? diagnosticValue(context.clientName),
            version:
                diagnosticValue(body.clientInfo?.version) ?? diagnosticValue(context.clientVersion),
            userAgent:
                diagnosticValue(body.clientInfo?.userAgent) ?? diagnosticValue(context.userAgent),
        },
    };
    const apiSurface = context.surface ?? 'v1';
    const capabilities = resolvePlaybackCapabilities(body.capabilities);
    const { getMediaItemById } = await import('../database/queries/catalog-operations.queries.js');
    const media = await getMediaItemById(sql, body.mediaId);
    if (!media) return { status: 404, message: 'Media not found' };
    const mediaType = String(media.media_type);
    const isRadio = mediaType === 'radio';
    const kind =
        mediaType === 'track' || isRadio
            ? 'music'
            : mediaType === 'audiobook'
              ? 'audiobook'
              : 'video';
    if (mediaType === 'tvchannel') {
        // Decision (fresh-eyes 2026-10-20): Live TV takes station options (feed, quality,
        // bitrate cap, HEVC) and starts at its own endpoint, which returns this same envelope.
        return {
            status: 422,
            message:
                'Live TV stations start at POST /livetv/playback-sessions with {stationId}; it returns the same playback-session envelope',
        };
    }
    if (!['track', 'radio', 'audiobook', 'movie', 'episode', 'video'].includes(mediaType)) {
        return { status: 422, message: 'This media kind cannot start here' };
    }
    const invalid = (message: string): PlaybackStartFailure => ({ status: 422, message });
    if (isRadio) {
        if (body.purpose === 'prefetch') return invalid('Internet radio cannot be prefetched');
        if ((body.startPositionMs ?? 0) !== 0) return invalid('Internet radio cannot seek');
        if (body.audio !== undefined)
            return invalid('Internet radio does not support audio options');
        if (body.requestedMethod !== undefined && body.requestedMethod !== 'direct')
            return invalid('Internet radio supports direct playback only');
        const { getRadioStreamUrl } = await import('../database/queries/radio-stream.queries.js');
        const streamUrl = await getRadioStreamUrl(sql, body.mediaId);
        if (typeof streamUrl !== 'string' || !URL.canParse(streamUrl))
            return invalid('Radio station has no valid stream URL');
        if (!['http:', 'https:'].includes(new URL(streamUrl).protocol))
            return invalid('Radio station has no valid stream URL');
    }
    if (body.purpose === 'prefetch' && kind !== 'music')
        return invalid('purpose=prefetch is supported only for music tracks');
    if (
        kind !== 'video' &&
        (body.capabilities?.maxVideoBitrateBps !== undefined ||
            body.capabilities?.maxHeight !== undefined)
    )
        return invalid('Video quality controls are unsupported for audio starts');
    if (kind === 'music' && body.audio?.download !== undefined)
        return invalid('Music downloads use Bearer GET /music/tracks/{id}/stream?download=1');
    if (kind === 'video' && body.audio !== undefined)
        return invalid('audio options are only supported for music and audiobook starts');
    if (
        kind !== 'video' &&
        (body.audioStreamIndex !== undefined ||
            body.subtitleId !== undefined ||
            body.fileId !== undefined)
    )
        return invalid('fileId and track selections are video-only controls');
    if (
        kind === 'audiobook' &&
        (body.audio?.format !== undefined || body.audio?.bitrateKbps !== undefined)
    )
        return invalid('Audiobook audio format/bitrate controls are unsupported');
    if (
        kind === 'audiobook' &&
        body.requestedMethod !== undefined &&
        !['direct', 'audio_transcode', 'full_transcode'].includes(body.requestedMethod)
    )
        return invalid('Unsupported audiobook requestedMethod');
    const { buildGrantedHref, mintPlaybackGrant } = await import('./playback-grant.js');
    let playbackSessionId: string | undefined;
    let grant: MintedPlaybackGrant;
    let delivery: PlaybackStartResponse['delivery'];

    try {
        if (kind === 'audiobook') {
            const { openAudiobookSession } = await import('./audiobook-session.service.js');
            const opened = await openAudiobookSession({
                ...context,
                sql,
                userId,
                username,
                mediaId: body.mediaId,
                deviceId: body.deviceId,
                surface: apiSurface,
                playSurface: surface,
                clientIp,
                castTarget: body.castTarget,
                clientName: body.clientInfo?.client,
                clientVersion: body.clientInfo?.version,
                userAgent: body.clientInfo?.userAgent,
                positionMs: body.startPositionMs,
                forceTranscode:
                    body.requestedMethod === 'full_transcode' ||
                    body.requestedMethod === 'audio_transcode',
                purpose: body.audio?.download ? 'download' : 'playback',
                // Omitted capabilities: the session's own MP3 + MP4 fallback (the documented
                // audiobook default). Unknown container tokens are ignored.
                supportedMimeTypes: body.capabilities?.containers?.flatMap((container) => {
                    if (container.includes('/')) return [container];
                    const mime = AUDIOBOOK_CONTAINER_MIME[container.toLowerCase()];
                    return mime ? [mime] : [];
                }),
            });
            if (!opened.ok) {
                switch (opened.kind) {
                    case 'stream_policy':
                        return opened.error;
                    case 'not_an_audiobook':
                        return { status: 404, message: 'Audiobook not found' };
                    case 'no_abs_link':
                        return { status: 403, message: 'This account has no AudiobookShelf link' };
                    case 'abs_unavailable':
                        return { status: 503, message: opened.message };
                }
            }
            playbackSessionId = opened.playbackSessionId;
            grant = opened.grant;
            const book = opened.payload;
            // The private map keeps upstream file identifiers out of delivery URLs.
            const privateTracks = opened.sourceTracks
                .filter((track) => track.ino)
                .map((track) => ({ index: track.index, ino: track.ino! }));
            await sql`UPDATE play_sessions SET device_capabilities = ${sql.json({ audiobookTracks: privateTracks })}
                WHERE id = ${playbackSessionId} AND user_id = ${userId}`;
            const hlsUrl =
                book.playMethod === 'transcode'
                    ? buildGrantedHref(
                          grant,
                          audiobookDeliveryUrl(
                              `/audiobook/${body.mediaId}/hls/playback/${playbackSessionId}/output.m3u8`,
                          ),
                          { PlaySessionId: playbackSessionId },
                      )
                    : undefined;
            const HLS_MIME = 'application/vnd.apple.mpegurl';
            // A transcoded book is ONE HLS playlist on the book clock, not per-file tracks.
            const fileTracks = opened.sourceTracks.map((track, index) => {
                if (!track.ino && !hlsUrl)
                    throw new Error('Audiobook track has no delivery source');
                const next = opened.sourceTracks[index + 1];
                const startMs = Math.round(track.startOffset * 1000);
                const durationMs = Math.max(
                    0,
                    Math.round(
                        (track.duration ??
                            (next
                                ? next.startOffset - track.startOffset
                                : ((book.durationMs ?? startMs) - startMs) / 1000)) * 1000,
                    ),
                );
                return {
                    index: track.index,
                    url: track.ino
                        ? buildGrantedHref(
                              grant,
                              audiobookDeliveryUrl(
                                  `/audiobooks/${body.mediaId}/files/${track.index}`,
                              ),
                              { PlaySessionId: playbackSessionId },
                          )
                        : hlsUrl!,
                    startMs,
                    durationMs,
                    codec: track.codec,
                    title: track.title,
                    needsRemux: track.needsRemux,
                    remuxUrl:
                        track.ino && track.needsRemux
                            ? buildGrantedHref(
                                  grant,
                                  audiobookDeliveryUrl(
                                      `/audiobooks/${body.mediaId}/remux/${track.index}`,
                                  ),
                                  { PlaySessionId: playbackSessionId },
                              )
                            : undefined,
                    mime: !track.ino ? HLS_MIME : (track.mimeType ?? 'application/octet-stream'),
                };
            });
            const tracks = hlsUrl
                ? [
                      {
                          index: 0,
                          url: hlsUrl,
                          startMs: 0,
                          durationMs:
                              book.durationMs ??
                              fileTracks.reduce((total, track) => total + track.durationMs, 0),
                          mime: HLS_MIME,
                      },
                  ]
                : fileTracks;
            delivery = {
                kind: 'multipart-audio',
                book: book.book,
                tracks,
                chapters: opened.sourceChapters.map((chapter, index) => ({
                    index,
                    name: chapter.title ?? '',
                    startMs: Math.round(chapter.start * 1000),
                    endMs: Math.round((chapter.end ?? (book.durationMs ?? 0) / 1000) * 1000),
                })),
                startPositionMs: book.startPositionMs,
                durationMs: book.durationMs ?? null,
            };
        } else {
            let info: LumastraInfoResponse | undefined;
            let deliveryPaths: PlaybackDeliveryPaths | undefined;
            let method: PlayMethod = 'direct';
            let effectiveAudio = body.audioStreamIndex;
            // The plan's audio layout after a method upgrade (see upgradePlan).
            let upgradedHlsAudioMode: 'muxed' | 'demux' | undefined;
            let effectiveSubtitleId =
                body.subtitleId ?? (body.requestedMethod === 'audio_only' ? 'none' : undefined);
            let effectiveSubtitleIndex: number | undefined;
            let subtitleBurnIn = false;
            const extraReasonCodes: TranscodeReason[] = [];
            let musicDecision: AudioNegotiation | undefined;
            if (kind === 'music' && !isRadio) {
                const { getTrackStreamSource } =
                    await import('../database/queries/music.queries.js');
                const { resolveMediaPath } = await import('../utils/media-path-resolver.js');
                const { probeAudioSource } = await import('./music-transcode/source-metadata.js');
                const { negotiateAudio } = await import('./music-transcode/negotiation.js');
                const { features } = await import('../config.js');
                const source = await getTrackStreamSource(sql, body.mediaId);
                if (!source?.file_path) return { status: 404, message: 'Track file not found' };
                const path = await resolveMediaPath(
                    source.file_path,
                    { skipLocalAccessCheck: true },
                    sql,
                );
                if (!path?.isAccessible) return { status: 404, message: 'Track file unavailable' };
                try {
                    const metadata = await probeAudioSource(path.containerPath);
                    musicDecision = negotiateAudio(metadata, {
                        ...body.audio,
                        // Keep omitted lists distinguishable from explicit exclusions.
                        capabilities: body.capabilities ?? {},
                        requestedMethod: body.requestedMethod,
                        transcodeEnabled: features.musicTranscode,
                    });
                } catch (error) {
                    return {
                        kind: 'source_incompatible',
                        requested: body.requestedMethod ?? 'direct',
                        reason: error instanceof Error ? error.message : 'Audio incompatible',
                        suggestion: 'audio_transcode',
                    };
                }
                method = musicDecision.playMethod;
            }
            if (kind === 'video') {
                const { buildPlaybackStartInfo } = await import('./info.service.js');
                const { startDecisionInputs } = await import('./playback-start-inputs.js');
                const result = await buildPlaybackStartInfo({
                    sql,
                    userId,
                    internalId: body.mediaId,
                    fileId: body.fileId,
                    audioStreamIndex: body.audioStreamIndex,
                    subtitleId: effectiveSubtitleId,
                    requestedMethod: body.requestedMethod,
                    ...startDecisionInputs(body.capabilities),
                    surface: apiSurface,
                });
                if (!result.ok) return { status: result.status, message: result.message };
                info = result.data;
                deliveryPaths = result.deliveryPaths;
                const requestedVideoStart =
                    body.startPositionMs ??
                    Math.max(info.resume_position_ms ?? 0, info.stream_start_position_ms ?? 0);
                if (
                    info.duration_ms != null &&
                    info.duration_ms > 0 &&
                    requestedVideoStart >= info.duration_ms
                ) {
                    // A switch from a longer release must not create a session
                    // beyond this version's end. Store and publish
                    // the same bounded logical position.
                    body = {
                        ...body,
                        startPositionMs: Math.max(0, Math.round(info.duration_ms) - 1000),
                    };
                }
                const { recommendedStreamIndexes } = await import('./playback-start-inputs.js');
                let defaults = recommendedStreamIndexes(info);
                if (!defaults) {
                    const { subtitleDeliveryMethod } =
                        await import('./playback-timeline.service.js');
                    const embeddedSubtitleTracks = info.tracks.subtitles;
                    const subtitleCandidates = (info.subtitles ?? []).filter(
                        (descriptor) =>
                            subtitleDeliveryMethod(
                                descriptor,
                                embeddedSubtitleTracks.find(
                                    (track) => track.index === descriptor.index,
                                )?.method,
                                capabilities.subtitleFormats,
                            ) !== 'none',
                    );
                    // A missing/failed preference read omits advisory recommendations,
                    // but must still apply safe automatic audio/forced-subtitle defaults.
                    // Valid explicit audio remains locked, including commentary/AD.
                    const selected = resolveTracks(
                        info.tracks.audio.map((track) => ({ ...track, isDefault: track.default })),
                        subtitleCandidates.map((track) => ({ ...track, isForced: track.forced })),
                        DEFAULT_LANGUAGE_PREFERENCES,
                        null,
                        (info.tracks.audio.find((track) => track.default) ?? info.tracks.audio[0])
                            ?.index ?? 0,
                        info.tracks.audio.find((track) => track.absoluteIndex === effectiveAudio)
                            ?.index,
                    );
                    defaults = {
                        audioStreamIndex: info.tracks.audio.find(
                            (track) => track.index === selected.audio.index,
                        )?.absoluteIndex,
                        subtitleId:
                            selected.subtitle.index === null
                                ? 'none'
                                : (subtitleCandidates.find(
                                      (track) => track.index === selected.subtitle.index,
                                  )?.id ?? 'none'),
                    };
                }
                effectiveAudio ??= defaults.audioStreamIndex;
                effectiveSubtitleId ??= defaults.subtitleId ?? 'none';
                // An older web tab can carry a relative or stale audio index.
                // Match the planner's selected-file default and publish the actual
                // absolute index in `applied`, including no audio for silent files.
                if (
                    effectiveAudio !== undefined &&
                    !info.tracks.audio.some((track) => track.absoluteIndex === effectiveAudio)
                )
                    effectiveAudio = defaults.audioStreamIndex;
                const descriptor = info.subtitles?.find(
                    (track) => track.id === effectiveSubtitleId,
                );
                if (effectiveSubtitleId !== 'none' && !descriptor)
                    return invalid('Subtitle not found in selected file');
                const selectedSubtitle =
                    descriptor?.kind === 'embedded'
                        ? info.tracks.subtitles.find((track) => track.index === descriptor.index)
                        : undefined;
                effectiveSubtitleIndex = selectedSubtitle?.index;
                subtitleBurnIn = selectedSubtitle?.method === 'burn_in';
                const { subtitleDeliveryMethod } = await import('./playback-timeline.service.js');
                if (
                    descriptor &&
                    subtitleDeliveryMethod(
                        descriptor,
                        selectedSubtitle?.method,
                        capabilities.subtitleFormats,
                    ) === 'none'
                )
                    return invalid('Selected subtitle has no supported delivery method');
                if (
                    subtitleBurnIn &&
                    body.requestedMethod !== undefined &&
                    body.requestedMethod !== 'full_transcode'
                )
                    return invalid('Burn-in subtitles require full_transcode');
                if (descriptor && body.requestedMethod === 'audio_only')
                    return invalid('audio_only cannot display subtitles');
                method = subtitleBurnIn ? 'full_transcode' : info.recommended;
                if (
                    subtitleBurnIn &&
                    !info.transcode_reason_codes?.some(
                        (reason) => reason.code === 'subtitle_burn_in',
                    )
                )
                    extraReasonCodes.push({ code: 'subtitle_burn_in' });
                const methodRank: Record<PlayMethod, number> = {
                    direct: 0,
                    remux: 1,
                    audio_transcode: 2,
                    full_transcode: 3,
                    audio_only: 3,
                };
                // The planner is authoritative: an override can only add conversion.
                if (
                    body.requestedMethod !== undefined &&
                    body.requestedMethod !== method &&
                    methodRank[body.requestedMethod] >= methodRank[method]
                ) {
                    method = body.requestedMethod;
                    extraReasonCodes.push({ code: 'client_requested' });
                }
                if (!info.playable || !info.play_methods[method]?.available) {
                    return {
                        kind: 'source_incompatible',
                        requested: method,
                        reason: 'Required delivery is unavailable for these capabilities',
                        suggestion: info.recommended,
                    };
                }
                // The HLS executor consumes this plan. Upgrade it together with the URL.
                if (info.plan_id && method !== info.recommended) {
                    const { playbackPlanner } = await import('./playback-planner.service.js');
                    upgradedHlsAudioMode = await playbackPlanner.upgradePlan(
                        info.plan_id,
                        method,
                        subtitleBurnIn,
                    );
                }
            }
            const started = await createPlaybackSessionRow(
                sql,
                userId,
                username,
                clientIp,
                {
                    media_id: body.mediaId,
                    device_id: body.deviceId,
                    device_name: body.clientInfo?.name,
                    client_name: body.clientInfo?.client,
                    client_version: body.clientInfo?.version,
                    user_agent: body.clientInfo?.userAgent,
                    requested: { play_method: method },
                    file_id: info?.active_file_id ?? body.fileId,
                    plan_id: info?.plan_id,
                    audio_stream_index: effectiveAudio,
                    subtitle_stream_index: effectiveSubtitleIndex,
                },
                surface,
                {
                    positionMs:
                        body.startPositionMs ??
                        Math.max(
                            0,
                            Math.round(
                                Math.max(
                                    info?.resume_position_ms ?? 0,
                                    info?.stream_start_position_ms ?? 0,
                                ),
                            ),
                        ),
                    capabilities,
                    // Dedicated previews never allocate an ordinary playback session.
                    isPreview: false,
                    purpose: body.purpose ?? 'play',
                    // Only video hands off; music and audiobooks have their own resume.
                    entry: kind === 'video' ? body.entry : undefined,
                },
            );
            if (isPolicyError(started)) return started;
            playbackSessionId = started.session_id;
            grant = await mintPlaybackGrant({
                userId,
                mediaId: body.mediaId,
                playbackSessionId,
                kind,
                clientIp,
                castTarget: body.castTarget,
                ...context,
            });
            if (isRadio) {
                delivery = {
                    kind: 'file',
                    live: true,
                    url: buildGrantedHref(
                        grant,
                        apiUrl(
                            apiSurface,
                            `/music/radio/${apiSurface === 'v1' ? 'stations/' : ''}${body.mediaId}/stream`,
                        ),
                    ),
                    container: 'unknown',
                    playMethod: 'direct',
                    startPositionMs: 0,
                    durationMs: null,
                };
            } else if (kind === 'music') {
                delivery = {
                    kind: 'file',
                    url: buildGrantedHref(
                        grant,
                        apiUrl(apiSurface, `/music/tracks/${body.mediaId}/stream`),
                        {
                            format: musicDecision?.target ?? 'raw',
                            bitrateKbps: musicDecision?.target
                                ? musicDecision.bitrateKbps
                                : undefined,
                        },
                    ),
                    container: musicDecision!.container,
                    codec: musicDecision!.codec,
                    bitrateKbps: musicDecision!.bitrateKbps,
                    playMethod: method,
                    reasons: musicDecision!.reasonCodes.map((reason) => reason.code),
                    reasonCodes: musicDecision!.reasonCodes,
                    startPositionMs: body.startPositionMs ?? 0,
                    durationMs:
                        media.runtime_seconds != null
                            ? Math.round(media.runtime_seconds * 1000)
                            : null,
                };
            } else if (info && deliveryPaths) {
                const selected = apiUrl(
                    apiSurface,
                    deliveryPaths[method].replace(/^\/api\/(?:v1\/)?/, '/'),
                );
                const query = {
                    PlaySessionId: playbackSessionId,
                    hlsAudioTrack: effectiveAudio,
                    SubtitleStreamIndex: effectiveSubtitleIndex,
                    SubtitleMethod: subtitleBurnIn ? 'Encode' : undefined,
                    maxHeight: capabilities.maxHeight,
                    maxAudioChannels: capabilities.maxAudioChannels,
                };
                // One list: package 9's descriptors (embedded + sidecars), built on the
                // caller's surface by buildPlaybackStartInfo and carrying this grant.
                const { subtitleDeliveryMethod } = await import('./playback-timeline.service.js');
                const subtitles = (info.subtitles ?? []).map((track) => ({
                    ...track,
                    method: subtitleDeliveryMethod(
                        track,
                        info.tracks.subtitles.find((embedded) => embedded.index === track.index)
                            ?.method,
                        capabilities.subtitleFormats,
                    ),
                    hrefs: Object.fromEntries(
                        Object.entries(track.hrefs ?? {}).map(([key, href]) => [
                            key,
                            typeof href === 'string'
                                ? regrantHref(buildGrantedHref, grant, href, {
                                      PlaySessionId: playbackSessionId,
                                  })
                                : href,
                        ]),
                    ),
                }));
                const common = {
                    url: buildGrantedHref(grant, selected, query),
                    fileId: info.active_file_id,
                    playMethod: method,
                    hlsAudioMode:
                        method === 'direct'
                            ? undefined
                            : method !== info.recommended
                              ? // An upgraded plan is muxed unless it is native HLS; a client that
                                // reads 'demux' believes it can switch audio in the player.
                                (upgradedHlsAudioMode ?? ('demux' as const))
                              : info.hls_audio_mode,
                    reasons: [
                        ...info.transcode_reasons,
                        ...extraReasonCodes.map((reason) => reason.code),
                    ],
                    reasonCodes: [...(info.transcode_reason_codes ?? []), ...extraReasonCodes],
                    applied: {
                        audioStreamIndex: effectiveAudio,
                        subtitleId: effectiveSubtitleId ?? 'none',
                    },
                    transcodeCodec:
                        method === 'full_transcode' ? (info.transcode_codec ?? 'h264') : undefined,
                    outputHdr:
                        method === 'full_transcode'
                            ? method === info.recommended
                                ? info.output_hdr
                                : 'sdr'
                            : info.tracks.video?.hdr,
                    tracks: info.tracks,
                    subtitles,
                    startPositionMs:
                        body.startPositionMs ??
                        Math.max(
                            0,
                            Math.round(
                                Math.max(
                                    info.resume_position_ms ?? 0,
                                    info.stream_start_position_ms ?? 0,
                                ),
                            ),
                        ),
                    durationMs: info.duration_ms != null ? Math.round(info.duration_ms) : null,
                    seek: {
                        clientShouldSeek:
                            (body.startPositionMs ??
                                Math.max(
                                    info.resume_position_ms ?? 0,
                                    info.stream_start_position_ms ?? 0,
                                )) > 0,
                        streamStartPositionMs: Math.max(
                            0,
                            Math.round(info.stream_start_position_ms ?? 0),
                        ),
                    },
                    trickplay: info.trickplay
                        ? {
                              href: buildGrantedHref(
                                  grant,
                                  apiUrl(
                                      apiSurface,
                                      `/playback/${body.mediaId}/trickplay/${info.trickplay.width}/manifest`,
                                  ),
                                  { fileId: info.active_file_id, PlaySessionId: playbackSessionId },
                              ),
                              intervalMs: info.trickplay.interval,
                          }
                        : undefined,
                    recommended: (
                        await import('./playback-start-inputs.js')
                    ).recommendedStreamIndexes(info),
                    // Package 9's timeline (chapters, segments, trickplay)
                    // with every href carrying this start's grant.
                    timeline: {
                        href: buildGrantedHref(
                            grant,
                            apiUrl(apiSurface, `/playback/${body.mediaId}/timeline`),
                            { fileId: info.active_file_id },
                        ),
                    },
                };
                if (method === 'direct') {
                    const container = info.tracks.video?.container ?? started.container;
                    if (!container)
                        throw new Error('Selected video file has no container metadata');
                    delivery = { ...common, kind: 'file', container };
                } else {
                    delivery = { ...common, kind: 'hls' };
                }
            } else {
                throw new Error('Missing video playback decision');
            }
        }
        if (body.clientInfo?.carPlay !== undefined) {
            try {
                const { recordSessionCarPlayContext } =
                    await import('../database/queries/play-session-client-context.queries.js');
                await recordSessionCarPlayContext(
                    sql,
                    playbackSessionId,
                    0,
                    body.clientInfo.carPlay,
                );
            } catch (error) {
                logger.warn('Could not record client playback context', {
                    playbackSessionId,
                    error,
                });
            }
        }
        return {
            playbackSessionId,
            mediaId: body.mediaId,
            kind,
            delivery,
            grant: {
                id: grant.id,
                token: grant.token,
                param: 'grant',
                mediaId: grant.mediaId,
                playbackSessionId: grant.playbackSessionId,
                kind: grant.kind,
                ipPinned: grant.ipPinned,
                expiresAt: grant.expiresAt.toISOString(),
                renewAfter: grant.renewAfter.toISOString(),
                renewHref: apiUrl(apiSurface, `/playback/grants/${grant.id}/renew`),
            },
            reporting: {
                kind: 'progress',
                method: 'PUT',
                playbackSessionId,
                href: apiUrl(apiSurface, `/play-sessions/${playbackSessionId}`),
                intervalMs: 10_000,
                unit: 'ms',
            },
        };
    } catch (error) {
        if (playbackSessionId) {
            await endPlaySession(
                sql,
                playbackSessionId,
                body.startPositionMs ?? 0,
                'error',
                userId,
            );
        }
        throw error;
    }
}

/** Adds a start's grant to a server-built base-relative href (keeps its own query). */
/** Audio container tokens (capabilities.containers) to the MIME types the audiobook session negotiates. */
const AUDIOBOOK_CONTAINER_MIME: Record<string, string> = {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    m4b: 'audio/mp4',
    mp4: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
    webm: 'audio/webm',
};

function regrantHref(
    build: typeof BuildGrantedHref,
    grant: MintedPlaybackGrant,
    href: string,
    extra: Record<string, string | undefined> = {},
): string {
    const url = new URL(href, 'https://playback.invalid');
    for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined) url.searchParams.set(key, value);
    }
    return build(grant, url.pathname, url.searchParams);
}
