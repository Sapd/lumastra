// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for ai/voyage.ts — the C21 fix-plan finding.
 *
 * Covers:
 *   - Outside any `runWithEmbeddingFetch(...)` scope, the OpenAI/Voyage
 *     clients are built with an SSRF-guarded default fetch (delegates to
 *     `safeFetch` from tasks/url-safety.ts) rather than the raw global
 *     fetch — this is what closes the "interactive embedding bypasses the
 *     task-scoped SSRF guard" hole.
 *   - Inside a `runWithEmbeddingFetch(...)` scope, the task-scoped fetch is
 *     used instead (unchanged priority).
 *   - `generateOpenAIEmbedding` / `generateVoyageQueryEmbedding` validate the
 *     returned vector (length === expected dimension, every entry finite)
 *     and return null on a malformed response rather than handing a
 *     poisoned vector to the caller.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockOpenAICreate = vi.fn();
const capturedOpenAIOptions: Array<{ apiKey: string; baseURL?: string; fetch?: typeof fetch }> = [];
vi.mock('openai', () => ({
    default: class OpenAI {
        embeddings = { create: (...args: unknown[]) => mockOpenAICreate(...args) };
        constructor(opts: { apiKey: string; baseURL?: string; fetch?: typeof fetch }) {
            capturedOpenAIOptions.push(opts);
        }
    },
}));

const mockVoyageEmbed = vi.fn();
const capturedVoyageOptions: Array<{ apiKey: string; fetch?: typeof fetch }> = [];
vi.mock('voyageai', () => ({
    VoyageAIClient: class VoyageAIClient {
        embed = (...args: unknown[]) => mockVoyageEmbed(...args);
        constructor(opts: { apiKey: string; fetch?: typeof fetch }) {
            capturedVoyageOptions.push(opts);
        }
    },
}));

const mockGetAiConfig = vi.fn();
vi.mock('../config/domains/ai.js', () => ({
    getAiConfig: (...args: unknown[]) => mockGetAiConfig(...args),
}));

