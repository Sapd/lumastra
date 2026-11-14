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
 * and, for the two processes that ask for it (the web server and the task runtime's
 * main process), starts the push relay token enrolment loop (relay-token-enrol.ts).
 * Executor children, the credential-revocation fan-out and the plugin `ctx.ai`
 * surface never start it, so one install makes one call, not one per process.
 *
 * With LUMASTRA_CLI=1 (the reset-password command) only the registrations run: no
 * sweeper, remote control, enrolment loop or retry timer.
 *
 * Never inside a plugin-isolation worker: those hold no database and no master
 * key, and must not start loops or call out.
 *
 * A stream-proxy-only node has no database: it gets no enrolment loop and only the
 * registrations that need none. A step that failed is retried by the next call
 * (steps that worked are not run again).
 *
 * The dynamic imports keep the graph small: nothing here loads until a process
 * asks for it.
 */

import { config } from '$lib/server/config.js';
import { startRelayTokenEnrolLoop } from '$lib/server/services/push/relay-token-enrol.js';
import { isIsolationWorker } from '$lib/server/tasks/isolation/isolation-context.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('CompatInit');

export interface CompatLoadOptions {
    /**
     * Start the push relay token enrolment loop. Only the web server and the
     * task runtime's main process pass this.
     */
    enrolRelayToken?: boolean;
}

interface Step {
    name: string;
    /** Starts a background loop, timer or listener: skipped in a CLI process (LUMASTRA_CLI=1). */
    background?: boolean;
    /** Skipped on a stream-proxy-only node (it has no database). */
    needsFullNode: boolean;
    run: () => void | Promise<void>;
}

const STEPS: Step[] = [
    // Wire the AI assistant into the core registry so the plugin `ctx.ai` bridge
    // can reach it without the core importing it. The registry contract is
    // structural (input/deps typed `unknown` in the core), so adapt `runAssistant`
    // here; the bridge always calls it with the correct concrete shapes.
    {
        name: 'ai assistant provider',
        needsFullNode: true,
        run: async () => {
            const [{ registerAiAssistantProvider }, { runAssistant, resolveUser }] =
                await Promise.all([
                    import('$lib/server/ai/assistant-provider.js'),
                    import('$lib/server/assistant/assistant-service.js'),
                ]);
            registerAiAssistantProvider({
                runAssistant: (input, deps) =>
                    runAssistant(
                        input as Parameters<typeof runAssistant>[0],
                        deps as Parameters<typeof runAssistant>[1],
                    ),
                resolveUser,
            });
        },
    },
    // /j session store into the credential-revocation fan-out, so disabling,
    // resetting the password of or deleting a user also tears down their live /j
    // sessions (see jellyfin-compat-revocation.ts).
    {
        name: '/j session revocation',
        needsFullNode: true,
        run: async () => {
            const [{ registerJellyfinCompatRevocationProvider }, { revokeSessionsForUser }] =
                await Promise.all([
                    import('$lib/server/auth/jellyfin-compat-revocation.js'),
                    import('$lib/server/jellyfin-compat/auth.js'),
                ]);
            registerJellyfinCompatRevocationProvider({ revokeSessionsForUser });
        },
    },
    // Opt-in /j response-contract validator (JELLYFIN_CONTRACT_VALIDATE), called by
    // jellyfinResponseObserverHandle in hooks.server.ts.
    {
        name: '/j response observer',
        needsFullNode: false,
        run: async () => {
            const [{ registerJellyfinResponseObserver }, { observeJellyfinResponse }] =
                await Promise.all([
                    import('$lib/server/compat/jellyfin-response-observer.js'),
                    import('$lib/server/jellyfin-compat/contract/runtime-hook.js'),
                ]);
            registerJellyfinResponseObserver(observeJellyfinResponse);
        },
    },
    // Redacted GitHub report for /j diagnostics (the admin endpoint resolves the
    // builder through this registry).
    {
        name: '/j report builder',
        needsFullNode: true,
        run: async () => {
            const [{ registerJellyfinReportBuilder }, { buildGithubReport }] = await Promise.all([
                import('$lib/server/compat/jellyfin-report-provider.js'),
                import('$lib/server/jellyfin-compat/github-report.js'),
            ]);
            registerJellyfinReportBuilder(buildGithubReport);
        },
    },
    // The sweep claim is atomic. The sweeper timer is unref()ed, so it never
    // blocks process exit and needs no shutdown hook.
    {
        name: '/j silent-start sweeper',
        needsFullNode: true,
        background: true,
        run: async () => {
            const [{ startSilentStartSweeper }, { getDb }] = await Promise.all([
                import('$lib/server/jellyfin-compat/silent-start.js'),
                import('$lib/server/database/connection.js'),
            ]);
            startSilentStartSweeper(async () => getDb());
        },
    },
    // /j/socket (Jellyfin remote control) claims the WebSocket upgrade through
    // the dispatcher hooks.server.ts installs.
    {
        name: '/j remote control',
        needsFullNode: true,
        background: true,
        run: async () => {
            const { registerJellyfinRemoteControl } =
                await import('$lib/server/jellyfin-compat/remote-control/register.js');
            registerJellyfinRemoteControl();
        },
    },
];

