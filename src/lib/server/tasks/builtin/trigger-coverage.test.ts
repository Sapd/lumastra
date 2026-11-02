// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every registered builtin must declare HOW it gets triggered.
 *
 * `TaskRegistry.classifyTriggers()` walks a fixed ladder — demo, static
 * schedule, dynamic schedule, pipeline child, enqueueable covered stage,
 * `manualOnly` — and anything that falls off the end is `unknown`. The
 * orchestrator's boot-time `auditTriggerCoverage()` treats `unknown` as an
 * orphan: it logs at ERROR in production and THROWS everywhere else. Because
 * that throw happens before the orchestrator singleton is assigned, a single
 * undeclared task leaves the entire task system dead for the process, in dev
 * and in every test that boots it — and the only symptom is one exception far
 * from the task that caused it.
 *
 * `music-embedding-projection-fit` shipped in exactly that state: it dropped
 * its `schedule` on purpose (fitting a basis is a deliberate operator action)
 * and said so in a comment, but a comment is not a declaration. This test is
 * the declaration check, run against the real builtin registry the same way
 * `task-descriptions-coverage.test.ts` does, so the next task that omits a
 * schedule fails here instead of at someone's next `npm run dev`.
 */
import { describe, it, expect } from 'vitest';
import { registry } from '../registry.js';
import { loadBuiltins, _resetLoadedForTests } from './index.js';

describe('builtin trigger coverage', () => {
    it('does not expose a full-library keyword refetch in the admin task inventory', async () => {
        _resetLoadedForTests();
        await loadBuiltins();

        expect(registry.getAllTasks().map((task) => task.id)).not.toContain(
            'metadata-keyword-backfill',
        );
    }, 60_000);

    it('classifies every builtin task — no task falls through to `unknown`', async () => {
        _resetLoadedForTests();
        await loadBuiltins();

        const coverage = registry.classifyTriggers();
        expect(coverage.size).toBeGreaterThan(0);

        const orphans = [...coverage.entries()]
            .filter(([, c]) => c.kind === 'unknown')
            .map(([id]) => id)
            .sort();

        // The failure message is the remediation: declare a schedule, a
        // dynamicSchedule, pipeline membership, an enqueueable covered stage,
        // or `manualOnly: true`.
        expect(orphans).toEqual([]);
    }, 60_000);
});
