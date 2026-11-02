// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * device-commands.service.ts — remote control of a user's devices.
 *
 * One command API for every device and every kind of playback; see
 * docs/superpowers/specs/2026-10-16-device-remote-control-design.md and the
 * vocabulary in `$lib/schemas/device-commands.ts`.
 *
 * Storage (Valkey, all keyed under `devcmd:v1:`):
 *   - `cmd:<id>`                the command record (TTL: expiry + 5 min)
 *   - `inbox:<deviceSessionId>` set of ids the device has not finished with
 *   - `idem:<userId>:<key>`     Idempotency-Key → command id + request hash (24 h)
 *   - `state:<deviceSessionId>` the state the device last reported (90 s)
 *   - `caps:<deviceSessionId>`  the capabilities it last announced (30 days),
 *                               so a device whose heartbeat lapsed is still checked
 *
 * Status changes are compare-and-set (one Lua script): a device's result, the
 * sender's cancel, a supersede and an expiry can race, and only the change from
 * the status it was read in wins.
 *
 * Delivery: the command goes out as SSE `device.command` to the target
 * device's own stream only (never replayed); the device also reads its inbox
 * on (re)connect. Every status change goes to the owner's account (and an
 * admin sender) as `device.command_status`; reported state as `device.state`.
 * Neither is replayed either: both are recoverable with a GET.
 *
 * Access is the caller's job (`verifyDeviceControlAccess` in the def): this
 * module trusts that the target device belongs to `ownerUserId`.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Logger } from '$lib/server/utils/logger.js';
import {
    connectValkey,
    isCoordinationValkeyReady,
    getCoordinationClient,
    setEx,
    setIfNotExists,
    cacheGetOrThrow,
    cacheDel,
    sAdd,
    sCard,
    sMembers,
    sRem,
    expire,
} from '$lib/server/cache/valkey.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { onDeviceSessionsRevoked } from '$lib/server/oauth/device-session-liveness.js';
import { publishUserEvent } from '$lib/server/services/notification-events.service.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    listDeviceSessionIdsOfUser,
    listGrantsByOwner,
} from '$lib/server/database/queries/device-control-grants.queries.js';
import {
    DEVICE_ONLINE_KEY,
    DEVICE_STREAM_KEY,
    getHeartbeat,
    isDeviceStreamOpen,
} from '$lib/server/services/device-presence.service.js';
import {
    ADMIN_UI_MESSAGE_TTL_SECONDS,
    DEVICE_COMMANDS,
    FINAL_COMMAND_STATUSES,
    QUEUE_REVISION_REQUIRED,
    type DeviceCommand,
    type DeviceCommandRequest,
    type DeviceCommandSource,
    type DeviceCommandStatus,
    type DeviceCommandType,
    type DeviceCapabilities,
    type DeviceNowPlaying,
    type DeviceState,
    type DeviceStateReport,
} from '$lib/schemas/device-commands.js';

const logger = Logger.for('DeviceCommands');

// A signed-out or revoked device drops its commands, state and presence.
onDeviceSessionsRevoked((ids) => {
    for (const id of ids) void forgetDevice(id);
});

const PREFIX = 'devcmd:v1';
const commandKey = (id: string): string => `${PREFIX}:cmd:${id}`;
const inboxKey = (deviceSessionId: string): string => `${PREFIX}:inbox:${deviceSessionId}`;
const idemKey = (userId: string, key: string): string => `${PREFIX}:idem:${userId}:${key}`;
const stateKey = (deviceSessionId: string): string => `${PREFIX}:state:${deviceSessionId}`;
const capsKey = (deviceSessionId: string): string => `${PREFIX}:caps:${deviceSessionId}`;
const revisionKey = (deviceSessionId: string): string => `${PREFIX}:rev:${deviceSessionId}`;

/** How long a finished command stays readable for its sender. */
const RECORD_GRACE_SECONDS = 5 * 60;
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
/** A reported state older than this is dropped (the device reports every 10 s). */
export const STATE_TTL_SECONDS = 90;
/** How long announced capabilities are remembered for an offline device. */
const CAPABILITIES_TTL_SECONDS = 30 * 24 * 60 * 60;
/** How far ahead a command may be scheduled. */
const MAX_SCHEDULE_AHEAD_MS = 24 * 60 * 60 * 1000;
/** A scheduled command may still run this long after its time (a device waking up late). */
const SCHEDULE_GRACE_SECONDS = 120;
/** Commands waiting for one device at most (the old queue held 5). */
export const INBOX_LIMIT = 50;

const RATE_LIMIT = { limit: 20, windowSeconds: 10 };
const MESSAGE_RATE_LIMIT = { limit: 10, windowSeconds: 60 };
const STATE_RATE_LIMIT = { limit: 30, windowSeconds: 10 };

