// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WatcherLeader — native directory watcher with Valkey leader election.
 *
 * Only one replica at a time runs the native watcher. A Valkey lock with TTL ensures that
 * if the leader crashes, another replica takes over after the TTL expires.
 *
 * "Don't get stuck" guarantees:
 *  - Lock TTL = 30s → auto-releases if process crashes
 *  - Heartbeat renews every 10s using atomic check-and-extend (renewLock)
 *  - 3 consecutive heartbeat failures → watcher stops + lock expires naturally
 *  - Graceful stop → explicit releaseLock() + native child shutdown
 *  - Pending debounces are always cancelled on stop
 */

import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import {
    acquireLock,
    cacheDel,
    cacheExists,
    cacheGet,
    cacheSet,
    releaseLock,
    renewLock,
} from '../../../../../../cache/valkey.js';
import {
    deleteStaleMediaFile,
    findMediaFilePathNfc,
    findRangeFilesSupersededBy,
} from '../../../../../../database/queries/media-files.queries.js';
import { findRangeFilesCoveringRemovedFile } from './multi-episode-links.js';
import { findUnlinkedSameSizeNames, takeSkippedAliases } from './removed-file-recheck.js';
import { isLyricsSidecar } from '../../../../../../utils/walk-directory.js';
import { safeAccess } from '../../../../../../utils/safe-fs.js';
import { assessFilePresence } from '../../../../../../utils/file-presence.js';
import { AsyncSemaphore } from '../../../../../../utils/async-semaphore.js';
import { clearSidecarLyricsForDeletedFile } from './lyrics-sidecar.js';
import { Logger } from '../../../../../../utils/logger.js';
import type { PluginContext } from '../../../../../../plugins/types/base-plugin.js';
import { cancelWatcherFlowDebouncer } from './flow-debouncer.js';
import { queueRecencyRefresh } from './watcher-recency.js';
import {
    NativeWatcherProcess,
    verifyNativeWatcherBinary,
    waitForNativeWatcherQuarantineRelease,
    type NativeWatcherErrorInfo,
    type NativeWatcherOptions,
} from './watcher-native-host.js';
import {
    NATIVE_WATCHER_NETWORK_RECONCILE_MAX_SECS,
    NATIVE_WATCHER_NETWORK_RECONCILE_MIN_SECS,
    type NativeWatcherPolicyV2,
    type NativeWatcherStatus,
} from './watcher-native-protocol.js';
import { buildNativeWatcherPolicy } from '../../../../../../utils/native-watcher-policy.js';
import { WatcherRescanCoalescer } from './watcher-rescan.js';

const logger = Logger.for('FileScannerWatcher');
let warnedObsoleteWatcherSettings = false;

// `lock:` prefix is REQUIRED: it routes this cross-replica singleton lock to the
// noeviction coordination Valkey instance (COORDINATION_KEY_PREFIXES in
// cache/valkey.ts). Without it the key lands on the evictable cache instance and
// eviction under memory pressure would let a second replica start a duplicate
// native watcher → duplicate scans/imports.
const LOCK_KEY = 'lock:file-scanner:watcher';
const LOCK_TTL_SECONDS = 30;
/** The lease counts as lost this long before its TTL could expire (clock/latency margin). */
const LEASE_SAFETY_MARGIN_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 10_000; // renew every 10s — 3× safety margin vs TTL
const MAX_HEARTBEAT_FAILURES = 3;
const DEBOUNCE_MS = 500;

/**
 * Max concurrent `processFile` ingests fired by the watcher's debounce timers.
 *
 * A bulk `rsync`/copy into a watched library fires an `add`/`change` event per
 * file; without a cap, a burst of a few hundred debounce timers landing at
 * once would fire that many concurrent DB-writing ingests OUTSIDE the task
 * system's own concurrency controls (the bulk file-library-scan caps at
 * `SCAN_CONCURRENCY=8` for exactly this reason). Kept intentionally small —
 * the watcher's job is "don't miss a live change", not "ingest a burst fast";
 * a full backfill is the bulk scanner's job.
 */
export const WATCHER_INGEST_CONCURRENCY = 4;
export const WATCHER_NATIVE_BACKLOG_LIMIT = 8192;

/** Network filesystems that need periodic reconciliation for remote writes. */
const NETWORK_FS_TYPES = new Set([
    'nfs',
    'nfs4',
    'cifs',
    'smb3',
    'smbfs',
    'fuse.sshfs',
    'fuse.glusterfs',
    'glusterfs',
    'ceph',
    'afs',
    'lustre',
    // Remote-backed FUSE and cluster filesystems used for media libraries.
    'beegfs',
    'gpfs',
    'moosefs',
    'fuse.moosefs',
    'fuse.rclone',
    'fuse.mergerfs',
    'mergerfs',
    'fuse.s3fs',
    'fuse.juicefs',
    '9p',
]);

// /proc/mounts (and /etc/mtab) octal-escape four bytes in field values: space
// (\040), tab (\011), newline (\012), and backslash (\134) — anything else
// that would otherwise break the space-delimited format.
const MOUNT_ESCAPE_RE = /\\(040|011|012|134)/g;
const MOUNT_ESCAPES: Record<string, string> = {
    '040': ' ',
    '011': '\t',
    '012': '\n',
    '134': '\\',
};

function unescapeMountField(raw: string): string {
    return raw.replace(MOUNT_ESCAPE_RE, (match, code: string) => MOUNT_ESCAPES[code] ?? match);
}

/**
 * Mount points backed by a network filesystem, read from `/proc/mounts` — a
 * local kernel virtual file (instant, never touches the network mount). Returns
 * [] on non-Linux (dev) or if unreadable, so the watcher behaves exactly as
 * before on local disks.
 */
function readNetworkMountPoints(): string[] {
    try {
        const txt = readFileSync('/proc/mounts', 'utf8');
        const points: string[] = [];
        for (const line of txt.split('\n')) {
            const fields = line.split(' '); // device mountpoint fstype options dump pass
            if (fields.length >= 3 && NETWORK_FS_TYPES.has(fields[2])) {
                points.push(unescapeMountField(fields[1]));
            }
        }
        return points;
    } catch {
        return [];
    }
}

export function isUnderMount(path: string, mount: string): boolean {
    if (path === mount) return true;
    return path.startsWith(mount.endsWith('/') ? mount : `${mount}/`);
}

// Status key written by the leader every heartbeat — lets non-leader replicas
// check whether the watcher is alive without polling the lock value.
export const WATCHER_STATUS_KEY = 'v1:file-scanner:watcher-heartbeat';
// TTL matches the lock TTL: the key stays valid as long as the lock itself could.
const WATCHER_STATUS_TTL = LOCK_TTL_SECONDS;

