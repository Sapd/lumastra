// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression coverage for the two stages a STOCK install could never complete.
 *
 * `TRICKPLAY_ENABLED` defaults to false and a fresh install has no embedding
 * key, yet `trickplay-generation` and `library-embeddings` both seeded every
 * item ELIGIBLE and declared no disposition that could account for the switch
 * being off:
 *
 *   - trickplay: `generateTrickplayForMediaItem()` early-returned
 *     `success:false` ("Trickplay generation is disabled"). `success:false`
 *     without `permanent` routes through `resetRunningToPending`, which
 *     deliberately leaves `attempt` alone — so the row went straight back to
 *     `pending` and was re-swept 60s later, forever. Nothing dead-lettered and
 *     nothing completed. The stage is also FIRST in stage-sweep's
 *     `PER_STAGE_HEAL_ORDER`, so the sweep kept seeding fresh unrunnable rows.
 *
 *   - embeddings: `generateTextEmbedding()` returns `null` with no provider,
 *     the generator counts a per-item error and still reports `success: true`
 *     with `generated: 0`, so `onSuccess` never fired and no coverage row was
 *     ever written. Being global-identity tasks there was no `mediaItemId` for
 *     `wrapExecute` to auto-complete either.
 *
 * Both left the aggregate progress bar structurally unable to reach 100%,
 * because `loadStageProgressByIds` counts `pending` as REMAINING.
 *
 * What these tests pin, per stage:
 *   1. the feature flag reaches BOTH the eligibility fragment (which drives the
 *      dispose AND the event-independent heal) and the author predicate (which
 *      supplies the honest reason);
 *   2. the flag is read PER CALL, so flipping it is observed within one sweep
 *      tick in both directions — this is the whole re-enrolment story, since no
 *      pipeline event exists for a config change;
 *   3. the reason the predicate writes is listed in
 *      `recoverWhenAdditionalReasons`, which is what lets the heal reclaim it
 *      (`skipped_permanent` is otherwise never re-swept).
 *
 * (3) is the load-bearing one: drop it and turning the feature on leaves the
 * library tombstoned permanently — a worse failure than the churn it replaced.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StageTerminalDisposition } from '@sapd/lumastra-plugin-sdk';

const { configState, embeddingState, essentiaState } = vi.hoisted(() => ({
    configState: { TRICKPLAY_ENABLED: false, DISABLE_MUSIC_ANALYSIS: false },
    embeddingState: { configured: false },
    essentiaState: { available: true },
}));

vi.mock('../../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));
vi.mock('$lib/server/config.js', () => ({
    config: configState,
    getAuthoritativeStageIds: () => new Set<string>(),
}));
vi.mock('../embedding-dep.js', () => ({
    EMBEDDINGS_DEP: { name: 'embeddings' },
    hasUsableEmbeddingProvider: () => embeddingState.configured,
}));
vi.mock('../../../../services/essentia-analysis.service.js', () => ({
    isEssentiaAvailable: () => essentiaState.available,
    // The stage gates on isAnalysisEngineUsable (binary present AND not crashing).
    isAnalysisEngineUsable: () => essentiaState.available,
    verifyAnalysisEngineReady: vi.fn(),
    analyzeTrack: vi.fn(),
    storeAnalysis: vi.fn(),
    withEssentiaConcurrency: vi.fn(),
    getEssentiaConcurrencyLimit: () => 1,
}));

import { trickplayGenerationTask } from '../media-item-tasks.js';
import { libraryEmbeddingsTask } from '../library-embeddings-task.js';
import { discoveryEmbeddingsTask } from '../discovery-embeddings.js';
import { musicAnalysisTask } from '../music-analysis.js';

/**
 * Stand-in for the host `sql` template tag. The declarations only ever build
 * fragments and nest fragments inside fragments, so flattening to a plain
 * string reproduces exactly what postgres.js would compose — and lets a test
 * assert on it without a database.
 */
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): string {
    return strings.reduce(
        (acc, chunk, i) => acc + chunk + (i < values.length ? String(values[i]) : ''),
        '',
    );
}

