// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Section titles are HTML ("Because you watched <span class=…>{title}</span>")
 * and the client keeps `span` + `class` when it renders them, so a library
 * title or keyword must reach the message as TEXT: otherwise it can close the
 * span and open its own with arbitrary Tailwind classes (a full-screen overlay).
 */
import { describe, it, expect } from 'vitest';
import { buildBecauseYouWatchedSections, buildYouLikeSections } from './section-builder.js';
import type { BecauseYouWatchedRow, KeywordRow } from './section-builder.js';

const HOSTILE = 'X</span><span class="fixed inset-0 z-[9999] bg-surface-900">pwned</span><span>';

describe('section titles built from i18n HTML messages', () => {
    it('escapes the source title of a "Because you watched" row', () => {
        const rows = [
            {
                sourceMovie: {
                    externalIds: { tmdb: '1' },
                    title: HOSTILE,
                    mediaType: 'movie',
                },
                similar: [],
            },
        ] as unknown as BecauseYouWatchedRow[];
        const [section] = buildBecauseYouWatchedSections(rows);
        expect(section.title).not.toContain('class="fixed');
        expect(section.title).not.toContain('</span><span');
        expect(section.title).toContain('&lt;/span&gt;');
    });

    it('escapes the keyword of a "You like" row', () => {
        const rows = [{ keyword: HOSTILE, count: 1, movies: [] }] as KeywordRow[];
        const [section] = buildYouLikeSections(rows);
        expect(section.title).not.toContain('class="fixed');
        expect(section.title).toContain('&lt;/span&gt;');
    });

    it('keeps ordinary titles readable', () => {
        const rows = [{ keyword: 'time travel', count: 1, movies: [] }] as KeywordRow[];
        expect(buildYouLikeSections(rows)[0].title).toContain('>time travel</span>');
    });
});
