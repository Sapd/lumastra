// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Human-friendly labels for the internal identifiers that leak into attention
 * titles (pipeline stage ids, health-component keys, onboarding step keys).
 *
 * The operations drawer is a self-documenting surface for non-developer
 * self-hosters: a fresh
 * admin should not have to know that `media-probe` means "reading technical
 * details from media files". Unknown ids fall back to a prettified form so a
 * new stage never renders as a blank or a crash — it just reads as title case.
 */

import { KNOWN_PIPELINE_STEP_IDS, pipelineStepName } from '$lib/config/pipeline-step-names.js';
import * as m from '$lib/paraglide/messages.js';

/**
 * Prettify an unknown kebab/snake id: strip noise suffixes, title-case the
 * rest. Exported so sibling lookups (e.g. task-names.ts's `taskName`) reuse
 * the same unknown-id fallback instead of re-deriving it.
 */
export function prettify(id: string): string {
    const base = id
        .replace(/-(self-terminal|a|b)$/i, '')
        .replace(/[-_]+/g, ' ')
        .trim();
    // An empty/whitespace id must not collapse to '' (which would leave a dangling
    // "… in " in an alert title) — fall back to the raw id or a placeholder.
    if (!base) return id || 'unknown';
    return base.charAt(0).toUpperCase() + base.slice(1);
}

// Ids the pipeline page does NOT name (legacy/aggregate stage ids). Every
// id it does name goes through `pipelineStepName` in `stageLabel` below.
// Functions (not plain strings) so each is resolved in the CURRENT request's
// locale (paraglide's per-request context) at call time, not once at module
// load — labels.ts used to hardcode English here regardless of UI language.
const STAGE_LABELS: Record<string, () => string> = {
    'media-probe': m.admin_attention_stage_media_probe,
    'content-stage': m.admin_attention_stage_content,
    'identity-stage': m.admin_attention_stage_identity,
    'audio-stage': m.admin_attention_stage_audio,
    reconcile: m.admin_attention_stage_reconcile,
    reconciler: m.admin_attention_stage_reconcile,
    'embedding-generator': m.admin_attention_stage_embedding_generator,
};

const COMPONENT_LABELS: Record<string, () => string> = {
    database: m.admin_attention_component_database,
    valkey: m.admin_attention_component_valkey,
    orchestrator: m.admin_attention_component_orchestrator,
    webhookOutbox: m.admin_attention_component_webhook_outbox,
    pendingWriteDrain: m.admin_attention_component_pending_write_drain,
    authCacheBus: m.admin_attention_component_auth_cache_bus,
};

const STEP_LABELS: Record<string, () => string> = {
    library_paths: m.admin_attention_step_library_paths,
    tmdb_config: m.admin_attention_step_tmdb_config,
    library_scan: m.admin_attention_step_library_scan,
    ai_config: m.admin_attention_step_ai_config,
    add_provider: m.admin_attention_step_add_provider,
};

/**
 * Name for a pipeline stage id in an attention title. A stage the pipeline
 * page knows uses ITS name (one vocabulary, spec 2026-09-27 §1.5 — the title
 * used to say "media analysis" for the step the pipeline page and the task
 * list call "Read Media File Details (quick)"); legacy/other ids keep the
 * lowercase phrases below.
 */
export function stageLabel(stageId: string): string {
    if (KNOWN_PIPELINE_STEP_IDS.includes(stageId)) return pipelineStepName(stageId);
    return STAGE_LABELS[stageId]?.() ?? prettify(stageId);
}

/** Friendly name for a health-component key (e.g. `valkey` → "Cache (Valkey)"). */
export function componentLabel(key: string): string {
    return COMPONENT_LABELS[key]?.() ?? prettify(key);
}

/** Friendly name for an onboarding step key (e.g. `tmdb_config` → "connect TMDB metadata"). */
export function stepLabel(stepKey: string): string {
    return STEP_LABELS[stepKey]?.() ?? prettify(stepKey);
}
