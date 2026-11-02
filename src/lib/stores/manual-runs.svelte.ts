// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * App-wide tracker for the runs the signed-in user started by hand (a library
 * scan, a metadata refresh, a sync …): their live progress on every page, and a
 * success / failure / stopped notice when each one ends — also after
 * navigating away, and after a full reload.
 *
 * The server is the source of truth (`GET /api/me/manual-runs`). Two things are
 * kept per user in localStorage so they survive a reload:
 * - `lastServerTime` — each poll asks for runs finished since then MINUS a
 *   margin. The windows deliberately overlap: a run's `completed_at` can
 *   precede the moment its row became visible (transaction-start NOW(),
 *   batched terminal writes, replay after an outage, clock skew), and a strict
 *   boundary silently dropped such completions.
 * - `announced` — run id → the terminal state already announced. It is what
 *   makes the overlap safe (each outcome is announced once, across reloads and
 *   tabs sharing storage) and what lets a later, DIFFERENT outcome through: a
 *   run whose failure was announced but which a retry then completed is
 *   announced again as finished.
 *
 * A failure is only announced once it has stood for FAILURE_GRACE_MS (server
 * clock): the task system records `failed` between retry attempts and
 * overwrites it when the retry starts.
 *
 * On a first visit (nothing stored) the current window is recorded, not
 * announced — nothing historic pops up.
 *
 * Polling: every 2.5s while a run is live (or a failure is still in its
 * grace), every 30s idle, and at once when any API response reports it started
 * a run (`run-started-signal`) or the tab becomes visible again. A hidden tab
 * does not poll at all — the visible-kick catches it up. Once the session is
 * declared expired (`isAuthFailed()`) polling stops for good: the auth banner
 * takes over and a stale tab must not keep 401-ing the server.
 */

import { getMyManualRuns } from '$lib/api/manual-runs';
import { isAuthFailed } from '$lib/auth-monitor';
import { onRunStarted } from '$lib/api/run-started-signal';
import { toasts } from '$lib/stores/toast.store';
import type { ManualRun } from '$lib/schemas/manual-runs';
import * as m from '$lib/paraglide/messages.js';

const ACTIVE_POLL_MS = 2_500;
const IDLE_POLL_MS = 30_000;
const KICK_DEBOUNCE_MS = 300;
/** Overlap between consecutive windows — see the header. */
const WINDOW_OVERLAP_MS = 10 * 60 * 1000;
/** How long `failed` must stand before it is final (retries rewrite it). */
export const FAILURE_GRACE_MS = 60 * 1000;
/** Announced ids are kept a little longer than the server's 24h lookback. */
const ANNOUNCED_TTL_MS = 25 * 60 * 60 * 1000;
const ANNOUNCED_MAX = 500;

const TERMINAL: ReadonlySet<ManualRun['state']> = new Set(['completed', 'failed', 'cancelled']);

interface Persisted {
    lastServerTime?: string;
    /** run id → [terminal state announced, when (ms)] */
    announced: Record<string, [ManualRun['state'], number]>;
}

function isHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function storageKey(userKey: string): string {
    return `v1:manual-runs:${userKey}`;
}

function load(userKey: string): Persisted | null {
    try {
        const raw = localStorage.getItem(storageKey(userKey));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<Persisted>;
        return { lastServerTime: parsed.lastServerTime, announced: parsed.announced ?? {} };
    } catch {
        return null; // private mode / blocked storage / corrupt: treat as a first visit
    }
}

function save(userKey: string, state: Persisted): void {
    try {
        localStorage.setItem(storageKey(userKey), JSON.stringify(state));
    } catch {
        /* best-effort: only costs a repeated or missed "finished while away" notice */
    }
}

export function manualRunName(run: Pick<ManualRun, 'title' | 'detail'>): string {
    return run.detail ? `${run.title} · ${run.detail}` : run.title;
}

class ManualRunsTracker {
    /** Live runs to show. A fanned-out parent is hidden while it has children listed. */
    runs = $state<ManualRun[]>([]);

    #userKey: string | null = null;
    #persisted: Persisted = { announced: {} };
    #firstVisit = false;
    /** Bumped by stop(): a poll started under an older generation discards its result. */
    #generation = 0;
    #timer: ReturnType<typeof setTimeout> | null = null;
    #kickTimer: ReturnType<typeof setTimeout> | null = null;
    #inFlight: Promise<void> | null = null;
    #kickedDuringPoll = false;
    #teardown: Array<() => void> = [];

