// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stale-while-revalidate cache around runDependencyChecks(). The attention spine
 * derives on every bell poll (~60s), every /admin auto-refresh, and every admin
 * page load; each dependency probe is a live outbound HTTP request (5s timeout),
 * so it must NOT run inline on those. This wrapper serves the last known findings
 * instantly and refreshes them in the background at most once per TTL.
 *
 * Cold start (never successfully probed): throw DependencyChecksWarmingError rather
 * than returning []. Returning [] would read as "all clear" and make the attention
 * reconcile RESOLVE a persisted dependency alert — then the completing probe would
 * re-create it, flapping the alert on every process restart. Throwing routes the
 * `optional-dependency:` prefix into the spine's failedPrefixes, which protects
 * persisted alerts ("couldn't observe" is not "resolved").
 */

import type postgres from 'postgres';
import { runDependencyChecks, type DependencyFinding } from './dependency-checks.js';
import { Logger } from '$lib/server/utils/logger.js';

/** Thrown on a cold (never-probed) get so the caller protects persisted alerts. */
export class DependencyChecksWarmingError extends Error {
    constructor() {
        super('Dependency checks are warming up (no probe has completed yet)');
        this.name = 'DependencyChecksWarmingError';
    }
}

const DEFAULT_TTL_MS = 60_000;

const logger = Logger.for('DependencyChecksCache');

interface CacheDeps {
    probe: (sql?: postgres.Sql) => Promise<DependencyFinding[]>;
    now: () => number;
    ttlMs?: number;
}

/**
 * Build a SWR cache. Exposed as a factory (rather than only a module singleton) so
 * the probe and clock can be injected in tests for deterministic TTL behaviour.
 */
export function createDependencyChecksCache(deps: CacheDeps): {
    get: (sql?: postgres.Sql) => Promise<DependencyFinding[]>;
} {
    const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    let cache: { findings: DependencyFinding[]; at: number } | null = null;
    let inflight: Promise<DependencyFinding[]> | null = null;

    function refresh(sql?: postgres.Sql): Promise<DependencyFinding[]> {
        // Stampede guard: concurrent stale/cold callers share one probe.
        if (!inflight) {
            inflight = deps
                .probe(sql)
                .then((findings) => {
                    cache = { findings, at: deps.now() };
                    return findings;
                })
                .catch((err) => {
                    // runDependencyChecks never throws today, but if a future probe
                    // does, log it once here rather than let the per-caller
                    // `.catch(() => undefined)` swallow it silently. Re-throw so the
                    // cold path still surfaces DependencyChecksWarmingError.
                    logger.warn(
                        'dependency-check probe failed; serving stale/cold until next attempt',
                        { err: err instanceof Error ? err.message : String(err) },
                    );
                    throw err;
                })
                .finally(() => {
                    inflight = null;
                });
        }
        return inflight;
    }

    return {
        get(sql?: postgres.Sql): Promise<DependencyFinding[]> {
            const fresh = cache !== null && deps.now() - cache.at < ttlMs;
            if (fresh && cache !== null) {
                return Promise.resolve(cache.findings);
            }
            // Stale or cold: ensure a refresh is running.
            void refresh(sql).catch(() => undefined); // errors surface on the next cold/typed path
            if (cache !== null) {
                return Promise.resolve(cache.findings); // stale-while-revalidate
            }
            return Promise.reject(new DependencyChecksWarmingError()); // cold
        },
    };
}

/** Production singleton: real probe, real clock, 60s TTL. */
const singleton = createDependencyChecksCache({
    probe: runDependencyChecks,
    now: () => Date.now(),
});

export function getCachedDependencyChecks(sql?: postgres.Sql): Promise<DependencyFinding[]> {
    return singleton.get(sql);
}
