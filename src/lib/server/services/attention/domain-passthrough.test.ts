// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A producer-stated `domain` must survive the whole path, not just the adapter.
 *
 * This test exists because the domain plumbing shipped INERT and every existing
 * test passed. `adaptStorageCapacity` set `domain: 'storage'`, and
 * `adapters.storage-capacity.test.ts` asserted it — one call before `reconcile`
 * dropped the field while building its literals. `UpsertAlert.domain` is
 * optional, so the omission compiled; the upsert then fell back to
 * `domainForType('degraded-component')` and wrote 'system'. A disk-full alert
 * was indistinguishable from four unrelated component-health rows.
 *
 * Asserting at the adapter is not enough. The seam that broke is adapter →
 * reconcile → upsert, so that is what this covers.
 */

import { describe, it, expect } from 'vitest';
import { reconcile, itemFromRow } from './reconcile.js';
import type { DerivedAlert, AlertRow } from './types.js';

function derived(over: Partial<DerivedAlert> = {}): DerivedAlert {
    return {
        id: 'storage:capacity:library',
        fingerprint: 'low:2',
        type: 'degraded-component',
        domain: 'storage',
        severity: 'critical',
        title: 'The library disk is nearly full',
        actions: [],
        ...over,
    } as DerivedAlert;
}

const NOW = '2026-08-27T00:00:00.000Z';

describe('producer-stated domain survives reconcile', () => {
    it('reaches the UPSERT, so the DB column records what the producer said', () => {
        const { upserts } = reconcile([derived()], [], NOW);
        expect(upserts).toHaveLength(1);
        expect(upserts[0].domain).toBe('storage');
    });

    it('reaches the WIRE item, so the Health page groups it correctly', () => {
        const { items } = reconcile([derived()], [], NOW);
        expect(items[0].domain).toBe('storage');
    });

    it('does not invent a domain for a producer that states none', () => {
        // Every pre-existing adapter omits it and must keep resolving through
        // the deprecated `type` map at the serialization boundary.
        const { upserts, items } = reconcile([derived({ domain: undefined })], [], NOW);
        expect(upserts[0].domain).toBeUndefined();
        expect(items[0].domain).toBeUndefined();
    });

    it('reads the persisted domain back out of a row', () => {
        const row: AlertRow = {
            id: 'storage:capacity:library',
            fingerprint: 'low:2',
            type: 'degraded-component',
            domain: 'storage',
            severity: 'critical',
            title: 'The library disk is nearly full',
            detail: null,
            source_ref: null,
            status: 'active',
            first_seen: NOW,
            last_seen: NOW,
            acked_at: null,
            acked_by: null,
            acked_fingerprint: null,
            count: null,
            acked_count: null,
            snoozed_until: null,
            resolved_at: null,
        } as AlertRow;
        expect(itemFromRow(row, NOW).domain).toBe('storage');
    });
});
