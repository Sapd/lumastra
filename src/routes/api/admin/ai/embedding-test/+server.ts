// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/ai/embedding-test
 *
 * Admin-only live probe for the saved embedding configuration. Unlike the setup
 * wizard endpoint, this does not accept unsaved credentials in the request body.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getEmbeddingDimension } from '$lib/server/database/queries/onboarding.queries.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-timeout.js';
import { getAiConfig } from '$lib/server/config/domains/ai.js';
import { resolveEffectiveEmbedding } from '$lib/server/ai/embedding-models.js';
import { Logger } from '$lib/server/utils/logger.js';
import { setupProbeHttpError, describeFetchFailure } from '$lib/server/utils/fetch-error-cause.js';
import { isRecord } from '$lib/utils/data-extraction.js';

const logger = Logger.for('EmbeddingTest');

const TEST_INPUT = 'Lumastra embedding connection test.';
const PROBE_TIMEOUT_MS = 15_000;

function isRecordUnknown(v: unknown): v is Record<string, unknown> {
    return isRecord(v);
}

export const GET: RequestHandler = requireAdmin(
    withErrorHandler(async () => {
        const ai = getAiConfig();
        const effective = resolveEffectiveEmbedding({
            embeddingModel: ai.embeddingModel,
            embeddingDimensions: ai.embeddingDimensions,
            embeddingBaseUrl: ai.embeddingBaseUrl,
            embeddingApiKey: ai.embeddingApiKey,
            voyageApiKey: ai.voyageApiKey,
            openaiApiKey: ai.openaiApiKey,
        });

        if (!effective.hasProvider) {
            return json({
                ok: false,
                provider: ai.embeddingBaseUrl ? 'custom' : 'none',
                error:
                    ai.embeddingBaseUrl && !ai.embeddingApiKey
                        ? 'Custom embedding endpoint requires EMBEDDING_API_KEY.'
                        : 'No embedding provider is configured.',
            });
        }

        const sql = await aiDbService.getSql();
        if (!sql) {
            return json({
                ok: false,
                provider: effective.provider,
                error: 'Database unavailable.',
            });
        }
        const expected = await getEmbeddingDimension(sql);
        if (expected === null) {
            return json({
                ok: false,
                provider: effective.provider,
                error: 'Could not read the database embedding dimension.',
            });
        }

        let url: string;
        let apiKey: string;
        let reqBody: Record<string, unknown>;
        const provider = ai.embeddingBaseUrl ? 'custom' : effective.provider;
        if (provider === 'voyage') {
            apiKey = ai.voyageApiKey;
            url = 'https://api.voyageai.com/v1/embeddings';
            reqBody = {
                model: effective.model,
                input: [TEST_INPUT],
                output_dimension: expected,
            };
        } else {
            apiKey = ai.embeddingBaseUrl ? ai.embeddingApiKey : ai.openaiApiKey;
            const base = (ai.embeddingBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
            url = `${base}/embeddings`;
            reqBody = { model: effective.model, input: TEST_INPUT, dimensions: expected };
        }

        if (!apiKey) {
            return json({
                ok: false,
                provider,
                model: effective.model,
                expected,
                error: 'The selected embedding provider is missing an API key.',
            });
        }

        try {
            const res = await fetchWithTimeout(
                url,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify(reqBody),
                },
                PROBE_TIMEOUT_MS,
            );
            if (!res.ok) {
                logger.warn('Embedding connection test rejected by provider', {
                    status: res.status,
                });
                return json({
                    ok: false,
                    provider,
                    model: effective.model,
                    expected,
                    error: setupProbeHttpError(res.status, 'embedding'),
                });
            }
            const data: unknown = await res.json();
            const embedding =
                isRecordUnknown(data) &&
                Array.isArray(data.data) &&
                isRecordUnknown(data.data[0]) &&
                Array.isArray(data.data[0].embedding)
                    ? (data.data[0].embedding as unknown[])
                    : null;
            if (!embedding) {
                return json({
                    ok: false,
                    provider,
                    model: effective.model,
                    expected,
                    error: 'Unexpected response: no embedding vector.',
                });
            }
            const dimension = embedding.length;
            return json({
                ok: true,
                provider,
                model: effective.model,
                dimension,
                expected,
                matches: dimension === expected,
            });
        } catch (err) {
            logger.warn('Embedding connection test failed', {
                error: describeFetchFailure(err, [apiKey]),
            });
            return json({
                ok: false,
                provider,
                model: effective.model,
                expected,
                error: 'Embedding connection test failed.',
            });
        }
    }),
);
