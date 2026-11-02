// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * `AttentionList` is the THIRD consumer of `sectionForItem`, and the only one
 * whose filter has two modes.
 *
 * It was covered only INDIRECTLY: `SectionAttentionStrip` mounts it, so mutating
 * `sectionForItem` fails six of the strip's eight tests. But the strip always
 * passes a `section`, so it exercises exactly one half of
 *
 *     (i) => section === undefined || sectionForItem(i) === section
 *
 * The other half — the pass-through, which is what Home (`/admin`) and the
 * Health findings list mount, both with no `section` at all — had no test
 * anywhere. Deleting the `section === undefined` arm leaves those two pages
 * rendering an empty attention list while every strip test, the map's own guard,
 * `nav-status`, and the whole server suite stay green: an inline `$derived` in a
 * `.svelte` file is invisible to `npm run typecheck` (tsgo skips `.svelte`).
 *
 * Asserted as AGREEMENT with `sectionForItem` over the shared representative-id
 * table, not as a restated list of expected sections — the map's completeness
 * guard (`admin-status-payload.service.test.ts`) then reaches this file too.
 */

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import type { AdminStatusPayload } from '$lib/schemas/api-admin-status-payload.js';
import type { AttentionItem } from '$lib/schemas/api-attention-responses.js';
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
    start: () => {},
    stop: () => {},
    refresh: async () => {},
    ack: async () => {},
}));

vi.mock('$lib/stores/admin-status.store.svelte.js', () => ({ adminStatus: store }));

const AttentionList = (await import('./AttentionList.svelte')).default;

function setItems(items: AttentionItem[], unavailable = false): void {
    store.payload = {
        verdict: 'degraded',
        attention: { items, unavailable },
        sectionStatus: {},
    } as unknown as AdminStatusPayload;
}

/** The fixture builder's title for an id — unique per id, so absence is provable. */
const titleOf = (id: string) => `title for ${id}`;

beforeEach(() => {
    store.payload = null;
});
afterEach(cleanup);

describe('AttentionList', () => {
    /**
     * The filtered half. For every section the full table is loaded, and each id
     * must be visible if and only if the map assigns it to that section.
     *
     * Revert-check (CROSS-WIRE): change the filter to
     * `sectionForItem(i) !== section`, or to `i.domain === section`, and every
     * case fails — both on a missing title and on a present one that should not
     * be there. Deleting the `sectionForItem(i) === section` arm outright fails
     * it the same way, which is why the pass-through case below is a separate
     * test rather than an extra assertion here.
     */
    it.each(SECTIONS_WITH_IDS)('renders exactly the %s items the map assigns', (section) => {
        setItems(ALL_SECTION_IDS.map((id) => attentionItem({ id })));
        render(AttentionList, { section });

        for (const id of ALL_SECTION_IDS) {
            const belongs = sectionForItem({ id }) === section;
            expect(screen.queryAllByText(titleOf(id)).length > 0, `${id} in ${section}`).toBe(
                belongs,
            );
        }
    });

    /**
     * The pass-through half, which nothing else in the repo touches. With no
     * `section` prop the list is the WHOLE board — that is the contract Home and
     * the Health findings list are built on.
     *
     * The table spans four sections, so this is discriminating in both
     * directions: a filter that lost its `section === undefined` arm renders
     * nothing at all (every assertion fails), and one that silently defaulted
     * `section` to a real id renders only that section's slice (the other three
     * sections' assertions fail).
     *
     * Revert-check (CROSS-WIRE): drop `section === undefined ||` from the filter
     * and this fails on the first id, with the empty-state assertion failing too;
     * the `it.each` above still passes.
     */
    it('renders every item, from every section, when no section is given', () => {
        setItems(ALL_SECTION_IDS.map((id) => attentionItem({ id })));
        render(AttentionList);

        // The table has to span more than one section, or "renders everything"
        // and "renders one section" would be the same assertion.
        expect(SECTIONS_WITH_IDS.length).toBeGreaterThan(1);
        for (const id of ALL_SECTION_IDS) {
            expect(screen.queryAllByText(titleOf(id)).length, id).toBeGreaterThan(0);
        }
        expect(screen.queryByText(m.admin_ops_attention_empty())).toBeNull();
    });

    /**
     * The pass-through must be the ABSENCE of a section, not a wildcard that any
     * unmatched value falls into. A section with nothing in it renders the empty
     * state, so "filtered to nothing" and "filtered to everything" are separate
     * observable outcomes rather than two readings of a blank list.
     */
    it('renders the empty state for a section the map assigns nothing to', () => {
        setItems(ALL_SECTION_IDS.map((id) => attentionItem({ id })));
        render(AttentionList, { section: 'developer' });

        expect(sectionForItem({ id: ALL_SECTION_IDS[0] })).not.toBe('developer');
        expect(screen.getByText(m.admin_ops_attention_empty())).toBeTruthy();
        for (const id of ALL_SECTION_IDS) {
            expect(screen.queryByText(titleOf(id)), id).toBeNull();
        }
    });

    /**
     * `max` caps the ROWS but the "show all N →" link counts the items the filter
     * left — so the cap has to be applied after the section filter, not before.
     * Fed the whole table with `section: 'library'`, a list that capped the
     * unfiltered array would show non-library rows and a count of every item on
     * the board.
     */
    it('caps rows after filtering, and counts the filtered items in "show all"', () => {
        setItems(ALL_SECTION_IDS.map((id) => attentionItem({ id })));
        const librarySection = IDS_BY_SECTION.library;
        expect(librarySection.length).toBeGreaterThan(2);
        expect(librarySection.length).toBeLessThan(ALL_SECTION_IDS.length);

        render(AttentionList, { section: 'library', max: 2, showAllHref: '/admin/system/health' });

        const rendered = librarySection.filter(
            (id) => screen.queryAllByText(titleOf(id)).length > 0,
        );
        expect(rendered).toHaveLength(2);
        expect(
            screen.getByText(m.admin_home_attention_show_all({ count: librarySection.length })),
        ).toBeTruthy();
        expect(
            screen.queryByText(m.admin_home_attention_show_all({ count: ALL_SECTION_IDS.length })),
        ).toBeNull();
    });

    /**
     * Acked and snoozed items are quiet by default in BOTH modes, so the list can
     * never contradict the verdict banner it renders above itself. The
     * pass-through mode is where this matters most — Home mounts it unsectioned,
     * and an acked item reappearing there is the operator's ack going visibly
     * unhonoured.
     */
    it('hides acked and snoozed items in the pass-through mode', () => {
        const [open, acked, snoozed] = IDS_BY_SECTION.library;
        setItems([
            attentionItem({ id: open }),
            attentionItem({ id: acked, acked: true }),
            attentionItem({ id: snoozed, snoozed: true }),
        ]);
        render(AttentionList);

        expect(screen.getByText(titleOf(open))).toBeTruthy();
        expect(screen.queryByText(titleOf(acked))).toBeNull();
        expect(screen.queryByText(titleOf(snoozed))).toBeNull();
    });
});

it('keeps unconfigured optional providers visible as Info on Health', () => {
    setItems([
        attentionItem({ id: 'provider:lastfm', severity: 'info', title: 'Optional Last.fm' }),
    ]);
    render(AttentionList);
    expect(screen.getByText('Optional Last.fm')).toBeTruthy();
    expect(screen.getByText('Info:')).toBeTruthy();
});
