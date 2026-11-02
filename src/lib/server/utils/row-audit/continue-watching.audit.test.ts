// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    CW_INVARIANTS,
    detectPhantomShadows,
    type CWAuditItem,
    type CWCrossRefItem,
} from './continue-watching.audit.js';
import { runInvariants, summarizeAudit } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeItem(overrides: Partial<CWAuditItem> = {}): CWAuditItem {
    return {
        media_id: 'mi-1',
        media_type: 'episode',
        resume_position_ms: 10 * 60 * 1000, // 10 min
        runtime_ms: 45 * 60 * 1000, // 45 min  → 22% ratio
        is_watched: false,
        updated_at: new Date(Date.now() - 1 * DAY_MS).toISOString(),
        ...overrides,
    };
}

describe('CW_INVARIANTS', () => {
    it('healthy item passes all invariants', () => {
        const [result] = runInvariants([makeItem()], CW_INVARIANTS);
        expect(result.violations).toHaveLength(0);
    });

    it('is-not-watched fires when is_watched=true', () => {
        const [r] = runInvariants([makeItem({ is_watched: true })], CW_INVARIANTS);
        expect(r.violations.map((v) => v.invariantId)).toContain('is-not-watched');
    });

    it('not-complete-by-ratio fires when ratio exceeds the runtime-aware threshold', () => {
        // 45-min episode (tier: <90 min → threshold 0.90) at 95.6% → violation.
        const [r] = runInvariants(
            [
                makeItem({
                    resume_position_ms: 43 * 60 * 1000,
                    runtime_ms: 45 * 60 * 1000, // 95.6%
                }),
            ],
            CW_INVARIANTS,
        );
        expect(r.violations.map((v) => v.invariantId)).toContain('not-complete-by-ratio');
    });

    it('not-complete-by-ratio passes just below the runtime-aware threshold', () => {
        // 45-min episode (tier: <90 min → threshold 0.90) at 88% → healthy.
        const [r] = runInvariants(
            [
                makeItem({
                    resume_position_ms: Math.floor(0.88 * 45 * 60 * 1000),
                    runtime_ms: 45 * 60 * 1000,
                }),
            ],
            CW_INVARIANTS,
        );
        expect(r.violations.map((v) => v.invariantId)).not.toContain('not-complete-by-ratio');
    });

    it('3-hour movie at 95.5% is healthy (Codex regression case)', () => {
        // 180-min movie (tier: ≥150 min → threshold 0.96). Write path keeps
        // the row resumable until 96%, so the CW query and audit invariant
        // must agree: 95.5% is still in-progress, not "complete-by-ratio".
        const [r] = runInvariants(
            [
                makeItem({
                    media_type: 'movie',
                    resume_position_ms: Math.floor(0.955 * 180 * 60 * 1000),
                    runtime_ms: 180 * 60 * 1000,
                }),
            ],
            CW_INVARIANTS,
        );
        expect(r.violations.map((v) => v.invariantId)).not.toContain('not-complete-by-ratio');
    });

    it('has-min-progress fires when ratio < 0.10', () => {
        const [r] = runInvariants(
            [
                makeItem({
                    resume_position_ms: 2 * 60 * 1000,
                    runtime_ms: 45 * 60 * 1000, // 4.4%
                }),
            ],
            CW_INVARIANTS,
        );
        expect(r.violations.map((v) => v.invariantId)).toContain('has-min-progress');
    });

    it('not-music-type fires for music family', () => {
        for (const t of ['music', 'track', 'album', 'podcast', 'artist']) {
            const [r] = runInvariants([makeItem({ media_type: t })], CW_INVARIANTS);
            expect(r.violations.map((v) => v.invariantId)).toContain('not-music-type');
        }
    });

    it('not-stale-beyond-60d fires after 60 days', () => {
        const [r] = runInvariants(
            [
                makeItem({
                    updated_at: new Date(Date.now() - 61 * DAY_MS).toISOString(),
                }),
            ],
            CW_INVARIANTS,
        );
        expect(r.violations.map((v) => v.invariantId)).toContain('not-stale-beyond-60d');
    });

    it('unknown runtime is forgiving (ratio invariants skip)', () => {
        const [r] = runInvariants([makeItem({ runtime_ms: null })], CW_INVARIANTS);
        expect(r.violations.map((v) => v.invariantId)).not.toContain('not-complete-by-ratio');
        expect(r.violations.map((v) => v.invariantId)).not.toContain('has-min-progress');
    });
});

