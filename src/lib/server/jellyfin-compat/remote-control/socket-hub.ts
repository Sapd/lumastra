// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Jellyfin WebSocket (`/j/socket`): what remote control is delivered over.
 *
 * Mirrors Jellyfin's WebSocketManager + SessionWebSocketListener:
 *   - authenticated at the upgrade with the same /j session token every other
 *     route takes (`?api_key=` or the MediaBrowser auth header); PATs are not
 *     accepted, as on the plain `GET /j/socket` route;
 *   - `ForceKeepAlive` (60 s) on connect, `KeepAlive` echoed back, a socket
 *     with no inbound frame for 60 s is dropped;
 *   - `SessionsStart` / `SessionsStop` subscribe to a periodic `Sessions` list;
 *   - `Play` / `Playstate` / `GeneralCommand` arrive through the fan-out.
 *
 * Every sweep (20 s) re-checks each socket's token, so signing a device out or
 * disabling the account closes its socket within one sweep.
 */

import { buildPrincipal } from '$lib/server/api/principal';
import { localsIsAdmin } from '$lib/server/auth/locals-admin';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { isDependencyError } from '$lib/server/auth/dependency-unavailable.js';
import { resolveTokenUserAccess } from '$lib/server/auth/resolve-token-user-access';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import { getClientIpStrictFromRequest } from '$lib/server/utils/client-ip';
import { config } from '$lib/server/config';
import { getDb } from '$lib/server/database/connection.js';
import type { UserContext } from '$lib/server/types';
import { Logger } from '$lib/server/utils/logger.js';
import { toUserId } from '$lib/shared/user-id';
import { validateSession, type JellyfinSession } from '../auth';
import { parseEmbyAuthHeader } from '../middleware';
import {
    clearPresence,
    refreshPresence,
    remoteSessionId,
    touchDevices,
    upsertDevice,
} from './device-registry';
import { ensureFanoutSubscription } from './fanout';
import {
    addLocalSocket,
    allLocalSockets,
    removeLocalSocket,
    type LocalSocket,
} from './local-sockets';
import { outboundMessage, parseInboundMessage, parseSessionsStartInterval } from './protocol';
import { buildSessionList } from './sessions-list';

const logger = Logger.for('JellyfinCompat:Socket');

/** Jellyfin's WebSocketLostTimeout (s): sent as ForceKeepAlive data. */
export const KEEPALIVE_TIMEOUT_S = 60;
const SWEEP_INTERVAL_MS = 20_000;
/**
 * A socket silent for this long is sent a ForceKeepAlive. Jellyfin uses
 * 0.75 × timeout (45 s), but it checks far more often than this 20 s sweep:
 * with 45 s a socket last heard at 41 s gets nothing at that sweep and is
 * dropped at the next (61 s). 30 s leaves at least one sweep with a
 * ForceKeepAlive before the 60 s drop.
 */
const FORCE_KEEPALIVE_AFTER_MS = 30_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
/** Sockets per device; the oldest is closed when a new one exceeds it. */
const MAX_SOCKETS_PER_DEVICE = 4;
export const SESSIONS_FEED_MIN_INTERVAL_MS = 2_000;
const SESSIONS_FEED_DEFAULT_INTERVAL_MS = 10_000;
const FAILED_AUTH_LIMIT_PER_MINUTE = 60;

/** Pathnames this hub claims (case-insensitive, as Jellyfin routes are). */
export function isJellyfinSocketPath(pathname: string): boolean {
    return /^\/j\/(socket|embywebsocket)\/?$/i.test(pathname);
}

interface Connection extends LocalSocket {
    readonly ws: WebSocket;
    readonly token: string;
    user: UserContext;
    principal: ReturnType<typeof buildPrincipal>;
    lastInboundAt: number;
    sessionsTimer: ReturnType<typeof setInterval> | null;
    /** Deferred first push of a SessionsStart that came too soon after the last build. */
    sessionsKick: ReturnType<typeof setTimeout> | null;
    lastSessionsJson: string | null;
    /** A Sessions build is running for this socket; no second one starts. */
    sessionsBuilding: boolean;
    /** When the last Sessions build started (ms epoch; 0 = never). */
    lastSessionsBuildAt: number;
}

const connections = new Set<Connection>();
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
let sweepTimer: ReturnType<typeof setInterval> | null = null;
/** A sweep is running; a tick that lands meanwhile is skipped, not stacked. */
let sweeping = false;
let shutdownHooked = false;

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

