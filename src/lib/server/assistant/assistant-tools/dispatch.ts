// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The assistant tool-calling dispatch loop (agentic RAG).
 *
 * Repeatedly calls the chat model (via the provider-neutral {@link ChatProvider}
 * — OpenAI or Anthropic) with the typed `tools` array; whenever the model
 * returns tool calls, each call's arguments are validated against the tool's
 * Zod schema BEFORE execution (the prompt-injection boundary), the tool runs
 * access-scoped, and its result is fed back. The loop ends when the model
 * returns a plain answer, or is force-finalized at the round cap.
 *
 * Security/cost properties:
 * - The raw user message is fenced in `<user_message>` delimiters so the
 *   model treats it as data, not instructions (finding F5).
 * - Token usage is summed across every round so the caller can record true
 *   multi-round cost (findings: cost & rate limiting preserved).
 * - Card-worthy media surfaced by tools is collected and de-duplicated, so
 *   recommended cards come from real tool results — no regex round-trip.
 * - Provider-native assistant turns (incl. Claude thinking blocks) are replayed
 *   verbatim across rounds via the neutral `assistant_tools` message, so a
 *   thinking-enabled backend doesn't reject the follow-up round.
 *
 * @module server/assistant/assistant-tools/dispatch
 */

import { randomUUID } from 'node:crypto';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';
import type { RecommendedMusic } from '../../../schemas/assistant-types.js';
import type { AssistantTool, AssistantToolContext, AssistantToolLogger } from './types.js';
import { buildNeutralToolDefs } from './to-openai-schema.js';
import { escapeFenceDelimiters, fenceUntrusted } from './untrusted-text.js';
import { ASSISTANT_TOOL_NAMES } from '../../../schemas/assistant-tools.js';
import type {
    ChatProvider,
    ChatRequest,
    ChatResult,
    NeutralMessage,
} from '../assistant-provider/types.js';

/**
 * Tools that mutate the caller's own state (registry.ts's "WRITE ACTIONS").
 * `resolveToolCall` refuses any of these once at least one tool result has
 * already entered the model's context (round > 1) — see P5 in the round-gate
 * comment below. `create_request` is included even though it is deliberately
 * two-phase: its own confirm gate (confirm-gate.ts) is designed around a
 * genuinely LATER user turn (a new call to this loop, a new invocationId),
 * never a later ROUND of the same turn, so refusing it here too is not a
 * regression on any legitimate flow.
 */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
    ASSISTANT_TOOL_NAMES.ADD_TO_WATCHLIST,
    ASSISTANT_TOOL_NAMES.REMOVE_FROM_WATCHLIST,
    ASSISTANT_TOOL_NAMES.SET_RATING,
    ASSISTANT_TOOL_NAMES.MARK_WATCHED,
    ASSISTANT_TOOL_NAMES.CREATE_REQUEST,
]);

// Implemented in `untrusted-text.ts` (dependency-free, shared with
// `assistant-service.ts`); re-exported because callers and tests import it here.
export { escapeFenceDelimiters };

/** Wrap a tool result so the model treats it as data, mirroring `<user_message>` (P5). */
export function fenceToolResult(name: string, content: string): string {
    return `<tool_result name="${name}">\n${escapeFenceDelimiters(content, 'tool_result')}\n</tool_result>`;
}

/**
 * Progress event emitted by {@link runAssistantToolLoop} when an `onEvent`
 * callback is supplied (SSE streaming path). When `onEvent` is absent the loop
 * runs exactly as before (non-streaming, for the plugin bridge).
 *
 * - `round`   — a model round-trip is starting. The frontend resets its
 *               in-progress text buffer on this, since only the FINAL round's
 *               text is the answer (earlier rounds may stream partial text
 *               before deciding to call a tool).
 * - `text` / `thinking` — forwarded provider deltas as they stream.
 * - `tool_start` / `tool_end` — a tool invocation began / finished.
 */
export type AssistantLoopEvent =
    | { readonly type: 'round'; readonly round: number }
    | { readonly type: 'text'; readonly delta: string }
    | { readonly type: 'thinking'; readonly delta: string }
    | { readonly type: 'tool_start'; readonly name: string; readonly round: number }
    | {
          readonly type: 'tool_end';
          readonly name: string;
          readonly ok: boolean;
          readonly ms: number;
      };

