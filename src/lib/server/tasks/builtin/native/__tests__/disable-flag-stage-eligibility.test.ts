// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stages whose task can be switched off with a `DISABLE_*` flag must not leave
 * their rows `pending` while it is off.
 *
 * Preprod 2026-10-07: 70 `fribb-anime-sync` rows sat `pending` (attempt 0, never
 * run) since August. A use-case preset set `DISABLE_FRIBB_ANIME_SYNC`, so every
 * run early-returned success without writing a row, and the task is
 * global-identity, so nothing auto-completed them either. stage-sweep found the
 * same 70 candidates every minute, enqueued none, backed off for ~24h, and the
 * admin UI showed a backlog that could never drain. `mal-anime-id-enrichment`,
 * `media-probe` and `trickplay-params-sync` had the same shape.
 *
 * Same contract as `feature-gated-stage-eligibility.test.ts` (trickplay,
 * embeddings, music-analysis), per stage:
 *   1. the flag reaches BOTH `eligibility.sql` (dispose + heal) and a
 *      `skipped_permanent` predicate with its own reason;
 *   2. the flag is read per call, so one sweep tick observes a flip;
 *   3. that reason is in `recoverWhenAdditionalReasons`, so clearing the flag
 *      re-enrols the rows (otherwise turning the task back on would leave them
 *      tombstoned for good).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StageTerminalDisposition } from '@sapd/lumastra-plugin-sdk';

const { flags } = vi.hoisted(() => ({
    flags: {
        DISABLE_FRIBB_ANIME_SYNC: false,
        DISABLE_MAL_ANIME_ENRICHMENT: false,
        DISABLE_MEDIA_PROBE: false,
        DISABLE_TRICKPLAY_PARAMS: false,
    } as Record<string, boolean>,
}));

vi.mock('../../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    // Real config for everything else; only the four flags are driven here.
    const config = new Proxy(actual.config, {
        get(target, prop, receiver) {
            if (typeof prop === 'string' && Object.hasOwn(flags, prop)) return flags[prop];
            return Reflect.get(target, prop, receiver);
        },
    });
    return { ...actual, config, getAuthoritativeStageIds: () => new Set<string>() };
});

import { fribbAnimeSyncTask, FRIBB_DISABLED_REASON } from '../fribb-anime-sync.js';
import {
    malAnimeIdEnrichmentTask,
    MAL_ENRICHMENT_DISABLED_REASON,
} from '../mal-anime-id-enrichment.js';
import { mediaProbeTask, MEDIA_PROBE_DISABLED_REASON } from '../media-probe.js';
import {
    trickplayParamsSyncTask,
    TRICKPLAY_PARAMS_DISABLED_REASON,
} from '../trickplay-params-sync.js';

/** Flattens a nested `sql` template to a string, as in feature-gated-stage-eligibility. */
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): string {
    return strings.reduce(
        (acc, chunk, i) => acc + chunk + (i < values.length ? String(values[i]) : ''),
        '',
    );
}

interface StageLike {
    id: string;
    enqueueable?: boolean;
    eligibility?: {
        sql?: (sql: unknown) => unknown;
        recoverWhenAdditionalReasons?: readonly string[];
    };
    terminalDisposition?: StageTerminalDisposition | readonly StageTerminalDisposition[];
    healLimit?: number;
}

function stageOf(task: { coversStages?: readonly unknown[] }, stageId: string): StageLike {
    const stage = (task.coversStages as StageLike[] | undefined)?.find((s) => s.id === stageId);
    if (!stage) throw new Error(`No coversStages entry with id='${stageId}'`);
    return stage;
}

function dispositions(stage: StageLike): readonly StageTerminalDisposition[] {
    const d = stage.terminalDisposition;
    return d === undefined ? [] : Array.isArray(d) ? d : [d as StageTerminalDisposition];
}

function eligibilityGate(stage: StageLike): 'true' | 'false' {
    const rendered = String(stage.eligibility?.sql?.(fakeSql) ?? '').trim();
    const m = rendered.match(/^(true|false)\b/);
    if (!m) throw new Error(`eligibility.sql for '${stage.id}' does not open with the flag`);
    return m[1] as 'true' | 'false';
}