describe('summarizeAudit', () => {
    it('counts healthy vs violating and groups by invariant id', () => {
        const items = [
            makeItem(),
            makeItem({ is_watched: true }), // is-not-watched
            makeItem({
                resume_position_ms: 44 * 60 * 1000,
                runtime_ms: 45 * 60 * 1000, // 97% → not-complete-by-ratio
            }),
            makeItem({ media_type: 'music' }), // not-music-type
        ];
        const results = runInvariants(items, CW_INVARIANTS);
        const summary = summarizeAudit(results);
        expect(summary.total).toBe(4);
        expect(summary.healthy).toBe(1);
        expect(summary.violating).toBe(3);
        expect(summary.byInvariant['is-not-watched']).toBe(1);
        expect(summary.byInvariant['not-complete-by-ratio']).toBe(1);
        expect(summary.byInvariant['not-music-type']).toBe(1);
    });
});

describe('detectPhantomShadows', () => {
    function makeCrossRef(
        overrides: Partial<CWCrossRefItem> & {
            series_id: string;
            season_number: number;
            episode_number: number;
        },
    ): CWCrossRefItem {
        return {
            media_id: 'ep-x',
            media_type: 'episode',
            resume_position_ms: 5 * 60 * 1000,
            runtime_ms: 45 * 60 * 1000, // ~11% default
            is_watched: false,
            updated_at: new Date(Date.now() - 10 * DAY_MS).toISOString(),
            ...overrides,
        };
    }

    const ctx = {
        nextUpBySeries: new Map([['series-A', { season_number: 8, episode_number: 1 }]]),
        substantialRatio: 0.2,
        phantomStalenessMs: 3 * DAY_MS,
    };

    it('flags ahead-of-sequence, low-progress, stale item', () => {
        const phantoms = detectPhantomShadows(
            [
                makeCrossRef({
                    series_id: 'series-A',
                    season_number: 8,
                    episode_number: 14,
                }),
            ],
            ctx,
        );
        expect(phantoms).toHaveLength(1);
    });

    it('does not flag backlog (CW before NU)', () => {
        const phantoms = detectPhantomShadows(
            [
                makeCrossRef({
                    series_id: 'series-A',
                    season_number: 7,
                    episode_number: 24,
                    resume_position_ms: 5 * 60 * 1000, // low progress irrelevant
                }),
            ],
            ctx,
        );
        expect(phantoms).toHaveLength(0);
    });

    it('does not flag ahead-of-sequence with substantial progress', () => {
        const phantoms = detectPhantomShadows(
            [
                makeCrossRef({
                    series_id: 'series-A',
                    season_number: 8,
                    episode_number: 14,
                    resume_position_ms: 20 * 60 * 1000, // ~44%
                    runtime_ms: 45 * 60 * 1000,
                }),
            ],
            ctx,
        );
        expect(phantoms).toHaveLength(0);
    });

    it('does not flag recent ahead-of-sequence item', () => {
        const phantoms = detectPhantomShadows(
            [
                makeCrossRef({
                    series_id: 'series-A',
                    season_number: 8,
                    episode_number: 14,
                    updated_at: new Date(Date.now() - 1 * DAY_MS).toISOString(),
                }),
            ],
            ctx,
        );
        expect(phantoms).toHaveLength(0);
    });

    it('does not flag when series has no Next Up candidate', () => {
        const phantoms = detectPhantomShadows(
            [
                makeCrossRef({
                    series_id: 'series-Z',
                    season_number: 8,
                    episode_number: 14,
                }),
            ],
            ctx,
        );
        expect(phantoms).toHaveLength(0);
    });
});
