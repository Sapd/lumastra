// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `resolveSeriesAnchor`. Pure function — no DB or fixtures
 * needed. Covers every branch of the rule (cw-only, nu-only, backlog-catchup,
 * substantial, fresh, phantom-scrub) plus edge cases (missing timestamps,
 * tied episodes, nowMs override).
 */
import { describe, it, expect } from 'vitest';
import { EPISODE_ORDER_MULTIPLIER } from '$lib/server/utils/jellyfin-units.js';
import type { ContinueWatchingItem } from './section-builder.js';
import { resolveSeriesAnchor } from './series-anchor.js';

const baseConfig = {
    substantialPercent: 0.2,
    phantomStalenessDays: 3,
    nowMs: new Date('2026-01-10T12:00:00Z').getTime(),
};

function cw(overrides: Partial<ContinueWatchingItem> = {}): ContinueWatchingItem {
    return {
        id: 'cw-id',
        title: 'CW Episode',
        mediaType: 'episode',
        watchProgress: 0,
        seasonNumber: 1,
        episodeNumber: 5,
        seriesId: 'series-uuid',
        externalIds: { internal: 'cw-id' },
        ...overrides,
    };
}

function nu(overrides: Partial<ContinueWatchingItem> = {}): ContinueWatchingItem {
    return {
        id: 'nu-id',
        title: 'NU Episode',
        mediaType: 'episode',
        watchProgress: 0,
        seasonNumber: 1,
        episodeNumber: 6,
        seriesId: 'series-uuid',
        externalIds: { internal: 'nu-id' },
        ...overrides,
    };
}

