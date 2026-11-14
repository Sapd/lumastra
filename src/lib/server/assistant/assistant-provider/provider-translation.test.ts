// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the neutral→wire message translation in both chat providers.
 * This is the part most likely to drift: tool_result coalescing and verbatim
 * replay of provider-native assistant turns (Claude thinking blocks).
 */
import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
    toOpenAIMessages,
    buildOpenAIParams,
    OPENAI_PROMPT_CACHE_KEY,
    OpenAIChatProvider,
} from './openai-provider.js';
import {
    toAnthropicMessages,
    withToolCache,
    cachedSystem,
    withConversationCache,
    thinkingCapability,
    buildAnthropicParams,
} from './anthropic-provider.js';
import type { ChatRequest, NeutralMessage } from './types.js';

// Mock the OpenAI SDK so createChatStream can be driven by a scripted stream.
const { openAiCreate } = vi.hoisted(() => ({ openAiCreate: vi.fn() }));
vi.mock('openai', () => ({
    default: class {
        chat = { completions: { create: openAiCreate } };
        constructor(_opts: unknown) {}
    },
}));

const toolBlocks = [
    { type: 'thinking', thinking: 'reasoning…', signature: 'sig' },
    { type: 'tool_use', id: 'tu_1', name: 'echo', input: { q: 'hi' } },
];

const conversation: NeutralMessage[] = [
    { role: 'user', content: 'hi' },
    {
        role: 'assistant_tools',
        toolCalls: [{ id: 'tu_1', name: 'echo', argumentsJson: '{"q":"hi"}' }],
        providerRaw: toolBlocks,
    },
    { role: 'tool', toolCallId: 'tu_1', content: 'got:hi' },
    { role: 'tool', toolCallId: 'tu_2', content: 'got:bye' },
    { role: 'assistant', content: 'done' },
];

describe('toOpenAIMessages', () => {
    it('prepends the system turn and maps each role', () => {
        const out = toOpenAIMessages('sys', conversation);
        expect(out[0]).toEqual({ role: 'system', content: 'sys' });
        expect(out[1]).toEqual({ role: 'user', content: 'hi' });
        // assistant_tools → assistant with reconstructed tool_calls
        expect(out[2]).toMatchObject({
            role: 'assistant',
            content: null,
            tool_calls: [
                {
                    id: 'tu_1',
                    type: 'function',
                    function: { name: 'echo', arguments: '{"q":"hi"}' },
                },
            ],
        });
        // Each tool result is its own `tool` message (OpenAI requires one per id).
        expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'tu_1', content: 'got:hi' });
        expect(out[4]).toEqual({ role: 'tool', tool_call_id: 'tu_2', content: 'got:bye' });
        expect(out[5]).toEqual({ role: 'assistant', content: 'done' });
    });
});

describe('toAnthropicMessages', () => {
    it('replays native blocks verbatim and coalesces consecutive tool results', () => {
        const out = toAnthropicMessages(conversation);
        // No system turn here (system is a top-level param on Claude).
        expect(out[0]).toEqual({ role: 'user', content: 'hi' });
        // assistant_tools replays the EXACT native blocks (thinking preserved).
        expect(out[1]).toEqual({ role: 'assistant', content: toolBlocks });
        // The two consecutive tool results collapse into ONE user turn.
        expect(out[2]).toEqual({
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'tu_1', content: 'got:hi' },
                { type: 'tool_result', tool_use_id: 'tu_2', content: 'got:bye' },
            ],
        });
        expect(out[3]).toEqual({ role: 'assistant', content: 'done' });
        expect(out).toHaveLength(4);
    });

    it('flushes pending tool results before a following assistant turn', () => {
        const out = toAnthropicMessages([
            { role: 'tool', toolCallId: 'a', content: 'ra' },
            { role: 'assistant', content: 'next' },
        ]);
        expect(out[0]).toMatchObject({ role: 'user' });
        expect(out[1]).toEqual({ role: 'assistant', content: 'next' });
    });
});

