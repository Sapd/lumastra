// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Single source of truth for embedding model → output-dimension rules, plus a
// pure resolver that BOTH the runtime embedder (voyage.ts) and the migration
// DDL (base-schema.ts) use to pick the `vector(N)` column width.
//
// Why this exists: `EMBEDDING_DIMENSIONS` was never validated against the
// configured model. Setting it to an OpenAI-style 1536 with the default Voyage
// `voyage-3-large` (which only emits 256/512/1024/2048) created 1536-wide
// columns while the query embedding returned 1024 → `/api/assistant` 500s with
// "expected 1536 dimensions, not 1024", and library embeddings silently wrote
// nothing. A fresh OSS install with a mismatched value is silently broken.
//
// This module deliberately has NO imports from the config system so it stays
// usable from the migration runner (which reads `process.env` directly, before
// the config singletons are wired) and from a standalone CLI.
//
// Dimension data verified against provider docs on 2026-06-03:
//   - Voyage embeddings API (`output_dimension`): voyage-3-large / voyage-3.5 /
//     voyage-3.5-lite / voyage-code-3 / voyage-context-3 support
//     {256, 512, 1024 (default), 2048}; older voyage-3 / voyage-2 /
//     voyage-finance-2 / voyage-law-2 emit a single fixed 1024.
//   - OpenAI embeddings API (`dimensions` param): text-embedding-3-small
//     (default 1536) and text-embedding-3-large (default 3072) support any
//     dimension in 1..default via truncation; text-embedding-ada-002 is fixed
//     at 1536.

export type EmbeddingProvider = 'voyage' | 'openai';

/** How a model's output dimension may be customised. */
export type DimensionRule =
    /** Only `defaultDimension` is valid (no custom output dimension). */
    | { readonly kind: 'fixed' }
    /** Matryoshka models — the dimension must be one of these exact values. */
    | { readonly kind: 'oneOf'; readonly values: readonly number[] }
    /** OpenAI v3 — any integer in 1..max is valid (truncation). */
    | { readonly kind: 'range'; readonly max: number };

export interface EmbeddingModelSpec {
    readonly model: string;
    readonly provider: EmbeddingProvider;
    /** Output dimension used when none is explicitly configured. */
    readonly defaultDimension: number;
    readonly dimensions: DimensionRule;
}

export const DEFAULT_VOYAGE_MODEL = 'voyage-3-large';
export const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small';
export const DEFAULT_VOYAGE_DIMENSION = 1024;
export const DEFAULT_OPENAI_DIMENSION = 1536;

const VOYAGE_MATRYOSHKA: DimensionRule = {
    kind: 'oneOf',
    values: [256, 512, 1024, 2048],
};

function voyageMatryoshka(model: string): EmbeddingModelSpec {
    return {
        model,
        provider: 'voyage',
        defaultDimension: 1024,
        dimensions: VOYAGE_MATRYOSHKA,
    };
}
function voyageFixed(model: string, dim = 1024): EmbeddingModelSpec {
    return {
        model,
        provider: 'voyage',
        defaultDimension: dim,
        dimensions: { kind: 'fixed' },
    };
}

export const EMBEDDING_MODELS: Readonly<Record<string, EmbeddingModelSpec>> = {
    // Voyage — Matryoshka (flexible output dimension)
    'voyage-3-large': voyageMatryoshka('voyage-3-large'),
    'voyage-3.5': voyageMatryoshka('voyage-3.5'),
    'voyage-3.5-lite': voyageMatryoshka('voyage-3.5-lite'),
    'voyage-code-3': voyageMatryoshka('voyage-code-3'),
    'voyage-context-3': voyageMatryoshka('voyage-context-3'),
    // Voyage — single fixed dimension
    'voyage-3': voyageFixed('voyage-3'),
    'voyage-2': voyageFixed('voyage-2'),
    'voyage-finance-2': voyageFixed('voyage-finance-2'),
    'voyage-law-2': voyageFixed('voyage-law-2'),
    // OpenAI
    'text-embedding-3-small': {
        model: 'text-embedding-3-small',
        provider: 'openai',
        defaultDimension: 1536,
        dimensions: { kind: 'range', max: 1536 },
    },
    'text-embedding-3-large': {
        model: 'text-embedding-3-large',
        provider: 'openai',
        defaultDimension: 3072,
        dimensions: { kind: 'range', max: 3072 },
    },
    'text-embedding-ada-002': {
        model: 'text-embedding-ada-002',
        provider: 'openai',
        defaultDimension: 1536,
        dimensions: { kind: 'fixed' },
    },
};

/**
 * Normalised inputs the resolver needs — caller-agnostic so it works from the
 * config domain (`getAiConfig()`), `process.env`, or a test fixture. All fields
 * optional; missing/empty are treated as unset.
 */
