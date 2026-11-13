// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Boot registrations the rest of the server reaches through registries.
 *
 * Lumastra is AGPL-3.0 with no paid parts. The /j (Jellyfin-compat) API and the
 * AI assistant sit behind small registries in the core (so the core never has
 * to import them), and this module is the one place that fills them. Every
 * process that needs them calls {@link ensureCompatLoaded}: the web server at
 * boot (hooks.server.ts), the task runtime and its executor children, the
 * credential-revocation fan-out, and the plugin `ctx.ai` surface. It is
 * idempotent and never throws.
 *
 * It registers:
 * - the AI assistant provider (plugin `ctx.ai` bridge),
 * - the /j session revocation (disable / password reset / delete of a user),
 * - the /j response observer (JELLYFIN_CONTRACT_VALIDATE),
 * - the /j GitHub report builder (admin diagnostics),
 * - the /j silent-start sweeper and the /j/socket remote control (full nodes only),
 * and, first and synchronously, starts the push relay token enrolment loop
 * (relay-token-enrol.ts).
 *
 * It replaces what `proprietary/licensing/init.ts` used to do besides licensing.
 * Never inside a plugin-isolation worker: those hold no database and no master
 * key, and must not start loops or call out.
 *
 * The dynamic imports keep the graph small: nothing here loads until a process
 * asks for it, exactly like the lazy loader it replaces.
 */

import { config } from '$lib/server/config.js';
import { startRelayTokenEnrolLoop } from '$lib/server/services/push/relay-token-enrol.js';
import { isIsolationWorker } from '$lib/server/tasks/isolation/isolation-context.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('CompatInit');

let loading: Promise<void> | null = null;

/** Run one registration; a failure is logged and never blocks the others. */
async function step(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (err) {
        logger.warn(`Boot registration failed: ${name}`, { error: String(err) });
    }
}

async function load(): Promise<void> {
    // Wire the AI assistant into the core registry so the plugin `ctx.ai` bridge
    // can reach it without the core importing it. The registry contract is
    // structural (input/deps typed `unknown` in the core), so adapt `runAssistant`
    // here; the bridge always calls it with the correct concrete shapes.
    await step('ai assistant provider', async () => {
        const [{ registerAiAssistantProvider }, { runAssistant, resolveUser }] = await Promise.all([
            import('$lib/server/ai/assistant-provider.js'),
            import('$lib/server/proprietary/assistant-service.js'),
        ]);
        registerAiAssistantProvider({
            runAssistant: (input, deps) =>
                runAssistant(
                    input as Parameters<typeof runAssistant>[0],
                    deps as Parameters<typeof runAssistant>[1],
                ),
            resolveUser,
        });
    });
    // /j session store into the credential-revocation fan-out, so disabling,
    // resetting the password of or deleting a user also tears down their live /j
    // sessions (see jellyfin-compat-revocation.ts).
    await step('/j session revocation', async () => {
        const [{ registerJellyfinCompatRevocationProvider }, { revokeSessionsForUser }] =
            await Promise.all([
                import('$lib/server/auth/jellyfin-compat-revocation.js'),
                import('$lib/server/proprietary/jellyfin-compat/auth.js'),
            ]);
        registerJellyfinCompatRevocationProvider({ revokeSessionsForUser });
    });
    // Opt-in /j response-contract validator (JELLYFIN_CONTRACT_VALIDATE), called by
    // jellyfinResponseObserverHandle in hooks.server.ts.
    await step('/j response observer', async () => {
        const [{ registerJellyfinResponseObserver }, { observeJellyfinResponse }] =
            await Promise.all([
                import('$lib/server/compat/jellyfin-response-observer.js'),
                import('$lib/server/proprietary/jellyfin-compat/contract/runtime-hook.js'),
            ]);
        registerJellyfinResponseObserver(observeJellyfinResponse);
    });
    // Redacted GitHub report for /j diagnostics (the admin endpoint resolves the
    // builder through this registry).
    await step('/j report builder', async () => {
        const [{ registerJellyfinReportBuilder }, { buildGithubReport }] = await Promise.all([
            import('$lib/server/compat/jellyfin-report-provider.js'),
            import('$lib/server/proprietary/jellyfin-compat/github-report.js'),
        ]);
        registerJellyfinReportBuilder(buildGithubReport);
    });
    // Stream-proxy-only nodes skip the sweeper and the remote control. Elsewhere
    // the sweep claim is atomic. The sweeper timer is unref()ed, so it never
    // blocks process exit and needs no shutdown hook.
    if (!config.STREAM_PROXY_MODE) {
        await step('/j silent-start sweeper', async () => {
            const [{ startSilentStartSweeper }, { getDb }] = await Promise.all([
                import('$lib/server/proprietary/jellyfin-compat/silent-start.js'),
                import('$lib/server/database/connection.js'),
            ]);
            startSilentStartSweeper(async () => getDb());
        });
        // /j/socket (Jellyfin remote control) claims the WebSocket upgrade through
        // the dispatcher hooks.server.ts installs.
        await step('/j remote control', async () => {
            const { registerJellyfinRemoteControl } =
                await import('$lib/server/proprietary/jellyfin-compat/remote-control/register.js');
            registerJellyfinRemoteControl();
        });
    }
}

/**
 * Register everything above, once per process. Resolves when done; never
 * rejects. A no-op inside a plugin-isolation worker.
 */
export function ensureCompatLoaded(): Promise<void> {
    if (isIsolationWorker()) return Promise.resolve();
    if (!loading) {
        // Synchronously, before any await: the legacy licence loop (still present
        // until it is removed) asks `wantsLicenceMintedRelayToken()` on its first
        // tick and must already see that this loop owns the relay token. A throw
        // here (never expected) must not stop the registrations below.
        try {
            startRelayTokenEnrolLoop();
        } catch (err) {
            logger.warn('Push relay token enrolment did not start', { error: String(err) });
        }
        loading = load();
    }
    return loading;
}

/** Test seam: forget that registrations ran. */
export function __resetCompatLoadedForTests(): void {
    loading = null;
}
