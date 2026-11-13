// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Anthropic (Claude) chat backend for the assistant.
 *
 * Native Messages API (NOT the OpenAI-compat shim) behind the neutral
 * {@link ChatProvider} interface, with adaptive thinking. The neutral message
 * stream is translated to Claude's content-block model:
 *
 * - `system` → top-level `system` (not a message).
 * - assistant tool-call turns are replayed VERBATIM from the captured native
 *   blocks (`providerRaw`): Claude rejects a modified/dropped thinking block on
 *   replay with a 400, so the thinking + tool_use blocks it produced must be
 *   echoed back exactly.
 * - consecutive `tool` results are coalesced into a SINGLE user turn of
 *   `tool_result` blocks (Claude expects all results for one assistant turn in
 *   one user message).
 *
 * Thinking: when enabled we send `{type:'adaptive', display:'summarized'}` so a
 * readable reasoning summary comes back (the default is `omitted` → empty
 * text). Thinking tokens count toward `max_tokens`, so the output ceiling is
 * lifted to a floor when thinking is on.
 *
 * @module server/proprietary/assistant-provider/anthropic-provider
 */

import Anthropic from '@anthropic-ai/sdk';
import { guardedDefaultFetch } from '$lib/server/utils/fetch-utils.js';
import { modelSupportsTools } from '../assistant-tools/capability.js';
import type {
    ChatProvider,
    ChatRequest,
    ChatResult,
    ChatStreamOptions,
    NeutralMessage,
} from './types.js';
import { withExternalCallCounting } from '$lib/server/utils/external-request-counter.js';

/** Output-token floor when thinking is on, so reasoning + answer aren't truncated. */
const THINKING_MAX_TOKENS_FLOOR = 8000;

/** Modest thinking budget for models that lack adaptive thinking (e.g. Haiku). */
const BUDGET_THINKING_TOKENS = 2000;

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Per-model thinking capability. Verified against the Models API:
 * - adaptive + effort: Opus 4.5+/4.6/4.7/4.8, Sonnet 4.6, Fable/Mythos 5.
 * - budget thinking only (no adaptive, no effort): Haiku 4.5, Sonnet 4.5,
 *   Opus 4.0/4.1, Claude 3.7 Sonnet.
 * - unknown models: no thinking / no effort (safe — never 400 on an
 *   unsupported parameter).
 */
export function thinkingCapability(model: string): {
    mode: 'adaptive' | 'budget' | 'none';
    effort: boolean;
} {
    const m = model.toLowerCase();
    if (/^claude-(opus-4-[5-8]|sonnet-4-6|fable-5|mythos-(5|preview))/.test(m)) {
        return { mode: 'adaptive', effort: true };
    }
    if (/^claude-(haiku-4-5|sonnet-4-5|opus-4-[01]|3-7-sonnet)/.test(m)) {
        return { mode: 'budget', effort: false };
    }
    return { mode: 'none', effort: false };
}

/**
 * Translate neutral messages to Claude's content-block model. Exported for unit
 * testing of the coalescing/replay rules (the part most likely to drift).
 */
export function toAnthropicMessages(messages: readonly NeutralMessage[]): Anthropic.MessageParam[] {
    const out: Anthropic.MessageParam[] = [];
    let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

    const flushToolResults = (): void => {
        if (pendingToolResults.length > 0) {
            out.push({ role: 'user', content: pendingToolResults });
            pendingToolResults = [];
        }
    };

    for (const m of messages) {
        if (m.role === 'tool') {
            // Accumulate; emitted as one user turn when the run of tool results ends.
            pendingToolResults.push({
                type: 'tool_result',
                tool_use_id: m.toolCallId,
                content: m.content,
            });
            continue;
        }
        flushToolResults();
        switch (m.role) {
            case 'user':
                out.push({ role: 'user', content: m.content });
                break;
            case 'assistant':
                out.push({ role: 'assistant', content: m.content });
                break;
            case 'assistant_tools':
                // Replay the native blocks verbatim (thinking + tool_use). The
                // output ContentBlock[] is accepted as ContentBlockParam[] input.
                out.push({
                    role: 'assistant',
                    content: m.providerRaw as Anthropic.ContentBlockParam[],
                });
                break;
        }
    }
    flushToolResults();
    return out;
}

const EPHEMERAL = { type: 'ephemeral' as const };

