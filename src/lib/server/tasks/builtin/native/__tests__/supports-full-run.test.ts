// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `supportsFullRun` is a PROMISE TO THE OPERATOR: pressing the admin action
 * posts `{ mode: 'manual' }` and the task will work through its whole backlog
 * instead of the short slice a scheduled run does.
 *
 * Nothing in the type system keeps that promise honest. The flag is declared by
 * hand on each task, while the behaviour it advertises lives in a completely
 * different place — whether `execute()` actually threads its `mode` input into
 * `resolveDrainMode`/`drainBacklog`. Those can drift apart silently, and the
 * failure is invisible: the button appears, the run starts, and it quietly
 * performs an ordinary catchup.
 *
 * That is not hypothetical. `library-embeddings.ts` and
 * `sonic-embedding-backfill.ts` both declare `backlog: {...}` yet ignore the
 * mode input entirely — `library-embeddings` hardcodes `{ mode: 'catchup' }`.
 * Either would look like a plausible candidate for the flag to a future author.
 *
 * So this asserts the correspondence in both directions against the source,
 * matching the convention used by the sibling coverage tests in this directory.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const nativeDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const sources = readdirSync(nativeDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: f, source: readFileSync(resolve(nativeDir, f), 'utf8') }));

/** Declares the flag in its task manifest. */
const declares = (s: string): boolean => /supportsFullRun:\s*true/.test(s);

/**
 * Threads an operator-supplied mode into a drain. `resolveDrainMode` is the
 * shared helper; the intro analyzer parses `rawInput.mode` itself and branches
 * on `mode === 'catchup'`, so both shapes count.
 */
const honoursMode = (s: string): boolean =>
    /resolveDrainMode\s*\(/.test(s) || /rawInput\.mode/.test(s);

describe('supportsFullRun matches what the task actually does', () => {
    it('finds the declaring tasks (a zero-match regex would pass everything)', () => {
        expect(sources.filter((s) => declares(s.source)).length).toBeGreaterThan(0);
    });

    it('every task declaring the flag actually honours a mode input', () => {
        const liars = sources
            .filter((s) => declares(s.source) && !honoursMode(s.source))
            .map((s) => s.file);
        expect(
            liars,
            `declare supportsFullRun but never read a mode input, so the admin ` +
                `action would silently perform an ordinary catchup: ${liars.join(', ')}`,
        ).toEqual([]);
    });

    /**
     * Tasks that honour a mode input but deliberately withhold the action.
     * Each entry is a decision with a reason recorded at the declaration site,
     * not an oversight — keep them in sync.
     */
    const WITHHELD = new Map([
        [
            'media-probe.ts',
            'identityFor is `global-${mode}`, so a manual drain takes a different ' +
                'exclusiveWith key from the 1h scheduled catchup and both probe the ' +
                'same unclaimed slice concurrently',
        ],
    ]);

    it('withheld tasks still explain themselves at the declaration site', () => {
        for (const [file] of WITHHELD) {
            const entry = sources.find((s) => s.file === file);
            expect(entry, `${file} is listed as withheld but no longer exists`).toBeDefined();
            expect(entry!.source, `${file} withholds the action but does not say why`).toContain(
                'supportsFullRun',
            );
        }
    });

    it('every task honouring a mode input declares the flag', () => {
        // The reverse direction: a task that CAN drain fully but hides it leaves
        // an operator no way to ask for it — the gap this flag exists to close.
        const hidden = sources
            .filter((s) => honoursMode(s.source) && !declares(s.source))
            .filter((s) => !WITHHELD.has(s.file))
            .map((s) => s.file);
        expect(
            hidden,
            `honour a mode input but do not declare supportsFullRun, so their ` +
                `full-run capability is unreachable from the admin UI: ${hidden.join(', ')}`,
        ).toEqual([]);
    });
});
