// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bounded in-memory window of recent playback events (seeks, quality
 * switches, stalls, reconnect attempts) — pure in-memory, zero I/O. Records
 * everything cheaply during playback; costs nothing for a session with no
 * errors. Only flushed to the server when a notable event fires
 * (see incident-reporter.ts).
 *
 * Two independent eviction rules on every push: drop the oldest entry once
 * length exceeds maxEntries, AND drop any entry older than maxAgeMs relative
 * to now. This is a sliding window, not a single threshold — an idle
 * session (long pauses between seeks) should only ever hold the last
 * maxAgeMs of activity, not accumulate toward maxEntries over an
 * arbitrarily long span.
 */

export interface IncidentBufferEntry {
    /** Epoch ms. */
    t: number;
    kind:
        | 'seek'
        | 'quality_switch'
        | 'play'
        | 'pause'
        | 'reconnect_attempt'
        | 'rebuffer_event'
        | 'playback_stall'
        | 'media_stalled';
    detail?: Record<string, unknown>;
}

export interface IncidentRingBufferOptions {
    maxEntries: number;
    maxAgeMs: number;
    /** Injectable clock for deterministic tests; defaults to Date.now. */
    now?: () => number;
}

export class IncidentRingBuffer {
    private entries: IncidentBufferEntry[] = [];
    private readonly maxEntries: number;
    private readonly maxAgeMs: number;
    private readonly now: () => number;

    constructor(opts: IncidentRingBufferOptions) {
        // A non-finite/non-positive maxEntries (e.g. NaN from a bad config read)
        // would make `entries.length > maxEntries` always false, silently
        // disabling count-based eviction while age-based eviction keeps running
        // — falling back to the documented default keeps this buffer bounded
        // even if the caller passes a garbage value.
        this.maxEntries =
            Number.isFinite(opts.maxEntries) && opts.maxEntries > 0
                ? opts.maxEntries
                : PLAYBACK_INCIDENT_BUFFER_MAX_ENTRIES;
        this.maxAgeMs =
            Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs > 0
                ? opts.maxAgeMs
                : PLAYBACK_INCIDENT_BUFFER_MAX_AGE_MS;
        this.now = opts.now ?? Date.now;
    }

    push(entry: IncidentBufferEntry): void {
        this.entries.push(entry);
        this.evict();
    }

    private evict(): void {
        const cutoff = this.now() - this.maxAgeMs;
        this.entries = this.entries.filter((e) => e.t >= cutoff);
        if (this.entries.length > this.maxEntries) {
            this.entries = this.entries.slice(this.entries.length - this.maxEntries);
        }
    }

    snapshot(): IncidentBufferEntry[] {
        return [...this.entries];
    }

    clear(): void {
        this.entries = [];
    }
}

export const PLAYBACK_INCIDENT_BUFFER_MAX_ENTRIES = 120;
export const PLAYBACK_INCIDENT_BUFFER_MAX_AGE_MS = 90_000;
