// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The server collapses one series' episodes that arrived together into one item
 * (`episodeCount` + `seasons`); the row turns that into a range title, an
 * episode-count badge and a link to the series. Single items keep the old form.
 */

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import type { RecentlyAddedItem } from '$lib/schemas/api-attention-responses';

const RecentlyAddedRow = (await import('./RecentlyAddedRow.svelte')).default;

afterEach(cleanup);

const episode: RecentlyAddedItem = {
    id: 'ep-24',
    title: 'Finale',
    type: 'episode',
    addedAt: new Date().toISOString(),
    seriesId: 'series-1',
    seriesTitle: 'Show',
    seasonNumber: 5,
    episodeNumber: 24,
};

function renderRow(item: RecentlyAddedItem): HTMLAnchorElement {
    render(RecentlyAddedRow, { props: { item } });
    return screen.getByRole('link') as HTMLAnchorElement;
}

describe('RecentlyAddedRow', () => {
    it('renders a single episode as before and links to it', () => {
        const link = renderRow(episode);
        expect(link.textContent).toContain('Show · S05E24 · Finale');
        expect(link.textContent).toContain('episode');
        expect(link.getAttribute('href')).toMatch(/\/admin\/library\/media\/ep-24$/);
    });

    it('renders a one-season group as an episode range with a count, linking to the series', () => {
        const link = renderRow({
            ...episode,
            episodeCount: 11,
            seasons: [{ season: 5, episodes: [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26] }],
        });
        expect(link.textContent).toContain(`Show · ${m.season({ number: 5 })} · E15–E24, E26`);
        expect(link.textContent).toContain(m.series_episodes_count({ count: 11 }));
        expect(link.getAttribute('href')).toMatch(/\/admin\/library\/media\/series-1$/);
    });

    it('renders a multi-season group as a season list', () => {
        const link = renderRow({
            ...episode,
            episodeCount: 48,
            seasons: [
                { season: 4, episodes: [1, 2] },
                { season: 5, episodes: [1, 2] },
            ],
        });
        expect(link.textContent).toContain(`Show · ${m.admin_ops_recent_seasons({ list: '4–5' })}`);
    });

    it('renders a movie with its year', () => {
        const link = renderRow({
            id: 'mv',
            title: 'A Film',
            type: 'movie',
            year: 1999,
            addedAt: new Date().toISOString(),
        });
        expect(link.textContent).toContain('A Film (1999)');
    });
});