interface StageLike {
    id: string;
    eligibility?: {
        sql?: (sql: unknown) => unknown;
        recoverWhenAdditionalReasons?: readonly string[];
    };
    terminalDisposition?: StageTerminalDisposition | readonly StageTerminalDisposition[];
    healLimit?: number;
}

function stageOf(task: { coversStages?: readonly unknown[] }, stageId: string): StageLike {
    const stage = (task.coversStages as StageLike[] | undefined)?.find((s) => s.id === stageId);
    if (!stage)
        throw new Error(`No coversStages entry with id='${stageId}' — declaration removed?`);
    return stage;
}

/** The `excludes` fragment of the named predicate disposition, rendered. */
function renderExcludes(stage: StageLike, ruleId: string): string {
    const list: readonly StageTerminalDisposition[] = Array.isArray(stage.terminalDisposition)
        ? stage.terminalDisposition
        : stage.terminalDisposition
          ? [stage.terminalDisposition as StageTerminalDisposition]
          : [];
    const d = list.find((entry) => (entry as { ruleId?: string }).ruleId === ruleId);
    if (!d) throw new Error(`No terminalDisposition with ruleId='${ruleId}'`);
    if (d.kind !== 'predicate') throw new Error(`ruleId='${ruleId}' is kind='${d.kind}'`);
    return String(d.excludes(fakeSql as never));
}

function renderEligibility(stage: StageLike): string {
    const builder = stage.eligibility?.sql;
    if (!builder) throw new Error(`stage '${stage.id}' declares no eligibility.sql`);
    return String(builder(fakeSql));
}

/** Leading boolean literal of a `<flag> AND <structural…>` eligibility fragment. */
function eligibilityGate(stage: StageLike): 'true' | 'false' {
    const rendered = renderEligibility(stage).trim();
    if (rendered.startsWith('true')) return 'true';
    if (rendered.startsWith('false')) return 'false';
    throw new Error(`eligibility.sql for '${stage.id}' does not open with a feature gate`);
}

describe('trickplay-generation — TRICKPLAY_ENABLED is part of eligibility', () => {
    const stage = stageOf(trickplayGenerationTask, 'trickplay-generation');
    const RULE = 'trickplay-generation-disabled';

    beforeEach(() => {
        configState.TRICKPLAY_ENABLED = false;
    });

    it('disabled (the DEFAULT): the predicate disposes and eligibility is false', () => {
        expect(renderExcludes(stage, RULE)).toBe('true');
        expect(eligibilityGate(stage)).toBe('false');
    });

    it('enabled: the predicate is inert and eligibility passes to the structural clauses', () => {
        configState.TRICKPLAY_ENABLED = true;
        expect(renderExcludes(stage, RULE)).toBe('false');
        expect(eligibilityGate(stage)).toBe('true');
    });

    it('the flag is re-read per call, so one sweep tick observes a flip either way', () => {
        // The re-enrolment mechanism in full: no event is emitted for a config
        // change, so the ONLY thing that reverses the tombstone is the sweep
        // re-running these builders against live config on its next tick.
        expect(eligibilityGate(stage)).toBe('false');
        configState.TRICKPLAY_ENABLED = true;
        expect(eligibilityGate(stage)).toBe('true');
        configState.TRICKPLAY_ENABLED = false;
        expect(eligibilityGate(stage)).toBe('false');
    });

    it('the structural clauses survive the added gate', () => {
        configState.TRICKPLAY_ENABLED = true;
        const rendered = renderEligibility(stage);
        expect(rendered).toContain('media_streams');
        expect(rendered).toContain("ms.stream_type = 'video'");
        expect(rendered).toContain('NOT mf.is_missing');
    });

    it('the disabled reason is one the eligibility heal reclaims', () => {
        expect(stage.eligibility?.recoverWhenAdditionalReasons).toContain('trickplay-disabled');
    });

    it('keeps the self-terminal contract alongside the new predicate', () => {
        const list = stage.terminalDisposition as readonly StageTerminalDisposition[];
        expect(Array.isArray(list)).toBe(true);
        expect(list.map((d) => d.kind)).toEqual(['predicate', 'self-terminal']);
        // Author variants fire in declaration order and BEFORE the eligibility
        // dispose, so the specific 'trickplay-disabled' reason wins over the
        // generic 'ineligible' the negation would otherwise stamp.
        expect((list[0] as { reason?: string }).reason).toBe('trickplay-disabled');
        expect((list[0] as { disposeAs?: string }).disposeAs).toBe('skipped_permanent');
    });
});

