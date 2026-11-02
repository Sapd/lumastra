// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * `SectionAttentionStrip` is the other CONSUMER of `sectionForItem`, and the one
 * whose failure the operator sees first: the strip is what makes a nav dot
 * explain itself on arrival, so an item it filters out is INVISIBLE on the page
 * it belongs to while the dot that sent the operator there stays lit.
 *
 * That is exactly what shipped twice — `scan-run:` and then `music-hygiene:`
 * items carried `domain: 'library'`, linked into `/admin/library/media`, and
 * rendered on System instead. The map has a structural guard now; this consumer
 * had no test at all, and a `.svelte` file's inline `$derived` filter is
 * invisible to `npm run typecheck` (tsgo skips `.svelte`) and to every server
 * test, so nothing else can see it.
 *
 * Asserted as AGREEMENT with `sectionForItem` over the shared representative-id
 * table, not as a restated list of expected sections — the map's completeness
 * guard (`admin-status-payload.service.test.ts`) then reaches this file too.
 */

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import type { AdminStatusPayload, AdminSectionId } from '$lib/schemas/api-admin-status-payload.js';
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

const SectionAttentionStrip = (await import('./SectionAttentionStrip.svelte')).default;

function setItems(items: AttentionItem[]): void {
    store.payload = {
        verdict: 'degraded',
        attention: { items, unavailable: false },
        sectionStatus: {},
    } as unknown as AdminStatusPayload;
}

/** The fixture builder's title for an id — unique per id, so absence is provable. */
const titleOf = (id: string) => `title for ${id}`;

/**
 * Mount the strip and open it. The list lives in a dropdown behind the pill,
 * so the rows only exist after the click — a test that skipped this would read
 * "no rows rendered" as "filtered out".
 */
async function renderStrip(section: AdminSectionId): Promise<void> {
    render(SectionAttentionStrip, { section });
    const pill = screen.queryByRole('button', { expanded: false });
    if (pill) await fireEvent.click(pill);
}

beforeEach(() => {
    store.payload = null;
});
afterEach(cleanup);

describe('SectionAttentionStrip', () => {
    /**
     * The agreement property. For every section, the full table is loaded and
     * each id must be visible if and only if the map assigns it to that section.
     *
     * Revert-check (CROSS-WIRE): change the component's filter to
     * `sectionForItem(i) !== section`, or to `i.domain === section`, and every
     * case fails — both on a missing title and on a present one that should not
     * be there.
     */
    it.each(SECTIONS_WITH_IDS)('renders exactly the %s items the map assigns', async (section) => {
        setItems(ALL_SECTION_IDS.map((id) => attentionItem({ id })));
        await renderStrip(section);

        for (const id of ALL_SECTION_IDS) {
            const belongs = sectionForItem({ id }) === section;
            expect(screen.queryAllByText(titleOf(id)).length > 0, `${id} in ${section}`).toBe(
                belongs,
            );
        }
    });

    /**
     * The specific regression, named. A `music-hygiene:` item must reach the
     * Library landing page and must NOT reach System — the two halves of the bug
     * that shipped, in one assertion each.
     */
    it('puts a music-hygiene item on Library and keeps it off System', async () => {
        const id = 'music-hygiene:music-title-from-filename';
        expect(sectionForItem({ id })).toBe('library');

        setItems([attentionItem({ id })]);
        await renderStrip('library');
        expect(screen.getByText(titleOf(id))).toBeTruthy();

        cleanup();
        setItems([attentionItem({ id })]);
        await renderStrip('system');
        expect(screen.queryByText(titleOf(id))).toBeNull();
    });

    /**
     * The whole strip is conditional on `openCount > 0`, so a section with
     * nothing to say must render NOTHING — not an empty bordered box above the
     * page's own content.
     */
    it('renders nothing at all when no item maps to this section', () => {
        setItems(ALL_SECTION_IDS.map((id) => attentionItem({ id })));
        const { container } = render(SectionAttentionStrip, { section: 'developer' });

        expect(sectionForItem({ id: ALL_SECTION_IDS[0] })).not.toBe('developer');
        expect(container.textContent?.trim()).toBe('');
    });

    /**
     * Acked and snoozed items are quiet: they must neither render nor count.
     * The pill's count and the opened list are both asserted, so a consumer
     * that dropped the filter fails on either.
     */
    it('excludes acked and snoozed items from the strip and from its count', async () => {
        const [openA, openB, third] = IDS_BY_SECTION.library;
        setItems([
            attentionItem({ id: openA }),
            attentionItem({ id: openB }),
            attentionItem({ id: third, acked: true }),
            attentionItem({ id: 'library:snoozed-probe', snoozed: true }),
        ]);
        await renderStrip('library');

        expect(screen.getByText(m.admin_attention_section_summary({ count: 2 }))).toBeTruthy();
        expect(screen.getByText(titleOf(openA))).toBeTruthy();
        expect(screen.getByText(titleOf(openB))).toBeTruthy();
        expect(screen.queryByText(titleOf(third))).toBeNull();
    });

    /**
     * The list is an overlay, opened on demand: nothing but the pill may render
     * until the operator asks. Revert-check: render AttentionList
     * unconditionally (the old in-flow strip) and this fails.
     */
    it('keeps the list closed until the pill is clicked, and Escape closes it', async () => {
        const [openA] = IDS_BY_SECTION.library;
        setItems([attentionItem({ id: openA })]);
        render(SectionAttentionStrip, { section: 'library' });

        expect(screen.queryByText(titleOf(openA))).toBeNull();
        const pill = screen.getByRole('button', { expanded: false });
        await fireEvent.click(pill);
        expect(screen.getByText(titleOf(openA))).toBeTruthy();

        await fireEvent.keyDown(pill, { key: 'Escape' });
        expect(screen.queryByText(titleOf(openA))).toBeNull();
    });

    /**
     * The pill's summary is the count the operator reads before opening, so
     * it has to be the section's own open count — not the payload's total. The
     * two differ here by every non-library item in the table, which is what makes
     * this fail if the summary is fed the unfiltered list.
     */
    it('summarises with the section count, not the payload total', () => {
        setItems(ALL_SECTION_IDS.map((id) => attentionItem({ id })));
        render(SectionAttentionStrip, { section: 'library' });

        const expected = IDS_BY_SECTION.library.length;
        expect(expected).toBeGreaterThan(2);
        expect(expected).toBeLessThan(ALL_SECTION_IDS.length);
        expect(
            screen.getByText(m.admin_attention_section_summary({ count: expected })),
        ).toBeTruthy();
        expect(
            screen.queryByText(
                m.admin_attention_section_summary({ count: ALL_SECTION_IDS.length }),
            ),
        ).toBeNull();
    });
});
