// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '../../config.js';

/** Typed AI configuration — OpenAI, embeddings, and assistant settings */
export interface AiConfig {
    // OpenAI / Chat
    readonly openaiApiKey: string;
    readonly openaiChatApiKey: string;
    readonly openaiBaseUrl: string;
    readonly openaiChatModel: string;

    // Anthropic (Claude) / Chat
    readonly anthropicApiKey: string;
    readonly anthropicBaseUrl: string;
    readonly anthropicChatModel: string;

    // Assistant chat backend selection
    readonly assistantProvider: 'openai' | 'anthropic' | 'auto';
    readonly assistantThinking: boolean;
    readonly assistantEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** Resolved backend after applying the 'auto' rule: 'openai' | 'anthropic'. */
    readonly chatProvider: 'openai' | 'anthropic';
    /** Chat model for the resolved backend (openaiChatModel or anthropicChatModel). */
    readonly chatModel: string;
    /** Whether a usable chat backend (API key for the resolved provider) is configured. */
    readonly hasChat: boolean;
    readonly hasAnthropic: boolean;

    // Embeddings
    readonly voyageApiKey: string;
    readonly embeddingBaseUrl: string;
    readonly embeddingApiKey: string;
    readonly embeddingModel: string;
    readonly embeddingDimensions: number;
    /** Mirrors LIVETV_ALLOW_PRIVATE_URLS — opt-in for a self-hosted embeddingBaseUrl on a trusted/LAN network. */
    readonly embeddingAllowPrivateUrls: boolean;

    // Assistant
    readonly assistantName: string;
    readonly assistantPersona: string;
    readonly assistantTone: 'concise' | 'balanced' | 'warm';
    readonly assistantProactivity: 'off' | 'light';
    readonly assistantAvatar: string;
    readonly assistantDailyLimitUser: number;
    readonly assistantDailyLimitAdmin: number;
    readonly assistantDailyTokenLimitUser: number;
    readonly assistantDailyTokenLimitAdmin: number;
    /** Max concurrent in-flight assistant runs per user (default 2). */
    readonly assistantMaxConcurrent: number;
    /** Per-user requests-per-minute cap (default 10). */
    readonly assistantRequestsPerMinute: number;
    /** Conversation-compaction budget: most-recent turns kept (default 20). */
    readonly assistantHistoryMaxTurns: number;
    /** Conversation-compaction budget: cumulative content chars kept (default 24000). */
    readonly assistantHistoryMaxChars: number;
    /** How dropped history turns are handled ('truncate' | 'summarize'). */
    readonly assistantHistoryCompaction: 'truncate' | 'summarize';

    // Derived availability flags
    readonly hasOpenai: boolean;
    readonly hasVoyage: boolean;
    readonly hasAnyProvider: boolean;
}

/**
 * Get AI-scoped configuration.
 * Returns a frozen object with only AI-related config properties.
 */
export function getAiConfig(): AiConfig {
    // Resolve the active chat backend. 'auto' prefers Anthropic only when it is
    // the sole configured key, so existing OpenAI deployments are unaffected.
    const hasOpenaiKey = !!config.OPENAI_CHAT_API_KEY;
    const hasAnthropicKey = !!config.ANTHROPIC_API_KEY;
    const requested = config.ASSISTANT_PROVIDER;
    const chatProvider: 'openai' | 'anthropic' =
        requested === 'anthropic'
            ? 'anthropic'
            : requested === 'openai'
              ? 'openai'
              : hasAnthropicKey && !hasOpenaiKey
                ? 'anthropic'
                : 'openai';
    const chatModel =
        chatProvider === 'anthropic' ? config.ANTHROPIC_CHAT_MODEL : config.OPENAI_CHAT_MODEL;
    const hasChat = chatProvider === 'anthropic' ? hasAnthropicKey : hasOpenaiKey;

    return Object.freeze({
        openaiApiKey: config.OPENAI_API_KEY,
        openaiChatApiKey: config.OPENAI_CHAT_API_KEY,
        openaiBaseUrl: config.OPENAI_BASE_URL,
        openaiChatModel: config.OPENAI_CHAT_MODEL,

        anthropicApiKey: config.ANTHROPIC_API_KEY,
        anthropicBaseUrl: config.ANTHROPIC_BASE_URL,
        anthropicChatModel: config.ANTHROPIC_CHAT_MODEL,

        assistantProvider: requested,
        assistantThinking: config.ASSISTANT_THINKING,
        assistantEffort: config.ASSISTANT_EFFORT,
        chatProvider,
        chatModel,
        hasChat,
        hasAnthropic: hasAnthropicKey,

        voyageApiKey: config.VOYAGE_API_KEY,
        embeddingBaseUrl: config.EMBEDDING_BASE_URL,
        embeddingApiKey: config.EMBEDDING_API_KEY,
        embeddingModel: config.EMBEDDING_MODEL,
        embeddingDimensions: config.EMBEDDING_DIMENSIONS,
        embeddingAllowPrivateUrls: config.EMBEDDING_ALLOW_PRIVATE_URLS,

        assistantName: config.ASSISTANT_NAME,
        assistantPersona: config.ASSISTANT_PERSONA,
        assistantTone: config.ASSISTANT_TONE,
        assistantProactivity: config.ASSISTANT_PROACTIVITY,
        assistantAvatar: config.ASSISTANT_AVATAR,
        assistantDailyLimitUser: config.ASSISTANT_DAILY_LIMIT_USER,
        assistantDailyLimitAdmin: config.ASSISTANT_DAILY_LIMIT_ADMIN,
        assistantDailyTokenLimitUser: config.ASSISTANT_DAILY_TOKEN_LIMIT_USER,
        assistantDailyTokenLimitAdmin: config.ASSISTANT_DAILY_TOKEN_LIMIT_ADMIN,
        assistantMaxConcurrent: config.ASSISTANT_MAX_CONCURRENT,
        assistantRequestsPerMinute: config.ASSISTANT_REQUESTS_PER_MINUTE,
        assistantHistoryMaxTurns: config.ASSISTANT_HISTORY_MAX_TURNS,
        assistantHistoryMaxChars: config.ASSISTANT_HISTORY_MAX_CHARS,
        assistantHistoryCompaction: config.ASSISTANT_HISTORY_COMPACTION,

        hasOpenai: !!config.OPENAI_API_KEY,
        hasVoyage: !!config.VOYAGE_API_KEY,
        hasAnyProvider: !!(
            config.OPENAI_API_KEY ||
            config.VOYAGE_API_KEY ||
            config.ANTHROPIC_API_KEY
        ),
    });
}