/** Why live updates are incomplete without the watcher being broken. */
export type WatcherLimitation =
    | 'watch_limit'
    | 'network_shares'
    | 'network_unreconciled'
    | 'unreadable_dirs'
    | 'stalled_probes'
    | 'stalled_roots'
    | 'unwatched_dirs';

export interface WatcherHeartbeatStatus {
    lastHeartbeatAt: string;
    paths: number;
    lastError?: string;
    /** Native watcher only: `partial` while some directories are not being watched. */
    coverage?: 'full' | 'partial';
    limitations?: WatcherLimitation[];
    /** Interval of the child's network-root reconcile; 0 = off. */
    networkReconcileSecs?: number;
}

export interface WatcherRuntimeState {
    implementation: 'rust';
    /** degraded = running with partial coverage / watch_limit / lease fence; failed = fatal or drain failure. */
    state: 'stopped' | 'starting' | 'ready' | 'degraded' | 'failed';
    coverage?: 'full' | 'partial';
    limitations: string[];
    restarts: number;
    lastRestartAt?: string;
    lastError?: string;
    leaseHeld: boolean;
    /** Native watcher with network roots: reconcile interval in seconds (0 = disabled). */
    networkReconcileSecs?: number;
    /** PID of the native watcher child while one runs. */
    pid?: number;
}

const DEFAULT_NETWORK_RECONCILE_SECS = 900;

/**
 * `LUMASTRA_WATCH_NETWORK_RECONCILE_SECS`: seconds between full reconciles of network roots
 * by the native child. Unset/empty/invalid -> 900, `0` disables, other values are clamped to
 * 60..86400 (the range the child accepts).
 */
export function parseNetworkReconcileSecs(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === '') return DEFAULT_NETWORK_RECONCILE_SECS;
    const value = Number(raw.trim());
    if (!Number.isInteger(value) || value < 0) {
        logger.warn('Ignoring invalid LUMASTRA_WATCH_NETWORK_RECONCILE_SECS; using the default', {
            value: raw,
            default: DEFAULT_NETWORK_RECONCILE_SECS,
        });
        return DEFAULT_NETWORK_RECONCILE_SECS;
    }
    if (value === 0) return 0;
    const clamped = Math.min(
        Math.max(value, NATIVE_WATCHER_NETWORK_RECONCILE_MIN_SECS),
        NATIVE_WATCHER_NETWORK_RECONCILE_MAX_SECS,
    );
    if (clamped !== value)
        logger.warn('LUMASTRA_WATCH_NETWORK_RECONCILE_SECS out of range; clamped', {
            value,
            clamped,
        });
    return clamped;
}

/** The subset of `paths` that lives on a network filesystem (read from /proc/mounts). */
export function computeNetworkPaths(paths: string[]): string[] {
    const mounts = readNetworkMountPoints();
    if (mounts.length === 0) return [];
    return paths.filter((path) => mounts.some((mount) => isUnderMount(path, mount)));
}

interface NativeInit {
    policy: NativeWatcherPolicyV2;
    networkPaths: string[];
    networkReconcileSecs: number;
}

// The native child waits for 500 ms of write stability; the host adds a per-path debounce.
export type ProcessFileFn = (
    sql: PluginContext['sql'],
    filePath: string,
    context: PluginContext,
) => Promise<void>;

export class WatcherLeader {
    private lockValue: string | null = null;
    private watcher: NativeWatcherProcess | null = null;
    private stopping = false;
    private pendingStop: Promise<void> | null = null;
    private releaseOnStop = false;
    private repairPending = false;
    private nativeDrainFailure: Error | null = null;
    /** Native child's last `status` frame and the operator-facing notice derived from errors. */
    private nativeStatus: NativeWatcherStatus | null = null;
    private nativeWatchLimit = false;
    private nativeNotice: string | null = null;
    private nativeNetworkPaths: string[] = [];
    /** True from the first failed lease renewal until a renewal succeeds again. */
    private leaseLost = false;
    private leaseValidUntil = 0;
    private nativeNetworkReconcileSecs = 0;
    private nativeReady = false;
    private fatalError: string | null = null;
    private restartCount = 0;
    private lastRestartAt: string | null = null;
    private nativeOverflow = false;
    private readonly nativeDeletionLimiter = new AsyncSemaphore(WATCHER_INGEST_CONCURRENCY);
    private rescan: WatcherRescanCoalescer | null = null;
    private repairGeneration = 0;
    private repairRoots: { generation: number; pending: Set<string> } | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private context: PluginContext | null = null;
    private consecutiveHeartbeatFailures = 0;
    private pendingDebounces = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly processFile: ProcessFileFn;
    private _watchedPaths: number = 0;
    /**
     * The currently-watched path set, sorted, for change detection in
     * updatePaths. The ensure-watcher timer (hooks.server.ts) calls updatePaths
     * unconditionally every ~60s; without this guard each call tore down and
     * rebuilt the native watcher, which dropped any in-flight `add`/`change` debounce and
     * left a brief no-watcher window — so newly-added files could be missed
     * entirely until the next full scan. We only rebuild when the set actually
     * changes.
     */
    private _currentPaths: string[] = [];
    /**
     * Per-library-root deletion breaker: root → epoch-ms until which `unlink`
     * events under that root are ignored WITHOUT re-probing the filesystem.
     *
     * Set when `assessFilePresence` classifies a root as `'transient'` (the
     * whole mount went offline — the library root itself is gone). When an NFS
     * share drops, deletion observations can arrive for many files at once;
     * deleting them all from the DB would be catastrophic data loss the moment
     * the mount returns. The cooldown lets the FIRST vanished file park the
     * root, then short-circuits the rest of the storm so we neither delete nor
     * hammer the fs-guard once per file. Cleared on a confirmed real deletion
     * and on stop()/path-update alongside `_currentPaths`.
     */
    private _unhealthyRootUntil = new Map<string, number>();
    private _lastEventAt: Date | null = null;
    private _lastEventFile: string | null = null;
    private _starting = false;
    /**
     * Bumped by every stop() call (synchronously, before it queues onto
     * `_lifecycle`). start() snapshots this on entry; if it has moved by the
     * time `_startInner` resolves successfully, a stop() request was made
     * while start() was inside its lock-retry sleep (see `_lifecycle` doc
     * below) and effectively no-op'd against a not-yet-live watcher. start()
     * then tears down the watcher it just brought up instead of leaving it
     * running out from under a caller who believes stop() won.
     */
    private _stopGeneration = 0;
    /**
     * Serializes stop() and updatePaths(). Both are reachable concurrently
     * (60s ensure timer, admin path changes, fatal-error handlers, heartbeat
     * loss) and both tear down / rebuild `this.watcher`; unserialized, two
     * overlapping updatePaths calls can each construct a NativeWatcherProcess and
     * orphan one (leaked child firing duplicate events), and a stop()
     * landing inside updatePaths' close→rebuild window resurrects a watcher
     * with no lock/heartbeat. start() stays outside this lock (its lock-retry
     * sleeps can hold it ~75s) — it is guarded by `_starting`, and a stop()
     * that lands during that window (finding watcher/lockValue still null,
     * so it no-ops) is caught after the fact via the `_stopGeneration` check
     * above; any other start/stop interleaving self-heals via the ensure
     * timer.
     */
    private _lifecycle: Promise<unknown> = Promise.resolve();
    /** Bounds concurrent watcher-triggered ingests — see WATCHER_INGEST_CONCURRENCY. */
    private readonly ingestLimiter = new AsyncSemaphore(WATCHER_INGEST_CONCURRENCY);
    /** How long a root stays in the deletion breaker after a transient outage. */
    private static readonly UNHEALTHY_ROOT_COOLDOWN_MS = 10_000;

