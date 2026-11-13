// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AGPL-core registry for the optional, PROPRIETARY AI assistant.
 *
 * This is the clean license boundary between the AGPL core and the proprietary
 * assistant pipeline (`src/lib/server/proprietary/assistant-service.ts`),
 * mirroring `licensing/entitlements.ts`: the core NEVER imports the proprietary
 * tree (the `check-license-boundary` CI gate forbids it, in any import form).
 * Instead the proprietary module, when present (official build), registers
 * itself here via {@link registerAiAssistantProvider} — proprietary → core,
 * the direction the boundary permits.
 *
 * When the proprietary tree is absent (an AGPL-only build — anyone may delete
 * the proprietary dirs and rebuild, per LICENSING.md §3), nothing registers and
 * {@link getAiAssistantProvider} returns `null`, so `ctx.ai` is simply not
 * offered to plugins.
 *
 * The registration happens in `boot/compat-init.ts` (`ensureCompatLoaded()`),
 * which every process that needs the assistant calls.
 */
import type postgres from 'postgres';

/**
 * A resolved user context, or `null` when the username has no resolvable row
 * (deleted/unsynced user, or DB unreachable). Kept structural (`unknown`) so
 * this AGPL file stays decoupled from the proprietary `UserContext` shape — but
 * the nullability MUST be preserved so callers fail closed instead of
 * dereferencing `null`.
 */
type ResolvedUser = NonNullable<unknown> | null;

/**
 * The narrow contract the proprietary assistant registers. Intentionally
 * structural (inputs/deps typed `unknown`) so the AGPL core never references a
 * proprietary type. The bridge (`tasks/plugin-ai-surface.ts`) adapts this into
 * the SDK `ctx.ai` surface.
 */
export interface AiAssistantProvider {
    runAssistant: (
        input: unknown,
        deps: unknown,
    ) => Promise<{
        text: string;
        recommendedMedia: Array<{ id: string; mediaType: string }>;
        usage: { tokens: number; costUsd: number };
    }>;
    resolveUser: (sql: postgres.Sql, username: string) => Promise<ResolvedUser>;
}

let provider: AiAssistantProvider | null = null;

/**
 * Called by the proprietary assistant module on load to wire itself in.
 * (proprietary → core direction, which the boundary permits.)
 */
export function registerAiAssistantProvider(p: AiAssistantProvider): void {
    provider = p;
}

/** The registered proprietary assistant provider, or `null` in AGPL-only builds. */
export function getAiAssistantProvider(): AiAssistantProvider | null {
    return provider;
}