/**
 * Tool definitions with a cache breakpoint on the LAST tool. Tools render first
 * in the prompt and are byte-identical across users/requests, so this caches
 * the (large) tool-schema prefix and yields cross-request cache reads. Returns
 * undefined when there are no tools.
 */
export function withToolCache(tools: Anthropic.Tool[] | undefined): Anthropic.Tool[] | undefined {
    if (!tools || tools.length === 0) return tools;
    const out = tools.slice();
    out[out.length - 1] = { ...out[out.length - 1], cache_control: EPHEMERAL };
    return out;
}

/**
 * System prompt as a single cached text block. A breakpoint here caches the
 * tools + system prefix together (render order is tools → system), so every
 * round of a multi-round tool loop re-reads it instead of re-billing it.
 */
export function cachedSystem(system: string): Anthropic.TextBlockParam[] {
    return [{ type: 'text', text: system, cache_control: EPHEMERAL }];
}

/**
 * Add a cache breakpoint to the last block of the last message, so each
 * subsequent tool-loop round re-reads the whole prior conversation (system +
 * tools + earlier turns + tool results) from cache. The dispatch loop always
 * calls with the last message being a user / tool_result turn, so this never
 * mutates a replayed assistant thinking block.
 */
export function withConversationCache(
    messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
    if (messages.length === 0) return messages;
    const idx = messages.length - 1;
    const last = messages[idx];
    const blocks: Anthropic.ContentBlockParam[] =
        typeof last.content === 'string'
            ? [{ type: 'text', text: last.content }]
            : last.content.slice();
    if (blocks.length === 0) return messages;
    blocks[blocks.length - 1] = {
        ...blocks[blocks.length - 1],
        cache_control: EPHEMERAL,
    } as Anthropic.ContentBlockParam;
    const out = messages.slice();
    out[idx] = { ...last, content: blocks };
    return out;
}

/**
 * Build the Messages API params from a neutral request. Shared VERBATIM by the
 * non-streaming ({@link AnthropicChatProvider.createChat}) and streaming
 * ({@link AnthropicChatProvider.createChatStream}) paths so both send identical
 * prompt-cache breakpoints, thinking config, and effort. Exported so the
 * streaming/non-streaming param parity can be asserted directly in tests.
 */
export function buildAnthropicParams(opts: {
    model: string;
    thinkingEnabled: boolean;
    effort: AnthropicEffort;
    cap: ReturnType<typeof thinkingCapability>;
    req: ChatRequest;
}): Anthropic.MessageCreateParamsNonStreaming {
    const { model, thinkingEnabled, effort, cap, req } = opts;

    // Prompt caching (prefix match, render order tools → system → messages):
    // breakpoints on the last tool, the system block, and the last message make
    // every multi-round tool-loop call re-read the large, stable
    // tools+system+history prefix from cache instead of re-billing it.
    const tools = withToolCache(
        req.tools?.map((t): Anthropic.Tool => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters as Anthropic.Tool.InputSchema,
        })),
    );

    // Thinking is model-aware: adaptive (Sonnet/Opus/Fable) vs budget_tokens
    // (Haiku — no adaptive support) vs off. A per-request `suppressThinking`
    // (trivial inputs) turns it off to save output tokens.
    const useThinking = thinkingEnabled && !req.suppressThinking && cap.mode !== 'none';
    const thinkingParam: Anthropic.ThinkingConfigParam | undefined =
        useThinking && cap.mode === 'adaptive'
            ? { type: 'adaptive', display: 'summarized' }
            : useThinking && cap.mode === 'budget'
              ? { type: 'enabled', budget_tokens: BUDGET_THINKING_TOKENS }
              : undefined;

    const maxTokens = thinkingParam
        ? Math.max(req.maxOutputTokens, THINKING_MAX_TOKENS_FLOOR)
        : req.maxOutputTokens;

    return {
        model,
        max_tokens: maxTokens,
        system: cachedSystem(req.system),
        messages: withConversationCache(toAnthropicMessages(req.messages)),
        ...(tools && tools.length > 0
            ? {
                  tools,
                  // 'none' forbids tools (force final answer); else let the
                  // model choose. Only auto/none are thinking-safe.
                  tool_choice:
                      req.toolChoice === 'none'
                          ? { type: 'none' as const }
                          : { type: 'auto' as const },
              }
            : {}),
        ...(thinkingParam ? { thinking: thinkingParam } : {}),
        // Effort caps overall spend/thinking depth — only on models that
        // support it (never Haiku/Sonnet-4.5, which 400 on the param).
        ...(cap.effort ? { output_config: { effort } } : {}),
    };
}

