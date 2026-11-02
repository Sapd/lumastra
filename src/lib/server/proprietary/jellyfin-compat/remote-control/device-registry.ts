// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Remote-controllable /j devices, shared by every web replica through Valkey.
 *
 * Jellyfin keeps one in-memory `SessionInfo` per device: the capabilities the
 * app reported (`POST /Sessions/Capabilities`) plus the WebSocket(s) it holds.
 * Lumastra runs several web replicas, so both halves live in Valkey:
 *
 *   - `jfcompat:rc:v1:devices` (HASH, field = remote session id): who the
 *     device is — owner, names, last activity.
 *   - `jfcompat:rc:v1:caps` (HASH, same field): what the app last reported via
 *     `/Sessions/Capabilities`. Kept apart so a socket connecting at the same
 *     moment (apps do both at startup) can never overwrite it with a stale
 *     read — each hash field has exactly one kind of writer.
 *   - `jfcompat:rc:v1:viewing` (HASH, same field): `POST /Sessions/Viewing`.
 *   - `jfcompat:rc:v1:online` (HASH, field = `<session id>|<connection id>`):
 *     one entry per open socket, value = expiry (ms). The replica holding the
 *     socket refreshes it every keep-alive sweep; a crashed replica's entries
 *     simply expire. A device "supports remote control" exactly when it
 *     reported `SupportsMediaControl` AND has a live entry here — Jellyfin's
 *     own rule (SessionInfo.SupportsRemoteControl).
 *
 * The remote session id is derived from (user, device), so it is stable
 * across reconnects, replicas and restarts, and is a 32-hex Guid like
 * Jellyfin's.
 */

import { createHash } from 'node:crypto';
import { connectValkey, hDel, hGet, hGetAll, hSet, hSetMulti } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { GeneralCommandType, MediaType, ReportedCapabilities } from './protocol';

const logger = Logger.for('JellyfinCompat:RemoteDevices');

export const DEVICES_KEY = 'jfcompat:rc:v1:devices';
export const CAPS_KEY = 'jfcompat:rc:v1:caps';
export const VIEWING_KEY = 'jfcompat:rc:v1:viewing';
export const ONLINE_KEY = 'jfcompat:rc:v1:online';

/** Every hash a device has fields in (for cleanup). */
export const DEVICE_KEYS = [DEVICES_KEY, CAPS_KEY, VIEWING_KEY, ONLINE_KEY];

/** How long one presence refresh keeps a socket "online" (ms). */
export const PRESENCE_TTL_MS = 90_000;
/** Device records with no activity for this long are dropped on read. */
export const DEVICE_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface RemoteDeviceRecord {
    /** Remote session id (32 hex). */
    id: string;
    /** users.id (dashed UUID). */
    userId: string;
    username: string;
    displayName: string | null;
    deviceId: string;
    deviceName: string;
    client: string;
    clientVersion: string;
    playableMediaTypes: MediaType[];
    supportedCommands: GeneralCommandType[];
    supportsMediaControl: boolean;
    /** Epoch ms of the last capabilities report, socket connect or keep-alive. */
    lastActivityAt: number;
    /** `POST /Sessions/Viewing` — the item the app says it is showing. */
    nowViewingItemId?: string | null;
}

/** Identity of the /j client a record is about (from its session token). */
export interface RemoteDeviceIdentity {
    userId: string;
    username: string;
    displayName: string | null;
    deviceId: string;
    deviceName: string;
    client: string;
    clientVersion: string;
}

/** Stable remote session id for a (user, device) pair. */
export function remoteSessionId(userId: string, deviceId: string): string {
    return createHash('sha256')
        .update(`jf-remote:${userId.toLowerCase()}:${deviceId}`)
        .digest('hex')
        .slice(0, 32);
}

/** The identity half of a record, as stored in DEVICES_KEY. */
type StoredIdentity = RemoteDeviceIdentity & { id: string; lastActivityAt: number };

