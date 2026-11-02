// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Short-lived, process-wide cache for TMDB detail responses.
 *
 * Matching an item starts a chain of per-item tasks within seconds of each
 * other — series-sync, then metadata-translations-sync, the season-poster stage
 * (once PER SEASON), metadata-update — and each one fetched the same
 * `/tv/{id}` or `/movie/{id}` again. On prod (week to 2026-10-06) 168 of the
 * 176 items that got TMDB calls got them from more than one task within the
 * same hour; series-sync itself fetched each series twice per run, and the
 * season-poster stage asked for the same series' season list 7.5 times on
 * average. A response that is minutes old is exactly as good as a new one for
 * all of them.
 *
 * Bounded on purpose, by count AND bytes: it is not a metadata store, and it
 * also lives in the web pods (image proxy, admin artwork browser). Anything
 * that must see TMDB's answer NOW — an admin's forced refresh — passes
 * `fresh: true`, which skips the read but still stores the new answer.
 *
 * Entries are stored as JSON text, never as live objects: every hit parses its
 * own copy, so a caller that mutates its response cannot change what the next
 * caller sees. Concurrent identical requests share one in-flight fetch — the
 * shared result is serialised BEFORE the originating caller gets its object, so
 * a joiner never observes the originator's mutations — except when the caller
 * passes an AbortSignal (an aborted caller must not cancel someone else's
 * request). A joiner whose shared fetch failed retries once on its own.
 * Failures are never cached.
 *
 * Off under vitest (`process.env.VITEST`) so suites that mock `fetch` per call
 * keep seeing every call; `setTmdbResponseCacheEnabled(true)` turns it on for
 * a test.
 */

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 64;
/** Total JSON text held. A long-running series' detail with aggregate_credits is ~1 MB. */
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
/** A single response larger than this is returned but not kept. */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

interface Entry {
    json: string;
    expiresAt: number;
}

interface Shared {
    value: unknown;
    json: string;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<Shared>>();
let totalBytes = 0;
let generation = 0;
let enabled = !process.env.VITEST;

export function setTmdbResponseCacheEnabled(on: boolean): void {
    enabled = on;
    clearTmdbResponseCache();
}

export function clearTmdbResponseCache(): void {
    entries.clear();
    inflight.clear();
    totalBytes = 0;
    // An in-flight fetch that started before the clear must not repopulate it.
    generation++;
}

/** Entries currently held (tests / diagnostics). */
export function tmdbResponseCacheSize(): number {
    return entries.size;
}

export function tmdbResponseCacheKey(
    language: string,
    endpoint: string,
    params: Record<string, string | number> = {},
): string {
    const sorted = Object.keys(params)
        .sort()
        .map((k) => `${k}=${String(params[k])}`)
        .join('&');
    return `${language}|${endpoint}|${sorted}`;
}

function remove(key: string): void {
    const e = entries.get(key);
    if (!e) return;
    entries.delete(key);
    totalBytes -= e.json.length;
}

function store(key: string, json: string): void {
    if (json.length > MAX_ENTRY_BYTES) return;
    const now = Date.now();
    for (const [k, e] of entries) if (e.expiresAt <= now) remove(k);
    // delete-then-set so a re-stored key moves to the most-recent end.
    remove(key);
    entries.set(key, { json, expiresAt: now + TTL_MS });
    totalBytes += json.length;
    while (entries.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest);
    }
}

/** A fresh cached copy of `key`, or undefined. Never fetches. */
export function peekTmdbResponse<T>(key: string): T | undefined {
    if (!enabled) return undefined;
    const hit = entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
        remove(key);
        return undefined;
    }
    entries.delete(key);
    entries.set(key, hit);
    return JSON.parse(hit.json) as T;
}

/**
 * Return a fresh cached copy of `key`, or run `load` and remember a successful
 * result. `fresh: true` skips the read (the result is still stored).
 */
export async function cachedTmdbResponse<T>(
    key: string,
    load: () => Promise<T>,
    options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<T> {
    if (!enabled) return load();
    options.signal?.throwIfAborted();

    if (!options.fresh) {
        const hit = peekTmdbResponse<T>(key);
        if (hit !== undefined) return hit;
    }

    const shareable = !options.signal && !options.fresh;
    const pending = shareable ? inflight.get(key) : undefined;
    if (pending) {
        try {
            return JSON.parse((await pending).json) as T;
        } catch {
            // The shared fetch failed (timeout, 429 …). Its failure is the
            // originator's; this caller gets its own attempt below.
        }
    }

    const gen = generation;
    const request: Promise<Shared> = load().then((value) => ({
        value,
        // Serialised here, before the originator's caller can touch `value`.
        json: JSON.stringify(value) ?? 'null',
    }));
    if (shareable) inflight.set(key, request);
    try {
        const { value, json } = await request;
        if (enabled && gen === generation) store(key, json);
        return value as T;
    } finally {
        if (shareable && inflight.get(key) === request) inflight.delete(key);
    }
}
