// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The Lumastra remote controlling a Jellyfin client (direction B): the
 * `/j` remote-control registry as targets of the core device API.
 *
 * Registered with the core (`external-remote-targets.ts`) by `register.ts`
 * (which `boot/compat-init.ts` imports lazily), and only active while
 * `FEATURE_JELLYFIN_COMPAT` is on, so `GET /devices` lists the user's Jellyfin clients next to their Lumastra
 * devices under the id `jf:<remote session id>` (never a device session id),
 * `GET /devices/{id}/state` describes them and `POST /devices/{id}/commands`
 * is delivered through the client's open `/j/socket` as a `Playstate`,
 * `GeneralCommand` or `Play` message (mapping: `jellyfin-targets-map.ts`).
 *
 * Jellyfin has no per-command acknowledgement. A command is `applied` as soon
 * as it was handed to a client with an open socket; a client without one, or a
 * message that reached no socket and could not be published, is a
 * `device_unreachable` error. The command is final on POST: nothing is stored.
 */

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { config } from '$lib/server/config';
import { getDb } from '$lib/server/database/connection.js';
import { getActiveSessionsForUser } from '$lib/server/database/queries/play-sessions.queries';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import {
    DEVICE_COMMANDS,
    type DeviceCapabilities,
    type DeviceCommand,
    type DeviceCommandRequest,
    type DeviceNowPlaying,
    type DeviceState,
} from '$lib/schemas/device-commands.js';
import type {
    ExternalRemoteTargetProvider,
    ExternalTargetUser,
} from '$lib/server/services/external-remote-targets.js';
import type {
    CommandSender,
    DeviceCommandErrorKind,
    Result,
    SendChecks,
} from '$lib/server/services/device-commands.service.js';
import type { ResolvedDeviceSession } from '$lib/server/services/user-devices.service.js';
import { toUserId } from '$lib/shared/user-id';
import { sanitizeDisplayName } from '$lib/server/utils/display-name.js';
import { Logger } from '$lib/server/utils/logger.js';
import { toJellyfinId } from '../serializers/user';
import { canSeeItem, userContextFor } from './commands';
import {
    getDevice,
    getOnlineSessionIds,
    listDevicesForUser,
    type RemoteDeviceRecord,
} from './device-registry';
import { deliverToSession } from './fanout';
import { IDLE_DEVICE_WINDOW_MS } from './sessions-list';
import {
    deviceTypeForClient,
    fromTargetId,
    isJellyfinTargetId,
    registryCapabilities,
    requestItemIds,
    requestToJellyfin,
    toTargetId,
} from './jellyfin-targets-map';

const logger = Logger.for('JellyfinCompat:RemoteTargets');

// Keys carry `jf:` so they never share a budget with the native `devcmd:<user>:<device>` keys.
const RATE_LIMIT = { limit: 20, windowSeconds: 10 };
const MESSAGE_RATE_LIMIT = { limit: 10, windowSeconds: 60 };
/** A live play session reports every ~10 s; older ones are not "now playing". */
const ACTIVE_FRESHNESS_MS = 60_000;
const PAUSED_FRESHNESS_MS = 30 * 60_000;
/** Lifetime stamped on the (already final) command object. */
const COMMAND_RECORD_TTL_MS = 5 * 60_000;
/** A relative seek from a heartbeat older than this would land somewhere unknown. */
const SEEK_SAMPLE_MAX_AGE_MS = 15_000;
/** Longest the revision map is allowed to grow before it is rebuilt. */
const MAX_TRACKED_REVISIONS = 5000;

const fail = <T>(
    kind: DeviceCommandErrorKind,
    message: string,
    retryAfter?: number,
): Result<T> => ({
    ok: false,
    error: { kind, message, ...(retryAfter !== undefined ? { retryAfter } : {}) },
});

const sameUser = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

async function ownedRecord(
    id: string,
    user: ExternalTargetUser,
): Promise<RemoteDeviceRecord | null> {
    if (!isJellyfinTargetId(id)) return null;
    const record = await getDevice(fromTargetId(id));
    return record && sameUser(record.userId, user.userId) ? record : null;
}

