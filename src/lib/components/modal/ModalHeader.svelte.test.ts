// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen } from '@testing-library/svelte';
import { describe, expect, test } from 'vitest';
import ModalHeader from './ModalHeader.svelte';

describe('detail heading', () => {
    test('groups movie facts before the synopsis', () => {
        const { container } = render(ModalHeader, {
            title: 'Awakening',
            mediaType: 'movie',
            year: '2016',
            duration: 6960,
            certification: 'PG-13',
            genres: ['Science Fiction', 'Drama'],
            overview: 'A long movie synopsis. '.repeat(30),
        });
        expect(screen.getByText('2016')).toBeTruthy();
        expect(screen.getByText('PG-13')).toBeTruthy();
        expect(screen.getByText('Science Fiction')).toBeTruthy();
        expect(container.querySelector('.detail-facts')?.textContent).toContain('1h');
        expect(container.querySelector('.description')?.textContent).toContain(
            'A long movie synopsis.',
        );
    });
    test('shows real context and a tagline without changing the title', () => {
        render(ModalHeader, {
            title: 'Awakening',
            tagline: 'Why are they here?',
            libraryNames: ['Cinema'],
        });
        expect(screen.getByRole('heading', { name: 'Awakening' })).toBeTruthy();
        expect(screen.getByText('Why are they here?')).toBeTruthy();
        expect(screen.getByText('Cinema')).toBeTruthy();
    });
    test('omits empty context', () => {
        const { container } = render(ModalHeader, {
            title: 'Awakening',
            tagline: '  ',
            libraryNames: [],
        });
        expect(container.querySelector('.detail-tagline')).toBeNull();
        expect(container.querySelector('.library-context')).toBeNull();
    });
    test('renders both combined episode descriptions', () => {
        render(ModalHeader, {
            title: 'First / Second',
            episode: 1,
            episodeNumberEnd: 2,
            episodeTitle: 'First / Second',
            overview: `${'First episode description. '.repeat(12)} / ${'Second episode description. '.repeat(12)}`,
        });
        expect(screen.getByText('First')).toBeTruthy();
        expect(screen.getByText('Second')).toBeTruthy();
    });
    test('keeps audiobook identity and synopsis visible', () => {
        render(ModalHeader, {
            title: 'A long book title',
            audiobook: true,
            creator: 'An author',
            overview: 'A long synopsis',
        });
        expect(screen.getByText('An author')).toBeTruthy();
        expect(screen.getByText('A long synopsis')).toBeTruthy();
    });
});

describe('series episode summary', () => {
    test('renders totals separately from playable and watched counts, then updates to zero unwatched', async () => {
        const { container, rerender } = render(ModalHeader, {
            title: 'A series',
            mediaType: 'series',
            seriesCounts: {
                seasonCount: 3,
                episodeCount: 60,
                availableEpisodeCount: 24,
                watchedEpisodeCount: 12,
                unwatchedEpisodeCount: 12,
            },
        });
        expect(container.querySelector('[data-series-counts]')?.textContent).toBe(
            '3 seasons · 60 episodes',
        );
        expect(container.querySelector('[data-series-progress]')?.textContent).toBe(
            '24 available episodes · 12 watched episodes · 12 unwatched episodes',
        );
        await rerender({
            title: 'A series',
            mediaType: 'series',
            seriesCounts: {
                seasonCount: 3,
                episodeCount: 60,
                availableEpisodeCount: 24,
                watchedEpisodeCount: 24,
                unwatchedEpisodeCount: 0,
            },
        });
        expect(container.querySelector('[data-series-progress]')?.textContent).toContain(
            '0 unwatched episodes',
        );
    });
    test('omits all series count rows for movies and unknown series counts', () => {
        const movie = render(ModalHeader, {
            title: 'A movie',
            mediaType: 'movie',
            seriesCounts: { episodeCount: 60, availableEpisodeCount: 24 },
        });
        expect(movie.container.querySelector('[data-series-counts]')).toBeNull();
        expect(movie.container.querySelector('[data-series-progress]')).toBeNull();
        const unknown = render(ModalHeader, { title: 'A series', mediaType: 'series' });
        expect(unknown.container.querySelector('[data-series-counts]')).toBeNull();
        expect(unknown.container.querySelector('[data-series-progress]')).toBeNull();
    });
});

describe('matched search title', () => {
    test('keeps the primary heading and shows the matching stored title before enrichment', () => {
        render(ModalHeader, { title: 'The Worst Witch', matchedTitle: 'Eine lausige Hexe' });
        expect(screen.getByRole('heading', { name: 'The Worst Witch' })).toBeTruthy();
        expect(screen.getByText('Eine lausige Hexe')).toBeTruthy();
    });
    test('does not duplicate the primary title after metadata language overlay', () => {
        const { container } = render(ModalHeader, {
            title: 'Eine lausige Hexe',
            matchedTitle: ' EINE LAUSIGE HÉXE! ',
        });
        expect(container.textContent).not.toContain('EINE LAUSIGE HÉXE!');
    });
});
