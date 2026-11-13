// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin remote apps controlling a native Lumastra device (direction A):
 * the device sessions of the core remote-control registry, seen as Jellyfin
 * sessions, and the `/Sessions/{id}/…` commands that reach them.
 *
 * - A native device (an app that announces `capabilities.commands` in its
 *   heartbeat) lists in `GET /Sessions` under the 32-hex form of its device
 *   session id. Its `SupportedCommands` / `PlayableMediaTypes` are derived from
 *   the announced commands (`native-map.ts`), its `PlayState` / `NowPlayingItem`
 *   from the state it reports (`buildDeviceState`).
 * - A command addressed to such a session becomes a registry command and goes
 *   through `sendDeviceCommand`, with the Jellyfin caller as sender
 *   (source `app`). Ownership follows the existing layer: the owner, or an
 *   administrator; an administrator may only send what the registry allows
 *   administrators (`ui.message`, `playback.stop`).
 *
 * Access here is owner-or-administrator only. The household grant
 * (`device_control_grants`, `/devices/grants`) is a Lumastra-remote feature and
 * does not extend to `/j`: a helper reaches the owner's devices through the
 * device API, not through a Jellyfin app.
 *
 * Errors are shaped as Jellyfin answers: 404 for a session the caller may not
 * see (no existence leak), 400 for a command the device cannot carry out or
 * cannot be reached for, 403 for an administrator going beyond the admin
 * commands, 429/503 for limits and outages.
 */

import type postgres from 'postgres';
import { getMediaType } from '$lib/server/database/queries/media-type-cache.queries.js';
import type { UserContext } from '$lib/server/types';
import {
    DEVICE_COMMANDS,
    type DeviceCommandRequest,
    type DeviceCommandType,
    type DeviceState,
} from '$lib/schemas/device-commands.js';
import {
    buildDeviceState,
    sendDeviceCommand,
    type CommandSender,
    type DeviceCommandError,
} from '$lib/server/services/device-commands.service.js';
import { deviceCommandChecks } from '$lib/server/services/device-command-checks.js';
import { getHeartbeat, getHeartbeats } from '$lib/server/services/device-presence.service.js';
import { sanitizeDisplayName } from '$lib/server/utils/display-name.js';
import { Logger } from '$lib/server/utils/logger.js';
import { uuidToPlaylistId } from '../playlist-id';
import { JELLYFIN_SERVER_ID } from '../constants';
import { toJellyfinId } from '../serializers/user';
import type { JellyfinSessionInfo } from '../types';
import { ApiProblem } from '$lib/server/api/problem.js';
import { userAllowsLiveTv } from '$lib/server/auth/livetv-user-policy.js';
import { config } from '$lib/server/config.js';
import { canControl } from './access';
import { canSeeItem } from './commands';
import {
    announcedCommands,
    generalCommandToRequest,
    jellyfinCapabilityView,
    nowPlayingToItem,
    nowPlayingToPlayState,
    playKindForDbType,
    playRequestToRequests,
    playstateToRequest,
    usableCommands,
    type NativeMapResult,
    type ResolvedItem,
} from './native-map';
import {
    generalCommandItemIds,
    toDashedGuid,
    toWireGuid,
    type GeneralCommandData,
    type PlayCommand,
    type PlaystateCommand,
} from './protocol';

const logger = Logger.for('JellyfinCompat:NativeDevices');

const HEX32 = /^[0-9a-f]{32}$/;
const DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Device sessions one list or lookup considers (a household has a handful). */
const MAX_NATIVE_DEVICES = 500;

type Viewer = Pick<UserContext, 'userId' | 'ownerIsAdmin'>;

/** A native device session a Jellyfin caller may address. */
export interface NativeTarget {
    deviceSessionId: string;
    ownerUserId: string;
    ownerUsername: string;
    ownerDisplayName: string | null;
    /** The client-generated device id (`oauth_refresh_tokens.device_id`), when known. */
    deviceId: string | null;
    deviceName: string | null;
}

