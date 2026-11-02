// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Durable singleton lease: exactly one dedicated worker may run task consumers,
// the watcher and the scheduler. A second worker started by mistake (two
// compose services, a scaled Deployment, an overlapping redeploy) waits here,
// unready, instead of consuming next to the first.
//
// Why a row lease and not a session advisory lock: an advisory lock is released
// only when PostgreSQL notices its session is gone. After a hard node loss that
// waits on server-side TCP keepalive (hours by default), so the replacement
// worker would stay locked out; behind a transaction-pooling proxy the lock
// would not hold at all. A row with a database-clock expiry frees itself
// `leaseMs` after the last renewal on every topology.
//
// Fencing: every takeover bumps `generation`, and a renewal only matches the
// holder id AND the generation it acquired, so a holder that was taken over
// learns it on its next renewal even if its id were reused.
//
// Loss deadline: measured on the local monotonic clock from the moment the last
// confirmed acquire/renew was SENT, as the minimum of the local threshold
// (`leaseMs - max(1s, leaseMs/5)`) and the remaining lease the database reported
// (`lease_until - clock_timestamp()`) minus the same margin. Residual risk: all
// expiry decisions use the database clock. If that clock steps FORWARD after our
// last confirmation, the row can expire (and a successor take it) earlier than
// our local deadline, which only learns about the step on the next renewal; the
// margin absorbs drift, not arbitrary steps. Keep the database host on NTP with
// slewing, not stepping.
//
// The lease is renewed on its OWN single connection so a saturated task pool
// (plugins holding every connection) cannot starve renewals into a false loss.
// Every request on it is raced against a timeout: a server statement timeout
// does not end a client wait on a dead socket.

