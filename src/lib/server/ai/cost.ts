// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Model-aware cost estimation for OpenAI chat completions.
 *
 * Previously the assistant route hardcoded GPT-4o-mini rates
 * ($0.15/$0.60 per 1M tokens) regardless of the configured model, so cost
 * tracking silently broke whenever `OPENAI_CHAT_MODEL` changed (finding F14).
 * This centralizes pricing in one table, keyed by model-name prefix, with an
 * explicit documented fallback for unrecognised/local models.
 *
 * Prices are USD per 1,000,000 tokens and are approximate published OpenAI
 * list prices — update as pricing changes. They are used only for the
 * assistant's internal cost ledger, not billing.
 *
 * @module server/ai/cost
 */

export interface ModelPricing {
    /** USD per 1,000,000 input (prompt) tokens. */
    readonly inputPerMillion: number;
    /** USD per 1,000,000 output (completion) tokens. */
    readonly outputPerMillion: number;
}

/**
 * Pricing by model-name prefix, most-specific first (the first matching
 * prefix wins, so `gpt-4o-mini` must precede `gpt-4o`).
 */
const PRICING_TABLE: ReadonlyArray<{
    readonly prefix: string;
    readonly pricing: ModelPricing;
}> = [
    {
        prefix: 'gpt-4o-mini',
        pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
    },
    {
        prefix: 'gpt-4o',
        pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
    },
    {
        prefix: 'chatgpt-4o',
        pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
    },
    {
        prefix: 'gpt-4.1-nano',
        pricing: { inputPerMillion: 0.1, outputPerMillion: 0.4 },
    },
    {
        prefix: 'gpt-4.1-mini',
        pricing: { inputPerMillion: 0.4, outputPerMillion: 1.6 },
    },
    { prefix: 'gpt-4.1', pricing: { inputPerMillion: 2, outputPerMillion: 8 } },
    {
        prefix: 'gpt-4-turbo',
        pricing: { inputPerMillion: 10, outputPerMillion: 30 },
    },
    { prefix: 'gpt-4', pricing: { inputPerMillion: 30, outputPerMillion: 60 } },
    {
        prefix: 'gpt-3.5',
        pricing: { inputPerMillion: 0.5, outputPerMillion: 1.5 },
    },
    {
        prefix: 'gpt-5-nano',
        pricing: { inputPerMillion: 0.05, outputPerMillion: 0.4 },
    },
    {
        prefix: 'gpt-5-mini',
        pricing: { inputPerMillion: 0.25, outputPerMillion: 2 },
    },
    {
        prefix: 'gpt-5',
        pricing: { inputPerMillion: 1.25, outputPerMillion: 10 },
    },
    {
        prefix: 'o1-mini',
        pricing: { inputPerMillion: 1.1, outputPerMillion: 4.4 },
    },
    { prefix: 'o1', pricing: { inputPerMillion: 15, outputPerMillion: 60 } },
    {
        prefix: 'o3-mini',
        pricing: { inputPerMillion: 1.1, outputPerMillion: 4.4 },
    },
    { prefix: 'o3', pricing: { inputPerMillion: 2, outputPerMillion: 8 } },
    {
        prefix: 'o4-mini',
        pricing: { inputPerMillion: 1.1, outputPerMillion: 4.4 },
    },
    // Anthropic Claude (USD per 1M tokens, approximate list prices). Family
    // prefixes — most-specific first so 'claude-3-haiku' beats 'claude-haiku'.
    {
        prefix: 'claude-opus',
        pricing: { inputPerMillion: 5, outputPerMillion: 25 },
    },
    {
        prefix: 'claude-sonnet',
        pricing: { inputPerMillion: 3, outputPerMillion: 15 },
    },
    {
        prefix: 'claude-3-haiku',
        pricing: { inputPerMillion: 0.25, outputPerMillion: 1.25 },
    },
    {
        prefix: 'claude-haiku',
        pricing: { inputPerMillion: 1, outputPerMillion: 5 },
    },
    {
        prefix: 'claude-fable',
        pricing: { inputPerMillion: 10, outputPerMillion: 50 },
    },
];

/**
 * Resolve pricing for a model name, or `null` if unrecognised.
 *
 * Unknown models return `null` (NOT a guessed rate). A self-hoster running a
 * LOCAL/OSS chat model pays nothing, so fabricating a gpt-4o-mini ($0.15/$0.60)
 * figure for it would put phantom spend in the assistant cost ledger — a
 * trust-killer on the cost surface. Mirrors {@link embeddingPricePerMillion}'s
 * null-for-unknown contract. Callers treat null as "free / unpriced" → $0.
 */
export function getModelPricing(model: string): ModelPricing | null {
    const name = (model ?? '').trim().toLowerCase();
    if (!name) return null;
    for (const entry of PRICING_TABLE) {
        if (name.startsWith(entry.prefix)) return entry.pricing;
    }
    return null;
}

/**
 * Estimate the USD cost of a chat completion for the given model and token
 * usage. Model-aware; unknown/local models cost $0 (no fabricated spend).
 */
export function estimateChatCostUsd(
    model: string,
    inputTokens: number,
    outputTokens: number,
): number {
    const pricing = getModelPricing(model);
    if (!pricing) return 0;
    const input = Math.max(0, inputTokens) / 1_000_000;
    const output = Math.max(0, outputTokens) / 1_000_000;
    return input * pricing.inputPerMillion + output * pricing.outputPerMillion;
}

