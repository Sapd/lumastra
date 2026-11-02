// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Chat API with RAG (Retrieval-Augmented Generation)
 *
 * The orchestration (entitlement gate, age block, token budget, RAG tool-loop
 * vs single-shot, persistence, cost recording) lives in the proprietary
 * `assistant-service.ts` so the same pipeline backs both this route and the
 * optional `ctx.ai` plugin bridge. This handler is a thin shell: auth + db
 * checks, then `runAssistant`, mapping its typed throws back to HTTP responses
 * and its result to the existing JSON shape.
 */
import type { RequestHandler } from './$types';
import { typedJson } from '$lib/server/utils/typed-response.js';
import {
    ChatMessageResponseSchema,
    ChatRateLimitResponseSchema,
} from '$lib/schemas/api-ai-responses.js';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getAiConfig } from '$lib/server/config/domains/ai.js';
import { getDailyTokenUsage } from '$lib/server/database/queries/assistant-rag.queries.js';
import { withValidation } from '$lib/server/middleware/validate';
import { chatMessageBodySchema } from '$lib/schemas/ai';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { AiUnavailableError } from '@sapd/lumastra-plugin-sdk';
import {
    runAssistant,
    AssistantTokenBudgetError,
} from '$lib/server/proprietary/assistant-service.js';
import {
    admitAssistantRun,
    AssistantAdmissionError,
    type AssistantAdmission,
} from '$lib/server/proprietary/assistant-admission.js';
import type { AssistantLoopEvent } from '$lib/server/proprietary/assistant-tools/dispatch.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('AIAssistant');

/** True when an error message signals a missing chat provider API key. */
function isMissingApiKey(msg: string, provider: 'openai' | 'anthropic'): boolean {
    return provider === 'openai'
        ? msg.includes('OPENAI_API_KEY') || msg.includes('OPENAI_CHAT_API_KEY')
        : msg.includes('ANTHROPIC_API_KEY');
}

/**
 * Map an assistant pipeline throw to a client-safe {message, status}. Shared by
 * the JSON and SSE error paths so both surface identical, non-leaky errors.
 */
function mapAssistantError(err: unknown): { message: string; status: number } {
    if (err instanceof AiUnavailableError) return { message: err.message, status: 403 };
    if (err instanceof AssistantTokenBudgetError) return { message: err.message, status: 429 };
    const msg = err instanceof Error ? err.message : String(err);
    if (isMissingApiKey(msg, 'openai')) {
        return { message: 'OpenAI chat API key not configured', status: 503 };
    }
    if (isMissingApiKey(msg, 'anthropic')) {
        return { message: 'Anthropic API key not configured', status: 503 };
    }
    // Never reflect raw internals — they're logged, not returned.
    return { message: 'Internal server error', status: 500 };
}

/** True for a client-disconnect / caller-abort (logged as info, not an error). */
function isAbortError(err: unknown): boolean {
    return err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError');
}

/** Build the JSON/`done`-event payload from a runAssistant result. */
function buildChatPayload(result: Awaited<ReturnType<typeof runAssistant>>) {
    return {
        response: result.text,
        thinking: result.thinking,
        recommendedMovies: result.recommendedMovies,
        recommendedMusic: result.recommendedMusic,
        usage: {
            tokens: result.usage.tokens,
            costUsd: result.usage.costUsd,
            responseTimeMs: result.responseTimeMs,
        },
        rateLimit: result.rateLimit,
        context: result.context,
    };
}

