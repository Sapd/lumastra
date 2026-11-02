// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared fetch path for the /music lazy content sections (LazySection +
 * LazySectionGroup).
 *
 * Two problems this solves, both felt hardest on mobile:
 *
 *  1. **Request storm.** On a tall viewport many sections cross the
 *     IntersectionObserver threshold at once and each fired its own `fetch`
 *     with no coordination — up to ~14 simultaneous requests, several of them
 *     backed by expensive DB / embedding work, all contending for the browser's
 *     handful of connections and the database at the same instant. A small
 *     shared semaphore caps how many run concurrently; the rest queue and drain
 *     as slots free, so the sections the user is actually looking at load first
 *     instead of every section fighting for bandwidth.
 *
 *  2. **Refetch on back-navigation.** The components only remembered a fetch
 *     while mounted, so returning to /music re-ran every section fetch from
 *     scratch. A short-TTL client cache (in-memory + sessionStorage) returns the
 *     previous payload instantly for repeat views within the same tab session.
 *
 * The cache is per-tab and short-lived by design: the payloads are personalised
 * to the current user (their own data), so caching them client-side is correct;
 * the TTL keeps them reasonably fresh, and a new tab / reload starts clean.
 */

/** Max section fetches allowed in flight at once. Keeps the initial burst from
 *  saturating the connection pool and hammering the DB with parallel expensive
 *  queries. Cached hits do NOT consume a slot (they resolve before acquiring). */
const MAX_CONCURRENT = 4;

/** Per-fetch network timeout — a hung request surfaces as an error row rather
 *  than an invisible layout hole. Mirrors the previous per-component value. */
const FETCH_TIMEOUT_MS = 15_000;

/** How long a cached section payload is served before a fresh fetch. Short so
 *  personalised rows don't feel stale, long enough to cover back-nav / tab
 *  switching within a browsing session. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Bump when the cached payload shape changes to invalidate old entries. */
const CACHE_VERSION = 'v2';
const CACHE_PREFIX = `lumastra:music-section:${CACHE_VERSION}:`;

// --- Concurrency limiter (module-global, shared across every section instance) ---

let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
    if (active < MAX_CONCURRENT) {
        active += 1;
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
    const next = waiters.shift();
    if (next) {
        // Hand the just-freed slot straight to the next waiter — `active` stays
        // put (the slot is transferred, not returned).
        next();
    } else {
        active = Math.max(0, active - 1);
    }
}

// --- Client cache (L1 in-memory + L2 sessionStorage) ---

interface CacheEntry {
    t: number;
    body: unknown;
}

const memCache = new Map<string, CacheEntry>();

function readCache(url: string): { body: unknown } | null {
    const now = Date.now();
    const mem = memCache.get(url);
    if (mem) {
        if (now - mem.t < CACHE_TTL_MS) return { body: mem.body };
        memCache.delete(url);
    }
    if (typeof sessionStorage === 'undefined') return null;
    try {
        const raw = sessionStorage.getItem(CACHE_PREFIX + url);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CacheEntry;
        if (now - parsed.t >= CACHE_TTL_MS) {
            sessionStorage.removeItem(CACHE_PREFIX + url);
            return null;
        }
        // Promote into the faster in-memory tier.
        memCache.set(url, parsed);
        return { body: parsed.body };
    } catch {
        // Corrupt entry / blocked storage — treat as a miss.
        return null;
    }
}

function writeCache(url: string, body: unknown): void {
    const entry: CacheEntry = { t: Date.now(), body };
    memCache.set(url, entry);
    if (typeof sessionStorage === 'undefined') return;
    try {
        sessionStorage.setItem(CACHE_PREFIX + url, JSON.stringify(entry));
    } catch {
        // Quota exceeded / private mode — the in-memory tier still helps.
    }
}

// --- Public API ---

export type SectionFetchResult =
    | { kind: 'ok'; body: unknown }
    | { kind: 'empty' } // 503 dependency_unavailable — collapse like an empty section
    | { kind: 'error' };

/**
 * Fetch a section endpoint through the shared cache + concurrency limiter.
 * Returns a discriminated result so callers keep their existing render
 * branching (ok / collapse / error). Only successful `res.ok` payloads are
 * cached; the cheap-fail paths (503 / network error) are left to refetch.
 */
export async function fetchSectionCached(url: string): Promise<SectionFetchResult> {
    const cached = readCache(url);
    if (cached) return { kind: 'ok', body: cached.body };

    await acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
            if (res.status === 503) {
                const body = (await res.json().catch(() => null)) as { code?: string } | null;
                if (body?.code === 'dependency_unavailable') return { kind: 'empty' };
            }
            return { kind: 'error' };
        }
        const body = (await res.json()) as unknown;
        writeCache(url, body);
        return { kind: 'ok', body };
    } catch {
        return { kind: 'error' };
    } finally {
        clearTimeout(timer);
        release();
    }
}
