// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AGPL-core registry for the optional AI assistant.
 *
 * This is the seam between the core and the assistant pipeline
 * (`src/lib/server/assistant/assistant-service.ts`), mirroring
 * `auth/jellyfin-compat-revocation.ts`: the core never imports the assistant
 * tree. Instead the assistant module registers itself here via
 * {@link registerAiAssistantProvider}, at boot.
 *
 * When the assistant tree is absent (a build with it deleted), nothing registers and
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
 * this AGPL file stays decoupled from the assistant's `UserContext` shape — but
 * the nullability MUST be preserved so callers fail closed instead of
 * dereferencing `null`.
 */
type ResolvedUser = NonNullable<unknown> | null;

/**
 * The narrow contract the assistant registers. Intentionally
 * structural (inputs/deps typed `unknown`) so the AGPL core never references a
 * assistant type. The bridge (`tasks/plugin-ai-surface.ts`) adapts this into
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
 * Called by the assistant module on load to wire itself in.
 * (module → core direction, which the boundary permits.)
 */
export function registerAiAssistantProvider(p: AiAssistantProvider): void {
    provider = p;
}

/** The registered assistant provider, or `null` in AGPL-only builds. */
export function getAiAssistantProvider(): AiAssistantProvider | null {
    return provider;
}
