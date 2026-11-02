// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Task-scoped embedding HTTP fetch injection.
 *
 * Embedding generation (Voyage / OpenAI-compatible) runs deep inside
 * `EmbeddingOnlyGenerator` / `generateMusicEmbeddings`, several call layers
 * below the task `execute()`. Threading a rate-limited fetch through every
 * intermediate signature would be invasive, so the embedding tasks publish
 * the fetch into an AsyncLocalStorage scope for the duration of the run and
 * the SDK clients (`voyage.ts`, `openai.ts`) consult it when building their
 * HTTP client.
 *
 * When present, the ambient fetch is the task-system `ctx.dep('embeddings')`
 * fetch — so embedding API calls flow through the same per-dependency token
 * bucket (cross-replica via Valkey), circuit breaker, and Retry-After
 * handling as every other declared external dependency. The SSRF guard in
 * `ctx.dep().fetch()` also applies, closing the "misconfigured
 * embeddingBaseUrl points at a private IP" hole. This path DOES honour
 * `EMBEDDING_ALLOW_PRIVATE_URLS=true` (config.ts): the builtin embeddings
 * dependency (`tasks/builtin/native/embedding-dep.ts`) sets
 * `DepConfig.allowPrivateUrls` to a function that reads the flag fresh on
 * every call, and `RateLimiter.forDep` (`tasks/rate-limiter.ts`) consults it
 * per-fetch — falling back to the same same-origin-only redirect policy
 * (`fetchWithTimeout`, no public-IP check) the interactive path below uses
 * when opted in, instead of the public-only `safeFetch` guard. So a
 * self-hosted LAN `EMBEDDING_BASE_URL` works the same way on a bulk/backfill
 * task run as it does interactively.
 *
 * Outside a `runWithEmbeddingFetch(...)` scope — the interactive lyrics/
 * text-to-sound search defs, the assistant query path, dev scripts —
 * `getEmbeddingFetch()` returns `undefined`. The clients (`voyage.ts`) do
 * NOT fall back to an unguarded default fetch: they build their own guarded
 * fetch — `safeFetch` (public-only, same as the task path) by default, or
 * `fetchWithTimeout`'s same-origin-only redirect policy (no public-IP check)
 * when `EMBEDDING_ALLOW_PRIVATE_URLS=true` — so a custom `EMBEDDING_BASE_URL`
 * provider cannot redirect an interactive caller to an unrelated private
 * address either way (C21 fix-plan finding). That fallback has no rate
 * limiter or circuit breaker of its own — those live at the API-def
 * `rateLimit` field for the interactive defs instead.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Same shape the SDK clients accept for their `fetch` option and that
 * `ctx.dep(name).fetch` satisfies (`typeof fetch`).
 */
export type EmbeddingFetch = typeof fetch;

const storage = new AsyncLocalStorage<EmbeddingFetch>();

/**
 * Run `fn` with `fetch` published as the ambient embedding fetch. All
 * Voyage/OpenAI embedding HTTP issued synchronously or asynchronously
 * within `fn` routes through it.
 */
export function runWithEmbeddingFetch<T>(
    fetchImpl: EmbeddingFetch,
    fn: () => Promise<T>,
): Promise<T> {
    return storage.run(fetchImpl, fn);
}

/** The ambient embedding fetch, or `undefined` outside a task-run scope. */
export function getEmbeddingFetch(): EmbeddingFetch | undefined {
    return storage.getStore();
}