const CASES = [
    {
        stageId: 'fribb-anime-sync',
        task: () => fribbAnimeSyncTask,
        flag: 'DISABLE_FRIBB_ANIME_SYNC',
        ruleId: 'fribb-anime-sync-enabled',
        reason: FRIBB_DISABLED_REASON,
        structural: "ei.provider = 'tmdb'",
    },
    {
        stageId: 'mal-anime-id-enrichment',
        task: () => malAnimeIdEnrichmentTask,
        flag: 'DISABLE_MAL_ANIME_ENRICHMENT',
        ruleId: 'mal-anime-enrichment-enabled',
        reason: MAL_ENRICHMENT_DISABLED_REASON,
        structural: "ei.provider = 'mal'",
    },
    {
        stageId: 'media-probe-a',
        task: () => mediaProbeTask,
        flag: 'DISABLE_MEDIA_PROBE',
        ruleId: 'media-probe-a-enabled',
        reason: MEDIA_PROBE_DISABLED_REASON,
        structural: 'NOT mf.is_missing',
    },
    {
        stageId: 'media-probe-b',
        task: () => mediaProbeTask,
        flag: 'DISABLE_MEDIA_PROBE',
        ruleId: 'media-probe-b-enabled',
        reason: MEDIA_PROBE_DISABLED_REASON,
        structural: "ms.stream_type = 'video'",
    },
    {
        stageId: 'trickplay-params-sync',
        task: () => trickplayParamsSyncTask,
        flag: 'DISABLE_TRICKPLAY_PARAMS',
        ruleId: 'trickplay-params-enabled',
        reason: TRICKPLAY_PARAMS_DISABLED_REASON,
        structural: "ms.stream_type = 'video'",
    },
] as const;

describe.each(CASES)('$stageId — $flag parks rows instead of leaving them pending', (c) => {
    const stage = (): StageLike => stageOf(c.task(), c.stageId);
    const predicate = () => {
        const d = dispositions(stage()).find(
            (entry) => (entry as { ruleId?: string }).ruleId === c.ruleId,
        );
        if (!d || d.kind !== 'predicate') throw new Error(`no predicate '${c.ruleId}'`);
        return d;
    };

    beforeEach(() => {
        for (const k of Object.keys(flags)) flags[k] = false;
    });

    it('is an enqueueable stage (the sweep counts and enqueues its rows)', () => {
        expect(stage().enqueueable).toBe(true);
    });

    it('enabled: the predicate is inert and eligibility passes to the structural clauses', () => {
        expect(String(predicate().excludes(fakeSql as never))).toBe('false');
        expect(eligibilityGate(stage())).toBe('true');
        expect(String(stage().eligibility?.sql?.(fakeSql))).toContain(c.structural);
    });

    it('disabled: the predicate disposes and eligibility is false', () => {
        flags[c.flag] = true;
        const excludes = String(predicate().excludes(fakeSql as never));
        if (c.stageId === 'mal-anime-id-enrichment') {
            // Scoped to series only the switch keeps out (see the next block).
            expect(excludes).toContain("ei.provider = 'mal'");
            expect(excludes).toContain("pm.metadata->'anime_genres' <> '[]'::jsonb");
        } else {
            expect(excludes).toBe('true');
        }
        expect(eligibilityGate(stage())).toBe('false');
    });

    it('the flag is re-read per call, so one sweep tick observes a flip either way', () => {
        expect(eligibilityGate(stage())).toBe('true');
        flags[c.flag] = true;
        expect(eligibilityGate(stage())).toBe('false');
        flags[c.flag] = false;
        expect(eligibilityGate(stage())).toBe('true');
    });

    it('disposes skipped_permanent under its own reason, which the heal reclaims', () => {
        const d = predicate() as { disposeAs?: string; reason?: string };
        expect(d.disposeAs).toBe('skipped_permanent');
        expect(d.reason).toBe(c.reason);
        expect(stage().eligibility?.recoverWhenAdditionalReasons).toContain(c.reason);
    });

    it('the disabled predicate is the FIRST disposition, and self-terminal is kept', () => {
        // First so a global-guard (mal's auth guard) cannot keep re-draining the
        // rows to skipped_transient while the task is off.
        const list = dispositions(stage());
        expect((list[0] as { ruleId?: string }).ruleId).toBe(c.ruleId);
        expect(list.map((d) => d.kind)).toContain('self-terminal');
    });
});

describe('mal-anime-id-enrichment — the disabled predicate leaves non-anime series to their own rules', () => {
    it('does not park a series the stage would skip anyway', () => {
        // The stage sets skipAutoDispose, so nothing re-labels a parked row once
        // the switch is back on and the heal only reclaims eligible rows. A
        // non-anime series parked as "disabled" would keep that label forever.
        flags.DISABLE_MAL_ANIME_ENRICHMENT = true;
        const stage = stageOf(malAnimeIdEnrichmentTask, 'mal-anime-id-enrichment');
        const d = dispositions(stage).find(
            (entry) => (entry as { ruleId?: string }).ruleId === 'mal-anime-enrichment-enabled',
        );
        if (!d || d.kind !== 'predicate') throw new Error('predicate missing');
        expect(String(d.excludes(fakeSql as never))).not.toBe('true');
        flags.DISABLE_MAL_ANIME_ENRICHMENT = false;
    });
});

describe.each(['media-probe-a', 'media-probe-b', 'trickplay-params-sync'] as const)(
    '%s — re-enabling a large library is not throttled to 50 rows per tick',
    (stageId) => {
        it('declares a heal limit above the sweep default', () => {
            const task =
                stageId === 'trickplay-params-sync' ? trickplayParamsSyncTask : mediaProbeTask;
            expect(stageOf(task, stageId).healLimit).toBeGreaterThanOrEqual(500);
        });
    },
);
