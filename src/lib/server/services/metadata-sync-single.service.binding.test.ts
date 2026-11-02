// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { resolveEpisodeTitleBindings } from './metadata-sync-single.service.js';

describe('resolveEpisodeTitleBindings', () => {
    const catalogById = new Map([
        ['79000', { name: 'Wo sind Spinellis Eltern?', overview: 'O25' }],
        ['78888', { name: 'Das Experiment', overview: 'O3' }],
    ]);
    it('overrides by identity ONLY when title_binding is identity', () => {
        const out = resolveEpisodeTitleBindings(
            {
                seasonNumber: 1,
                episodeNumber: 3,
                title: 'Das Experiment',
                overview: 'O3',
            },
            new Map([['1:3', { externalTmdbId: '79000', titleBinding: 'identity' }]]),
            catalogById,
        );
        expect(out.title).toBe('Wo sind Spinellis Eltern?');
        expect(out.overview).toBe('O25');
    });
    it('does NOT override when row has a tmdb id but binding is position', () => {
        const out = resolveEpisodeTitleBindings(
            {
                seasonNumber: 1,
                episodeNumber: 3,
                title: 'Das Experiment',
                overview: 'O3',
            },
            new Map([['1:3', { externalTmdbId: '79000', titleBinding: 'position' }]]),
            catalogById,
        );
        expect(out.title).toBe('Das Experiment');
    });
    it('keeps position title when no binding exists', () => {
        const out = resolveEpisodeTitleBindings(
            {
                seasonNumber: 1,
                episodeNumber: 3,
                title: 'Das Experiment',
                overview: 'O3',
            },
            new Map(),
            new Map(),
        );
        expect(out.title).toBe('Das Experiment');
    });
});