/** The newest live play session of the client's device, if it reports one. */
async function activePlayback(
    sql: postgres.Sql,
    record: RemoteDeviceRecord,
    now: number,
): Promise<{
    sessionId: string;
    mediaId: string;
    mediaType: string | null;
    positionSeconds: number;
    durationSeconds?: number;
    paused: boolean;
    /** When the position was sampled (the play session's last heartbeat), epoch ms. */
    sampledAt: number;
} | null> {
    const rows = (await getActiveSessionsForUser(sql, toUserId(record.userId))).filter((row) => {
        if (row.device_id !== record.deviceId) return false;
        const quiet = now - new Date(row.last_heartbeat_at).getTime();
        return row.status === 'PAUSED' ? quiet < PAUSED_FRESHNESS_MS : quiet < ACTIVE_FRESHNESS_MS;
    });
    if (rows.length === 0) return null;
    const row = rows.reduce((a, b) => (b.last_heartbeat_at > a.last_heartbeat_at ? b : a));
    return {
        sessionId: row.id,
        mediaId: row.media_id,
        mediaType: row.media_type,
        positionSeconds: Math.max(0, row.position_ms / 1000),
        ...(row.runtime_ms ? { durationSeconds: row.runtime_ms / 1000 } : {}),
        paused: row.status === 'PAUSED',
        sampledAt: new Date(row.last_heartbeat_at).getTime(),
    };
}

/** Where playback is now: the sample, moved on by the time since it was taken while playing. */
function currentPosition(
    playing: {
        positionSeconds: number;
        durationSeconds?: number;
        paused: boolean;
        sampledAt: number;
    },
    now: number,
): number {
    if (playing.paused) return playing.positionSeconds;
    const moved = playing.positionSeconds + Math.max(0, now - playing.sampledAt) / 1000;
    return playing.durationSeconds !== undefined ? Math.min(moved, playing.durationSeconds) : moved;
}

const isAudio = (mediaType: string | null): boolean =>
    /^(track|audio|music)$/i.test(mediaType ?? '');

/** Per-process high-water mark: a state answer never carries a lower revision than an earlier one. */
const lastRevision = new Map<string, number>();
function nextRevision(id: string, now: number): number {
    const next = Math.max((lastRevision.get(id) ?? 0) + 1, now);
    if (lastRevision.size >= MAX_TRACKED_REVISIONS) lastRevision.clear();
    lastRevision.set(id, next);
    return next;
}

function capabilitiesOf(record: RemoteDeviceRecord): DeviceCapabilities {
    return registryCapabilities(record);
}

function toDeviceEntry(record: RemoteDeviceRecord, online: boolean): ResolvedDeviceSession {
    const last = new Date(record.lastActivityAt).toISOString();
    return {
        // Stable and negative: never a database row id, never equal to another target's.
        id: -(1 + (Number.parseInt(record.id.slice(0, 7), 16) || 0)),
        external: true,
        deviceSessionId: toTargetId(record.id),
        deviceId: record.deviceId,
        deviceName: record.deviceName,
        isCustomName: false,
        clientId: record.client,
        createdAt: last,
        lastUsedAt: last,
        isOnline: online,
        deviceType: deviceTypeForClient(record.client),
        supportsWatchTogether: false,
        features: [],
        ...(online ? { lastHeartbeat: last } : {}),
        capabilities: capabilitiesOf(record),
    };
}

/** A client the remote can use: it reported capabilities with something to control. */
const isControllable = (record: RemoteDeviceRecord): boolean =>
    record.supportsMediaControl || record.supportedCommands.length > 0;

