// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plain-language labels for the raw enum codes the task system leaks into admin
 * surfaces. Operator screens (/admin/tasks, /admin/tasks/runs, /admin/tasks/
 * pipeline, …) should route raw `media_item_stage_state.status`, resource-class, and
 * circuit-breaker values through these helpers so a non-developer self-hoster
 * never has to decode `failed_transient` or `half_open`.
 *
 * Sibling to `src/lib/server/services/attention/labels.ts` (which labels stage
 * ids / health-component keys / onboarding steps). These cover the orthogonal
 * status/class/circuit enums and are framework-agnostic plain TS so they can be
 * imported from either client or server admin code via the `$lib` alias.
 *
 * Every helper falls back to a humanized form for unknown values so a newly
 * added enum member never renders as a blank or a raw code — it just reads as
 * "Some new status" instead of `some_new_status`.
 */

/** Humanize an unknown snake/kebab code: replace separators with spaces, capitalize the first letter. */
function humanize(code: string): string {
    const base = code.replace(/[-_]+/g, ' ').trim();
    if (!base) return code || 'Unknown';
    return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Friendly label for a `media_item_stage_state.status` / run status code.
 *
 * @example taskStatusLabel('failed_transient') // "Failed — will retry"
 * @example taskStatusLabel('some_future_state') // "Some future state"
 */
const TASK_STATUS_LABELS: Record<string, string> = {
    pending: 'Waiting',
    running: 'In progress',
    completed: 'Done',
    failed_transient: 'Failed — will retry',
    failed_permanent: 'Failed — gave up',
    skipped_transient: 'Skipped for now',
    skipped_permanent: 'Not applicable',
    obsolete: 'No longer needed',
    cancelling: 'Stopping',
    cancelled: 'Stopped',
};

export function taskStatusLabel(status: string): string {
    return TASK_STATUS_LABELS[status] ?? humanize(status);
}

/**
 * Friendly label for a task resource-class code (the pool a task runs in, each
 * with its own concurrency cap).
 *
 * @example resourceClassLabel('io') // "Disk & network"
 * @example resourceClassLabel('embedding') // "AI"
 */
const RESOURCE_CLASS_LABELS: Record<string, string> = {
    cpu: 'CPU',
    io: 'Disk & network',
    embedding: 'AI',
    maintenance: 'Upkeep',
    ingest: 'New files',
    bulk: 'Bulk enrichment',
    analysis: 'Media analysis',
    discovery: 'Discovery',
};

export function resourceClassLabel(cls: string): string {
    return RESOURCE_CLASS_LABELS[cls] ?? humanize(cls);
}

/**
 * Friendly label for a circuit-breaker state code.
 *
 * @example circuitStateLabel('open') // "Paused (after repeated failures)"
 * @example circuitStateLabel('half_open') // "Testing recovery"
 */
const CIRCUIT_STATE_LABELS: Record<string, string> = {
    closed: 'Running',
    open: 'Paused (after repeated failures)',
    half_open: 'Testing recovery',
};

export function circuitStateLabel(state: string): string {
    return CIRCUIT_STATE_LABELS[state] ?? humanize(state);
}

/**
 * Friendly label for a circuit-breaker action code. The `force-enable` action
 * (force-close an open breaker so the task runs again) reads as "Resume now".
 *
 * @example circuitActionLabel('force-enable') // "Resume now"
 */
const CIRCUIT_ACTION_LABELS: Record<string, string> = {
    'force-enable': 'Resume now',
};

export function circuitActionLabel(action: string): string {
    return CIRCUIT_ACTION_LABELS[action] ?? humanize(action);
}

/**
 * Friendly label for a task/plugin failure-reason code — the raw
 * `plugin_failure_events.reason` value shown in the task failures panel
 * (`TaskFailuresList.svelte`). Most plugins write free-text (an exception
 * message); media-probe writes a fixed `FileHealthIssueType` code. Known
 * codes get a plain-language label; anything else — including free text —
 * falls back to the same humanized form so it never renders as a raw,
 * undecoded code.
 *
 * @example failureReasonLabel('truncated_video') // "Video cut off early"
 * @example failureReasonLabel('some_new_code') // "Some new code"
 */
const FAILURE_REASON_LABELS: Record<string, string> = {
    truncated_video: 'Video cut off early',
    no_keyframes: 'No seek points found',
    duration_mismatch: "Duration doesn't match metadata",
    tag_parse_timeout: 'Tag scan timed out',
    tag_parse_corrupt: 'Corrupt file tags',
    filename_not_utf8: 'Filename has invalid characters',
    container_unreadable: "File can't be read",
    video_ends_early: 'Video ends before its reported length',
    video_decode_gaps: 'Gaps partway through the video',
};

export function failureReasonLabel(reason: string): string {
    return FAILURE_REASON_LABELS[reason] ?? humanize(reason);
}
