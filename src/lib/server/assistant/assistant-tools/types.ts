// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared contract for AI-assistant tools (agentic RAG).
 *
 * Every tool is a thin, access-scoped wrapper over an EXISTING query module.
 * Tools never build raw SQL and never receive the raw SQL connection without
 * the access context — `AssistantToolContext` bundles the per-request access
 * boundary (`accessCtx`) that scoped queries require, so a tool physically
 * cannot return out-of-scope titles as long as it threads `accessCtx`
 * through to its backing query.
 *
 * @module server/assistant/assistant-tools/types
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import type { z } from 'zod';
import type { SearchAccessContext } from '../../utils/search-access-context.js';
import type { UserContext } from '../../types.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';
import type { RecommendedMusic } from '../../../schemas/assistant-types.js';

/**
 * Minimal logger surface tools may use. Optional so tools stay unit-testable
 * without wiring a real logger.
 */
export interface AssistantToolLogger {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Everything a tool needs to execute against the user's accessible data.
 * Built ONCE per assistant request and passed to every tool invocation.
 */
export interface AssistantToolContext {
    /** Web-tier connection (getDb()), non-null. */
    readonly sql: postgres.Sql;
    /** Calling user's stable users.id UUID (the user-scope key for all per-user queries). */
    readonly userId: UserId;
    /** Whether the caller is an admin (gates admin-only behaviour, if any). */
    readonly userIsAdmin: boolean;
    /**
     * Caller's groups + watch-permission flag — needed by tools that reuse
     * permission helpers keyed on groups (e.g. `get_active_streams`, which
     * defers to the shared session-visibility pipeline). Optional so existing
     * tests need not supply them.
     */
    readonly userGroups?: string[];
    readonly hasWatchPermission?: boolean;
    /** Caller may use consented cross-user watch-history data. Defaults to false. */
    readonly socialWatchHistoryViewable?: boolean;
    /** Library/age access boundary — thread into every scoped query. */
    readonly accessCtx: SearchAccessContext;
    /**
     * The full caller principal. REQUIRED, not optional: every mutation service
     * (`resolveAndGate`, `watched-state-ops`, `ratingManager.recordRating`)
     * takes a `UserContext`, and `resolveAndGate` turns a missing one into a
     * bare `MediaAccessDeniedError` — which a write tool must report as
     * "not found". A wiring slip would therefore look like a mystery missing
     * title rather than a bug, so the type system carries the obligation
     * instead. In restricted (plugin-bridge) mode this is the DE-ESCALATED
     * principal, never the raw viewer.
     */
    readonly user: UserContext;
    /**
     * Whether this run may mutate user state at all. False for the plugin
     * `ctx.ai` bridge: a plugin's prompt must not be able to steer the model
     * into rating or watchlisting against the viewer's real account.
     *
     * The PRIMARY gate is absence — `buildAssistantTools` does not register the
     * write tools when this is false, so the model never sees them. This flag
     * is the second line: a write tool re-checks it, so registering one
     * unconditionally by mistake still cannot mutate a restricted caller's data.
     */
    readonly writesAllowed: boolean;
    /**
     * Embed a free-text query into a pgvector literal string
     * (e.g. "[0.1,0.2,...]"), used by semantic search tools. Injected so
     * tests can stub it without calling Voyage.
     */
    readonly embedQuery: (text: string) => Promise<string>;
    /** Optional logger. */
    readonly logger?: AssistantToolLogger;
    /**
     * Identifies ONE call to `runAssistantToolLoop` (i.e. one HTTP request /
     * user turn) — minted once by `dispatch.ts` and threaded onto every
     * tool's `ctx` for that invocation, so every round of the SAME loop call
     * shares the same value. `create_request`'s hard confirm gate
     * (`confirm-gate.ts`) uses it to tell "the user confirmed in a genuinely
     * LATER turn" apart from "the model called confirmed:false then
     * confirmed:true inside one turn" (P5).
     *
     * Optional because it only exists when a tool runs through the real
     * dispatch loop — absent when a test calls `tool.execute()` directly, in
     * which case gates keyed on it are inapplicable (there is no round/turn
     * to compare against) and treat that as "gate does not apply here", not
     * as an automatic pass on identity.
     */
    readonly invocationId?: string;
}

/**
 * The result of executing a tool.
 *
 * - `summaryForModel` is the text fed back to the model in the `tool`
 *   message. Keep it compact and factual (often JSON.stringify of summaries).
 * - `media` is the set of concrete library rows the tool surfaced, if any.
 *   The route collects these across all tool calls to build recommended
 *   cards directly — replacing the old regex round-trip. Tools that return
 *   no card-worthy media (stats, history) omit it.
 */
export interface AssistantToolExecuteResult {
    readonly summaryForModel: string;
    readonly media?: AssistantMovieRow[];
    /**
     * Client-ready music cards (tracks/albums/artists). Aggregated separately
     * from `media` (movie/tv) and returned as `recommendedMusic`.
     */
    readonly music?: RecommendedMusic[];
}

/**
 * A registered assistant tool. `TArgs` is inferred from `argsSchema`, which
 * is BOTH the OpenAI parameter schema (via `z.toJSONSchema`) and the runtime
 * validator the dispatch loop applies to the model's `tool_calls.arguments`.
 */
export interface AssistantTool<TArgs = unknown> {
    /** Canonical tool name (see `ASSISTANT_TOOL_NAMES`). */
    readonly name: string;
    /** Human/model-facing description of when to use the tool. */
    readonly description: string;
    /** Zod schema for the tool's arguments (SSOT). */
    readonly argsSchema: z.ZodType<TArgs>;
    /** Execute the tool with validated args against the request context. */
    execute(args: TArgs, ctx: AssistantToolContext): Promise<AssistantToolExecuteResult>;
}