export const POST: RequestHandler = withErrorHandler(
    withValidation(
        async ({ validated, locals, request }) => {
            // 1. Check authentication
            if (!locals.user?.username) {
                return ApiResponses.unauthorized('Authentication required');
            }
            const user = locals.user;
            // The budget tier and admin tools take the CREDENTIAL's verdict: a
            // scoped token of an admin owner is not admin here.
            const isAdmin = localsIsAdmin(locals);

            const sqlDb = getDb();
            if (!sqlDb) {
                return ApiResponses.serviceUnavailable('AI database');
            }
            const sql = sqlDb; // Non-nullable after check

            // 2. Get validated message + streaming preference
            const { message, history, stream } = validated.body;
            const acceptsSse = (request.headers.get('accept') || '').includes('text/event-stream');
            const wantsStream = stream === true || acceptsSse;

            // 3. Per-user RPM limit + in-flight slot (cheap gate before any
            // expensive work). Admitted here, not inside runAssistant, so a refusal
            // is a plain 429 and never an SSE stream that opens and then errors;
            // the ticket is handed to runAssistant so it does not admit twice.
            let slot: AssistantAdmission;
            try {
                slot = await admitAssistantRun(user.userId);
            } catch (err) {
                if (err instanceof AssistantAdmissionError) {
                    return err.kind === 'rate_limited'
                        ? ApiResponses.rateLimited(
                              err.resetAt === undefined ? undefined : err.resetAt * 1000,
                              '/api/assistant',
                          )
                        : ApiResponses.rateLimited(
                              undefined,
                              '/api/assistant - too many concurrent',
                          );
                }
                throw err;
            }

            // Abort signal: cancels the LLM round-trip on client disconnect.
            // A LINKED controller, not request.signal directly: some dev/proxy
            // setups (vite dev, buffering proxies) never fire request.signal on
            // disconnect, but the SSE ReadableStream's cancel() callback does —
            // so both sources abort the ONE signal the pipeline sees, and the
            // loop's partial-usage accounting runs either way.
            const abort = new AbortController();
            const signal = abort.signal;
            if (request.signal.aborted) {
                abort.abort();
            } else {
                request.signal.addEventListener('abort', () => abort.abort(), { once: true });
            }

            // Release the concurrency slot at most once (start()'s finally and a
            // client-disconnect cancel() can both fire — never double-decrement).
            let slotReleased = false;
            const releaseSlot = async (): Promise<void> => {
                if (slotReleased) return;
                slotReleased = true;
                await slot.release();
            };

            // ── SSE streaming path ─────────────────────────────────────────────
            if (wantsStream) {
                const encoder = new TextEncoder();
                // Set by cancel() (client disconnect) and by the enqueue guard —
                // a delta racing the close must be dropped, not crash the run
                // with "Controller is already closed".
                let streamClosed = false;
                const body = new ReadableStream<Uint8Array>({
                    async start(controller) {
                        const send = (eventName: string, data: unknown): void => {
                            if (streamClosed) return;
                            try {
                                controller.enqueue(
                                    encoder.encode(
                                        `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`,
                                    ),
                                );
                            } catch {
                                // Closed between the flag check and the enqueue —
                                // stop emitting; the abort ends the run itself.
                                streamClosed = true;
                            }
                        };
                        try {
                            const result = await runAssistant(
                                { message, history },
                                {
                                    user,
                                    isAdmin,
                                    sql,
                                    signal,
                                    admission: slot,
                                    onEvent: (ev: AssistantLoopEvent) => {
                                        switch (ev.type) {
                                            case 'round':
                                                send('status', {
                                                    phase: 'model',
                                                    round: ev.round,
                                                });
                                                break;
                                            case 'tool_start':
                                                send('status', {
                                                    phase: 'tool',
                                                    tool: ev.name,
                                                    round: ev.round,
                                                });
                                                break;
                                            case 'text':
                                                send('text', { delta: ev.delta });
                                                break;
                                            case 'thinking':
                                                send('thinking', { delta: ev.delta });
                                                break;
                                            // tool_end carries no protocol event.
                                        }
                                    },
                                },
                            );
                            // Validate the terminal payload against the SAME schema
                            // the JSON path uses. NON-FATAL on mismatch: the
                            // answer already streamed, and the prod JSON path
                            // (typedJson) never validates — killing the stream
                            // over schema drift would fail the user over a
                            // payload the JSON path would have served. Log it
                            // loudly and send the unvalidated payload instead.
                            const raw = buildChatPayload(result);
                            const parsed = ChatMessageResponseSchema.safeParse(raw);
                            if (!parsed.success) {
                                logger.error(
                                    'Chat done-payload failed schema validation (sent unvalidated)',
                                    new Error(parsed.error.message),
                                );
                            }
                            send('done', parsed.success ? parsed.data : raw);
                        } catch (err) {
                            if (isAbortError(err) || signal.aborted) {
                                logger.info('Chat stream aborted by client');
                            } else {
                                logger.error(
                                    'Chat stream error',
                                    err instanceof Error ? err : new Error(String(err)),
                                );
                                const { message: emsg, status } = mapAssistantError(err);
                                send('error', { message: emsg, status });
                            }
                        } finally {
                            await releaseSlot();
                            streamClosed = true;
                            try {
                                controller.close();
                            } catch {
                                // Already closed by cancel() — nothing to do.
                            }
                        }
                    },
                    async cancel() {
                        // Client disconnected mid-stream — stop emitting, cancel
                        // the in-flight LLM work (this is the reliable disconnect
                        // path; request.signal may never fire), release the slot.
                        streamClosed = true;
                        abort.abort();
                        await releaseSlot();
                    },
                });

                return new Response(body, {
                    headers: {
                        'content-type': 'text/event-stream',
                        'cache-control': 'no-cache',
                        'x-accel-buffering': 'no',
                    },
                });
            }

            // ── Non-streaming JSON path (byte-for-byte unchanged shape) ─────────
            try {
                const result = await runAssistant(
                    { message, history },
                    { user, isAdmin, sql, signal, admission: slot },
                );
                return typedJson(ChatMessageResponseSchema, buildChatPayload(result));
            } catch (err) {
                // Age-restricted / unlicensed → 403 (same as before).
                if (err instanceof AiUnavailableError) {
                    return ApiResponses.forbidden(err.message);
                }
                // Over daily token budget → 429 (same message as before).
                if (err instanceof AssistantTokenBudgetError) {
                    return ApiResponses.rateLimited(undefined, `/api/assistant - ${err.message}`);
                }
                // Already a Response — return it.
                if (err instanceof Response) {
                    return err;
                }

                // Client disconnect: log as info, not an error.
                if (isAbortError(err) || signal.aborted) {
                    logger.info('Chat request aborted by client');
                    return new Response(null, { status: 499 });
                }

                const errorMessage = err instanceof Error ? err.message : String(err);
                logger.error('Chat error', err instanceof Error ? err : new Error(String(err)));

                if (isMissingApiKey(errorMessage, 'openai')) {
                    return ApiResponses.serviceUnavailable(
                        'AI chat',
                        'OpenAI chat API key not configured',
                    );
                }
                if (isMissingApiKey(errorMessage, 'anthropic')) {
                    return ApiResponses.serviceUnavailable(
                        'AI chat',
                        'Anthropic API key not configured',
                    );
                }

                // Do NOT reflect the raw error message to the client — it can
                // carry provider/internal details (already logged above).
                return ApiResponses.error(
                    'Internal server error',
                    err instanceof Error ? err : undefined,
                );
            } finally {
                await releaseSlot();
            }
        },
        { body: chatMessageBodySchema },
    ),
);

