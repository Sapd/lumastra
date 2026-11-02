// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `supportsForceRun` is a PROMISE THAT DATA WILL BE DESTROYED: pressing the
 * action posts `{ mode: 'force' }`, and the operator is shown a warning saying
 * the task will discard what it produced and rebuild it.
 *
 * `drainBacklog` performs that wipe by calling the task's own `onWipe` hook,
 * and a task that reaches force mode WITHOUT one degrades to an ordinary manual
 * drain with a log warning — the operator asked to rebuild everything, agreed to
 * a destructive dialog, and silently got a plain catch-up. Nothing in the type
 * system connects the flag to the hook, so this asserts the correspondence in
 * both directions against the source, matching `supports-full-run.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const nativeDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const sources = readdirSync(nativeDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: f, source: readFileSync(resolve(nativeDir, f), 'utf8') }));

const declares = (s: string): boolean => /supportsForceRun:\s*true/.test(s);

/** Supplies the hook drainBacklog calls before the first slice in force mode. */
const wipes = (s: string): boolean => /onWipe:/.test(s);

describe('supportsForceRun matches what the task actually does', () => {
    it('finds the declaring tasks (a zero-match regex would pass everything)', () => {
        expect(sources.filter((s) => declares(s.source)).length).toBeGreaterThan(0);
    });

    it('every task offering a force run actually wipes', () => {
        const liars = sources
            .filter((s) => declares(s.source) && !wipes(s.source))
            .map((s) => s.file);
        expect(
            liars,
            `declare supportsForceRun but pass no onWipe, so the destructive ` +
                `dialog would be followed by an ordinary manual drain: ${liars.join(', ')}`,
        ).toEqual([]);
    });

    it('every task that wipes also offers the action', () => {
        // The reverse direction: a task that CAN rebuild but hides it leaves an
        // operator no way to ask for it.
        const hidden = sources
            .filter((s) => wipes(s.source) && !declares(s.source))
            .map((s) => s.file);
        expect(
            hidden,
            `pass onWipe but do not declare supportsForceRun, so their rebuild ` +
                `capability is unreachable from the admin UI: ${hidden.join(', ')}`,
        ).toEqual([]);
    });

    it('force is never offered without a full run, since force IS a full run', () => {
        // `drainBacklog` treats force as manual-plus-a-wipe. A task offering the
        // destructive option while claiming it cannot drain its backlog would be
        // incoherent, and the card renders force inside the full-run dialog.
        const incoherent = sources
            .filter((s) => declares(s.source) && !/supportsFullRun:\s*true/.test(s.source))
            .map((s) => s.file);
        expect(incoherent).toEqual([]);
    });
});
