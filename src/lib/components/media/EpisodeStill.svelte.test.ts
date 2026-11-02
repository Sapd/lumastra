// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import EpisodeStill from './EpisodeStill.svelte';

afterEach(cleanup);

describe('EpisodeStill descriptor URLs', () => {
    it('renders the inherited owner URL and revision at the requested size', async () => {
        const href = '/api/media/series-owner/images/backdrop?size=hd&v=revision';
        const card = '/api/media/series-owner/images/backdrop?size=card&v=revision';
        render(EpisodeStill, {
            episode: {
                id: 'episode-id',
                name: 'Pilot',
                hasOwnStill: false,
                images: { thumb: { href, variants: { card }, revision: 'revision', source: 'series' } },
            },
            resolvedSeriesId: 'different-series',
            size: 'card',
        });
        const image = screen.getByAltText('Pilot');
        expect(image.getAttribute('src')).toBe(card);
        await fireEvent.error(image);
        expect(image.getAttribute('src')).toBe(card);
        expect(image.style.display).toBe('none');
    });

    it('renders a placeholder without a request when thumb is absent', () => {
        const { container } = render(EpisodeStill, {
            episode: { id: 'episode-id', name: 'Pilot', images: {} },
            resolvedSeriesId: 'series-owner',
        });
        expect(container.querySelector('img')).toBeNull();
    });
});