    /** Idempotent per user. Call once the user is known (root layout). */
    start(userKey: string): void {
        if (this.#userKey === userKey) return;
        this.stop();
        this.#userKey = userKey;
        const stored = load(userKey);
        this.#firstVisit = stored === null;
        this.#persisted = stored ?? { announced: {} };
        this.#teardown.push(onRunStarted(() => this.kick()));
        const onVisible = (): void => {
            if (document.visibilityState === 'visible') this.kick();
        };
        document.addEventListener('visibilitychange', onVisible);
        this.#teardown.push(() => document.removeEventListener('visibilitychange', onVisible));
        void this.poll();
    }

    stop(): void {
        this.#generation++;
        for (const fn of this.#teardown.splice(0)) fn();
        if (this.#timer) clearTimeout(this.#timer);
        if (this.#kickTimer) clearTimeout(this.#kickTimer);
        this.#timer = this.#kickTimer = null;
        this.#inFlight = null;
        this.#kickedDuringPoll = false;
        this.#userKey = null;
        this.#persisted = { announced: {} };
        this.runs = [];
    }

    /** Poll soon — something may have just started. */
    kick(): void {
        if (!this.#userKey) return;
        if (this.#kickTimer) clearTimeout(this.#kickTimer);
        this.#kickTimer = setTimeout(() => {
            this.#kickTimer = null;
            // A poll already in flight may have queried before the new run's row
            // existed: re-poll once it lands instead of piggy-backing on it.
            if (this.#inFlight) this.#kickedDuringPoll = true;
            else void this.poll();
        }, KICK_DEBOUNCE_MS);
    }

    poll(): Promise<void> {
        if (this.#inFlight) return this.#inFlight;
        const generation = this.#generation;
        const inFlight = this.#poll(generation).finally(() => {
            if (this.#inFlight !== inFlight) return;
            this.#inFlight = null;
            if (this.#kickedDuringPoll && this.#generation === generation) {
                this.#kickedDuringPoll = false;
                void this.poll();
            }
        });
        this.#inFlight = inFlight;
        return inFlight;
    }

    async #poll(generation: number): Promise<void> {
        const userKey = this.#userKey;
        if (!userKey) return;
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
        if (isAuthFailed()) return; // session expired: stop polling

        const last = this.#persisted.lastServerTime;
        const since = last
            ? new Date(Date.parse(last) - WINDOW_OVERLAP_MS).toISOString()
            : undefined;
        const { data } = await getMyManualRuns(since);
        if (this.#generation !== generation) return; // stopped / switched user meanwhile

        let pendingFailure = false;
        if (data) {
            // Another tab of this user may have announced some of these already.
            const shared = load(userKey);
            if (shared) {
                this.#persisted.announced = { ...shared.announced, ...this.#persisted.announced };
            }
            const serverNow = Date.parse(data.serverTime);
            const parents = new Set(data.runs.map((r) => r.parentRunId).filter(Boolean));
            for (const run of data.runs) {
                if (!TERMINAL.has(run.state)) continue;
                if (this.#persisted.announced[run.id]?.[0] === run.state) continue;
                const endedAt = run.completedAt ? Date.parse(run.completedAt) : serverNow;
                if (run.state === 'failed' && serverNow - endedAt < FAILURE_GRACE_MS) {
                    pendingFailure = true; // may be a retry gap: decide on a later poll
                    continue;
                }
                this.#persisted.announced[run.id] = [run.state, Date.now()];
                // A fan-out parent ends as soon as it has dispatched; its children
                // carry the real outcome and are announced one by one.
                if (this.#firstVisit || parents.has(run.id)) continue;
                this.#announce(run);
            }
            const live = data.runs.filter((r) => !TERMINAL.has(r.state));
            const liveParents = new Set(live.map((r) => r.parentRunId).filter(Boolean));
            this.runs = live.filter((r) => !liveParents.has(r.id));
            this.#persisted.lastServerTime = data.serverTime;
            this.#firstVisit = false;
            this.#prune();
            save(userKey, this.#persisted);
        }

        // A hidden tab shows nothing, so it does not poll: the visibilitychange
        // kick (start()) resumes the loop, and the overlapping window catches up
        // every run that ended meanwhile. Every open tab polling every 30s all
        // night was 5,855 requests in ~34h on prod (2026-09-25).
        if (isHidden() || isAuthFailed()) return;
        this.#timer = setTimeout(
            () => {
                if (!isHidden()) void this.poll();
            },
            this.runs.length > 0 || pendingFailure ? ACTIVE_POLL_MS : IDLE_POLL_MS,
        );
    }

    #prune(): void {
        const cutoff = Date.now() - ANNOUNCED_TTL_MS;
        const entries = Object.entries(this.#persisted.announced)
            .filter(([, [, at]]) => at > cutoff)
            .sort((a, b) => b[1][1] - a[1][1])
            .slice(0, ANNOUNCED_MAX);
        this.#persisted.announced = Object.fromEntries(entries);
    }

    #announce(run: ManualRun): void {
        const name = manualRunName(run);
        if (run.state === 'completed') {
            toasts.success(m.manual_run_completed({ name }));
        } else if (run.state === 'cancelled') {
            toasts.info(m.manual_run_stopped({ name }));
        } else if (run.error) {
            toasts.error(m.manual_run_failed_reason({ name, reason: run.error }));
        } else {
            toasts.error(m.manual_run_failed({ name }));
        }
    }
}

export const manualRuns = new ManualRunsTracker();
