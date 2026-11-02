// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { matchEpisodeByTitle, normalizeEpisodeTitle } from './episode-title-match.js';

const ep = (id: string, ...titles: Array<string | null>) => ({ id, titles });

describe('normalizeEpisodeTitle', () => {
    it('folds umlauts to their filename spelling and drops punctuation', () => {
        expect(normalizeEpisodeTitle('Die Verfluchten der Mäuse')).toBe(
            'die verfluchten der maeuse',
        );
        expect(normalizeEpisodeTitle('He Came!')).toBe('he came');
        expect(normalizeEpisodeTitle('Projekt B.R.A.I.N.')).toBe('projekt b r a i n');
    });
});

describe('matchEpisodeByTitle', () => {
    it('matches an exact title (Specials named only by title)', () => {
        const candidates = [ep('a', 'The Ghost of Christmas'), ep('b', 'He Came!')];
        expect(matchEpisodeByTitle('The Ghost of Christmas', candidates)).toBe('a');
        expect(matchEpisodeByTitle('He Came', candidates)).toBe('b');
    });

    it('matches a title that ends the filename title (series name and number in front)', () => {
        const candidates = [
            ep('e3', 'Gollyzilla'),
            ep('e5', 'Die Verfluchten der Mäuse'),
            ep('e64', 'Das Ende einer Legende - Projekt B.R.A.I.N.'),
        ];
        expect(matchEpisodeByTitle('Pinky 05 Die Verfluchten der Maeuse', candidates)).toBe('e5');
        expect(matchEpisodeByTitle('Pinky 03 Gollyzilla', candidates)).toBe('e3');
        expect(
            matchEpisodeByTitle('Pinky 64 Das Ende einer Legende Projekt B R A I N', candidates),
        ).toBe('e64');
    });

    it('checks the English and original titles too', () => {
        expect(
            matchEpisodeByTitle('Cold Station 12', [ep('x', 'Kältestation 12', 'Cold Station 12')]),
        ).toBe('x');
    });

    it('prefers the longest matching title', () => {
        const candidates = [ep('short', 'Legende'), ep('long', 'Das Ende einer Legende')];
        expect(matchEpisodeByTitle('Pinky 64 Das Ende einer Legende', candidates)).toBe('long');
    });

    it('binds nothing when two episodes match equally well', () => {
        const candidates = [ep('a', 'Reunion'), ep('b', 'Reunion')];
        expect(matchEpisodeByTitle('Show Reunion', candidates)).toBeNull();
    });

    it('ignores placeholder and very short titles', () => {
        const candidates = [ep('p', 'Episode 4'), ep('q', 'Folge 12'), ep('r', 'Ende')];
        expect(matchEpisodeByTitle('Show Episode 4', candidates)).toBeNull();
        expect(matchEpisodeByTitle('Show Folge 12', candidates)).toBeNull();
        expect(matchEpisodeByTitle('Das Ende', [ep('s', 'End')])).toBeNull();
    });

    it('does not match a title that is only a word inside the filename title', () => {
        expect(matchEpisodeByTitle('Christmas Ghost Story', [ep('a', 'Ghost')])).toBeNull();
        expect(matchEpisodeByTitle('Ghostly', [ep('a', 'Ghost')])).toBeNull();
    });
});
