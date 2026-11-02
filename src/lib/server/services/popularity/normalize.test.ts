// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { normalizeTitle, normalizeTrackScores, normalizeArtistScore } from './normalize.js';

describe('normalizeTitle', () => {
    describe('spec examples', () => {
        it('strips nightcore edit suffix', () => {
            expect(normalizeTitle('All the Things She Said - Nightcore Edit')).toBe(
                'all the things she said',
            );
        });

        it('strips parenthetical radio edit', () => {
            expect(normalizeTitle('Poison (DJ Fenwick Meets Money G Radio Edit)')).toBe('poison');
        });

        it('strips feat. parenthetical', () => {
            expect(normalizeTitle('Song Title (feat. Artist Name)')).toBe('song title');
        });

        it('strips diacritics', () => {
            expect(normalizeTitle('Café Olé')).toBe('cafe ole');
        });

        it('collapses whitespace and strips punctuation', () => {
            expect(normalizeTitle('   Hello,   World!  ')).toBe('hello world');
        });
    });

    describe('rule 1 — trim', () => {
        it('trims leading and trailing whitespace', () => {
            expect(normalizeTitle('  song  ')).toBe('song');
        });
    });

    describe('rule 2 — lowercase', () => {
        it('lowercases ASCII', () => {
            expect(normalizeTitle('HELLO WORLD')).toBe('hello world');
        });

        it('lowercases mixed case', () => {
            expect(normalizeTitle('MiXeD CaSe')).toBe('mixed case');
        });
    });

    describe('rule 3 — diacritics', () => {
        it('strips acute accents', () => {
            expect(normalizeTitle('résumé')).toBe('resume');
        });

        it('strips umlaut', () => {
            expect(normalizeTitle('über')).toBe('uber');
        });
    });

    describe('rule 4 — parenthetical version markers', () => {
        it('removes (remix)', () => {
            expect(normalizeTitle('Track (Remix)')).toBe('track');
        });

        it('removes [extended mix]', () => {
            expect(normalizeTitle('Track [Extended Mix]')).toBe('track');
        });

        it('removes (Radio Edit)', () => {
            expect(normalizeTitle('Track (Radio Edit)')).toBe('track');
        });

        it('removes (featuring Artist)', () => {
            expect(normalizeTitle('Track (featuring Artist)')).toBe('track');
        });

        it('removes (ft. Artist)', () => {
            expect(normalizeTitle('Track (ft. Artist)')).toBe('track');
        });

        it('removes (live)', () => {
            expect(normalizeTitle('Track (Live)')).toBe('track');
        });

        it('removes (acoustic version)', () => {
            expect(normalizeTitle('Track (Acoustic Version)')).toBe('track');
        });

        it('removes (remaster)', () => {
            expect(normalizeTitle('Track (2023 Remaster)')).toBe('track');
        });

        it('removes (nightcore)', () => {
            expect(normalizeTitle('Track (Nightcore)')).toBe('track');
        });

        it('keeps parentheticals without version keywords', () => {
            expect(normalizeTitle('Track (Original)')).toBe('track original');
        });
    });

    describe('rule 5 — hyphen suffix', () => {
        it('removes - xyz mix suffix', () => {
            expect(normalizeTitle('Track - Extended Mix')).toBe('track');
        });

        it('removes - xyz edit suffix', () => {
            expect(normalizeTitle('Track - Radio Edit')).toBe('track');
        });

        it('removes - xyz version suffix', () => {
            expect(normalizeTitle('Track - Club Version')).toBe('track');
        });

        it('removes multi-word remixer credit before keyword', () => {
            expect(normalizeTitle("Don't Look Back - G4bby feat. Bazz Boyz Edit")).toBe(
                'dont look back',
            );
        });

        it('removes multi-word producer credit before mix', () => {
            expect(normalizeTitle('Song - Some Producer Extended Mix')).toBe('song');
        });
    });

    describe('rule 6 — non-alphanumeric removal', () => {
        it('removes punctuation', () => {
            expect(normalizeTitle("it's a test!")).toBe('its a test');
        });

        it('removes apostrophes', () => {
            expect(normalizeTitle("don't stop")).toBe('dont stop');
        });
    });

    describe('rule 7 — whitespace collapse', () => {
        it('collapses multiple spaces', () => {
            expect(normalizeTitle('a  b   c')).toBe('a b c');
        });
    });

    describe('edge cases', () => {
        it('empty string returns empty string', () => {
            expect(normalizeTitle('')).toBe('');
        });

        it('only whitespace returns empty string', () => {
            expect(normalizeTitle('   ')).toBe('');
        });
    });

    describe('idempotency', () => {
        const inputs = [
            'All the Things She Said - Nightcore Edit',
            'Poison (DJ Fenwick Meets Money G Radio Edit)',
            'Café Olé',
            '   Hello,   World!  ',
            'Song Title (feat. Artist Name)',
            'Normal Song',
            '',
            'Track (Remix) [Extended]',
        ];

        for (const input of inputs) {
            it(`idempotent for: ${input || '(empty)'}`, () => {
                const once = normalizeTitle(input);
                expect(normalizeTitle(once)).toBe(once);
            });
        }
    });
});

describe('normalizeTrackScores', () => {
    it('top track gets 1.0', () => {
        const scores = normalizeTrackScores([
            { listeners: 1000, playcount: 5000 },
            { listeners: 500, playcount: 2500 },
        ]);
        expect(scores[0]).toBe(1.0);
    });

    it('second track gets fractional score', () => {
        const scores = normalizeTrackScores([
            { listeners: 1000, playcount: 5000 },
            { listeners: 500, playcount: 2500 },
        ]);
        expect(scores[1]).toBeCloseTo(0.5);
    });

    it('all zeros listeners returns all zeros', () => {
        const scores = normalizeTrackScores([
            { listeners: 0, playcount: 0 },
            { listeners: 0, playcount: 100 },
        ]);
        expect(scores).toEqual([0, 0]);
    });

    it('empty array returns empty array', () => {
        expect(normalizeTrackScores([])).toEqual([]);
    });

    it('single track gets 1.0 if non-zero listeners', () => {
        expect(normalizeTrackScores([{ listeners: 42, playcount: 0 }])).toEqual([1.0]);
    });
});

describe('normalizeArtistScore', () => {
    it('ceiling=0 returns 0', () => {
        expect(normalizeArtistScore(1000, 0)).toBe(0);
    });

    it('negative ceiling returns 0', () => {
        expect(normalizeArtistScore(1000, -5)).toBe(0);
    });

    it('listeners=0 returns 0', () => {
        expect(normalizeArtistScore(0, 1000)).toBe(0);
    });

    it('negative listeners returns 0', () => {
        expect(normalizeArtistScore(-1, 1000)).toBe(0);
    });

    it('listeners=ceiling returns 1.0', () => {
        expect(normalizeArtistScore(99, 99)).toBeCloseTo(1.0);
    });

    it('listeners > ceiling clamps to 1.0', () => {
        expect(normalizeArtistScore(200, 99)).toBe(1.0);
    });

    it('small listeners against large ceiling is < 1', () => {
        const score = normalizeArtistScore(100, 1_000_000);
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThan(1);
    });

    it('log formula: listeners=99, ceiling=99 → 1.0', () => {
        expect(normalizeArtistScore(99, 99)).toBeCloseTo(1.0, 10);
    });
});
