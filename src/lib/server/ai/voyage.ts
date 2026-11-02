// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Embedding Integration
// Supports Voyage AI (default), OpenAI embeddings, or custom OpenAI-compatible endpoints

import { VoyageAIClient } from 'voyageai';
import OpenAI from 'openai';
import { Logger } from '../utils/logger';
import { getAiConfig } from '../config/domains/ai.js';
import {
    resolveEffectiveEmbedding,
    resolveEmbeddingModelName,
    type EmbeddingResolverInput,
} from './embedding-models.js';
import { getEmbeddingFetch } from './embedding-fetch-context.js';
import { safeFetch } from '../tasks/url-safety.js';
import { fetchWithTimeout } from '../utils/fetch-utils.js';
import {
    withExternalCallCounting,
    trackExternalCall,
} from '$lib/server/utils/external-request-counter.js';

const logger = Logger.for('Embeddings');

/**
 * SSRF-guarded fetch used to build the OpenAI/Voyage clients whenever no
 * task-scoped fetch (`getEmbeddingFetch()`) is active — i.e. every
 * interactive caller (the lyrics/text-to-sound search defs, the assistant
 * query path, dev scripts). Delegates to `safeFetch` (tasks/url-safety.ts),
 * the SAME per-hop-revalidating, DNS-rebinding-safe fetch the task-scoped
 * `ctx.dep('embeddings').fetch` uses (tasks/rate-limiter.ts) — so a custom
 * `EMBEDDING_BASE_URL` provider answering a 307 can no longer pivot an
 * interactive request to a private address the caller could not otherwise
 * reach (C21 fix-plan finding). It carries no rate limiter or circuit
 * breaker of its own; those live at the API-def `rateLimit` field for the
 * interactive defs instead.
 *
 * Normalises a `Request` input into (url, init) the same way
 * `RateLimiter.forDep` does, buffering the body so it can be replayed —
 * the OpenAI/Voyage SDKs are observed to call with a plain URL string, but
 * `typeof fetch` allows any of the three input shapes.
 */
const guardedDefaultFetch: typeof fetch = async (input, init) => {
    const urlStr =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    let effectiveInit: RequestInit;
    if (typeof Request !== 'undefined' && input instanceof Request) {
        const hasBody = input.method !== 'GET' && input.method !== 'HEAD';
        const bufferedBody = hasBody ? await input.clone().text() : undefined;
        effectiveInit = {
            method: input.method,
            headers: input.headers,
            ...(bufferedBody !== undefined ? { body: bufferedBody } : {}),
            ...init,
            signal: init?.signal === undefined ? input.signal : init.signal,
        };
    } else {
        effectiveInit = init ?? {};
    }

    // EMBEDDING_ALLOW_PRIVATE_URLS (default off, mirrors
    // LIVETV_ALLOW_PRIVATE_URLS): a self-hosted EMBEDDING_BASE_URL on a
    // trusted/LAN network is otherwise unreachable, since `safeFetch`'s SSRF
    // guard has no private-address opt-in of its own (unlike ssrf-guard.ts's
    // resolveSafePublicUrl) and unconditionally refuses a private-IP target.
    // When opted in, fall back to the same-origin-only redirect policy
    // (fetch-utils.ts `fetchWithTimeout` — no public-IP check) instead of the
    // public-only guard — the SAME trade-off the task-scoped `ctx.dep()` path
    // now makes too: `EMBEDDINGS_DEP`'s `allowPrivateUrls` (builtin/native/
    // embedding-dep.ts) reads this same config flag fresh on every call via
    // `DepConfig.allowPrivateUrls` (tasks/rate-limiter.ts), so a bulk/backfill
    // task run honours the opt-in exactly like this interactive path does.
    if (getAiConfig().embeddingAllowPrivateUrls) {
        return trackExternalCall(
            urlStr,
            () => fetchWithTimeout(urlStr, effectiveInit),
            effectiveInit.signal ?? null,
        );
    }
    return safeFetch(urlStr, effectiveInit);
};

