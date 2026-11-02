// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { PageSection } from '$lib/types/server-driven-ui';
import { withTrendingCta, TRENDING_WIDGET_HREF } from './trending-availability';
import * as m from '$lib/paraglide/messages';

function cwEmpty(): PageSection {
    return {
        id: 'continue-watching',
        type: 'continue-watching',
        title: 'Continue',
        items: [],
        meta: {
            emptyState: { message: 'caught up', linkHref: '/browse', linkLabel: m.nav_browse() },
        },
    } as PageSection;
}

describe('withTrendingCta', () => {
    it('keeps the "Browse" CTA while trending availability is unknown', () => {
        const sections = [cwEmpty()];
        expect(withTrendingCta(sections, null)).toBe(sections);
    });

    it('keeps the "Browse" CTA when trending has nothing to show', () => {
        const sections = [cwEmpty()];
        const out = withTrendingCta(sections, false);
        expect(out[0]!.meta?.emptyState?.linkHref).toBe('/browse');
        expect(out[0]!.meta?.emptyState?.linkLabel).toBe(m.nav_browse());
    });

    it('upgrades to "Browse trending" once trending has items', () => {
        const out = withTrendingCta([cwEmpty()], true);
        expect(out[0]!.meta?.emptyState).toMatchObject({
            message: 'caught up',
            linkHref: TRENDING_WIDGET_HREF,
            linkLabel: m.section_browse_trending(),
        });
    });

    it('leaves other sections and populated CW rows alone', () => {
        const other = { id: 'x', type: 'carousel', title: 't', items: [] } as PageSection;
        const populated = {
            id: 'continue-watching',
            type: 'continue-watching',
            title: 'c',
            items: [],
        } as PageSection;
        const out = withTrendingCta([other, populated], true);
        expect(out[0]).toBe(other);
        expect(out[1]).toBe(populated);
    });
});