/**
 * Embedding pricing — USD per 1,000,000 tokens. Embeddings are single-rate
 * (no input/output split). Most-specific prefix first. Approximate published
 * OpenAI/Voyage list prices.
 *
 * Unknown models return `null` (NOT a guessed rate): a self-hoster running a
 * LOCAL embedding model pays nothing, so we must not fabricate a dollar figure.
 * Callers treat null as "free / unpriced" → $0.
 */
const EMBEDDING_PRICING_PER_MILLION: ReadonlyArray<{
    readonly prefix: string;
    readonly perMillion: number;
}> = [
    { prefix: 'text-embedding-3-small', perMillion: 0.02 },
    { prefix: 'text-embedding-3-large', perMillion: 0.13 },
    { prefix: 'text-embedding-ada', perMillion: 0.1 },
    { prefix: 'voyage-3-large', perMillion: 0.18 },
    { prefix: 'voyage-3-lite', perMillion: 0.02 },
    { prefix: 'voyage-3', perMillion: 0.06 },
    { prefix: 'voyage-2', perMillion: 0.1 },
    { prefix: 'voyage-code', perMillion: 0.18 },
    { prefix: 'voyage', perMillion: 0.12 },
];

/**
 * An operator-defined price override — see {@link parseCostPriceOverrides}.
 * `prefix` is already lowercased/trimmed; matching mirrors the built-in
 * tables (`name.startsWith(prefix)`).
 */
export interface CostPriceOverride {
    readonly prefix: string;
    readonly perMillion: number;
}

/**
 * Parse the `AI_COST_PRICE_OVERRIDES` setting into a sorted override list.
 *
 * Each entry has the shape `"model-prefix=usdPerMillionTokens"` (e.g.
 * `"text-embedding-3-small=0.02"`); the admin `array`-type setting already
 * splits on commas (see `toList` in `$lib/config/schema.js`), so this
 * function receives either a real `string[]` or a single already-split
 * entry. Malformed entries (no `=`, empty prefix, non-finite or negative
 * price) are silently dropped rather than throwing — a single bad entry
 * (e.g. a stray trailing comma) must not take down cost-page pricing for
 * every other model.
 *
 * Sorted longest-prefix-first so `parseCostPriceOverrides` behaves like the
 * built-in tables ("most-specific prefix wins") regardless of the order the
 * operator typed entries in — e.g. an override for `claude-3-haiku` must be
 * checked before a broader `claude` override.
 */
export function parseCostPriceOverrides(raw: unknown): CostPriceOverride[] {
    const entries: string[] = Array.isArray(raw)
        ? raw.map(String)
        : typeof raw === 'string'
          ? raw.split(',')
          : [];

    const out: CostPriceOverride[] = [];
    for (const entry of entries) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const eqIndex = trimmed.lastIndexOf('=');
        if (eqIndex <= 0 || eqIndex === trimmed.length - 1) continue;
        const prefix = trimmed.slice(0, eqIndex).trim().toLowerCase();
        const priceStr = trimmed.slice(eqIndex + 1).trim();
        const perMillion = Number(priceStr);
        if (!prefix || !Number.isFinite(perMillion) || perMillion < 0) continue;
        out.push({ prefix, perMillion });
    }
    return out.sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * USD per 1M tokens for an embedding model, or `null` if unrecognised
 * (local/free). `overrides` (from `AI_COST_PRICE_OVERRIDES`, see
 * {@link parseCostPriceOverrides}) are consulted FIRST — an operator-assigned
 * price always wins over the built-in table, so re-labelling a model that
 * later gains built-in support doesn't silently change a price the operator
 * already set deliberately.
 */
export function embeddingPricePerMillion(
    model: string,
    overrides: readonly CostPriceOverride[] = [],
): number | null {
    const name = (model ?? '').trim().toLowerCase();
    if (!name) return null;
    for (const o of overrides) {
        if (name.startsWith(o.prefix)) return o.perMillion;
    }
    for (const entry of EMBEDDING_PRICING_PER_MILLION) {
        if (name.startsWith(entry.prefix)) return entry.perMillion;
    }
    return null;
}

/**
 * Whether an embedding model's resolved price (if any) comes from an
 * operator override or the built-in table. `null` when the model is
 * unpriced by both. Used by the admin cost page to label the price source.
 */
export function embeddingPriceSource(
    model: string,
    overrides: readonly CostPriceOverride[] = [],
): 'custom' | 'built-in' | null {
    const name = (model ?? '').trim().toLowerCase();
    if (!name) return null;
    for (const o of overrides) {
        if (name.startsWith(o.prefix)) return 'custom';
    }
    for (const entry of EMBEDDING_PRICING_PER_MILLION) {
        if (name.startsWith(entry.prefix)) return 'built-in';
    }
    return null;
}

/**
 * Estimate USD cost of `tokens` embedding tokens for `model`. Unknown model
 * (and no matching override) → 0.
 */
export function estimateEmbeddingCostUsd(
    model: string,
    tokens: number,
    overrides: readonly CostPriceOverride[] = [],
): number {
    const per = embeddingPricePerMillion(model, overrides);
    if (per === null) return 0;
    return (Math.max(0, tokens) / 1_000_000) * per;
}