async function list(user: ExternalTargetUser): Promise<ResolvedDeviceSession[]> {
    if (!config.FEATURE_JELLYFIN_COMPAT) return [];
    const now = Date.now();
    const [records, online] = await Promise.all([
        listDevicesForUser(user.userId, now),
        getOnlineSessionIds(now),
    ]);
    return records
        .filter(
            (r) =>
                isControllable(r) &&
                (online.has(r.id) || now - r.lastActivityAt <= IDLE_DEVICE_WINDOW_MS),
        )
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
        .map((r) => toDeviceEntry(r, online.has(r.id)));
}

async function state(id: string, user: ExternalTargetUser): Promise<DeviceState | null> {
    if (!config.FEATURE_JELLYFIN_COMPAT) return null;
    const record = await ownedRecord(id, user);
    if (!record) return null;
    const now = Date.now();
    const [online, sql] = [await getOnlineSessionIds(now), getDb()];
    const capabilities = capabilitiesOf(record);
    let nowPlaying: DeviceNowPlaying | null = null;
    if (sql) {
        const playing = await activePlayback(sql, record, now).catch((err: unknown) => {
            logger.warn('Playback lookup for a Jellyfin target failed', { error: String(err) });
            return null;
        });
        if (playing) {
            const audio = isAudio(playing.mediaType);
            nowPlaying = {
                kind: audio ? 'music' : 'video',
                sessionId: playing.sessionId,
                title: '',
                positionSeconds: playing.positionSeconds,
                ...(playing.durationSeconds !== undefined
                    ? { durationSeconds: playing.durationSeconds }
                    : {}),
                paused: playing.paused,
                rate: 1,
                // The sample's own time: a remote extrapolates from it, so "now" would skew it.
                observedAt: new Date(playing.sampledAt).toISOString(),
                reported: false,
                availableCommands: Object.keys(capabilities.commands),
                ...(audio
                    ? { music: { trackId: playing.mediaId } }
                    : {
                          video: {
                              itemId: playing.mediaId,
                              audioTracks: [],
                              subtitleTracks: [],
                              segments: [],
                          },
                      }),
            };
        }
    }
    return {
        deviceSessionId: id,
        deviceName: record.deviceName,
        deviceType: deviceTypeForClient(record.client),
        online: online.has(record.id),
        lastSeen: new Date(record.lastActivityAt).toISOString(),
        reachable: online.has(record.id),
        capabilities,
        nowPlaying,
        textInput: null,
        party: null,
        // Wall-clock milliseconds, raised above the last one answered for this
        // target so two answers within a millisecond still increase.
        revision: nextRevision(id, now),
    };
}

function commandRecord(
    id: string,
    request: DeviceCommandRequest,
    sender: CommandSender,
): DeviceCommand {
    const now = Date.now();
    const parsed = DEVICE_COMMANDS[request.type].args.safeParse(request.args ?? {});
    return {
        id: `cmd_${randomUUID()}`,
        deviceSessionId: id,
        type: request.type,
        args: parsed.success ? (parsed.data as Record<string, unknown>) : (request.args ?? {}),
        ...(request.expect ? { expect: request.expect } : {}),
        delivery: 'live',
        source: sender.source,
        sender: {
            username: sender.username,
            ...(sender.deviceName ? { deviceName: sender.deviceName } : {}),
        },
        status: 'applied',
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + COMMAND_RECORD_TTL_MS).toISOString(),
    };
}