vi.mock('../utils/logger', () => ({
    Logger: { for: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

const mockSafeFetch = vi.fn();
vi.mock('../tasks/url-safety.js', () => ({
    safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
}));

const mockFetchWithTimeout = vi.fn();
vi.mock('../utils/fetch-utils.js', () => ({
    fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
}));

const { getEmbeddingFetch, runWithEmbeddingFetch } = await import('./embedding-fetch-context.js');
const { generateVoyageEmbedding, generateVoyageQueryEmbedding, generateVoyageEmbeddingsBatch } =
    await import('./voyage.js');

// generateOpenAIEmbedding isn't exported — reach it via generateVoyageEmbedding
// with an OpenAI-preferring config (no voyageApiKey, openaiApiKey set), which
// is exactly what the real callers (generateVoyageQueryEmbedding's fallback,
// a custom EMBEDDING_BASE_URL) do too.

const OPENAI_CONFIG = {
    embeddingModel: '',
    embeddingDimensions: 0,
    embeddingBaseUrl: '',
    embeddingApiKey: '',
    voyageApiKey: '',
    openaiApiKey: 'sk-openai-test',
    embeddingAllowPrivateUrls: false,
};

const VOYAGE_CONFIG = {
    embeddingModel: '',
    embeddingDimensions: 0,
    embeddingBaseUrl: '',
    embeddingApiKey: '',
    voyageApiKey: 'voyage-test-key',
    openaiApiKey: '',
    embeddingAllowPrivateUrls: false,
};

function fakeVector(len: number, value = 0.1): number[] {
    return Array.from({ length: len }, () => value);
}

beforeEach(() => {
    vi.clearAllMocks();
    capturedOpenAIOptions.length = 0;
    capturedVoyageOptions.length = 0;
    mockGetAiConfig.mockReturnValue(OPENAI_CONFIG);
});

describe('getOpenAIEmbeddingClient — default fetch (C21)', () => {
    it('builds the client with an SSRF-guarded fetch when no task-scoped fetch is active', async () => {
        expect(getEmbeddingFetch()).toBeUndefined();
        mockOpenAICreate.mockResolvedValue({
            data: [{ embedding: fakeVector(1536), index: 0 }],
            usage: { total_tokens: 3 },
        });

        await generateVoyageEmbedding('hello');

        expect(capturedOpenAIOptions).toHaveLength(1);
        const guardedFetch = capturedOpenAIOptions[0].fetch;
        expect(typeof guardedFetch).toBe('function');

        // Prove it actually delegates to safeFetch rather than raw fetch.
        mockSafeFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        await guardedFetch!('https://api.openai.com/v1/embeddings', { method: 'POST' });
        expect(mockSafeFetch).toHaveBeenCalledWith(
            'https://api.openai.com/v1/embeddings',
            expect.objectContaining({ method: 'POST' }),
        );
        expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('delegates to the same-origin-only fetchWithTimeout instead of safeFetch when EMBEDDING_ALLOW_PRIVATE_URLS is set', async () => {
        mockGetAiConfig.mockReturnValue({ ...OPENAI_CONFIG, embeddingAllowPrivateUrls: true });
        mockOpenAICreate.mockResolvedValue({
            data: [{ embedding: fakeVector(1536), index: 0 }],
            usage: { total_tokens: 3 },
        });

        // The cached module-level `openaiEmbeddingClient` singleton may
        // already exist from an earlier test in this file (constructed once,
        // reused thereafter) — reset modules so this test observes a FRESH
        // construction and a fresh `capturedOpenAIOptions` entry regardless
        // of run order.
        vi.resetModules();
        const fresh = await import('./voyage.js');
        await fresh.generateVoyageEmbedding('hello');

        expect(capturedOpenAIOptions).toHaveLength(1);
        const guardedFetch = capturedOpenAIOptions[0].fetch;
        mockFetchWithTimeout.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        await guardedFetch!('http://embedder.lan/v1/embeddings', { method: 'POST' });

        expect(mockFetchWithTimeout).toHaveBeenCalledWith(
            'http://embedder.lan/v1/embeddings',
            expect.objectContaining({ method: 'POST' }),
        );
        // safeFetch (the public-only guard) must not be used for this call —
        // it would refuse a private/LAN address regardless of the opt-in.
        expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('uses the task-scoped fetch instead when inside runWithEmbeddingFetch', async () => {
        const taskFetch = vi.fn().mockResolvedValue(new Response('{}'));
        mockOpenAICreate.mockResolvedValue({
            data: [{ embedding: fakeVector(1536), index: 0 }],
            usage: { total_tokens: 3 },
        });

        await runWithEmbeddingFetch(taskFetch as unknown as typeof fetch, async () => {
            await generateVoyageEmbedding('hello');
        });

        expect(capturedOpenAIOptions).toHaveLength(1);
        await capturedOpenAIOptions[0].fetch!('https://embedder.test/v1/embeddings', {
            method: 'POST',
        });
        expect(taskFetch).toHaveBeenCalledExactlyOnceWith('https://embedder.test/v1/embeddings', {
            method: 'POST',
        });
        // The guarded default must not be involved at all in this path.
        expect(mockSafeFetch).not.toHaveBeenCalled();
    });
});

describe('getVoyageClient — default fetch (C21)', () => {
    beforeEach(() => {
        mockGetAiConfig.mockReturnValue(VOYAGE_CONFIG);
    });

    it('builds the client with an SSRF-guarded fetch when no task-scoped fetch is active', async () => {
        mockVoyageEmbed.mockResolvedValue({
            data: [{ embedding: fakeVector(1024) }],
            usage: { totalTokens: 3 },
        });

        await generateVoyageQueryEmbedding('some lyrics');

        expect(capturedVoyageOptions).toHaveLength(1);
        expect(typeof capturedVoyageOptions[0].fetch).toBe('function');
    });

    it('uses the task-scoped fetch instead when inside runWithEmbeddingFetch', async () => {
        const taskFetch = vi.fn().mockResolvedValue(new Response('{}'));
        mockVoyageEmbed.mockResolvedValue({
            data: [{ embedding: fakeVector(1024) }],
            usage: { totalTokens: 3 },
        });

        await runWithEmbeddingFetch(taskFetch as unknown as typeof fetch, async () => {
            await generateVoyageQueryEmbedding('some lyrics');
        });

        await capturedVoyageOptions[0].fetch!('https://api.voyageai.com/v1/embeddings', {
            method: 'POST',
        });
        expect(taskFetch).toHaveBeenCalledExactlyOnceWith(
            'https://api.voyageai.com/v1/embeddings',
            { method: 'POST' },
        );
    });
});

describe('embedding response validation (C21)', () => {
    it('generateOpenAIEmbedding (via generateVoyageEmbedding) returns null on wrong dimension', async () => {
        mockOpenAICreate.mockResolvedValue({
            data: [{ embedding: fakeVector(3), index: 0 }], // 3 !== 1536
            usage: { total_tokens: 3 },
        });

        const result = await generateVoyageEmbedding('hello');
        expect(result).toBeNull();
    });

    it('generateOpenAIEmbedding returns null when the vector contains a non-finite entry', async () => {
        const bad = fakeVector(1536);
        bad[100] = Number.NaN;
        mockOpenAICreate.mockResolvedValue({
            data: [{ embedding: bad, index: 0 }],
            usage: { total_tokens: 3 },
        });

        const result = await generateVoyageEmbedding('hello');
        expect(result).toBeNull();
    });

    it('generateOpenAIEmbedding returns the vector unchanged when valid', async () => {
        const good = fakeVector(1536, 0.42);
        mockOpenAICreate.mockResolvedValue({
            data: [{ embedding: good, index: 0 }],
            usage: { total_tokens: 3 },
        });

        const result = await generateVoyageEmbedding('hello');
        expect(result).toEqual(good);
    });

    it('generateVoyageQueryEmbedding returns null on wrong dimension', async () => {
        mockGetAiConfig.mockReturnValue(VOYAGE_CONFIG);
        mockVoyageEmbed.mockResolvedValue({
            data: [{ embedding: fakeVector(7) }], // 7 !== 1024
            usage: { totalTokens: 3 },
        });

        const result = await generateVoyageQueryEmbedding('some lyrics');
        expect(result).toBeNull();
    });

    it('generateVoyageQueryEmbedding returns null when the vector contains a non-finite entry', async () => {
        mockGetAiConfig.mockReturnValue(VOYAGE_CONFIG);
        const bad = fakeVector(1024);
        bad[0] = Number.POSITIVE_INFINITY;
        mockVoyageEmbed.mockResolvedValue({
            data: [{ embedding: bad }],
            usage: { totalTokens: 3 },
        });

        const result = await generateVoyageQueryEmbedding('some lyrics');
        expect(result).toBeNull();
    });

    it('generateVoyageQueryEmbedding returns the vector unchanged when valid', async () => {
        mockGetAiConfig.mockReturnValue(VOYAGE_CONFIG);
        const good = fakeVector(1024, 0.5);
        mockVoyageEmbed.mockResolvedValue({
            data: [{ embedding: good }],
            usage: { totalTokens: 3 },
        });

        const result = await generateVoyageQueryEmbedding('some lyrics');
        expect(result).toEqual(good);
    });

    // Deferred item 7: generateVoyageEmbedding's direct Voyage-client branch
    // (as opposed to its generateOpenAIEmbedding fallback, covered above) had
    // no validation at all — a malformed vector from the direct Voyage
    // response went straight to the caller.
    it('generateVoyageEmbedding (direct Voyage path) returns null on wrong dimension', async () => {
        mockGetAiConfig.mockReturnValue(VOYAGE_CONFIG);
        mockVoyageEmbed.mockResolvedValue({
            data: [{ embedding: fakeVector(3) }], // 3 !== 1024
            usage: { totalTokens: 3 },
        });

        const result = await generateVoyageEmbedding('hello');
        expect(result).toBeNull();
    });

    it('generateVoyageEmbedding (direct Voyage path) returns null when the vector contains a null/NaN entry', async () => {
        mockGetAiConfig.mockReturnValue(VOYAGE_CONFIG);
        const bad = fakeVector(1024);
        bad[5] = Number.NaN;
        mockVoyageEmbed.mockResolvedValue({
            data: [{ embedding: bad }],
            usage: { totalTokens: 3 },
        });

        const result = await generateVoyageEmbedding('hello');
        expect(result).toBeNull();
    });

    it('generateVoyageEmbedding (direct Voyage path) returns the vector unchanged when valid', async () => {
        mockGetAiConfig.mockReturnValue(VOYAGE_CONFIG);
        const good = fakeVector(1024, 0.42);
        mockVoyageEmbed.mockResolvedValue({
            data: [{ embedding: good }],
            usage: { totalTokens: 3 },
        });

        const result = await generateVoyageEmbedding('hello');
        expect(result).toEqual(good);
    });
});

describe('batch embedding response validation (item 7)', () => {
    // Batch functions must not mis-associate a vector with the wrong item: a
    // malformed entry is rejected (replaced with null) IN PLACE rather than
    // dropped, which would shift every subsequent entry's index and corrupt
    // the input[i] <-> output[i] mapping a caller relies on.

    it('generateVoyageEmbeddingsBatch (direct Voyage path) nulls only the malformed entry, in place', async () => {
        mockGetAiConfig.mockReturnValue(VOYAGE_CONFIG);
        const good0 = fakeVector(1024, 0.1);
        const bad1 = fakeVector(3); // wrong dimension
        const good2 = fakeVector(1024, 0.3);
        mockVoyageEmbed.mockResolvedValue({
            data: [{ embedding: good0 }, { embedding: bad1 }, { embedding: good2 }],
            usage: { totalTokens: 9 },
        });

        const result = await generateVoyageEmbeddingsBatch(['a', 'b', 'c']);

        expect(result).toHaveLength(3);
        expect(result[0]).toEqual(good0);
        expect(result[1]).toBeNull();
        expect(result[2]).toEqual(good2);
    });

    it('generateVoyageEmbeddingsBatch (direct Voyage path) nulls an entry with a non-finite value', async () => {
        mockGetAiConfig.mockReturnValue(VOYAGE_CONFIG);
        const good = fakeVector(1024, 0.1);
        const bad = fakeVector(1024);
        bad[10] = Number.POSITIVE_INFINITY;
        mockVoyageEmbed.mockResolvedValue({
            data: [{ embedding: good }, { embedding: bad }],
            usage: { totalTokens: 6 },
        });

        const result = await generateVoyageEmbeddingsBatch(['a', 'b']);

        expect(result).toEqual([good, null]);
    });

    it('generateOpenAIEmbeddingsBatch (via generateVoyageEmbeddingsBatch fallback) nulls only the malformed entry, preserving index order', async () => {
        mockGetAiConfig.mockReturnValue(OPENAI_CONFIG); // routes through generateOpenAIEmbeddingsBatch
        const good0 = fakeVector(1536, 0.1);
        const bad1 = fakeVector(1536);
        bad1[0] = Number.NaN;
        const good2 = fakeVector(1536, 0.3);
        mockOpenAICreate.mockResolvedValue({
            // Deliberately out of order, like the existing sort-by-index handling expects.
            data: [
                { embedding: good2, index: 2 },
                { embedding: good0, index: 0 },
                { embedding: bad1, index: 1 },
            ],
            usage: { total_tokens: 9 },
        });

        const result = await generateVoyageEmbeddingsBatch(['a', 'b', 'c']);

        expect(result).toHaveLength(3);
        expect(result[0]).toEqual(good0);
        expect(result[1]).toBeNull();
        expect(result[2]).toEqual(good2);
    });
});

describe('batch embedding cardinality/index attacks (C-1 fix round)', () => {
    // A malformed ENTRY is one thing; a malformed BATCH SHAPE is another.
    // These cover an attacker-controlled EMBEDDING_BASE_URL returning a
    // `data` array whose size or `index` values don't match the request —
    // the previous fix (sort-by-index, then push) never checked
    // `results.length === texts.length`, so any of these would silently
    // shift every later entry (and every later CHUNK, since results
    // accumulate across the outer loop) into the wrong slot.

    it('OpenAI-routed: a SHORT response (missing an entry, no usable index) rejects the WHOLE chunk rather than shift indices', async () => {
        mockGetAiConfig.mockReturnValue(OPENAI_CONFIG);
        const good0 = fakeVector(1536, 0.1);
        const good1 = fakeVector(1536, 0.2);
        // 3 texts requested, only 2 entries returned, NEITHER carries an index.
        mockOpenAICreate.mockResolvedValue({
            data: [{ embedding: good0 }, { embedding: good1 }],
            usage: { total_tokens: 6 },
        });

        const result = await generateVoyageEmbeddingsBatch(['a', 'b', 'c']);

        expect(result).toEqual([null, null, null]);
    });

    it('OpenAI-routed: an OVER-LONG response (extra entry, no usable index) rejects the WHOLE chunk', async () => {
        mockGetAiConfig.mockReturnValue(OPENAI_CONFIG);
        const good0 = fakeVector(1536, 0.1);
        const good1 = fakeVector(1536, 0.2);
        const extra = fakeVector(1536, 0.3);
        // 2 texts requested, 3 entries returned, none carry an index.
        mockOpenAICreate.mockResolvedValue({
            data: [{ embedding: good0 }, { embedding: good1 }, { embedding: extra }],
            usage: { total_tokens: 9 },
        });

        const result = await generateVoyageEmbeddingsBatch(['a', 'b']);

        expect(result).toEqual([null, null]);
    });

    it('OpenAI-routed: an out-of-range index is rejected without disturbing the other entries', async () => {
        mockGetAiConfig.mockReturnValue(OPENAI_CONFIG);
        const good0 = fakeVector(1536, 0.1);
        const outOfRange = fakeVector(1536, 0.2);
        const good2 = fakeVector(1536, 0.3);
        mockOpenAICreate.mockResolvedValue({
            data: [
                { embedding: good0, index: 0 },
                { embedding: outOfRange, index: 99 }, // out of range for a 3-text batch
                { embedding: good2, index: 2 },
            ],
            usage: { total_tokens: 9 },
        });

        const result = await generateVoyageEmbeddingsBatch(['a', 'b', 'c']);

        expect(result).toEqual([good0, null, good2]);
    });

    it('OpenAI-routed: a duplicate index is rejected (first writer wins) without disturbing other entries', async () => {
        mockGetAiConfig.mockReturnValue(OPENAI_CONFIG);
        const first = fakeVector(1536, 0.1);
        const duplicate = fakeVector(1536, 0.9); // same index as `first`, different content
        const good1 = fakeVector(1536, 0.2);
        mockOpenAICreate.mockResolvedValue({
            data: [
                { embedding: first, index: 0 },
                { embedding: duplicate, index: 0 }, // duplicate of the first entry's index
                { embedding: good1, index: 1 },
            ],
            usage: { total_tokens: 9 },
        });

        const result = await generateVoyageEmbeddingsBatch(['a', 'b']);

        expect(result).toEqual([first, good1]);
    });

    it('OpenAI-routed: a non-integer index anywhere in the response disables index-trust for the whole chunk, falling back to strict positional order', async () => {
        mockGetAiConfig.mockReturnValue(OPENAI_CONFIG);
        const posA = fakeVector(1536, 0.1);
        const posB = fakeVector(1536, 0.2);
        const posC = fakeVector(1536, 0.3);
        mockOpenAICreate.mockResolvedValue({
            data: [
                { embedding: posA, index: 0 },
                { embedding: posB, index: 1.5 }, // non-integer — poisons trust in ALL indices
                { embedding: posC, index: 2 },
            ],
            usage: { total_tokens: 9 },
        });

        const result = await generateVoyageEmbeddingsBatch(['a', 'b', 'c']);

        // Cardinality matches (3 entries for 3 texts), so the fallback places
        // by RESPONSE POSITION, not by the (partially untrustworthy) index
        // field — every entry is still validly shaped, so all three land.
        expect(result).toEqual([posA, posB, posC]);
    });

    it('direct-Voyage-path: a SHORT response (no index field at all) rejects the whole chunk', async () => {
        mockGetAiConfig.mockReturnValue(VOYAGE_CONFIG);
        const good0 = fakeVector(1024, 0.1);
        // 3 texts requested, only 1 entry returned.
        mockVoyageEmbed.mockResolvedValue({
            data: [{ embedding: good0 }],
            usage: { totalTokens: 3 },
        });

        const result = await generateVoyageEmbeddingsBatch(['a', 'b', 'c']);

        expect(result).toEqual([null, null, null]);
    });
});
