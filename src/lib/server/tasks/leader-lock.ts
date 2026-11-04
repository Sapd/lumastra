// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// leader-lock.ts — renewable SET-NX leader lock for per-class orchestrator
// leadership. Extracted from orchestrator.ts (behavior-preserving) — it has no
// TaskOrchestrator internals.

import { type ValkeyLike, errMessage } from './valkey-types.js';
import { Logger } from '$lib/server/utils/logger.js';
import { appendAuditEvent } from './observability/audit-log.js';
import type { AuthorityToken } from '../../../task-runtime/authority/store.js';
import { captureValkeyAuthority, invokeFencedValkey } from './lua/fenced.js';
import { raceTimeout } from './loop-stop.js';
import { createRepeatWarning } from '$lib/server/utils/repeat-warning.js';

const log = Logger.for('LeaderLock');

/**
 * Derive a human-readable resource class from an orchestrator lock key
 * (`lock:orch:<class>`). Falls back to the raw key for non-orchestrator locks.
 */
function leaderResourceFromKey(key: string): string {
    return key.startsWith('lock:orch:') ? key.slice('lock:orch:'.length) : key;
}

/**
 * A Valkey that is gone fails every class lock's release the same way: one
 * warning per window for the whole process, the rest at debug. A release that
 * works ends the window.
 */
const releaseFailures = createRepeatWarning(log);

/** Test seam. */
export function __resetLeaderLockReleaseWarningForTests(): void {
    releaseFailures.reset();
}

/**
 * Renewable SET-NX lock. Acquires `key=holderId NX PX ttl`; renews via a small
 * compare-and-extend Lua. Fires `onLost` once if a renewal sees somebody else
 * owns the key (preempted by a peer), or when no renewal has been confirmed
 * within `ttl - margin` of the last confirmed one (see `lossThresholdMs`).
 */
export class LeaderLock {
    private timer: ReturnType<typeof setInterval> | null = null;
    private heldSince: number | null = null;
    private lostCb: (() => void) | null = null;
    private stopped = false;
    private generation = 0;
    // SET may have committed even when its acknowledgement is lost. Keep the
    // constructor-known holder releasable until compare-delete confirms absence.
    private releaseRequired = false;
    private acquisition: Promise<boolean> | null = null;
    private readonly renewals = new Set<Promise<boolean>>();
    private consecutiveRenewFailures = 0;
    /**
     * Monotonic time (ns, `process.hrtime.bigint()`) at which the last CONFIRMED
     * acquire/renew was SENT. Valkey applied its PX no earlier than that, so the
     * key is guaranteed ours until at least this + ttl. Measuring from the send
     * (not the reply) keeps the bound safe however slow the reply was.
     */
    private lastRenewOkNs: bigint | null = null;
    /** Generation whose renew request is still unanswered; the loop never stacks a second. */
    private pendingRenewGeneration: number | null = null;
    /** Fires when `lossThresholdMs` elapses without a confirmed renewal. */
    private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * Leadership is declared lost once `lossThresholdMs` has passed since
     * `lastRenewOkNs`, whether or not a renew is still pending. A renew that
     * hangs (paused connection, stalled server) never resolves to a failure, so
     * counting failures alone would let the key expire under us while we still
     * act as leader and a peer acquires it: two leaders. The margin
     * (`max(1s, ttl/5)`, at most ttl/2) covers clock-rate drift and the time the
     * loss callbacks need to stop leader work before the key can expire.
     */
    private readonly lossThresholdMs: number;
    private readonly authority: Readonly<AuthorityToken> | undefined;

    constructor(
        private readonly client: ValkeyLike,
        private readonly key: string,
        private readonly holderId: string,
        private readonly ttlMs: number,
        private readonly renewMs: number,
        authority?: AuthorityToken,
    ) {
        this.authority = captureValkeyAuthority(authority);
        const marginMs = Math.min(Math.max(1_000, ttlMs / 5), ttlMs / 2);
        this.lossThresholdMs = ttlMs - marginMs;
        // A renew interval at or past the loss threshold would declare loss on
        // (almost) every cycle before the next renewal could confirm: flapping.
        if (!(renewMs > 0 && renewMs < this.lossThresholdMs))
            throw new Error(
                `LeaderLock ${key}: renew interval ${renewMs} ms must be below the loss threshold ` +
                    `${this.lossThresholdMs} ms (ttl ${ttlMs} ms minus a ${marginMs} ms margin)`,
            );
    }