    private withLifecycleLock<T>(fn: () => Promise<T>): Promise<T> {
        const run = this._lifecycle.then(fn, fn);
        this._lifecycle = run.catch(() => {});
        return run;
    }

    constructor(processFile: ProcessFileFn) {
        this.processFile = processFile;
    }

    /**
     * Attempt to become the watcher leader and start the native watcher.
     * Returns true if this replica is now the leader.
     * Returns false if another replica holds the lock (normal — do nothing).
     *
     * Retries up to 3 times with a delay slightly longer than the lock TTL.
     * This handles stale locks from a previous container incarnation that
     * haven't expired yet when this replica starts.
     */
    async start(context: PluginContext, paths: string[]): Promise<boolean> {
        if (this.nativeDrainFailure) throw this.nativeDrainFailure;
        if (this.stopping) return false;
        if (this.isActive()) {
            logger.debug('Watcher already active, ignoring start()');
            return true;
        }
        if (this._starting) return false;
        this._starting = true;
        const generationAtEntry = this._stopGeneration;
        try {
            const started = await this._startInner(context, paths);
            if (started && generationAtEntry !== this._stopGeneration) {
                // A stop() call landed while we were inside _startInner's
                // lock-retry sleep window (up to ~105s) — at that moment
                // watcher/lockValue were still null, so that stop() found
                // nothing to tear down and no-op'd. Don't leave a live
                // watcher behind that the caller believes is stopped: tear
                // it down now, through the same lifecycle-locked path stop()
                // itself uses.
                logger.warn(
                    'start() completed after a concurrent stop() request — tearing down the just-started watcher',
                );
                await this.withLifecycleLock(() => this._stopInner(true));
                return false;
            }
            return started;
        } finally {
            this._starting = false;
        }
    }

    private nativeBacklogFull(): boolean {
        const count =
            this.pendingDebounces.size +
            this.ingestLimiter.waiting +
            this.nativeDeletionLimiter.waiting;
        if (count < WATCHER_NATIVE_BACKLOG_LIMIT) {
            if (count < WATCHER_NATIVE_BACKLOG_LIMIT / 2) this.nativeOverflow = false;
            return false;
        }
        if (!this.nativeOverflow) {
            this.nativeOverflow = true;
            logger.warn('Native watcher callback backlog full; requesting bounded reconciliation');
        }
        this.requestReconciliation();
        return true;
    }

    private requestReconciliation(): void {
        // A newer observation gap invalidates earlier per-root admissions, even
        // while the previous submission is settling. The coalescer retains the
        // newer dirty request; its next pass must snapshot every relevant root.
        this.repairGeneration++;
        this.rescan?.request();
    }

    private extendLease(): void {
        this.leaseValidUntil = Date.now() + LOCK_TTL_SECONDS * 1000 - LEASE_SAFETY_MARGIN_MS;
    }

    /**
     * Fenced = a renewal failed, or the last successful one is too old for the lease to be
     * trusted. While fenced no event is dispatched and no DB mutation is made.
     */
    private isFenced(): boolean {
        if (this.leaseLost) return true;
        return this.lockValue !== null && Date.now() >= this.leaseValidUntil;
    }

    private dispatchWatcherEvent(event: 'add' | 'change' | 'unlink', filePath: string): void {
        // Fenced: without a confirmed lease another replica may be the leader. Events are
        // dropped and a reconciliation is requested once the lease renews again.
        if (this.isFenced()) return;
        if (event !== 'unlink') {
            this.scheduleProcess(filePath);
            return;
        }
        if (this.nativeBacklogFull()) {
            // Preserve create→delete cancellation even when detailed deletion work overflows.
            const timer = this.pendingDebounces.get(filePath);
            if (timer !== undefined) {
                clearTimeout(timer);
                this.pendingDebounces.delete(filePath);
            }
            return;
        }
        const deletion = this.nativeDeletionLimiter.withPermit(() => this.handleUnlink(filePath));
        void deletion.catch((error: unknown) => {
            logger.warn('Error handling watched file deletion', { filePath }, error as Error);
        });
    }

