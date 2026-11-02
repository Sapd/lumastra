// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';

interface Baseline {
    t: number;
    processed: number;
    total: number;
}

/** Minimum observed window before an estimate is shown — one sample is no rate. */
const MIN_ELAPSED_MS = 10_000;

/**
 * Seconds-left estimates for progress the page only OBSERVES (the server sends
 * no start time): the rate is measured from a baseline sample to the latest.
 *
 * - The baseline resets when the total changes (a phase added work) or the
 *   count goes backwards, and the estimate is withheld until 10s of progress
 *   have been seen.
 * - It is never taken at 0: a rescan's triage marks every unchanged file done
 *   in ONE write (0 → ~33k), which would read as a huge rate and a
 *   "<1 min left" that is minutes off.
 */
export class EtaEstimator {
    #baselines = new Map<string, Baseline>();

    /** Feed the latest sample for `key`; returns seconds left, or undefined while unknown. */
    update(key: string, processed: number, total: number, now = Date.now()): number | undefined {
        const base = this.#baselines.get(key);
        if (!base || base.total !== total || processed < base.processed) {
            if (processed > 0) this.#baselines.set(key, { t: now, processed, total });
            else this.#baselines.delete(key);
            return undefined;
        }
        const elapsed = now - base.t;
        const done = processed - base.processed;
        if (elapsed < MIN_ELAPSED_MS || done <= 0) return undefined;
        return Math.round((total - processed) / (done / (elapsed / 1000)));
    }

    forget(key: string): void {
        this.#baselines.delete(key);
    }

    /** Drop every key not in `live` (finished or vanished work). */
    retain(live: Iterable<string>): void {
        const keep = new Set(live);
        for (const key of [...this.#baselines.keys()]) {
            if (!keep.has(key)) this.#baselines.delete(key);
        }
    }
}

export function formatEta(seconds: number): string {
    if (seconds < 60) return m.admin_library_scan_eta_under_min();
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return m.admin_library_scan_eta_min({ minutes });
    return m.admin_library_scan_eta_hours({
        hours: Math.floor(minutes / 60),
        minutes: minutes % 60,
    });
}
