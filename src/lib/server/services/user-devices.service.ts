// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Devices Service
 *
 * The one place device display names are written, and the one place the device
 * list is read. Both used to be scattered:
 *
 *   - Names were written at login only, into two different tables, one of which
 *     stored a Jellyfin credential string that then shadowed the real name in
 *     every UI.
 *   - The device list was assembled by three copy-pasted merges that had already
 *     drifted apart (one enriched from Valkey presence, two did not), so the same
 *     device showed different names on different screens.
 *
 * This module is AGPL core on purpose. `/settings` and the OAuth flow depend on
 * it, so it must not live under `src/lib/server/proprietary/` — proprietary code
 * may import core, never the reverse.
 */

import type { DeviceCapabilities } from '$lib/schemas/device-commands.js';
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import {
    getUserDeviceRows,
    upsertUserDevice,
    findDeviceSessionIdForDevice,
    type UserDeviceRow,
} from '$lib/server/database/queries/user-devices.queries.js';
import { getActiveRefreshTokens } from '$lib/server/database/queries/oauth-refresh-tokens.queries.js';
import { connectValkey, isCoordinationValkeyReady } from '$lib/server/cache/valkey.js';
import { getHeartbeat } from '$lib/server/services/device-presence.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { sanitizeDisplayName } from '$lib/server/utils/display-name.js';

const logger = Logger.for('UserDevicesService');

/**
 * Display names are shown in admin tables and interpolated into the
 * `X-Emby-Authorization` header, so they stay short. 64 leaves room for the
 * `"${APP_NAME} - "` prefix the Jellyfin binding adds while staying under the
 * 40-char point where the admin session view starts ellipsising… for most names.
 */
export const MAX_DEVICE_NAME_LENGTH = 64;

/**
 * Where a reported name came from. Used only for logging — precedence between a
 * client report and a user override is enforced by the schema (custom_name is a
 * separate column), not by this value.
 */
export type DeviceNameSource = 'oauth-device-flow' | 'play-session' | 'heartbeat';

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a client-supplied device name.
 *
 * Delegates to the shared display-label sanitiser rather than reimplementing it:
 * device names are exactly the attacker-chosen-label shape it exists for, and
 * bidi/zero-width spoofing matters more here than most places — a device list is
 * precisely where one entry impersonating another pays off.
 *
 * Every inlet is untrusted, and one (POST /oauth/device) is pre-auth and renders
 * the result on the page where a human decides whether to approve the login, so a
 * name is a phishing surface, not just a label.
 *
 * Quote/backslash escaping is deliberately NOT done here: that concern belongs to
 * `buildJellyfinAuthHeaders`, which sanitises at its own boundary. Stripping it
 * here too would corrupt legitimate names like `Tom"s TV`.
 *
 * Returns null for anything that normalises to empty, so callers store NULL
 * rather than an empty string that renders as a blank row.
 */
