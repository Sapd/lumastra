// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * File-presence classification for backlog plugins.
 *
 * Plugins that operate on files (media-probe, music-analysis) must
 * distinguish "file is gone forever" from "file is on a network mount that
 * is having a 30-second NFS hiccup". Marking a transient outage as a hard
 * miss poisons the row — it goes into the ineligible bucket until the next
 * PROCESSING_VERSION bump, even though the file reappears minutes later.
 *
 * The rule of thumb shared by all call-sites: if the file is absent AND its
 * parent directory is also absent, the whole mount is likely offline; leave
 * the row eligible. If the file is absent but the parent directory is
 * present, the file was deleted — mark it excluded.
 *
 * That immediate-parent heuristic is too coarse when a whole *folder* is
 * deleted from a network share: the file AND its parent album folder are both
 * gone even though the mount is perfectly healthy, so a naive probe classes a
 * real deletion as transient and the row never gets cleaned up. Pass a
 * `mountRoot` (the library root that must exist while the share is mounted) to
 * walk up the directory chain: if ANY ancestor up to and including the mount
 * root exists, the mount is live and the absence is a real deletion; only when
 * the mount root itself is gone do we treat it as a transient outage.
 *
 * Use `assessFilePresence()` in every plugin slice processor that touches
 * on-disk files. Keeping the logic in one place means a future refinement
 * (e.g. symlink handling) lands everywhere at once.
 */

import { access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withFsGuard, FsTimeoutError } from './safe-fs.js';

export type FilePresence = 'present' | 'missing' | 'transient';

type PathProbeResult = 'present' | 'absent' | 'timeout';

/** Per-probe timeout (ms). Short so a slow mount is classified transient fast. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Attempt an access(2) check bounded by a 2-second timeout and an optional
 * abort signal. Returns:
 *   - 'present' if the stat succeeded,
 *   - 'absent'  if the stat failed (ENOENT / EACCES / etc.),
 *   - 'timeout' if either the 2s timeout fired or the caller's signal aborted.
 *
 * Distinguishing 'absent' from 'timeout' is important: a live-but-slow NFS
 * mount that times out must be treated as transient, NOT as missing — the
 * caller would otherwise mark live files as deleted.
 *
 * CRITICAL: the access(2) call is routed through `withFsGuard` so the hung
 * syscall is COUNTED against the global fs concurrency cap. A previous version
 * raced a raw `access()` against a bare timer; on a dead mount the timer fired
 * but the abandoned syscall kept occupying a libuv threadpool thread that the
 * safe-fs semaphore could not see — enough of them starved getaddrinfo/DB and
 * reproduced the original CONNECT_TIMEOUT wedge. Guarding it bounds the damage
 * to the cap. (See safe-fs.ts and the F1 finding in the release-readiness doc.)
 */
async function pathExists(path: string, signal?: AbortSignal): Promise<PathProbeResult> {
    if (signal?.aborted) return 'timeout';

    // The guard holds its permit until access() truly settles (even past the 2s
    // caller timeout), so abandoned probes on a dead mount can never exceed the
    // cap. FsTimeoutError => the mount is slow/unhealthy => 'timeout' (transient);
    // any other rejection => the path is genuinely absent.
    const probe = withFsGuard(() => access(path), 'access', path, PROBE_TIMEOUT_MS).then(
        () => 'present' as const,
        (err: unknown) =>
            err instanceof FsTimeoutError ? ('timeout' as const) : ('absent' as const),
    );

    if (!signal) return probe;

    // Also settle early if the caller aborts the drain. The underlying guarded
    // access keeps running under its permit (bounded by the cap) but the caller
    // no longer waits on it.
    let onAbort: (() => void) | null = null;
    const abortPromise = new Promise<PathProbeResult>((resolve) => {
        onAbort = () => resolve('timeout');
        signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
        return await Promise.race([probe, abortPromise]);
    } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
    }
}

