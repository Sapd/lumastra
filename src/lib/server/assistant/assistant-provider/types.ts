// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider-neutral chat abstraction for the AI assistant.
 *
 * The assistant tool loop and single-shot path talk to this interface, not to
 * a specific vendor SDK. Two implementations exist: `openai-provider` (the
 * historical backend, behaviour preserved) and `anthropic-provider` (Claude
 * Messages API with adaptive thinking).
 *
 * Design notes:
 * - Tool definitions are built ONCE from each tool's Zod schema (the same
 *   schema the dispatch loop validates against) and handed to the provider as
 *   a neutral `{name, description, parameters}` shape; each provider formats
 *   that to its own wire schema.
 * - An assistant turn that issued tool calls carries an opaque `providerRaw`
 *   payload. Anthropic REQUIRES that thinking + tool_use blocks be echoed back
 *   verbatim on the next round (a modified thinking block is a 400), so the
 *   provider stores its native blocks there and replays them. OpenAI ignores
 *   it and reconstructs from `toolCalls`.
 *
 * @module server/assistant/assistant-provider/types
 */

/** A tool the model may call, in provider-neutral form. */
export interface NeutralToolDef {
    readonly name: string;
    readonly description: string;
    /** JSON Schema (draft 2020-12) for the tool's arguments. */
    readonly parameters: Record<string, unknown>;
}

/** A single tool call the model emitted. `argumentsJson` is raw, possibly malformed. */
export interface NeutralToolCall {
    readonly id: string;
    readonly name: string;
    readonly argumentsJson: string;
}

/** Provider-neutral conversation turn. */
export type NeutralMessage =
    | { readonly role: 'user'; readonly content: string }
    | { readonly role: 'assistant'; readonly content: string }
    | {
          /** Assistant turn that issued tool calls. */
          readonly role: 'assistant_tools';
          readonly toolCalls: readonly NeutralToolCall[];
          /** Provider-native blocks for verbatim replay (thinking/tool_use). Opaque. */
          readonly providerRaw: unknown;
      }
    | {
          readonly role: 'tool';
          readonly toolCallId: string;
          readonly content: string;
      };

export interface ChatRequest {
    readonly system: string;
    readonly messages: readonly NeutralMessage[];
    readonly tools?: readonly NeutralToolDef[];
    /** 'auto' (default) lets the model choose; 'none' forbids tool calls. */
    readonly toolChoice?: 'auto' | 'none';
    /** Hard ceiling on output tokens for this turn. */
    readonly maxOutputTokens: number;
    /**
     * Per-request override to skip thinking even when the provider has it on
     * (e.g. trivial inputs like greetings, where reasoning wastes output
     * tokens). Providers without thinking ignore it.
     */
    readonly suppressThinking?: boolean;
}

export interface ChatUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
}

export interface ChatResult {
    /** Final answer text (concatenated text blocks). */
    readonly text: string;
    /** Tool calls the model wants executed (empty when it produced a final answer). */
    readonly toolCalls: readonly NeutralToolCall[];
    /** Summarized reasoning, when the backend produced thinking. */
    readonly thinking?: string;
    /** Provider-native assistant turn for verbatim replay on the next round. */
    readonly providerRaw: unknown;
    readonly usage: ChatUsage;
    /**
     * True when the backend returned no usage data (some OpenAI-compatible/local
     * servers omit it). The caller warns once so the token budget's undercount
     * is observable rather than silent.
     */
    readonly usageMissing: boolean;
}

/**
 * An incremental chunk of streamed model output. `text` deltas are answer
 * content; `thinking` deltas are summarized reasoning (Anthropic only). Tool
 * calls are NOT streamed as deltas — they are accumulated internally and only
 * surfaced on the resolved {@link ChatResult}.
 */
export type ChatStreamDelta =
    | { readonly type: 'text'; readonly delta: string }
    | { readonly type: 'thinking'; readonly delta: string };

/** Options for {@link ChatProvider.createChatStream}. */
export interface ChatStreamOptions {
    readonly signal?: AbortSignal;
    /** Invoked as content arrives. Never called after the promise resolves. */
    readonly onDelta: (delta: ChatStreamDelta) => void;
}

/** A chat-completion backend (OpenAI or Anthropic). */
export interface ChatProvider {
    /** Active model id, for cost attribution and logging. */
    readonly model: string;
    /** Whether this backend+model supports the tool-calling loop. */
    supportsTools(): boolean;
    /** Run one model round-trip. Never accumulates state — the caller owns history. */
    createChat(req: ChatRequest, opts?: { signal?: AbortSignal }): Promise<ChatResult>;
    /**
     * Streaming variant of {@link createChat}. Streams vendor output, invoking
     * `opts.onDelta` for each text/thinking fragment as it arrives, and resolves
     * with the SAME accumulated {@link ChatResult} shape `createChat` returns
     * (text, toolCalls, thinking, providerRaw, usage, usageMissing). Prompt
     * caching and all request params are identical to the non-streaming path.
     */
    createChatStream(req: ChatRequest, opts: ChatStreamOptions): Promise<ChatResult>;
}
