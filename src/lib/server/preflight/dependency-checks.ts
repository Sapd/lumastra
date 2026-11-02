// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Optional-dependency reachability checks for the first-run wizard.
 *
 * Answers "are the sibling containers/services this instance is configured to use
 * actually reachable, and is the config volume mounted & writable?" — the common
 * Docker footguns (forgot to mount the config volume; the music-embedder or Live TV
 * proxy container isn't up; an *arr/download service is misconfigured).
 *
 * NON-BLOCKING BY DESIGN: every probe is gated on both its feature flag AND config
 * presence (unconfigured → omitted, never shown), runs concurrently under a short
 * timeout, and can never throw — a dead dependency becomes a `warn` finding, not an
 * error that blocks onboarding. Each finding names the service so the operator sees
 * exactly which feature won't work until it's fixed.
 *
 * Read-only: touches no DB and writes no config. Reusable outside onboarding (e.g.
 * an admin health surface).
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { getConfigStorageStatus } from '$lib/server/config/config.service.js';
import { getConfigPath } from '$lib/server/config/index.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-timeout.js';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { dirname } from 'node:path';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

/** A single dependency finding. `warn` = configured but unreachable/not persisting. */
export interface DependencyFinding {
    /** Stable id the client maps to a localized message (e.g. 'sonic-embedder'). */
    id: string;
    /** Proper-noun service label (not translated), e.g. "Sonarr". */
    name: string;
    status: 'pass' | 'warn';
    /** Base URL or path for display — NEVER contains secrets/api keys. */
    url?: string;
    /** Optional count (e.g. number of readable media library paths). */
    count?: number;
}

/** Short per-probe timeout — a hung container must not stall onboarding. */
const PROBE_TIMEOUT_MS = 5_000;

/** Strip a trailing slash so `${base}/path` never double-slashes. */
function trimUrl(u: string): string {
    return u.replace(/\/+$/, '');
}

/**
 * Probe one HTTP dependency. `pass` iff the service answered 2xx (configured AND
 * working); any non-2xx or transport failure → `warn`. Never throws.
 */
async function probeHttp(
    id: string,
    name: string,
    displayUrl: string,
    probeUrl: string,
    init?: RequestInit,
): Promise<DependencyFinding> {
    try {
        const res = await fetchWithTimeout(probeUrl, init, PROBE_TIMEOUT_MS);
        return { id, name, status: res.ok ? 'pass' : 'warn', url: displayUrl };
    } catch {
        return { id, name, status: 'warn', url: displayUrl };
    }
}

/** Config volume mounted & writable — otherwise settings/secrets won't persist. */
async function checkConfigDir(): Promise<DependencyFinding> {
    let dir: string;
    try {
        dir = dirname(getConfigPath());
    } catch {
        dir = '';
    }
    try {
        const status = await getConfigStorageStatus();
        return {
            id: 'config-dir',
            name: 'Config directory',
            status: status.willPersist ? 'pass' : 'warn',
            url: dir || undefined,
        };
    } catch {
        return {
            id: 'config-dir',
            name: 'Config directory',
            status: 'warn',
            url: dir || undefined,
        };
    }
}

/** Music sonic-embedder sidecar (`/health` on the container). */
function checkSonicEmbedder(): Promise<DependencyFinding> | null {
    // Empty SONIC_EMBEDDER_URL = subprocess mode (no HTTP sidecar to probe).
    if (!config.FEATURE_MUSIC_SONIC || !config.SONIC_EMBEDDER_URL) return null;
    const base = trimUrl(config.SONIC_EMBEDDER_URL);
    return probeHttp('sonic-embedder', 'Music embedder', base, `${base}/health`);
}

/** Live TV stream proxy container (`/status`, needs the shared secret). */
function checkStreamProxy(): Promise<DependencyFinding> | null {
    if (
        !config.FEATURE_LIVETV ||
        config.LIVETV_SOURCE !== 'standalone' ||
        !config.STREAM_PROXY_URL
    ) {
        return null;
    }
    const base = trimUrl(config.STREAM_PROXY_URL);
    const headers: Record<string, string> = {};
    if (config.STREAM_PROXY_SECRET) headers['X-Proxy-Secret'] = config.STREAM_PROXY_SECRET;
    return probeHttp('stream-proxy', 'Live TV proxy', base, `${base}/status`, { headers });
}

/** A Sonarr/Radarr-style *arr service (`/api/v3/system/status`, X-Api-Key). */
function checkArr(
    id: string,
    name: string,
    baseUrl: string,
    apiKey: string,
): Promise<DependencyFinding> | null {
    if (!baseUrl || !apiKey) return null;
    const base = trimUrl(baseUrl);
    return probeHttp(id, name, base, `${base}/api/v3/system/status`, {
        headers: { 'X-Api-Key': apiKey },
    });
}

/** Jellyseerr (`/api/v1/status`, X-Api-Key). */
function checkJellyseerr(): Promise<DependencyFinding> | null {
    if (!config.SEERRURL || !config.SEERRAPIKEY) return null;
    const base = trimUrl(config.SEERRURL);
    return probeHttp('jellyseerr', 'Seerr', base, `${base}/api/v1/status`, {
        headers: { 'X-Api-Key': config.SEERRAPIKEY },
    });
}

/** Audiobookshelf reachability; include its credential when one is configured. */
function checkAudiobookshelf(): Promise<DependencyFinding> | null {
    if (!config.FEATURE_AUDIOBOOKS || !config.AUDIOURL) return null;
    const base = trimUrl(config.AUDIOURL);
    return probeHttp('audiobookshelf', 'Audiobookshelf', base, joinUpstreamUrl(base, '/ping'), {
        headers: config.AUDIOAPIKEY ? { Authorization: `Bearer ${config.AUDIOAPIKEY}` } : {},
    });
}

/** Is a filesystem path readable by this process? Never throws. */
export async function isPathReadable(p: string): Promise<boolean> {
    try {
        await access(p, fsConstants.R_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Media library paths readable from THIS node. Requires a DB handle (paths live in
 * `library_paths`); at first-run there are none, so this yields nothing. Distinct
 * enabled paths are probed concurrently: each unreadable one becomes its own `warn`
 * (its media won't scan/play), and when every path is readable a single aggregate
 * `pass` summarizes the count. Never throws.
 */
async function checkMediaPaths(sql: postgres.Sql): Promise<DependencyFinding[]> {
    let paths: string[];
    try {
        const rows = await getEnabledLibraryPaths(sql);
        // Defensive: a null/empty path row must not throw (which would swallow ALL
        // media-path findings via the catch below).
        paths = [
            ...new Set(
                rows
                    .map((r) => r.path)
                    .filter((p): p is string => typeof p === 'string' && p.length > 0),
            ),
        ];
    } catch {
        return []; // DB hiccup must not block the rest of the report.
    }
    if (paths.length === 0) return [];

    const results = await Promise.allSettled(
        paths.map(async (p) => ({ path: p, ok: await isPathReadable(p) })),
    );

    const findings: DependencyFinding[] = [];
    let readable = 0;
    for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        if (r.value.ok) {
            readable += 1;
        } else {
            findings.push({
                id: `media-path:${r.value.path}`,
                name: r.value.path,
                status: 'warn',
                url: r.value.path,
            });
        }
    }
    // All readable → one reassuring aggregate; otherwise only the broken paths show.
    if (findings.length === 0 && readable > 0) {
        findings.push({
            id: 'media-paths-ok',
            name: 'Media libraries',
            status: 'pass',
            count: readable,
        });
    }
    return findings;
}

/**
 * Run all configured dependency probes concurrently and return the findings.
 * Unconfigured services are omitted; the config-dir check is always included.
 * Pass a DB handle (`sql`) to also probe media-library-path readability (skipped at
 * first-run, where no libraries exist yet). Never rejects — a probe that somehow
 * throws is dropped rather than propagated.
 */
export async function runDependencyChecks(sql?: postgres.Sql): Promise<DependencyFinding[]> {
    const maybe: Array<Promise<DependencyFinding> | null> = [
        checkConfigDir(),
        checkSonicEmbedder(),
        checkStreamProxy(),
        checkArr('sonarr', 'Sonarr', config.SONARRURL, config.SONARRAPIKEY),
        checkArr('radarr', 'Radarr', config.RADARRURL, config.RADARRAPIKEY),
        checkJellyseerr(),
        checkAudiobookshelf(),
    ];
    const active = maybe.filter((p): p is Promise<DependencyFinding> => p !== null);
    const settled = await Promise.allSettled(active);
    const findings = settled
        .filter((s): s is PromiseFulfilledResult<DependencyFinding> => s.status === 'fulfilled')
        .map((s) => s.value);

    if (sql) findings.push(...(await checkMediaPaths(sql)));

    return findings;
}
