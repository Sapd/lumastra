// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The enforcement half of the decline-streak reset invariant.
 *
 * ## Why this is a static test and not a unit test
 *
 * The invariant — "every run-outcome write ends the decline streak" — is a claim
 * about a SET of writers scattered across `queries/`, `services/` and `tasks/`.
 * A unit test can only assert the writers someone remembered to list, and the
 * list is exactly what keeps being wrong: it was got wrong twice during design
 * review (four live sites missed the first time, two more the second), and this
 * codebase has the same scar elsewhere — a load-time master-key snapshot needed
 * ten call sites fixed, and a split stage id left four hand-maintained UI mirrors
 * pointing at a retired value.
 *
 * So the guarantee is this file, not the list. A new writer that forgets the
 * columns fails CI even if nobody updates any documentation.
 *
 * ## Why it asserts the COLUMNS and not a shared fragment
 *
 * The design originally called for a shared SQL fragment every site would splice
 * in. Splicing is how this codebase produced a malformed `$3AND` — postgres.js
 * concatenates adjacent template fragments with no separator — and a fragment
 * would have bought nothing, because a site that imported it and spliced it into
 * the wrong clause would still pass a "did you call the helper" check. Asserting
 * the effect is both stricter and free of that hazard.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALERT_FLOOR, FREE_DECLINES, DEMOTION_ONSET } from './decline-loop.js';

const SRC = join(process.cwd(), 'src');

/**
 * Writers that deliberately do NOT reset the streak. Each is here for a reason
 * that would be a bug to "fix".
 */
const ALLOWLIST = new Map<string, string>([
    [
        'resetRunningToPending',
        'the decline write itself — it INCREMENTS the streak, and is the only writer that does',
    ],
    [
        'reclaimWedgedRunningStageRows',
        'writes failed_transient with `attempt` deliberately unchanged, so no cap is escalating. ' +
            'Resetting here would erase the streak on the decline/wedge loop and make ' +
            "`failed_transient` in the alert derive's status list dead code.",
    ],
    [
        'releaseWedgedRunningForStage',
        'operator-forced recovery of a wedged row, same shape as the reclaimer: failed_transient ' +
            'with `attempt` unchanged. The streak is evidence the operator is acting on.',
    ],
    [
        'deferTransientRetryBatch',
        'a DEFER, not an outcome — its contract is explicitly "WITHOUT changing status" for ' +
            'transient unavailability (a mount outage). The row keeps its state, so it keeps its streak.',
    ],
    [
        'releaseSkippedTransientForReason',
        'shortens a global-guard backoff when the missing key is saved; not an outcome. The ' +
            'row stays skipped_transient, so it keeps its streak.',
    ],
    ['upsertRunningRow', 'claims a row for a run; not an outcome'],
    ['markRunning', 'claims a row for a run; not an outcome'],
]);

interface Stmt {
    file: string;
    fn: string;
    body: string;
}

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.svelte-kit') continue;
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
    }
    return out;
}

/**
 * Every SQL statement in the repo that writes `media_item_stage_state`, tagged
 * with the enclosing exported function so a failure names something greppable.
 */
