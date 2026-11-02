// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { computeSectionOrder } from './section-ranker';
import type { FeedbackRow } from '$lib/server/database/queries/user-section-feedback.queries';

const CANONICAL = ['trending', 'anime', 'binge-worthy', 'popular-shows'];

function row(overrides: Partial<FeedbackRow>): FeedbackRow {
    return {
        sectionType: 'trending',
        impressions: 0,
        plays: 0,
        abandonments: 0,
        dismissals: 0,
        lastEngagedAt: null,
        updatedAt: new Date(),
        ...overrides,
    };
}

describe('computeSectionOrder', () => {
    it('cold-start (empty feedback) keeps canonical order unchanged', () => {
        const result = computeSectionOrder(new Map(), CANONICAL);
        expect(result).toEqual(CANONICAL);
    });

    it('a section below MIN_IMPRESSIONS is treated as neutral (0) and keeps canonical order', () => {
        const feedback = new Map<string, FeedbackRow>([
            ['anime', row({ sectionType: 'anime', impressions: 4, plays: 4 })],
        ]);
        const result = computeSectionOrder(feedback, CANONICAL);
        expect(result).toEqual(CANONICAL);
    });

    it('a high-play section floats to the top', () => {
        const feedback = new Map<string, FeedbackRow>([
            ['binge-worthy', row({ sectionType: 'binge-worthy', impressions: 20, plays: 15 })],
        ]);
        const result = computeSectionOrder(feedback, CANONICAL);
        expect(result[0]).toBe('binge-worthy');
        // Everything else stays in canonical relative order behind it.
        expect(result.slice(1)).toEqual(['trending', 'anime', 'popular-shows']);
    });

    it('a high-dismiss section sinks to the bottom', () => {
        const feedback = new Map<string, FeedbackRow>([
            [
                'trending',
                row({ sectionType: 'trending', impressions: 20, plays: 1, dismissals: 15 }),
            ],
        ]);
        const result = computeSectionOrder(feedback, CANONICAL);
        expect(result[result.length - 1]).toBe('trending');
        expect(result.slice(0, -1)).toEqual(['anime', 'binge-worthy', 'popular-shows']);
    });

    it('a high-abandon section sinks (weighted half as harshly as dismissals)', () => {
        // Same impressions/plays/count applied as abandonments on one section and
        // as dismissals on another — this only passes if ABANDON_WEIGHT (0.5) is
        // strictly less than DISMISS_WEIGHT (1.0). The abandon section is deliberately
        // given the LATER canonical index ('popular-shows', index 3) than the dismiss
        // section ('anime', index 1): if the weights were equal (a tied score), the
        // stable tie-break by canonical index would rank 'anime' ahead of
        // 'popular-shows' anyway, so this assertion would fail rather than
        // coincidentally pass — it only succeeds because the abandon-weighted score
        // is genuinely less negative.
        const feedback = new Map<string, FeedbackRow>([
            ['anime', row({ sectionType: 'anime', impressions: 20, plays: 1, dismissals: 15 })],
            [
                'popular-shows',
                row({ sectionType: 'popular-shows', impressions: 20, plays: 1, abandonments: 15 }),
            ],
        ]);
        const result = computeSectionOrder(feedback, CANONICAL);
        // Both sink below the neutral (score 0) sections, but the abandon-weighted
        // section's less-negative score keeps it strictly ahead of the
        // dismiss-weighted one.
        expect(result[result.length - 1]).toBe('anime');
        expect(result.indexOf('popular-shows')).toBeLessThan(result.indexOf('anime'));
    });

    it('ties (including multiple neutral sections) keep canonical relative order', () => {
        const feedback = new Map<string, FeedbackRow>([
            ['trending', row({ sectionType: 'trending', impressions: 20, plays: 10 })],
            ['popular-shows', row({ sectionType: 'popular-shows', impressions: 20, plays: 10 })],
        ]);
        const result = computeSectionOrder(feedback, CANONICAL);
        // trending and popular-shows tie exactly — trending (canonical index 0)
        // must still precede popular-shows (canonical index 3).
        expect(result.indexOf('trending')).toBeLessThan(result.indexOf('popular-shows'));
        // anime/binge-worthy are both neutral (0) ties — canonical order preserved.
        expect(result.indexOf('anime')).toBeLessThan(result.indexOf('binge-worthy'));
    });

    it('a feedback row for a section not in canonicalOrder is ignored', () => {
        const feedback = new Map<string, FeedbackRow>([
            [
                'some-unknown-kind',
                row({ sectionType: 'some-unknown-kind', impressions: 50, plays: 50 }),
            ],
        ]);
        const result = computeSectionOrder(feedback, CANONICAL);
        expect(result).toHaveLength(CANONICAL.length);
        expect(new Set(result)).toEqual(new Set(CANONICAL));
        expect(result).not.toContain('some-unknown-kind');
    });

    it('every canonical section appears exactly once, none dropped or duplicated', () => {
        const feedback = new Map<string, FeedbackRow>([
            ['anime', row({ sectionType: 'anime', impressions: 50, plays: 40 })],
            ['trending', row({ sectionType: 'trending', impressions: 50, dismissals: 40 })],
        ]);
        const result = computeSectionOrder(feedback, CANONICAL);
        expect(result).toHaveLength(CANONICAL.length);
        expect(new Set(result)).toEqual(new Set(CANONICAL));
    });
});