/**
 * Prompt tokens for the daily budget and cost ledger. With prompt caching on
 * (tools, system and the last message carry cache breakpoints) the API reports
 * the cached prefix in `cache_creation_input_tokens` / `cache_read_input_tokens`,
 * SEPARATE from `input_tokens`; counting `input_tokens` alone leaves the large
 * system + tool-schema prefix of every round out of the budget.
 */
export function anthropicInputTokens(
    usage: Pick<
        Anthropic.Usage,
        'input_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'
    >,
): number {
    return (
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
    );
}

/** Fold a completed message's content blocks + usage into a neutral ChatResult. */
function resultFromContent(
    content: readonly Anthropic.ContentBlock[],
    usage: Anthropic.Usage,
): ChatResult {
    let text = '';
    let thinking = '';
    const toolCalls: { id: string; name: string; argumentsJson: string }[] = [];
    for (const block of content) {
        if (block.type === 'text') {
            text += block.text;
        } else if (block.type === 'thinking') {
            thinking += block.thinking;
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                name: block.name,
                argumentsJson: JSON.stringify(block.input ?? {}),
            });
        }
    }

    return {
        text,
        toolCalls,
        thinking: thinking.trim() ? thinking : undefined,
        // Native blocks for verbatim replay on the next round.
        providerRaw: content,
        usage: {
            inputTokens: anthropicInputTokens(usage),
            outputTokens: usage.output_tokens,
        },
        usageMissing: false,
    };
}

export class AnthropicChatProvider implements ChatProvider {
    readonly model: string;
    private readonly client: Anthropic;
    private readonly thinkingEnabled: boolean;
    private readonly effort: AnthropicEffort;
    private readonly cap: ReturnType<typeof thinkingCapability>;

    constructor(opts: {
        apiKey: string;
        baseUrl?: string;
        model: string;
        thinking: boolean;
        effort?: AnthropicEffort;
    }) {
        this.model = opts.model;
        this.thinkingEnabled = opts.thinking;
        this.effort = opts.effort ?? 'medium';
        this.cap = thinkingCapability(opts.model);
        this.client = new Anthropic({
            apiKey: opts.apiKey,
            ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
            // C22 fix-plan finding: ANTHROPIC_BASE_URL is admin-settable (a
            // self-hosted/proxied endpoint is a supported deployment), so it
            // is a private, operator-controlled target like ABS/Kavita — the
            // SDK's raw global fetch would follow an arbitrary redirect from
            // that proxy with the API key still attached.
            // `guardedDefaultFetch` is the same-origin-only guard.
            fetch: withExternalCallCounting(guardedDefaultFetch),
        });
    }

    supportsTools(): boolean {
        return modelSupportsTools(this.model);
    }

    private buildParams(req: ChatRequest): Anthropic.MessageCreateParamsNonStreaming {
        return buildAnthropicParams({
            model: this.model,
            thinkingEnabled: this.thinkingEnabled,
            effort: this.effort,
            cap: this.cap,
            req,
        });
    }

    async createChat(req: ChatRequest, opts?: { signal?: AbortSignal }): Promise<ChatResult> {
        const response = await this.client.messages.create(
            this.buildParams(req),
            opts?.signal ? { signal: opts.signal } : undefined,
        );
        return resultFromContent(response.content, response.usage);
    }

    async createChatStream(req: ChatRequest, opts: ChatStreamOptions): Promise<ChatResult> {
        // Same params as createChat (prompt caching + thinking + effort
        // preserved). The `.stream()` helper exposes text/summarized-thinking
        // deltas via events and the fully-assembled message via finalMessage().
        const stream = this.client.messages.stream(
            this.buildParams(req),
            opts.signal ? { signal: opts.signal } : undefined,
        );
        stream.on('text', (delta) => {
            if (delta) opts.onDelta({ type: 'text', delta });
        });
        stream.on('thinking', (delta) => {
            if (delta) opts.onDelta({ type: 'thinking', delta });
        });
        const finalMessage = await stream.finalMessage();
        return resultFromContent(finalMessage.content, finalMessage.usage);
    }
}
