// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Declarative Stage Contract — disposition shape validation.
 *
 * Shared, registry-independent validation of a stage's `terminalDisposition`
 * declaration. Reachable both from `TaskRegistry.validateCoversStages` (live
 * registration) and from unit tests without a live registry.
 *
 * PHASE 3 (CURRENT): fail-closed. Every `enqueueable` stage MUST declare a
 * valid `terminalDisposition`; a missing/invalid one throws `PluginDefinitionError`
 * at registration (quarantining just that plugin via `safeRegister`). This makes
 * the coverage "wedge" bug class structurally impossible: you cannot register an
 * enqueueable stage with no declared way to dispose ineligible rows.
 *
 * The phase is governed by `WEDGE_GUARD_PHASE`; set back to `'warn'` only for an
 * emergency rollback during a mid-migration window.
 */

import type { CoversStagesDeclaration, StageTerminalDisposition } from '$lib/types/pipeline.js';
import { PluginDefinitionError } from '@sapd/lumastra-plugin-sdk';

/**
 * Enforcement mode for the disposition contract. `'throw'` (current) is
 * fail-closed: a missing/invalid disposition on an enqueueable stage aborts
 * registration. `'warn'` is the pre-migration mode (problems logged, boot
 * continues) — kept only as an emergency rollback lever.
 */
export const WEDGE_GUARD_PHASE: 'warn' | 'throw' = 'throw';

/** Reference operators can follow to author a disposition. */
const DOC_REF = 'the StageTerminalDisposition type in @sapd/lumastra-plugin-sdk';

function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate a single disposition variant's shape. Emits one `warn` per problem.
 * Phase 1: never throws.
 */
function validateOneDisposition(
    stageId: string,
    d: StageTerminalDisposition,
    warn: (msg: string) => void,
): void {
    switch (d.kind) {
        case 'predicate': {
            if (!isNonEmptyString(d.ruleId)) {
                warn(
                    `stage '${stageId}' terminalDisposition kind:'predicate' is missing a non-empty 'ruleId' (see ${DOC_REF})`,
                );
            }
            if (
                d.disposeAs !== 'skipped_permanent' &&
                d.disposeAs !== 'skipped_transient' &&
                d.disposeAs !== 'completed'
            ) {
                warn(
                    `stage '${stageId}' terminalDisposition kind:'predicate' has invalid 'disposeAs' (${String(d.disposeAs)}); expected skipped_permanent | skipped_transient | completed`,
                );
            }
            if (!isNonEmptyString(d.reason)) {
                warn(
                    `stage '${stageId}' terminalDisposition kind:'predicate' is missing a non-empty 'reason'`,
                );
            }
            if (typeof d.excludes !== 'function') {
                warn(
                    `stage '${stageId}' terminalDisposition kind:'predicate' is missing the 'excludes' fragment builder ((sql) => sql\`…\`)`,
                );
            }
            if (
                d.disposeAs === 'skipped_transient' &&
                (typeof d.retryAfterMs !== 'number' || d.retryAfterMs <= 0)
            ) {
                warn(
                    `stage '${stageId}' terminalDisposition kind:'predicate' with disposeAs:'skipped_transient' requires a positive 'retryAfterMs'`,
                );
            }
            if (d.requiresQuietUpstream !== undefined) {
                const g = d.requiresQuietUpstream;
                if (typeof g.windowMs !== 'number' || g.windowMs <= 0) {
                    warn(
                        `stage '${stageId}' terminalDisposition kind:'predicate' requiresQuietUpstream needs a positive 'windowMs'`,
                    );
                }
                if (g.scope !== 'self' && g.scope !== 'parent') {
                    warn(
                        `stage '${stageId}' terminalDisposition kind:'predicate' requiresQuietUpstream.scope must be 'self' | 'parent' (got ${String(g.scope)})`,
                    );
                }
                if (d.disposeAs !== 'skipped_permanent') {
                    warn(
                        `stage '${stageId}' terminalDisposition kind:'predicate' sets requiresQuietUpstream with disposeAs:'${d.disposeAs}' — the quiet-upstream gate only makes sense for terminal 'skipped_permanent' skips`,
                    );
                }
            }
            if (d.requiresUpstreamRun !== undefined && !isNonEmptyString(d.requiresUpstreamRun)) {
                warn(
                    `stage '${stageId}' terminalDisposition kind:'predicate' requiresUpstreamRun must be a non-empty upstream stage_id`,
                );
            }
            break;
        }
        case 'global-guard': {
            if (!isNonEmptyString(d.ruleId)) {
                warn(
                    `stage '${stageId}' terminalDisposition kind:'global-guard' is missing a non-empty 'ruleId'`,
                );
            }
            if (typeof d.guard !== 'function') {
                warn(
                    `stage '${stageId}' terminalDisposition kind:'global-guard' is missing the 'guard' function`,
                );
            }
            if (!isNonEmptyString(d.reason)) {
                warn(
                    `stage '${stageId}' terminalDisposition kind:'global-guard' is missing a non-empty 'reason'`,
                );
            }
            if (typeof d.retryAfterMs !== 'number' || d.retryAfterMs <= 0) {
                warn(
                    `stage '${stageId}' terminalDisposition kind:'global-guard' requires a positive 'retryAfterMs'`,
                );
            }
            break;
        }
        case 'self-terminal': {
            if (!isNonEmptyString(d.ruleId)) {
                warn(
                    `stage '${stageId}' terminalDisposition kind:'self-terminal' is missing a non-empty 'ruleId'`,
                );
            }
            break;
        }
        default: {
            warn(
                `stage '${stageId}' terminalDisposition has unknown kind '${String((d as { kind?: unknown }).kind)}' (expected predicate | self-terminal | global-guard)`,
            );
        }
    }
}

