// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The /j WebSockets open on THIS process, indexed by remote session id.
 *
 * Kept apart from the hub (which owns their lifecycle) and the fan-out (which
 * delivers into them) so neither has to import the other.
 */

/** The minimum a delivery needs from a socket. */
export interface LocalSocket {
    readonly connectionId: string;
    readonly sessionId: string;
    /** Send one text frame. Must not throw. */
    send(payload: string): void;
}

const bySession = new Map<string, Set<LocalSocket>>();

export function addLocalSocket(socket: LocalSocket): void {
    let set = bySession.get(socket.sessionId);
    if (!set) {
        set = new Set();
        bySession.set(socket.sessionId, set);
    }
    set.add(socket);
}

export function removeLocalSocket(socket: LocalSocket): void {
    const set = bySession.get(socket.sessionId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) bySession.delete(socket.sessionId);
}

export function getLocalSockets(sessionId: string): LocalSocket[] {
    return [...(bySession.get(sessionId) ?? [])];
}

export function allLocalSockets(): LocalSocket[] {
    return [...bySession.values()].flatMap((s) => [...s]);
}

/** Write `payload` to every local socket of `sessionId`. Returns how many got it. */
export function deliverLocal(sessionId: string, payload: string): number {
    const sockets = getLocalSockets(sessionId);
    for (const s of sockets) s.send(payload);
    return sockets.length;
}

/** Test-only. */
export function __resetLocalSocketsForTests(): void {
    bySession.clear();
}
