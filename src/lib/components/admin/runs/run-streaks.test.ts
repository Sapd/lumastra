// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { collapseRunStreaks } from './run-streaks.js';
import type { Run } from '$lib/schemas/run.schema.js';

let seq = 0;
function makeRun(over: Partial<Run> = {}): Run {
    seq += 1;
    return {
        id: `run-${seq}`,
        taskId: 'mal-anime-id-enrichment',
        label: 'MAL Anime ID Enrichment',
        state: 'completed',
        input: undefined,
        trigger: { kind: 'scheduled' },
        startedAt: new Date(Date.now() - seq * 60_000).toISOString(),
        stages: [],
        actor: { type: 'system' },
        ...over,
    };
}

function failedRun(message: string, over: Partial<Run> = {}): Run {
    return makeRun({ state: 'failed', error: { message }, ...over });
}

describe('collapseRunStreaks', () => {
    it('passes through non-failed runs untouched', () => {
        const runs = [makeRun(), makeRun(), makeRun()];
        const items = collapseRunStreaks(runs);
        expect(items).toEqual(runs.map((run) => ({ kind: 'run', run })));
    });

    it('leaves a streak of 2 identical failures uncollapsed', () => {
        const runs = [
            failedRun('upstream outage — 0 enriched with 3 error(s).'),
            failedRun('upstream outage — 0 enriched with 3 error(s).'),
        ];
        const items = collapseRunStreaks(runs);
        expect(items).toEqual(runs.map((run) => ({ kind: 'run', run })));
    });

    it('collapses 3+ consecutive failures sharing the same displayed failure line', () => {
        const message = 'upstream outage — 0 enriched with 3 error(s).';
        const runs = [
            failedRun(message),
            failedRun(message),
            failedRun(message),
            failedRun(message),
        ];
        const items = collapseRunStreaks(runs);

        expect(items).toHaveLength(2);
        expect(items[0]).toEqual({ kind: 'run', run: runs[0] });
        expect(items[1]).toMatchObject({
            kind: 'streak',
            id: runs[0].id,
            newest: runs[0],
            collapsed: [runs[1], runs[2], runs[3]],
            oldestStartedAt: runs[3].startedAt,
        });
    });

    it('does not bridge a streak across a run with a different failure line', () => {
        const message = 'upstream outage — 0 enriched with 3 error(s).';
        const runs = [
            failedRun(message),
            failedRun(message),
            failedRun(message),
            failedRun('a completely different failure'),
            failedRun(message),
            failedRun(message),
            failedRun(message),
        ];
        const items = collapseRunStreaks(runs);

        // First streak of 3 (newest row + toggle), the lone different failure,
        // second streak of 3 (newest row + toggle).
        expect(items).toHaveLength(5);
        expect(items[0]).toEqual({ kind: 'run', run: runs[0] });
        expect(items[1]).toMatchObject({ kind: 'streak', collapsed: [runs[1], runs[2]] });
        expect(items[2]).toEqual({ kind: 'run', run: runs[3] });
        expect(items[3]).toEqual({ kind: 'run', run: runs[4] });
        expect(items[4]).toMatchObject({ kind: 'streak', collapsed: [runs[5], runs[6]] });
    });

    it('does not bridge a streak across a run with a different state', () => {
        const message = 'upstream outage — 0 enriched with 3 error(s).';
        const runs = [
            failedRun(message),
            failedRun(message),
            makeRun({ state: 'active' }),
            failedRun(message),
            failedRun(message),
        ];
        const items = collapseRunStreaks(runs);

        // Neither run of 2 reaches the min streak length of 3, so nothing collapses.
        expect(items).toEqual(runs.map((run) => ({ kind: 'run', run })));
    });

    it('uses the same explained summary as RunCard, so runner-internal phrasings collapse too', () => {
        // Both messages are recognized by explainRunError as the same hard-timeout
        // explanation, even though the raw text differs run to run.
        const runs = [
            failedRun('Handler runtime 300s exceeded hard timeout'),
            failedRun('Handler runtime 305s exceeded hard timeout'),
            failedRun('Handler runtime 301s exceeded hard timeout'),
        ];
        const items = collapseRunStreaks(runs);
        expect(items).toHaveLength(2);
        expect(items[1]).toMatchObject({ kind: 'streak', collapsed: [runs[1], runs[2]] });
    });

    it('treats task-authored messages with a stripped task-id prefix as matching', () => {
        const runs = [
            failedRun('mal-anime-id-enrichment: upstream outage — 0 enriched with 3 error(s).'),
            failedRun('upstream outage — 0 enriched with 3 error(s).'),
            failedRun('upstream outage — 0 enriched with 3 error(s).'),
        ];
        const items = collapseRunStreaks(runs);
        expect(items).toHaveLength(2);
        expect(items[1]).toMatchObject({ kind: 'streak', collapsed: [runs[1], runs[2]] });
    });

    it('never collapses runs that are not failures at all', () => {
        const runs = [makeRun({ state: 'completed' }), makeRun({ state: 'cancelled' })];
        const items = collapseRunStreaks(runs);
        expect(items).toEqual(runs.map((run) => ({ kind: 'run', run })));
    });

    it("collapses a structurally-typed run shape narrower than the full SDK Run (the task drawer's shape)", () => {
        // TaskRecentRuns.svelte (the task drawer's Recent Runs tab) fetches the
        // same `Run` shape as RunList today, but `collapseRunStreaks` is typed
        // against the minimal `StreakableRun` structural type rather than the
        // full SDK `Run` — this proves any run-shaped list can reuse it without
        // needing every SDK field.
        interface DrawerRun {
            id: string;
            taskId: string;
            state: string;
            startedAt: string;
            error?: { message: string };
        }
        function makeDrawerRun(idx: number, over: Partial<DrawerRun> = {}): DrawerRun {
            return {
                id: `drawer-run-${idx}`,
                taskId: 'mal-anime-id-enrichment',
                state: 'completed',
                startedAt: new Date(Date.now() - idx * 60_000).toISOString(),
                ...over,
            };
        }

        const message = 'upstream outage — 0 enriched with 3 error(s).';
        const runs: DrawerRun[] = [
            makeDrawerRun(0, { state: 'failed', error: { message } }),
            makeDrawerRun(1, { state: 'failed', error: { message } }),
            makeDrawerRun(2, { state: 'failed', error: { message } }),
        ];

        const items = collapseRunStreaks(runs);

        expect(items).toHaveLength(2);
        expect(items[0]).toEqual({ kind: 'run', run: runs[0] });
        expect(items[1]).toMatchObject({
            kind: 'streak',
            id: runs[0].id,
            newest: runs[0],
            collapsed: [runs[1], runs[2]],
            oldestStartedAt: runs[2].startedAt,
        });
    });
});