describe('resolveSeriesAnchor', () => {
    it('returns null winner when both inputs are null', () => {
        const result = resolveSeriesAnchor({
            cw: null,
            nu: null,
            config: baseConfig,
        });
        expect(result).toEqual({ winner: null, reason: 'none' });
    });

    it('returns CW when only CW exists', () => {
        const result = resolveSeriesAnchor({
            cw: cw(),
            nu: null,
            config: baseConfig,
        });
        expect(result).toEqual({ winner: 'cw', reason: 'cw-only' });
    });

    it('returns NU when only NU exists', () => {
        const result = resolveSeriesAnchor({
            cw: null,
            nu: nu(),
            config: baseConfig,
        });
        expect(result).toEqual({ winner: 'nu', reason: 'nu-only' });
    });

    it('CW wins via backlog-catchup when CW order < NU order', () => {
        const result = resolveSeriesAnchor({
            cw: cw({
                episodeNumber: 3,
                resumeRatio: 0.05,
                updatedAt: '2026-01-09T12:00:00Z',
            }),
            nu: nu({ episodeNumber: 7 }),
            config: baseConfig,
        });
        // Low progress, but recent — a real catch-up intention, so the order
        // check wins. (Stale + low progress now yields to NU; see the
        // nu-stale-backlog cases below. This test previously used
        // '1970-01-01T00:00:00Z' to mean "stale", but that parses to 0, which
        // was the unknown-timestamp sentinel and read as FRESH — so it never
        // exercised staleness at all.)
        expect(result).toEqual({ winner: 'cw', reason: 'cw-backlog-catchup' });
    });

    it('NU wins when the backlog CW row is stale AND barely started', () => {
        // Regression: this used to return cw-backlog-catchup unconditionally.
        // A months-old, 5%-watched S01E03 outranked the correct next episode
        // forever — the "I finish an episode and get offered one from three
        // seasons ago" report.
        //
        // Use a real date. '1970-01-01T00:00:00Z' would work now that parseTs
        // distinguishes epoch from unknown, but a plausible timestamp keeps the
        // scenario readable as "watched a couple of months ago".
        const result = resolveSeriesAnchor({
            cw: cw({
                episodeNumber: 3,
                resumeRatio: 0.05,
                updatedAt: '2025-11-01T00:00:00Z',
            }),
            nu: nu({ episodeNumber: 7 }),
            config: baseConfig,
        });
        expect(result).toEqual({ winner: 'nu', reason: 'nu-stale-backlog' });
    });

    it('CW still wins backlog-catchup when the stale backlog row is substantial', () => {
        // Deliberate catch-up: the user is 60% through an earlier episode.
        // Age alone must not hand the anchor to NU.
        const result = resolveSeriesAnchor({
            cw: cw({
                episodeNumber: 3,
                resumeRatio: 0.6,
                updatedAt: '2025-11-01T00:00:00Z',
            }),
            nu: nu({ episodeNumber: 7 }),
            config: baseConfig,
        });
        expect(result).toEqual({ winner: 'cw', reason: 'cw-backlog-catchup' });
    });

    it('CW still wins backlog-catchup when the backlog row is fresh', () => {
        // Started S01E03 yesterday at 5% — a real, current intention.
        const result = resolveSeriesAnchor({
            cw: cw({
                episodeNumber: 3,
                resumeRatio: 0.05,
                updatedAt: '2026-01-09T12:00:00Z',
            }),
            nu: nu({ episodeNumber: 7 }),
            config: baseConfig,
        });
        expect(result).toEqual({ winner: 'cw', reason: 'cw-backlog-catchup' });
    });

    it('CW wins via substantial when ahead-of-sequence with high progress', () => {
        const result = resolveSeriesAnchor({
            cw: cw({
                episodeNumber: 7,
                resumeRatio: 0.5, // 50% — well above 20% substantial threshold
                updatedAt: '2025-01-01T00:00:00Z', // very stale
            }),
            nu: nu({ episodeNumber: 6 }),
            config: baseConfig,
        });
        // Even though stale, substantial progress wins.
        expect(result).toEqual({ winner: 'cw', reason: 'cw-substantial' });
    });

    it('CW wins via fresh when ahead-of-sequence with recent activity', () => {
        const result = resolveSeriesAnchor({
            cw: cw({
                episodeNumber: 7,
                resumeRatio: 0.05, // 5% — below substantial threshold
                updatedAt: '2026-01-09T12:00:00Z', // 24h before nowMs — fresh
            }),
            nu: nu({ episodeNumber: 6 }),
            config: baseConfig,
        });
        expect(result).toEqual({ winner: 'cw', reason: 'cw-fresh' });
    });

    it('NU wins via phantom-scrub when ahead-of-sequence + low-progress + stale', () => {
        const result = resolveSeriesAnchor({
            cw: cw({
                episodeNumber: 7,
                resumeRatio: 0.05, // 5% — below substantial
                updatedAt: '2026-01-01T12:00:00Z', // 9 days before nowMs — well past 3-day staleness
            }),
            nu: nu({ episodeNumber: 6 }),
            config: baseConfig,
        });
        expect(result).toEqual({ winner: 'nu', reason: 'nu-phantom-scrub' });
    });

    it('CW wins via fresh when updatedAt is missing (treated as fresh)', () => {
        // Per the rule: hiding a legitimate resume because metadata is missing
        // is worse than rendering a slightly stale card. updatedAt absent
        // → treat as fresh.
        const result = resolveSeriesAnchor({
            cw: cw({
                episodeNumber: 7,
                resumeRatio: 0.05,
                updatedAt: undefined,
            }),
            nu: nu({ episodeNumber: 6 }),
            config: baseConfig,
        });
        expect(result).toEqual({ winner: 'cw', reason: 'cw-fresh' });
    });

    it('CW wins when episodes tie on order and CW is fresh', () => {
        // S1E5 vs S1E5 — equal order. cwOrder < nuOrder is false, so we drop
        // to substantial/fresh. Resume substantial=false, fresh=true → CW.
        const result = resolveSeriesAnchor({
            cw: cw({
                episodeNumber: 5,
                resumeRatio: 0.05,
                updatedAt: '2026-01-09T12:00:00Z',
            }),
            nu: nu({ episodeNumber: 5 }),
            config: baseConfig,
        });
        expect(result).toEqual({ winner: 'cw', reason: 'cw-fresh' });
    });

    it('cross-season order is respected via EPISODE_ORDER_MULTIPLIER', () => {
        // S1E10 should be < S2E1. Without the multiplier, naive (s+e) would
        // tie S1E10 with S2E0 nonsense. With multiplier: 1*M+10 = M+10 vs
        // 2*M+1 = 2M+1, latter is larger.
        expect(EPISODE_ORDER_MULTIPLIER).toBeGreaterThan(100);
        const result = resolveSeriesAnchor({
            cw: cw({
                seasonNumber: 1,
                episodeNumber: 10,
                resumeRatio: 0,
                // Fresh, so the backlog-catchup branch is reached and this
                // test measures the cross-season ORDER comparison it is about.
                updatedAt: '2026-01-09T12:00:00Z',
            }),
            nu: nu({ seasonNumber: 2, episodeNumber: 1 }),
            config: baseConfig,
        });
        // CW order < NU order across seasons → backlog-catchup.
        expect(result).toEqual({ winner: 'cw', reason: 'cw-backlog-catchup' });
    });

    it('substantialPercent threshold is configurable', () => {
        // Bump threshold to 60% — a 50% resumeRatio should now be insufficient.
        const result = resolveSeriesAnchor({
            cw: cw({
                episodeNumber: 7,
                resumeRatio: 0.5,
                updatedAt: '2026-01-01T12:00:00Z', // stale
            }),
            nu: nu({ episodeNumber: 6 }),
            config: { ...baseConfig, substantialPercent: 0.6 },
        });
        expect(result.winner).toBe('nu');
        expect(result.reason).toBe('nu-phantom-scrub');
    });

    it('phantomStalenessDays threshold is configurable', () => {
        // Bump staleness to 30 days. CW that's 9 days old now counts as fresh.
        const result = resolveSeriesAnchor({
            cw: cw({
                episodeNumber: 7,
                resumeRatio: 0.05,
                updatedAt: '2026-01-01T12:00:00Z', // 9 days before nowMs
            }),
            nu: nu({ episodeNumber: 6 }),
            config: { ...baseConfig, phantomStalenessDays: 30 },
        });
        expect(result).toEqual({ winner: 'cw', reason: 'cw-fresh' });
    });

    it('nowMs override falls back to Date.now() when omitted', () => {
        // No nowMs in config — uses Date.now() implicitly. With a recent
        // updatedAt, CW should still win via fresh.
        const result = resolveSeriesAnchor({
            cw: cw({
                episodeNumber: 7,
                resumeRatio: 0.05,
                updatedAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
            }),
            nu: nu({ episodeNumber: 6 }),
            config: { substantialPercent: 0.2, phantomStalenessDays: 3 },
        });
        expect(result).toEqual({ winner: 'cw', reason: 'cw-fresh' });
    });

    it('handles malformed updatedAt by treating as missing (fresh)', () => {
        const result = resolveSeriesAnchor({
            cw: cw({
                episodeNumber: 7,
                resumeRatio: 0.05,
                updatedAt: 'not-a-date',
            }),
            nu: nu({ episodeNumber: 6 }),
            config: baseConfig,
        });
        // Date.parse('not-a-date') is NaN → parseTs returns 0 → treated as fresh.
        expect(result).toEqual({ winner: 'cw', reason: 'cw-fresh' });
    });

    it('substantial with exactly threshold value wins', () => {
        // Boundary: resumeRatio === substantialPercent.
        const result = resolveSeriesAnchor({
            cw: cw({
                episodeNumber: 7,
                resumeRatio: 0.2, // exactly 20%
                updatedAt: '2025-01-01T00:00:00Z',
            }),
            nu: nu({ episodeNumber: 6 }),
            config: baseConfig,
        });
        expect(result).toEqual({ winner: 'cw', reason: 'cw-substantial' });
    });
});