describe('buildOpenAIParams (prompt caching)', () => {
    it('always sets a stable prompt_cache_key for cache routing', () => {
        const params = buildOpenAIParams('gpt-4o', {
            system: 'sys',
            messages: [{ role: 'user', content: 'hi' }],
            maxOutputTokens: 4000,
        });
        expect(params.prompt_cache_key).toBe(OPENAI_PROMPT_CACHE_KEY);
        expect(params.model).toBe('gpt-4o');
        expect(params.max_completion_tokens).toBe(4000);
        // system is the stable prefix (rendered first), user message last
        expect(params.messages[0]).toEqual({ role: 'system', content: 'sys' });
    });

    it('passes tools + tool_choice through when tools are present', () => {
        const params = buildOpenAIParams('gpt-4o', {
            system: 'sys',
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ name: 'echo', description: 'd', parameters: { type: 'object' } }],
            toolChoice: 'none',
            maxOutputTokens: 4000,
        });
        expect(params.tools).toHaveLength(1);
        expect(params.tool_choice).toBe('none');
        expect(params.prompt_cache_key).toBe(OPENAI_PROMPT_CACHE_KEY);
    });
});

describe('OpenAIChatProvider.createChatStream (accumulation)', () => {
    const baseReq: ChatRequest = {
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: 100,
    };

    it('accumulates text, concatenates tool_call fragments, reads final-chunk usage', async () => {
        async function* chunks(): AsyncGenerator<Record<string, unknown>> {
            yield { choices: [{ delta: { content: 'Hel' } }] };
            yield { choices: [{ delta: { content: 'lo' } }] };
            // id/name land on the first tool fragment; arguments concatenate.
            yield {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: 'call_1',
                                    function: { name: 'search', arguments: '{"q":' },
                                },
                            ],
                        },
                    },
                ],
            };
            yield {
                choices: [
                    { delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] } },
                ],
            };
            // include_usage final chunk: empty choices, populated usage.
            yield { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } };
        }
        openAiCreate.mockResolvedValue(chunks());

        const provider = new OpenAIChatProvider({ apiKey: 'k', model: 'gpt-4o' });
        const deltas: string[] = [];
        const res = await provider.createChatStream(baseReq, {
            onDelta: (d) => {
                if (d.type === 'text') deltas.push(d.delta);
            },
        });

        expect(deltas).toEqual(['Hel', 'lo']);
        expect(res.text).toBe('Hello');
        expect(res.toolCalls).toEqual([
            { id: 'call_1', name: 'search', argumentsJson: '{"q":"hi"}' },
        ]);
        expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
        expect(res.usageMissing).toBe(false);

        // Streaming flags were added on top of the shared param builder.
        const params = openAiCreate.mock.calls[0][0] as Record<string, unknown>;
        expect(params.stream).toBe(true);
        expect(params.stream_options).toEqual({ include_usage: true });
        expect(params.prompt_cache_key).toBe(OPENAI_PROMPT_CACHE_KEY);
    });

    it('marks usageMissing when no usage chunk is emitted', async () => {
        async function* chunks(): AsyncGenerator<Record<string, unknown>> {
            yield { choices: [{ delta: { content: 'hey' } }] };
        }
        openAiCreate.mockResolvedValue(chunks());

        const provider = new OpenAIChatProvider({ apiKey: 'k', model: 'gpt-4o' });
        const res = await provider.createChatStream(baseReq, { onDelta: () => {} });

        expect(res.text).toBe('hey');
        expect(res.usageMissing).toBe(true);
        expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });
});