/**
 * Validate a raw embedding response: the right length for the effective
 * configured dimension, and every entry a finite number. A malformed vector
 * (wrong length, `null`/`NaN`/`Infinity` slots — the JSON shapes a
 * misbehaving or compromised custom `EMBEDDING_BASE_URL` provider can
 * return) must never reach a caller that binds it straight into a pgvector
 * query (C21 fix-plan finding) — reject the whole vector instead.
 */
function isValidEmbedding(embedding: unknown, expectedDimension: number): embedding is number[] {
    if (!Array.isArray(embedding)) return false;
    if (embedding.length !== expectedDimension) return false;
    return embedding.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Places validated embeddings from ONE provider batch response into an
 * array whose size and order match the REQUEST (`batchSize`) — never the
 * response's own size or order.
 *
 * Threat model: an attacker-controlled `EMBEDDING_BASE_URL` provider can
 * return a `data` array with the WRONG cardinality (short or long), a
 * duplicate `index`, an out-of-range `index`, or omit `index` altogether.
 * Sorting by `index` and then pushing in that order (the previous
 * implementation) only reorders — it never checks that the response has
 * exactly one entry per requested text, so any of the above silently
 * shifts every later entry into the wrong slot. Because the caller
 * accumulates chunks across an outer loop, ONE short/malformed chunk
 * misaligns every chunk after it too — a multi-thousand-item backfill
 * would then persist vectors against the wrong media rows.
 *
 * Strategy:
 *  - If EVERY item in the response carries a valid integer `index` in
 *    `[0, batchSize)` with no duplicates, place each embedding at that
 *    exact index. An out-of-range or duplicate index is rejected (logged,
 *    slot stays `null`) rather than guessed; for a duplicate, the first
 *    writer for that index wins and the later one is dropped.
 *  - Otherwise (any item's `index` is missing or not an integer) there is
 *    no trustworthy per-item field to map response entries back to
 *    request entries — falling back to response order per-item would let
 *    an attacker pick and choose which entries get index-based placement.
 *    Fall back to strict positional mapping ONLY when the response has
 *    EXACTLY one entry per requested text (`data.length === batchSize`);
 *    any other shape rejects the WHOLE chunk (every slot stays `null`)
 *    rather than invent a mapping past the end of the batch.
 */
function placeBatchEmbeddings(
    data: ReadonlyArray<{ index?: number; embedding?: unknown }>,
    batchSize: number,
    expectedDimension: number,
    label: string,
): (number[] | null)[] {
    const out: (number[] | null)[] = new Array(batchSize).fill(null);

    const place = (index: number, embedding: unknown, context: Record<string, unknown>): void => {
        if (embedding && isValidEmbedding(embedding, expectedDimension)) {
            out[index] = embedding;
            if (cachedDimension === null) {
                cachedDimension = embedding.length;
                logger.info('Detected embedding dimension', { dimension: cachedDimension });
            }
        } else {
            logger.warn(`${label}: entry failed validation`, {
                ...context,
                got: Array.isArray(embedding) ? embedding.length : typeof embedding,
                expected: expectedDimension,
            });
        }
    };

    const allIndexed = data.length > 0 && data.every((item) => Number.isInteger(item.index));

    if (allIndexed) {
        for (const item of data) {
            const index = item.index as number;
            if (index < 0 || index >= batchSize) {
                logger.warn(`${label}: entry index out of range — rejected`, { index, batchSize });
                continue;
            }
            if (out[index] !== null) {
                logger.warn(`${label}: duplicate index — rejected`, { index });
                continue;
            }
            place(index, item.embedding, { index });
        }
        return out;
    }

    if (data.length !== batchSize) {
        logger.warn(
            `${label}: response cardinality does not match the request and entries carry no usable index — rejecting the whole batch rather than guessing the mapping`,
            { got: data.length, expected: batchSize },
        );
        return out;
    }

    data.forEach((item, position) => {
        place(position, item.embedding, { position });
    });
    return out;
}

/** Adapt the AI config domain to the provider-agnostic embedding resolver. */
function embeddingResolverInput(): EmbeddingResolverInput {
    const ai = getAiConfig();
    return {
        embeddingModel: ai.embeddingModel,
        embeddingDimensions: ai.embeddingDimensions,
        embeddingBaseUrl: ai.embeddingBaseUrl,
        embeddingApiKey: ai.embeddingApiKey,
        voyageApiKey: ai.voyageApiKey,
        openaiApiKey: ai.openaiApiKey,
    };
}

const EMBEDDING_TIMEOUT_MS = 30_000; // 30s timeout per API call

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

// Default dimension kept for the back-compat re-export below.
const DEFAULT_VOYAGE_DIMENSION = 1024; // voyage-3-large

// First output dimension observed from a live embedding response — used only to
// log the detected width once (the configured width comes from the resolver).
let cachedDimension: number | null = null;

/**
 * Get the embedding dimension based on configuration.
 * Priority: EMBEDDING_DIMENSIONS > model default > provider default.
 * Delegates to the shared resolver so this matches the `vector(N)` column width
 * picked by the migration DDL (base-schema.ts) — a divergence here is exactly
 * what produced the silent 1024-vs-1536 mismatch.
 */
export function getEmbeddingDimension(): number {
    return resolveEffectiveEmbedding(embeddingResolverInput()).dimensions;
}

// For backward compatibility
export const VOYAGE_EMBEDDING_DIMENSION = DEFAULT_VOYAGE_DIMENSION;

// Get the embedding model name (shared resolver — config or provider default).
function getEmbeddingModel(): string {
    return resolveEmbeddingModelName(embeddingResolverInput()).model;
}

// Cached per credentials: a saved key or endpoint change builds a new client
// instead of the first one living until a restart.
let voyageClient: { key: string; client: VoyageAIClient } | null = null;
let openaiEmbeddingClient: { key: string; client: OpenAI } | null = null;

/**
 * Check if using custom OpenAI-compatible embedding endpoint
 */
function useCustomEmbeddings(): boolean {
    const ai = getAiConfig();
    return !!((ai.embeddingBaseUrl && ai.embeddingApiKey) || (!ai.voyageApiKey && ai.openaiApiKey));
}

/**
 * Initialize OpenAI client for embeddings (custom endpoint or OpenAI)
 */
function getOpenAIEmbeddingClient(): OpenAI | null {
    const ai = getAiConfig();
    const apiKey = ai.embeddingBaseUrl ? ai.embeddingApiKey : ai.openaiApiKey;
    if (!apiKey) {
        logger.warn(
            ai.embeddingBaseUrl
                ? 'EMBEDDING_API_KEY not set - custom embeddings disabled'
                : 'OPENAI_API_KEY not set - OpenAI embeddings disabled',
        );
        return null;
    }

    // When a task-scoped rate-limited fetch is active (`ctx.dep('embeddings')`),
    // build a fresh client bound to it — the cached singleton uses the default
    // fetch and would bypass the per-dependency rate limiter / SSRF guard. The
    // fetch is run-scoped, so caching it would leak one run's limiter into the
    // next.
    const embeddingFetch = getEmbeddingFetch();

    if (embeddingFetch) {
        try {
            const options: {
                apiKey: string;
                baseURL?: string;
                fetch: typeof fetch;
            } = {
                apiKey,
                fetch: withExternalCallCounting(embeddingFetch, 'openai'),
            };
            if (ai.embeddingBaseUrl) {
                options.baseURL = ai.embeddingBaseUrl;
            }
            return new OpenAI(options);
        } catch (error) {
            logger.warn('OpenAI embedding client initialization failed', {}, error as Error);
            return null;
        }
    }

    const cacheKey = `${apiKey}|${ai.embeddingBaseUrl ?? ''}`;
    if (openaiEmbeddingClient?.key !== cacheKey) {
        try {
            // No task-scoped fetch active — fall back to the SSRF-guarded
            // default rather than the SDK's raw global fetch (C21 fix-plan
            // finding). Safe to cache: unlike the task-scoped fetch above,
            // this is a stable module-level function, not run-scoped.
            const options: { apiKey: string; baseURL?: string; fetch: typeof fetch } = {
                apiKey,
                fetch: withExternalCallCounting(guardedDefaultFetch, 'openai'),
            };
            if (ai.embeddingBaseUrl) {
                options.baseURL = ai.embeddingBaseUrl;
            }
            openaiEmbeddingClient = { key: cacheKey, client: new OpenAI(options) };
            logger.info('Initialized OpenAI embedding client', {
                baseURL: ai.embeddingBaseUrl || 'default',
                model: getEmbeddingModel(),
            });
        } catch (error) {
            logger.warn('OpenAI embedding client initialization failed', {}, error as Error);
            return null;
        }
    }

    return openaiEmbeddingClient.client;
}

/**
 * Initialize Voyage AI client with graceful fallback
 */
function getVoyageClient(): VoyageAIClient | null {
    const ai = getAiConfig();
    if (!ai.voyageApiKey) {
        return null;
    }

    // See getOpenAIEmbeddingClient: a task-scoped fetch must not be cached.
    const embeddingFetch = getEmbeddingFetch();
    if (embeddingFetch) {
        try {
            // voyageai ≥0.4 accepts a standard fetch, so the task-scoped fetch (rate
            // limiter + SSRF guard) wraps the real outbound request directly.
            return new VoyageAIClient({
                apiKey: ai.voyageApiKey,
                fetch: withExternalCallCounting(embeddingFetch, 'voyage'),
            });
        } catch (error) {
            logger.warn('Voyage AI initialization failed', {}, error as Error);
            return null;
        }
    }

    if (voyageClient?.key !== ai.voyageApiKey) {
        try {
            // See getOpenAIEmbeddingClient — same guarded-default-fetch fallback,
            // safe to cache since guardedDefaultFetch is not run-scoped.
            voyageClient = {
                key: ai.voyageApiKey,
                client: new VoyageAIClient({
                    apiKey: ai.voyageApiKey,
                    fetch: withExternalCallCounting(guardedDefaultFetch, 'voyage'),
                }),
            };
        } catch (error) {
            logger.warn('Voyage AI initialization failed', {}, error as Error);
            return null;
        }
    }

    return voyageClient.client;
}

/**
 * Generate embedding using OpenAI-compatible API
 */
async function generateOpenAIEmbedding(
    text: string,
    onTokens?: (tokens: number) => void,
): Promise<number[] | null> {
    const client = getOpenAIEmbeddingClient();
    if (!client) return null;

    try {
        const model = getEmbeddingModel();
        const response = await withTimeout(
            client.embeddings.create({ model, input: text }),
            EMBEDDING_TIMEOUT_MS,
            'OpenAI embedding',
        );

        onTokens?.(response.usage?.total_tokens ?? 0);

        if (response.data && response.data.length > 0) {
            const embedding = response.data[0].embedding;
            if (!embedding) return null;
            const expectedDimension = getEmbeddingDimension();
            const gotLength = embedding.length;
            if (!isValidEmbedding(embedding, expectedDimension)) {
                logger.warn('OpenAI embedding response failed validation', {
                    got: gotLength,
                    expected: expectedDimension,
                });
                return null;
            }
            // Update cached dimension only from a validated vector — a
            // malformed response must never poison it (item 7 fix).
            if (cachedDimension === null) {
                cachedDimension = embedding.length;
                logger.info('Detected embedding dimension', {
                    dimension: cachedDimension,
                    model,
                });
            }
            return embedding;
        }

        return null;
    } catch (error) {
        logger.warn('Failed to generate OpenAI embedding', {}, error as Error);
        return null;
    }
}

/**
 * Generate embeddings batch using OpenAI-compatible API
 */
async function generateOpenAIEmbeddingsBatch(
    texts: string[],
    onTokens?: (tokens: number) => void,
): Promise<(number[] | null)[]> {
    const client = getOpenAIEmbeddingClient();
    if (!client) return texts.map(() => null);

    try {
        const model = getEmbeddingModel();
        // OpenAI supports up to 2048 inputs per request, but we use smaller batches
        const batchSize = 100;
        const results: (number[] | null)[] = [];

        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize);

            const response = await withTimeout(
                client.embeddings.create({ model, input: batch }),
                EMBEDDING_TIMEOUT_MS * 2,
                'OpenAI batch embedding',
            );

            onTokens?.(response.usage?.total_tokens ?? 0);

            // placeBatchEmbeddings PLACES by index (or rejects the whole
            // chunk when no index is usable) rather than sorting-then-pushing
            // — a wrong-cardinality or duplicate/out-of-range-index response
            // from a hostile provider can no longer mis-associate a vector
            // with the wrong text (item 7 / C-1 fix). Always returns exactly
            // `batch.length` entries, so pushing per-chunk keeps every later
            // chunk's alignment intact regardless of what this one returned.
            const expectedDimension = getEmbeddingDimension();
            const placed = response.data
                ? placeBatchEmbeddings(
                      response.data,
                      batch.length,
                      expectedDimension,
                      'OpenAI batch embedding',
                  )
                : new Array<number[] | null>(batch.length).fill(null);
            results.push(...placed);
        }

        return results;
    } catch (error) {
        logger.warn('Failed to generate OpenAI embeddings batch', {}, error as Error);
        return texts.map(() => null);
    }
}