export interface AssistantToolLoopOptions {
    readonly provider: ChatProvider;
    readonly systemPrompt: string;
    readonly userMessage: string;
    /**
     * The history turns were NOT all written by the asker (a shared room's
     * recent messages). Fence them as `<untrusted_history>` — data to read, never
     * a user's request — instead of `<user_message>`. The live `userMessage` is
     * always the asker's own and keeps its fence.
     */
    readonly untrustedHistory?: boolean;
    /** Recent prior turns (most recent last) for multi-turn context. */
    readonly history?: ReadonlyArray<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    readonly tools: readonly AssistantTool[];
    readonly ctx: AssistantToolContext;
    /** Per-call completion-token ceiling (default 4000). */
    readonly maxCompletionTokens?: number;
    /** Max tool-calling rounds before forcing a textual answer (default 3). */
    readonly maxRounds?: number;
    /** Skip thinking for this turn (e.g. trivial inputs) to save output tokens. */
    readonly suppressThinking?: boolean;
    readonly logger?: AssistantToolLogger;
    /**
     * Optional abort signal. Forwarded to every model round-trip so an aborted
     * caller (plugin `ctx.ai.ask` or HTTP disconnect) cancels the in-flight LLM
     * request instead of running to completion and billing tokens for a
     * discarded result.
     */
    readonly signal?: AbortSignal;
    /**
     * Optional progress sink. When provided, the loop STREAMS each model
     * round-trip (via {@link ChatProvider.createChatStream}) and emits
     * {@link AssistantLoopEvent}s (round boundaries, text/thinking deltas, tool
     * start/end). When absent, the loop uses the non-streaming `createChat` and
     * emits nothing (unchanged behaviour for the plugin bridge).
     */
    readonly onEvent?: (event: AssistantLoopEvent) => void;
}

export interface AssistantToolLoopUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
}

export interface AssistantToolLoopResult {
    /** Final assistant answer text. */
    readonly finalText: string;
    /** Summarized model reasoning across rounds, when the backend produced it. */
    readonly thinking?: string;
    /** De-duplicated card-worthy media surfaced across all tool calls. */
    readonly mediaForCards: AssistantMovieRow[];
    /** De-duplicated music cards surfaced across all tool calls. */
    readonly musicForCards: RecommendedMusic[];
    /** Summed token usage across every round. */
    readonly usage: AssistantToolLoopUsage;
    /** Number of model round-trips performed. */
    readonly rounds: number;
    /** Total number of tool invocations executed. */
    readonly toolCallCount: number;
    /** Names of every tool actually executed, in execution order (for logging). */
    readonly toolNames: string[];
}

/**
 * Thrown when the caller's AbortSignal fires mid-loop, or a provider call fails
 * after at least one round completed. Carries the token usage of the rounds
 * that COMPLETED so the caller can still record it against the daily budget —
 * completed rounds were billed by the provider, so treating the run as free
 * would make abort-and-retry (or a late failure) a budget bypass. The original
 * provider error is preserved as `cause`.
 */
export class AssistantLoopAbortedError extends Error {
    readonly usage: AssistantToolLoopUsage;
    readonly rounds: number;
    constructor(cause: unknown, usage: AssistantToolLoopUsage, rounds: number) {
        super('Assistant tool loop aborted', { cause });
        this.name = 'AssistantLoopAbortedError';
        this.usage = usage;
        this.rounds = rounds;
    }
}

/**
 * Tool-call budget. A model may emit any number of calls in one round and a
 * round runs them in parallel: unbounded, one prompt fans out into dozens of
 * embedding calls + vector queries per round, or a bulk write storm. Calls over
 * the budget are answered with an error the model can read, not executed.
 */
const MAX_TOOL_CALLS_PER_ROUND = 8;
const MAX_TOOL_CALLS_PER_INVOCATION = 16;
/** Own-data writes (watchlist, rating, watched, request) per invocation. */
const MAX_WRITE_CALLS_PER_INVOCATION = 3;

const DEFAULT_MAX_COMPLETION_TOKENS = 4000;
// Each round re-sends the growing context; 3 covers the vast majority of
// queries (1 lookup + 1 follow-up + a final answer) while capping the
// cumulative-token blowup of long tool chains.
const DEFAULT_MAX_ROUNDS = 3;

/** Composite-key de-dup so the same title can't card twice. */
function mediaKey(row: AssistantMovieRow): string {
    if (row.primary_ext_id) return `${row.primary_ext_id}:${row.media_type}`;
    return String(row.media_id ?? `${row.title}:${row.media_type}`);
}

/** De-dup music by its UUID + type. */
function musicKey(row: RecommendedMusic): string {
    return `${row.id}:${row.mediaType}`;
}

