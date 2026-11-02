// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/setup/integrations — admin-only: save the optional first-run
 * integrations the wizard collects beyond TMDB (which has its own endpoint):
 * MDBList (ratings enrichment) and the embedding provider (AI recommendations).
 *
 * Embeddings are DIMENSION-LOCKED. The pgvector column dimension is frozen when
 * the base schema is applied (from EMBEDDING_MODEL/EMBEDDING_DIMENSIONS at first
 * boot) and there's no runtime path to change it, so we read the live column
 * dimension and pin EMBEDDING_DIMENSIONS to it — the picked provider must emit
 * that width. A dimension is requested only when the provider/model supports it;
 * otherwise the model's native width must match. Keys are persisted encrypted via saveConfig.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getEmbeddingDimension } from '$lib/server/database/queries/onboarding.queries.js';
import { saveConfig } from '$lib/server/config/config.service.js';
import { isRecord, toStringOr } from '$lib/utils/data-extraction.js';
import { getAll, isEnvOverridden } from '$lib/server/config/index.js';
import { planSettingsUpdates } from '$lib/server/admin/settings-write.js';
import { parseEmbeddingConfig, probeEmbedding } from '../embedding-test/probe.js';
import { DEFAULT_OPENAI_MODEL, DEFAULT_VOYAGE_MODEL } from '$lib/server/ai/embedding-models.js';
import * as m from '$lib/paraglide/messages';

const ENDPOINT = '/api/setup/integrations';

export const POST: RequestHandler = requireAdmin(
    withErrorHandler(async ({ request }) => {
        let body: unknown;
        try {
            body = await readBoundedJson(request);
        } catch {
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        }
        if (!isRecord(body)) {
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        }

        let saved = false;

        // MDBList — optional ratings/lists enrichment.
        const mdblistApiKey = toStringOr(body.mdblistApiKey, '').trim();
        if (mdblistApiKey) {
            await saveConfig({ MDBLIST_API_KEY: mdblistApiKey });
            saved = true;
        }

        const sql = await aiDbService.getSql();
        if (!sql) {
            return ApiResponses.error(
                m.setup_embedding_refused({ reason: m.setup_embedding_dimension_unavailable() }),
                undefined,
                503,
                ENDPOINT,
            );
        }
        const updates: Record<string, unknown> = {};

        // Embeddings — optional AI recommendations provider.
        if (isRecord(body.embedding)) {
            const parsed = parseEmbeddingConfig(body.embedding);
            if ('error' in parsed)
                return ApiResponses.badRequest(
                    m.setup_embedding_refused({ reason: parsed.error }),
                    undefined,
                    ENDPOINT,
                );
            const { provider, apiKey, endpoint } = parsed;
            const current = getAll();
            const model =
                parsed.model ||
                (isEnvOverridden('EMBEDDING_MODEL')
                    ? toStringOr(current.EMBEDDING_MODEL, '')
                    : '') ||
                (provider === 'voyage' ? DEFAULT_VOYAGE_MODEL : DEFAULT_OPENAI_MODEL);

            // Pin the requested dimension to the DB's actual column width. If we
            // can't read it, REFUSE rather than save embeddings unpinned — an
            // unpinned provider would emit its default width and every insert would
            // mismatch the column and silently fail. (Configure via Admin → Settings
            // instead, where the dimension can be inspected.)
            const dimension = await getEmbeddingDimension(sql);
            if (dimension === null) {
                return ApiResponses.error(
                    m.setup_embedding_refused({
                        reason: m.setup_embedding_dimension_unavailable(),
                    }),
                    undefined,
                    500,
                    ENDPOINT,
                );
            }
            updates.EMBEDDING_DIMENSIONS = dimension;
            updates.FEATURE_AI_RECOMMENDATIONS = true;
            if (parsed.model || !isEnvOverridden('EMBEDDING_MODEL'))
                updates.EMBEDDING_MODEL = model;

            // A custom OpenAI-compatible endpoint has its own key: the embedding
            // resolver never sends OPENAI_API_KEY to EMBEDDING_BASE_URL (or the
            // other way round). Picking OpenAI or Voyage clears a custom base URL
            // left from an earlier run, which would otherwise still take precedence.
            if (provider === 'custom') {
                updates.EMBEDDING_BASE_URL = endpoint;
                updates.EMBEDDING_API_KEY = apiKey;
            } else {
                updates.EMBEDDING_BASE_URL = '';
                updates[provider === 'voyage' ? 'VOYAGE_API_KEY' : 'OPENAI_API_KEY'] = apiKey;
                if (provider === 'openai' && current.VOYAGE_API_KEY) updates.VOYAGE_API_KEY = '';
            }
            const plan = planSettingsUpdates(updates);
            if (plan.envLocked.length > 0) {
                return ApiResponses.badRequest(
                    m.setup_embedding_refused({
                        reason: m.setup_embedding_env_locked({ keys: plan.envLocked.join(', ') }),
                    }),
                    undefined,
                    ENDPOINT,
                );
            }
            if (Object.keys(plan.updates).length === 0) return json({ ok: true, saved });
            const result = await probeEmbedding({ ...parsed, model }, dimension);
            if (!result.ok && !result.retryable)
                return ApiResponses.badRequest(
                    m.setup_embedding_refused({ reason: result.error }),
                    undefined,
                    ENDPOINT,
                );
            if (result.ok && !result.matches) {
                return ApiResponses.badRequest(
                    m.setup_embedding_refused({
                        reason: m.setup_embedding_dimension_mismatch({
                            actual: result.dimension,
                            expected: dimension,
                        }),
                    }),
                    undefined,
                    ENDPOINT,
                );
            }
            await saveConfig(plan.updates);
            return json({
                ok: true,
                saved: true,
                ...(!result.ok
                    ? { warning: m.setup_embedding_verification_warning({ reason: result.error }) }
                    : {}),
            });
        }

        return json({ ok: true, saved });
    }),
);