/**
 * GET endpoint to check rate limit status
 */
export const GET: RequestHandler = withErrorHandler(async ({ locals }) => {
    try {
        if (!locals.user?.username) {
            return ApiResponses.unauthorized('Authentication required');
        }

        const userId = locals.user.userId;
        // The RESOLVED verdict, matching the budget tier runAssistant charges
        // against. Group-derived admin misses the `admin_pinned` override and the
        // in-app `admin` capability, so a pinned admin was quoted the user limit.
        const userIsAdmin = localsIsAdmin(locals);
        const ai = getAiConfig();
        // Limit is by TOKEN budget, not message count.
        const tokenBudget = userIsAdmin
            ? ai.assistantDailyTokenLimitAdmin
            : ai.assistantDailyTokenLimitUser;

        const sqlDb = getDb();
        if (!sqlDb) {
            return ApiResponses.serviceUnavailable('AI database');
        }
        const sql = sqlDb; // Non-nullable after check

        const tokensToday = await getDailyTokenUsage(sql, userId);
        const remainingTokens = Math.max(0, tokenBudget - tokensToday);

        // Calculate next reset time (midnight tomorrow in server timezone)
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);

        return typedJson(ChatRateLimitResponseSchema, {
            userId,
            isAdmin: userIsAdmin,
            limit: tokenBudget,
            used: tokensToday,
            remaining: remainingTokens,
            resetsAt: tomorrow.toISOString(),
        });
    } catch (err) {
        logger.error('Status check error', err instanceof Error ? err : new Error(String(err)));

        // Handle specific error types - if it's already a Response, return it
        if (err instanceof Response) {
            return err;
        }

        // Generic client message; raw detail is logged above, not reflected.
        return ApiResponses.error('Internal server error', err instanceof Error ? err : undefined);
    }
});
