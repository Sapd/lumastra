// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Metadata storage writability probe — feeds the `metadata-storage-writability`
 * health invariant (see `invariants.ts`).
 *
 * Guards against the METADATA_STORAGE_LOCATION="alongside" + read-only library
 * mount combination: `resolveWritePath()` (`metadata-storage.service.ts`) throws
 * on every write attempt in that state, so episode-thumbnail extraction,
 * trickplay, and lyrics generation fail with zero operator-visible signal
 * beyond worker-container logs. This probes each enabled library root for a
 * REAL write (not just a permission-bit check — a `:ro` container bind mount
 * preserves file-mode bits but still fails the actual write with EROFS, which
 * is exactly the incident this guards against) and caches the outcome briefly
 * so a 15-minute scheduled tick (or a manual re-run) doesn't repeatedly write
 * probe files to what may be a slow NFS mount. An aggregate per-call budget
 * additionally bounds how long a fleet of simultaneously-hung roots can delay
 * the invariant as a whole (see PROBE_LOOP_BUDGET_MS).
 */

import { join } from 'node:path';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { metadataCentralBaseDir } from '$lib/server/services/metadata-storage.service.js';
import { safeWriteFile, safeUnlink, safeMkdir, FsTimeoutError } from '$lib/server/utils/safe-fs.js';
import { Logger } from '$lib/server/utils/logger.js';
import { parseDurationMs } from '$lib/server/tasks/duration.js';

const logger = Logger.for('MetadataStorageWritability');

// Mirrors health-invariants.ts's own `schedule.every`. Not imported directly
// (that would create a cycle: health-invariants.ts -> invariants.ts -> this
// file), so the two must be kept in sync by hand — the assertion below turns
// a silent drift into a loud one (safeRegister disables just this task at
// boot) instead of quietly defeating the cache below on the next edit.
const HEALTH_INVARIANTS_SCHEDULE_EVERY_MS = parseDurationMs('15m') ?? 15 * 60 * 1000;

/** Writability is a slow-changing filesystem property — cache each root's
 * probe result instead of re-writing to the mount on every health tick.
 * Deliberately longer than the health-invariants task's own 15-minute
 * schedule: a shorter cache would expire before every single scheduled run
 * anyway, providing no real benefit over not caching at all. */
const PROBE_CACHE_MS = 20 * 60 * 1000;

if (PROBE_CACHE_MS <= HEALTH_INVARIANTS_SCHEDULE_EVERY_MS) {
    throw new Error(
        `metadata-storage-writability: PROBE_CACHE_MS (${PROBE_CACHE_MS}ms) must exceed the ` +
            `health-invariants schedule (${HEALTH_INVARIANTS_SCHEDULE_EVERY_MS}ms), or the cache ` +
            'never survives to the next scheduled tick and every run re-probes every root.',
    );
}

/** Per-root probe timeout. Short and strict: a hung NFS mount must never
 * block the shared health-invariants tick — see safe-fs.ts's FsTimeoutError. */
const PROBE_TIMEOUT_MS = 3_000;

/** Aggregate ceiling across every uncached root probed in one call. Without
 * this, a fleet of simultaneously-hung roots (e.g. one unresponsive NFS
 * server backing every library) would serially burn PROBE_TIMEOUT_MS per
 * root, and a large-enough fleet could eat into the shared health-invariants
 * task's own overall run timeout. Once exceeded, remaining roots are marked
 * unknown without being probed — never readonly.
 *
 * SCOPE: this bounds the LIBRARY-ROOT loop only. The central-metadata probe runs
 * before the loop and is not charged against it, so the worst case for the whole
 * function is this budget plus one probe's own ceiling (mkdir + write + unlink, i.e.
 * 3 * PROBE_TIMEOUT_MS). Deliberate: the central probe is a single fixed directory,
 * so it cannot fan out the way a fleet of library roots can, and charging it would
 * let a hung central root starve the library probes entirely. */
const PROBE_LOOP_BUDGET_MS = 30_000;

type ProbeResult = 'writable' | 'readonly' | 'unknown';

interface CacheEntry {
    result: ProbeResult;
    expiresAt: number;
}

// Module-level (not the shared Valkey cache manager): the health-invariants
// task runs on a single leader replica at a time, so a plain in-process cache
// is sufficient and avoids registering a new namespace for a niche probe.
const probeCache = new Map<string, CacheEntry>();