/**
 * Generate embedding for text
 * Uses configured provider (Voyage AI, OpenAI, or custom endpoint)
 */
export async function generateVoyageEmbedding(
    text: string,
    onTokens?: (tokens: number) => void,
): Promise<number[] | null> {
    // Check if we should use OpenAI-compatible endpoint
    if (useCustomEmbeddings()) {
        return generateOpenAIEmbedding(text, onTokens);
    }

    // Use Voyage AI
    const client = getVoyageClient();
    if (!client) {
        // Fallback to OpenAI if Voyage not available
        return generateOpenAIEmbedding(text, onTokens);
    }

    try {
        const model = getAiConfig().embeddingModel || 'voyage-3-large';
        const response = await withTimeout(
            client.embed({ input: text, model, inputType: 'document' }),
            EMBEDDING_TIMEOUT_MS,
            'Voyage embedding',
        );

        onTokens?.(response.usage?.totalTokens ?? 0);

        if (response.data && response.data.length > 0) {
            const embedding = response.data[0].embedding;
            if (!embedding) return null;
            const expectedDimension = getEmbeddingDimension();
            const gotLength = embedding.length;
            if (!isValidEmbedding(embedding, expectedDimension)) {
                logger.warn('Voyage embedding response failed validation', {
                    got: gotLength,
                    expected: expectedDimension,
                });
                return null;
            }
            return embedding;
        }

        return null;
    } catch (error) {
        logger.warn('Failed to generate Voyage embedding', {}, error as Error);
        return null;
    }
}

