// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Orphan Request Filter
 *
 * A "pending" request can become orphaned when an admin deletes the
 * underlying movie/series from Radarr/Sonarr without cancelling the
 * Jellyseerr request. The Jellyseerr request lingers as PROCESSING
 * forever — and Lumastra's pending-requests popup keeps showing a stuck
 * "Being processed" / "Searching" entry that the user can't act on.
 *
 * This helper drops those orphaned entries before the popup payload is
 * built. It's strict on what counts as an orphan:
 *
 *   1. Request must be older than ORPHAN_GRACE_MS — Radarr/Sonarr can take
 *      a few seconds to fully accept a freshly-created request, and we'd
 *      rather show a stuck "Being processed" briefly than wrongly hide
 *      a request that just landed.
 *   2. The integration must be configured AND reachable. Health is
 *      determined by an explicit /system/status ping per-service — NOT by
 *      "did any record match in this batch", which falsely fail-opens when
 *      every pending request is genuinely an orphan (the case this filter
 *      exists for). If ping fails, we fail-open for that service only.
 *   3. Per-request null check is the actual orphan signal:
 *        radarrClient.getMovieByTmdbId(tmdbId) === null  →  orphan
 *      Same for sonarrClient.getSeriesByTvdbId(tvdbId).
 *
 * Sonarr requires a TVDB id which Jellyseerr's request payload doesn't
 * always carry — TV requests without a tvdbId are skipped (kept) rather
 * than guessed at, again to avoid false positives. The dominant case is
 * movies, which is what this filter targets first.
 */
import { radarrClient, sonarrClient } from '$lib/server/sonarr.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { JellyseerrRequest } from '$lib/server/jellyseerr.js';

const logger = Logger.for('OrphanFilter');

/**
 * Don't filter requests younger than this — Radarr/Sonarr need a moment
 * to ingest a freshly created request, and treating that gap as "orphan"
 * would silently drop new requests.
 */
const ORPHAN_GRACE_MS = 30_000;

/**
 * Cap on parallel upstream probes per filter pass. Each popup poll could
 * otherwise fan out N HTTP calls (one per pending request) and DOS Radarr
 * /Sonarr on busy users.
 */
const PROBE_CONCURRENCY = 5;

interface ServiceHealth {
    radarrUp: boolean;
    sonarrUp: boolean;
}

/**
 * Decide which requests are orphans (still pending in Jellyseerr but
 * deleted from the corresponding *arr). Returns the filtered list and a
 * count of dropped entries.
 */
export async function filterOrphanedRequests(
    requests: JellyseerrRequest[],
): Promise<{ kept: JellyseerrRequest[]; orphansDropped: number }> {
    if (requests.length === 0) {
        return { kept: requests, orphansDropped: 0 };
    }

    const now = Date.now();

    // Partition: too-fresh-to-check vs. eligible-for-orphan-check.
    // A malformed/missing createdAt parses to NaN — keep those as
    // passthrough rather than racing them through the orphan path with
    // a meaningless age.
    const eligible: JellyseerrRequest[] = [];
    const passthrough: JellyseerrRequest[] = [];
    for (const req of requests) {
        const createdMs = new Date(req.createdAt).getTime();
        const ageMs = now - createdMs;
        if (!Number.isFinite(createdMs) || ageMs < ORPHAN_GRACE_MS) {
            passthrough.push(req);
        } else {
            eligible.push(req);
        }
    }

    if (eligible.length === 0) {
        return { kept: requests, orphansDropped: 0 };
    }

    // Health-check only the services we'd actually probe. ping() returns
    // true only on a successful authenticated /system/status call, so a
    // genuine "down" cannot be confused with a 404 from a deleted record.
    const needRadarr = eligible.some((r) => r.type === 'movie');
    const needSonarr = eligible.some((r) => r.type === 'tv' && !!r.media.tvdbId);
    const [radarrUp, sonarrUp] = await Promise.all([
        needRadarr ? radarrClient.ping() : Promise.resolve(false),
        needSonarr ? sonarrClient.ping() : Promise.resolve(false),
    ]);
    const health: ServiceHealth = { radarrUp, sonarrUp };

    // If every service we'd query is down, skip the probes — every result
    // would be null (kept) anyway.
    const anyServiceUp = (needRadarr && health.radarrUp) || (needSonarr && health.sonarrUp);
    if (!anyServiceUp) {
        return { kept: requests, orphansDropped: 0 };
    }

    // Probe upstream with bounded concurrency. Each result: true = exists,
    // false = orphan, null = unknown (skip). Probes only run when the
    // corresponding service ping returned true, so a null here means
    // "not applicable" (e.g. TV without tvdbId), not "service down".
    const probes = await mapWithConcurrency(eligible, PROBE_CONCURRENCY, (req) =>
        probeUpstream(req, health),
    );

    const kept: JellyseerrRequest[] = [...passthrough];
    let orphansDropped = 0;
    eligible.forEach((req, i) => {
        if (probes[i] === false) {
            orphansDropped += 1;
        } else {
            kept.push(req);
        }
    });

    if (orphansDropped > 0) {
        logger.info('Hid orphaned pending requests from popup', {
            orphansDropped,
            totalEligible: eligible.length,
        });
    }

    return { kept, orphansDropped };
}

/**
 * `true`  — request's upstream movie/series exists (NOT an orphan)
 * `false` — upstream returned 404 / no record (orphan, only when service is up)
 * `null`  — couldn't determine (TV without tvdbId, integration down,
 *           network error). Treated as "keep" by the caller.
 */
async function probeUpstream(
    req: JellyseerrRequest,
    health: ServiceHealth,
): Promise<boolean | null> {
    try {
        if (req.type === 'movie') {
            if (!health.radarrUp) return null;
            const tmdbId = req.media.tmdbId;
            if (typeof tmdbId !== 'number' || tmdbId <= 0) return null;
            const movie = await radarrClient.getMovieByTmdbId(tmdbId);
            return movie !== null;
        }
        if (req.type === 'tv') {
            if (!health.sonarrUp) return null;
            // Jellyseerr stores tvdbId on req.media when TV is requested,
            // but it can be missing for some flows — skip rather than guess.
            const tvdbId = req.media.tvdbId;
            if (typeof tvdbId !== 'number' || tvdbId <= 0) return null;
            const series = await sonarrClient.getSeriesByTvdbId(tvdbId);
            return series !== null;
        }
    } catch {
        // Network or auth failure — treat as unknown and let caller keep it.
        return null;
    }
    return null;
}

/**
 * Run `fn` over each item with at most `limit` in flight. Preserves input
 * order in the returned array.
 */
async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const workerCount = Math.min(limit, items.length);
    for (let w = 0; w < workerCount; w += 1) {
        workers.push(
            (async () => {
                while (true) {
                    const i = cursor;
                    cursor += 1;
                    if (i >= items.length) return;
                    results[i] = await fn(items[i]);
                }
            })(),
        );
    }
    await Promise.all(workers);
    return results;
}
