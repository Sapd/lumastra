// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stage id → one-sentence "what does this step actually do" description, the
 * prose counterpart to `pipeline-step-names.ts` (which only answers "what is
 * it called"). Operator surfaces that list pipeline steps — the per-item
 * Pipeline tab's step rows and its progress-dot tooltips — show this behind a
 * `?` affordance so an operator never has to guess what `mdblist-sync` means.
 *
 * Most stage ids ARE the id of the task that owns them, so the curated,
 * already-translated `taskDescription()` catalogue is the primary source and
 * this module stays tiny: it only carries overrides for stages whose owning
 * task's description would be wrong or too vague at stage granularity —
 * `media-probe-a`/`media-probe-b` (two distinct passes, one `media-probe`
 * task) and `integrity-file-present` (one check of the broader
 * `integrity-scanner` task).
 *
 * Every id in `KNOWN_PIPELINE_STEP_IDS` resolves to something here; the
 * colocated test pins that. Unknown ids (a freshly installed plugin's stage)
 * resolve through the owning task's SDK description if it has one, else
 * `undefined` — callers then hide the `?` rather than showing an empty bubble.
 */

import * as m from '$lib/paraglide/messages.js';
import { taskDescription } from '$lib/utils/admin/task-descriptions.js';

type StepDescriptionMessage = () => string;

/** Stage-granular overrides — see the module doc for why each one exists. */
const STEP_DESCRIPTION_OVERRIDE: Partial<Record<string, StepDescriptionMessage>> = {
    'media-probe-a': m.admin_pipeline_step_desc_media_probe_a,
    'media-probe-b': m.admin_pipeline_step_desc_media_probe_b,
    'integrity-file-present': m.admin_pipeline_step_desc_integrity_file_present,
};

/**
 * Operator-facing description of what a pipeline step does, or `undefined`
 * when nothing is known about it (third-party stage whose task set no
 * description).
 *
 * @param stageId `media_item_stage_state.stage_id`.
 * @param taskId  The task that owns the stage (`TimelineStage.taskId`), when
 *                the caller knows it. Used as the second lookup so an
 *                orphaned stage still gets prose from its former owner.
 */
export function pipelineStepDescription(
    stageId: string,
    taskId?: string | null,
): string | undefined {
    const override = STEP_DESCRIPTION_OVERRIDE[stageId];
    if (override) return override();
    // `taskDescription` returns the curated message for a known id, else the
    // SDK-supplied one, else undefined — so all three lookups are safe to chain.
    //
    // The third lookup is the OWNING TASK DERIVED FROM THE STAGE ID. Since the
    // `task:stage` split (migration 16.212.0 turned `lumastra-intro-analyzer`
    // into `:visual` + `:acoustic`), a split stage id no longer equals its task
    // id — so the first lookup, which used to succeed by coincidence for every
    // single-stage task, now returns undefined and the step renders bare. The
    // caller often has no `taskId` to pass (the `?` affordance in the admin
    // pipeline view looks steps up by stage id alone), so relying on the second
    // lookup is not enough. Deriving it costs nothing and closes the whole
    // class: any future task that splits its stages keeps its prose without a
    // seventh hand-maintained mirror to remember.
    if (taskId) {
        return taskDescription(stageId) ?? taskDescription(taskId);
    }
    const derivedTaskId = stageId.includes(':') ? stageId.slice(0, stageId.indexOf(':')) : null;
    return taskDescription(stageId) ?? (derivedTaskId ? taskDescription(derivedTaskId) : undefined);
}