export interface EmbeddingResolverInput {
    /** EMBEDDING_MODEL */
    readonly embeddingModel?: string;
    /** EMBEDDING_DIMENSIONS (0 or undefined = unset) */
    readonly embeddingDimensions?: number;
    /** EMBEDDING_BASE_URL — presence implies a custom OpenAI-compatible endpoint */
    readonly embeddingBaseUrl?: string;
    /** EMBEDDING_API_KEY — required for a custom OpenAI-compatible endpoint */
    readonly embeddingApiKey?: string;
    /** VOYAGE_API_KEY */
    readonly voyageApiKey?: string;
    /** OPENAI_API_KEY */
    readonly openaiApiKey?: string;
}

export interface ResolvedEmbedding {
    readonly provider: EmbeddingProvider;
    readonly model: string;
    /** The model's known spec, or `null` for an unknown/custom model. */
    readonly spec: EmbeddingModelSpec | null;
    /** Effective output dimension after applying config + model/provider defaults. */
    readonly dimensions: number;
    readonly dimensionSource: 'config' | 'model-default' | 'provider-default';
    readonly modelSource: 'config' | 'provider-default';
    /** True when no embedding provider is configured at all. */
    readonly hasProvider: boolean;
}

function trimmed(value: string | undefined): string {
    return (value ?? '').trim();
}

/**
 * True when the effective provider is OpenAI (or an OpenAI-compatible custom
 * endpoint): an explicit base URL, or an OpenAI key with no Voyage key. Mirrors
 * the legacy logic in voyage.ts so behaviour is unchanged.
 */
function prefersOpenAi(input: EmbeddingResolverInput): boolean {
    const baseUrl = trimmed(input.embeddingBaseUrl);
    const embeddingKey = trimmed(input.embeddingApiKey);
    const voyage = trimmed(input.voyageApiKey);
    const openai = trimmed(input.openaiApiKey);
    return (!!baseUrl && !!embeddingKey) || (!voyage && !!openai);
}

/** Resolve the effective model name from config or provider defaults. */
export function resolveEmbeddingModelName(input: EmbeddingResolverInput): {
    model: string;
    source: 'config' | 'provider-default';
} {
    const explicit = trimmed(input.embeddingModel);
    if (explicit) return { model: explicit, source: 'config' };
    return {
        model: prefersOpenAi(input) ? DEFAULT_OPENAI_MODEL : DEFAULT_VOYAGE_MODEL,
        source: 'provider-default',
    };
}

/**
 * Resolve the effective embedding model + output dimension. Pure — no I/O, no
 * caching, no config-system dependency. `dimensions` follows the existing
 * precedence: explicit EMBEDDING_DIMENSIONS > model default > provider default.
 * Note this does NOT silently "fix" a mismatch — it reports what the config
 * asks for, and `validateEmbeddingConfig` is what flags an invalid combination.
 */
export function resolveEffectiveEmbedding(input: EmbeddingResolverInput): ResolvedEmbedding {
    const { model, source: modelSource } = resolveEmbeddingModelName(input);
    const spec = EMBEDDING_MODELS[model] ?? null;
    const provider: EmbeddingProvider =
        spec?.provider ?? (prefersOpenAi(input) ? 'openai' : 'voyage');
    const hasProvider = !!(
        (trimmed(input.embeddingBaseUrl) && trimmed(input.embeddingApiKey)) ||
        trimmed(input.voyageApiKey) ||
        trimmed(input.openaiApiKey)
    );

    const configured =
        typeof input.embeddingDimensions === 'number' &&
        Number.isFinite(input.embeddingDimensions) &&
        input.embeddingDimensions > 0
            ? Math.trunc(input.embeddingDimensions)
            : 0;

    let dimensions: number;
    let dimensionSource: ResolvedEmbedding['dimensionSource'];
    if (configured > 0) {
        dimensions = configured;
        dimensionSource = 'config';
    } else if (spec) {
        dimensions = spec.defaultDimension;
        dimensionSource = 'model-default';
    } else {
        dimensions = provider === 'openai' ? DEFAULT_OPENAI_DIMENSION : DEFAULT_VOYAGE_DIMENSION;
        dimensionSource = 'provider-default';
    }

    return {
        provider,
        model,
        spec,
        dimensions,
        dimensionSource,
        modelSource,
        hasProvider,
    };
}

export interface EmbeddingConfigIssue {
    readonly severity: 'error' | 'warning';
    readonly code: string;
    readonly message: string;
    readonly remediation?: string;
}

/** Describe the dimensions a known model accepts, for error messages. */
function describeAllowed(spec: EmbeddingModelSpec): string {
    switch (spec.dimensions.kind) {
        case 'fixed':
            return `${spec.defaultDimension} (fixed)`;
        case 'oneOf':
            return spec.dimensions.values.join(', ');
        case 'range':
            return `1–${spec.dimensions.max}`;
    }
}

function dimensionAllowed(spec: EmbeddingModelSpec, dim: number): boolean {
    switch (spec.dimensions.kind) {
        case 'fixed':
            return dim === spec.defaultDimension;
        case 'oneOf':
            return spec.dimensions.values.includes(dim);
        case 'range':
            return dim >= 1 && dim <= spec.dimensions.max;
    }
}

/**
 * Validate the embedding configuration against the resolved model. Returns the
 * empty array when everything is consistent. This is the check that would have
 * caught the EMBEDDING_DIMENSIONS=1536 + voyage-3-large mismatch at boot.
 */
