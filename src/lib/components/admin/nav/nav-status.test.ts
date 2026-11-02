// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * `sectionAttentionCount` is one of the two CONSUMERS of `sectionForItem`, and
 * the consumers are where the operator-visible symptom appeared both times a
 * prefix mismatch shipped (`scan-run:`, then `music-hygiene:`): the item counted
 * into the System nav tooltip instead of Library's.
 *
 * The map itself has a structural guard that enumerates producers
 * (`admin-status-payload.service.test.ts`). Neither consumer had a test at all,
 * so a consumer that reimplemented the mapping — filtered on `item.domain`, or
 * compared against the wrong section — would ship green with the map perfectly
 * correct. These tests assert AGREEMENT with `sectionForItem` over the shared
 * representative-id table rather than restating the expected sections, so the
 * map's own completeness guard reaches this file too.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AdminStatusPayload, AdminSectionId } from '$lib/schemas/api-admin-status-payload.js';
import type { AttentionItem } from '$lib/schemas/api-attention-responses.js';
import type { AdminNavSection } from '$lib/config/admin-nav.js';
import { sectionForItem } from '$lib/shared/attention-section-map.js';
import {
    ALL_SECTION_IDS,
    IDS_BY_SECTION,
    SECTIONS_WITH_IDS,
    attentionItem,
} from '$lib/shared/__fixtures__/attention-section-ids.js';

const store = vi.hoisted(() => ({
    payload: null as AdminStatusPayload | null,
    loading: false,
}));

vi.mock('$lib/stores/admin-status.store.svelte.js', () => ({ adminStatus: store }));

const { sectionAttentionCount, sectionDot, verdictToDot } = await import('./nav-status.js');

const ALL_SECTIONS: AdminSectionId[] = [
    'home',
    'library',
    'tasks',
    'system',
    'users',
    'settings',
    'developer',
];

function setPayload(items: AttentionItem[], sectionStatus: Record<string, string> = {}): void {
    store.payload = {
        attention: { items, unavailable: false },
        sectionStatus,
    } as unknown as AdminStatusPayload;
}

beforeEach(() => {
    store.payload = null;
    store.loading = false;
});

describe('sectionAttentionCount', () => {
    /**
     * The agreement property, per item. Each id is loaded ALONE, so the one
     * section that gains a count is exactly the section `sectionForItem` names
     * and every other section stays at zero — a consumer that mapped
     * `music-hygiene:` to `system` fails on the id AND on the section it stole
     * the count from.
     *
     * Revert-check (CROSS-WIRE): change the consumer to compare
     * `sectionForItem(item) !== id`, or to read `item.domain` instead of the
     * map, and every case here fails.
     */
    it.each(ALL_SECTION_IDS)('counts %s into exactly the section the map names', (id) => {
        const expected = sectionForItem({ id });
        setPayload([attentionItem({ id })]);

        for (const section of ALL_SECTIONS) {
            expect(sectionAttentionCount(section), `${id} → ${section}`).toBe(
                section === expected ? 1 : 0,
            );
        }
    });

    /**
     * The same table loaded all at once — the real shape of a payload. A
     * consumer that counted every open item into every section, or that stopped
     * at the first match, passes the per-item case above and fails this one.
     */
    it('splits a full payload across sections exactly as the map does', () => {
        setPayload(ALL_SECTION_IDS.map((id) => attentionItem({ id })));

        for (const section of SECTIONS_WITH_IDS) {
            expect(sectionAttentionCount(section), section).toBe(IDS_BY_SECTION[section].length);
        }
        // Nothing in the table maps to these, and the counts must say so rather
        // than absorbing the unmatched remainder.
        expect(sectionAttentionCount('system')).toBe(0);
        expect(sectionAttentionCount('users')).toBe(0);
        expect(sectionAttentionCount('developer')).toBe(0);
        // Every item landed somewhere: no item is counted twice or dropped.
        const total = ALL_SECTIONS.reduce((n, s) => n + sectionAttentionCount(s), 0);
        expect(total).toBe(ALL_SECTION_IDS.length);
    });

    /**
     * Unknown prefixes are the map's catch-all, and Health is the surface that
     * owns them. A consumer that silently dropped what it could not classify
     * would leave the item with no dot anywhere.
     */
    it('counts an unknown prefix into system, not into nothing', () => {
        setPayload([attentionItem({ id: 'some-future-source:x' })]);

        expect(sectionAttentionCount('system')).toBe(1);
        expect(ALL_SECTIONS.reduce((n, s) => n + sectionAttentionCount(s), 0)).toBe(1);
    });

    /**
     * The tooltip explains why the dot is LIT, so it may only count what is
     * still open. Asserted against a payload where the acked and snoozed items
     * share a section with an open one, so a consumer that dropped the filter
     * reports 3 where the dot is lit by 1.
     */
    it('ignores acked and snoozed items', () => {
        const [libraryId] = IDS_BY_SECTION.library;
        setPayload([
            attentionItem({ id: libraryId }),
            attentionItem({ id: libraryId + '-acked', acked: true }),
            attentionItem({ id: libraryId + '-snoozed', snoozed: true }),
        ]);

        expect(sectionAttentionCount('library')).toBe(1);
    });

    it('reports zero when the payload has not arrived yet', () => {
        store.payload = null;
        for (const section of ALL_SECTIONS) {
            expect(sectionAttentionCount(section), section).toBe(0);
        }
    });
});

