// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/setup/assistant-test — admin-only: validate the AI-assistant (chat)
 * provider by sending ONE tiny message with the ENTERED (not-yet-saved) provider
 * + key + model. Confirms reachability + key + model BEFORE the operator saves,
 * mirroring /api/setup/embedding-test for the embeddings field.
 *
 * Calls the provider's native chat endpoint directly (OpenAI chat/completions or
 * Anthropic messages) with a short timed fetch — the same lightweight posture as
 * embedding-test. Admin-only; only reflects back `{ ok, model, reply }` (or a short
 * provider error), so the exposure is minimal. Keys are never read back.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-timeout.js';
import {
    describeSetupFetchFailure,
    setupProbeHttpError,
} from '$lib/server/utils/fetch-error-cause.js';
import { isRecord, toStringOr } from '$lib/utils/data-extraction.js';

const ENDPOINT = '/api/setup/assistant-test';
const PROVIDERS = ['openai', 'anthropic'] as const;
type AssistantProvider = (typeof PROVIDERS)[number];

// Mirror the config.ts chat-model defaults (OPENAI_CHAT_MODEL / ANTHROPIC_CHAT_MODEL)
// so a blank model tests exactly what the saved config would use.
const DEFAULT_OPENAI_CHAT_MODEL = 'gpt-4o-mini';
const DEFAULT_ANTHROPIC_CHAT_MODEL = 'claude-opus-4-8';
const ANTHROPIC_VERSION = '2023-06-01';
const TEST_PROMPT = 'Reply with the single word: OK';
const PROBE_TIMEOUT_MS = 20_000;

function isRecordUnknown(v: unknown): v is Record<string, unknown> {
    return isRecord(v);
}

/** Pull the assistant text out of an OpenAI or Anthropic completion response. */
function extractReply(provider: AssistantProvider, data: unknown): string | null {
    if (!isRecordUnknown(data)) return null;
    if (provider === 'anthropic') {
        return Array.isArray(data.content) &&
            isRecordUnknown(data.content[0]) &&
            typeof data.content[0].text === 'string'
            ? data.content[0].text
            : null;
    }
    return Array.isArray(data.choices) &&
        isRecordUnknown(data.choices[0]) &&
        isRecordUnknown(data.choices[0].message) &&
        typeof data.choices[0].message.content === 'string'
        ? data.choices[0].message.content
        : null;
}

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
        const apiKey = toStringOr(body.apiKey, '').trim();
        const model = toStringOr(body.model, '').trim();

        if (!PROVIDERS.includes(provider)) {
            return ApiResponses.badRequest('Unknown assistant provider', undefined, ENDPOINT);
        }
        if (!apiKey) {
            return ApiResponses.badRequest('An API key is required', undefined, ENDPOINT);
        }

        // A blank model falls back to the same default the saved config would use.
        const usedModel =
            model ||
            (provider === 'anthropic' ? DEFAULT_ANTHROPIC_CHAT_MODEL : DEFAULT_OPENAI_CHAT_MODEL);

        let url: string;
        let headers: Record<string, string>;
        let reqBody: Record<string, unknown>;
        if (provider === 'anthropic') {
            url = 'https://api.anthropic.com/v1/messages';
            headers = {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': ANTHROPIC_VERSION,
            };
            reqBody = {
                model: usedModel,
                max_tokens: 16,
                messages: [{ role: 'user', content: TEST_PROMPT }],
            };
        } else {
            url = 'https://api.openai.com/v1/chat/completions';
            headers = {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            };
            reqBody = {
                model: usedModel,
                max_tokens: 16,
                temperature: 0,
                messages: [{ role: 'user', content: TEST_PROMPT }],
            };
        }

        try {
            const res = await fetchWithTimeout(
                url,
                { method: 'POST', headers, body: JSON.stringify(reqBody) },
                PROBE_TIMEOUT_MS,
            );
            if (!res.ok) {
                return json({ ok: false, error: setupProbeHttpError(res.status) });
            }
            const data: unknown = await res.json();
            const reply = extractReply(provider, data);
            if (reply === null) {
                return json({ ok: false, error: 'Unexpected response — no chat completion.' });
            }
            return json({ ok: true, model: usedModel, reply: reply.trim().slice(0, 200) });
        } catch (err) {
            return json({ ok: false, error: describeSetupFetchFailure(err, url, [apiKey]) });
        }
    }),
);