export function validateEmbeddingConfig(input: EmbeddingResolverInput): EmbeddingConfigIssue[] {
    const issues: EmbeddingConfigIssue[] = [];
    const resolved = resolveEffectiveEmbedding(input);
    const missingCustomKey = !!trimmed(input.embeddingBaseUrl) && !trimmed(input.embeddingApiKey);

    if (missingCustomKey) {
        issues.push({
            severity: 'error',
            code: 'embedding.custom-key-missing',
            message:
                'EMBEDDING_BASE_URL is set but EMBEDDING_API_KEY is missing. Custom embedding endpoints use their own key and do not fall back to OPENAI_API_KEY.',
            remediation:
                'Set EMBEDDING_API_KEY for the custom endpoint, or clear EMBEDDING_BASE_URL to use Voyage/OpenAI embeddings.',
        });
    }

    if (!resolved.hasProvider && !missingCustomKey) {
        issues.push({
            severity: 'warning',
            code: 'embedding.no-provider',
            message:
                'No embedding provider configured — AI recommendations, RAG chat, and similarity search are disabled.',
            remediation:
                'Set VOYAGE_API_KEY (recommended), set OPENAI_API_KEY, or set EMBEDDING_BASE_URL plus EMBEDDING_API_KEY for an OpenAI-compatible endpoint.',
        });
        return issues;
    }

    const explicit =
        typeof input.embeddingDimensions === 'number' &&
        Number.isFinite(input.embeddingDimensions) &&
        input.embeddingDimensions > 0
            ? Math.trunc(input.embeddingDimensions)
            : 0;

    if (!resolved.spec) {
        // Unknown/custom model — we can't validate its width.
        if (explicit <= 0) {
            issues.push({
                severity: 'warning',
                code: 'embedding.unknown-model',
                message: `Unknown embedding model "${resolved.model}" — cannot verify its output dimension; assuming the ${resolved.provider} default of ${resolved.dimensions}.`,
                remediation:
                    'Set EMBEDDING_DIMENSIONS to the dimension your model actually emits so the vector columns match.',
            });
        }
        return issues;
    }

    if (explicit > 0 && !dimensionAllowed(resolved.spec, explicit)) {
        issues.push({
            severity: 'error',
            code: 'embedding.dimension-mismatch',
            message: `EMBEDDING_DIMENSIONS=${explicit} is not valid for model "${resolved.model}" (which emits ${describeAllowed(resolved.spec)}). The vector columns would be ${explicit}-wide but the model returns ${resolved.spec.defaultDimension}, so embedding writes fail and /api/assistant returns 500.`,
            remediation: `Set EMBEDDING_DIMENSIONS to one of: ${describeAllowed(resolved.spec)} (default ${resolved.spec.defaultDimension}), or unset it to use the model default.`,
        });
    }

    return issues;
}

/**
 * Compare the configured embedding dimension against the actual width of an
 * existing `vector(N)` column (e.g. `media_embeddings.embedding`).
 *
 * This is the gap `validateEmbeddingConfig` cannot see: an operator can switch
 * from Voyage (1024) to OpenAI (1536) with a perfectly *internally* consistent
 * config (valid model + valid EMBEDDING_DIMENSIONS), yet the pre-existing vector
 * column is still `vector(1024)`. The base schema only stamps the column width
 * at *fresh install* time; nothing migrates it when the provider later changes.
 * Without this guard the mismatch surfaces only at first insert as a cryptic
 * pgvector error ("expected 1536 dimensions, not 1024") and every embedding
 * write silently fails.
 *
 * Pure — the caller supplies both numbers (the configured dimension and the
 * dimension read from the DB), so this stays usable from the migration runner,
 * the CLI doctor, and the health endpoint alike.
 *
 * @param configuredDimension Effective dimension the embedder will produce.
 * @param columnDimension Actual `vector(N)` width of the embedding column, or
 *   `null` when the column/table does not exist yet (fresh install pre-migration).
 */
export function checkEmbeddingColumnDimension(
    configuredDimension: number,
    columnDimension: number | null,
): EmbeddingConfigIssue[] {
    if (columnDimension == null || columnDimension <= 0) {
        // No column yet (fresh install) — the base schema will create it at the
        // configured width. Nothing to compare.
        return [];
    }
    if (configuredDimension === columnDimension) return [];
    return [
        {
            severity: 'error',
            code: 'embedding.column-dimension-mismatch',
            message: `The configured embedding dimension (${configuredDimension}) does not match the existing media_embeddings.embedding column width (vector(${columnDimension})). This usually means the embedding provider/model was switched (e.g. Voyage 1024 ↔ OpenAI 1536) without migrating the vector column. New embedding writes will fail with a pgvector dimension error.`,
            remediation: `Either revert EMBEDDING_MODEL/EMBEDDING_DIMENSIONS to the values that produced vector(${columnDimension}), or migrate the vector columns to ${configuredDimension} dimensions and re-embed your library (the old ${columnDimension}-wide vectors are not comparable to ${configuredDimension}-wide ones).`,
        },
    ];
}
