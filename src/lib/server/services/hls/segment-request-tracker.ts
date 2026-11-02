// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

const repeatedSegmentRequests = new Map<string, { count: number; lastSeenAt: number }>();

const staleAudioRequestWarnings = new Map<string, number>();

export interface NoteRepeatedSegmentRequestOptions {
    playSessionId: string;
    streamDir: string;
    requestedSegmentNum: number;
    windowMs: number;
    now?: number;
}

export function noteRepeatedSegmentRequest(options: NoteRepeatedSegmentRequestOptions): number {
    const now = options.now ?? Date.now();
    const key = `${options.playSessionId}:${options.streamDir}:${options.requestedSegmentNum}`;
    const existing = repeatedSegmentRequests.get(key);
    const count =
        existing && now - existing.lastSeenAt <= options.windowMs ? existing.count + 1 : 1;
    repeatedSegmentRequests.set(key, { count, lastSeenAt: now });

    if (repeatedSegmentRequests.size > 1000) {
        for (const [entryKey, entry] of repeatedSegmentRequests) {
            if (now - entry.lastSeenAt > options.windowMs * 2) {
                repeatedSegmentRequests.delete(entryKey);
            }
        }
    }

    return count;
}

export function clearRepeatedSegmentRequest(
    playSessionId: string,
    streamDir: string,
    requestedSegmentNum: number,
): void {
    repeatedSegmentRequests.delete(`${playSessionId}:${streamDir}:${requestedSegmentNum}`);
}

export interface ShouldLogStaleAudioRequestWarningOptions {
    playSessionId: string;
    streamDir: string;
    requestedSegmentNum: number;
    segmentOffset: number;
    cooldownMs: number;
    now?: number;
}

export function shouldLogStaleAudioRequestWarning(
    options: ShouldLogStaleAudioRequestWarningOptions,
): boolean {
    const now = options.now ?? Date.now();
    const key = `${options.playSessionId}:${options.streamDir}:${options.requestedSegmentNum}:${options.segmentOffset}`;
    const previous = staleAudioRequestWarnings.get(key) ?? 0;
    if (now - previous < options.cooldownMs) {
        return false;
    }
    staleAudioRequestWarnings.set(key, now);

    if (staleAudioRequestWarnings.size > 1000) {
        for (const [entryKey, loggedAt] of staleAudioRequestWarnings) {
            if (now - loggedAt > options.cooldownMs * 3) {
                staleAudioRequestWarnings.delete(entryKey);
            }
        }
    }

    return true;
}

export function clearSessionRequestTrackers(playSessionId: string): void {
    const prefix = `${playSessionId}:`;
    for (const key of repeatedSegmentRequests.keys()) {
        if (key.startsWith(prefix)) repeatedSegmentRequests.delete(key);
    }
    for (const key of staleAudioRequestWarnings.keys()) {
        if (key.startsWith(prefix)) staleAudioRequestWarnings.delete(key);
    }
}

export function clearHlsSegmentRequestTrackersForTests(): void {
    repeatedSegmentRequests.clear();
    staleAudioRequestWarnings.clear();
}