interface TokenRow {
    device_session_id: string;
    user_id: string;
    username: string;
    display_name: string | null;
    device_id: string | null;
    device_name: string | null;
}

const toTarget = (r: TokenRow): NativeTarget => ({
    deviceSessionId: r.device_session_id,
    ownerUserId: r.user_id,
    ownerUsername: r.username,
    ownerDisplayName: r.display_name,
    deviceId: r.device_id,
    deviceName: r.device_name,
});

/** The Jellyfin session id of a native device: its device session id without dashes. */
export const nativeSessionId = (deviceSessionId: string): string => toWireGuid(deviceSessionId);

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * The live device sessions a viewer may address: their own, or every user's
 * for an administrator.
 */
async function loadTokenRows(sql: postgres.Sql, viewer: Viewer): Promise<TokenRow[]> {
    const own = viewer.ownerIsAdmin ? null : String(viewer.userId);
    // One row per session (its newest token), the most recently used sessions
    // first, so the cap drops the stalest ones.
    return await sql<TokenRow[]>`
        SELECT latest.device_session_id,
               latest.user_id,
               latest.username,
               latest.display_name,
               latest.device_id,
               latest.device_name
        FROM (
            SELECT DISTINCT ON (t.device_session_id)
                   t.device_session_id,
                   t.user_id::text AS user_id,
                   u.username,
                   u.display_name,
                   t.device_id,
                   t.device_name,
                   GREATEST(t.created_at, COALESCE(t.last_used_at, t.created_at)) AS used_at
            FROM oauth_refresh_tokens t
            JOIN users u ON u.id = t.user_id
            WHERE t.revoked_at IS NULL
              AND t.device_session_id IS NOT NULL
              AND (${own}::uuid IS NULL OR t.user_id = ${own}::uuid)
            ORDER BY t.device_session_id, t.created_at DESC
        ) latest
        ORDER BY latest.used_at DESC
        LIMIT ${MAX_NATIVE_DEVICES}
    `;
}

/**
 * Resolve a Jellyfin session id to a native device the caller may control.
 * Null when it is not a device session, is revoked, or belongs to someone the
 * caller may not control (unknown and not-yours look the same). A database
 * error is also null: the caller then answers 404 rather than guessing.
 */
export async function resolveNativeTarget(
    sql: postgres.Sql,
    rawSessionId: string,
    caller: Pick<UserContext, 'userId' | 'ownerIsAdmin'>,
): Promise<NativeTarget | null> {
    const id = rawSessionId.trim().toLowerCase();
    if (!HEX32.test(id) && !DASHED.test(id)) return null;
    try {
        const rows = await sql<TokenRow[]>`
            SELECT t.device_session_id,
                   t.user_id::text AS user_id,
                   u.username,
                   u.display_name,
                   t.device_id,
                   t.device_name
            FROM oauth_refresh_tokens t
            JOIN users u ON u.id = t.user_id
            WHERE lower(t.device_session_id) = lower(${toDashedGuid(id)})
              AND t.revoked_at IS NULL
            ORDER BY t.created_at DESC
            LIMIT 1
        `;
        const row = rows[0];
        if (!row || !canControl(caller, row.user_id)) return null;
        return toTarget(row);
    } catch (err) {
        logger.warn('Native device lookup failed', { error: String(err) });
        return null;
    }
}

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------

/** One native device for the session list: who, what it can do, what it plays. */
export interface NativeDeviceView {
    target: NativeTarget;
    state: DeviceState;
    /** Commands this viewer may send (admins viewing a foreign device: the admin ones). */
    commands: DeviceCommandType[];
}

/**
 * The native devices the viewer sees: online (heartbeat) and announcing at
 * least one command. Failure-tolerant — a Valkey or database problem leaves
 * the rest of `/Sessions` intact.
 */
