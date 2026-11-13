// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Chat-provider factory for the assistant.
 *
 * Resolves the active backend from AI config (`chatProvider`/`chatModel`, set
 * by the 'auto'|'openai'|'anthropic' rule in {@link getAiConfig}) and returns a
 * cached {@link ChatProvider}. The cache key folds in provider+model+key+base
 * so a config change rebuilds the client instead of serving a stale one.
 *
 * @module server/proprietary/assistant-provider
 */

import { getAiConfig } from '../../config/domains/ai.js';
import { OpenAIChatProvider } from './openai-provider.js';
import { AnthropicChatProvider } from './anthropic-provider.js';
import type { ChatProvider } from './types.js';

export type {
    ChatProvider,
    ChatRequest,
    ChatResult,
    NeutralMessage,
    NeutralToolDef,
} from './types.js';

let cached: { key: string; provider: ChatProvider } | null = null;

/**
 * Get the configured chat provider. Throws if the resolved backend has no API
 * key (mirrors the old `OPENAI_CHAT_API_KEY not configured` guard).
 */
export function getChatProvider(): ChatProvider {
    const ai = getAiConfig();

    if (ai.chatProvider === 'anthropic') {
        if (!ai.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY not configured');
        const key = `anthropic|${ai.anthropicChatModel}|${ai.anthropicApiKey}|${ai.anthropicBaseUrl}|${ai.assistantThinking}|${ai.assistantEffort}`;
        if (!cached || cached.key !== key) {
            cached = {
                key,
                provider: new AnthropicChatProvider({
                    apiKey: ai.anthropicApiKey,
                    baseUrl: ai.anthropicBaseUrl || undefined,
                    model: ai.anthropicChatModel,
                    thinking: ai.assistantThinking,
                    effort: ai.assistantEffort,
                }),
            };
        }
        return cached.provider;
    }

    if (!ai.openaiChatApiKey) throw new Error('OPENAI_CHAT_API_KEY not configured');
    const key = `openai|${ai.openaiChatModel}|${ai.openaiChatApiKey}|${ai.openaiBaseUrl}`;
    if (!cached || cached.key !== key) {
        cached = {
            key,
            provider: new OpenAIChatProvider({
                apiKey: ai.openaiChatApiKey,
                baseUrl: ai.openaiBaseUrl || undefined,
                model: ai.openaiChatModel,
            }),
        };
    }
    return cached.provider;
}
