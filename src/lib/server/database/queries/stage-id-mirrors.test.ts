// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every hand-maintained mirror of a stage id must name a stage the registry
 * actually declares.
 *
 * 🔴 There are five such mirrors and no automated check — `ingest-map.constants`
 * says "four" in its own header, but `pipeline-step-names.ts`'s `STEP_NAME` /
 * `STEP_SHORT_NAME` tables (via `KNOWN_PIPELINE_STEP_IDS`) are a fifth. When
 * migration 16.212.0 split `lumastra-intro-analyzer` into `:visual` +
 * `:acoustic`, every mirror kept the retired id, and nothing anywhere noticed:
 *
 *   - the admin "is my library done yet?" bar read the legacy stage and sat
 *     frozen at 19.6% (9,270 of 47,375) for three days, last completion
 *     2026-08-18, while the real stage was at 95.6% and finishing episodes that
 *     morning. It does not read as stale — it reads as stuck.
 *   - the ingest metro map parked every episode train at the `intro` station
 *     permanently.
 *
 * The fifth mirror was missed by both the rename AND this file's first guard
 * pass: `pipeline-step-names.ts` kept the retired id with no case asserting
 * it, so the intro-analyzer step rendered a humanized raw id
 * ("Lumastra Intro Analyzer:visual") instead of its curated name everywhere
 * `pipelineStepName`/`pipelineStepShortName` is read (the metro station label,
 * its tooltip, the Completion grid's column headers, diagnostics panels).
 *
 * A retired stage id is invisible to every WRITE path (they all iterate
 * `registry.getAllTasks()`), so the rows simply stop moving while the read
 * paths keep rendering them. That asymmetry is what makes this class of drift
 * silent, and why it needs a mechanical check rather than a comment asking
 * people to remember.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { registry } from '$lib/server/tasks/registry.js';
import { loadBuiltins } from '$lib/server/tasks/builtin/index.js';
import { HEADLINE_PROGRESS_STAGE_IDS } from './ingest-map.queries.js';
import { SCHEDULED_CHECK_STAGE_IDS } from './coverage-grid.queries.js';
import {
    LINES,
    STAGE_APPLIES_TO,
    STAGE_RESOURCE_CLASS,
    STATION_INFO,
} from '$lib/components/admin/coverage/ingest-map.constants.js';
import { UNDECLARED_BY_DESIGN_STAGE_IDS } from '$lib/server/services/health-invariants/invariants.js';
import { KNOWN_PIPELINE_STEP_IDS } from '$lib/config/pipeline-step-names.js';
import {
    ANALYZER_ACOUSTIC_STAGE_ID,
    ANALYZER_VISUAL_STAGE_ID,
} from '$lib/server/tasks/builtin/native/lumastra-intro-analyzer.js';

describe('stage-id mirrors stay in step with the registry', () => {
    let declared: Set<string>;

    beforeAll(async () => {
        await loadBuiltins();
        declared = new Set(registry.allStageIds());
        // Guard the guard: an empty registry would make every assertion below
        // pass vacuously, which is the failure mode this file exists to catch.
        expect(declared.size).toBeGreaterThan(5);
    });

    it('every headline progress stage is declared', () => {
        // This is the one that showed a frozen 19.6% for three days.
        for (const stageId of HEADLINE_PROGRESS_STAGE_IDS) {
            expect(declared.has(stageId), `${stageId} is not declared by any task`).toBe(true);
        }
    });

    it('every scheduled-check stage the coverage summary skips is declared', () => {
        // A renamed check stage would put its unchecked rows back into the
        // admin drawer's "remaining work".
        for (const stageId of SCHEDULED_CHECK_STAGE_IDS) {
            expect(declared.has(stageId), `${stageId} is not declared by any task`).toBe(true);
        }
    });

    it('every metro-map station is a declared stage', () => {
        for (const line of LINES) {
            for (const stationId of line.stations) {
                expect(
                    declared.has(stationId),
                    `metro line '${line.id}' station '${stationId}' is not declared by any task`,
                ).toBe(true);
            }
        }
    });

    it('every stage named in the appliesTo mirror is declared', () => {
        for (const stageId of Object.keys(STAGE_APPLIES_TO)) {
            expect(declared.has(stageId), `${stageId} is not declared by any task`).toBe(true);
        }
    });

    it('movie visual coverage is included in the admin applicability mirror', () => {
        const task = registry.findTaskByStage(ANALYZER_VISUAL_STAGE_ID);
        const stage = task?.coversStages?.find((entry) => entry.id === ANALYZER_VISUAL_STAGE_ID);
        expect(stage?.appliesTo).toContain('movie');
        expect(STAGE_APPLIES_TO[ANALYZER_VISUAL_STAGE_ID]).toEqual(stage?.appliesTo);
    });

    it('every stage named in the resource-class mirror is declared', () => {
        for (const stageId of Object.keys(STAGE_RESOURCE_CLASS)) {
            expect(declared.has(stageId), `${stageId} is not declared by any task`).toBe(true);
        }
    });

    it('every stage described in STATION_INFO is declared', () => {
        for (const stageId of Object.keys(STATION_INFO)) {
            expect(declared.has(stageId), `${stageId} is not declared by any task`).toBe(true);
        }
    });

    // The fifth mirror this file's guard was written for but originally
    // missed: pipeline-step-names.ts's curated Paraglide name tables. A key
    // that names a retired stage id silently falls back to a humanized raw id
    // (with a colon in it) on every admin surface, rather than failing loudly.
    //
    // 🔴 This is the ONE mirror that must accept the by-design-undeclared ids
    // too, because naming a stage and sweeping it are independent concerns.
    // The other four mirrors drive WRITE-adjacent behaviour (sweep backlog,
    // headline progress, metro routing) and so genuinely require a declared
    // stage. This one only answers "what do we call the rows that already
    // exist" — and `lumastra-intro-analyzer:acoustic` really does have rows,
    // surfacing as a Completion-grid column, while being deliberately absent
    // from `coversStages` (season-scoped, eligibility from row ABSENCE in
    // `getUnanalyzedSeasons`; a second `coversStages` entry would also trip
    // runner.ts's Phase 1a single-stage limit and silently drop coverage for
    // `:visual`). Requiring declaration here would force exactly the change
    // that regression is documented to forbid.
    it('every curated pipeline step name is a real stage id', () => {
        const nameable = new Set([...declared, ...UNDECLARED_BY_DESIGN_STAGE_IDS]);
        for (const stageId of KNOWN_PIPELINE_STEP_IDS) {
            expect(
                nameable.has(stageId),
                `${stageId} is neither declared by a task nor listed in UNDECLARED_BY_DESIGN_STAGE_IDS`,
            ).toBe(true);
        }
    });

    it('each metro line pairs one label with one station', () => {
        // The two arrays are matched by index, so a station added without its
        // label silently shifts every label after it onto the wrong station.
        for (const line of LINES) {
            expect(line.stationLabels.length, `metro line '${line.id}'`).toBe(line.stations.length);
        }
    });

    // The inverse mirror: `orphan-stage-rows` treats "not declared by any
    // task" as "left behind by a rename". One stage id is written on purpose
    // and legitimately undeclared, so the invariant carries an allowlist. Both
    // halves of that allowlist can rot — the id can be renamed, or the stage
    // can later be declared for real — and either way the invariant goes
    // quietly wrong, so both are asserted here.
    it('every by-design-undeclared stage id is a real stage id', () => {
        const known = new Set([ANALYZER_ACOUSTIC_STAGE_ID, ANALYZER_VISUAL_STAGE_ID]);
        for (const stageId of UNDECLARED_BY_DESIGN_STAGE_IDS) {
            expect(known.has(stageId), `${stageId} names no analyzer stage constant`).toBe(true);
        }
    });

    // Minimality. The two cases above pin WHICH ids may sit on the allowlist
    // and that they are still undeclared — but both are satisfiable by simply
    // widening the hand-maintained `known` set above, which is exactly the
    // move someone makes to silence a failing mirror. Neither asks the
    // question that separates a legitimate entry from a parked one: *could*
    // this stage have been declared instead?
    //
    // For `:acoustic` the answer is a mechanical no. runner.ts records
    // coverage only for a task whose `coversStages` has EXACTLY ONE entry and
    // skips it entirely at two or more (the Phase 1a single-stage limit), so
    // an owner that already declares one stage has no room: a second entry
    // would silently drop coverage for the first. That is a property of the
    // registry, not of this list, so it cannot be widened away — an id parked
    // here whose owner still has room fails, with "declare it instead" as the
    // only way out.
    //
    // Owners are resolved by the `<taskId>:<suffix>` convention. A future
    // entry that does not follow it fails here too, which is intended: the
    // allowlist should not grow by a route this guard cannot reason about.
    it('every by-design-undeclared stage id is undeclarABLE, not merely undeclared', () => {
        for (const stageId of UNDECLARED_BY_DESIGN_STAGE_IDS) {
            const ownerId = stageId.split(':')[0];
            const owner = registry.getAllTasks().find((task) => task.id === ownerId);
            expect(
                owner,
                `${stageId} names no registered owner task '${ownerId}' — an allowlist entry ` +
                    `must belong to a task that could have declared it`,
            ).toBeDefined();
            expect(
                owner?.coversStages?.length ?? 0,
                `${stageId} is on the allowlist, but its owner '${ownerId}' declares ` +
                    `${owner?.coversStages?.length ?? 0} stage(s) — at anything other than exactly 1 ` +
                    `the Phase 1a limit is not what blocks declaring it, so declare it instead ` +
                    `of parking it here`,
            ).toBe(1);
        }
    });

    it('every by-design-undeclared stage id is in fact still undeclared', () => {
        // If a stage on this list gets declared for real, the allowlist entry
        // becomes dead weight that would hide a future rename of that same id.
        for (const stageId of UNDECLARED_BY_DESIGN_STAGE_IDS) {
            expect(
                declared.has(stageId),
                `${stageId} is now declared — drop it from UNDECLARED_BY_DESIGN_STAGE_IDS`,
            ).toBe(false);
        }
    });
});
