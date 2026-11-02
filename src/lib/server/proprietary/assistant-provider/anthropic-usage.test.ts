// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The daily token budget and cost ledger are built on `ChatResult.usage`. With
 * prompt caching the Anthropic API reports the cached prefix in separate
 * `cache_*_input_tokens` fields; leaving them out undercounts every round.
 */
import { describe, it, expect } from 'vitest';
import { AnthropicChatProvider } from './anthropic-provider.js';

function providerReturning(usage: Record<string, unknown>): AnthropicChatProvider {
    const provider = new AnthropicChatProvider({
        apiKey: 'test-key',
        model: 'claude-sonnet-4-5',
        thinking: false,
    });
    const message = {
        content: [{ type: 'text', text: 'hi' }],
        usage,
        stream: undefined,
    };
    (provider as unknown as { client: unknown }).client = {
        messages: {
            create: async () => message,
            stream: () => ({ finalMessage: async () => message, on: () => undefined }),
        },
    };
    return provider;
}

const REQ = {
    system: 's',
    messages: [{ role: 'user' as const, content: 'q' }],
    maxOutputTokens: 100,
};

describe('Anthropic usage accounting', () => {
    it('counts cache read and cache creation tokens as input tokens', async () => {
        const result = await providerReturning({
            input_tokens: 20,
            output_tokens: 7,
            cache_read_input_tokens: 9000,
            cache_creation_input_tokens: 300,
        }).createChat(REQ);
        expect(result.usage).toEqual({ inputTokens: 9320, outputTokens: 7 });
    });

    it('treats null cache fields (caching off) as zero', async () => {
        const result = await providerReturning({
            input_tokens: 20,
            output_tokens: 7,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
        }).createChat(REQ);
        expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 7 });
    });
});