function header(req: IncomingMessage, name: string): string {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/** Token from the query (`api_key`, `ApiKey`, `token`) or the auth headers. */
export function extractSocketToken(req: IncomingMessage): string {
    const url = new URL(req.url ?? '/', 'http://socket.invalid');
    for (const name of ['api_key', 'ApiKey', 'apiKey', 'token']) {
        const v = url.searchParams.get(name);
        if (v) return v;
    }
    const emby = parseEmbyAuthHeader(header(req, 'x-emby-authorization'));
    const auth = parseEmbyAuthHeader(header(req, 'authorization'));
    return (
        emby['Token'] ||
        auth['Token'] ||
        header(req, 'x-emby-token').trim() ||
        header(req, 'x-mediabrowser-token').trim() ||
        ''
    );
}

interface SocketAuth {
    session: JellyfinSession;
    user: UserContext;
    principal: ReturnType<typeof buildPrincipal>;
}

/** Validate a /j session token exactly as withJellyfinAuth does for sessions. */
async function authenticateToken(token: string): Promise<SocketAuth | null> {
    if (!token) return null;
    const session = await validateSession(token, '/j/socket');
    if (!session) return null;
    const access = await resolveTokenUserAccess(session.username);
    if (!access || access.disabled || access.deleted) return null;
    return {
        session,
        principal: buildPrincipal({
            kind: 'jellyfin_compat',
            userId: toUserId(session.userId),
            username: session.username,
            userGroups: access.userGroups,
            tokenScopes: ['read', 'write'],
            sessionIsAdmin: access.permissions.ownerIsAdmin && session.origin !== 'quick_connect',
        }),
        user: {
            userId: toUserId(session.userId),
            username: session.username,
            groups: access.userGroups.join('|'),
            userGroups: access.userGroups,
            ...access.permissions,
        },
    };
}

/**
 * The client address for the auth-failure throttle, resolved like the HTTP
 * path's `getClientIpStrict`: X-Forwarded-For only from a TRUSTED_PROXY_IPS
 * peer. Keying on the raw peer alone put every client behind the ingress in
 * one bucket, so 60 failures a minute from anyone turned every stale-token
 * reconnect into a 429 (Jellyfin apps re-login on 401, not on 429).
 */
export function socketClientIp(req: IncomingMessage): string {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const request = new Request('http://socket.invalid/', { headers });
    return getClientIpStrictFromRequest(request, () => req.socket.remoteAddress ?? 'unknown');
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    if (socket.destroyed) return;
    const retry = status === 503 ? 'Retry-After: 5\r\n' : '';
    socket.end(
        `HTTP/1.1 ${status} ${reason}\r\n${retry}Connection: close\r\nContent-Length: 0\r\n\r\n`,
    );
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

function sendJson(conn: Connection, message: unknown): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    conn.ws.send(JSON.stringify(message), (err) => {
        if (err) logger.debug('Socket send failed', { error: err.message });
    });
}

function stopSessionsFeed(conn: Connection): void {
    if (conn.sessionsTimer) clearInterval(conn.sessionsTimer);
    if (conn.sessionsKick) clearTimeout(conn.sessionsKick);
    conn.sessionsTimer = null;
    conn.sessionsKick = null;
    conn.lastSessionsJson = null;
}

/**
 * Build and send the Sessions list. At most one build runs per socket at a
 * time: a slow build (PG under load) makes later ticks skip instead of piling
 * up behind it.
 */
async function pushSessions(conn: Connection): Promise<void> {
    const sql = getDb();
    if (!sql || conn.ws.readyState !== WebSocket.OPEN || conn.sessionsBuilding) return;
    conn.sessionsBuilding = true;
    conn.lastSessionsBuildAt = Date.now();
    try {
        const list = await buildSessionList(sql, {
            userId: conn.user.userId,
            ownerIsAdmin: localsIsAdmin(conn),
        });
        const body = JSON.stringify(list);
        // Jellyfin's periodic listeners only send when the data changed.
        if (body === conn.lastSessionsJson) return;
        conn.lastSessionsJson = body;
        sendJson(conn, outboundMessage('Sessions', list));
    } catch (err) {
        logger.warn('Sessions feed build failed', { error: String(err) });
    } finally {
        conn.sessionsBuilding = false;
    }
}

function startSessionsFeed(conn: Connection, data: unknown): void {
    stopSessionsFeed(conn);
    const interval = parseSessionsStartInterval(
        data,
        SESSIONS_FEED_MIN_INTERVAL_MS,
        SESSIONS_FEED_DEFAULT_INTERVAL_MS,
    );
    // The first list goes out at once — unless the last build started less than
    // the minimum interval ago. Then it is deferred to that point, so a client
    // repeating SessionsStart cannot make the server rebuild the list (two PG
    // queries, item lookups, four Valkey hash reads) as fast as it can send.
    // The periodic timer starts with that first push.
    const startTimer = (): void => {
        conn.sessionsTimer = setInterval(() => void pushSessions(conn), interval);
        conn.sessionsTimer.unref();
    };
    const wait = SESSIONS_FEED_MIN_INTERVAL_MS - (Date.now() - conn.lastSessionsBuildAt);
    if (wait <= 0) {
        void pushSessions(conn);
        startTimer();
        return;
    }
    conn.sessionsKick = setTimeout(() => {
        conn.sessionsKick = null;
        void pushSessions(conn);
        startTimer();
    }, wait);
    conn.sessionsKick.unref();
}

function onMessage(conn: Connection, data: RawData, isBinary: boolean): void {
    conn.lastInboundAt = Date.now();
    if (isBinary) return;
    const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8');
    const msg = parseInboundMessage(text);
    if (!msg) return;
    switch (msg.type) {
        case 'KeepAlive':
            sendJson(conn, outboundMessage('KeepAlive'));
            return;
        case 'SessionsStart':
            startSessionsFeed(conn, msg.data);
            return;
        case 'SessionsStop':
            stopSessionsFeed(conn);
            return;
        default:
            // ActivityLogEntryStart, ScheduledTasksInfoStart, …: admin
            // dashboard feeds Lumastra does not serve. Ignored, like any
            // message type Jellyfin has no listener for.
            logger.debug('Ignoring inbound socket message', { type: msg.type });
    }
}

function onClose(conn: Connection): void {
    if (!connections.delete(conn)) return;
    stopSessionsFeed(conn);
    removeLocalSocket(conn);
    void clearPresence(conn.sessionId, conn.connectionId).catch(() => undefined);
    logger.debug('Jellyfin socket closed', { sessionId: conn.sessionId });
}

function enforceDeviceCap(sessionId: string): void {
    const mine = [...connections].filter((c) => c.sessionId === sessionId);
    const excess = mine.length - MAX_SOCKETS_PER_DEVICE;
    for (let i = 0; i < excess; i++) {
        mine[i].ws.close(1008, 'Too many connections for this device');
        onClose(mine[i]);
    }
}

async function openConnection(ws: WebSocket, auth: SocketAuth, token: string): Promise<void> {
    const { session, user, principal } = auth;
    const deviceId = session.deviceId || `token-${remoteSessionId(session.userId, token)}`;
    const sessionId = remoteSessionId(session.userId, deviceId);
    const conn: Connection = {
        connectionId: randomUUID(),
        sessionId,
        ws,
        token,
        user,
        principal,
        lastInboundAt: Date.now(),
        sessionsTimer: null,
        sessionsKick: null,
        lastSessionsJson: null,
        sessionsBuilding: false,
        lastSessionsBuildAt: 0,
        send(payload: string): void {
            if (ws.readyState !== WebSocket.OPEN) return;
            ws.send(payload, (err) => {
                if (err) logger.debug('Socket send failed', { error: err.message });
            });
        },
    };
    connections.add(conn);
    addLocalSocket(conn);
    enforceDeviceCap(sessionId);

    ws.on('message', (data, isBinary) => onMessage(conn, data, isBinary));
    ws.on('close', () => onClose(conn));
    ws.on('error', (err) => {
        logger.debug('Socket error', { error: err.message });
        onClose(conn);
    });

    ensureSweep();

    // Register before greeting: once the app has its ForceKeepAlive it may
    // report capabilities or be listed as controllable straight away.
    try {
        await upsertDevice({
            userId: String(user.userId),
            username: session.username,
            displayName: session.displayName ?? null,
            deviceId,
            deviceName: session.deviceName || 'Unknown',
            client: session.clientName || 'Unknown',
            clientVersion: session.clientVersion || '1.0.0',
        });
        await refreshPresence([{ sessionId, connectionId: conn.connectionId }]);
        // Closed while registering: onClose already cleared presence, so the
        // write above must not leave the device looking online.
        if (!connections.has(conn)) await clearPresence(sessionId, conn.connectionId);
        await ensureFanoutSubscription();
    } catch (err) {
        logger.warn('Remote-control registration failed for a socket', { error: String(err) });
    }
    sendJson(conn, outboundMessage('ForceKeepAlive', KEEPALIVE_TIMEOUT_S));
    logger.info('Jellyfin socket connected', {
        username: session.username,
        client: session.clientName,
        deviceName: session.deviceName,
    });
}

/**
 * The upgrade handler registered with the AGPL dispatcher
 * (`$lib/server/utils/http-upgrade`).
 */
export function handleJellyfinSocketUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
): void {
    socket.on('error', () => socket.destroy());
    // An upgrade never passes through hooks.server.ts, so resolveAuth's /j
    // kill switch has to be repeated here.
    if (!config.FEATURE_JELLYFIN_COMPAT) {
        rejectUpgrade(socket, 404, 'Not Found');
        return;
    }
    void (async () => {
        const token = extractSocketToken(req);
        let auth: SocketAuth | null = null;
        try {
            auth = await authenticateToken(token);
        } catch (err) {
            logger.warn('Socket auth threw', { error: String(err) });
            if (isDependencyError(err)) {
                rejectUpgrade(socket, 503, 'Service Unavailable');
                return;
            }
        }
        if (!auth) {
            // Same brute-force throttle as withJellyfinAuth, keyed on the peer.
            const ip = socketClientIp(req);
            const rate = await checkRateLimit(
                `jfcompat:auth_fail:${ip}`,
                FAILED_AUTH_LIMIT_PER_MINUTE,
                60,
            ).catch(() => ({ allowed: true }));
            if (!rate.allowed) rejectUpgrade(socket, 429, 'Too Many Requests');
            else rejectUpgrade(socket, 401, 'Unauthorized');
            return;
        }
        if (socket.destroyed) return;
        wss.handleUpgrade(req, socket, head, (ws) => {
            void openConnection(ws, auth, token);
        });
    })();
}