function parseJson<T>(raw: string | null | undefined): T | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function parseIdentity(raw: string | null | undefined): StoredIdentity | null {
    const r = parseJson<StoredIdentity>(raw);
    return r && typeof r.id === 'string' && typeof r.userId === 'string' ? r : null;
}

function combine(
    identity: StoredIdentity,
    capsRaw: string | null | undefined,
    viewingRaw: string | null | undefined,
): RemoteDeviceRecord {
    const caps = parseJson<ReportedCapabilities>(capsRaw);
    return {
        ...identity,
        playableMediaTypes: caps?.playableMediaTypes ?? [],
        supportedCommands: caps?.supportedCommands ?? [],
        supportsMediaControl: caps?.supportsMediaControl === true,
        nowViewingItemId: viewingRaw || null,
    };
}

export async function getDevice(id: string): Promise<RemoteDeviceRecord | null> {
    await connectValkey();
    const key = id.toLowerCase();
    const identity = parseIdentity(await hGet(DEVICES_KEY, key));
    if (!identity) return null;
    const [caps, viewing] = await Promise.all([hGet(CAPS_KEY, key), hGet(VIEWING_KEY, key)]);
    return combine(identity, caps, viewing);
}

/**
 * Create or refresh the device's identity (and its last activity). With
 * `capabilities`, also replace what the app reported; without (a socket
 * connect), the stored capabilities are left untouched.
 */
export async function upsertDevice(
    identity: RemoteDeviceIdentity,
    capabilities?: ReportedCapabilities,
    now = Date.now(),
): Promise<void> {
    await connectValkey();
    const id = remoteSessionId(identity.userId, identity.deviceId);
    let displayName = identity.displayName;
    if (displayName === null) {
        // The capabilities route has no display name; keep the socket's.
        displayName = parseIdentity(await hGet(DEVICES_KEY, id))?.displayName ?? null;
    }
    const stored: StoredIdentity = { id, ...identity, displayName, lastActivityAt: now };
    await hSet(DEVICES_KEY, id, JSON.stringify(stored));
    if (capabilities) {
        const caps: ReportedCapabilities = {
            playableMediaTypes: capabilities.playableMediaTypes,
            supportedCommands: capabilities.supportedCommands,
            supportsMediaControl: capabilities.supportsMediaControl,
        };
        await hSet(CAPS_KEY, id, JSON.stringify(caps));
    }
}

/** Record `POST /Sessions/Viewing` on an existing device. No-op when unknown. */
export async function setNowViewing(id: string, itemId: string | null): Promise<boolean> {
    await connectValkey();
    const key = id.toLowerCase();
    if (!parseIdentity(await hGet(DEVICES_KEY, key))) return false;
    if (itemId) await hSet(VIEWING_KEY, key, itemId);
    else await hDel(VIEWING_KEY, key);
    return true;
}

/** Bump last activity for devices whose sockets are alive on this replica. */
export async function touchDevices(ids: string[], now = Date.now()): Promise<void> {
    if (ids.length === 0) return;
    await connectValkey();
    const fields: Record<string, string> = {};
    for (const id of new Set(ids)) {
        const identity = parseIdentity(await hGet(DEVICES_KEY, id));
        if (!identity) continue;
        fields[id] = JSON.stringify({ ...identity, lastActivityAt: now });
    }
    await hSetMulti(DEVICES_KEY, fields);
}

const presenceField = (sessionId: string, connectionId: string): string =>
    `${sessionId}|${connectionId}`;

/** Mark sockets online until now + PRESENCE_TTL_MS. */
export async function refreshPresence(
    entries: { sessionId: string; connectionId: string }[],
    now = Date.now(),
): Promise<void> {
    if (entries.length === 0) return;
    await connectValkey();
    const fields: Record<string, string> = {};
    for (const e of entries) {
        fields[presenceField(e.sessionId, e.connectionId)] = String(now + PRESENCE_TTL_MS);
    }
    await hSetMulti(ONLINE_KEY, fields);
}