export function normalizeDeviceName(raw: string | null | undefined): string | null {
    if (typeof raw !== 'string') return null;
    const cleaned = sanitizeDisplayName(raw, MAX_DEVICE_NAME_LENGTH);
    return cleaned || null;
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

export interface ReportDeviceNameParams {
    userId: UserId;
    /** Client-generated device identifier. */
    deviceId: string;
    /** Raw client-supplied name; normalised here. */
    name?: string | null;
    deviceType?: string | null;
    clientId?: string | null;
    source: DeviceNameSource;
}

/**
 * Register a device sighting and record the name the client reported.
 *
 * Safe to call on every heartbeat: the upsert only advances `last_seen_at` and
 * refreshes `reported_name`, and never touches the user's `custom_name`. Callers
 * should not gate this on "did the name change" — the query already does the
 * right thing and the write is a single indexed upsert.
 *
 * **Errors propagate, deliberately.** This used to swallow them to keep device
 * bookkeeping from failing a login or a playback start. That is actively wrong
 * when the caller holds a transaction — and both playback callers do
 * (`startPlaySession` and the /j `findOrCreateJellyfinSession` both pass a
 * transaction handle). A failed statement inside a Postgres transaction aborts
 * it; catching the error in JavaScript does not undo that, so the next statement
 * — the session-supersede UPDATE — would fail with "current transaction is
 * aborted", pointing at the wrong culprit. Propagating means the session and its
 * device row land together or not at all, which is what those call sites already
 * document.
 *
 * Callers that are NOT in a transaction and genuinely want best-effort semantics
 * (the heartbeat, the Subsonic handlers) catch it themselves.
 */
export async function reportDeviceName(
    sql: postgres.Sql,
    params: ReportDeviceNameParams,
): Promise<UserDeviceRow | null> {
    if (!params.deviceId) return null;

    return await upsertUserDevice(sql, {
        userId: params.userId,
        deviceId: params.deviceId,
        reportedName: normalizeDeviceName(params.name),
        deviceType: params.deviceType ?? null,
        clientId: params.clientId ?? null,
    });
}

/**
 * Resolve the device session id to reuse for a (user, device) pair, so a
 * re-login continues an existing device instead of creating a new one.
 *
 * Previously this ran against `user_provider_device_tokens`, which only has rows
 * when Jellyfin sync is enabled — so on the default Jellyfin-less install every
 * login produced a fresh session and the device list accumulated one phantom
 * device per login.
 */
export async function resolveExistingDeviceSession(
    sql: postgres.Sql,
    userId: UserId,
    deviceId: string,
): Promise<string | null> {
    if (!deviceId) return null;
    try {
        return await findDeviceSessionIdForDevice(sql, userId, deviceId);
    } catch (error) {
        logger.warn('Device session reuse lookup failed', { error: String(error) });
        return null;
    }
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

export interface ResolvedDeviceSession {
    /** Database row id of the underlying auth session. */
    id: number;
    deviceSessionId: string;
    /** Client-generated device id, when the session resolves to one. */
    deviceId: string | null;
    /**
     * Display name: COALESCE(custom_name, reported_name) from user_devices,
     * falling back to the session's own recorded name. Never sourced from
     * `provider_device_binding` — that is a credential, not a label.
     */
    deviceName: string | null;
    /** True when the name came from the user rather than the client. */
    isCustomName: boolean;
    /** Recorded when bearer approval established this dependent session. */
    approvedByDeviceName?: string;
    clientId?: string;
    createdAt: string;
    lastUsedAt: string | null;
    isOnline: boolean;
    deviceType?: 'tv' | 'mobile' | 'web' | 'unknown';
    supportsWatchTogether: boolean;
    /**
     * UI features the device announced on its last heartbeat — see
     * `$lib/shared/client-features.ts`. Absent when the device is offline or
     * announced nothing; a device-targeted admin action should treat absent
     * and empty alike ("cannot render it").
     */
    features?: string[];
    /** Remote-control capabilities from the last heartbeat. */
    capabilities?: DeviceCapabilities;
    lastHeartbeat?: string;
    /** A remote-control target that is no Lumastra device session (`jf:…`). */
    external?: boolean;
}

/**
 * The most recent sign of life for a session.
 *
 * `last_used_at` alone read "Never" for every device: it lives on the refresh
 * token, and a token is only marked used at the moment it is exchanged, which is
 * the same moment rotation supersedes it. The live (non-superseded) token is
 * therefore always the fresh, never-used one. Its `created_at` is the last
 * rotation, i.e. the last time the client came back, and the device row's
 * `last_seen_at` advances on every heartbeat and playback start. The newest of
 * the three is what a user means by "last active".
 */
export function latestActivity(...dates: (Date | null | undefined)[]): string | null {
    let latest: number | null = null;
    for (const d of dates) {
        if (!d) continue;
        const t = d.getTime();
        if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
    }
    return latest === null ? null : new Date(latest).toISOString();
}

/** The persisted `user_devices.device_type`, narrowed to the API enum. */
function storedDeviceType(raw: string | null | undefined): ResolvedDeviceSession['deviceType'] {
    return raw === 'tv' || raw === 'mobile' || raw === 'web' ? raw : undefined;
}

export interface GetUserDevicesOptions {
    /** Enrich with Valkey presence. Off by default — it costs one lookup per session. */
    withPresence?: boolean;
}

/**
 * The single device-list read model.
 *
 * Returns one entry per auth session (which is what every caller revokes by),
 * with the display name resolved from the device entity so all surfaces agree.
 * Presence stays in Valkey keyed by device_session_id and is attached here.
 */
export async function getUserDevices(
    sql: postgres.Sql,
    userId: UserId,
    options: GetUserDevicesOptions = {},
): Promise<ResolvedDeviceSession[]> {
    const [deviceRows, oauthTokens] = await Promise.all([
        getUserDeviceRows(sql, userId),
        getActiveRefreshTokens(sql, userId),
    ]);

    // device_id -> resolved display name
    const byDeviceId = new Map<string, UserDeviceRow>();
    for (const row of deviceRows) byDeviceId.set(row.device_id, row);

    const sessions: ResolvedDeviceSession[] = [];
    const seen = new Set<string>();

    for (const token of oauthTokens) {
        if (!token.device_session_id) continue; // legacy tokens predate device sessions
        if (seen.has(token.device_session_id)) continue;
        seen.add(token.device_session_id);

        const device = token.device_id ? byDeviceId.get(token.device_id) : undefined;
        const resolvedName = device
            ? (device.custom_name ?? device.reported_name ?? token.device_name)
            : token.device_name;

        sessions.push({
            id: token.id,
            deviceSessionId: token.device_session_id,
            deviceId: token.device_id ?? null,
            deviceName: resolvedName,
            isCustomName: Boolean(device?.custom_name),
            ...(token.approved_by_device_session_id
                ? {
                      approvedByDeviceName:
                          token.approved_by_device_name ?? token.approved_by_device_session_id,
                  }
                : {}),
            clientId: token.client_id ?? undefined,
            createdAt: token.created_at.toISOString(),
            lastUsedAt: latestActivity(token.last_used_at, token.created_at, device?.last_seen_at),
            isOnline: false,
            deviceType: storedDeviceType(device?.device_type),
            supportsWatchTogether: false,
        });
    }

    if (options.withPresence) {
        await connectValkey();
        // device:online: lives on the task Valkey.
        if (isCoordinationValkeyReady()) {
            await Promise.all(
                sessions.map(async (session) => {
                    try {
                        const heartbeat = await getHeartbeat(session.deviceSessionId);
                        if (!heartbeat) return;
                        session.isOnline = true;
                        // Old clients send no type and the heartbeat handler
                        // records that as 'unknown'; a known stored type wins then.
                        session.deviceType =
                            heartbeat.deviceType && heartbeat.deviceType !== 'unknown'
                                ? heartbeat.deviceType
                                : (session.deviceType ?? heartbeat.deviceType);
                        session.supportsWatchTogether = heartbeat.supportsWatchTogether;
                        if (heartbeat.features !== undefined) {
                            session.features = heartbeat.features;
                        }
                        if (heartbeat.capabilities) {
                            session.capabilities = heartbeat.capabilities;
                        }
                        session.lastHeartbeat = new Date(heartbeat.lastSeen).toISOString();
                        // The heartbeat name is only a fallback now: reportDeviceName()
                        // persists it on every beat, so user_devices is already current.
                        // A user-chosen name still wins.
                        if (!session.deviceName && heartbeat.deviceName) {
                            session.deviceName = heartbeat.deviceName;
                        }
                    } catch {
                        // Presence is best-effort; a device with no heartbeat is offline.
                    }
                }),
            );
        }
    }

    // Online first, then most recent activity.
    sessions.sort((a, b) => {
        if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
        const at = new Date(a.lastHeartbeat ?? a.lastUsedAt ?? a.createdAt).getTime();
        const bt = new Date(b.lastHeartbeat ?? b.lastUsedAt ?? b.createdAt).getTime();
        return bt - at;
    });

    return sessions;
}
