// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Server side of `POST /Sessions/{sessionId}/…`: find the target device,
 * check the caller may control it, build the Jellyfin message and deliver it.
 *
 * Authorization follows the brief rather than Jellyfin's per-user
 * `EnableRemoteControlOfOtherUsers` flag (Lumastra has no such permission): a
 * user controls only their own devices, an admin any. A target the caller may
 * not control answers 404, exactly like one that does not exist, so session
 * ids cannot be probed.
 */

import type postgres from 'postgres';
import { userAllowsLiveTv } from '$lib/server/auth/livetv-user-policy.js';
import { config } from '$lib/server/config.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getSessionById } from '$lib/server/database/queries/play-sessions.queries';
import type { UserContext } from '$lib/server/types';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { resolveTokenUserAccess } from '$lib/server/auth/resolve-token-user-access';
import { getUserRole } from '$lib/server/utils/playlist-utils';
import { toUserId } from '$lib/shared/user-id';
import { uuidToPlaylistId } from '../playlist-id';
import { toJellyfinId } from '../serializers/user';
import { getDevice, remoteSessionId, type RemoteDeviceRecord } from './device-registry';
import { sendToSession } from './fanout';
import { canControl } from './access';
import {
    outboundMessage,
    toDashedGuid,
    type GeneralCommandData,
    type OutboundMessage,
    type PlayRequestData,
    type PlaystateRequestData,
} from './protocol';

const HEX32 = /^[0-9a-f]{32}$/;
const DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Resolve `sessionId` to a device record the caller may control, or null.
 * Accepts the remote session id `/Sessions` lists for a device, and also the
 * play-session id a playing session from a non-registered device carries
 * (resolved through that play session's user + device).
 */
export async function resolveControllableTarget(
    sql: postgres.Sql,
    rawSessionId: string,
    caller: Pick<UserContext, 'userId' | 'ownerIsAdmin'>,
): Promise<RemoteDeviceRecord | null> {
    const id = rawSessionId.trim().toLowerCase();
    let record: RemoteDeviceRecord | null = null;

    if (HEX32.test(id)) record = await getDevice(id);

    if (!record && (HEX32.test(id) || DASHED.test(id))) {
        const playSession = await getSessionById(sql, toDashedGuid(id));
        if (playSession?.device_id) {
            record = await getDevice(remoteSessionId(playSession.user_id, playSession.device_id));
        }
    }

    if (!record || !canControl(caller, record.userId)) return null;
    return record;
}

/** An account as a UserContext, for item-access checks. Null: gone or disabled. */
export async function userContextFor(
    userId: string,
    username: string,
): Promise<UserContext | null> {
    const access = await resolveTokenUserAccess(username);
    if (!access || access.disabled || access.deleted) return null;
    return {
        userId: toUserId(userId),
        username,
        groups: access.userGroups.join('|'),
        userGroups: access.userGroups,
        ...access.permissions,
        hasLiveTvPermission:
            access.permissions.hasLiveTvPermission && (await userAllowsLiveTv(username)),
    };
}

/** The target device's owner as a UserContext, for item-access checks. */
async function targetUserContext(record: RemoteDeviceRecord): Promise<UserContext | null> {
    return userContextFor(record.userId, record.username);
}

export async function canSeeItem(
    sql: postgres.Sql,
    itemId: string,
    user: UserContext,
): Promise<boolean> {
    const dashed = toDashedGuid(itemId);
    const playlistId = uuidToPlaylistId(dashed);
    if (playlistId !== null) {
        const { role } = await getUserRole(sql, playlistId, user.username, String(user.userId));
        return role !== null;
    }
    return checkMediaAccess(sql, dashed, user);
}

/**
 * Every item must be visible to BOTH the caller and the target's owner:
 * an admin must not make a child's TV play something its age cap hides, and
 * a user must not learn about items they cannot see by casting them.
 */
export async function itemsPlayableBy(
    sql: postgres.Sql,
    itemIds: string[],
    caller: UserContext,
    target: RemoteDeviceRecord,
): Promise<boolean> {
    const owner =
        String(caller.userId).toLowerCase() === target.userId.toLowerCase()
            ? caller
            : await targetUserContext(target);
    if (!owner) return false;
    for (const id of itemIds) {
        if (!(await canSeeItem(sql, id, caller))) return false;
        if (owner !== caller && !(await canSeeItem(sql, id, owner))) return false;
    }
    return true;
}

export const controllingUserId = (caller: Pick<UserContext, 'userId'>): string =>
    toJellyfinId(String(caller.userId)).toLowerCase();

export function playMessage(data: PlayRequestData): OutboundMessage<PlayRequestData> {
    return outboundMessage('Play', data);
}

export function playstateMessage(
    data: PlaystateRequestData,
): OutboundMessage<PlaystateRequestData> {
    return outboundMessage('Playstate', data);
}

export function generalCommandMessage(
    data: GeneralCommandData,
): OutboundMessage<GeneralCommandData> {
    return outboundMessage('GeneralCommand', data);
}

/** Deliver to the target. Jellyfin answers 204 whether or not a socket is open. */
export async function deliver(target: RemoteDeviceRecord, message: OutboundMessage): Promise<void> {
    await sendToSession(target.id, message);
}

/** Legacy Jellyfin remotes can change channels without visiting any LiveTv route. */
export async function liveTvCommandDenial(
    name: string,
    ownerUsername: string,
): Promise<Response | null> {
    if (name !== 'ChannelUp' && name !== 'ChannelDown') return null;
    if (!config.FEATURE_LIVETV) return ApiProblem.notFound();
    const access = await resolveTokenUserAccess(ownerUsername, { freshGroups: true });
    return access &&
        !access.disabled &&
        !access.deleted &&
        access.permissions.hasLiveTvPermission &&
        (await userAllowsLiveTv(ownerUsername))
        ? null
        : ApiProblem.notFound();
}