export async function listNativeDevices(
    sql: postgres.Sql,
    viewer: Viewer,
): Promise<NativeDeviceView[]> {
    try {
        const rows = await loadTokenRows(sql, viewer);
        // One round of heartbeat lookups; only devices with a live one go on.
        const heartbeats = await getHeartbeats(rows.map((r) => r.device_session_id));
        const views = await Promise.all(
            rows.map(async (row): Promise<NativeDeviceView | null> => {
                const heartbeat = heartbeats.get(row.device_session_id);
                if (!heartbeat) return null;
                const foreign = row.user_id.toLowerCase() !== String(viewer.userId).toLowerCase();
                const commands = usableCommands(
                    announcedCommands(heartbeat.capabilities),
                    foreign && viewer.ownerIsAdmin,
                );
                if (commands.length === 0) return null;
                const state = await buildDeviceState(row.device_session_id, {
                    deviceName: row.device_name,
                });
                return { target: toTarget(row), state, commands };
            }),
        );
        return views.filter((v): v is NativeDeviceView => v !== null);
    } catch (err) {
        logger.warn('Native devices could not be listed', { error: String(err) });
        return [];
    }
}

/** The Jellyfin `SessionInfo` of a native device that no play session already represents. */
export function serializeNativeSession(view: NativeDeviceView): JellyfinSessionInfo {
    const { target, state } = view;
    const capability = jellyfinCapabilityView(view.commands);
    const lastActivity = new Date(state.lastSeen ?? Date.now()).toISOString();
    const np = state.nowPlaying;
    return {
        Id: nativeSessionId(target.deviceSessionId),
        UserId: toJellyfinId(target.ownerUserId),
        UserName: target.ownerDisplayName || target.ownerUsername,
        ServerId: JELLYFIN_SERVER_ID,
        Client: 'Lumastra',
        DeviceName: state.deviceName ?? target.deviceName ?? 'Lumastra device',
        DeviceId: target.deviceId ?? target.deviceSessionId,
        ApplicationVersion: '1.0.0',
        IsActive: true,
        SupportsRemoteControl: capability.controllable,
        SupportsMediaControl: capability.controllable,
        HasCustomDeviceName: false,
        PlayableMediaTypes: capability.playableMediaTypes,
        SupportedCommands: capability.supportedCommands,
        AdditionalUsers: [],
        NowPlayingQueue: [],
        NowPlayingQueueFullItems: [],
        PlayState: nowPlayingToPlayState(np, view.commands),
        LastActivityDate: lastActivity,
        LastPlaybackCheckIn: lastActivity,
        ...(np ? { NowPlayingItem: nowPlayingToItem(np) } : {}),
    };
}

/** What the remote-control overlay needs when a play session already represents the device. */
export function nativeOverlay(view: NativeDeviceView): {
    id: string;
    supportsRemoteControl: boolean;
    playableMediaTypes: string[];
    supportedCommands: string[];
} {
    const capability = jellyfinCapabilityView(view.commands);
    return {
        id: nativeSessionId(view.target.deviceSessionId),
        supportsRemoteControl: capability.controllable,
        playableMediaTypes: capability.playableMediaTypes,
        supportedCommands: capability.supportedCommands,
    };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface NativeCommandContext {
    sql: postgres.Sql;
    target: NativeTarget;
    caller: UserContext;
    /** `event.locals` of the request, for the Live TV / simple-mode checks. */
    locals: Parameters<typeof deviceCommandChecks>[0]['locals'];
}

const noContent = (): Response => new Response(null, { status: 204 });

function problem(status: number, message: string, details?: string, retryAfter?: number): Response {
    return new Response(JSON.stringify({ error: message, ...(details ? { details } : {}) }), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...(retryAfter !== undefined ? { 'Retry-After': String(retryAfter) } : {}),
        },
    });
}

