// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-run circuit breaker for the music enrichment sources (TheAudioDB,
 * Discogs, Deezer).
 *
 * Artist and album enrichment ask every source for every item. When a source
 * is down for the whole run (TheAudioDB 404-ing every request after its free
 * key was retired, say), each item still paid one failing, rate-limited
 * request to it: about 16 minutes of dead calls for a re-poll of ~450 albums.
 *
 * After `threshold` consecutive failures a source is OPEN: the chains skip it
 * and count it as unavailable, so the item is deferred, never recorded as a
 * no-match. After `cooldownMs` one request is let through as a probe; an
 * answer closes the breaker, a failure keeps it open for another cooldown.
 * When every source of the chain is open, the task stops its drain instead of
 * parking the rest of the backlog without having asked anyone.
 *
 * One instance per run, in memory. Nothing persists: the next run starts
 * closed and finds out again within `threshold` requests.
 */
export class EnrichmentSourceBreaker<S extends string = string> {
    private readonly threshold: number;
    private readonly cooldownMs: number;
    private readonly now: () => number;
    private readonly failures = new Map<S, number>();
    private readonly openedAt = new Map<S, number>();

    constructor(opts: { threshold?: number; cooldownMs?: number; now?: () => number } = {}) {
        this.threshold = opts.threshold ?? 3;
        this.cooldownMs = opts.cooldownMs ?? 10 * 60 * 1000;
        this.now = opts.now ?? Date.now;
    }

    /**
     * `true` when the chain must not call `source` now. Once the cooldown has
     * passed, returns `false` exactly once (the probe) and re-arms the
     * cooldown, so a probe that never reports back (an abort) keeps the
     * source open rather than letting every following item through.
     */
    shouldSkip(source: S): boolean {
        const opened = this.openedAt.get(source);
        if (opened === undefined) return false;
        if (this.now() - opened < this.cooldownMs) return true;
        this.openedAt.set(source, this.now());
        return false;
    }

    /** The source failed instead of answering. */
    recordFailure(source: S): void {
        const failures = (this.failures.get(source) ?? 0) + 1;
        this.failures.set(source, failures);
        if (this.openedAt.has(source) || failures >= this.threshold) {
            this.openedAt.set(source, this.now());
        }
    }

    /** The source answered (a match or a miss). */
    recordAnswer(source: S): void {
        this.failures.delete(source);
        this.openedAt.delete(source);
    }

    /** Sources currently open and inside their cooldown. */
    openSources(): S[] {
        const now = this.now();
        return [...this.openedAt].filter(([, at]) => now - at < this.cooldownMs).map(([s]) => s);
    }

    /** `true` when every one of `sources` is open and inside its cooldown. */
    allOpen(sources: readonly S[]): boolean {
        if (sources.length === 0) return false;
        const open = new Set(this.openSources());
        return sources.every((s) => open.has(s));
    }
}
