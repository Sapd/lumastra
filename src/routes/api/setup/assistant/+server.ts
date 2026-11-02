// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/setup/assistant — admin-only: enable/configure the AI assistant
 * (chat) from the first-run setup wizard.
 *
 * The assistant's chat key (OPENAI_CHAT_API_KEY) is separate from the
 * embeddings key (OPENAI_API_KEY, configured via /api/setup/integrations) —
 * no fallback between the two. Keys are persisted encrypted via saveConfig
 * (same sealed/secret path as OPENAI_API_KEY in /api/setup/integrations).
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { saveConfig } from '$lib/server/config/config.service.js';
import { isRecord, toBooleanOr, toStringOr } from '$lib/utils/data-extraction.js';

const ENDPOINT = '/api/setup/assistant';
const PROVIDERS = ['openai', 'anthropic'] as const;
type AssistantProvider = (typeof PROVIDERS)[number];

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

        const provider = toStringOr(body.provider, '') as AssistantProvider;
        if (!PROVIDERS.includes(provider)) {
            return ApiResponses.badRequest('Invalid assistant provider', undefined, ENDPOINT);
        }

        const updates: Record<string, unknown> = {
            FEATURE_AI_ASSISTANT: toBooleanOr(body.enabled, false),
            ASSISTANT_PROVIDER: provider,
        };

        // Never blank an existing key/model when omitted or empty.
        const apiKey = toStringOr(body.apiKey, '').trim();
        if (apiKey) {
            updates[provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_CHAT_API_KEY'] =
                apiKey;
        }

        const model = toStringOr(body.model, '').trim();
        if (model) {
            updates[provider === 'anthropic' ? 'ANTHROPIC_CHAT_MODEL' : 'OPENAI_CHAT_MODEL'] =
                model;
        }

        await saveConfig(updates);
        return json({ ok: true });
    }),
);