describe.each([
    ['library-embeddings', () => libraryEmbeddingsTask, 'library-embeddings-provider-configured'],
    [
        'discovery-embeddings',
        () => discoveryEmbeddingsTask,
        'discovery-embeddings-provider-configured',
    ],
] as const)('%s — the embedding provider is part of eligibility', (stageId, getTask, ruleId) => {
    beforeEach(() => {
        embeddingState.configured = false;
    });

    it('no provider (the fresh-install DEFAULT): predicate disposes, eligibility false', () => {
        const stage = stageOf(getTask(), stageId);
        expect(renderExcludes(stage, ruleId)).toBe('true');
        expect(eligibilityGate(stage)).toBe('false');
    });

    it('provider configured: predicate inert, eligibility passes through', () => {
        embeddingState.configured = true;
        const stage = stageOf(getTask(), stageId);
        expect(renderExcludes(stage, ruleId)).toBe('false');
        expect(eligibilityGate(stage)).toBe('true');
    });

    it('adding a key is observed on the next tick, with no restart and no event', () => {
        const stage = stageOf(getTask(), stageId);
        expect(eligibilityGate(stage)).toBe('false');
        embeddingState.configured = true;
        expect(eligibilityGate(stage)).toBe('true');
    });

    it('disposes skipped_permanent under its own reason, which the heal reclaims', () => {
        const stage = stageOf(getTask(), stageId);
        const list: readonly StageTerminalDisposition[] = Array.isArray(stage.terminalDisposition)
            ? stage.terminalDisposition
            : [stage.terminalDisposition as StageTerminalDisposition];
        const d = list.find((entry) => (entry as { ruleId?: string }).ruleId === ruleId) as {
            disposeAs?: string;
            reason?: string;
        };
        expect(d.disposeAs).toBe('skipped_permanent');
        expect(d.reason).toBe('no-embedding-provider');
        expect(stage.eligibility?.recoverWhenAdditionalReasons).toContain('no-embedding-provider');
    });

    it('keeps its own structural eligibility clause', () => {
        embeddingState.configured = true;
        const rendered = renderEligibility(stageOf(getTask(), stageId));
        expect(rendered).toContain('has_files');
    });
});

/**
 * The THIRD headline stage with this hole, found by walking
 * `HEADLINE_PROGRESS_STAGE_IDS` after the first two were fixed.
 *
 * `music-analysis` is global-identity, so its early returns write nothing at all
 * and every seeded track row stays `pending` — counted as REMAINING forever.
 * `DISABLE_MUSIC_ANALYSIS` defaults to on-by-default, so the flag is not the
 * stock trap; `isEssentiaAvailable()` is. Essentia publishes a prebuilt
 * extractor for linux-x86_64 ONLY, and the Dockerfile skips it on other arches
 * by design — so every arm64 install with a music library was stalled at under
 * 100% out of the box.
 */