/**
 * Run the tool-calling loop and return the final answer plus the media to
 * render as cards. Never throws for individual tool failures — a failing tool
 * reports its error back to the model and the loop continues.
 */
export async function runAssistantToolLoop(
    options: AssistantToolLoopOptions,
): Promise<AssistantToolLoopResult> {
    const {
        provider,
        systemPrompt,
        userMessage,
        history,
        untrustedHistory = false,
        tools,
        ctx,
        maxCompletionTokens = DEFAULT_MAX_COMPLETION_TOKENS,
        maxRounds = DEFAULT_MAX_ROUNDS,
        suppressThinking,
        logger,
        signal,
        onEvent,
    } = options;
    const chatOpts = signal ? { signal } : undefined;

    // One id per call to runAssistantToolLoop (one HTTP request / user turn),
    // threaded onto every tool's ctx for this invocation — see P5's confirm
    // gate (confirm-gate.ts) and AssistantToolContext.invocationId's docstring.
    const invocationId = randomUUID();
    const toolCtx: AssistantToolContext = { ...ctx, invocationId };

    // One model round-trip. When a progress sink is attached we stream (so text
    // and thinking deltas surface live) — the resolved ChatResult is identical
    // in shape to the non-streaming path. Otherwise we run the plain call.
    const runModel = async (req: ChatRequest): Promise<ChatResult> => {
        try {
            if (onEvent) {
                return await provider.createChatStream(req, {
                    ...(signal ? { signal } : {}),
                    onDelta: (delta) => onEvent(delta),
                });
            }
            return await provider.createChat(req, chatOpts);
        } catch (err) {
            // Abort mid-round: hand the caller the usage of the rounds that DID
            // complete (billed by the provider) so it can record them against
            // the daily budget. The aborted round itself never returned usage.
            // A provider failure in a later round (5xx/429/overloaded) leaves the
            // earlier, completed rounds billed too: hand their usage to the
            // caller the same way. A first-round failure carries no usage and
            // stays the raw provider error.
            if (signal?.aborted || inputTokens + outputTokens > 0) {
                throw new AssistantLoopAbortedError(
                    err,
                    { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
                    rounds,
                );
            }
            throw err;
        }
    };

    const toolDefs = buildNeutralToolDefs(tools);
    const toolsByName = new Map<string, AssistantTool>(tools.map((t) => [t.name, t]));

    const messages: NeutralMessage[] = [
        // Prior conversation turns for follow-ups ("yes", "the first one", …).
        // Prior USER turns are fenced in <user_message> exactly like the live
        // message so an injection planted earlier in the history can't act as
        // instructions on a later turn; assistant turns stay raw.
        ...(history ?? []).map((turn): NeutralMessage =>
            turn.role === 'user'
                ? {
                      role: 'user',
                      content: fenceUntrusted(
                          untrustedHistory ? 'untrusted_history' : 'user_message',
                          turn.content,
                      ),
                  }
                : { role: 'assistant', content: turn.content },
        ),
        {
            role: 'user',
            // Fence the raw user input so the model treats it as data, not
            // instructions (prompt-injection defense, finding F5). Escaped
            // so a message containing the literal string `</user_message>`
            // can't break out of the fence (final fix wave, 2026-09-13).
            content: `<user_message>\n${escapeFenceDelimiters(userMessage, 'user_message')}\n</user_message>`,
        },
    ];

    const mediaByKey = new Map<string, AssistantMovieRow>();
    const musicByKey = new Map<string, RecommendedMusic>();
    const thinkingParts: string[] = [];
    const executedToolNames: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCallCount = 0;
    let rounds = 0;
    let usageMissingWarned = false;
    let admittedCalls = 0;
    let admittedWrites = 0;

    // Some OpenAI-compatible/local backends omit `usage`. Without it the daily
    // token budget silently undercounts (and can be bypassed). Warn once so the
    // gap is observable rather than invisible.
    const warnIfNoUsage = (missing: boolean): void => {
        if (missing && !usageMissingWarned) {
            usageMissingWarned = true;
            logger?.warn(
                'Chat completion returned no usage data; assistant token budget will undercount for this backend',
            );
        }
    };

    /**
     * Cards ordered by what the answer actually recommends: titles the model
     * cited via `(ref:...)` links come FIRST, in mention order (the ref format
     * `primary_ext_id:media_type` equals {@link mediaKey}); the remaining
     * card-worthy rows follow newest-tool-result-first. Without this, a
     * follow-up turn whose tools re-return earlier items buries the fresh
     * suggestions at the end of the rail.
     */
    const orderCardsByMention = (finalText: string): AssistantMovieRow[] => {
        const mentionRank = new Map<string, number>();
        for (const match of finalText.matchAll(/\(ref:([^)\s]+)\)/g)) {
            if (!mentionRank.has(match[1])) mentionRank.set(match[1], mentionRank.size);
        }
        const mentioned: AssistantMovieRow[] = [];
        const rest: AssistantMovieRow[] = [];
        for (const row of mediaByKey.values()) {
            (mentionRank.has(mediaKey(row)) ? mentioned : rest).push(row);
        }
        mentioned.sort(
            (a, b) => (mentionRank.get(mediaKey(a)) ?? 0) - (mentionRank.get(mediaKey(b)) ?? 0),
        );
        rest.reverse();
        return [...mentioned, ...rest];
    };

    const finalize = (finalText: string): AssistantToolLoopResult => ({
        finalText,
        thinking: thinkingParts.length > 0 ? thinkingParts.join('\n\n') : undefined,
        mediaForCards: orderCardsByMention(finalText),
        musicForCards: [...musicByKey.values()],
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        rounds,
        toolCallCount,
        toolNames: executedToolNames,
    });

    /**
     * Resolve ONE tool call: validate args (the prompt-injection boundary),
     * execute, and return a self-contained outcome. Pure per-call so the round's
     * calls can run in parallel; the caller appends results in the ORIGINAL
     * order for determinism.
     */
    interface ToolOutcome {
        readonly toolCallId: string;
        readonly name: string;
        /** Message content to feed back to the model. */
        readonly content: string;
        readonly media?: readonly AssistantMovieRow[];
        readonly music?: readonly RecommendedMusic[];
        /** Whether tool.execute actually ran (validation/JSON failures don't). */
        readonly executed: boolean;
    }

    const resolveToolCall = async (toolCall: {
        id: string;
        name: string;
        argumentsJson: string;
    }): Promise<ToolOutcome> => {
        const { name, argumentsJson } = toolCall;
        const tool = toolsByName.get(name);
        if (!tool) {
            return {
                toolCallId: toolCall.id,
                name,
                content: `Error: unknown tool "${name}".`,
                executed: false,
            };
        }

        // P5 (3): refuse a write tool once at least one tool result has
        // already entered the model's context (round > 1, i.e. this is not
        // the FIRST model round-trip of this invocation). Round 1 is the only
        // round guaranteed to run before any tool-sourced text (which can
        // carry an injected instruction — a hostile guide listing, overview,
        // or an earlier round's own tool result) exists in the conversation,
        // so it is the only round a write tool may fire from. `create_request`
        // is a WRITE_TOOL_NAMES member too — see that set's docstring for why
        // that does not affect its own legitimate two-turn confirm flow.
        if (rounds > 1 && WRITE_TOOL_NAMES.has(name)) {
            return {
                toolCallId: toolCall.id,
                name,
                content: JSON.stringify({
                    ok: false,
                    reason: 'confirmation_required',
                    note: `"${name}" was refused: a write tool cannot be called after a tool result has already entered this conversation. Ask the user to confirm this action, then call "${name}" again in their NEXT message.`,
                }),
                executed: false,
            };
        }

        let parsedArgs: unknown;
        try {
            parsedArgs = argumentsJson ? JSON.parse(argumentsJson) : {};
        } catch {
            // best-effort: malformed LLM-produced tool args are reported back to the model, not swallowed.
            return {
                toolCallId: toolCall.id,
                name,
                content: `Error: arguments for "${name}" were not valid JSON.`,
                executed: false,
            };
        }

        const validation = tool.argsSchema.safeParse(parsedArgs);
        if (!validation.success) {
            // Zod messages are safe to surface — they help the model self-correct.
            return {
                toolCallId: toolCall.id,
                name,
                content: `Error: invalid arguments for "${name}": ${validation.error.message}`,
                executed: false,
            };
        }

        onEvent?.({ type: 'tool_start', name, round: rounds });
        const startedAt = Date.now();
        try {
            const toolResult = await tool.execute(validation.data, toolCtx);
            const ms = Date.now() - startedAt;
            onEvent?.({ type: 'tool_end', name, ok: true, ms });
            logger?.info('Assistant tool call', {
                tool: name,
                args: JSON.stringify(validation.data).slice(0, 300),
                ms,
                resultChars: toolResult.summaryForModel.length,
                media: (toolResult.media ?? []).length,
                music: (toolResult.music ?? []).length,
            });
            return {
                toolCallId: toolCall.id,
                name,
                content: toolResult.summaryForModel,
                media: toolResult.media,
                music: toolResult.music,
                executed: true,
            };
        } catch (err) {
            const ms = Date.now() - startedAt;
            const msg = err instanceof Error ? err.message : String(err);
            // Full detail to the log; a GENERIC message to the model — err.message
            // can carry SQL / internal details that must not reach the LLM.
            logger?.warn('Assistant tool execution failed', { tool: name, error: msg, ms });
            onEvent?.({ type: 'tool_end', name, ok: false, ms });
            return {
                toolCallId: toolCall.id,
                name,
                content: `Error: tool "${name}" failed.`,
                executed: true,
            };
        }
    };

    for (let round = 0; round < maxRounds; round++) {
        rounds = round + 1;
        onEvent?.({ type: 'round', round: rounds });
        const result = await runModel({
            system: systemPrompt,
            messages,
            tools: toolDefs,
            toolChoice: 'auto',
            maxOutputTokens: maxCompletionTokens,
            suppressThinking,
        });

        warnIfNoUsage(result.usageMissing);
        inputTokens += result.usage.inputTokens;
        outputTokens += result.usage.outputTokens;
        if (result.thinking) thinkingParts.push(result.thinking);

        if (result.toolCalls.length === 0) {
            return finalize(result.text);
        }

        // Model wants to call tools — append its turn (replayed verbatim so a
        // thinking backend keeps its blocks), then resolve each call.
        messages.push({
            role: 'assistant_tools',
            toolCalls: result.toolCalls,
            providerRaw: result.providerRaw,
        });

        // Execute this round's calls in PARALLEL, but append tool-result
        // messages and merge media/music in the ORIGINAL call order so the
        // conversation the model sees next is deterministic.
        const outcomes = await Promise.all(
            result.toolCalls.map((tc, index) => {
                const overRound = index >= MAX_TOOL_CALLS_PER_ROUND;
                const overInvocation = admittedCalls >= MAX_TOOL_CALLS_PER_INVOCATION;
                const isWrite = WRITE_TOOL_NAMES.has(tc.name);
                const overWrites = isWrite && admittedWrites >= MAX_WRITE_CALLS_PER_INVOCATION;
                if (overRound || overInvocation || overWrites) {
                    return Promise.resolve<ToolOutcome>({
                        toolCallId: tc.id,
                        name: tc.name,
                        content: overWrites
                            ? `Error: "${tc.name}" was not run: too many changes to the user's data in one message. Tell the user what was done and ask them to continue in a new message.`
                            : `Error: "${tc.name}" was not run: too many tool calls in this request. Answer with what you already have.`,
                        executed: false,
                    });
                }
                admittedCalls++;
                if (isWrite) admittedWrites++;
                return resolveToolCall(tc);
            }),
        );
        for (const outcome of outcomes) {
            if (outcome.executed) {
                toolCallCount++;
                executedToolNames.push(outcome.name);
            }
            for (const row of outcome.media ?? []) {
                mediaByKey.set(mediaKey(row), row);
            }
            for (const row of outcome.music ?? []) {
                musicByKey.set(musicKey(row), row);
            }
            messages.push({
                role: 'tool',
                toolCallId: outcome.toolCallId,
                // Fenced (P5) so the model treats it as data, mirroring
                // <user_message> — a tool result can carry attacker-influenced
                // text (an EPG/book/guide entry, a hostile overview).
                content: fenceToolResult(outcome.name, outcome.content),
            });
        }
    }

    // Round cap hit while still wanting tools — force a final textual answer.
    logger?.info('Assistant tool loop hit round cap; forcing final answer', { maxRounds });
    rounds += 1;
    onEvent?.({ type: 'round', round: rounds });
    const forced = await runModel({
        system: systemPrompt,
        messages,
        // Pass the tools but forbid calling them, so the model must produce
        // a final textual answer.
        tools: toolDefs,
        toolChoice: 'none',
        maxOutputTokens: maxCompletionTokens,
        suppressThinking,
    });
    warnIfNoUsage(forced.usageMissing);
    inputTokens += forced.usage.inputTokens;
    outputTokens += forced.usage.outputTokens;
    if (forced.thinking) thinkingParts.push(forced.thinking);
    // `rounds` was already bumped (and the round event emitted) before the
    // forced call above.

    return finalize(forced.text);
}