    private createWatcher(
        options: Pick<NativeWatcherOptions, 'paths' | 'onEvent' | 'onError' | 'onReady'>,
        nativeInit: NativeInit,
    ): NativeWatcherProcess {
        if (!this.rescan) {
            this.rescan = new WatcherRescanCoalescer(
                async () => {
                    if (!this.context || !this.lockValue) return false;
                    const generation = this.repairGeneration;
                    const { getEnabledLibraryPaths } =
                        await import('../../../../../../database/queries/library-paths.queries.js');
                    const paths = await getEnabledLibraryPaths(this.context.sql);
                    const watched = new Set(this._currentPaths.map((root) => resolve(root)));
                    const eligible = paths.filter((path) => watched.has(resolve(path.path)));
                    let repair = this.repairRoots;
                    if (!repair || repair.generation !== generation) {
                        repair = {
                            generation,
                            pending: new Set(eligible.map((path) => path.id)),
                        };
                        this.repairRoots = repair;
                    }
                    const eligibleIds = new Set(eligible.map((path) => path.id));
                    // Roots disabled/removed while retrying no longer need repair.
                    for (const id of repair.pending) {
                        if (!eligibleIds.has(id)) repair.pending.delete(id);
                    }
                    const { orchestrator } =
                        await import('../../../../../../tasks/orchestrator.js');
                    for (const path of eligible) {
                        if (!repair.pending.has(path.id)) continue;
                        if (!this.context || !this.lockValue) return false;
                        // A global fanout can be accepted while its scoped child is
                        // deduped to a scan that already passed the changed file.
                        // Observe the actual path admission and retain repair until
                        // a fresh scan is admitted for every watched enabled root.
                        const result = await orchestrator.startRun(
                            'file-library-scan',
                            { libraryPathId: path.id },
                            {
                                libraryGroupId: path.library_group_id,
                                trigger: {
                                    kind: 'in-process',
                                    sourceRoute: 'file-scanner.native-watcher-reconciliation',
                                },
                            },
                        );
                        // Keep accepted roots out of THIS generation's retries:
                        // otherwise A accepted/B deduped followed by A deduped/B
                        // accepted could keep the latch alive forever.
                        // A queued scan (including a delayed retry) will start
                        // after this observation and cover the gap. An active
                        // scan may already have passed it, so retain that latch.
                        if (
                            !result.deduped ||
                            (await orchestrator.isRunQueued(
                                'file-library-scan',
                                { libraryPathId: path.id },
                                result.runId,
                            ))
                        ) {
                            repair.pending.delete(path.id);
                        }
                    }
                    if (repair.pending.size > 0) return false;
                    if (this.repairGeneration === generation) this.repairRoots = null;
                    return true;
                },
                (error: unknown) => {
                    logger.warn(
                        'Native watcher reconciliation submission failed',
                        {},
                        error as Error,
                    );
                },
            );
        }
        // The native watcher suppresses its initial tree. Only request repair once
        // observation is established: a scan started before ready can finish while
        // files are still changing in the unwatched startup/upgrade interval.
        const onReady = (): void => {
            this.requestReconciliation();
            options.onReady();
        };
        this.nativeNetworkPaths = nativeInit.networkPaths;
        this.nativeNetworkReconcileSecs = nativeInit.networkReconcileSecs;
        return new NativeWatcherProcess({
            paths: options.paths,
            networkPaths: nativeInit.networkPaths,
            networkReconcileSecs: nativeInit.networkReconcileSecs,
            policy: nativeInit.policy,
            onEvent: options.onEvent,
            onError: (info) => {
                this.noteNativeError(info);
                options.onError(info);
            },
            onStatus: (status) => {
                this.applyNativeStatus(status);
            },
            onRestart: () => {
                this.restartCount++;
                this.lastRestartAt = new Date().toISOString();
                this.nativeReady = false;
            },
            onReady: () => {
                this.nativeReady = true;
                // A new child reports its own coverage; forget the previous child's.
                this.nativeStatus = null;
                this.nativeWatchLimit = false;
                this.nativeNotice = null;
                onReady();
            },
            onRescan: (reason: string) => {
                logger.warn('Native watcher requested library reconciliation', { reason });
                this.requestReconciliation();
            },
        });
    }

    private async _startInner(context: PluginContext, pathsIn: string[]): Promise<boolean> {
        const networkReconcileSecs = parseNetworkReconcileSecs(
            process.env.LUMASTRA_WATCH_NETWORK_RECONCILE_SECS,
        );
        const obsoleteSettings = [
            ...(process.env.LUMASTRA_WATCHER_IMPLEMENTATION !== undefined
                ? ['LUMASTRA_WATCHER_IMPLEMENTATION']
                : []),
            ...(process.env.LUMASTRA_WATCH_NETWORK_FS?.toLowerCase() === 'false'
                ? ['LUMASTRA_WATCH_NETWORK_FS=false']
                : []),
        ];
        if (!warnedObsoleteWatcherSettings && obsoleteSettings.length > 0) {
            warnedObsoleteWatcherSettings = true;
            const networkStatus =
                networkReconcileSecs === 0
                    ? 'network mounts are watched; periodic network reconciliation is disabled (0 s)'
                    : `network mounts are watched and reconciled every ${networkReconcileSecs} s`;
            logger.warn(
                `${obsoleteSettings.join(', ')}: no longer supported; the native watcher is always used; ${networkStatus}`,
            );
        }
        // Nothing to watch needs no binary (a fresh install, or a worker before setup).
        const paths = pathsIn;
        if (paths.length === 0) {
            logger.debug('No library paths configured, skipping watch');
            return false;
        }
        // Reject missing/incompatible binaries before acquiring a lease.
        try {
            await verifyNativeWatcherBinary();
        } catch (error) {
            this.nativeNotice = error instanceof Error ? error.message : String(error);
            this.fatalError = this.nativeNotice;
            logger.error(
                'Native watcher preflight failed; not watching',
                error instanceof Error ? error : new Error(String(error)),
            );
            throw error;
        }
        const nativeInit = await this.buildNativeInit(paths, networkReconcileSecs);

        // Try to acquire the distributed lock, retrying if a stale lock exists.
        // On container restart both replicas may fail because the old lock
        // (TTL=30s) is still alive. Retrying after the TTL ensures one of them
        // eventually becomes the leader.
        const MAX_ATTEMPTS = 3;
        const RETRY_DELAY_MS = (LOCK_TTL_SECONDS + 5) * 1000; // wait for TTL + margin

        // A failed final reconciliation retained this lease/context after reaping the
        // child. An explicit restart may resume watching and the repair latch under
        // that SAME confirmed owner; it must not acquire a competing replacement.
        const retainedOwner =
            this.lockValue !== null && this.context !== null && this.watcher === null;
        let lockValue = retainedOwner ? this.lockValue : null;
        if (
            retainedOwner &&
            (!lockValue || !(await renewLock(LOCK_KEY, lockValue, LOCK_TTL_SECONDS)))
        ) {
            throw new Error(
                'Cannot resume watcher with unresolved repair and unconfirmed lease; outcome UNKNOWN',
            );
        }
        for (let attempt = 1; !lockValue && attempt <= MAX_ATTEMPTS; attempt++) {
            lockValue = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS);
            if (lockValue) break;

            if (attempt < MAX_ATTEMPTS) {
                logger.info(
                    `Watcher lock held (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying after ${RETRY_DELAY_MS / 1000}s in case it is stale`,
                );
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            }
        }

        if (!lockValue) {
            logger.info('Watcher lock held by another replica — this replica will not watch');
            return false;
        }

        this.lockValue = lockValue;
        this.context = context;
        this.consecutiveHeartbeatFailures = 0;
        this.leaseLost = false;
        this.extendLease();
        this.fatalError = null;
        this.nativeReady = false;
        this.rescan?.resume();

        // Start heartbeat BEFORE the native watcher — ensures lock stays alive
        this.heartbeatTimer ??= setInterval(() => {
            void this.runHeartbeat().catch((error: unknown) => {
                logger.warn('Watcher heartbeat/stop failed', {}, error as Error);
            });
        }, HEARTBEAT_INTERVAL_MS);