describe('verdictToDot and sectionDot', () => {
    it('hides the dot only for healthy', () => {
        expect(verdictToDot('healthy').show).toBe(false);
        expect(verdictToDot(undefined).show).toBe(false);
        expect(verdictToDot('degraded').show).toBe(true);
        expect(verdictToDot('critical').show).toBe(true);
    });

    /**
     * Colour alone fails a colour-blind operator, so each state must also carry
     * a distinct label — and the three must be distinct FROM EACH OTHER, which
     * asserting each one merely "not empty" would not catch.
     */
    it('gives each state its own colour and its own label', () => {
        const dots = (['critical', 'degraded', 'healthy'] as const).map(verdictToDot);
        expect(new Set(dots.map((d) => d.colorClass)).size).toBe(3);
        expect(new Set(dots.map((d) => d.label)).size).toBe(3);
        expect(verdictToDot('critical').colorClass).toBe('bg-red-500');
        expect(verdictToDot('degraded').colorClass).toBe('bg-amber-400');
    });

    /** `sectionDot` must read the section it was ASKED about, not the first one. */
    it('resolves a section against its own entry in sectionStatus', () => {
        setPayload([], { library: 'critical', tasks: 'degraded' });

        expect(sectionDot('library').colorClass).toBe('bg-red-500');
        expect(sectionDot('tasks').colorClass).toBe('bg-amber-400');
        expect(sectionDot('system').show).toBe(false);
    });
});

describe('pageAttentionDots', () => {
    const tasks = {
        id: 'tasks',
        pages: [{ path: '/admin/tasks' }, { path: '/admin/tasks/runs' }],
    } as unknown as AdminNavSection;

    it('resolves a deep sourceRef to the longest-matching page, worst severity wins', async () => {
        const { pageAttentionDots } = await import('./nav-status.js');
        setPayload([
            attentionItem({ id: 'tasks:a', sourceRef: '/admin/tasks/media-probe?tab=failures' }),
            attentionItem({
                id: 'tasks:b',
                severity: 'critical',
                sourceRef: '/admin/tasks/media-probe#x',
            }),
        ]);
        const dots = pageAttentionDots(tasks);
        expect(Object.keys(dots)).toEqual(['/admin/tasks']);
        expect(dots['/admin/tasks'].colorClass).toBe('bg-red-500');
    });

    it('normalises absolute and trailing-slash refs', async () => {
        const { pageAttentionDots } = await import('./nav-status.js');
        setPayload([
            attentionItem({ id: 'tasks:a', sourceRef: 'https://example.org/admin/tasks/runs/' }),
        ]);
        expect(Object.keys(pageAttentionDots(tasks))).toEqual(['/admin/tasks/runs']);
    });

    it('ignores items of another section, info, acked, snoozed and ref-less ones', async () => {
        const { pageAttentionDots } = await import('./nav-status.js');
        setPayload([
            attentionItem({ id: 'unmatched:a', sourceRef: '/admin/tasks/runs' }),
            attentionItem({ id: 'tasks:b', severity: 'info', sourceRef: '/admin/tasks/runs' }),
            attentionItem({ id: 'tasks:c', acked: true, sourceRef: '/admin/tasks/runs' }),
            attentionItem({ id: 'tasks:d', snoozed: true, sourceRef: '/admin/tasks/runs' }),
            attentionItem({ id: 'tasks:e' }),
        ]);
        expect(pageAttentionDots(tasks)).toEqual({});
    });
});