    onLost(cb: () => void): void {
        this.lostCb = cb;
    }

    isHeld(): boolean {
        return this.heldSince !== null;
    }

    /**
     * Verify with Valkey that this holder STILL owns the lock (GET key === holder).
     * The renew loop is the primary loss detector; this is for the orchestrator's
     * leadership-reconcile safety net to catch any divergence between in-process
     * belief (`isHeld()`) and reality. Ownership or read failures return false;
     * a stale owner must never act on its local belief during an outage.
     */
    async verifyHeld(): Promise<boolean> {
        try {
            const value = await invokeFencedValkey(
                "return redis.call('GET', KEYS[1])",
                [this.key],
                [],
                this.client,
                this.authority,
            );
            const str =
                typeof value === 'string'
                    ? value
                    : value instanceof Uint8Array
                      ? Buffer.from(value).toString('utf-8')
                      : null;
            return str === this.holderId;
        } catch {
            return false;
        }
    }

    /**
     * Locally relinquish leadership WITHOUT touching Valkey and WITHOUT firing
     * `onLost`: stop the renew loop and clear held state. Used by the orchestrator's
     * zombie-reconcile, which drives the loss → re-acquire flow itself. `acquire()`
     * re-arms `stopped`, so a later re-acquire on this instance is clean.
     */
    relinquishLocal(): void {
        this.stop();
        this.heldSince = null;
        this.consecutiveRenewFailures = 0;
        this.lastRenewOkNs = null;
    }

    acquire(): Promise<boolean> {
        this.acquisition ??= this.acquireOnce().finally(() => {
            this.acquisition = null;
        });
        return this.acquisition;
    }

    private async acquireOnce(): Promise<boolean> {
        const generation = this.generation;
        const previouslyRequired = this.releaseRequired;
        this.releaseRequired = true;
        const sentNs = process.hrtime.bigint();
        const result = await invokeFencedValkey(
            "return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])",
            [this.key],
            [this.holderId, this.ttlMs],
            this.client,
            this.authority,
            { allowDraining: false },
        );
        const ok = result === 'OK';
        if (result === null) this.releaseRequired = previouslyRequired;
        // stop() invalidates operations that started before it. A late SET
        // remains a release obligation, but can never re-arm local leadership.
        if (generation !== this.generation) return false;
        if (ok) {
            // RE-ARM after a prior loss. A previous `onLost` ran `stop()`, which
            // set `stopped = true`; without clearing it here the renew loop started
            // below would early-return on every firing (`if (this.stopped) return`),
            // so the freshly-acquired key would never be renewed — it expires within
            // one TTL, a peer-less class becomes permanently leaderless in Valkey
            // while this process still believes it leads (no further renew ⇒ no
            // further `onLost` ⇒ no re-acquire). That is exactly the "leadership
            // didn't auto-recover until a redeploy" failure. Reset the loss state so
            // the renew loop is live.
            this.stopped = false;
            this.consecutiveRenewFailures = 0;
            this.heldSince = Date.now();
            // The key's TTL clock started no earlier than the SET was sent.
            this.pendingRenewGeneration = null;
            this.lastRenewOkNs = sentNs;
            this.armRenewDeadline();
            this.startRenewLoop();
            // Observability (Slice 0): audit leadership acquisition. Best-effort.
            const resourceClass = leaderResourceFromKey(this.key);
            void appendAuditEvent({
                category: 'leader',
                action: 'leader-acquired',
                severity: 'info',
                summary: `Leadership acquired for ${resourceClass} by ${this.holderId}.`,
                detail: { resourceClass, holderId: this.holderId },
            });
        }
        return ok;
    }