function collectStageStateWrites(): Stmt[] {
    const stmts: Stmt[] = [];
    for (const file of walk(SRC)) {
        const text = readFileSync(file, 'utf8');
        if (!text.includes('media_item_stage_state')) continue;
        const lines = text.split('\n');
        let fn = '<module>';
        let start: number | null = null;
        for (let i = 0; i < lines.length; i++) {
            const nameMatch = /^(?:export )?(?:async )?function (\w+)/.exec(lines[i]);
            if (nameMatch) fn = nameMatch[1];
            if (/sql\w*(?:<[^`]*>)?`|txSql`/.test(lines[i]) && start === null) start = i;
            if (start !== null && lines[i].includes('`;')) {
                stmts.push({ file, fn, body: lines.slice(start, i + 1).join('\n') });
                start = null;
            }
        }
    }
    return stmts;
}

const WRITES = collectStageStateWrites().filter(
    (s) =>
        /UPDATE\s+media_item_stage_state/.test(s.body) ||
        /ON CONFLICT \(media_item_id, stage_id\) DO UPDATE/.test(s.body),
);

function resets(body: string): boolean {
    return /declines\s*=\s*0/.test(body) && /declines_since\s*=\s*NULL/.test(body);
}

describe('decline-streak reset invariant', () => {
    it('finds the stage-state write sites at all (guards the scanner itself)', () => {
        // A scanner that silently matched nothing would make every assertion
        // below vacuously true — the failure mode a static test must not have.
        expect(WRITES.length).toBeGreaterThan(20);
    });

    /**
     * Predicate 1: any write that zeroes `attempt` is putting a row back into
     * circulation, so the streak must go with it.
     */
    it('every write that resets `attempt` also resets the decline streak', () => {
        const offenders = WRITES.filter(
            (s) => /attempt\s*=\s*0/.test(s.body) && !resets(s.body) && !ALLOWLIST.has(s.fn),
        ).map((s) => `${s.fn} (${s.file.replace(SRC, 'src')})`);
        expect(offenders).toEqual([]);
    });

    /**
     * Predicate 2 — the one that matters. An earlier revision of this test only
     * had predicate 1, which matches the pending-flips and is blind to every
     * terminal writer: `markCompleted` touches neither `attempt` nor `pending`.
     * That gap is not cosmetic. Three writers carry `completed` rows to
     * `obsolete`, and `stage-version-detector` does it stage-wide on every
     * processing-version bump — i.e. at deploys — so a stale streak riding a
     * completed row would surface as a mass false "not progressing since three
     * weeks" alert the first time anyone deployed.
     */
    it('every write that sets a non-running status resets the decline streak', () => {
        const offenders = WRITES.filter((s) => {
            if (ALLOWLIST.has(s.fn) || resets(s.body)) return false;
            const statuses = [...s.body.matchAll(/status\s*=\s*'(\w+)'/g)].map((m) => m[1]);
            return statuses.some((st) => st !== 'running');
        }).map((s) => `${s.fn} (${s.file.replace(SRC, 'src')})`);
        expect(offenders).toEqual([]);
    });

    it('every allowlisted writer still exists — a stale exemption hides a real gap', () => {
        const seen = new Set(WRITES.map((s) => s.fn));
        expect([...ALLOWLIST.keys()].filter((fn) => !seen.has(fn))).toEqual([]);
    });
});

describe('decline-loop constants', () => {
    /**
     * The blocker that killed revision R3: the floor and the demotion onset were
     * chosen separately and drifted by one. Past `DEMOTION_ONSET` a row carries a
     * `next_eligible_at`, and `findSweepCandidates` orders
     * `next_eligible_at ASC NULLS FIRST` — so it sorts behind the entire
     * NULL-pending backlog and, on a busy stage, may never be picked again.
     * `declines` only advances when a row IS picked, so a floor even one above
     * the onset is unreachable and the alert can never fire.
     *
     * Assert the RELATIONSHIP, not the values — pinning the numbers would pass
     * just as happily with the two constants drifting together.
     */
    it('ALERT_FLOOR is exactly DEMOTION_ONSET, never above it', () => {
        expect(ALERT_FLOOR).toBe(DEMOTION_ONSET);
        expect(DEMOTION_ONSET).toBe(FREE_DECLINES + 1);
    });

    /**
     * The index predicate (migration 16.240.0, squashed into the base schema in
     * 16.300.0) is a frozen literal — an index predicate cannot reference a TS
     * constant, and resolving one at migration time would fork fresh-install
     * indexes from upgraded ones. So moving the floor must fail HERE, forcing a
     * new rebuild migration, rather than silently leaving the derive's
     * predicate outside the index's coverage and degrading a query on a
     * 60-second reconcile loop to a sequential scan with nothing failing.
     */
    it("the base schema's frozen index predicate still equals ALERT_FLOOR", () => {
        const baseSchema = readFileSync(
            join(SRC, 'lib/server/database/base-schema-sql.ts'),
            'utf8',
        );
        const match = /idx_stage_state_decline_streak ON [^;]*WHERE \(declines >= (\d+)\)/.exec(
            baseSchema,
        );
        expect(match, 'index predicate not found in the base schema').not.toBeNull();
        expect(Number(match![1])).toBe(ALERT_FLOOR);
    });
});
