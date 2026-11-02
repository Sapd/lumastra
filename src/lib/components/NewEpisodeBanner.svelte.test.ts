// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * "New episodes available" card copy: the watched count is plural-aware
 * ("1 episode watched", not "1 episodes watched") and "+N more" counts only
 * the OTHER new episodes of the series.
 */

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'vitest';
import NewEpisodeBanner from './NewEpisodeBanner.svelte';
import type { NewEpisodeAlert } from '$lib/schemas/api-for-you-responses';

const SERIES_ID = '11111111-1111-4111-8111-111111111111';
const EPISODE_ID = '22222222-2222-4222-8222-222222222222';

function alert(count: number, watchedEpisodeCount: number): NewEpisodeAlert {
    return {
        id: EPISODE_ID,
        catalogId: EPISODE_ID,
        type: 'episode',
        ids: {},
        title: 'The Lighthouse Keeper',
        images: {},
        availability: { isAvailable: true, hasFile: true, canRequest: false },
        context: {
            series: { id: SERIES_ID, catalogId: SERIES_ID, title: 'Harbour Lights' },
            seasonNumber: 3,
            episodeNumber: 4,
            airDate: new Date().toISOString(),
        },
        reason: { kind: 'new_release', label: 'S3E4' },
        newEpisodes: { count, watchedEpisodeCount, followReason: 'watched' },
    };
}

afterEach(() => cleanup());

describe('NewEpisodeBanner copy', () => {
    test('one watched episode reads "1 episode watched"', () => {
        const { container } = render(NewEpisodeBanner, { props: { alerts: [alert(1, 1)] } });
        expect(container.textContent).toContain('1 episode watched');
        expect(container.textContent).not.toContain('1 episodes watched');
    });

    test('several watched episodes use the plural', () => {
        const { container } = render(NewEpisodeBanner, { props: { alerts: [alert(1, 3)] } });
        expect(container.textContent).toContain('3 episodes watched');
    });

    test('"+N more" counts the other new episodes and is absent for a single one', () => {
        const single = render(NewEpisodeBanner, { props: { alerts: [alert(1, 3)] } });
        expect(single.container.textContent).not.toMatch(/\+\d+ more/);
        cleanup();
        const many = render(NewEpisodeBanner, { props: { alerts: [alert(3, 3)] } });
        expect(many.container.textContent).toContain('+2 more');
    });

    test('every card carries the NEW badge, never REQUESTED', () => {
        const { container } = render(NewEpisodeBanner, { props: { alerts: [alert(2, 5)] } });
        expect(container.textContent).toContain('NEW');
        expect(container.textContent).not.toContain('REQUESTED');
    });
});
