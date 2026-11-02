// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getEmbeddingDimension } from '$lib/server/database/queries/onboarding.queries.js';
import { isRecord } from '$lib/utils/data-extraction.js';
import { parseEmbeddingConfig, probeEmbedding } from './probe.js';
import * as m from '$lib/paraglide/messages';

const ENDPOINT = '/api/setup/embedding-test';

export const POST: RequestHandler = requireAdmin(
    withErrorHandler(async ({ request }) => {
        let body: unknown;
        try {
            body = await readBoundedJson(request);
        } catch {
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        }
        if (!isRecord(body))
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        const config = parseEmbeddingConfig(body);
        if ('error' in config) return ApiResponses.badRequest(config.error, undefined, ENDPOINT);
        const sql = await aiDbService.getSql();
        if (!sql) return ApiResponses.error('Database unavailable', undefined, 503, ENDPOINT);
        const expected = await getEmbeddingDimension(sql);
        if (expected === null)
            return json({ ok: false, error: m.setup_embedding_dimension_unavailable() });
        const result = await probeEmbedding(config, expected);
        return json(result.ok ? result : { ok: false, error: result.error });
    }),
);
