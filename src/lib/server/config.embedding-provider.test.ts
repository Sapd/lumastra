// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `hasEmbeddingProvider()`.
 *
 * Two consumers MUST agree on this predicate: `features.aiRecommendations`
 * (does the app expose AI recs?) and the `embeddings` entry in
 * OPTIONAL_INTEGRATIONS (does the admin bell nudge about a missing key?). If
 * they disagree, the bell reports "configured" while the feature stays off.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const EMBEDDING_ENV_KEYS = [
    'OPENAI_API_KEY',
    'VOYAGE_API_KEY',
    'EMBEDDING_BASE_URL',
    'EMBEDDING_API_KEY',
] as const;

// Snapshot so the deletions loadConfig() does on every call don't leak into
// other test files that share this process.
const ORIGINAL_ENV: Partial<Record<(typeof EMBEDDING_ENV_KEYS)[number], string>> = {};
for (const key of EMBEDDING_ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];

async function loadConfig(
    envVars: Partial<Record<(typeof EMBEDDING_ENV_KEYS)[number], string>>,
): Promise<{ hasEmbeddingProvider: () => boolean }> {
    for (const key of EMBEDDING_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, envVars);
    vi.resetModules();
    return (await import('./config.js')) as unknown as {
        hasEmbeddingProvider: () => boolean;
    };
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    for (const key of EMBEDDING_ENV_KEYS) {
        if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
        else process.env[key] = ORIGINAL_ENV[key];
    }
});

describe('hasEmbeddingProvider', () => {
    it('is false when no provider key is set', async () => {
        const { hasEmbeddingProvider } = await loadConfig({});
        expect(hasEmbeddingProvider()).toBe(false);
    });

    it('is true with only OPENAI_API_KEY', async () => {
        const { hasEmbeddingProvider } = await loadConfig({ OPENAI_API_KEY: 'sk-test' });
        expect(hasEmbeddingProvider()).toBe(true);
    });

    it('is true with only VOYAGE_API_KEY', async () => {
        const { hasEmbeddingProvider } = await loadConfig({ VOYAGE_API_KEY: 'pa-test' });
        expect(hasEmbeddingProvider()).toBe(true);
    });

    it('is true with a custom endpoint (base URL AND key)', async () => {
        const { hasEmbeddingProvider } = await loadConfig({
            EMBEDDING_BASE_URL: 'https://embed.example.com/v1',
            EMBEDDING_API_KEY: 'local-key',
        });
        expect(hasEmbeddingProvider()).toBe(true);
    });

    it('is false with a custom base URL but no key — that combination cannot embed', async () => {
        const { hasEmbeddingProvider } = await loadConfig({
            EMBEDDING_BASE_URL: 'https://embed.example.com/v1',
        });
        expect(hasEmbeddingProvider()).toBe(false);
    });

    it('is false with a whitespace-only VOYAGE_API_KEY', async () => {
        const { hasEmbeddingProvider } = await loadConfig({ VOYAGE_API_KEY: '   ' });
        expect(hasEmbeddingProvider()).toBe(false);
    });

    it('is false with a whitespace-only OPENAI_API_KEY', async () => {
        const { hasEmbeddingProvider } = await loadConfig({ OPENAI_API_KEY: '   ' });
        expect(hasEmbeddingProvider()).toBe(false);
    });

    it('is false with a valid EMBEDDING_BASE_URL but a whitespace-only EMBEDDING_API_KEY', async () => {
        const { hasEmbeddingProvider } = await loadConfig({
            EMBEDDING_BASE_URL: 'https://embed.example.com/v1',
            EMBEDDING_API_KEY: '   ',
        });
        expect(hasEmbeddingProvider()).toBe(false);
    });
});
