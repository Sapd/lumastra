// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether the home Trending row has anything to show.
 *
 * The Continue-Watching empty card ("You're all caught up") offers a CTA. It
 * should only point at trending when the Trending row exists: a small library
 * often holds none of the global trending titles, the row then hides itself,
 * and a "Browse trending" button would lead nowhere. `null` = not known yet
 * (row not mounted / still loading) — treated as "no", so the safe "Browse"
 * CTA is shown until trending proves it has content.
 */

import { writable } from 'svelte/store';
import type { PageSection } from '$lib/types/server-driven-ui';
import * as m from '$lib/paraglide/messages';

export const trendingAvailable = writable<boolean | null>(null);

/** Anchor of the home Trending widget (`id="widget-trending"` on the widget wrapper). */
export const TRENDING_WIDGET_HREF = '/#widget-trending';

/**
 * Swap the CW empty-state CTA to "Browse trending" once trending is known to
 * have items. Any other section, or a CW section with cards, is returned as is.
 */
export function withTrendingCta(
    sections: PageSection[],
    hasTrending: boolean | null,
): PageSection[] {
    if (hasTrending !== true) return sections;
    return sections.map((section) => {
        const emptyState = section.meta?.emptyState;
        if (section.id !== 'continue-watching' || !emptyState?.linkHref) return section;
        return {
            ...section,
            meta: {
                ...section.meta,
                emptyState: {
                    ...emptyState,
                    linkHref: TRENDING_WIDGET_HREF,
                    linkLabel: m.section_browse_trending(),
                },
            },
        };
    });
}