export async function clearPresence(sessionId: string, connectionId: string): Promise<void> {
    await hDel(ONLINE_KEY, presenceField(sessionId, connectionId));
}

/** Remote session ids with at least one live socket on any replica. */
export async function getOnlineSessionIds(now = Date.now()): Promise<Set<string>> {
    await connectValkey();
    const all = await hGetAll(ONLINE_KEY);
    const online = new Set<string>();
    const expired: string[] = [];
    for (const [field, value] of Object.entries(all)) {
        const sep = field.indexOf('|');
        if (sep <= 0) {
            expired.push(field);
            continue;
        }
        if (Number(value) > now) online.add(field.slice(0, sep));
        else expired.push(field);
    }
    if (expired.length > 0) await hDel(ONLINE_KEY, expired);
    return online;
}

/** Every device still within DEVICE_RECORD_MAX_AGE_MS; older ones are pruned. */
export async function listDevices(now = Date.now()): Promise<RemoteDeviceRecord[]> {
    await connectValkey();
    const [identities, caps, viewing] = await Promise.all([
        hGetAll(DEVICES_KEY),
        hGetAll(CAPS_KEY),
        hGetAll(VIEWING_KEY),
    ]);
    const out: RemoteDeviceRecord[] = [];
    const stale: string[] = [];
    for (const [field, raw] of Object.entries(identities)) {
        const identity = parseIdentity(raw);
        if (!identity || now - identity.lastActivityAt > DEVICE_RECORD_MAX_AGE_MS) {
            stale.push(field);
            continue;
        }
        out.push(combine(identity, caps[field], viewing[field]));
    }
    // Capabilities / viewing rows whose identity is gone are orphans too.
    const orphanCaps = Object.keys(caps).filter((f) => !(f in identities));
    const orphanViewing = Object.keys(viewing).filter((f) => !(f in identities));
    if (stale.length > 0) {
        await hDel(DEVICES_KEY, stale);
        logger.debug('Pruned stale remote-control device records', { count: stale.length });
    }
    if (stale.length + orphanCaps.length > 0) await hDel(CAPS_KEY, [...stale, ...orphanCaps]);
    if (stale.length + orphanViewing.length > 0) {
        await hDel(VIEWING_KEY, [...stale, ...orphanViewing]);
    }
    return out;
}

/**
 * One user's devices. The identity hash is read once and only this user's
 * entries are parsed and joined with their capabilities (a point read each),
 * so a server with many users does not pay for everyone's devices on every
 * call. Records past DEVICE_RECORD_MAX_AGE_MS are skipped (pruning is
 * `listDevices`' job).
 */
export async function listDevicesForUser(
    userId: string,
    now = Date.now(),
): Promise<RemoteDeviceRecord[]> {
    await connectValkey();
    const wanted = userId.toLowerCase();
    const identities = await hGetAll(DEVICES_KEY);
    const mine: StoredIdentity[] = [];
    for (const raw of Object.values(identities)) {
        // Cheap text test first: parse only entries that can be this user's.
        if (!raw.toLowerCase().includes(wanted)) continue;
        const identity = parseIdentity(raw);
        if (!identity || identity.userId.toLowerCase() !== wanted) continue;
        if (now - identity.lastActivityAt > DEVICE_RECORD_MAX_AGE_MS) continue;
        mine.push(identity);
    }
    return Promise.all(
        mine.map(async (identity) => {
            const key = identity.id.toLowerCase();
            const [caps, viewing] = await Promise.all([
                hGet(CAPS_KEY, key),
                hGet(VIEWING_KEY, key),
            ]);
            return combine(identity, caps, viewing);
        }),
    );
}

/** Jellyfin's rule: reported SupportsMediaControl AND a socket is open. */
export function supportsRemoteControl(record: RemoteDeviceRecord, online: Set<string>): boolean {
    return record.supportsMediaControl && online.has(record.id);
}
