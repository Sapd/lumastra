// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * http-upgrade.ts — route HTTP `Upgrade` requests (WebSocket) to registered
 * handlers.
 *
 * adapter-node gives SvelteKit no WebSocket support and the app never sees the
 * `http.Server` it creates. This module finds that server without patching
 * anything: the `net.server.socket` diagnostics channel publishes every
 * accepted connection BEFORE its first byte is parsed, so the first
 * connection to any server in the process attaches the dispatcher, in time
 * for that same connection to be an upgrade.
 *
 * Only upgrades for a registered path are claimed. Node's default treats an
 * upgrade request on a server with no `upgrade` listener as an ordinary
 * request (that is how `/j/socket` answered 200 before), and merely adding a
 * listener would flip EVERY `Upgrade:` request (`curl --http2` sends
 * `Upgrade: h2c`) into the upgrade path. `server.shouldUpgradeCallback`
 * (Node >= 22.22 / 24.9) keeps the default for everything not registered
 * here; on a Node without it, nothing is attached and registered paths keep
 * falling through to their ordinary route handler.
 *
 * Registration goes through this module so the AGPL core never imports a
 * handler's (possibly proprietary) implementation: the handler's owner calls
 * `registerUpgradeHandler()` from its own init.
 */

import { channel } from 'node:diagnostics_channel';
import { Server as HttpServer, type IncomingMessage, type Server } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('HttpUpgrade');

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

interface UpgradeRoute {
    name: string;
    matches: (pathname: string) => boolean;
    handler: UpgradeHandler;
}

const routes: UpgradeRoute[] = [];
const attachedServers = new WeakSet<object>();
let installed = false;

/** URL_BASE_PATH as SvelteKit sees it; stripped before matching when a proxy did not. */
function basePath(): string {
    const raw = (process.env.URL_BASE_PATH ?? '').trim().replace(/\/+$/, '');
    return raw && raw.startsWith('/') ? raw : '';
}

/** Pathname of an upgrade request, base path stripped. Null when unparseable. */
export function upgradePathname(req: Pick<IncomingMessage, 'url'>): string | null {
    let pathname: string;
    try {
        pathname = new URL(req.url ?? '/', 'http://upgrade.invalid').pathname;
    } catch {
        return null;
    }
    const base = basePath();
    if (base && (pathname === base || pathname.startsWith(`${base}/`))) {
        pathname = pathname.slice(base.length) || '/';
    }
    return pathname;
}

function findRoute(req: Pick<IncomingMessage, 'url'>): UpgradeRoute | null {
    const pathname = upgradePathname(req);
    if (pathname === null) return null;
    return routes.find((r) => r.matches(pathname)) ?? null;
}

/**
 * Claim upgrades whose path `matches`. Returns a function that removes the
 * registration. A later registration under the same `name` replaces the
 * earlier one (HMR re-runs module init in dev).
 */
export function registerUpgradeHandler(
    name: string,
    matches: (pathname: string) => boolean,
    handler: UpgradeHandler,
): () => void {
    const existing = routes.findIndex((r) => r.name === name);
    if (existing !== -1) routes.splice(existing, 1);
    const route: UpgradeRoute = { name, matches, handler };
    routes.push(route);
    return () => {
        const i = routes.indexOf(route);
        if (i !== -1) routes.splice(i, 1);
    };
}

type UpgradeAwareServer = Server & {
    shouldUpgradeCallback?: (this: Server, req: IncomingMessage) => boolean;
};

/**
 * Attach the dispatcher to one server. Idempotent. Exported as a test seam;
 * production attaches through `installUpgradeDispatch()`.
 */
export function attachUpgradeDispatch(server: Server): boolean {
    if (attachedServers.has(server)) return true;
    const s = server as UpgradeAwareServer;
    const previous = s.shouldUpgradeCallback;
    if (typeof previous !== 'function') {
        attachedServers.add(server);
        logger.warn(
            'This Node.js has no http.Server.shouldUpgradeCallback; WebSocket upgrades stay disabled',
            { node: process.version },
        );
        return false;
    }
    attachedServers.add(server);

    const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const route = findRoute(req);
        // Not ours: another listener (Vite HMR in dev) owns it.
        if (!route) return;
        try {
            route.handler(req, socket, head);
        } catch (err) {
            logger.error('Upgrade handler threw', err as Error, { route: route.name });
            socket.destroy();
        }
    };

    s.shouldUpgradeCallback = function (req: IncomingMessage): boolean {
        if (findRoute(req)) return true;
        // Defer to the server's own policy, but only when someone other than
        // this dispatcher would receive the event; the default policy counts
        // our listener and would otherwise swallow every unmatched upgrade.
        const others = server.listeners('upgrade').some((l) => l !== onUpgrade);
        return others && previous.call(server, req);
    };
    server.on('upgrade', onUpgrade);
    return true;
}

/**
 * Start attaching the dispatcher to every HTTP server in this process as it
 * accepts its first connection. Idempotent; call once at boot.
 */
export function installUpgradeDispatch(): void {
    if (installed) return;
    installed = true;
    channel('net.server.socket').subscribe((message) => {
        const server = (message as { socket?: { server?: unknown } }).socket?.server;
        // Only HTTP(S) servers carry the upgrade machinery; a raw net.Server
        // (a plugin's TCP listener, say) is left alone.
        if (!(server instanceof HttpServer) && !(server instanceof HttpsServer)) return;
        attachUpgradeDispatch(server as Server);
    });
}

/** Test-only: drop every registration. */
export function __resetUpgradeRoutesForTests(): void {
    routes.length = 0;
}
