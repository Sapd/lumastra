// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-library file-scanner state, shared between the Libraries overview
 * (which watches every library at once) and a single library's page (which
 * watches its own group). Extracted from the overview page's original
 * inline implementation — see that page's history for the bug this design
 * fixes ("I start a Series scan and it scans Anime, or everything"): each
 * library carries its OWN scan state and its OWN Scan/Stop button, never one
 * aggregate progress bar shared by every concurrent scan.
 */

import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { triggerFileScanner, getFileScannerStatus } from '$lib/api/admin';
import { toasts } from '$lib/stores/toast.store';
import { getErrorMessage } from '$lib/utils/error-handling';
import { EtaEstimator } from '$lib/utils/eta-estimator';
import type {
    LibraryScanStatus,
    PluginScanProgress,
} from '$lib/schemas/api-admin-library-responses';
import * as m from '$lib/paraglide/messages.js';

/** The minimum a library group needs to carry to be scanned as a unit. */
export interface ScanGroupLike {
    id: string;
    name: string;
    paths: Array<{ id: string }>;
}

export interface GroupScanState {
    state: 'queued' | 'running' | 'cancelling';
    processed: number;
    total: number;
    discovering: boolean;
    automatic: boolean;
}

/**
 * Owns the file-scanner's live state (poll results, per-group ETA, in-flight
 * trigger/abort requests) so a page only renders it. One instance per page —
 * it is not a singleton, since the overview page and a library page must not
 * share in-flight "pending" guards for unrelated libraries.
 */
export class LibraryScanController {
    libraryScans = $state<LibraryScanStatus[]>([]);
    scanning = $state(false);
    scanProgress = $state<PluginScanProgress | null>(null);
    aborting = $state(false);
    pendingGroupIds = new SvelteSet<string>();
    groupEtas = new SvelteMap<string, number>();

    #wasScanning = false;
    /**
     * Polls left to see a just-started scan as running. A scan that finishes
     * (or is a no-op) between the trigger and the first poll is never seen
     * running, so without this budget `scanning` stayed true and the poll ran
     * every 2 s until the page was left.
     */
    #expectPolls = 0;
    #polling = false;
    #pollTimer: ReturnType<typeof setInterval> | null = null;
    #etaEstimator = new EtaEstimator();

    /** One state per library that has at least one queued/running path scan. */
    groupScanStates(groups: ScanGroupLike[]): Map<string, GroupScanState> {
        const byPath = new SvelteMap(this.libraryScans.map((s) => [s.libraryPathId, s]));
        const out = new SvelteMap<string, GroupScanState>();
        for (const group of groups) {
            const scans = group.paths
                .map((p) => byPath.get(p.id))
                .filter((s): s is LibraryScanStatus => s !== undefined);
            if (scans.length === 0) continue;
            const state = scans.some((s) => s.state === 'running')
                ? 'running'
                : scans.some((s) => s.state === 'queued')
                  ? 'queued'
                  : 'cancelling';
            out.set(group.id, {
                state,
                processed: scans.reduce((n, s) => n + (s.processedItems ?? 0), 0),
                total: scans.reduce((n, s) => n + (s.totalItems ?? 0), 0),
                discovering: scans.some((s) => s.phase === 'discovering'),
                automatic: scans.every((s) => s.trigger === 'scheduled'),
            });
        }
        return out;
    }

    /** Percent done, or null while there is no meaningful number (queued/discovering). */
    scanPct(st: GroupScanState): number | null {
        if (st.state !== 'running' || st.discovering || st.total <= 0) return null;
        return Math.min(100, Math.round((st.processed / st.total) * 100));
    }

    #updateEtas(states: Map<string, GroupScanState>, now = Date.now()): void {
        this.#etaEstimator.retain(states.keys());
        for (const id of [...this.groupEtas.keys()]) {
            if (!states.has(id)) this.groupEtas.delete(id);
        }
        for (const [id, st] of states) {
            const seconds =
                this.scanPct(st) === null
                    ? (this.#etaEstimator.forget(id), undefined)
                    : this.#etaEstimator.update(id, st.processed, st.total, now);
            if (seconds === undefined) this.groupEtas.delete(id);
            else this.groupEtas.set(id, seconds);
        }
    }

    /**
     * Reset state right before starting a NEW scan — guards against a stale
     * "just finished" read if the next poll lands before the server has
     * flagged the job as running.
     */
    prepareForNewScan(): void {
        this.#wasScanning = false;
        this.#expectPolls = LibraryScanController.EXPECT_POLLS;
        this.scanning = true;
        this.scanProgress = null;
    }

