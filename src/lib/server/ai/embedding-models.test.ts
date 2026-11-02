// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    checkEmbeddingColumnDimension,
    resolveEffectiveEmbedding,
    resolveEmbeddingModelName,
    validateEmbeddingConfig,
    DEFAULT_VOYAGE_MODEL,
    DEFAULT_OPENAI_MODEL,
    type EmbeddingResolverInput,
} from './embedding-models.js';

describe('resolveEmbeddingModelName', () => {
    it('uses the explicit model when configured', () => {
        const r = resolveEmbeddingModelName({
            embeddingModel: 'voyage-3.5',
            voyageApiKey: 'k',
        });
        expect(r).toEqual({ model: 'voyage-3.5', source: 'config' });
    });

    it('defaults to the Voyage model when a Voyage key is present', () => {
        const r = resolveEmbeddingModelName({ voyageApiKey: 'k' });
        expect(r).toEqual({
            model: DEFAULT_VOYAGE_MODEL,
            source: 'provider-default',
        });
    });

    it('defaults to the OpenAI model for a custom base URL', () => {
        const r = resolveEmbeddingModelName({
            embeddingBaseUrl: 'https://x/v1',
            embeddingApiKey: 'k',
        });
        expect(r.model).toBe(DEFAULT_OPENAI_MODEL);
    });

    it('defaults to OpenAI when only an OpenAI key is present', () => {
        const r = resolveEmbeddingModelName({ openaiApiKey: 'k' });
        expect(r.model).toBe(DEFAULT_OPENAI_MODEL);
    });

    it('prefers Voyage when both keys are present', () => {
        const r = resolveEmbeddingModelName({
            voyageApiKey: 'v',
            openaiApiKey: 'o',
        });
        expect(r.model).toBe(DEFAULT_VOYAGE_MODEL);
    });
});

describe('resolveEffectiveEmbedding — dimensions', () => {
    it('uses the model default when no dimension is configured', () => {
        const r = resolveEffectiveEmbedding({ voyageApiKey: 'k' });
        expect(r.model).toBe('voyage-3-large');
        expect(r.dimensions).toBe(1024);
        expect(r.dimensionSource).toBe('model-default');
        expect(r.provider).toBe('voyage');
    });

    it('lets an explicit EMBEDDING_DIMENSIONS win (even an invalid one)', () => {
        // The resolver reports what config asks for; validation flags mismatches.
        const r = resolveEffectiveEmbedding({
            voyageApiKey: 'k',
            embeddingDimensions: 1536,
        });
        expect(r.dimensions).toBe(1536);
        expect(r.dimensionSource).toBe('config');
    });

    it('falls back to the provider default for an unknown model', () => {
        const r = resolveEffectiveEmbedding({
            embeddingModel: 'my-custom-model',
            openaiApiKey: 'k',
        });
        expect(r.spec).toBeNull();
        expect(r.provider).toBe('openai');
        expect(r.dimensions).toBe(1536);
        expect(r.dimensionSource).toBe('provider-default');
    });

    it('reports no provider when nothing is configured', () => {
        const r = resolveEffectiveEmbedding({});
        expect(r.hasProvider).toBe(false);
        expect(r.dimensions).toBe(1024); // voyage default
    });

    it('does not treat a custom endpoint as configured without EMBEDDING_API_KEY', () => {
        const r = resolveEffectiveEmbedding({ embeddingBaseUrl: 'https://x/v1' });
        expect(r.provider).toBe('voyage');
        expect(r.hasProvider).toBe(false);
    });
});