// Round-robin rotation offset (mirrors stage-sweep.ts's identical D1-fairness
// pattern): each call starts the probe loop at a different root so a single
// chronically-slow root can't permanently starve the roots after it in the
// list from ever being probed once the loop budget kicks in. In-process
// counter — resets on restart, which is fine (the point is rotation across
// consecutive calls, not durable state).
let rootRotationOffset = 0;

/**
 * Subdirectory of the central base that actually holds metadata. Mirrors
 * `artworkCentralDir` (`media-image-storage.service.ts`) and
 * `getMetadataDir` (`media-path-resolver.ts`).
 */
const CENTRAL_METADATA_SUBDIR = '.metadata';

/**
 * @param opts.create mkdir the directory before probing. Required for the central
 * metadata dir: it does not exist until the first real write, and without this a
 * fresh install would probe a missing path, get ENOENT, and report 'unknown'
 * forever instead of the truth. `resolveWritePath` does the same mkdir before its
 * own central writes, so this probes precisely what production does. Never used for
 * library roots — creating a missing library root would mask a misconfiguration.
 */
async function probeWritable(root: string, opts?: { create?: boolean }): Promise<ProbeResult> {
    const cached = probeCache.get(root);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    if (opts?.create) {
        try {
            await safeMkdir(root, { recursive: true }, PROBE_TIMEOUT_MS);
        } catch (err) {
            // A denied mkdir IS the failure mode we are looking for — the app cannot
            // create its own central dir. Classify it exactly as a denied write, and
            // skip the write attempt (it would only fail with ENOENT and downgrade a
            // real 'readonly' to 'unknown').
            const code = (err as { code?: string }).code;
            const result: ProbeResult =
                err instanceof FsTimeoutError
                    ? 'unknown'
                    : code === 'EROFS' || code === 'EACCES' || code === 'EPERM'
                      ? 'readonly'
                      : 'unknown';
            if (result === 'unknown') {
                logger.warn('Central metadata dir probe inconclusive (mkdir)', {
                    root,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            probeCache.set(root, { result, expiresAt: Date.now() + PROBE_CACHE_MS });
            return result;
        }
    }

    // Fixed (not per-attempt-unique) filename: if a prior cycle's cleanup
    // failed to unlink (e.g. the mount hung mid-cleanup, per safe-fs.ts's own
    // "a timed-out write may still land on disk later" caveat), the next
    // cycle's write simply overwrites that same leftover file instead of
    // creating a new one every cache-expiry cycle — caps the orphan risk to
    // at most one stray file per root rather than one accumulating per cycle.
    const probeFile = join(root, '.lumastra-writability-probe');
    let result: ProbeResult;
    try {
        await safeWriteFile(probeFile, '', PROBE_TIMEOUT_MS);
        result = 'writable';
    } catch (err) {
        if (err instanceof FsTimeoutError) {
            // Hung mount — inconclusive, NEVER "read-only". A stalled NFS
            // server must not manufacture a false-positive critical finding.
            result = 'unknown';
        } else {
            const code = (err as { code?: string }).code;
            // EROFS/EACCES/EPERM are genuine write denials — the incident this
            // invariant guards against. Anything else (e.g. ENOENT — the root
            // doesn't exist) is a different problem, out of scope here.
            result =
                code === 'EROFS' || code === 'EACCES' || code === 'EPERM' ? 'readonly' : 'unknown';
        }
        if (result === 'unknown') {
            logger.warn('Writability probe inconclusive', {
                root,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    } finally {
        // Best-effort cleanup: a failed write left nothing to unlink, and a
        // failed unlink just leaves a harmless empty dotfile behind.
        try {
            await safeUnlink(probeFile, PROBE_TIMEOUT_MS);
        } catch {
            // Nothing to clean up, or cleanup itself was inconclusive.
        }
    }

    probeCache.set(root, { result, expiresAt: Date.now() + PROBE_CACHE_MS });
    return result;
}

export interface MetadataStorageWritabilityResult {
    mode: 'central' | 'alongside' | 'alongside-prefer';
    readOnlyRoots: string[];
    unknownRoots: string[];
    /** The probed central root (`metadataCentralBaseDir()`), for the finding text. */
    centralDir: string;
    /**
     * Writability of the central root. Probed in EVERY mode, including strict
     * 'alongside': central is not just the 'central'-mode target, it is the
     * unconditional fallback for any item with no derivable media folder
     * (`resolveArtworkWritePath` forces `strategyOverride: 'central'` there,
     * media-image-storage.service.ts). Prod 2026-07-30 had `/data` owned by root
     * with the app as uid 1000, so every such item failed `mkdir` and dead-lettered
     * as `write-path-failed` with nothing but a debug log to show for it — and this
     * invariant said green because it only ever probed library roots.
     */
    centralWritable: ProbeResult;
}

/**
 * Probe every enabled library root for real write access, mode-aware.
 *
 * NOTE: this is called from inside the health-invariants task's per-invariant
 * `sql.begin()` transaction, so it holds that pooled connection open for the
 * duration of any uncached probes below. This is bounded (PROBE_TIMEOUT_MS per
 * uncached root) and rare (results are cached for PROBE_CACHE_MS), so it's an
 * acceptable tradeoff rather than a bigger refactor of the shared task runner.
 */
export async function checkMetadataStorageWritability(
    sql: postgres.Sql,
): Promise<MetadataStorageWritabilityResult> {
    const mode = config.METADATA_STORAGE_LOCATION;

    // Probed FIRST and in every mode — see MetadataStorageWritabilityResult.
    // Cheap: one cached probe against a single directory.
    //
    // The probed path is `<base>/.metadata`, NOT `<base>` — that is the directory
    // `resolveWritePath`'s central branch actually mkdir -p's and writes into. Probing
    // only the parent assumes permissions are uniform down the tree, which is exactly
    // the assumption a layered container mount breaks: a writable `<base>` with a
    // wrongly-chowned `.metadata` subdir reads GREEN while every real write fails (the
    // original incident, one level deeper), and a read-only `<base>` with a separately
    // mounted, writable `.metadata` reads RED while writes succeed.
    const centralDir = join(metadataCentralBaseDir(), CENTRAL_METADATA_SUBDIR);
    const centralWritable = await probeWritable(centralDir, { create: true });
    if (centralWritable === 'readonly') {
        logger.warn('Central metadata root is not writable', { mode, centralDir });
    }

    if (mode === 'central') {
        // 'central' never writes to library roots — nothing further to probe.
        return { mode, readOnlyRoots: [], unknownRoots: [], centralDir, centralWritable };
    }

    const paths = await getEnabledLibraryPaths(sql);
    const roots = [...new Set(paths.map((p) => p.path))];

    // Rotate the starting root per call — see rootRotationOffset.
    const rotatedRoots =
        roots.length > 0
            ? (() => {
                  const off = rootRotationOffset % roots.length;
                  rootRotationOffset++;
                  return [...roots.slice(off), ...roots.slice(0, off)];
              })()
            : roots;

    const readOnlyRoots: string[] = [];
    const unknownRoots: string[] = [];
    // performance.now() (monotonic) rather than Date.now() (wall clock): an
    // NTP step correction mid-loop must never distort how much budget is left.
    const loopStartedAt = performance.now();
    for (let i = 0; i < rotatedRoots.length; i++) {
        // Reserve headroom for the probe about to start: a single probe's own
        // worst case is write-timeout + unlink-timeout (2 * PROBE_TIMEOUT_MS),
        // so checking against the raw budget here would let the last probe
        // overrun the aggregate ceiling by that much.
        if (performance.now() - loopStartedAt > PROBE_LOOP_BUDGET_MS - 2 * PROBE_TIMEOUT_MS) {
            const remaining = rotatedRoots.slice(i);
            logger.warn('Writability probe loop budget exceeded, skipping remaining roots', {
                probed: i,
                remaining: remaining.length,
                total: rotatedRoots.length,
            });
            unknownRoots.push(...remaining);
            break;
        }
        const root = rotatedRoots[i];
        const result = await probeWritable(root);
        if (result === 'readonly') readOnlyRoots.push(root);
        else if (result === 'unknown') unknownRoots.push(root);
    }

    if (readOnlyRoots.length > 0) {
        logger.warn('Library root(s) mounted read-only but metadata writes require them', {
            mode,
            readOnlyRoots,
        });
    }

    return { mode, readOnlyRoots, unknownRoots, centralDir, centralWritable };
}

/** Test-only: clear the in-process probe cache between test cases. */
export function __resetWritabilityProbeCacheForTests(): void {
    probeCache.clear();
}

/** Test-only: reset the round-robin rotation offset between test cases. */
export function __resetProbeRotationForTests(): void {
    rootRotationOffset = 0;
}
