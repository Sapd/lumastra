// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { fetchWithTimeout } from '$lib/server/utils/fetch-timeout.js';
import {
    describeSetupFetchFailure,
    setupProbeHttpError,
} from '$lib/server/utils/fetch-error-cause.js';
import {
    DEFAULT_OPENAI_MODEL,
    DEFAULT_VOYAGE_MODEL,
    EMBEDDING_MODELS,
} from '$lib/server/ai/embedding-models.js';
import { isRecord, toStringOr } from '$lib/utils/data-extraction.js';
import * as m from '$lib/paraglide/messages';

export interface EmbeddingProbeConfig {
    provider: 'openai' | 'voyage' | 'custom';
    apiKey: string;
    endpoint: string;
    model: string;
}

export type EmbeddingProbeResult =
    | { ok: false; error: string; retryable: boolean }
    | { ok: true; dimension: number; expected: number; matches: boolean };

export function parseEmbeddingConfig(
    body: Record<string, unknown>,
): EmbeddingProbeConfig | { error: string } {
    const provider = toStringOr(body.provider, '');
    const apiKey = toStringOr(body.apiKey, '').trim();
    const endpoint = toStringOr(body.endpoint, '').trim();
    const model = toStringOr(body.model, '').trim();
    if (provider !== 'openai' && provider !== 'voyage' && provider !== 'custom') {
        return { error: m.setup_embedding_provider_invalid() };
    }
    if (!apiKey || /[\s\p{Cc}]/u.test(apiKey)) return { error: m.setup_embedding_key_invalid() };
    if (/[\p{Cc}]/u.test(model)) return { error: m.setup_embedding_model_invalid() };
    if (provider === 'custom') {
        try {
            const parsed = new URL(endpoint);
            if (
                !['http:', 'https:'].includes(parsed.protocol) ||
                parsed.username ||
                parsed.password ||
                parsed.hash
            ) {
                return { error: m.setup_embedding_url_invalid() };
            }
        } catch {
            return { error: m.setup_embedding_url_invalid() };
        }
    }
    return { provider, apiKey, endpoint, model };
}

export async function probeEmbedding(
    config: EmbeddingProbeConfig,
    expected: number,
): Promise<EmbeddingProbeResult> {
    const { provider, apiKey, endpoint, model } = config;
    const url =
        provider === 'voyage'
            ? new URL('https://api.voyageai.com/v1/embeddings')
            : new URL(provider === 'custom' ? endpoint : 'https://api.openai.com/v1');
    if (provider !== 'voyage') url.pathname = `${url.pathname.replace(/\/+$/, '')}/embeddings`;
    const usedModel =
        model || (provider === 'voyage' ? DEFAULT_VOYAGE_MODEL : DEFAULT_OPENAI_MODEL);
    const spec = EMBEDDING_MODELS[usedModel];
    const dimensionSupported =
        provider !== 'custom' &&
        spec?.provider === provider &&
        ((spec.dimensions.kind === 'range' && expected > 0 && expected <= spec.dimensions.max) ||
            (spec.dimensions.kind === 'oneOf' && spec.dimensions.values.includes(expected)));
    const reqBody =
        provider === 'voyage'
            ? {
                  model: usedModel,
                  input: ['Lumastra embedding connection test.'],
                  ...(dimensionSupported ? { output_dimension: expected } : {}),
              }
            : {
                  model: usedModel,
                  input: 'Lumastra embedding connection test.',
                  ...(dimensionSupported ? { dimensions: expected } : {}),
              };
    try {
        const response = await fetchWithTimeout(
            url.toString(),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify(reqBody),
            },
            15_000,
        );
        if (!response.ok)
            return {
                ok: false,
                error: setupProbeHttpError(response.status, 'embedding'),
                retryable: ![400, 401, 403, 404, 422].includes(response.status),
            };
        let data: unknown;
        try {
            data = await response.json();
        } catch {
            return { ok: false, error: m.setup_embedding_vector_invalid(), retryable: false };
        }
        const embedding =
            isRecord(data) && Array.isArray(data.data) && isRecord(data.data[0])
                ? data.data[0].embedding
                : undefined;
        if (
            !Array.isArray(embedding) ||
            embedding.length === 0 ||
            !embedding.every(
                (value: unknown) => typeof value === 'number' && Number.isFinite(value),
            )
        ) {
            return { ok: false, error: m.setup_embedding_vector_invalid(), retryable: false };
        }
        return {
            ok: true,
            dimension: embedding.length,
            expected,
            matches: embedding.length === expected,
        };
    } catch (error) {
        return {
            ok: false,
            error: describeSetupFetchFailure(error, url.toString(), [apiKey]),
            retryable: true,
        };
    }
}