/** Registry error → the HTTP answer a Jellyfin app gets. */
export function nativeErrorResponse(error: DeviceCommandError): Response {
    switch (error.kind) {
        case 'device_unsupported':
        case 'device_unreachable':
            return problem(400, error.message, error.kind);
        case 'invalid':
            return problem(400, error.message);
        case 'stale_target':
        case 'conflict':
            return problem(409, error.message, error.kind);
        case 'simple_mode_locked':
            return problem(403, error.message, error.kind);
        case 'forbidden':
            return problem(403, error.message);
        case 'feature_unavailable':
            return ApiProblem.notFound();
        case 'not_found':
            return problem(404, error.message);
        case 'rate_limited':
            return problem(429, error.message, error.kind, error.retryAfter);
        case 'unavailable':
            return problem(503, error.message);
    }
}

const isForeign = (ctx: NativeCommandContext): boolean =>
    ctx.target.ownerUserId.toLowerCase() !== String(ctx.caller.userId).toLowerCase();

function senderFor(ctx: NativeCommandContext): CommandSender {
    return {
        userId: String(ctx.caller.userId),
        username: ctx.caller.username,
        source: 'app',
        ...(isForeign(ctx) ? { admin: true } : {}),
    };
}

/** The Jellyfin device name of the caller, shown next to a message on the target. */
function callerDeviceName(locals: NativeCommandContext['locals']): string | undefined {
    const raw = (locals as { jfDevice?: { deviceName?: string | null } }).jfDevice?.deviceName;
    const clean = raw ? sanitizeDisplayName(raw, 64) : '';
    return clean || undefined;
}

/**
 * Send one registry command to the target. An administrator who is not the
 * owner may only send the admin commands (403 before anything is looked up).
 */
async function dispatch(
    ctx: NativeCommandContext,
    request: DeviceCommandRequest,
): Promise<Response> {
    if (
        request.type.startsWith('livetv.') &&
        (!config.FEATURE_LIVETV || !(await userAllowsLiveTv(ctx.target.ownerUsername)))
    )
        return ApiProblem.notFound();
    const foreign = isForeign(ctx);
    if (foreign && !(DEVICE_COMMANDS[request.type] as { admin?: boolean }).admin) {
        return problem(403, `Administrators cannot send ${request.type}`);
    }
    const deviceName = callerDeviceName(ctx.locals);
    const sender: CommandSender = {
        ...senderFor(ctx),
        ...(deviceName ? { deviceName } : {}),
    };
    const result = await sendDeviceCommand({
        deviceSessionId: ctx.target.deviceSessionId,
        ownerUserId: ctx.target.ownerUserId,
        request,
        sender,
        ...(foreign
            ? {}
            : {
                  checks: deviceCommandChecks({
                      sql: ctx.sql,
                      userId: ctx.caller.userId,
                      hasLiveTvPermission: Boolean(ctx.caller.hasLiveTvPermission),
                      locals: ctx.locals,
                  }),
              }),
    });
    return result.ok ? noContent() : nativeErrorResponse(result.error);
}

function mapped(ctx: NativeCommandContext, result: NativeMapResult): Promise<Response> | Response {
    if (!result.ok) {
        return result.reason === 'unsupported'
            ? problem(400, result.message, 'device_unsupported')
            : problem(400, result.message);
    }
    return dispatch(ctx, result.request);
}

/**
 * Resolve wire item ids to registry ids and kinds. `'forbidden'`: the caller is
 * an administrator beyond the admin commands; `'not_found'`: an item the
 * caller cannot see or that does not exist; `'unsupported'`: a kind a device
 * cannot play (a season, a book).
 */
