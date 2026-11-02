// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin IA redesign, plan step `task-descriptions` (spec §3.3/§8): every
 * registered, non-demo builtin task must have a curated one-sentence
 * operator description (`src/lib/utils/admin/task-descriptions.ts`). This
 * loads the real builtin registry (same path `watch-sync-reg.test.ts` uses)
 * and asserts coverage against the live task id list — so a new builtin
 * task added later without a description fails CI here instead of silently
 * shipping a blank card.
 */
import { describe, it, expect } from 'vitest';
import { registry } from '../registry.js';
import { loadBuiltins, _resetLoadedForTests } from './index.js';
import { hasCuratedDescription } from '$lib/utils/admin/task-descriptions.js';
import { hasCuratedName } from '$lib/utils/admin/task-names.js';

describe('task-descriptions coverage', () => {
    it('has a curated description for every non-demo builtin task', async () => {
        _resetLoadedForTests();
        await loadBuiltins();

        const tasks = registry.getAllTasks().filter((t) => t.demo !== true);
        expect(tasks.length).toBeGreaterThan(0);

        const missing = tasks.filter((t) => !hasCuratedDescription(t.id)).map((t) => t.id);
        expect(missing).toEqual([]);
    }, 60_000);

    // One vocabulary (spec 2026-09-27 §1.5): every builtin has ONE curated,
    // translated operator name (`task-names.ts`) that the task list, runs,
    // notifications and the pipeline page all use.
    it('has a curated name for every non-demo builtin task', async () => {
        _resetLoadedForTests();
        await loadBuiltins();

        const tasks = registry.getAllTasks().filter((t) => t.demo !== true);
        const missing = tasks.filter((t) => !hasCuratedName(t.id)).map((t) => t.id);
        expect(missing).toEqual([]);
    }, 60_000);
});
