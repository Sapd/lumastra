// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { CoversStagesDeclaration } from '$lib/types/pipeline.js';

/**
 * The eligibility version for one stage.
 *
 * 🔴 One task can own several stages whose work advances independently, and a
 * single task-level number cannot describe them. `detectVersionBumps` compares
 * this against `stage_version_state.observed_version` to decide which completed
 * rows are stale, so getting it from the wrong place breaks in both directions:
 * on prod the intro-analyzer's ledger read 4 (the task's provenance constant)
 * while all 14,651 completed `:visual` rows carried 5 (the stage's real
 * constant), which meant bumping the real one marked nothing obsolete and
 * bumping the provenance one would have re-analysed every row its own docstring
 * says must not be re-analysed.
 *
 * Falling back to the task value keeps every task that does not declare a
 * per-stage version byte-identical to the behaviour before the field existed.
 */
export function stageProcessingVersion(
    task: { processingVersion: number },
    stage: Pick<CoversStagesDeclaration, 'processingVersion'>,
): number {
    return stage.processingVersion ?? task.processingVersion;
}
