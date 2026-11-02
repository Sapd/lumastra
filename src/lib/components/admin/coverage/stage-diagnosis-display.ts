// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Operator-facing styling for the two pipeline enums the timeline renders:
 * `StuckReason` (why a step is not moving) and `StageOperatorState` (which of
 * the five buckets a row sits in).
 *
 * Both lived as `Record<Union, …>` literals inside `.svelte` components, and
 * nothing in this repo checked either one. `npm run typecheck` runs tsgo, which
 * does not read `.svelte` at all, and `npm run check` (svelte-check-native) was
 * MEASURED on 2026-08-27 not to flag a renamed key in a component-local
 * `Record<Union, …>` either.
 *
 * That is not a hypothetical here. `StuckReasonSchema` gained
 * `'schedule-paused'` — an admin switched the owning task off, emitted by
 * `pipeline-diagnosis.ts` and covered by its own server tests — and
 * StageDiagnosisBadge.svelte's record never got the entry. Its `?? none`
 * fallback then labelled a deliberately paused step "Waiting" in the neutral
 * zinc treatment, directly beside the row's own amber "Off" pill. The badge is
 * the element that exists to say WHY a step is stopped, and for that reason it
 * said the wrong thing rather than nothing.
 *
 * So both are exhaustive `switch`es in a `.ts` module now, where tsgo does check
 * them: a missing case fails the declared return type, and a case naming a
 * member that no longer exists fails as not comparable. Do not reintroduce a
 * `default` arm — the fallbacks at the old call sites are what turned a missing
 * case into a confident wrong answer.
 */

import type { StageOperatorState, StuckReason } from '$lib/schemas/pipeline-timeline.schema.js';

/** Plain-language meaning plus colour tier for a stuck reason. */
export interface StuckReasonStyle {
    cls: string;
    /** The headline a non-developer self-hoster reads. The raw cause is never shown verbatim. */
    label: string;
}

const RED = 'bg-red-900/40 text-red-200';
const AMBER = 'bg-amber-900/40 text-amber-200';
const ZINC = 'bg-zinc-700/50 text-zinc-300';

/**
 * Colour tiers:
 *   red   — process crashed, paused after failures, lost its worker
 *   amber — switched off by an admin, waiting (system busy), waiting on a lock
 *   zinc  — does not apply to this item / nothing to report
 *   sky   — in progress
 */
export function stuckReasonStyle(reason: StuckReason): StuckReasonStyle {
    switch (reason) {
        case 'worker-dead':
            return { cls: RED, label: 'Process crashed' };
        case 'circuit-open':
            return { cls: RED, label: 'Paused after repeated failures' };
        case 'orphaned-stage':
            return { cls: RED, label: 'Lost its worker — recovering' };
        case 'schedule-paused':
            // Amber, not zinc: an admin turned this step's task off, so it is
            // stopped on purpose and will not resume on its own. Reads as a
            // deliberate state to undo, not as the system idling.
            return { cls: AMBER, label: 'Switched off by an admin' };
        case 'backpressure':
            return { cls: AMBER, label: 'Waiting — system busy' };
        case 'scheduled-wait':
            return { cls: AMBER, label: 'Waiting for its scheduled time' };
        case 'identity-locked':
            return { cls: AMBER, label: 'Waiting on a lock' };
        case 'predicate-blocked':
            return { cls: ZINC, label: 'Does not apply to this item' };
        case 'running-healthy':
            return { cls: 'bg-sky-900/40 text-sky-200', label: 'In progress' };
        case 'none':
            return { cls: 'bg-zinc-800/60 text-zinc-400', label: 'Waiting' };
    }
}

/** Row rule + pill treatment for a stage's operator-facing bucket. */
export interface StageStateStyle {
    row: string;
    pill: string;
}

/**
 * Deliberately five visually distinct treatments: the whole point is that a
 * waiting row must not read like a failed one across a scanned list.
 */
export function stageOperatorStateStyle(state: StageOperatorState): StageStateStyle {
    switch (state) {
        case 'done':
            return {
                row: 'border-l-2 border-l-emerald-700/70',
                pill: 'bg-emerald-900/30 text-emerald-200',
            };
        case 'failed':
            return { row: 'border-l-2 border-l-red-600', pill: 'bg-red-900/40 text-red-200' };
        case 'waiting':
            return { row: 'border-l-2 border-l-sky-700/70', pill: 'bg-sky-900/30 text-sky-200' };
        case 'skipped':
            return {
                row: 'border-l-2 border-l-zinc-700 opacity-80',
                pill: 'bg-zinc-700/50 text-zinc-300',
            };
        case 'off':
            return { row: 'border-l-2 border-l-amber-600', pill: 'bg-amber-900/40 text-amber-200' };
    }
}
