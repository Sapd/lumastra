// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OpenAI chat backend for the assistant.
 *
 * Wraps the official `openai` SDK behind the neutral {@link ChatProvider}
 * interface. Behaviour matches the historical path: same
 * `chat.completions.create` call shape, same `max_completion_tokens`, same
 * `tool_choice` semantics — only the message/tool plumbing is translated from
 * the neutral form. Supports any OpenAI-compatible endpoint via `baseURL`.
 *
 * Prompt caching: OpenAI caches prompt prefixes (≥1024 tokens) automatically,
 * server-side — there is no `cache_control` to set. Our request already puts
 * the stable prefix first (system → tools → history) with the volatile user
 * message fenced last, so it caches as-is. We additionally pass a stable
 * `prompt_cache_key` (the documented replacement for the legacy `user` field)
 * to improve cache-routing hit rates across the multi-round tool loop and
 * repeat requests. Custom OpenAI-compatible backends that don't implement
 * caching simply ignore the field.
 *
 * @module server/assistant/assistant-provider/openai-provider
 */

import OpenAI from 'openai';
import { guardedDefaultFetch } from '$lib/server/utils/fetch-utils.js';
import { modelSupportsTools } from '../assistant-tools/capability.js';
import type {
    ChatProvider,
    ChatRequest,
    ChatResult,
    ChatStreamOptions,
    NeutralMessage,
    NeutralToolCall,
} from './types.js';
import { withExternalCallCounting } from '$lib/server/utils/external-request-counter.js';

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Stable prompt-cache routing key for all assistant requests. */
export const OPENAI_PROMPT_CACHE_KEY = 'lumastra-assistant';

/**
 * Translate neutral messages to OpenAI's chat-completion message array.
 * Exported for unit testing.
 */
export function toOpenAIMessages(
    system: string,
    messages: readonly NeutralMessage[],
): OpenAIMessage[] {
    const out: OpenAIMessage[] = [{ role: 'system', content: system }];
    for (const m of messages) {
        switch (m.role) {
            case 'user':
                out.push({ role: 'user', content: m.content });
                break;
            case 'assistant':
                out.push({ role: 'assistant', content: m.content });
                break;
            case 'assistant_tools':
                // Reconstruct the assistant tool-call turn from the neutral
                // calls (OpenAI has no thinking blocks to preserve).
                out.push({
                    role: 'assistant',
                    content: null,
                    tool_calls: m.toolCalls.map((tc) => ({
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.name, arguments: tc.argumentsJson },
                    })),
                });
                break;
            case 'tool':
                out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
                break;
        }
    }
    return out;
}

/**
 * Build the `chat.completions.create` params from a neutral request. Exported
 * for unit testing (asserts the prompt-cache key + tool/message plumbing).
 */
export function buildOpenAIParams(
    model: string,
    req: ChatRequest,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
    const tools = req.tools?.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    return {
        model,
        messages: toOpenAIMessages(req.system, req.messages),
        ...(tools && tools.length > 0 ? { tools, tool_choice: req.toolChoice ?? 'auto' } : {}),
        max_completion_tokens: req.maxOutputTokens,
        // Stable key → better prompt-cache routing across the multi-round loop
        // and repeat requests. Harmlessly ignored by non-caching backends.
        prompt_cache_key: OPENAI_PROMPT_CACHE_KEY,
    };
}

export class OpenAIChatProvider implements ChatProvider {
    readonly model: string;
    private readonly client: OpenAI;

    constructor(opts: { apiKey: string; baseUrl?: string; model: string }) {
        this.model = opts.model;
        this.client = new OpenAI({
            apiKey: opts.apiKey,
            ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
            // C22 fix-plan finding: OPENAI_BASE_URL is admin-settable (a
            // self-hosted OpenAI-compatible proxy is a supported deployment),
            // so it is a private, operator-controlled target like ABS/Kavita
            // — the SDK's raw global fetch would follow an arbitrary
            // redirect from that proxy with the API key still attached.
            // `guardedDefaultFetch` is the same-origin-only guard.
            fetch: withExternalCallCounting(guardedDefaultFetch, 'openai'),
        });
    }

    supportsTools(): boolean {
        return modelSupportsTools(this.model);
    }

    async createChat(req: ChatRequest, opts?: { signal?: AbortSignal }): Promise<ChatResult> {
        const completion = await this.client.chat.completions.create(
            buildOpenAIParams(this.model, req),
            opts?.signal ? { signal: opts.signal } : undefined,
        );

        const message = completion.choices[0]?.message;
        const toolCalls = (message?.tool_calls ?? [])
            .filter((tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
                Boolean(tc && 'function' in tc && tc.type === 'function'),
            )
            .map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                argumentsJson: tc.function.arguments ?? '',
            }));

        return {
            text: message?.content ?? '',
            toolCalls,
            providerRaw: message,
            usage: {
                inputTokens: completion.usage?.prompt_tokens ?? 0,
                outputTokens: completion.usage?.completion_tokens ?? 0,
            },
            usageMissing: !completion.usage,
        };
    }

    async createChatStream(req: ChatRequest, opts: ChatStreamOptions): Promise<ChatResult> {
        // Share the exact non-streaming param builder (same model, messages,
        // tools, tool_choice, max_completion_tokens, prompt_cache_key), then add
        // the streaming flags. `include_usage` makes the final chunk carry usage
        // so the daily token budget stays accurate.
        const base = buildOpenAIParams(this.model, req);
        const stream = await this.client.chat.completions.create(
            { ...base, stream: true, stream_options: { include_usage: true } },
            opts.signal ? { signal: opts.signal } : undefined,
        );

        let text = '';
        // Tool-call fragments arrive across chunks: id/name land on the first
        // fragment for an index, arguments concatenate. Keyed by `index`.
        const toolAcc = new Map<number, { id: string; name: string; args: string }>();
        let usage: OpenAI.Completions.CompletionUsage | undefined;

        for await (const chunk of stream) {
            const choice = chunk.choices[0];
            const delta = choice?.delta;
            if (delta?.content) {
                text += delta.content;
                opts.onDelta({ type: 'text', delta: delta.content });
            }
            for (const tc of delta?.tool_calls ?? []) {
                const idx = tc.index;
                const acc = toolAcc.get(idx) ?? { id: '', name: '', args: '' };
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.args += tc.function.arguments;
                toolAcc.set(idx, acc);
            }
            // The usage-bearing chunk (from include_usage) has an empty choices
            // array and a populated `usage`; capture it whenever present.
            if (chunk.usage) usage = chunk.usage;
        }

        const toolCalls: NeutralToolCall[] = [...toolAcc.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, v]) => ({ id: v.id, name: v.name, argumentsJson: v.args }));

        // Reconstruct an assistant message for providerRaw parity with the
        // non-streaming path (OpenAI rebuilds tool turns from `toolCalls`, so
        // this is only used for shape consistency, never replayed verbatim).
        const providerRaw: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
            role: 'assistant',
            content: text || null,
            ...(toolCalls.length > 0
                ? {
                      tool_calls: toolCalls.map((tc) => ({
                          id: tc.id,
                          type: 'function' as const,
                          function: { name: tc.name, arguments: tc.argumentsJson },
                      })),
                  }
                : {}),
        };

        return {
            text,
            toolCalls,
            providerRaw,
            usage: {
                inputTokens: usage?.prompt_tokens ?? 0,
                outputTokens: usage?.completion_tokens ?? 0,
            },
            usageMissing: !usage,
        };
    }
}