// ---------------------------------------------------------------------------
// Sweep: keep-alive, presence, token re-check
// ---------------------------------------------------------------------------

/**
 * One keep-alive / presence / revocation pass. Exported for tests. A pass
 * re-validates every socket's token serially, so under a slow DB it can
 * outlast the 20 s interval; an overlapping call returns at once instead of
 * starting a second pass over the same sockets.
 */
export async function sweepSockets(now = Date.now()): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    try {
        await sweepOnce(now);
    } finally {
        sweeping = false;
    }
}

async function sweepOnce(now: number): Promise<void> {
    if (!config.FEATURE_JELLYFIN_COMPAT) {
        closeAllSockets('Jellyfin compatibility disabled');
        return;
    }
    const live: Connection[] = [];
    for (const conn of [...connections]) {
        const silentMs = now - conn.lastInboundAt;
        if (silentMs >= KEEPALIVE_TIMEOUT_S * 1000) {
            logger.info('Jellyfin socket lost (no keep-alive)', { sessionId: conn.sessionId });
            conn.ws.terminate();
            onClose(conn);
            continue;
        }
        let auth: SocketAuth | null;
        try {
            auth = await authenticateToken(conn.token);
        } catch (error) {
            if (isDependencyError(error)) {
                // Keep existing sockets and re-check next sweep after recovery.
                live.push(conn);
                continue;
            }
            logger.warn('Socket revalidation failed', { error: String(error) });
            conn.ws.close(1011, 'Session check failed');
            onClose(conn);
            continue;
        }
        if (!auth) {
            conn.ws.close(1008, 'Session ended');
            onClose(conn);
            continue;
        }
        conn.user = auth.user;
        conn.principal = auth.principal;
        if (silentMs > FORCE_KEEPALIVE_AFTER_MS) {
            sendJson(conn, outboundMessage('ForceKeepAlive', KEEPALIVE_TIMEOUT_S));
        }
        live.push(conn);
    }
    try {
        await refreshPresence(
            live.map((c) => ({ sessionId: c.sessionId, connectionId: c.connectionId })),
            now,
        );
        await touchDevices(
            live.map((c) => c.sessionId),
            now,
        );
    } catch (err) {
        logger.debug('Presence refresh failed', { error: String(err) });
    }
    if (connections.size === 0) stopSweep();
}

function ensureSweep(): void {
    hookShutdown();
    if (sweepTimer) return;
    sweepTimer = setInterval(() => void sweepSockets(), SWEEP_INTERVAL_MS);
    sweepTimer.unref();
}

function stopSweep(): void {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
}

/** Close every socket (1001) — on shutdown, so clients reconnect to a live replica. */
export function closeAllSockets(reason = 'Server shutting down'): void {
    for (const conn of [...connections]) {
        conn.ws.close(1001, reason);
        onClose(conn);
    }
    stopSweep();
}

function hookShutdown(): void {
    if (shutdownHooked) return;
    shutdownHooked = true;
    process.once('SIGTERM', () => closeAllSockets());
    process.once('SIGINT', () => closeAllSockets());
}

export function openSocketCount(): number {
    return connections.size;
}

/** Test-only: sockets currently registered locally. */
export function __localSocketCountForTests(): number {
    return allLocalSockets().length;
}
