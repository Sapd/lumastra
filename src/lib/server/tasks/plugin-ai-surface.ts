// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Optional `ctx.ai` bridge.
 *
 * The AI assistant pipeline is PROPRIETARY (`proprietary/assistant-service.ts`).
 * This file is AGPL core, so — per the license-boundary gate — it must NEVER
 * import the proprietary tree (in any form, including dynamic `import()`).
 * Instead it reaches the assistant through the AGPL-core registry
 * (`ai/assistant-provider.ts`), into which the proprietary module registers
 * itself at boot via the sanctioned optional-load path
 * (`entitlements.ensureProprietaryLoaded()` → `proprietary/licensing/init.ts`).
 * In an AGPL-only build the proprietary tree is absent, nothing registers, the
 * registry returns `null`, and `buildAiSurface` returns `undefined` so `ctx.ai`
 * is simply not offered.
 */
import { AuthDependencyUnavailableError } from '$lib/server/auth/dependency-error.js';
import { AiUnavailableError, type PluginContext, type PluginUser } from '@sapd/lumastra-plugin-sdk';
import type postgres from 'postgres';
import {
    getAiAssistantProvider,
    type AiAssistantProvider,
} from '$lib/server/ai/assistant-provider.js';
import { ensureProprietaryLoaded } from '$lib/server/licensing/entitlements.js';

/**
 * Same bounds the HTTP entry point enforces via `chatMessageBodySchema`
 * (`src/lib/schemas/ai.ts`). The plugin `ctx.ai.ask` bridge bypasses that Zod
 * gate, so re-assert them here — otherwise a plugin could send an empty prompt,
 * a multi-MB prompt, or thousands of history turns straight into the model
 * (unbounded cost + oversized-context API errors).
 */
const MAX_PROMPT_CHARS = 5000;
const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CONTENT_CHARS = 6000;

/**
 * Default loader: trigger the sanctioned proprietary optional-load (so
 * `init.ts` registers the provider if the tree is present), then read it from
 * the AGPL registry. Returns `null` in AGPL-only builds. No `proprietary/`
 * import here — that would trip the license-boundary gate.
 */
async function defaultLoader(): Promise<AiAssistantProvider | null> {
    await ensureProprietaryLoaded();
    return getAiAssistantProvider();
}

export async function buildAiSurface(
    sql: postgres.Sql,
    viewer: PluginUser,
    loader: () => Promise<AiAssistantProvider | null> = defaultLoader,
): Promise<NonNullable<PluginContext['ai']> | undefined> {
    const mod = await loader();
    if (!mod) return undefined;
    return {
        async ask(req) {
            // Re-assert the HTTP route's body bounds (Zod is bypassed here).
            const prompt = req.prompt ?? '';
            if (prompt.length === 0) {
                throw new AiUnavailableError('Prompt must not be empty');
            }
            if (prompt.length > MAX_PROMPT_CHARS) {
                throw new AiUnavailableError(`Prompt too long (max ${MAX_PROMPT_CHARS} chars)`);
            }
            if (req.history) {
                if (req.history.length > MAX_HISTORY_TURNS) {
                    throw new AiUnavailableError(
                        `Too many history turns (max ${MAX_HISTORY_TURNS})`,
                    );
                }
                for (const turn of req.history) {
                    if ((turn.content?.length ?? 0) > MAX_HISTORY_CONTENT_CHARS) {
                        throw new AiUnavailableError(
                            `History content too long (max ${MAX_HISTORY_CONTENT_CHARS} chars)`,
                        );
                    }
                }
            }

            // SECURITY: the RAG user is bound to the authenticated viewer that
            // built this context — never the caller-supplied `req.asUserId`.
            // This prevents a plugin from asking the assistant "as" admin and
            // exfiltrating media the viewer is not entitled to.
            const user = await mod.resolveUser(sql, viewer.username).catch((error: unknown) => {
                if (error instanceof AuthDependencyUnavailableError) {
                    throw new AiUnavailableError(
                        'Authentication temporarily unavailable; retry shortly',
                    );
                }
                throw error;
            });
            // Fail CLOSED: `resolveUser` returns null for a disabled,
            // deleted/unsynced user (or DB down) whose Authentik session is
            // still valid. Passing
            // null to `runAssistant` would TypeError on `user.isAgeRestricted`,
            // surfacing as a confusing unhandled 500 instead of a clean error.
            if (!user) {
                throw new AiUnavailableError('AI is not available for this user');
            }
            const r = await mod.runAssistant(
                { message: req.prompt, history: req.history, systemHint: req.systemHint },
                // SECURITY: the plugin-facing AI runs DE-ESCALATED — never with
                // admin rights (even for an admin viewer) and without
                // operational/cross-user tools (get_active_streams / "current
                // sessions"). It is also a SHARED surface: the reply can be
                // published to people other than the viewer and `history` can
                // carry other people's text, so `restricted: true` additionally
                // drops every personal-data tool and the taste snippet and fences
                // the history as untrusted. `runAssistant` also applies the
                // per-minute limit and in-flight slot. Do NOT remove it.
                { user, sql, signal: req.signal, restricted: true },
            );
            return {
                text: r.text,
                recommendedMedia: r.recommendedMedia.map((m) => ({
                    id: m.id,
                    mediaType: m.mediaType as never,
                })),
                usage: r.usage,
            };
        },
    };
}