        // Start the supervised native watcher child.
        this._watchedPaths = paths.length;
        this._currentPaths = [...paths].sort();
        this.watcher = this.createWatcher(
            {
                paths,
                onEvent: (event, filePath) => {
                    this.dispatchWatcherEvent(event, filePath);
                },
                onError: ({ message, code, fatal }) => {
                    if (!fatal) {
                        logger.warn(
                            'File watcher transient FS error — ignoring (file-library-scan will resync)',
                            { code, message },
                        );
                        return;
                    }
                    logger.error('File watcher fatal error — stopping watcher', new Error(message));
                    this.stopAfterFatalError();
                },
                onReady: () => {},
            },
            nativeInit,
        );
        this.watcher.start();

        await this.writeHeartbeatStatus();
        logger.info('File watcher started (leader)', { paths, lockValue });
        return true;
    }

    /**
     * Stop the watcher and release the lock.
     * @param doReleaseLock - set false when we're stopping due to lost lock (let TTL expire)
     */
    stop(doReleaseLock = true): Promise<void> {
        // Bump synchronously (before queueing onto `_lifecycle`) so a start()
        // currently sleeping inside its lock-retry loop can observe this stop
        // request even though the underlying _stopInner() work is serialized
        // behind the lifecycle lock. See `_stopGeneration` doc.
        this._stopGeneration++;
        this.releaseOnStop ||= doReleaseLock;
        if (this.pendingStop) return this.pendingStop;
        this.stopping = true;
        this.pendingStop = this.withLifecycleLock(() => this._stopInner(doReleaseLock)).finally(
            () => {
                this.pendingStop = null;
                this.releaseOnStop = false;
                if (!this.nativeDrainFailure) this.stopping = false;
            },
        );
        return this.pendingStop;
    }

    private async _stopInner(doReleaseLock: boolean): Promise<void> {
        if (this.nativeDrainFailure) throw this.nativeDrainFailure;
        // A terminal host fault requests a rescan immediately before its fatal callback.
        // Preserve that latch and flush it before discarding the leader context.
        this.rescan?.pause();
        // Cancel pending debounces first — no more processFile calls after stop
        for (const timer of this.pendingDebounces.values()) {
            clearTimeout(timer);
        }
        this.pendingDebounces.clear();

        // Cancel any pending downstream-flow batch — leadership is about to
        // hand off and our timer must not fire a flow under a no-longer-leader
        // process. Safe no-op if the singleton was never instantiated.
        cancelWatcherFlowDebouncer();

        // Keep renewing our existing lease until reaping and repair admission are
        // confirmed. A failed close/repair must not release ownership or let this
        // process claim a replacement before cleanup completes.
        if (this.watcher !== null) {
            try {
                await this.watcher.close();
            } catch (error) {
                logger.warn('Error closing file watcher', {}, error as Error);
                this.nativeDrainFailure = error instanceof Error ? error : new Error(String(error));
            }
            if (!this.nativeDrainFailure) this.watcher = null;
        }
        let repairFailure: unknown;
        if (this.rescan) {
            try {
                this.repairPending = !(await this.rescan.flush());
                if (this.repairPending)
                    repairFailure = new Error('Reconciliation was not accepted');
            } catch (error) {
                this.repairPending = true;
                repairFailure = error;
            }
        }
        if (this.nativeDrainFailure) {
            await this.abandonLeaseAfterDrainFailure(this.nativeDrainFailure);
            throw this.nativeDrainFailure;
        }
        if (this.repairPending) {
            // An in-memory latch cannot survive a clean process exit. Keep the lease,
            // context and paused latch until a retry is accepted or an explicit restart
            // resumes the same owner. Deduplication is retryable, not a permanent poison.
            throw new Error(
                'Native watcher reconciliation unresolved; cleanup incomplete; outcome UNKNOWN',
                {
                    cause: repairFailure,
                },
            );
        }

        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        // Release the lock and clear the heartbeat status (only if we still hold it).
        // On ungraceful stop (doReleaseLock=false), the status key expires via TTL.
        if ((doReleaseLock || this.releaseOnStop) && this.lockValue !== null) {
            await Promise.all([
                releaseLock(LOCK_KEY, this.lockValue),
                cacheDel(WATCHER_STATUS_KEY),
            ]);
        }

        this.lockValue = null;
        this.context = null;
        this.consecutiveHeartbeatFailures = 0;
        this.leaseLost = false;
        this._watchedPaths = 0;
        this._currentPaths = [];
        this._unhealthyRootUntil.clear();
        this.nativeStatus = null;
        this.nativeWatchLimit = false;

        logger.info('File watcher stopped');
    }

    /** True only if this replica holds the lock AND the native watcher is running */
    isActive(): boolean {
        return !this.nativeDrainFailure && this.watcher !== null && this.lockValue !== null;
    }

    /**
     * Update watched paths (e.g. after an admin enables/disables a library path).
     * If not the leader, does nothing.
     */
    updatePaths(pathsIn: string[]): Promise<void> {
        return this.withLifecycleLock(() => this._updatePathsInner(pathsIn));
    }

    private async _updatePathsInner(pathsIn: string[]): Promise<void> {
        if (this.nativeDrainFailure) throw this.nativeDrainFailure;
        if (!this.isActive() || !this.context) return;

        const paths = pathsIn;

        // Idempotency guard: the ensure-watcher timer calls this every ~60s with
        // the same path set. Rebuilding the native watcher on an unchanged set is pure
        // churn — it drops in-flight debounces and opens a no-watcher window
        // where new files can be missed. Only proceed when the set differs.
        const sorted = [...paths].sort();
        if (
            sorted.length === this._currentPaths.length &&
            sorted.every((p, i) => p === this._currentPaths[i])
        ) {
            return;
        }
        // Built before teardown so a failure leaves the running watcher untouched.
        const nativeInit = paths.length > 0 ? await this.buildNativeInit(paths) : undefined;

        // Cancel pending debounces for stale paths
        for (const timer of this.pendingDebounces.values()) {
            clearTimeout(timer);
        }
        this.pendingDebounces.clear();

        try {
            await this.watcher!.close();
        } catch (error) {
            logger.warn('Error closing watcher for path update', {}, error as Error);
            this.nativeDrainFailure = error instanceof Error ? error : new Error(String(error));
            await this.abandonLeaseAfterDrainFailure(this.nativeDrainFailure);
            throw this.nativeDrainFailure;
        }

        if (paths.length === 0) {
            // Release lock + cancel heartbeat so this replica can re-acquire
            // when paths are re-enabled later. Setting watcher=null alone would
            // leave the lock held and the heartbeat running indefinitely.
            // _stopInner (NOT stop()): we already hold the lifecycle lock —
            // queueing the public stop() behind ourselves would deadlock.
            this._currentPaths = [];
            await this._stopInner(true);
            return;
        }

        this._watchedPaths = paths.length;
        this.watcher = this.createWatcher(
            {
                paths,
                onEvent: (event, filePath) => {
                    this.dispatchWatcherEvent(event, filePath);
                },
                // Fatal startup errors must stop lease renewal as well as the child.
                onError: ({ message, code, fatal }) => {
                    if (!fatal) {
                        logger.warn(
                            'File watcher transient FS error after path update — ignoring (file-library-scan will resync)',
                            { code, message },
                        );
                        return;
                    }
                    logger.error(
                        'File watcher fatal error after path update — stopping',
                        new Error(message),
                    );
                    this.stopAfterFatalError();
                },
                onReady: () => {},
            },
            nativeInit!,
        );
        this.watcher.start();

        // Record the new set only AFTER a successful rebuild kickoff, so a
        // watcher that failed to start (handled above via stop()) doesn't leave
        // _currentPaths claiming a set that isn't actually being watched.
        this._currentPaths = sorted;
        // Roots changed → any parked deletion-breaker entries are stale.
        this._unhealthyRootUntil.clear();

        await this.writeHeartbeatStatus();
        logger.info('Watcher paths updated', { paths });
    }

    // -------------------------------------------------------------------------
    // Private

    private async buildNativeInit(
        paths: string[],
        networkReconcileSecs = parseNetworkReconcileSecs(
            process.env.LUMASTRA_WATCH_NETWORK_RECONCILE_SECS,
        ),
    ): Promise<NativeInit> {
        return {
            policy: await buildNativeWatcherPolicy(paths),
            networkPaths: computeNetworkPaths(paths),
            networkReconcileSecs,
        };
    }

    private noteNativeError(info: NativeWatcherErrorInfo): void {
        if (info.code === 'watch_limit') {
            this.nativeWatchLimit = true;
            this.nativeNotice = info.message;
            logger.error(
                'Native watcher hit the inotify watch limit; coverage is partial (scheduled scans still cover the rest)',
                new Error(info.message),
            );
        } else if (info.fatal) {
            this.nativeNotice = info.message;
            this.fatalError = info.message;
        }
    }

    private applyNativeStatus(status: NativeWatcherStatus): void {
        this.nativeStatus = status;
        this.nativeWatchLimit = status.watchLimit;
        if (!status.watchLimit && status.coverage === 'full') this.nativeNotice = null;
    }

    private onNetwork(): boolean {
        return (
            this.nativeNetworkPaths.length > 0 || (this.nativeStatus?.networkRoots.length ?? 0) > 0
        );
    }

    /** Coverage and limitations of the running native child. */
    private coverageInfo(): { coverage?: 'full' | 'partial'; limitations: WatcherLimitation[] } {
        if (!this.watcher) return { limitations: [] };
        const status = this.nativeStatus;
        const limitations: WatcherLimitation[] = [];
        if (this.nativeWatchLimit) limitations.push('watch_limit');
        const onNetwork = this.onNetwork();
        if (onNetwork) limitations.push('network_shares');
        // Without the periodic reconcile nothing but a scheduled scan finds changes there.
        const unreconciled = onNetwork && this.nativeNetworkReconcileSecs === 0;
        if (unreconciled) limitations.push('network_unreconciled');
        if ((status?.failedDirs ?? 0) > 0) limitations.push('unreadable_dirs');
        if (status?.stalledProbes) limitations.push('stalled_probes');
        const stalledRoots = (status?.stalledRoots.length ?? 0) > 0;
        if (stalledRoots) limitations.push('stalled_roots');
        if ((status?.unwatchedDirs ?? 0) > 0) limitations.push('unwatched_dirs');
        const partial =
            this.nativeWatchLimit ||
            unreconciled ||
            status?.coverage === 'partial' ||
            status?.stalledProbes === true ||
            stalledRoots ||
            (status?.unwatchedDirs ?? 0) > 0;
        return { coverage: partial ? 'partial' : 'full', limitations };
    }

    /**
     * A child that survives SIGKILL is quarantined by the host. This process can neither
     * watch nor prove the child is gone, so stop renewing and release the lease: another
     * worker (or a restart) takes over. The failure clears when the child finally closes.
     */
    private async abandonLeaseAfterDrainFailure(error: Error): Promise<void> {
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        const lockValue = this.lockValue;
        this.lockValue = null;
        this.context = null;
        this.consecutiveHeartbeatFailures = 0;
        this.leaseLost = false;
        this._watchedPaths = 0;
        this._currentPaths = [];
        this._unhealthyRootUntil.clear();
        this.fatalError = error.message;
        if (lockValue !== null) {
            try {
                await Promise.all([releaseLock(LOCK_KEY, lockValue), cacheDel(WATCHER_STATUS_KEY)]);
            } catch (releaseError) {
                logger.warn(
                    'Could not release watcher lease after drain failure; it will expire',
                    {},
                    releaseError as Error,
                );
            }
        }
        void waitForNativeWatcherQuarantineRelease().then(() => {
            if (this.nativeDrainFailure !== error) return;
            this.nativeDrainFailure = null;
            this.watcher = null;
            this.fatalError = null;
            if (!this.pendingStop) this.stopping = false;
            logger.info('Quarantined native watcher child is gone; watcher may start again');
        });
    }

    getRuntimeState(): WatcherRuntimeState {
        const { coverage, limitations } = this.coverageInfo();
        const failed = this.nativeDrainFailure !== null || this.fatalError !== null;
        const active = this.isActive();
        let state: WatcherRuntimeState['state'];
        if (failed) state = 'failed';
        else if (!active) state = this._starting ? 'starting' : 'stopped';
        else if (!this.nativeReady) state = 'starting';
        else if (coverage === 'partial' || this.isFenced()) state = 'degraded';
        else state = 'ready';
        const lastError =
            this.nativeDrainFailure?.message ?? this.fatalError ?? this.nativeNotice ?? undefined;
        const pid = this.watcher?.pid;
        return {
            implementation: 'rust',
            state,
            ...(coverage ? { coverage } : {}),
            limitations,
            restarts: this.restartCount,
            ...(this.lastRestartAt ? { lastRestartAt: this.lastRestartAt } : {}),
            ...(lastError ? { lastError } : {}),
            leaseHeld: this.lockValue !== null && !this.isFenced(),
            ...(this.onNetwork() ? { networkReconcileSecs: this.nativeNetworkReconcileSecs } : {}),
            ...(pid !== undefined ? { pid } : {}),
        };
    }

    private stopAfterFatalError(): void {
        // The caller logs the fatal message. Do not launch an independent cache write:
        // it could settle after lease release and overwrite a successor's health.
        void this.stop(false).catch((error: unknown) => {
            logger.warn('Fatal watcher stop incomplete; outcome UNKNOWN', {}, error as Error);
        });
    }

    private async runHeartbeat(): Promise<void> {
        if (!this.lockValue) return;

        let renewed = false;
        try {
            renewed = await renewLock(LOCK_KEY, this.lockValue, LOCK_TTL_SECONDS);
        } catch (error) {
            logger.warn('Watcher lease renewal threw', {}, error as Error);
        }

        if (renewed) {
            this.consecutiveHeartbeatFailures = 0;
            const wasFenced = this.isFenced();
            this.extendLease();
            if (wasFenced) {
                this.leaseLost = false;
                logger.info('Watcher lease renewed again; reconciling events missed while fenced');
                this.requestReconciliation();
            }
            await this.writeHeartbeatStatus();
        } else {
            // Fence on the FIRST failed renewal: from here the lease may belong to someone else.
            this.leaseLost = true;
            this.consecutiveHeartbeatFailures++;
            logger.warn('Watcher heartbeat failed', {
                consecutive: this.consecutiveHeartbeatFailures,
                max: MAX_HEARTBEAT_FAILURES,
            });

            if (this.consecutiveHeartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
                logger.error(
                    'Stopping watcher: heartbeat failed too many times. Lock may have expired. ' +
                        'Another replica will take over after the TTL elapses.',
                );
                // Don't release — we likely don't hold the lock anymore
                await this.stop(false);
            }
        }
    }

    /** Write current heartbeat status to Valkey so non-leader replicas can check health. */
    private async writeHeartbeatStatus(lastError?: string): Promise<void> {
        // Acceptance may happen after a same-lease restart or after a timed-out
        // flush. Keep UNKNOWN while any newer dirty request/submission remains.
        if (this.repairPending && this.rescan && !this.rescan.pending) this.repairPending = false;
        lastError ??=
            this.nativeDrainFailure?.message ??
            (this.repairPending
                ? 'Native watcher reconciliation pending; outcome UNKNOWN'
                : (this.nativeNotice ?? undefined));
        const { coverage, limitations } = this.coverageInfo();
        const payload: WatcherHeartbeatStatus = {
            lastHeartbeatAt: new Date().toISOString(),
            paths: this._watchedPaths,
            ...(lastError ? { lastError } : {}),
            ...(coverage ? { coverage, limitations } : {}),
            ...(this.onNetwork() ? { networkReconcileSecs: this.nativeNetworkReconcileSecs } : {}),
        };
        await cacheSet(WATCHER_STATUS_KEY, JSON.stringify(payload), WATCHER_STATUS_TTL);
    }

    /**
     * Read the leader's heartbeat status from Valkey.
     * Returns null if the key is absent (leader silent or never started).
     * Called by non-leader replicas to surface watcher health in the admin UI.
     */
    async getLeaderStatus(): Promise<WatcherHeartbeatStatus | null> {
        const raw = await cacheGet(WATCHER_STATUS_KEY);
        if (!raw) return null;
        try {
            return JSON.parse(raw) as WatcherHeartbeatStatus;
        } catch {
            return null;
        }
    }

    /** Get watcher status for admin dashboard */
    getStatus(): {
        active: boolean;
        paths: number;
        lastEventAt?: Date;
        lastEventFile?: string;
        lastError?: string;
        coverage?: 'full' | 'partial';
        limitations?: WatcherLimitation[];
        networkReconcileSecs?: number;
    } {
        const { coverage, limitations } = this.coverageInfo();
        const lastError = this.nativeDrainFailure?.message ?? this.fatalError ?? this.nativeNotice;
        return {
            active: this.isActive(),
            paths: this._watchedPaths,
            lastEventAt: this._lastEventAt ?? undefined,
            lastEventFile: this._lastEventFile ?? undefined,
            ...(lastError ? { lastError } : {}),
            ...(coverage ? { coverage, limitations } : {}),
            ...(this.onNetwork() ? { networkReconcileSecs: this.nativeNetworkReconcileSecs } : {}),
        };
    }

    /**
     * True if the watcher lock is held by a different replica.
     * Used by the admin dashboard to distinguish "inactive by design (another
     * replica is the leader)" from "inactive due to misconfiguration".
     */
    async isLockHeldElsewhere(): Promise<boolean> {
        if (this.isActive()) return false; // we are the leader
        return cacheExists(LOCK_KEY);
    }

    /** Debounced processFile call — cancels and reschedules if another event fires within 500ms */
    private scheduleProcess(filePath: string): void {
        // Track last event for status reporting
        this._lastEventAt = new Date();
        this._lastEventFile = filePath;

        const existing = this.pendingDebounces.get(filePath);
        if (existing === undefined && this.nativeBacklogFull()) return;
        if (existing !== undefined) clearTimeout(existing);

        const timer = setTimeout(() => {
            this.pendingDebounces.delete(filePath);
            if (!this.context || this.isFenced()) return;
            // Bounded via ingestLimiter (WATCHER_INGEST_CONCURRENCY) — a bulk
            // copy/rsync into a watched library can fire hundreds of these
            // debounce timers at once; without the cap that becomes hundreds
            // of concurrent DB-writing ingests outside the task system's own
            // concurrency controls. Re-check `this.context` inside the
            // permitted callback too: it can go null (stop()) while this
            // invocation is still queued waiting for a permit.
            void this.ingestLimiter
                .withPermit(async () => {
                    if (!this.context || this.isFenced()) return;
                    await this.processFile(this.context.sql, filePath, this.context);
                })
                .catch((error) => {
                    logger.warn('Error processing watched file', { filePath }, error as Error);
                });
        }, DEBOUNCE_MS);

        this.pendingDebounces.set(filePath, timer);
    }

    private async handleUnlink(filePath: string): Promise<void> {
        // A rapid create→delete (or delete of a file whose write-settle
        // debounce hasn't fired yet) leaves a stale pendingDebounces timer for
        // this path — left alone, it would fire later and re-ingest a file
        // that is now confirmed gone. Cancel it before anything else.
        const pendingTimer = this.pendingDebounces.get(filePath);
        if (pendingTimer !== undefined) {
            clearTimeout(pendingTimer);
            this.pendingDebounces.delete(filePath);
        }

        if (!this.context || this.isFenced()) return;

        // GUARD: the native watcher may emit phantom unlink events on transient FS errors
        // (e.g., ESTALE during a directory's scandir). Verify the file is actually gone
        // before deleting from DB. If it still exists, the unlink is spurious; the next
        // file-library-scan tick will catch any real deletions we miss.
        // safeAccess (not raw access): an unlink storm on a flapping mount must not
        // pile unbounded hung access() calls onto the shared libuv threadpool. A
        // timeout throws FsTimeoutError with no `code`, landing in the
        // "inconclusive — skip" branch below, which is the safe outcome.
        try {
            await safeAccess(filePath);
            // File still exists — phantom unlink. Skip.
            logger.warn('File watcher: ignoring phantom unlink (file still exists on disk)', {
                filePath,
            });
            return;
        } catch (err: unknown) {
            const code = (err as Error & { code?: string }).code;
            if (code !== 'ENOENT') {
                // Some other access error (permission, etc.) — treat as inconclusive and skip
                logger.warn('File watcher: skipping unlink — could not stat file', {
                    filePath,
                    code,
                });
                return;
            }
            // ENOENT confirmed — file is genuinely gone, proceed with delete
        }

        // GUARD 2 (mount-aware): the phantom check above only stats the file
        // itself. A whole-mount outage (NFS share offline) makes the file AND
        // its parent folder AND the library root all vanish at once — an ENOENT
        // that is NOT a real deletion. Walk up to the library root via
        // assessFilePresence: only a live mount (some ancestor still exists) is
        // a real deletion. A `'transient'` verdict parks the root in a short
        // cooldown so the rest of the unlink storm short-circuits here without
        // re-probing the (unhealthy) filesystem once per file.
        const root = this.resolveLibraryRoot(filePath);
        if (!root) {
            // No library root resolved — we're likely in a restart state with
            // empty _currentPaths. Skip delete to avoid mass-deletion during
            // the native watcher restart; reconcile/full-scan will catch genuine deletions.
            logger.debug(
                'File watcher: skipping unlink — no library root resolved (fail-safe during restart)',
                { filePath },
            );
            return;
        }
        const until = this._unhealthyRootUntil.get(root);
        if (until !== undefined && until > Date.now()) {
            logger.warn(
                'File watcher: skipping unlink — library root recently unhealthy (breaker open)',
                { filePath, root },
            );
            return;
        }
        const presence = await assessFilePresence(filePath, { mountRoot: root });
        if (presence !== 'missing') {
            if (presence === 'transient') {
                this._unhealthyRootUntil.set(
                    root,
                    Date.now() + WatcherLeader.UNHEALTHY_ROOT_COOLDOWN_MS,
                );
                logger.warn(
                    'File watcher: skipping unlink — library root appears offline (transient); ' +
                        'file-library-scan will resync if this is a real deletion',
                    { filePath, root },
                );
            }
            // 'present' means the mount-aware probe now sees the file — a
            // phantom that reappeared; nothing to delete either way.
            return;
        }
        // Confirmed real deletion under a live mount — clear any stale
        // breaker entry for this root so future deletions aren't skipped.
        this._unhealthyRootUntil.delete(root);

        // The awaits above can outlast the lease. A fenced leader must not mutate the DB; the
        // reconciliation requested when the lease returns finds the deletion instead.
        if (!this.context || this.isFenced()) {
            logger.warn('File watcher: skipping unlink — lease no longer held', { filePath });
            return;
        }

        // A removed lyrics sidecar isn't a media_files row — clear the sibling
        // track's file-sourced lyrics instead of attempting a stale-file delete.
        if (isLyricsSidecar(extname(filePath).toLowerCase())) {
            try {
                const cleared = await clearSidecarLyricsForDeletedFile(this.context.sql, filePath);
                if (cleared) {
                    logger.info('Cleared lyrics for removed sidecar', {
                        filePath,
                    });
                }
            } catch (error) {
                logger.warn(
                    'Error clearing lyrics for removed sidecar',
                    { filePath },
                    error as Error,
                );
            }
            return;
        }

        try {
            let { deleted, affectedItemIds, removedSizeBytes } = await deleteStaleMediaFile(
                this.context.sql,
                filePath,
            );
            let deletedPath = filePath;
            if (!deleted) {
                // No row matched the event path verbatim. The stored file_path
                // may be a different Unicode normalization form (the native watcher can
                // emit NFD on macOS while the scanner stored NFC, or vice
                // versa). Look up the actual stored bytes and retry once.
                const stored = await findMediaFilePathNfc(this.context.sql, filePath);
                if (stored && stored !== filePath && this.context && !this.isFenced()) {
                    ({ deleted, affectedItemIds, removedSizeBytes } = await deleteStaleMediaFile(
                        this.context.sql,
                        stored,
                    ));
                    deletedPath = stored;
                }
            }
            if (deleted) {
                logger.info('Removed deleted file from DB', { filePath });
                // A title that lost its earliest file (or every file) has stale
                // first_file_at / season_debut_at until something refreshes them.
                // Queued and batched per window: removing a folder fires one unlink
                // per file. Best-effort; the file is already gone from the DB.
                queueRecencyRefresh(this.context.sql, affectedItemIds ?? [], logger);
                await this.reingestUncoveredRangeFiles(deletedPath, root, removedSizeBytes);
            }
        } catch (error) {
            logger.warn('Error removing deleted file', { filePath }, error as Error);
        }
    }

    /**
     * Files that `removedPath` was standing in for are ingested now instead of
     * on the next full scan: multi-episode files it covered (`range_superseded`,
     * or a range named for its episode) link the episode it held again, and
     * other names of the same file (a hard link renamed over it, now unlinked)
     * stop being aliases. Best-effort; that scan picks up anything missed here.
     */
    private async reingestUncoveredRangeFiles(
        removedPath: string,
        root: string,
        removedSizeBytes?: number,
    ): Promise<void> {
        if (!this.context || this.isFenced()) return;
        try {
            const sql = this.context.sql;
            const candidates = new Set<string>([
                ...(await findRangeFilesSupersededBy(sql, removedPath, root)),
                ...(await findRangeFilesCoveringRemovedFile(sql, removedPath)),
            ]);
            const skippedNames = takeSkippedAliases(removedPath);
            if (removedSizeBytes !== undefined) {
                for (const p of await findUnlinkedSameSizeNames(
                    sql,
                    removedPath,
                    removedSizeBytes,
                    skippedNames,
                )) {
                    candidates.add(p);
                }
            }
            for (const p of candidates) {
                if (!this.context || this.isFenced()) return;
                await this.processFile(sql, p, this.context);
            }
        } catch (error) {
            logger.warn(
                'File watcher: re-ingesting multi-episode files a removed file covered failed',
                { filePath: removedPath },
                error as Error,
            );
        }
    }

    /**
     * Longest-prefix match of `filePath` against the currently-watched library
     * roots (`_currentPaths`). Returns the deepest matching root, or `null` if
     * the path is not under any watched root (e.g. a stale event fired after a
     * path update). The deepest match matters when one library root nests under
     * another so the mount-aware probe walks up to the correct boundary.
     */
    private resolveLibraryRoot(filePath: string): string | null {
        let best: string | null = null;
        for (const root of this._currentPaths) {
            if (isUnderMount(filePath, root) && (best === null || root.length > best.length)) {
                best = root;
            }
        }
        return best;
    }
}