async function send(input: {
    id: string;
    user: ExternalTargetUser;
    request: DeviceCommandRequest;
    sender: CommandSender;
    checks?: SendChecks;
}): Promise<Result<DeviceCommand>> {
    const { id, user, request, sender } = input;
    if (!config.FEATURE_JELLYFIN_COMPAT) return fail('not_found', 'Device not found');
    // The owner only: an administrator reaches another user's Jellyfin client
    // through the /j routes, never through this API.
    const record = await ownedRecord(id, user);
    if (!record) return fail('not_found', 'Device not found');

    const rl = await checkRateLimit(
        `devcmd:jf:${user.userId}:${id}`,
        RATE_LIMIT.limit,
        RATE_LIMIT.windowSeconds,
    );
    if (!rl.allowed) {
        return fail(
            'rate_limited',
            'Too many commands',
            Math.max(1, rl.resetAt - Math.floor(Date.now() / 1000)),
        );
    }
    if (request.type === 'ui.message') {
        const mrl = await checkRateLimit(
            `devcmd:jf:msg:${user.userId}`,
            MESSAGE_RATE_LIMIT.limit,
            MESSAGE_RATE_LIMIT.windowSeconds,
        );
        if (!mrl.allowed) {
            return fail(
                'rate_limited',
                'Too many messages',
                Math.max(1, mrl.resetAt - Math.floor(Date.now() / 1000)),
            );
        }
    }

    // Announced commands only, exactly like a Lumastra device.
    if (!Object.prototype.hasOwnProperty.call(capabilitiesOf(record).commands, request.type)) {
        return fail('device_unsupported', `This device cannot carry out ${request.type}`);
    }
    if (request.expect?.queueRevision !== undefined) {
        return fail('device_unsupported', 'A Jellyfin client has no music queue revision');
    }

    // Live TV permission and simple-mode lock, like a Lumastra device.
    const typeCheck = await input.checks?.check?.(request);
    if (typeCheck) return { ok: false, error: typeCheck };

    const sql = getDb();
    const needsPlayback =
        request.type === 'playback.seekBy' || request.expect?.sessionId !== undefined;
    const playing =
        needsPlayback && sql
            ? await activePlayback(sql, record, Date.now()).catch(() => null)
            : null;
    if (
        request.expect?.sessionId !== undefined &&
        playing?.sessionId !== request.expect.sessionId
    ) {
        return fail('stale_target', 'The device is playing something else now');
    }

    // Items the owner may not see are not sent to their own client either.
    const wireIds = requestItemIds(request);
    if (wireIds === null) return fail('invalid', 'itemId is not an item id this client can open');
    if (wireIds.length > 0) {
        if (!sql) return fail('unavailable', 'Database unavailable');
        const owner = await userContextFor(user.userId, user.username);
        if (!owner) return fail('not_found', 'Device not found');
        for (const wire of wireIds) {
            if (!(await canSeeItem(sql, wire, owner))) return fail('not_found', 'Item not found');
        }
    }

    // A relative seek starts from where playback is NOW, and only from a fresh sample.
    const now = Date.now();
    let positionSeconds: number | undefined;
    if (playing) {
        if (
            request.type === 'playback.seekBy' &&
            !playing.paused &&
            now - playing.sampledAt > SEEK_SAMPLE_MAX_AGE_MS
        ) {
            return fail('stale_target', 'The client has not reported its position recently');
        }
        positionSeconds = currentPosition(playing, now);
    }

    const senderLabel = sanitizeDisplayName(sender.deviceName || sender.username, 64) || 'Lumastra';
    const mapped = requestToJellyfin(request, {
        controllingUserId: toJellyfinId(user.userId).toLowerCase(),
        supportedCommands: record.supportedCommands,
        senderLabel: `Message from ${senderLabel}`,
        ...(positionSeconds !== undefined ? { positionSeconds } : {}),
    });
    if (!mapped.ok) return fail(mapped.kind, mapped.message);

    // An open socket on any replica is the only delivery Jellyfin has.
    const online = await getOnlineSessionIds();
    if (!online.has(record.id)) {
        return fail('device_unreachable', 'The device is not connected right now');
    }
    const delivery = await deliverToSession(record.id, mapped.message);
    if (delivery.local === 0 && !delivery.published) {
        return fail('device_unreachable', 'The command could not be delivered');
    }
    logger.info('Remote command delivered to a Jellyfin client', {
        type: request.type,
        message: mapped.message.MessageType,
    });
    return { ok: true, value: commandRecord(id, request, sender) };
}

export const jellyfinRemoteTargets: ExternalRemoteTargetProvider = {
    owns: (id) => isJellyfinTargetId(id) && config.FEATURE_JELLYFIN_COMPAT,
    list,
    state,
    send,
};