/** The record as stored: the public command plus who owns the target device and who sent it. */
interface StoredCommand extends DeviceCommand {
    ownerUserId: string;
    /** Set when the sender is not the owner (an administrator): they hear the status too. */
    senderUserId?: string;
}

export interface CommandSender {
    userId: string;
    username: string;
    source: DeviceCommandSource;
    /** The sending device, when the credential is a device JWT. */
    deviceSessionId?: string;
    deviceName?: string;
    admin?: boolean;
}

export type DeviceCommandErrorKind =
    | 'device_unsupported'
    | 'device_unreachable'
    | 'stale_target'
    | 'simple_mode_locked'
    | 'rate_limited'
    | 'forbidden'
    | 'not_found'
    | 'feature_unavailable'
    | 'invalid'
    | 'conflict'
    | 'unavailable';

export interface DeviceCommandError {
    kind: DeviceCommandErrorKind;
    message: string;
    retryAfter?: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: DeviceCommandError };

const fail = <T>(
    kind: DeviceCommandErrorKind,
    message: string,
    retryAfter?: number,
): Result<T> => ({
    ok: false,
    error: { kind, message, ...(retryAfter !== undefined ? { retryAfter } : {}) },
});

/**
 * Extra, type-specific checks the def supplies (they need request context the
 * service should not know about: Live TV permission, the lineup, Watch Together
 * membership, the simple-mode record).
 */
export interface SendChecks {
    /** Rejects with a problem kind + message, or null to allow. */
    check?: (request: DeviceCommandRequest) => Promise<DeviceCommandError | null>;
}

function toPublic(stored: StoredCommand): DeviceCommand {
    const { ownerUserId: _owner, senderUserId: _sender, ...pub } = stored;
    return pub;
}

async function readCommand(id: string): Promise<StoredCommand | null> {
    const raw = await cacheGetOrThrow(commandKey(id));
    if (!raw) return null;
    try {
        return JSON.parse(raw) as StoredCommand;
    } catch {
        logger.warn('Unreadable device command record', { id });
        return null;
    }
}

function recordTtl(cmd: StoredCommand): number {
    return Math.max(
        60,
        Math.ceil((Date.parse(cmd.expiresAt) - Date.now()) / 1000) + RECORD_GRACE_SECONDS,
    );
}

async function writeCommand(cmd: StoredCommand): Promise<void> {
    const stored = await setEx(commandKey(cmd.id), recordTtl(cmd), JSON.stringify(cmd));
    if (!stored) throw new Error('Valkey write failed');
}

/**
 * SET the record only while its stored status is one of ARGV[3..]. Returns 1
 * when written, 0 when the status moved on (or the record is gone).
 */
const CAS_STATUS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local ok, obj = pcall(cjson.decode, cur)
if not ok or type(obj) ~= 'table' then return 0 end
for i = 3, #ARGV do
  if obj['status'] == ARGV[i] then
    redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
    return 1
  end