import { hostname as osHostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { raceTimeout } from '$lib/server/tasks/loop-stop.js';

const log = Logger.for('WorkerLease');

const LEASE_NAME = 'tasks';
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RENEW_MS = 5_000;
const DEFAULT_RETRY_MS = 5_000;
/** A refused worker repeats the "who holds it" warning at most this often. */
const REFUSED_LOG_INTERVAL_MS = 60_000;

/** Snapshot for health/heartbeat surfaces. */
export interface WorkerLeaseState {
    /** True while THIS process holds the lease. */
    held: boolean;
    /** This process when held; otherwise the worker seen holding it, if any. */
    holder?: string;
    /** When `holder` acquired the lease (ISO, database clock). */
    since?: string;
    /** When `holder` last renewed it (ISO, database clock). */
    lastRenewAt?: string;
    /**
     * When THIS worker last received a renewal confirmation (ISO, this
     * worker's clock). Compare it with local time; `lastRenewAt` is on the
     * database clock.
     */
    lastRenewLocalAt?: string;
}

/** The lease row as read from PostgreSQL. */
export interface WorkerLeaseHolder {
    holderId: string;
    hostname: string;
    pid: number;
    generation: string;
    acquiredAt: string;
    renewedAt: string;
    leaseUntil: string;
}

export type WorkerLeaseAcquireResult =
    | { acquired: true }
    | { acquired: false; holder: WorkerLeaseHolder | undefined };

export interface WorkerLeaseOptions {
    name?: string;
    holderId?: string;
    hostname?: string;
    pid?: number;
    leaseMs?: number;
    renewMs?: number;
    retryMs?: number;
    /** Fired once when the lease is lost while held (taken over, expired, or renewals failing). */
    onLost?: (reason: string) => void;
}

interface LeaseRow {
    holder_id: string;
    hostname: string;
    pid: number;
    generation: string;
    acquired_at: Date;
    renewed_at: Date;
    lease_until: Date;
    remaining_ms: number | string;
}

function describeHolder(holder: WorkerLeaseHolder): string {
    return `${holder.holderId} (host ${holder.hostname}, pid ${holder.pid})`;
}

function toHolder(row: LeaseRow): WorkerLeaseHolder {
    return {
        holderId: row.holder_id,
        hostname: row.hostname,
        pid: row.pid,
        generation: String(row.generation),
        acquiredAt: new Date(row.acquired_at).toISOString(),
        renewedAt: new Date(row.renewed_at).toISOString(),
        leaseUntil: new Date(row.lease_until).toISOString(),
    };
}

/** Sleep `ms`, rejecting with the signal's reason as soon as it aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export class WorkerLease {
    readonly holderId: string;
    private readonly name: string;
    private readonly hostname: string;
    private readonly pid: number;
    private readonly leaseMs: number;
    private readonly renewMs: number;
    private readonly retryMs: number;
    private readonly marginMs: number;
    /** Local threshold: loss this long after the last confirmed request was sent. */
    private readonly lossThresholdMs: number;
    private readonly onLost: ((reason: string) => void) | undefined;

    private held = false;
    /** Generation we acquired (text: bigint). Renewals must match it. */
    private generationHeld: string | undefined;
    private acquiredAt: string | undefined;
    private lastRenewAt: string | undefined;
    private lastRenewLocalAt: string | undefined;
    /** Last foreign holder seen while refused (diagnostics). */
    private observedHolder: WorkerLeaseHolder | undefined;
    /** Local monotonic deadline (ns) after which the lease counts as lost. */
    private deadlineNs: bigint | null = null;
    private renewTimer: ReturnType<typeof setInterval> | null = null;
    private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    private renewing: Promise<void> | null = null;
    private epoch = 0;

    constructor(
        private readonly sql: postgres.Sql,
        options: WorkerLeaseOptions = {},
    ) {
        this.name = options.name ?? LEASE_NAME;
        this.hostname = options.hostname ?? osHostname();
        this.pid = options.pid ?? process.pid;
        this.holderId = options.holderId ?? `${config.INSTANCE_ID}:${randomUUID()}`;
        this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
        this.renewMs = options.renewMs ?? DEFAULT_RENEW_MS;
        this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
        this.marginMs = Math.min(Math.max(1_000, this.leaseMs / 5), this.leaseMs / 2);
        this.lossThresholdMs = this.leaseMs - this.marginMs;
        if (!(this.renewMs > 0 && this.renewMs < this.lossThresholdMs))
            throw new Error(
                `WorkerLease: renew interval ${this.renewMs} ms must be below the loss threshold ${this.lossThresholdMs} ms`,
            );
        this.onLost = options.onLost;
    }

    isHeld(): boolean {
        return this.held;
    }

    state(): WorkerLeaseState {
        if (this.held)
            return {
                held: true,
                holder: `${this.holderId} (host ${this.hostname}, pid ${this.pid})`,
                since: this.acquiredAt,
                lastRenewAt: this.lastRenewAt,
                lastRenewLocalAt: this.lastRenewLocalAt,
            };
        if (this.observedHolder)
            return {
                held: false,
                holder: describeHolder(this.observedHolder),
                since: this.observedHolder.acquiredAt,
                lastRenewAt: this.observedHolder.renewedAt,
            };
        return { held: false };
    }

    /**
     * One attempt. Takes the lease when it is free, expired (by the database
     * clock), or already ours; otherwise reports the live holder. A takeover
     * bumps the fencing generation.
     */
    async tryAcquire(): Promise<WorkerLeaseAcquireResult> {
        if (this.held) return { acquired: true };
        const sentNs = process.hrtime.bigint();
        const rows = await raceTimeout(
            this.sql<LeaseRow[]>`
                INSERT INTO task_worker_lease AS l
                    (name, holder_id, hostname, pid, generation, acquired_at, renewed_at, lease_until)
                VALUES (
                    ${this.name}, ${this.holderId}, ${this.hostname}, ${this.pid}, 1,
                    clock_timestamp(), clock_timestamp(),
                    clock_timestamp() + ${this.leaseMs}::integer * interval '1 millisecond'
                )
                ON CONFLICT (name) DO UPDATE SET
                    holder_id = EXCLUDED.holder_id,
                    hostname = EXCLUDED.hostname,
                    pid = EXCLUDED.pid,
                    generation = CASE WHEN l.holder_id = EXCLUDED.holder_id
                        THEN l.generation ELSE l.generation + 1 END,
                    acquired_at = CASE WHEN l.holder_id = EXCLUDED.holder_id
                        THEN l.acquired_at ELSE EXCLUDED.acquired_at END,
                    renewed_at = EXCLUDED.renewed_at,
                    lease_until = EXCLUDED.lease_until
                WHERE l.lease_until <= clock_timestamp() OR l.holder_id = EXCLUDED.holder_id
                RETURNING holder_id, hostname, pid, generation::text AS generation,
                    acquired_at, renewed_at, lease_until,
                    EXTRACT(EPOCH FROM (lease_until - clock_timestamp())) * 1000 AS remaining_ms
            `,
            this.lossThresholdMs,
            'worker lease acquisition',
        );
        const row = rows[0];
        if (!row) {
            const [current] = await raceTimeout(
                this.sql<LeaseRow[]>`
                    SELECT holder_id, hostname, pid, generation::text AS generation,
                        acquired_at, renewed_at, lease_until, 0 AS remaining_ms
                    FROM task_worker_lease WHERE name = ${this.name}
                `,
                this.lossThresholdMs,
                'worker lease holder lookup',
            );
            this.observedHolder = current ? toHolder(current) : undefined;
            return { acquired: false, holder: this.observedHolder };
        }
        const holder = toHolder(row);
        this.held = true;
        this.epoch++;
        this.generationHeld = holder.generation;
        this.observedHolder = undefined;
        this.acquiredAt = holder.acquiredAt;
        this.lastRenewAt = holder.renewedAt;
        this.lastRenewLocalAt = new Date().toISOString();
        this.deadlineNs = null;
        this.confirm(sentNs, Number(row.remaining_ms));
        this.startRenewLoop();
        log.info('Worker singleton lease acquired', {
            holder: this.holderId,
            hostname: this.hostname,
            pid: this.pid,
            generation: holder.generation,
            leaseMs: this.leaseMs,
        });
        return { acquired: true };
    }

    /**
     * Retry until the lease is ours. While another live worker holds it, log
     * who (on change, and every minute) and keep waiting. Rejects with the
     * signal's reason on abort; transient database errors are retried.
     */
    async acquire(signal?: AbortSignal): Promise<void> {
        let lastLogged: { key: string; at: number } | undefined;
        for (;;) {
            signal?.throwIfAborted();
            try {
                const result = await this.tryAcquire();
                if (result.acquired) return;
                signal?.throwIfAborted();
                const key = result.holder?.holderId ?? '';
                const now = performance.now();
                if (
                    !lastLogged ||
                    lastLogged.key !== key ||
                    now - lastLogged.at >= REFUSED_LOG_INTERVAL_MS
                ) {
                    lastLogged = { key, at: now };
                    log.warn(
                        result.holder
                            ? `Another worker holds the singleton lease: ${describeHolder(result.holder)}, since ${result.holder.acquiredAt} — not starting task consumers; retrying`
                            : 'Singleton lease changed hands during acquisition — retrying',
                        {
                            holder: result.holder?.holderId,
                            hostname: result.holder?.hostname,
                            pid: result.holder?.pid,
                            since: result.holder?.acquiredAt,
                            leaseUntil: result.holder?.leaseUntil,
                            retryMs: this.retryMs,
                        },
                    );
                }
            } catch (err) {
                if (signal?.aborted) throw signal.reason;
                log.warn('Worker singleton lease acquisition failed; retrying', {
                    error: err instanceof Error ? err.message : String(err),
                    retryMs: this.retryMs,
                });
            }
            await sleep(this.retryMs, signal);
        }
    }

    /** Stop renewing without touching the row (it expires `leaseMs` after the last renewal). */
    stop(): void {
        this.held = false;
        this.epoch++;
        if (this.renewTimer) {
            clearInterval(this.renewTimer);
            this.renewTimer = null;
        }
        if (this.deadlineTimer) {
            clearTimeout(this.deadlineTimer);
            this.deadlineTimer = null;
        }
    }

    /**
     * Give the lease up so a waiting worker can take it immediately. Bounded:
     * on a hung connection it throws `UNKNOWN` after one lease duration and the
     * row expires by itself.
     */
    async release(): Promise<void> {
        const wasHeld = this.held;
        const generation = this.generationHeld;
        this.stop();
        // A renewal sent before stop() must not land after the delete.
        if (this.renewing)
            await raceTimeout(
                this.renewing.catch(() => undefined),
                this.leaseMs,
                'worker lease pending renewal',
            );
        if (!wasHeld || generation === undefined) return;
        await raceTimeout(
            this.sql`
                DELETE FROM task_worker_lease
                WHERE name = ${this.name} AND holder_id = ${this.holderId}
                    AND generation = ${generation}::bigint
            `,
            this.leaseMs,
            'worker lease release',
        );
        log.info('Worker singleton lease released', { holder: this.holderId });
    }

    /**
     * Record a confirmation: the request was sent at `sentNs` and the database
     * reported `remainingMs` of lease left. The newest confirmation wins: it
     * carries the database's latest view of the expiry.
     */
    private confirm(sentNs: bigint, remainingMs: number): void {
        const allowedMs = Math.min(
            this.lossThresholdMs,
            Number.isFinite(remainingMs) ? remainingMs - this.marginMs : this.lossThresholdMs,
        );
        const deadline = sentNs + BigInt(Math.max(0, Math.floor(allowedMs))) * 1_000_000n;
        this.deadlineNs = deadline;
        this.armDeadline();
    }

    private declareLost(reason: string): void {
        if (!this.held) return;
        this.stop();
        log.error(`Worker singleton lease lost (${reason}) — this worker must stop consuming`, {
            holder: this.holderId,
            reason,
        });
        this.onLost?.(reason);
    }

    private checkDeadline(): boolean {
        if (!this.held || this.deadlineNs === null) return false;
        const now = process.hrtime.bigint();
        if (now < this.deadlineNs) return false;
        this.declareLost('no confirmed renewal within the lease safety margin');
        return true;
    }

    private armDeadline(): void {
        if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
        this.deadlineTimer = null;
        if (!this.held || this.deadlineNs === null) return;
        const remainingMs = Number((this.deadlineNs - process.hrtime.bigint()) / 1_000_000n);
        this.deadlineTimer = setTimeout(
            () => {
                this.deadlineTimer = null;
                if (!this.checkDeadline()) this.armDeadline();
            },
            Math.max(0, remainingMs + 1),
        );
        this.deadlineTimer.unref?.();
    }

    private startRenewLoop(): void {
        if (this.renewTimer) return;
        this.renewTimer = setInterval(() => {
            if (!this.held || this.checkDeadline()) return;
            // Never stack renewals behind a hung one; the deadline bounds it.
            if (this.renewing) return;
            this.renewing = this.renewOnce(this.epoch).finally(() => {
                this.renewing = null;
            });
        }, this.renewMs);
        this.renewTimer.unref?.();
    }

    private async renewOnce(epoch: number): Promise<void> {
        const sentNs = process.hrtime.bigint();
        try {
            const rows = await raceTimeout(
                this.sql<{ renewed_at: Date; remaining_ms: number | string }[]>`
                    UPDATE task_worker_lease
                    SET renewed_at = clock_timestamp(),
                        lease_until = clock_timestamp() + ${this.leaseMs}::integer * interval '1 millisecond'
                    WHERE name = ${this.name} AND holder_id = ${this.holderId}
                        AND generation = ${this.generationHeld ?? '0'}::bigint
                        AND lease_until > clock_timestamp()
                    RETURNING renewed_at,
                        EXTRACT(EPOCH FROM (lease_until - clock_timestamp())) * 1000 AS remaining_ms
                `,
                this.lossThresholdMs,
                'worker lease renewal',
            );
            if (epoch !== this.epoch) return;
            if (rows.length === 0) {
                this.declareLost('lease expired or taken over');
                return;
            }
            this.lastRenewAt = new Date(rows[0].renewed_at).toISOString();
            this.lastRenewLocalAt = new Date().toISOString();
            this.confirm(sentNs, Number(rows[0].remaining_ms));
        } catch (err) {
            if (epoch !== this.epoch) return;
            log.warn('Worker singleton lease renewal failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            this.checkDeadline();
        }
    }
}

// ── Process singleton ─────────────────────────────────────────────────────────

let current: { lease: WorkerLease; sql: postgres.Sql } | null = null;

/** Lease state of this process for health/heartbeat (`{ held: false }` before startup). */
export function getWorkerLeaseState(): WorkerLeaseState {
    return current?.lease.state() ?? { held: false };
}

/**
 * Open the lease's dedicated connection and wait until this process holds the
 * lease. Resolves once held; rejects with the signal's reason on abort (the
 * connection is closed then).
 */
export async function acquireWorkerLease(options: {
    signal?: AbortSignal;
    onLost: (reason: string) => void;
}): Promise<void> {
    if (current?.lease.isHeld()) return;
    if (!config.DATABASE_URL) throw new Error('Worker singleton lease requires DATABASE_URL');
    if (current) {
        const previous = current;
        current = null;
        previous.lease.stop();
        await previous.sql.end({ timeout: 5 }).catch(() => undefined);
    }
    const sql = postgres(config.DATABASE_URL, {
        max: 1,
        idle_timeout: 0,
        connect_timeout: 10,
        onnotice: () => {},
        connection: {
            application_name: 'lumastra-worker-lease',
            // A stuck renewal errors out instead of pinning the only connection.
            statement_timeout: 10_000,
        },
    });
    const lease = new WorkerLease(sql, { onLost: options.onLost });
    current = { lease, sql };
    try {
        await lease.acquire(options.signal);
    } catch (err) {
        lease.stop();
        await sql.end({ timeout: 5 }).catch(() => undefined);
        throw err;
    }
}

/** Release the lease (if held) and close its connection. Call last at shutdown. */
export async function releaseWorkerLease(): Promise<void> {
    const held = current;
    if (!held) return;
    try {
        await held.lease.release();
    } finally {
        await held.sql.end({ timeout: 5 }).catch(() => undefined);
    }
}
