// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A finding the operator cannot act on never renders red.
 *
 * Observed on preprod: `stage-version-ledger-drift` sat at the top of the
 * dashboard as Critical, first seen five hours earlier, with remediation
 * reading "This is a code defect, not an operational one, and nothing you can
 * do from here fixes it." An unclearable red is the decay the red budget
 * exists to prevent — a board that reads nonzero forever stops being read.
 *
 * Amber rather than green, because it IS real and its own remediation asks the
 * operator to report it. It is simply not an emergency addressed to them.
 */

import { describe, it, expect } from 'vitest';
import { INVARIANTS } from './invariants.js';

describe('invariant labels are plain language', () => {
    /**
     * An invariant's label becomes the alert TITLE on the operator's home page
     * ("`${inv.label}: warning.`", health-verdict.ts). Seven of thirteen were
     * Title Cased Ids — "Metadata Storage Writability", "Stage Wedge Guard",
     * "Outbox Pending" — developer slugs with the hyphens swapped for spaces,
     * sitting where a self-hoster reads what is wrong with their server.
     *
     * The heuristic is deliberately crude: a short all-Capitalised phrase.
     * It catches the id-with-spaces shape without demanding a house style.
     */
    it('reads as a sentence, not a Title Cased Id', () => {
        const offenders = INVARIANTS.filter((inv) => {
            const words = inv.label.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
            return words.length > 0 && words.length <= 4 && words.every((w) => /^[A-Z]/.test(w));
        }).map((i) => `${i.id} -> ${i.label}`);
        expect(offenders, 'these labels read as developer ids').toEqual([]);
    });

    it('never puts a bare env var or setting name in a label', () => {
        for (const inv of INVARIANTS) {
            expect(inv.label, `${inv.id}`).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
        }
    });
});

describe('operatorActionable invariants', () => {
    it('flags exactly the invariants whose remediation says nothing can be done here', () => {
        // The flag and the prose must agree; either alone is a lie.
        for (const inv of INVARIANTS) {
            const saysNothingToDo = /nothing you can do from here|Nothing to do from here/i.test(
                inv.remediation,
            );
            expect(
                inv.operatorActionable === false,
                `${inv.id}: remediation says "nothing to do" = ${saysNothingToDo}, ` +
                    `operatorActionable === false is ${inv.operatorActionable === false}`,
            ).toBe(saysNothingToDo);
        }
    });

    it('covers the two known code-defect invariants', () => {
        const flagged = INVARIANTS.filter((i) => i.operatorActionable === false).map((i) => i.id);
        expect(flagged).toContain('stage-version-ledger-drift');
        expect(flagged).toContain('orphan-stage-rows');
    });

    it('leaves ordinary operational invariants actionable', () => {
        // The flag is an exception, not the norm — if most invariants became
        // unactionable the board would go quiet about real problems.
        const unactionable = INVARIANTS.filter((i) => i.operatorActionable === false).length;
        expect(unactionable).toBeLessThan(INVARIANTS.length / 2);
    });
});