end
return 0`;

async function compareAndSetStatus(
    next: StoredCommand,
    fromStatuses: readonly DeviceCommandStatus[],
): Promise<boolean> {
    const client = getCoordinationClient();
    if (!client) throw new Error('Valkey client not available');
    const result = await client.customCommand([
        'EVAL',
        CAS_STATUS_SCRIPT,
        '1',
        commandKey(next.id),
        JSON.stringify(next),
        String(recordTtl(next)),
        ...fromStatuses,
    ]);
    return Number(result) === 1;
}

async function publishStatus(cmd: StoredCommand): Promise<void> {
    const recipients = new Set([cmd.ownerUserId, ...(cmd.senderUserId ? [cmd.senderUserId] : [])]);
    for (const userId of recipients) {
        await publishUserEvent({
            userId,
            kind: 'device.command_status',
            data: toPublic(cmd),
            persist: false,
            replay: false,
        }).catch(() => {
            /* best effort: the owner can GET the command */
        });
    }
}

async function publishToDevice(
    cmd: StoredCommand,
    kind: 'device.command' | 'device.command_cancelled',
): Promise<void> {
    await publishUserEvent({
        userId: cmd.ownerUserId,
        targetDeviceSessionId: cmd.deviceSessionId,
        kind,
        data: kind === 'device.command' ? toPublic(cmd) : { id: cmd.id },
        persist: false,
    }).catch(() => {
        /* best effort: the device reads its inbox on reconnect */
    });
}

/**
 * Moves a command from the status it was read in to `status` (compare-and-set)
 * and tells the account. Null when someone else changed it first.
 */
async function transition(
    cmd: StoredCommand,
    status: DeviceCommandStatus,
    extra: { reason?: string; actionId?: string } = {},
): Promise<StoredCommand | null> {
    const next: StoredCommand = {
        ...cmd,
        status,
        ...(extra.reason ? { reason: extra.reason } : {}),
        ...(extra.actionId ? { actionId: extra.actionId } : {}),
        updatedAt: new Date().toISOString(),
    };
    if (!(await compareAndSetStatus(next, [cmd.status]))) return null;
    if (FINAL_COMMAND_STATUSES.has(status) || status === 'applied') {
        // An applied ui.message with buttons still waits for its acknowledgement,
        // but it is no longer the device's to-do: the device keeps the dialog.
        await sRem(inboxKey(cmd.deviceSessionId), cmd.id);
    }
    await publishStatus(next);
    return next;
}

function isExpired(cmd: StoredCommand, now = Date.now()): boolean {
    return Date.parse(cmd.expiresAt) <= now;
}

/** When a command is due: its schedule, else its creation. */
function dueAt(cmd: DeviceCommand): string {
    return cmd.notBefore ?? cmd.createdAt;
}

/**
 * Everything still on the device's to-do list, expiring stale ones on the way.
 * A live command the device already received is not handed out again: after a
 * reconnect a second `seekBy` or `channelUp` would be wrong.
 */
async function readInbox(
    deviceSessionId: string,
    opts: { forDevice?: boolean } = {},
): Promise<StoredCommand[]> {
    const ids = await sMembers(inboxKey(deviceSessionId));
    const records = await Promise.all(ids.map((id) => readCommand(id)));
    const out: StoredCommand[] = [];
    for (const [i, cmd] of records.entries()) {
        if (!cmd || (cmd.status !== 'pending' && cmd.status !== 'delivered')) {
            await sRem(inboxKey(deviceSessionId), ids[i]);
            continue;
        }
        if (isExpired(cmd)) {
            await transition(cmd, 'expired');
            continue;
        }
        if (opts.forDevice && cmd.delivery === 'live' && cmd.status === 'delivered') continue;
        out.push(cmd);
    }
    return out.sort((a, b) => dueAt(a).localeCompare(dueAt(b)));
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Remembers what the device announced (called from the heartbeat). */
export async function rememberCapabilities(
    deviceSessionId: string,
    capabilities: DeviceCapabilities,
): Promise<void> {
    await setEx(capsKey(deviceSessionId), CAPABILITIES_TTL_SECONDS, JSON.stringify(capabilities));
}

/** The capabilities from the live heartbeat, else the last ones announced. */
async function knownCapabilities(deviceSessionId: string): Promise<DeviceCapabilities | null> {
    const heartbeat = await getHeartbeat(deviceSessionId);
    if (heartbeat?.capabilities) return heartbeat.capabilities;
    const raw = await cacheGetOrThrow(capsKey(deviceSessionId)).catch(() => null);
    if (!raw) return heartbeat ? { commands: {} } : null;
    try {
        return JSON.parse(raw) as DeviceCapabilities;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface StoredState {
    report: DeviceStateReport;
    observedAt: string;
    revision: number;
}

/**
 * The device reports `durationSeconds`; the served state carries `durationMs`.
 * The stored report keeps the device's own shape, so convert on the way out.
 */
function toServedNowPlaying(np: NonNullable<DeviceStateReport['nowPlaying']>): DeviceNowPlaying {
    const { durationSeconds, ...rest } = np;
    return durationSeconds === undefined
        ? rest
        : { ...rest, durationMs: Math.round(durationSeconds * 1000) };
}

async function readStoredState(deviceSessionId: string): Promise<StoredState | null> {
    const raw = await cacheGetOrThrow(stateKey(deviceSessionId));
    if (!raw) return null;
    try {
        return JSON.parse(raw) as StoredState;
    } catch {
        return null;
    }
}

/** A device reports its own state; the account gets it as `device.state`. */
export async function reportDeviceState(
    ownerUserId: string,
    deviceSessionId: string,
    report: DeviceStateReport,
): Promise<Result<StoredState>> {
    const rl = await checkRateLimit(
        `devstate:${deviceSessionId}`,
        STATE_RATE_LIMIT.limit,
        STATE_RATE_LIMIT.windowSeconds,
    );
    if (!rl.allowed) {
        return fail(
            'rate_limited',
            'Too many state reports',
            Math.max(1, rl.resetAt - Math.floor(Date.now() / 1000)),
        );
    }
    const observedAt = new Date().toISOString();
    // Atomic and monotonic per device, also across the state's 90 s expiry.
    const revision = await nextStateRevision(deviceSessionId);
    if (revision === null) return fail('unavailable', 'Failed to store the state');
    const nowPlaying = report.nowPlaying
        ? { ...report.nowPlaying, observedAt, reported: true }
        : report.nowPlaying;
    const stored: StoredState = { report: { ...report, nowPlaying }, observedAt, revision };
    if (!(await setEx(stateKey(deviceSessionId), STATE_TTL_SECONDS, JSON.stringify(stored)))) {
        return fail('unavailable', 'Failed to store the state');
    }
    const state = await buildDeviceState(deviceSessionId, { stored });
    const publishState = (userId: string): void => {
        void publishUserEvent({
            userId,
            kind: 'device.state',
            data: state,
            persist: false,
            replay: false,
        }).catch(() => {
            /* best effort */
        });
    };
    publishState(ownerUserId);
    // The helpers follow in the background: a TV reports every few seconds, and
    // the grant lookup (a database read on a cache miss) must not delay the 204.
    void helpersOf(ownerUserId)
        .then((ids) => ids.forEach(publishState))
        .catch(() => {
            /* helpersOf fails closed; nothing to follow */
        });
    return { ok: true, value: stored };
}

/**
 * The users the owner granted control (household grant) also follow the
 * device's state live. Cached briefly per process: a TV reports every few
 * seconds. A grant change on THIS replica clears the entry at once
 * ({@link invalidateHelpersCache}); another replica's cache lapses within the TTL.
 */
const HELPERS_TTL_MS = 10_000;
const helpersCache = new Map<string, { at: number; ids: string[] }>();
/** Bumped by every invalidation: a lookup that started before it must not be cached. */
let helpersEpoch = 0;

/** Forget the cached helpers of `ownerUserId` (a grant was added or removed). */
export function invalidateHelpersCache(ownerUserId: string): void {
    helpersEpoch += 1;
    helpersCache.delete(ownerUserId);
}

async function helpersOf(ownerUserId: string): Promise<string[]> {
    const hit = helpersCache.get(ownerUserId);
    if (hit && Date.now() - hit.at < HELPERS_TTL_MS) return hit.ids;
    const epoch = helpersEpoch;
    let ids: string[];
    try {
        const sql = getDb();
        if (!sql) return [];
        const rows = await listGrantsByOwner.all(sql, { ownerUserId });
        ids = rows.map((r) => r.user_id);
    } catch {
        // Fail closed: an expired list may hold a revoked helper.
        return [];
    }
    if (epoch === helpersEpoch) {
        if (helpersCache.size > 5000) helpersCache.clear();
        helpersCache.set(ownerUserId, { at: Date.now(), ids });
    }
    return ids;
}

/** A counter that only grows (30-day TTL, refreshed on every report). */
async function nextStateRevision(deviceSessionId: string): Promise<number | null> {
    const client = getCoordinationClient();
    if (!client) return null;
    try {
        const revision = Number(await client.incr(revisionKey(deviceSessionId)));
        await expire(revisionKey(deviceSessionId), CAPABILITIES_TTL_SECONDS);
        return Number.isFinite(revision) ? revision : null;
    } catch (err) {
        logger.warn('State revision INCR failed', { error: String(err) });
        return null;
    }
}

async function currentStateRevision(deviceSessionId: string): Promise<number> {
    const raw = await cacheGetOrThrow(revisionKey(deviceSessionId)).catch(() => null);
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) ? n : 0;
}

export interface StateFallbackSources {
    /** Server-side guess at what the device plays when it does not report. */
    project?: () => Promise<DeviceNowPlaying | null>;
}

/** The state a remote shows: the device's own report, else a server projection. */
export async function buildDeviceState(
    deviceSessionId: string,
    opts: {
        stored?: StoredState | null;
        deviceName?: string | null;
        fallback?: StateFallbackSources;
    } = {},
): Promise<DeviceState> {
    const [heartbeat, reachable, stored, counter] = await Promise.all([
        getHeartbeat(deviceSessionId).catch(() => null),
        isDeviceStreamOpen(deviceSessionId).catch(() => false),
        opts.stored !== undefined
            ? Promise.resolve(opts.stored)
            : readStoredState(deviceSessionId).catch(() => null),
        currentStateRevision(deviceSessionId),
    ]);
    let nowPlaying: DeviceNowPlaying | null = stored?.report.nowPlaying
        ? toServedNowPlaying(stored.report.nowPlaying)
        : null;
    if (!stored && opts.fallback?.project) {
        nowPlaying = await opts.fallback.project().catch(() => null);
    }
    const capabilities: DeviceCapabilities = heartbeat?.capabilities ?? { commands: {} };
    const liveTvMode = stored?.report.liveTvMode ?? capabilities.liveTvMode;
    return {
        deviceSessionId,
        deviceName: heartbeat?.deviceName ?? opts.deviceName ?? null,
        deviceType: heartbeat?.deviceType ?? 'unknown',
        online: heartbeat !== null,
        lastSeen: heartbeat ? new Date(heartbeat.lastSeen).toISOString() : null,
        reachable,
        capabilities,
        nowPlaying,
        ...(liveTvMode ? { liveTvMode } : {}),
        textInput: stored?.report.textInput ?? null,
        party: stored?.report.party ?? null,
        // Never behind the last report: a remote that saw revision N must not
        // drop this answer once the report itself expired.
        revision: Math.max(stored?.revision ?? 0, counter),
    };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendInput {
    deviceSessionId: string;
    ownerUserId: string;
    request: DeviceCommandRequest;
    sender: CommandSender;
    idempotencyKey?: string;
    checks?: SendChecks;
}

interface IdempotencyEntry {
    commandId: string;
    requestHash: string;
    /** The command as first answered: returned when its record has expired. */
    command: DeviceCommand | null;
    /** Claimed by a request that has not finished yet (no command to answer with). */
    inFlight?: true;
}

function requestHash(deviceSessionId: string, request: DeviceCommandRequest): string {
    return createHash('sha256')
        .update(JSON.stringify([deviceSessionId, request]))
        .digest('hex')
        .slice(0, 32);
}

async function readIdempotency(key: string): Promise<IdempotencyEntry | null> {
    const raw = await cacheGetOrThrow(key);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as IdempotencyEntry;
    } catch {
        return null;
    }
}

/**
 * A repeat of an Idempotency-Key: the first command when the request is the
 * same, a conflict when it is not. Null when the key is free (never used, or
 * its command is gone and the key can be taken again).
 */
async function idempotentReplay(
    key: string,
    hash: string,
    deviceSessionId: string,
): Promise<Result<{ command: DeviceCommand; replayed: boolean }> | null> {
    const entry = await readIdempotency(key);
    if (!entry) return null;
    if (entry.requestHash !== hash) {
        return fail('conflict', 'This Idempotency-Key was used for a different command');
    }
    if (entry.inFlight || !entry.command) {
        return fail('conflict', 'A command with this Idempotency-Key is in flight');
    }
    if (entry.command.deviceSessionId !== deviceSessionId) {
        return fail('conflict', 'This Idempotency-Key was used for another device');
    }
    const existing = await readCommand(entry.commandId);
    return {
        ok: true,
        value: { command: existing ? toPublic(existing) : entry.command, replayed: true },
    };
}

/** How long a claim without a result holds the key (the send itself is quick). */
const IDEMPOTENCY_CLAIM_SECONDS = 30;

export interface IdempotencyClaim {
    /** The command went out: keep the key for 24 h, answering with it. */
    commit(command: DeviceCommand): Promise<void>;
    /** The send failed: free the key so a retry can run. */
    release(): Promise<void>;
}

/**
 * Idempotency for a send that does not go through {@link sendDeviceCommand}
 * (an external provider such as a Jellyfin client). Same keys, same 24 h, same
 * semantics: a repeat of the same request returns the first command
 * (`replay`), a different request or device is a conflict, a repeat that
 * arrives while the first is still running is a conflict too. Otherwise the
 * caller holds a `claim`, and must `commit` or `release` it.
 */
export async function beginIdempotentSend(input: {
    userId: string;
    key: string;
    deviceSessionId: string;
    request: DeviceCommandRequest;
}): Promise<
    Result<{ replay: { command: DeviceCommand; replayed: true } } | { claim: IdempotencyClaim }>
> {
    await connectValkey();
    if (!isCoordinationValkeyReady()) return fail('unavailable', 'Cache service unavailable');
    const idem = idemKey(input.userId, input.key);
    const hash = requestHash(input.deviceSessionId, input.request);
    const replay = await idempotentReplay(idem, hash, input.deviceSessionId);
    if (replay) {
        return replay.ok
            ? { ok: true, value: { replay: { ...replay.value, replayed: true } } }
            : replay;
    }
    const placeholder: IdempotencyEntry = {
        commandId: '',
        requestHash: hash,
        command: null,
        inFlight: true,
    };
    if (!(await setIfNotExists(idem, JSON.stringify(placeholder), IDEMPOTENCY_CLAIM_SECONDS))) {
        const winner = await idempotentReplay(idem, hash, input.deviceSessionId);
        if (winner) {
            return winner.ok
                ? { ok: true, value: { replay: { ...winner.value, replayed: true } } }
                : winner;
        }
        return fail('conflict', 'A command with this Idempotency-Key is in flight');
    }
    return {
        ok: true,
        value: {
            claim: {
                commit: async (command) => {
                    const entry: IdempotencyEntry = {
                        commandId: command.id,
                        requestHash: hash,
                        command,
                    };
                    await setEx(idem, IDEMPOTENCY_TTL_SECONDS, JSON.stringify(entry));
                },
                release: async () => {
                    await cacheDel(idem).catch(() => 0);
                },
            },
        },
    };
}

/**
 * Validates and queues a command, delivers it to the device's stream and
 * returns it. `replayed: true` = an Idempotency-Key repeat (nothing was sent).
 */
export async function sendDeviceCommand(
    input: SendInput,
): Promise<Result<{ command: DeviceCommand; replayed: boolean }>> {
    const { deviceSessionId, ownerUserId, request, sender } = input;
    const spec = DEVICE_COMMANDS[request.type];
    if (!spec) return fail('invalid', `Unknown command type ${String(request.type)}`);

    await connectValkey();
    if (!isCoordinationValkeyReady()) return fail('unavailable', 'Cache service unavailable');

    if (sender.admin && !(spec as { admin?: boolean }).admin) {
        return fail('forbidden', `Administrators cannot send ${request.type}`);
    }
    if (sender.deviceSessionId && sender.deviceSessionId === deviceSessionId) {
        return fail('invalid', 'A device cannot send a command to itself');
    }

    // Schedule.
    let notBeforeMs: number | null = null;
    if (request.notBefore !== undefined) {
        notBeforeMs = Date.parse(request.notBefore);
        if (!Number.isFinite(notBeforeMs)) return fail('invalid', 'notBefore is not a date');
        if (notBeforeMs - Date.now() > MAX_SCHEDULE_AHEAD_MS) {
            return fail('invalid', 'notBefore may be at most 24 hours ahead');
        }
        if (notBeforeMs <= Date.now()) notBeforeMs = null;
    }
    if (QUEUE_REVISION_REQUIRED.has(request.type) && request.expect?.queueRevision === undefined) {
        return fail('invalid', `${request.type} needs expect.queueRevision`);
    }

    // Idempotency: a repeat returns the first command unchanged.
    const idem = input.idempotencyKey ? idemKey(sender.userId, input.idempotencyKey) : null;
    const hash = requestHash(deviceSessionId, request);
    if (idem) {
        const replay = await idempotentReplay(idem, hash, deviceSessionId);
        if (replay) return replay;
    }

    // Rate limits per sender + device, and per sender for messages.
    const rl = await checkRateLimit(
        `devcmd:${sender.userId}:${deviceSessionId}`,
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
            `devcmd:msg:${sender.userId}`,
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

    // Capability (live heartbeat, else the last announcement) + reachability.
    const capabilities = await knownCapabilities(deviceSessionId);
    if (
        capabilities &&
        !Object.prototype.hasOwnProperty.call(capabilities.commands, request.type)
    ) {
        return fail('device_unsupported', `This device cannot carry out ${request.type}`);
    }
    const waits = spec.delivery === 'queued' || notBeforeMs !== null;
    if (!waits && !(await isDeviceStreamOpen(deviceSessionId))) {
        return fail('device_unreachable', 'The device is not connected right now');
    }

    // Precondition against what the device last reported. Without a report the
    // device is the judge: it checks `expect` again before it applies anything.
    if (request.expect?.sessionId !== undefined || request.expect?.queueRevision !== undefined) {
        const stored = await readStoredState(deviceSessionId).catch(() => null);
        const np = stored?.report.nowPlaying ?? null;
        if (stored) {
            if (
                request.expect.sessionId !== undefined &&
                np?.sessionId !== request.expect.sessionId
            ) {
                return fail('stale_target', 'The device is playing something else now');
            }
            if (
                request.expect.queueRevision !== undefined &&
                np?.music?.queue?.revision !== request.expect.queueRevision
            ) {
                return fail('stale_target', 'The queue changed');
            }
        }
    }

    const typeCheck = await input.checks?.check?.(request);
    if (typeCheck) return { ok: false, error: typeCheck };

    if ((await sCard(inboxKey(deviceSessionId))) >= INBOX_LIMIT) {
        return fail('rate_limited', 'Too many commands are waiting for this device', 60);
    }

    // Build.
    const now = Date.now();
    const ttl =
        (request.type === 'ui.message' && sender.admin
            ? ADMIN_UI_MESSAGE_TTL_SECONDS
            : spec.ttlSeconds) + (notBeforeMs !== null ? SCHEDULE_GRACE_SECONDS : 0);
    const startsAt = notBeforeMs ?? now;
    const command: StoredCommand = {
        id: `cmd_${randomUUID()}`,
        deviceSessionId,
        ownerUserId,
        ...(sender.userId !== ownerUserId ? { senderUserId: sender.userId } : {}),
        type: request.type,
        args: parseArgs(request.type, request.args),
        ...(request.expect ? { expect: request.expect } : {}),
        ...(notBeforeMs !== null ? { notBefore: new Date(notBeforeMs).toISOString() } : {}),
        delivery: waits ? 'queued' : 'live',
        source: sender.source,
        sender: {
            username: sender.username,
            ...(sender.deviceSessionId ? { deviceSessionId: sender.deviceSessionId } : {}),
            ...(sender.deviceName ? { deviceName: sender.deviceName } : {}),
            ...(sender.admin ? { admin: true } : {}),
        },
        status: 'pending',
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        expiresAt: new Date(startsAt + ttl * 1000).toISOString(),
    };

    if (idem) {
        const entry: IdempotencyEntry = {
            commandId: command.id,
            requestHash: hash,
            command: toPublic(command),
        };
        if (!(await setIfNotExists(idem, JSON.stringify(entry), IDEMPOTENCY_TTL_SECONDS))) {
            // A concurrent request with the same key won: answer with its command.
            const winner = await idempotentReplay(idem, hash, deviceSessionId);
            return winner ?? fail('conflict', 'A command with this Idempotency-Key is in flight');
        }
    }

    try {
        await writeCommand(command);
        // sAdd swallows Valkey errors into 0; a new member must answer 1.
        if ((await sAdd(inboxKey(deviceSessionId), command.id)) !== 1) {
            await cacheDel(commandKey(command.id)).catch(() => 0);
            throw new Error('Inbox write failed');
        }
        // The set outlives its longest member (a schedule up to 24 h + lifetime).
        await expire(inboxKey(deviceSessionId), recordTtl(command) + 60);
    } catch (err) {
        logger.error('Failed to store device command', err as Error, { type: request.type });
        if (idem) await cacheDel(idem).catch(() => 0);
        return fail('unavailable', 'Failed to store the command');
    }

    // Supersede older pending ones of the same type for this device, after the
    // new one is safely stored (a failed write must not lose both).
    if ((spec as { supersede?: boolean }).supersede) {
        for (const old of await readInbox(deviceSessionId)) {
            // Only OLDER ones: two concurrent sends must not supersede each other.
            if (old.id === command.id || old.type !== request.type) continue;
            if (`${old.createdAt}|${old.id}` > `${command.createdAt}|${command.id}`) continue;
            const superseded = await transition(old, 'superseded');
            if (superseded) await publishToDevice(superseded, 'device.command_cancelled');
        }
    }

    await publishToDevice(command, 'device.command');
    logger.info('Device command sent', {
        type: command.type,
        source: command.source,
        target: deviceSessionId.substring(0, 8) + '...',
        delivery: command.delivery,
    });
    return { ok: true, value: { command: toPublic(command), replayed: false } };
}

/** Applies the type's schema defaults; the request union already validated. */
function parseArgs(
    type: DeviceCommandType,
    args: Record<string, unknown> | undefined,
): Record<string, unknown> {
    const parsed = DEVICE_COMMANDS[type].args.safeParse(args ?? {});
    return parsed.success ? parsed.data : (args ?? {});
}

// ---------------------------------------------------------------------------
// Sender side: read, cancel
// ---------------------------------------------------------------------------

/** The latest record after a lost compare-and-set. */
async function current(id: string, fallback: StoredCommand): Promise<StoredCommand> {
    return (await readCommand(id)) ?? fallback;
}

/**
 * Which commands a caller may read or cancel. The owner (and the device) see
 * every command; a granted helper only the ones they sent themselves.
 */
export interface CommandViewer {
    onlySenderUserId?: string;
}

const hiddenFrom = (cmd: StoredCommand, viewer: CommandViewer): boolean =>
    viewer.onlySenderUserId !== undefined && cmd.senderUserId !== viewer.onlySenderUserId;

/** One command, for the owner of its target device (a helper: only their own). */
export async function getDeviceCommand(
    deviceSessionId: string,
    commandId: string,
    viewer: CommandViewer = {},
): Promise<Result<DeviceCommand>> {
    await connectValkey();
    if (!isCoordinationValkeyReady()) return fail('unavailable', 'Cache service unavailable');
    const cmd = await readCommand(commandId);
    if (!cmd || cmd.deviceSessionId !== deviceSessionId || hiddenFrom(cmd, viewer))
        return fail('not_found', 'Unknown command');
    if ((cmd.status === 'pending' || cmd.status === 'delivered') && isExpired(cmd)) {
        const expired = (await transition(cmd, 'expired')) ?? (await current(commandId, cmd));
        return { ok: true, value: toPublic(expired) };
    }
    return { ok: true, value: toPublic(cmd) };
}

/** Cancels a command the device has not carried out yet. */
export async function cancelDeviceCommand(
    deviceSessionId: string,
    commandId: string,
    viewer: CommandViewer = {},
): Promise<Result<DeviceCommand>> {
    await connectValkey();
    if (!isCoordinationValkeyReady()) return fail('unavailable', 'Cache service unavailable');
    const cmd = await readCommand(commandId);
    if (!cmd || cmd.deviceSessionId !== deviceSessionId || hiddenFrom(cmd, viewer))
        return fail('not_found', 'Unknown command');
    if (cmd.status !== 'pending' && cmd.status !== 'delivered') {
        return fail('conflict', `The command is already ${cmd.status}`);
    }
    const cancelled = await transition(cmd, 'cancelled');
    if (!cancelled) {
        const now = await current(commandId, cmd);
        return fail('conflict', `The command is already ${now.status}`);
    }
    await publishToDevice(cancelled, 'device.command_cancelled');
    return { ok: true, value: toPublic(cancelled) };
}

/**
 * A helper's grant ended: cancel what they still have waiting on the owner's
 * devices (queued and scheduled commands would otherwise run after the
 * revocation). Returns how many were cancelled. Best effort per device.
 */
export async function cancelCommandsFromSender(
    ownerUserId: string,
    senderUserId: string,
): Promise<number> {
    const sql = getDb();
    if (!sql) return 0;
    await connectValkey();
    if (!isCoordinationValkeyReady()) return 0;
    let cancelled = 0;
    try {
        const sessions = await listDeviceSessionIdsOfUser.all(sql, { userId: ownerUserId });
        for (const { device_session_id: deviceSessionId } of sessions) {
            for (const cmd of await readInbox(deviceSessionId)) {
                if (cmd.senderUserId !== senderUserId) continue;
                const next = await transition(cmd, 'cancelled');
                if (!next) continue;
                cancelled += 1;
                await publishToDevice(next, 'device.command_cancelled');
            }
        }
    } catch (err) {
        logger.warn('Could not cancel the removed helper’s commands', { error: String(err) });
    }
    return cancelled;
}

// ---------------------------------------------------------------------------
// Device side: inbox, results
// ---------------------------------------------------------------------------

/** The device's own to-do list (catch-up after a reconnect, scheduled ones). */
export async function listDeviceInbox(deviceSessionId: string): Promise<Result<DeviceCommand[]>> {
    await connectValkey();
    if (!isCoordinationValkeyReady()) return fail('unavailable', 'Cache service unavailable');
    const inbox = await readInbox(deviceSessionId, { forDevice: true });
    return { ok: true, value: inbox.map(toPublic) };
}

const ALLOWED_TRANSITIONS: Record<string, readonly DeviceCommandStatus[]> = {
    pending: ['delivered', 'applied', 'rejected'],
    delivered: ['applied', 'rejected'],
    applied: ['acknowledged'],
};

/** The device reports what it did with one of its commands. */
export async function reportDeviceCommandResult(
    deviceSessionId: string,
    commandId: string,
    result: {
        status: 'delivered' | 'applied' | 'rejected' | 'acknowledged';
        reason?: string;
        actionId?: string;
    },
): Promise<Result<DeviceCommand>> {
    await connectValkey();
    if (!isCoordinationValkeyReady()) return fail('unavailable', 'Cache service unavailable');
    const cmd = await readCommand(commandId);
    if (!cmd || cmd.deviceSessionId !== deviceSessionId)
        return fail('not_found', 'Unknown command');
    if (cmd.status === result.status) return { ok: true, value: toPublic(cmd) }; // idempotent repeat
    const allowed = ALLOWED_TRANSITIONS[cmd.status] ?? [];
    if (!allowed.includes(result.status)) {
        return fail('conflict', `Cannot go from ${cmd.status} to ${result.status}`);
    }
    if (result.actionId !== undefined && result.status !== 'acknowledged') {
        return fail('invalid', 'actionId belongs to acknowledged only');
    }
    if (result.status === 'acknowledged') {
        if (cmd.type !== 'ui.message') return fail('invalid', 'Only messages are acknowledged');
        const offered = Array.isArray(cmd.args['actions'])
            ? (cmd.args['actions'] as { id?: unknown }[]).map((a) => a.id)
            : [];
        if (
            result.actionId === undefined ? offered.length > 0 : !offered.includes(result.actionId)
        ) {
            return fail('invalid', 'Not one of the offered buttons');
        }
    }
    // Applying after expiry is the device's late arrival; record it as expired.
    if (result.status !== 'rejected' && result.status !== 'acknowledged' && isExpired(cmd)) {
        const expired = (await transition(cmd, 'expired')) ?? (await current(commandId, cmd));
        return { ok: true, value: toPublic(expired) };
    }
    const next = await transition(cmd, result.status, {
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.actionId ? { actionId: result.actionId } : {}),
    });
    if (!next) {
        const now = await current(commandId, cmd);
        return fail('conflict', `The command is already ${now.status}`);
    }
    return { ok: true, value: toPublic(next) };
}

/** Drops the device's commands, state and presence (sign-out / revoke). */
export async function forgetDevice(deviceSessionId: string): Promise<void> {
    try {
        const ids = await sMembers(inboxKey(deviceSessionId));
        for (const id of ids) {
            const cmd = await readCommand(id).catch(() => null);
            if (cmd && (cmd.status === 'pending' || cmd.status === 'delivered')) {
                await transition(cmd, 'expired').catch(() => null);
            }
        }
        await cacheDel([
            inboxKey(deviceSessionId),
            stateKey(deviceSessionId),
            capsKey(deviceSessionId),
            revisionKey(deviceSessionId),
            DEVICE_ONLINE_KEY(deviceSessionId),
            DEVICE_STREAM_KEY(deviceSessionId),
        ]);
    } catch (err) {
        logger.warn('Failed to forget device commands', { error: String(err) });
    }
}

export type { StoredState };
