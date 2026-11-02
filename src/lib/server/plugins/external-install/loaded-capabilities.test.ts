// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { bundleCapabilityViolation, loadTimeCapabilityViolation } from './loaded-capabilities.js';

/** A stub registry reader: contract id -> what that contract registered. */
const reader = (m: Record<string, Record<string, unknown> | null>) => (id: string) => m[id] ?? null;

describe('bundleCapabilityViolation', () => {
    it('accepts a bundle that registers no more than it declared', () => {
        expect(
            bundleCapabilityViolation(
                { http: true, database: true },
                [{ id: 'p', kind: 'task' }],
                reader({ p: { http: true } }),
            ),
        ).toBeNull();
    });

    it('REFUSES a contract that registers a capability it did not declare', () => {
        // The upgrade case that had no check at all: a v2 whose signed manifest
        // still says {http:true} while its code reaches for the database.
        expect(
            bundleCapabilityViolation(
                { http: true },
                [{ id: 'p', kind: 'task' }],
                reader({ p: { http: true, database: true } }),
            ),
        ).toMatch(/database/);
    });

    it('compares the UNION across contracts, not each contract alone', () => {
        // Each half is individually within a subset of the declared set; only
        // the union exceeds it. Comparing per-contract would admit this.
        expect(
            bundleCapabilityViolation(
                { http: true },
                [
                    { id: 'p', kind: 'task' },
                    { id: 'p-ui', kind: 'feature' },
                ],
                reader({ p: { http: true }, 'p-ui': { browserUi: true } }),
            ),
        ).toMatch(/browserUi/);
    });

    it('unions allowedDomains across contracts rather than letting one win', () => {
        expect(
            bundleCapabilityViolation(
                { http: true, allowedDomains: ['a.example'] },
                [
                    { id: 'p', kind: 'task' },
                    { id: 'p2', kind: 'integration' },
                ],
                reader({
                    p: { http: true, allowedDomains: ['a.example'] },
                    p2: { http: true, allowedDomains: ['evil.example'] },
                }),
            ),
        ).toMatch(/evil\.example/);
    });

    it('declaring more than you use is fine — it is an upper bound, not equality', () => {
        expect(
            bundleCapabilityViolation(
                { http: true, database: true, browserUi: true },
                [{ id: 'p', kind: 'task' }],
                reader({ p: {} }),
            ),
        ).toBeNull();
    });

    it('is inert when the manifest declared nothing (pre-metadata plugins)', () => {
        expect(
            bundleCapabilityViolation(
                undefined,
                [{ id: 'p', kind: 'task' }],
                reader({ p: { database: true } }),
            ),
        ).toBeNull();
    });

    it('does NOT treat an unreadable contract as "registered nothing"', () => {
        // A kind missing from readLoadedCapabilities reads as null. Treating
        // that as an empty set would report "within bounds" for a plugin whose
        // capabilities are simply unknown — failing open on the exact gap that
        // let subtitle/lyrics/auth providers skip the bound entirely.
        expect(
            bundleCapabilityViolation(
                { http: true },
                [{ id: 'p', kind: 'task' }],
                reader({ p: null }),
            ),
        ).toBeNull();
    });
});

describe('loadTimeCapabilityViolation', () => {
    const read = (m: Record<string, Record<string, unknown> | null>) => (id: string) =>
        m[id] ?? null;

    it('REFUSES an upgrade that registers more than its manifest declared', () => {
        // The case with no check at all before: install stages an upgrade for
        // restart and never runs the fresh-install comparison, so the load is
        // the only place it can be caught.
        expect(
            loadTimeCapabilityViolation(
                { capabilities: { http: true } },
                { loaded: true, id: 'p', kind: 'task' },
                read({ p: { http: true, database: true } }),
            ),
        ).toMatch(/database/);
    });

    it('accepts a load within the declared bound', () => {
        expect(
            loadTimeCapabilityViolation(
                { capabilities: { http: true, database: true } },
                { loaded: true, id: 'p', kind: 'task' },
                read({ p: { http: true } }),
            ),
        ).toBeNull();
    });

    it('covers every contract of a multi-contract bundle, not just the first', () => {
        expect(
            loadTimeCapabilityViolation(
                { capabilities: { http: true } },
                { loaded: true, ids: ['p', 'p-ui'], kinds: ['task', 'feature'] },
                read({ p: { http: true }, 'p-ui': { browserUi: true } }),
            ),
        ).toMatch(/browserUi/);
    });

    // --- the paths where the gate deliberately does NOT fire ---
    // Each is a door the check depends on someone else having opened. They are
    // correct, but they are the reason "the gate exists" is not the same claim
    // as "the gate ran".

    it('does not fire when the load itself failed', () => {
        expect(
            loadTimeCapabilityViolation(
                { capabilities: { http: true } },
                { loaded: false, id: 'p', kind: 'task' },
                read({ p: { database: true } }),
            ),
        ).toBeNull();
    });

    it('does not fire for a row with no manifest metadata (pre-metadata installs)', () => {
        expect(
            loadTimeCapabilityViolation(
                null,
                { loaded: true, id: 'p', kind: 'task' },
                read({ p: { database: true } }),
            ),
        ).toBeNull();
    });

    it('does not fire when the manifest declared no capabilities at all', () => {
        // An upper bound cannot be enforced against an absent declaration. This
        // is disclosure, not restriction: a publisher declaring nothing gets no
        // bound, and the operator sees an empty capability list at install time
        // and judges. Worth pinning so nobody "fixes" it into a deny-by-default
        // that would refuse every pre-metadata plugin.
        expect(
            loadTimeCapabilityViolation(
                {},
                { loaded: true, id: 'p', kind: 'task' },
                read({ p: { database: true } }),
            ),
        ).toBeNull();
    });
});
