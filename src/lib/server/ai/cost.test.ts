// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for model-aware chat cost estimation (finding F14).
 *
 * Replaces the previous skipped repro: cost must vary by model and be
 * centralized, instead of hardcoding GPT-4o-mini rates everywhere.
 */
import { describe, it, expect } from 'vitest';
import {
    estimateChatCostUsd,
    getModelPricing,
    embeddingPricePerMillion,
    embeddingPriceSource,
    estimateEmbeddingCostUsd,
    parseCostPriceOverrides,
} from './cost.js';

describe('estimateChatCostUsd — model-aware (F14)', () => {
    const ONE_M = 1_000_000;

    it('prices gpt-4o-mini at its known rate', () => {
        expect(estimateChatCostUsd('gpt-4o-mini', ONE_M, ONE_M)).toBeCloseTo(0.15 + 0.6, 6);
    });

    it('charges more for gpt-4o than gpt-4o-mini for identical usage', () => {
        const mini = estimateChatCostUsd('gpt-4o-mini', ONE_M, ONE_M);
        const full = estimateChatCostUsd('gpt-4o', ONE_M, ONE_M);
        expect(full).toBeGreaterThan(mini);
    });

    it('distinguishes gpt-4o-mini from gpt-4o (prefix order matters)', () => {
        expect(getModelPricing('gpt-4o-mini')).not.toEqual(getModelPricing('gpt-4o'));
    });

    it('matches versioned/suffixed model names by prefix', () => {
        expect(getModelPricing('gpt-4o-2024-08-06')).toEqual(getModelPricing('gpt-4o'));
    });

    it('returns null (no fabricated spend) for unknown/local models', () => {
        // A local/OSS chat model pays nothing — fabricating a gpt-4o-mini figure
        // would put phantom spend in the assistant cost ledger.
        expect(getModelPricing('llama-3.1-some-local')).toBeNull();
        expect(getModelPricing('')).toBeNull();
        expect(estimateChatCostUsd('llama-3.1-some-local', ONE_M, ONE_M)).toBe(0);
    });

    it('never returns negative cost for zero/negative token counts', () => {
        expect(estimateChatCostUsd('gpt-4o', 0, 0)).toBe(0);
        expect(estimateChatCostUsd('gpt-4o', -5, -5)).toBe(0);
    });
});

describe('parseCostPriceOverrides (AI_COST_PRICE_OVERRIDES)', () => {
    it('parses "model=price" entries from a comma-separated string', () => {
        const overrides = parseCostPriceOverrides('my-local-model=0.05,another-model=1.5');
        expect(overrides).toEqual(
            expect.arrayContaining([
                { prefix: 'my-local-model', perMillion: 0.05 },
                { prefix: 'another-model', perMillion: 1.5 },
            ]),
        );
    });

    it('parses entries from a real string[] (admin API / programmatic callers)', () => {
        const overrides = parseCostPriceOverrides(['foo=1', 'bar=2']);
        expect(overrides).toEqual(
            expect.arrayContaining([
                { prefix: 'foo', perMillion: 1 },
                { prefix: 'bar', perMillion: 2 },
            ]),
        );
    });

    it('lowercases the prefix so matching is case-insensitive', () => {
        const overrides = parseCostPriceOverrides('My-Local-Model=0.05');
        expect(overrides[0]?.prefix).toBe('my-local-model');
    });

    it('sorts longest-prefix-first so the more specific override wins', () => {
        const overrides = parseCostPriceOverrides('claude=1,claude-3-haiku=0.25');
        expect(overrides[0]?.prefix).toBe('claude-3-haiku');
    });

    it('silently drops malformed entries (no "=", empty prefix, non-numeric or negative price)', () => {
        const overrides = parseCostPriceOverrides(
            'no-equals-sign,=0.05,empty-price=,negative=-1,not-a-number=abc,good=0.1',
        );
        expect(overrides).toEqual([{ prefix: 'good', perMillion: 0.1 }]);
    });

    it('returns an empty list for empty/undefined/non-string-non-array input', () => {
        expect(parseCostPriceOverrides('')).toEqual([]);
        expect(parseCostPriceOverrides(undefined)).toEqual([]);
        expect(parseCostPriceOverrides(null)).toEqual([]);
        expect(parseCostPriceOverrides(42)).toEqual([]);
    });

    it('accepts zero as a valid price (an operator marking a model explicitly free)', () => {
        expect(parseCostPriceOverrides('free-model=0')).toEqual([
            { prefix: 'free-model', perMillion: 0 },
        ]);
    });
});

describe('embeddingPricePerMillion / embeddingPriceSource — overrides (Task B)', () => {
    it('built-in table still resolves with no overrides passed', () => {
        expect(embeddingPricePerMillion('text-embedding-3-small')).toBe(0.02);
        expect(embeddingPriceSource('text-embedding-3-small')).toBe('built-in');
    });

    it('an unrecognised/local model is unpriced with no overrides', () => {
        expect(embeddingPricePerMillion('my-local-embedder')).toBeNull();
        expect(embeddingPriceSource('my-local-embedder')).toBeNull();
        expect(estimateEmbeddingCostUsd('my-local-embedder', 1_000_000)).toBe(0);
    });

    it('an operator override prices a previously-unrecognised model', () => {
        const overrides = parseCostPriceOverrides('my-local-embedder=0.03');
        expect(embeddingPricePerMillion('my-local-embedder', overrides)).toBe(0.03);
        expect(embeddingPriceSource('my-local-embedder', overrides)).toBe('custom');
        expect(estimateEmbeddingCostUsd('my-local-embedder', 1_000_000, overrides)).toBeCloseTo(
            0.03,
            6,
        );
    });

    it('an operator override for a KNOWN model wins over the built-in price', () => {
        // Operator intent always wins — re-labelling a model that later gains
        // built-in support must not silently change a price already set.
        const overrides = parseCostPriceOverrides('text-embedding-3-small=0.5');
        expect(embeddingPricePerMillion('text-embedding-3-small', overrides)).toBe(0.5);
        expect(embeddingPriceSource('text-embedding-3-small', overrides)).toBe('custom');
    });

    it('matches overrides by prefix, same as the built-in table', () => {
        const overrides = parseCostPriceOverrides('my-local=0.07');
        expect(embeddingPricePerMillion('my-local-embedder-v2', overrides)).toBe(0.07);
    });

    it('an empty overrides list behaves exactly like no overrides', () => {
        expect(embeddingPricePerMillion('text-embedding-3-small', [])).toBe(0.02);
        expect(embeddingPricePerMillion('my-local-embedder', [])).toBeNull();
    });
});