describe('validateEmbeddingConfig', () => {
    const codes = (input: EmbeddingResolverInput): string[] =>
        validateEmbeddingConfig(input).map((i) => i.code);

    it('passes a clean Voyage default config', () => {
        expect(validateEmbeddingConfig({ voyageApiKey: 'k' })).toEqual([]);
    });

    it('flags the EMBEDDING_DIMENSIONS=1536 + voyage-3-large mismatch as an error', () => {
        const issues = validateEmbeddingConfig({
            voyageApiKey: 'k',
            embeddingDimensions: 1536,
        });
        expect(issues).toHaveLength(1);
        expect(issues[0].severity).toBe('error');
        expect(issues[0].code).toBe('embedding.dimension-mismatch');
        expect(issues[0].message).toContain('1536');
        expect(issues[0].remediation).toContain('256, 512, 1024, 2048');
    });

    it('accepts a valid Matryoshka dimension for Voyage', () => {
        expect(
            validateEmbeddingConfig({
                voyageApiKey: 'k',
                embeddingDimensions: 512,
            }),
        ).toEqual([]);
    });

    it('accepts a reduced dimension within OpenAI v3 range', () => {
        expect(
            codes({
                embeddingModel: 'text-embedding-3-small',
                openaiApiKey: 'k',
                embeddingDimensions: 768,
            }),
        ).toEqual([]);
    });

    it('rejects an out-of-range dimension for OpenAI v3', () => {
        expect(
            codes({
                embeddingModel: 'text-embedding-3-large',
                openaiApiKey: 'k',
                embeddingDimensions: 9999,
            }),
        ).toEqual(['embedding.dimension-mismatch']);
    });

    it('rejects a custom dimension for a fixed-width model', () => {
        expect(
            codes({
                embeddingModel: 'text-embedding-ada-002',
                openaiApiKey: 'k',
                embeddingDimensions: 512,
            }),
        ).toEqual(['embedding.dimension-mismatch']);
    });

    it('warns (not errors) for an unknown model without explicit dimensions', () => {
        const issues = validateEmbeddingConfig({
            embeddingModel: 'mystery',
            voyageApiKey: 'k',
        });
        expect(issues).toHaveLength(1);
        expect(issues[0].severity).toBe('warning');
        expect(issues[0].code).toBe('embedding.unknown-model');
    });

    it('trusts an unknown model when dimensions are pinned explicitly', () => {
        expect(
            validateEmbeddingConfig({
                embeddingModel: 'mystery',
                voyageApiKey: 'k',
                embeddingDimensions: 768,
            }),
        ).toEqual([]);
    });

    it('warns when no provider is configured', () => {
        const issues = validateEmbeddingConfig({});
        expect(issues).toHaveLength(1);
        expect(issues[0].code).toBe('embedding.no-provider');
        expect(issues[0].severity).toBe('warning');
    });

    it('warns when a custom endpoint has no EMBEDDING_API_KEY', () => {
        const issues = validateEmbeddingConfig({ embeddingBaseUrl: 'https://x/v1' });
        expect(issues).toHaveLength(1);
        expect(issues[0].code).toBe('embedding.custom-key-missing');
        expect(issues[0].severity).toBe('error');
        expect(issues[0].remediation).toContain('EMBEDDING_API_KEY');
    });
});

describe('checkEmbeddingColumnDimension', () => {
    it('is clean when the column width matches the configured dimension', () => {
        expect(checkEmbeddingColumnDimension(1024, 1024)).toEqual([]);
    });

    it('is clean when the column does not exist yet (fresh install)', () => {
        expect(checkEmbeddingColumnDimension(1536, null)).toEqual([]);
        expect(checkEmbeddingColumnDimension(1536, 0)).toEqual([]);
    });

    it('errors on a Voyage(1024) → OpenAI(1536) switch without a column migration', () => {
        const issues = checkEmbeddingColumnDimension(1536, 1024);
        expect(issues).toHaveLength(1);
        expect(issues[0].code).toBe('embedding.column-dimension-mismatch');
        expect(issues[0].severity).toBe('error');
        // Message must name both widths so the operator can act.
        expect(issues[0].message).toContain('1536');
        expect(issues[0].message).toContain('1024');
        expect(issues[0].remediation).toBeTruthy();
    });

    it('errors on the reverse OpenAI(1536) → Voyage(1024) switch too', () => {
        const issues = checkEmbeddingColumnDimension(1024, 1536);
        expect(issues).toHaveLength(1);
        expect(issues[0].code).toBe('embedding.column-dimension-mismatch');
    });
});
