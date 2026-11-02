// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared `externalDeps` declaration for the three embedding tasks
 * (library / discovery / music). All embed via the same Voyage / OpenAI
 * embedding endpoint, so they share one named dependency — `embeddings` —
 * whose `ctx.dep('embeddings').fetch` funnels through a per-dependency
 * token bucket (cross-replica via the Valkey shared bucket), circuit
 * breaker, and Retry-After handling. Routing all three through the SAME
 * dep name means their aggregate outbound rate is capped together rather
 * than each task getting an independent allowance that, summed, breaches
 * the provider tier.
 *
 * The fetch is published into `runWithEmbeddingFetch(...)` so the deep SDK
 * client construction in `ai/voyage.ts` picks it up; see
 * `ai/embedding-fetch-context.ts`.
 */

import { config } from '$lib/server/config.js';

/**
 * Embedding provider rate cap. Voyage's free tier is ~3 rps / 10k TPM and
 * OpenAI tiers vary; 3 rps is a conservative shared default that the
 * generators' internal batching (128 inputs/Voyage request, 100/OpenAI)
 * keeps comfortably under. Operators on a higher tier can raise it later
 * by promoting this to config.
 */
export const EMBEDDINGS_DEP: {
    name: string;
    rps?: number;
    retryAfter?: 'header' | number;
    circuitBreaker?: { failures: number; cooldownMs: number };
    allowPrivateUrls?: () => boolean;
} = {
    name: 'embeddings',
    rps: 3,
    retryAfter: 'header',
    circuitBreaker: { failures: 5, cooldownMs: 60_000 },
    // EMBEDDING_ALLOW_PRIVATE_URLS (final fix wave, 2026-09-13): the config
    // UI describes this flag as applying to "Embedding Base URL" generally,
    // but it previously only reached ai/voyage.ts's guardedDefaultFetch (the
    // INTERACTIVE embedding path — lyrics/text-to-sound search, the
    // assistant query path). This task-scoped ctx.dep('embeddings').fetch
    // path (used by the library/discovery/music embedding tasks) always
    // went through the public-only safeFetch with no opt-in, so a
    // self-hosted EMBEDDING_BASE_URL on a private network stayed
    // unreachable from a task run even with the flag enabled. Read live via
    // `RateLimiter.forDep`'s DepConfig.allowPrivateUrls — a function, not a
    // captured boolean, so a config change takes effect without a restart.
    allowPrivateUrls: () => config.EMBEDDING_ALLOW_PRIVATE_URLS === true,
};

/**
 * Whether an embedding provider the GENERATOR CAN ACTUALLY USE is configured.
 *
 * 🔴 Deliberately NOT `hasEmbeddingProvider()` from `config.ts`. That helper
 * backs the feature gate, and it answers a slightly
 * different question: it returns TRUE when `OPENAI_API_KEY` is set even if
 * `EMBEDDING_BASE_URL` is set WITHOUT its own `EMBEDDING_API_KEY`. The write
 * path does not agree — `generateTextEmbedding()` is gated on
 * `isVoyageAvailable()` (`ai/voyage.ts`), which for a custom base URL requires
 * `EMBEDDING_API_KEY` and never falls back to the OpenAI key. Guarding a stage
 * on the looser predicate would report "configured" while every embed call
 * returns `null`, which is precisely the wedge the guard exists to prevent
 * (same trap `mdblist-sync`'s guard comment records: check what the sync can
 * USE, not what an adjacent surface thinks is present).
 *
 * So this mirrors `isVoyageAvailable()`'s STRUCTURE, with `hasEmbeddingProvider()`'s
 * `.trim()` discipline: a whitespace-only key from a compose `stack.env` is not
 * a provider. That combination is the strictly safer side of both — the one
 * case it excludes and `isVoyageAvailable()` admits (a whitespace key) is
 * already an ERROR-severity finding in `validateEmbeddingConfig()`, and
 * treating it as unconfigured drains the stage cleanly instead of wedging it
 * behind 401s.
 *
 * Synchronous and dependency-free on purpose: it is called from
 * `coversStages[].eligibility.sql` / `terminalDisposition.excludes` builders,
 * which the sweep invokes on every tick and which cannot await. Importing
 * `isVoyageAvailable` directly would pull the `voyageai` + `openai` SDKs into
 * the orchestrator boot path, which is exactly why the embedding generator is
 * lazy-imported inside `execute()`.
 *
 * The admin "embeddings provider not configured" nudge (attention adapters)
 * uses this too, so it shows exactly while the stages are parked.
 *
 * Read live (config getters read `process.env` on every access, and
 * `config.service` mirrors on save), so adding a key is observed by the next
 * sweep tick with no restart.
 */
export function hasUsableEmbeddingProvider(): boolean {
    const set = (value: string): boolean => value.trim().length > 0;
    return (
        set(config.VOYAGE_API_KEY) ||
        (set(config.EMBEDDING_BASE_URL)
            ? set(config.EMBEDDING_API_KEY)
            : set(config.OPENAI_API_KEY))
    );
}