/**
 * Classify a file path as present / missing / transient.
 *
 *   - `present`   — the file itself is visible; proceed with processing.
 *   - `missing`   — file absent but parent directory present → mark
 *                   excluded, the file was deleted.
 *   - `transient` — file absent AND parent directory absent → likely
 *                   unmount or network outage, leave the row eligible for
 *                   the next drain. Also returned when `signal` is already
 *                   aborted, so existing skip logic handles the abort path
 *                   gracefully without incrementing the error counter.
 *
 * Root-like paths (`/`, empty, `.`) short-circuit to `missing` because
 * they have no meaningful parent to probe.
 *
 * @param opts - Either an options object or (back-compat) a bare
 *   `AbortSignal`. Options:
 *   - `mountRoot` — the library root that exists while the share is mounted.
 *     When set (and `filePath` is under it), the absence check walks up the
 *     directory chain to distinguish a deleted folder (mount live) from an
 *     offline mount (root gone). See the module docstring.
 *   - `signal` — optional abort signal. When fired, individual stat calls
 *     resolve immediately and the result is `transient` (safe skip). Each
 *     stat is also bounded by an independent 2-second timeout regardless of
 *     the signal, so dead NFS mounts can't pin the worker.
 */
export async function assessFilePresence(
    filePath: string,
    opts?: { mountRoot?: string; signal?: AbortSignal } | AbortSignal,
): Promise<FilePresence> {
    // Back-compat: a bare AbortSignal (has an `aborted` property) is accepted
    // as the second arg. An options object never carries `aborted`.
    const options: { mountRoot?: string; signal?: AbortSignal } =
        opts && 'aborted' in opts ? { signal: opts } : (opts ?? {});
    const { mountRoot, signal } = options;

    if (signal?.aborted) return 'transient';
    const fileProbe = await pathExists(filePath, signal);
    if (fileProbe === 'present') return 'present';
    // Timeout on the file itself means the mount is unhealthy: treat as
    // transient so the caller leaves the row eligible for the next drain.
    if (fileProbe === 'timeout') return 'transient';
    if (signal?.aborted) return 'transient';

    // Mount-aware path: walk up toward mountRoot. Any existing ancestor up to
    // and including mountRoot means the mount is live → the absence is a real
    // deletion (missing). Reaching the root with everything absent means the
    // mount is offline (transient).
    //
    // The root is normalized (trailing slashes stripped) and containment is
    // boundary-aware (`=== root` or `startsWith(root + '/')`), NOT a bare
    // `startsWith(mountRoot)` — otherwise a sibling directory that merely
    // shares a string prefix (`/data/movies` vs `/data/movies-backup`) would
    // be wrongly walked using the wrong root's semantics, and a trailing
    // slash on mountRoot would make `dir === mountRoot` never fire, running
    // the walk past the root to a present local ancestor (misclassifying an
    // offline mount as a real deletion). When filePath === root, the walk
    // starts AT the root itself rather than one level above it, so the root
    // is always actually probed.
    if (mountRoot) {
        const root = mountRoot.replace(/\/+$/, '') || '/';
        const underRoot = filePath === root || filePath.startsWith(`${root}/`);
        if (underRoot) {
            let dir = filePath === root ? root : dirname(filePath);
            for (;;) {
                const probe = await pathExists(dir, signal);
                if (probe === 'present') return 'missing'; // mount is live → real deletion
                if (probe === 'timeout') return 'transient'; // unhealthy mount
                if (dir === root) return 'transient'; // reached root, all absent → offline
                const parent = dirname(dir);
                if (parent === dir) return 'transient'; // hit filesystem root without finding root
                dir = parent;
            }
        }
        // Not under this root → fall through to legacy immediate-parent probe.
    }

    // Legacy fallback (no mountRoot): immediate-parent probe.
    const parent = dirname(filePath);
    if (parent === filePath || parent === '' || parent === '.') {
        return 'missing';
    }
    const parentProbe = await pathExists(parent, signal);
    if (parentProbe === 'present') return 'missing';
    // Parent timed out or is absent → likely whole-mount outage; transient.
    return 'transient';
}