/**
 * Generate embedding for search query
 * Uses 'query' input type for Voyage AI (better search performance)
 */
export async function generateVoyageQueryEmbedding(query: string): Promise<number[] | null> {
    // Check if we should use OpenAI-compatible endpoint
    if (useCustomEmbeddings()) {
        return generateOpenAIEmbedding(query);
    }

    // Use Voyage AI
    const client = getVoyageClient();
    if (!client) {
        return generateOpenAIEmbedding(query);
    }

    try {
        const model = getAiConfig().embeddingModel || 'voyage-3-large';
        const response = await withTimeout(
            client.embed({ input: query, model, inputType: 'query' }),
            EMBEDDING_TIMEOUT_MS,
            'Voyage query embedding',
        );

        if (response.data && response.data.length > 0) {
            const embedding = response.data[0].embedding;
            if (!embedding) return null;
            const expectedDimension = getEmbeddingDimension();
            const gotLength = embedding.length;
            if (!isValidEmbedding(embedding, expectedDimension)) {
                logger.warn('Voyage query embedding response failed validation', {
                    got: gotLength,
                    expected: expectedDimension,
                });
                return null;
            }
            return embedding;
        }

        return null;
    } catch (error) {
        logger.warn('Failed to generate Voyage query embedding', {}, error as Error);
        return null;
    }
}

