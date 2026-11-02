// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/ai/assistant-test
 *
 * Admin-only live probe for the saved assistant chat configuration.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-timeout.js';
import { getAiConfig } from '$lib/server/config/domains/ai.js';
import {
    describeConnectionTestError,
    scrubConnectionText,
} from '$lib/server/utils/fetch-error-cause.js';
import { isRecord } from '$lib/utils/data-extraction.js';

const ANTHROPIC_VERSION = '2023-06-01';
const TEST_PROMPT = 'Reply with the single word: OK';
const PROBE_TIMEOUT_MS = 20_000;

function isRecordUnknown(v: unknown): v is Record<string, unknown> {
    return isRecord(v);
}

async function providerErrorMessage(res: Response): Promise<string> {
    try {
        const body: unknown = await res.json();
        if (isRecordUnknown(body)) {
            const err = body.error;
            if (typeof err === 'string') return err;
            if (isRecordUnknown(err) && typeof err.message === 'string') return err.message;
            if (typeof body.detail === 'string') return body.detail;
        }
    } catch {
        // Non-JSON provider body; use the status line below.
    }
    return `HTTP ${res.status}`;
}

function extractReply(provider: 'openai' | 'anthropic', data: unknown): string | null {
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

export const GET: RequestHandler = requireAdmin(
    withErrorHandler(async () => {
        const ai = getAiConfig();
        const provider = ai.chatProvider;
        const apiKey = provider === 'anthropic' ? ai.anthropicApiKey : ai.openaiChatApiKey;
        if (!apiKey) {
            return json({
                ok: false,
                provider,
                model: ai.chatModel,
                error: `No ${provider} assistant API key is configured.`,
            });
        }

        const base =
            provider === 'anthropic'
                ? (ai.anthropicBaseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '')
                : (ai.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
        const url = provider === 'anthropic' ? `${base}/messages` : `${base}/chat/completions`;
        const headers: Record<string, string> =
            provider === 'anthropic'
                ? {
                      'Content-Type': 'application/json',
                      'x-api-key': apiKey,
                      'anthropic-version': ANTHROPIC_VERSION,
                  }
                : {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${apiKey}`,
                  };
        const reqBody =
            provider === 'anthropic'
                ? {
                      model: ai.chatModel,
                      max_tokens: 16,
                      messages: [{ role: 'user', content: TEST_PROMPT }],
                  }
                : {
                      model: ai.chatModel,
                      max_tokens: 16,
                      temperature: 0,
                      messages: [{ role: 'user', content: TEST_PROMPT }],
                  };

        try {
            const res = await fetchWithTimeout(
                url,
                { method: 'POST', headers, body: JSON.stringify(reqBody) },
                PROBE_TIMEOUT_MS,
            );
            if (!res.ok) {
                return json({
                    ok: false,
                    provider,
                    model: ai.chatModel,
                    error: scrubConnectionText(await providerErrorMessage(res), [apiKey]),
                });
            }
            const data: unknown = await res.json();
            const reply = extractReply(provider, data);
            if (reply === null) {
                return json({
                    ok: false,
                    provider,
                    model: ai.chatModel,
                    error: 'Unexpected response: no chat completion.',
                });
            }
            return json({
                ok: true,
                provider,
                model: ai.chatModel,
                reply: reply.trim().slice(0, 200),
            });
        } catch (err) {
            return json({
                ok: false,
                provider,
                model: ai.chatModel,
                error: describeConnectionTestError(err, url, [apiKey]),
            });
        }
    }),
);
