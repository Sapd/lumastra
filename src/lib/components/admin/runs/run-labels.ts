// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Operator wording for run metadata, shared by every run list and the run
 * panel. Prod showed raw values in all of these places: "Started by
 * scheduled", an unlabelled `e0440fdcb81e-201f00` (the server that ran it),
 * UTC ISO timestamps in the log, and log lines full of item UUIDs.
 */

import * as m from '$lib/paraglide/messages.js';
import type { Run } from '$lib/schemas/run.schema.js';

/** Why the run started, in words. */
export function triggerLabel(trigger: Run['trigger']): string {
    switch (trigger.kind) {
        case 'scheduled':
            return m.admin_run_trigger_scheduled();
        case 'manual':
            return trigger.by
                ? m.admin_run_trigger_manual_by({ who: trigger.by })
                : m.admin_run_trigger_manual();
        case 'pipeline-child':
            return m.admin_run_trigger_pipeline();
        case 'resume':
            return m.admin_run_trigger_resume();
        case 'webhook':
            return m.admin_run_trigger_webhook();
        case 'in-process':
            return m.admin_run_trigger_internal();
    }
}

/**
 * "Resumed after restart (n/3)" for a run the server started to continue one
 * a restart interrupted (`trigger.resume`), or null for any other run.
 */
export function resumeLabel(trigger: Run['trigger']): string | null {
    if (!trigger.resume) return null;
    return m.admin_run_resumed_badge({
        count: String(trigger.resume.count),
        max: String(trigger.resume.max),
    });
}

/** How a finished run ended, from the task's own `stopReason`, or null when it gave none. */
export function stopReasonLabel(
    result: unknown,
    countSummary?: Run['countSummary'],
): string | null {
    // SSE omits the raw result envelope by design. A validated summary carries
    // the server's already-checked budget reason and remaining-source proof.
    if (countSummary?.continuation?.kind === 'source-check') {
        return m.admin_run_source_check_later({
            count: countSummary.continuation.remainingSources.toLocaleString(),
        });
    }
    if (typeof result !== 'object' || result === null) return null;
    const reason = (result as Record<string, unknown>).stopReason;
    switch (reason) {
        case 'drained':
            return m.admin_run_stop_drained();
        case 'budget':
            return m.admin_run_stop_budget();
        case 'no-progress':
            return m.admin_run_stop_no_progress();
        case 'aborted':
            return m.admin_run_stop_aborted();
        case 'single-slice':
            return m.admin_run_stop_single_slice();
        case 'skipped':
            return m.admin_run_stop_skipped();
        default:
            return null;
    }
}

const UUID_RE = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Shorten UUIDs inside free text to their first 8 characters + "…" — enough to
 * tell two items apart, without a log line being mostly hex. Display only; the
 * copy-to-clipboard paths keep the full text.
 */
export function shortenUuids(text: string): string {
    return text.replace(UUID_RE, '$1…');
}

/**
 * A log timestamp in the viewer's local time: "22:10:30" today, otherwise
 * "Sep 25, 22:10:30". The log used to print UTC ISO strings, two hours off for
 * a German operator and unlike every other time on the page.
 */
export function formatLogTime(ts: string | number, now: Date = new Date()): string {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    const time = d.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
    const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
    if (sameDay) return time;
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * The server that ran it, short. Instance ids look like `<host>-<suffix>`; the
 * suffix alone is what the Servers box on the Runs page shows (`#201f00`).
 */
export function serverLabel(ownerInstanceId: string): string {
    const auto = /^[0-9a-f]{12}-([0-9a-f]{6})$/i.exec(ownerInstanceId);
    return auto ? `#${auto[1]}` : ownerInstanceId;
}
