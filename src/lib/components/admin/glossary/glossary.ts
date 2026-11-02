// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * THE one shared glossary (admin IA redesign, spec §7): every jargon term
 * tooltipped anywhere in the admin gets its definition from here — no page
 * writes its own explanation. Term/definition are Paraglide message
 * functions (not plain strings) so tooltips localize with the rest of the
 * admin (en+de) instead of freezing to English at import time.
 *
 * An entry earns its place by being a word an operator actually reads on a
 * screen. Renaming beats explaining: the product already did that once —
 * the UI says "Stopped retrying", not "Dead letter" — and a term nothing
 * renders any more is a translation bill with no reader, so it gets deleted
 * rather than kept "in case". The `term` labels below therefore track the
 * visible UI wording (e.g. "Auto-pause", matching the task-detail stat card),
 * while the *keys* stay at the internal name because server adapters
 * (`services/attention/adapters.ts`) address entries by that key.
 *
 * `docHref` deepens an answer; it never is the answer. Self-hosted installs
 * are routinely offline, so the definition above the link has to stand on
 * its own.
 */

import * as m from '$lib/paraglide/messages.js';
import { docsUrl, TASK_TROUBLESHOOTING } from '$lib/utils/docs-url.js';

export interface GlossaryEntry {
    term: () => string;
    definition: () => string;
    /** Absolute docs URL — always built through `docsUrl()`, never hand-written. */
    docHref?: string;
}

export const GLOSSARY: Record<string, GlossaryEntry> = {
    // Core vocabulary (spec §2 rule 5: Task / Run / Step).
    task: {
        term: m.admin_glossary_task_term,
        definition: m.admin_glossary_task_definition,
    },
    run: {
        term: m.admin_glossary_run_term,
        definition: m.admin_glossary_run_definition,
        docHref: docsUrl(TASK_TROUBLESHOOTING.runStuckActive),
    },
    step: {
        term: m.admin_glossary_step_term,
        definition: m.admin_glossary_step_definition,
    },

    'circuit-breaker': {
        term: m.admin_glossary_circuit_breaker_term,
        definition: m.admin_glossary_circuit_breaker_definition,
        docHref: docsUrl(TASK_TROUBLESHOOTING.queueNotDraining),
    },
    'dead-letter': {
        term: m.admin_glossary_dead_letter_term,
        definition: m.admin_glossary_dead_letter_definition,
        docHref: docsUrl(TASK_TROUBLESHOOTING.itemSkipsStage),
    },
    'needs-reidentification': {
        term: m.admin_glossary_needs_reidentification_term,
        definition: m.admin_glossary_needs_reidentification_definition,
    },
    'stuck-wedged': {
        term: m.admin_glossary_stuck_wedged_term,
        definition: m.admin_glossary_stuck_wedged_definition,
        docHref: docsUrl(TASK_TROUBLESHOOTING.stuckItems),
    },
    'resource-class': {
        term: m.admin_glossary_resource_class_term,
        definition: m.admin_glossary_resource_class_definition,
        docHref: docsUrl(TASK_TROUBLESHOOTING.workerNotPickingUp),
    },
    'leader-election': {
        term: m.admin_glossary_leader_election_term,
        definition: m.admin_glossary_leader_election_definition,
    },
    'degraded-component': {
        term: m.admin_glossary_degraded_component_term,
        definition: m.admin_glossary_degraded_component_definition,
    },
    // `adapters.ts` has been emitting `term: 'health-invariant'` on invariant
    // findings with no entry here to receive it, so `AttentionItemRow` silently
    // fell back to rendering the bare title — the one alert most likely to
    // frighten someone ("9 library integrity issues found") was also the one
    // with no explanation attached. Definition deliberately says what a finding
    // does NOT mean: these are catalogue-vs-disk disagreements, not playback
    // breakage, and reading them as the latter is the whole failure mode.
    'health-invariant': {
        term: m.admin_glossary_health_invariant_term,
        definition: m.admin_glossary_health_invariant_definition,
    },
    'setup-incomplete': {
        term: m.admin_glossary_setup_incomplete_term,
        definition: m.admin_glossary_setup_incomplete_definition,
    },
    'failed-run-spike': {
        term: m.admin_glossary_failed_run_spike_term,
        definition: m.admin_glossary_failed_run_spike_definition,
    },
    'overdue-schedule': {
        term: m.admin_glossary_overdue_schedule_term,
        definition: m.admin_glossary_overdue_schedule_definition,
    },
    'optional-integration': {
        term: m.admin_glossary_optional_integration_term,
        definition: m.admin_glossary_optional_integration_definition,
    },
    stage: {
        term: m.admin_glossary_stage_term,
        definition: m.admin_glossary_stage_definition,
        docHref: docsUrl(TASK_TROUBLESHOOTING.stageRowWedged),
    },
    // Addressed dynamically, never by a literal: SubsystemLivenessGrid looks
    // these up by heartbeat name (kept as the object key here — and as the
    // `reason.subsystem` value adapters.ts' livenessTerm() returns) while
    // rendering the plain-language name below (`term`) as the heading itself,
    // so the tooltip's bold headline always agrees with what it hangs off.
    reconciler: {
        term: m.admin_glossary_reconciler_term,
        definition: m.admin_glossary_reconciler_definition,
    },
    'stage-sweep': {
        term: m.admin_glossary_stage_sweep_term,
        definition: m.admin_glossary_stage_sweep_definition,
    },
    'event-dispatcher': {
        term: m.admin_glossary_event_dispatcher_term,
        definition: m.admin_glossary_event_dispatcher_definition,
    },
    scheduler: {
        term: m.admin_glossary_scheduler_term,
        definition: m.admin_glossary_scheduler_definition,
    },
    'pending-write-drain': {
        term: m.admin_glossary_pending_write_drain_term,
        definition: m.admin_glossary_pending_write_drain_definition,
    },
    backlog: {
        term: m.admin_glossary_backlog_term,
        definition: m.admin_glossary_backlog_definition,
        docHref: docsUrl(TASK_TROUBLESHOOTING.pendingPileUp),
    },
};