    /** ~10 s at the default 2 s interval. */
    static readonly EXPECT_POLLS = 5;

    /**
     * Fetch current status and update every reactive field. Returns true
     * once, the moment a running scan finishes.
     *
     * Takes a GETTER, not a snapshot: `groups` is itself derived from other
     * in-flight loads (the library list), so evaluating it before the
     * `await` below can capture it empty and never re-read it once it
     * populates — which silently drops the ETA baseline for the whole scan.
     */
    async poll(getGroups: () => ScanGroupLike[]): Promise<boolean> {
        // One status request at a time: an older response landing after a
        // newer "finished" one re-set `scanning` with polling already stopped.
        if (this.#polling) return false;
        this.#polling = true;
        try {
            const { data, error } = await getFileScannerStatus();
            if (error) return false;
            this.libraryScans = data?.libraries ?? [];
            this.#updateEtas(this.groupScanStates(getGroups()));
            if (data?.isRunning) {
                this.scanning = true;
                this.scanProgress = data.progress ?? null;
                this.#wasScanning = true;
                this.#expectPolls = 0;
                return false;
            }
            if (this.#expectPolls > 0 && !this.#wasScanning) {
                this.#expectPolls--;
                if (this.#expectPolls > 0) return false;
                // Never seen running: it finished (or had nothing to do)
                // before the first poll. Treat that as finished.
                this.#wasScanning = true;
            }
            if (this.#wasScanning) {
                this.scanning = false;
                this.scanProgress = null;
                this.#wasScanning = false;
                this.stopPolling();
                return true;
            }
            return false;
        } catch {
            /* expected: non-critical polling failure — next poll interval will retry */
            return false;
        } finally {
            this.#polling = false;
        }
    }

    /** Poll on an interval. `tick` should call `poll` itself (it knows the current group list). */
    watch(tick: () => void, intervalMs = 2000): void {
        this.stopPolling();
        this.#pollTimer = setInterval(tick, intervalMs);
    }

    stopPolling(): void {
        if (this.#pollTimer) {
            clearInterval(this.#pollTimer);
            this.#pollTimer = null;
        }
    }

    /** Start (or merge into) this library's scan. Toasts the outcome itself. */
    async triggerForGroup(group: ScanGroupLike): Promise<{ started: boolean }> {
        if (this.pendingGroupIds.has(group.id)) return { started: false };
        this.pendingGroupIds.add(group.id);
        try {
            const { data, error } = await triggerFileScanner({
                paths: group.paths.map((p) => p.id),
                label: group.name,
                libraryGroupId: group.id,
            });
            if (error) {
                toasts.error(error ?? m.admin_library_group_scan_failed());
                return { started: false };
            }
            if (!data?.jobId) {
                toasts.error(m.admin_toast_group_scan_started_but_server_did_not_return_a_job());
                return { started: false };
            }
            // The server dedupes onto a scan already queued/running for these
            // paths (often the periodic one) — say so instead of "started".
            if (data.alreadyRunning) {
                toasts.info(m.admin_toast_scan_already_running_for({ name: group.name }));
            } else {
                toasts.success(m.admin_library_scan_started_for({ name: group.name }));
            }
            this.#wasScanning = false;
            this.#expectPolls = LibraryScanController.EXPECT_POLLS;
            return { started: true };
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_library_group_scan_failed()));
            return { started: false };
        } finally {
            this.pendingGroupIds.delete(group.id);
        }
    }

    /** Stop only this library's scan — never another library's or the periodic one elsewhere. */
    async abortForGroup(group: ScanGroupLike): Promise<void> {
        if (this.pendingGroupIds.has(group.id) || group.paths.length === 0) return;
        this.pendingGroupIds.add(group.id);
        try {
            const { error } = await triggerFileScanner({
                action: 'abort',
                paths: group.paths.map((p) => p.id),
            });
            if (error) {
                toasts.error(error);
            } else {
                toasts.info(m.admin_toast_scan_stopping_for({ name: group.name }));
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_library_group_scan_failed()));
        } finally {
            this.pendingGroupIds.delete(group.id);
        }
    }

    /** "Stop all": every running and queued scan, periodic ones included. */
    async abortAll(): Promise<void> {
        this.aborting = true;
        try {
            const { error } = await triggerFileScanner({ action: 'abort' });
            // A failed abort used to look exactly like a successful one.
            if (error) toasts.error(error);
            else toasts.info(m.admin_toast_scan_stopping_all());
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_library_group_scan_failed()));
        } finally {
            this.aborting = false;
        }
    }
}