    /**
     * Best-effort audit of a leadership loss (renewal saw a peer own the key, or
     * the renewal-failure window exceeded the TTL margin). Fired from both loss
     * paths in the renew loop.
     */
    private auditLost(reason: string): void {
        const resourceClass = leaderResourceFromKey(this.key);
        void appendAuditEvent({
            category: 'leader',
            action: 'leader-lost',
            severity: 'warn',
            summary: `Leadership lost for ${resourceClass} (${reason}).`,
            detail: { resourceClass, holderId: this.holderId, reason },
        });
    }

    renew(): Promise<boolean> {
        const pending = this.renewOnce();
        this.renewals.add(pending);
        void pending.then(
            () => this.renewals.delete(pending),
            () => this.renewals.delete(pending),
        );
        return pending;
    }

    private async renewOnce(): Promise<boolean> {
        // GET-then-PEXPIRE compare-and-extend; matches the `releaseLock` shape
        // used elsewhere but with PEXPIRE so renewal cadence is sub-second.
        const lua = `
            if redis.call("GET", KEYS[1]) == ARGV[1] then
                return redis.call("PEXPIRE", KEYS[1], ARGV[2])
            else
                return 0
            end
        `;
        const result = await invokeFencedValkey(
            lua,
            [this.key],
            [this.holderId, this.ttlMs],
            this.client,
            this.authority,
        );
        return result === 1 || result === '1';
    }

    async release(options: { strict?: boolean } = {}): Promise<void> {
        this.stop();
        // A request sent before stop may still SET/extend the key. The release
        // must be ordered after those requests have finished, including failures.
        // A hung connection may never answer: wait at most one TTL, then leave
        // the key to expire (any late extension also expires within a TTL).
        try {
            await raceTimeout(
                Promise.allSettled([this.acquisition ?? Promise.resolve(false), ...this.renewals]),
                this.ttlMs,
                `LeaderLock ${this.key} pending requests`,
            );
        } catch (err) {
            log.warn(
                'LeaderLock release skipped: earlier requests unanswered; key left to expire',
                {
                    key: this.key,
                    err: errMessage(err),
                },
            );
            if (options.strict)
                throw new Error(`UNKNOWN: LeaderLock release unconfirmed for ${this.key}`, {
                    cause: err,
                });
            return;
        }
        if (!this.releaseRequired) return;
        const lua = `
            if redis.call("GET", KEYS[1]) == ARGV[1] then
                return redis.call("DEL", KEYS[1])
            else
                return 0
            end
        `;
        try {
            const result = await raceTimeout(
                invokeFencedValkey(lua, [this.key], [this.holderId], this.client, this.authority),
                this.ttlMs,
                `LeaderLock ${this.key} release`,
            );
            if (result !== 0 && result !== '0' && result !== 1 && result !== '1')
                throw new Error('Invalid LeaderLock release acknowledgement');
            this.releaseRequired = false;
            releaseFailures.reset();
        } catch (err) {
            releaseFailures.warn('LeaderLock release failed', {
                key: this.key,
                err: errMessage(err),
            });
            if (options.strict)
                throw new Error(`UNKNOWN: LeaderLock release unconfirmed for ${this.key}`, {
                    cause: err,
                });
        }
    }