async function resolveItems(
    ctx: NativeCommandContext,
    wireIds: string[],
): Promise<ResolvedItem[] | 'forbidden' | 'not_found' | 'unsupported'> {
    // Item-carrying commands are never admin commands: refuse before any lookup.
    if (isForeign(ctx)) return 'forbidden';
    const items: ResolvedItem[] = [];
    for (const wire of wireIds) {
        if (!(await canSeeItem(ctx.sql, wire, ctx.caller))) return 'not_found';
        const dashed = toDashedGuid(wire);
        const playlist = uuidToPlaylistId(dashed);
        if (playlist !== null) {
            items.push({ id: String(playlist), kind: 'playlist' });
            continue;
        }
        const dbType = await getMediaType(ctx.sql, dashed);
        if (dbType === null) return 'not_found';
        const kind = playKindForDbType(dbType);
        if (kind === null) return 'unsupported';
        items.push({ id: dashed, kind });
    }
    return items;
}

function itemFailure(result: 'forbidden' | 'not_found' | 'unsupported'): Response {
    if (result === 'forbidden') return problem(403, 'Administrators cannot send this command');
    if (result === 'not_found') return problem(404, 'Item not found');
    return problem(400, 'This kind of item cannot be played on this device', 'device_unsupported');
}

/** `POST /Sessions/{id}/Playing/{command}`. */
export async function nativePlaystate(
    ctx: NativeCommandContext,
    command: PlaystateCommand,
    seekPositionTicks: number | undefined,
): Promise<Response> {
    return mapped(ctx, playstateToRequest(command, seekPositionTicks));
}

/** `POST /Sessions/{id}/Command[/{name}]` and `/Message` (a DisplayMessage command). */
export async function nativeGeneralCommand(
    ctx: NativeCommandContext,
    command: GeneralCommandData,
): Promise<Response> {
    const wireIds = generalCommandItemIds(command);
    if (wireIds === null) return problem(400, 'Arguments.ItemId(s) must be 1 to 500 item ids');
    let items: ResolvedItem[] = [];
    if (wireIds.length > 0) {
        const resolved = await resolveItems(ctx, wireIds);
        if (typeof resolved === 'string') return itemFailure(resolved);
        items = resolved;
    }
    return mapped(ctx, generalCommandToRequest(command, items));
}

/**
 * `POST /Sessions/{id}/Playing` — a Play request. PlayNow of several items is
 * `media.play` of the one at StartIndex plus `queue.add` of the tracks after it
 * (see `playRequestToRequests`); the queue part is only attempted when the
 * device announces `queue.add`, so nothing starts and then fails half-way.
 */
export async function nativePlay(
    ctx: NativeCommandContext,
    input: {
        playCommand: PlayCommand;
        itemIds: string[];
        startIndex?: number;
        startPositionTicks?: number;
    },
): Promise<Response> {
    const queueOnly = input.playCommand === 'PlayNext' || input.playCommand === 'PlayLast';
    if (!queueOnly && (input.startIndex ?? 0) >= input.itemIds.length) {
        return problem(400, 'startIndex is outside itemIds');
    }
    const resolved = await resolveItems(ctx, input.itemIds);
    if (typeof resolved === 'string') return itemFailure(resolved);
    const plan = playRequestToRequests({
        playCommand: input.playCommand,
        items: resolved,
        ...(input.startIndex !== undefined ? { startIndex: input.startIndex } : {}),
        ...(input.startPositionTicks !== undefined
            ? { startPositionTicks: input.startPositionTicks }
            : {}),
    });
    if (!plan.ok) {
        return plan.reason === 'unsupported'
            ? problem(400, plan.message, 'device_unsupported')
            : problem(400, plan.message);
    }
    if (plan.requests.length > 1) {
        const heartbeat = await getHeartbeat(ctx.target.deviceSessionId).catch(() => null);
        if (!announcedCommands(heartbeat?.capabilities).includes('queue.add')) {
            return problem(
                400,
                'This device cannot queue the rest of the list',
                'device_unsupported',
            );
        }
    }
    for (const request of plan.requests) {
        const response = await dispatch(ctx, request);
        if (!response.ok) return response;
    }
    return noContent();
}