describe('buildAnthropicParams (streaming/non-streaming param parity)', () => {
    const req: ChatRequest = {
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
            { name: 'a', description: 'a', parameters: { type: 'object' } },
            { name: 'b', description: 'b', parameters: { type: 'object' } },
        ],
        toolChoice: 'auto',
        maxOutputTokens: 4000,
    };

    it('sets cache breakpoints, adaptive thinking, and effort on an effort-capable model', () => {
        const cap = thinkingCapability('claude-opus-4-8');
        const params = buildAnthropicParams({
            model: 'claude-opus-4-8',
            thinkingEnabled: true,
            effort: 'high',
            cap,
            req,
        });
        // system cached
        const system = params.system as Anthropic.TextBlockParam[];
        expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
        // last tool cached, first not
        const tools = params.tools ?? [];
        expect(tools[0].cache_control).toBeUndefined();
        expect(tools[tools.length - 1].cache_control).toEqual({ type: 'ephemeral' });
        // adaptive thinking summary + effort cap
        expect(params.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(params.output_config).toEqual({ effort: 'high' });
    });

    it('drops thinking when suppressed (effort still applies, matching the non-stream path)', () => {
        const cap = thinkingCapability('claude-opus-4-8');
        const params = buildAnthropicParams({
            model: 'claude-opus-4-8',
            thinkingEnabled: true,
            effort: 'high',
            cap,
            req: { ...req, suppressThinking: true },
        });
        expect(params.thinking).toBeUndefined();
        expect(params.output_config).toEqual({ effort: 'high' });
    });
});

describe('thinkingCapability (model-aware thinking/effort)', () => {
    it('uses adaptive + effort for Sonnet 4.6 / Opus / Fable', () => {
        for (const m of [
            'claude-sonnet-4-6',
            'claude-opus-4-8',
            'claude-opus-4-5',
            'claude-fable-5',
        ]) {
            expect(thinkingCapability(m)).toEqual({ mode: 'adaptive', effort: true });
        }
    });

    it('uses budget thinking and NO effort for Haiku 4.5 / Sonnet 4.5', () => {
        // Verified against the Models API: haiku-4-5 has effort=false, adaptive=false.
        for (const m of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1']) {
            expect(thinkingCapability(m)).toEqual({ mode: 'budget', effort: false });
        }
    });

    it('disables thinking/effort for unknown models (never 400 on an unsupported param)', () => {
        expect(thinkingCapability('some-local-llm')).toEqual({ mode: 'none', effort: false });
    });
});

describe('Anthropic prompt-cache breakpoints', () => {
    const tools: Anthropic.Tool[] = [
        { name: 'a', description: 'a', input_schema: { type: 'object' } },
        { name: 'b', description: 'b', input_schema: { type: 'object' } },
    ];

    it('caches the LAST tool only (caches the stable tool-schema prefix)', () => {
        const out = withToolCache(tools)!;
        expect(out[0].cache_control).toBeUndefined();
        expect(out[1].cache_control).toEqual({ type: 'ephemeral' });
        // original input is not mutated
        expect(tools[1].cache_control).toBeUndefined();
    });

    it('returns tools untouched when empty/undefined', () => {
        expect(withToolCache(undefined)).toBeUndefined();
        expect(withToolCache([])).toEqual([]);
    });

    it('wraps the system prompt in a cached text block', () => {
        expect(cachedSystem('sys')).toEqual([
            { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
        ]);
    });

    it('breakpoints the last block of the last message (string content)', () => {
        const out = withConversationCache([{ role: 'user', content: 'hello' }]);
        expect(out[0].content).toEqual([
            { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
        ]);
    });

    it('breakpoints the last tool_result block of a coalesced tool turn', () => {
        const msgs: Anthropic.MessageParam[] = [
            { role: 'user', content: 'q' },
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
                    { type: 'tool_result', tool_use_id: 't2', content: 'r2' },
                ],
            },
        ];
        const out = withConversationCache(msgs);
        const blocks = out[1].content as Anthropic.ContentBlockParam[];
        expect(blocks[0]).not.toHaveProperty('cache_control');
        expect(blocks[1]).toMatchObject({ cache_control: { type: 'ephemeral' } });
        // earlier message and original input untouched
        expect(out[0]).toEqual({ role: 'user', content: 'q' });
        expect(msgs[1].content).toHaveLength(2);
    });
});