/**
 * Generate embeddings for multiple texts in batch
 * More efficient than calling one at a time
 */
export async function generateVoyageEmbeddingsBatch(
    texts: string[],
    inputType: 'document' | 'query' = 'document',
    onTokens?: (tokens: number) => void,
): Promise<(number[] | null)[]> {
    // Check if we should use OpenAI-compatible endpoint
    if (useCustomEmbeddings()) {
        return generateOpenAIEmbeddingsBatch(texts, onTokens);
    }

    // Use Voyage AI
    const client = getVoyageClient();
    if (!client) {
        return generateOpenAIEmbeddingsBatch(texts, onTokens);
    }

    try {
        const model = getAiConfig().embeddingModel || 'voyage-3-large';
        // Voyage AI supports up to 128 texts per batch
        const batchSize = 128;
        const results: (number[] | null)[] = [];

        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize);

            const response = await withTimeout(
                client.embed({ input: batch, model, inputType }),
                EMBEDDING_TIMEOUT_MS * 2,
                'Voyage batch embedding',
            );

            onTokens?.(response.usage?.totalTokens ?? 0);

            // placeBatchEmbeddings PLACES by index (or rejects the whole
            // chunk when no index is usable) rather than pushing in response
            // order — a wrong-cardinality or duplicate/out-of-range-index
            // response from a hostile provider can no longer mis-associate a
            // vector with the wrong text (item 7 / C-1 fix). Always returns
            // exactly `batch.length` entries, so pushing per-chunk keeps
            // every later chunk's alignment intact regardless of what this
            // one returned.
            const expectedDimension = getEmbeddingDimension();
            const placed = response.data
                ? placeBatchEmbeddings(
                      response.data,
                      batch.length,
                      expectedDimension,
                      'Voyage batch embedding',
                  )
                : new Array<number[] | null>(batch.length).fill(null);
            results.push(...placed);
        }

        return results;
    } catch (error) {
        logger.warn('Failed to generate Voyage embeddings batch', {}, error as Error);
        return texts.map(() => null);
    }
}

