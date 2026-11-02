// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

const KEY_PREFIX = 'lumastra:resume:v1:';
const MAX_ENTRIES = 200;

export interface ResumeEntry {
    positionMs: number;
    anchor: number;
}

interface RawEntry {
    p: number;
    a: number;
}

function keyFor(username: string): string {
    return `${KEY_PREFIX}${username}`;
}

function isRawEntry(value: unknown): value is RawEntry {
    if (typeof value !== 'object' || value === null) return false;
    const e = value as { p?: unknown; a?: unknown };
    return Number.isFinite(e.p) && Number.isFinite(e.a) && (e.p as number) > 0;
}

function readMap(username: string): Record<string, RawEntry> {
    if (!username) return {};
    try {
        const raw = localStorage.getItem(keyFor(username));
        if (raw === null) return {};
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            localStorage.removeItem(keyFor(username));
            return {};
        }
        const filtered: Record<string, RawEntry> = {};
        for (const [uuid, value] of Object.entries(parsed)) {
            if (isRawEntry(value)) filtered[uuid] = value;
        }
        return filtered;
    } catch {
        // best-effort: corrupt cached map → drop it and return empty (rebuilt on next write).
        try {
            localStorage.removeItem(keyFor(username));
        } catch {
            /* ignore */
        }
        return {};
    }
}

function writeMap(username: string, map: Record<string, RawEntry>): void {
    if (!username) return;
    try {
        localStorage.setItem(keyFor(username), JSON.stringify(map));
    } catch {
        // Quota exhausted, private mode, etc. Silently degrade.
    }
}

function evictOldest(map: Record<string, RawEntry>): void {
    const entries = Object.entries(map);
    if (entries.length <= MAX_ENTRIES) return;
    entries.sort((a, b) => a[1].a - b[1].a);
    const drop = entries.length - MAX_ENTRIES;
    for (let i = 0; i < drop; i++) {
        delete map[entries[i][0]];
    }
}

export function getResumeEntry(username: string, uuid: string): ResumeEntry | null {
    if (!username) return null;
    const map = readMap(username);
    const raw = map[uuid];
    if (!isRawEntry(raw)) return null;
    return { positionMs: raw.p, anchor: raw.a };
}

export function setResumeEntry(
    username: string,
    uuid: string,
    positionMs: number,
    anchor: number,
): void {
    if (!username) return;
    if (!Number.isFinite(positionMs) || positionMs <= 0) return;
    if (!Number.isFinite(anchor)) return;
    const map = readMap(username);
    map[uuid] = { p: positionMs, a: anchor };
    evictOldest(map);
    writeMap(username, map);
}

export function clearResumeEntry(username: string, uuid: string): void {
    if (!username) return;
    const map = readMap(username);
    if (!(uuid in map)) return;
    delete map[uuid];
    writeMap(username, map);
}