const done = new Set<string>();
let inFlight: Promise<void> | null = null;
let complete = false;

/**
 * A step that failed at boot (a transient import or filesystem hiccup) is tried
 * again on its own, so /j remote control and the sweeper do not stay
 * unregistered until some later request happens to call us. A few attempts, a
 * minute apart; a step that keeps failing is then left to the next explicit call.
 */
const RETRY_DELAY_MS = 60_000;
const MAX_TIMED_RETRIES = 5;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let timedRetries = 0;

/**
 * Command-line tools (scripts/reset-password.ts) set LUMASTRA_CLI=1. They need the
 * registrations (the /j revocation provider above all) but must not start loops,
 * sweepers, listeners or retry timers that would keep the process alive.
 */
function isCliProcess(): boolean {
    return process.env.LUMASTRA_CLI === '1';
}

function skipStep(step: Step): boolean {
    return (
        (step.needsFullNode && config.STREAM_PROXY_MODE) ||
        (step.background === true && isCliProcess())
    );
}

function scheduleRetry(): void {
    if (isCliProcess()) return;
    if (retryTimer || timedRetries >= MAX_TIMED_RETRIES) return;
    timedRetries += 1;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void ensureCompatLoaded();
    }, RETRY_DELAY_MS);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
}

/** Run every step that has not worked yet; a failure is logged and never blocks the others. */
async function runSteps(): Promise<void> {
    let failed = false;
    for (const step of STEPS) {
        if (done.has(step.name)) continue;
        if (skipStep(step)) continue;
        try {
            await step.run();
            done.add(step.name);
        } catch (err) {
            failed = true;
            logger.warn(`Boot registration failed: ${step.name}`, { error: String(err) });
        }
    }
    complete = !failed;
    if (failed) scheduleRetry();
}

/** Names of the registrations that have not worked yet (empty once everything is loaded). */
export function pendingCompatSteps(): string[] {
    return STEPS.filter((step) => !done.has(step.name) && !skipStep(step)).map(
        (step) => step.name,
    );
}

/**
 * Register everything above, once per process; a failed step is retried by the
 * next call. Resolves when done; never rejects. A no-op inside a plugin-isolation
 * worker.
 */
export function ensureCompatLoaded(options: CompatLoadOptions = {}): Promise<void> {
    if (isIsolationWorker()) return Promise.resolve();
    if (options.enrolRelayToken && !config.STREAM_PROXY_MODE && !isCliProcess()) {
        // Synchronously, before any await. A throw here (never expected) must
        // not stop the registrations below. The loop itself is idempotent.
        try {
            startRelayTokenEnrolLoop();
        } catch (err) {
            logger.warn('Push relay token enrolment did not start', { error: String(err) });
        }
    }
    if (complete) return Promise.resolve();
    if (!inFlight) {
        inFlight = runSteps()
            .catch((err: unknown) => {
                logger.warn('Boot registrations failed', { error: String(err) });
            })
            .finally(() => {
                inFlight = null;
            });
    }
    return inFlight;
}

/** Test seam: forget that registrations ran. */
export function __resetCompatLoadedForTests(): void {
    done.clear();
    inFlight = null;
    complete = false;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    timedRetries = 0;
}
