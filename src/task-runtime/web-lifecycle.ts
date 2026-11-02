// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { shouldStartWorkers } from '$lib/server/config.js';
import {
    assertValkeyEndpointConfiguration,
    ValkeyEndpointConfigurationError,
} from '$lib/server/config/valkey-endpoints.js';
import { Logger } from '$lib/server/utils/logger.js';
import { loadTaskRegistry } from './registration.js';

const log = Logger.for('WebTaskProducer');
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
let startup: Promise<void> | undefined;
let shutdown: Promise<void> | undefined;
let authStartup: Promise<void> | undefined;
let stopping = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelayMs = RETRY_BASE_MS;
let completedSteps = 0;
const startupController = new AbortController();

/** HTTP registration and queue submission only; consumer startup is unavailable here. */
export function startWebTaskSubsystem(): Promise<void> {
    if (stopping) return Promise.reject(new Error('Web task producer is stopping'));
    if (shouldStartWorkers())
        return Promise.reject(new Error('The web server cannot run as a dedicated task worker'));
    try {
        assertValkeyEndpointConfiguration();
    } catch (err) {
        return Promise.reject(err);
    }
    // Calls during backoff share the last attempt rather than bypassing its delay.
    startup ??= initialize().catch((err: unknown) => {
        if (!stopping && !(err instanceof ValkeyEndpointConfigurationError)) scheduleRetry(err);
        throw err;
    });
    return startup;
}

function scheduleRetry(error: unknown): void {
    const delayMs = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
    log.warn('Web task initialization failed; retrying', { error: String(error), delayMs });
    retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (stopping) return;
        startup = undefined;
        // Automatic attempts have no external caller to consume their rejection.
        void startWebTaskSubsystem().catch(() => undefined);
    }, delayMs);
    retryTimer.unref?.();
}

async function initialize(): Promise<void> {
    // Auth invalidation owns its own supervisor, independent of producer retries.
    authStartup ??= import('$lib/server/cache/auth-cache-bus')
        .then((m) => {
            if (!stopping) return m.startAuthCacheInvalidationSubscriber();
        })
        .catch((err: unknown) =>
            log.error(
                'Failed to start auth-cache invalidation',
                err instanceof Error ? err : new Error(String(err)),
            ),
        );

    // Checkpoint successful steps: in particular, feature onStartup may install
    // timers or time out with work still running and must never be replayed.
    const steps: Array<() => Promise<unknown>> = [
        () => loadTaskRegistry(startupController.signal),
        async () => {
            const { runFeatureStartups } =
                await import('$lib/server/plugins/runtime/feature-startup.js');
            const { registry } = await import('$lib/server/tasks/registry.js');
            const { buildPluginContext } = await import('$lib/server/tasks/plugin-context.js');
            startupController.signal.throwIfAborted();
            await runFeatureStartups(
                registry.getAllFeatures(),
                (id) => buildPluginContext(id),
                startupController.signal,
            );
        },
        async () => {
            const { connectValkey, isCoordinationValkeyHealthy } =
                await import('$lib/server/cache/valkey');
            startupController.signal.throwIfAborted();
            // connectValkey() reports the task Valkey; a down cache never blocks.
            if (!(await connectValkey()))
                throw new Error('Web task producer requires the task Valkey (TASK_CACHE_URL)');
            if (!(await isCoordinationValkeyHealthy()))
                throw new Error('Web task producer requires healthy coordination Valkey');
            // The web container writes revocation markers and rate limits to the
            // task Valkey too: report an evicting/shared one even when no worker
            // runs (the worker refuses to start on it; the web keeps serving).
            const { guardTaskValkey } = await import('$lib/server/cache/valkey');
            void guardTaskValkey().catch((err: unknown) =>
                log.error(
                    'Task Valkey check failed',
                    err instanceof Error ? err : new Error(String(err)),
                ),
            );
        },
        async () => {
            const { startDecodeDenySubscriber } = await import('$lib/server/cache/decode-deny-bus');
            startupController.signal.throwIfAborted();
            if (!(await startDecodeDenySubscriber()))
                throw new Error('Web decode deny subscriber unavailable');
        },
        async () => {
            const { startTrickplayHwaccelDenySubscriber } =
                await import('$lib/server/cache/trickplay-hwaccel-deny-bus');
            startupController.signal.throwIfAborted();
            if (!(await startTrickplayHwaccelDenySubscriber()))
                throw new Error('Web trickplay deny subscriber unavailable');
        },
        async () => {
            // Its role gate excludes leader election, reconciliation and dispatchers.
            const { getOrchestrator } = await import('$lib/server/tasks/orchestrator');
            startupController.signal.throwIfAborted();
            await getOrchestrator();
        },
    ];
    while (completedSteps < steps.length) {
        startupController.signal.throwIfAborted();
        await steps[completedSteps]();
        completedSteps++;
    }
    startupController.signal.throwIfAborted();
    retryDelayMs = RETRY_BASE_MS;
    log.info('Web task registry and submission coordination ready');
    // The web container never runs background work; say loudly when no
    // dedicated worker heartbeats (upgrades without the worker container).
    const { workerPresence } = await import('$lib/server/services/worker-presence.service');
    workerPresence.start();
}

export function stopWebTaskSubsystem(): Promise<void> {
    stopping = true;
    startupController.abort(new Error('Web task producer is stopping'));
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    shutdown ??= (async () => {
        await startup?.catch(() => undefined);
        const { workerPresence } = await import('$lib/server/services/worker-presence.service');
        workerPresence.stop();
        if (authStartup) {
            await authStartup;
            const { stopAuthCacheInvalidationSubscriber } =
                await import('$lib/server/cache/auth-cache-bus');
            stopAuthCacheInvalidationSubscriber();
        }
        const { orchestrator } = await import('$lib/server/tasks/orchestrator');
        await orchestrator.stop();
    })();
    return shutdown;
}
