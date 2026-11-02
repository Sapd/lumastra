// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

const lastSeekTimestamp = new Map<string, number>();

export function getLastSeekTimestamp(playSessionId: string): number | undefined {
    return lastSeekTimestamp.get(playSessionId);
}

export function setLastSeekTimestamp(playSessionId: string, timestamp: number): void {
    lastSeekTimestamp.set(playSessionId, timestamp);
}

export function clearSeekTimestamp(playSessionId: string): void {
    lastSeekTimestamp.delete(playSessionId);
}

export function pruneExpiredSeekTimestamps(options: {
    pruneThreshold: number;
    maxAgeMs: number;
    now?: number;
}): void {
    if (lastSeekTimestamp.size < options.pruneThreshold) return;

    const now = options.now ?? Date.now();
    for (const [key, timestamp] of lastSeekTimestamp) {
        if (now - timestamp > options.maxAgeMs) {
            lastSeekTimestamp.delete(key);
        }
    }
}

export function clearSeekCooldownTrackerForTests(): void {
    lastSeekTimestamp.clear();
}