describe('music-analysis — the analysis engine is part of eligibility', () => {
    const stage = stageOf(musicAnalysisTask, 'music-analysis');

    /** The two leading boolean literals of `<flag> AND <engine> AND <structural…>`. */
    function gates(): [string, string] {
        const m = renderEligibility(stage)
            .trim()
            .match(/^(true|false)\s+AND\s+(true|false)\b/);
        if (!m) throw new Error('eligibility.sql does not open with TWO feature gates');
        return [m[1], m[2]];
    }

    beforeEach(() => {
        configState.DISABLE_MUSIC_ANALYSIS = false;
        essentiaState.available = true;
    });

    it('enabled + engine present: both predicates inert, eligibility passes through', () => {
        expect(gates()).toEqual(['true', 'true']);
        expect(renderExcludes(stage, 'music-analysis-enabled')).toBe('false');
        expect(renderExcludes(stage, 'music-analysis-engine-available')).toBe('false');
    });

    it('no Essentia binary (arm64 stock install): disposes and eligibility is false', () => {
        essentiaState.available = false;
        expect(gates()).toEqual(['true', 'false']);
        expect(renderExcludes(stage, 'music-analysis-engine-available')).toBe('true');
        // The OTHER predicate must stay inert, or the Ingest Map would blame a
        // setting the operator never touched.
        expect(renderExcludes(stage, 'music-analysis-enabled')).toBe('false');
    });

    it('operator turned analysis off: the other predicate disposes, engine one inert', () => {
        configState.DISABLE_MUSIC_ANALYSIS = true;
        expect(gates()).toEqual(['false', 'true']);
        expect(renderExcludes(stage, 'music-analysis-enabled')).toBe('true');
        expect(renderExcludes(stage, 'music-analysis-engine-available')).toBe('false');
    });

    it('both gates are re-read per call, so one sweep tick observes a flip either way', () => {
        expect(gates()).toEqual(['true', 'true']);
        configState.DISABLE_MUSIC_ANALYSIS = true;
        essentiaState.available = false;
        expect(gates()).toEqual(['false', 'false']);
        configState.DISABLE_MUSIC_ANALYSIS = false;
        essentiaState.available = true;
        expect(gates()).toEqual(['true', 'true']);
    });

    it('both reasons are ones the eligibility heal reclaims', () => {
        // Load-bearing: without these, enabling analysis (or moving to amd64)
        // would leave the whole music library tombstoned permanently.
        const recover = stage.eligibility?.recoverWhenAdditionalReasons;
        expect(recover).toContain('music-analysis-disabled');
        expect(recover).toContain('essentia-unavailable');
        // Raising the duration cap must re-admit the DJ mixes it skipped.
        expect(recover).toContain('track-too-long');
    });

    it('keeps the self-terminal contract, with the predicates ordered before it', () => {
        const list = stage.terminalDisposition as readonly StageTerminalDisposition[];
        expect(list.map((d) => d.kind)).toEqual([
            'predicate',
            'predicate',
            'predicate',
            'self-terminal',
        ]);
        expect(list.map((d) => (d as { reason?: string }).reason)).toEqual([
            'music-analysis-disabled',
            'essentia-unavailable',
            'track-too-long',
            undefined,
        ]);
        for (const d of list.slice(0, 3)) {
            expect((d as { disposeAs?: string }).disposeAs).toBe('skipped_permanent');
        }
    });

    it('the structural audio clauses survive the added gates', () => {
        const rendered = renderEligibility(stage);
        expect(rendered).toContain("ms.stream_type = 'audio'");
        expect(rendered).toContain('NOT mf.is_missing');
    });

    it('does NOT gate on the transient engine-readiness probe', () => {
        // verifyAnalysisEngineReady() covers a configured-but-DOWN sidecar.
        // Tombstoning a library on a network blip would be a regression, so the
        // fragment must carry exactly two gates, not three.
        expect(renderEligibility(stage).trim()).not.toMatch(
            /^(true|false)\s+AND\s+(true|false)\s+AND\s+(true|false)\b/,
        );
    });
});
