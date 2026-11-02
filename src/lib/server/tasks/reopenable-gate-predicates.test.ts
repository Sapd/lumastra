// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which author predicates the stage sweep treats as GATES whose skips it
 * re-labels once the gate opens (see `reopenableGatePredicates`).
 *
 * Too wide and the sweep flips rows to `pending` that nothing re-disposes — a
 * readiness-gated predicate whose "not matching" means "not decided yet", or a
 * stage that skips the eligibility dispose. Too narrow and a row keeps telling
 * the operator to fix something that is already fixed.
 */

import { describe, it, expect } from 'vitest';
import type { StageTerminalDisposition } from '@sapd/lumastra-plugin-sdk';
import { reopenableGatePredicates } from './stage-disposition-runner.js';

const excludes = (() => 'x') as never;

function predicate(
    reason: string,
    extra: Partial<Extract<StageTerminalDisposition, { kind: 'predicate' }>> = {},
): StageTerminalDisposition {
    return {
        kind: 'predicate',
        ruleId: `rule-${reason}`,
        disposeAs: 'skipped_permanent',
        reason,
        excludes,
        ...extra,
    } as StageTerminalDisposition;
}

function stage(
    terminalDisposition: StageTerminalDisposition | StageTerminalDisposition[] | undefined,
    eligibility: Record<string, unknown> | undefined = {
        sql: () => 'true',
        recoverWhenAdditionalReasons: ['feature-off', 'no-engine'],
    },
): Parameters<typeof reopenableGatePredicates>[0] {
    return { id: 's', terminalDisposition, eligibility } as never;
}

const reasons = (s: Parameters<typeof reopenableGatePredicates>[0]): string[] =>
    reopenableGatePredicates(s).map((g) => g.reason);

describe('reopenableGatePredicates', () => {
    it('picks skipped_permanent predicates whose reason the heal already reclaims', () => {
        expect(reasons(stage([predicate('feature-off'), predicate('no-engine')]))).toEqual([
            'feature-off',
            'no-engine',
        ]);
    });

    it('accepts a single (non-array) disposition', () => {
        expect(reasons(stage(predicate('feature-off')))).toEqual(['feature-off']);
    });

    it('skips a predicate whose reason is not recoverable (a real per-item verdict)', () => {
        expect(reasons(stage([predicate('feature-off'), predicate('has-tag-mbid')]))).toEqual([
            'feature-off',
        ]);
    });

    it('skips readiness-gated predicates: "not matching" can mean "not decided yet"', () => {
        expect(
            reasons(
                stage([
                    predicate('feature-off', {
                        requiresQuietUpstream: { windowMs: 1000, scope: 'self' },
                    }),
                    predicate('no-engine', { requiresUpstreamRun: 'mdblist-sync' }),
                ]),
            ),
        ).toEqual([]);
    });

    it('skips transient and completed dispositions, global guards and self-terminal', () => {
        expect(
            reasons(
                stage([
                    predicate('feature-off', { disposeAs: 'skipped_transient', retryAfterMs: 1 }),
                    predicate('no-engine', { disposeAs: 'completed' }),
                    { kind: 'self-terminal', ruleId: 'self' } as StageTerminalDisposition,
                ]),
            ),
        ).toEqual([]);
    });

    it('never treats the eligibility skip reason itself as a gate', () => {
        expect(
            reasons(
                stage([predicate('ineligible')], {
                    sql: () => 'true',
                    recoverWhenAdditionalReasons: ['ineligible'],
                }),
            ),
        ).toEqual([]);
    });

    it('nothing without a native eligibility.sql, or when the eligibility dispose is off', () => {
        const gates = [predicate('feature-off')];
        expect(reasons(stage(gates, { recoverWhenAdditionalReasons: ['feature-off'] }))).toEqual(
            [],
        );
        expect(
            reasons(
                stage(gates, {
                    appliesTo: () => true,
                    recoverWhenAdditionalReasons: ['feature-off'],
                }),
            ),
        ).toEqual([]);
        expect(
            reasons(
                stage(gates, {
                    sql: () => 'true',
                    skipAutoDispose: true,
                    recoverWhenAdditionalReasons: ['feature-off'],
                }),
            ),
        ).toEqual([]);
    });
});