/**
 * Test embedding connectivity
 */
export async function testVoyageConnection(): Promise<boolean> {
    // Test custom endpoint if configured
    if (useCustomEmbeddings()) {
        const client = getOpenAIEmbeddingClient();
        if (!client) return false;

        try {
            const response = await client.embeddings.create({
                model: getEmbeddingModel(),
                input: 'test connection',
            });
            return (
                response.data !== undefined && response.data !== null && response.data.length > 0
            );
        } catch (error) {
            logger.warn('Embedding connection test failed', {}, error as Error);
            return false;
        }
    }

    // Test Voyage AI
    const client = getVoyageClient();
    if (!client) return false;

    try {
        const model = getAiConfig().embeddingModel || 'voyage-3-large';
        const response = await client.embed({
            input: 'test connection',
            model,
            inputType: 'document',
        });
        return response.data !== undefined && response.data !== null && response.data.length > 0;
    } catch (error) {
        logger.warn('Voyage AI connection test failed', {}, error as Error);
        return false;
    }
}

/**
 * Check if embedding generation is available
 */
export function isVoyageAvailable(): boolean {
    const ai = getAiConfig();
    return !!(ai.voyageApiKey || (ai.embeddingBaseUrl ? ai.embeddingApiKey : ai.openaiApiKey));
}

/**
 * Get embedding provider info for debugging/display
 */
export function getEmbeddingProviderInfo(): {
    provider: string;
    model: string;
    dimensions: number;
} {
    const ai = getAiConfig();
    let provider = 'none';
    if (ai.embeddingBaseUrl && ai.embeddingApiKey) {
        provider = 'custom';
    } else if (ai.voyageApiKey) {
        provider = 'voyage';
    } else if (ai.openaiApiKey) {
        provider = 'openai';
    }

    return {
        provider,
        model: getEmbeddingModel(),
        dimensions: getEmbeddingDimension(),
    };
}