    stop(): void {
        this.stopped = true;
        this.generation++;
        this.heldSince = null;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.deadlineTimer) {
            clearTimeout(this.deadlineTimer);
            this.deadlineTimer = null;
        }
    }

    /**
     * Test-only: clear the local "is held" flag without touching Valkey.
     * Used by `simulateCrashForTesting()` on the orchestrator so the dead
     * leader's in-process state matches what a real crash would produce.
     *
     * @internal
     */
    _clearHeldStateForTesting(): void {
        this.heldSince = null;
        this.consecutiveRenewFailures = 0;
        this.lastRenewOkNs = null;
        if (this.deadlineTimer) {
            clearTimeout(this.deadlineTimer);
            this.deadlineTimer = null;
        }
    }

    /** Fire the loss path once: stop renewing, clear held state, notify. */
    private declareLost(reason: string): void {
        this.consecutiveRenewFailures = 0;
        this.heldSince = null;
        this.stop();
        this.auditLost(reason);
        if (this.lostCb) this.lostCb();
    }

    /**
     * Declare loss when `lossThresholdMs` has elapsed since the last confirmed
     * renewal. Returns true when it did. An event-loop stall that delays every
     * timer past the threshold is treated the same way: the key may already
     * have expired and been taken, and nothing we do after the stall can be
     * trusted to still run under our leadership.
     */
    private checkRenewDeadline(): boolean {
        if (this.stopped || this.lastRenewOkNs === null) return false;
        const elapsedMs = Number((process.hrtime.bigint() - this.lastRenewOkNs) / 1_000_000n);
        if (elapsedMs < this.lossThresholdMs) return false;
        log.warn(
            'LeaderLock: no confirmed renewal within the TTL safety margin — leadership lost',
            {
                key: this.key,
                elapsedMs,
                ttlMs: this.ttlMs,
                lossThresholdMs: this.lossThresholdMs,
                renewPending: this.pendingRenewGeneration === this.generation,
            },
        );
        this.declareLost('renewal-deadline-exceeded');
        return true;
    }

    /** (Re)arm the timer that runs `checkRenewDeadline` when the threshold is due. */
    private armRenewDeadline(): void {
        if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
        this.deadlineTimer = null;
        if (this.stopped || this.lastRenewOkNs === null) return;
        const elapsedMs = Number((process.hrtime.bigint() - this.lastRenewOkNs) / 1_000_000n);
        const delayMs = Math.max(0, Math.ceil(this.lossThresholdMs - elapsedMs));
        this.deadlineTimer = setTimeout(() => {
            this.deadlineTimer = null;
            if (!this.checkRenewDeadline()) this.armRenewDeadline();
        }, delayMs);
        if (typeof this.deadlineTimer.unref === 'function') this.deadlineTimer.unref();
    }

    private async renewTick(generation: number): Promise<void> {
        const sentNs = process.hrtime.bigint();
        this.pendingRenewGeneration = generation;
        try {
            const ok = await this.renew();
            if (this.stopped || generation !== this.generation) return;
            if (!ok) {
                log.warn('LeaderLock lost during renew', { key: this.key });
                this.declareLost('preempted-by-peer');
                return;
            }
            this.consecutiveRenewFailures = 0;
            if (this.lastRenewOkNs === null || sentNs > this.lastRenewOkNs) {
                this.lastRenewOkNs = sentNs;
                this.armRenewDeadline();
            }
        } catch (err) {
            if (this.stopped || generation !== this.generation) return;
            this.consecutiveRenewFailures++;
            log.warn('LeaderLock renew error', {
                key: this.key,
                err: errMessage(err),
                consecutiveFailures: this.consecutiveRenewFailures,
            });
            // A managed-authority rejection is definitive; anything else is
            // judged by the deadline (a failed renew proves nothing either way).
            if (this.authority || errMessage(err).includes('TASK_AUTHORITY_')) {
                log.warn('LeaderLock: proactive onLost — renewal rejected by task authority', {
                    key: this.key,
                    consecutiveFailures: this.consecutiveRenewFailures,
                });
                this.declareLost('renewal-failures-exceeded-ttl');
            } else {
                this.checkRenewDeadline();
            }
        } finally {
            if (this.pendingRenewGeneration === generation) this.pendingRenewGeneration = null;
        }
    }

    private startRenewLoop(): void {
        if (this.timer) return;
        this.timer = setInterval(() => {
            if (this.stopped) return;
            if (this.checkRenewDeadline()) return;
            const generation = this.generation;
            // Never stack renewals behind a hung one: a second request queued on
            // the same stuck connection proves nothing, and the deadline above
            // already bounds how long we keep acting on the last confirmation.
            if (this.pendingRenewGeneration === generation) {
                log.warn('LeaderLock: previous renew still pending — skipping this renew', {
                    key: this.key,
                });
                return;
            }
            void this.renewTick(generation);
        }, this.renewMs);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }
}