/**
 * Validate a stage's `terminalDisposition` against the Declarative Stage
 * Contract. Collects all problems, then (per {@link WEDGE_GUARD_PHASE}) either
 * THROWS a `PluginDefinitionError` (fail-closed, current) or routes each problem
 * to `warn` (pre-migration rollback mode).
 *
 * - `enqueueable === true` && no disposition && native `eligibility.sql` → valid.
 *   The eligibility dispose pass (bulk UPDATE of `NOT(<sql>)`) structurally
 *   covers ineligible rows, so no wedge is possible.
 * - `enqueueable === true` && no disposition && only `eligibility.appliesTo`
 *   (no `sql`) → problem. The external per-row path disposes a bounded page per
 *   tick and cannot guarantee all ineligible rows drain, so without a disposition
 *   an ineligible row can persist sweepable indefinitely.
 * - `enqueueable === true` && no disposition && no eligibility at all → problem
 *   (coverage gap → wedge).
 * - present disposition (single or array) → validate each variant's shape.
 */
export function validateTerminalDisposition(
    taskId: string,
    stage: CoversStagesDeclaration,
    warn: (msg: string) => void,
): void {
    const disposition = stage.terminalDisposition;
    const problems: string[] = [];

    if (stage.enqueueable === true && disposition === undefined) {
        // Native eligibility.sql provides a bulk dispose pass that structurally
        // covers all ineligible rows — no wedge is possible without an explicit
        // terminalDisposition as long as the eligibility sql fragment is correct.
        const hasNativeSqlEligibility =
            stage.eligibility !== undefined &&
            typeof (stage.eligibility as { sql?: unknown }).sql === 'function';
        if (!hasNativeSqlEligibility) {
            problems.push(
                `enqueueable stage '${stage.id}' (task '${taskId}') declares no terminalDisposition ` +
                    `and no native eligibility.sql — a pending row it cannot process can wedge. ` +
                    `Declare a terminalDisposition or add an eligibility.sql block (see ${DOC_REF}).`,
            );
        }
    } else if (disposition !== undefined) {
        const list = Array.isArray(disposition) ? disposition : [disposition];
        for (const d of list) {
            validateOneDisposition(stage.id, d, (msg) => problems.push(msg));
        }
    }

    // requiresUpstreamRun without a recovery rail wedges items whose upstream
    // stage never writes a per-item row (the gate never opens). Require an
    // `eligibility` block as the event-independent recovery backstop (its heal
    // pass re-checks live state and recovers a row the gate wrongly suppressed).
    const dispositionList =
        disposition === undefined ? [] : Array.isArray(disposition) ? disposition : [disposition];
    const usesUpstreamGate = dispositionList.some(
        (d) => d.kind === 'predicate' && d.requiresUpstreamRun !== undefined,
    );
    if (usesUpstreamGate && stage.eligibility === undefined) {
        problems.push(
            `stage '${stage.id}' (task '${taskId}') sets requiresUpstreamRun but declares no ` +
                `eligibility block — items whose upstream never writes a per-item row would wedge ` +
                `permanently. Add an eligibility block as the recovery rail.`,
        );
    }

    if (problems.length === 0) return;

    if (WEDGE_GUARD_PHASE === 'throw') {
        throw new PluginDefinitionError({
            id: taskId,
            message: problems.join('; '),
            phase: 'registration',
            contract: 'TaskRegistry.registerTask',
        });
    }
    for (const p of problems) warn(p);
}
