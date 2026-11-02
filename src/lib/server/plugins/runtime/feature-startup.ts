// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type { FeatureDefinition, PluginContext } from '@sapd/lumastra-plugin-sdk';
import { Logger } from '$lib/server/utils/logger.js';

const log = Logger.for('FeatureStartup');

/** Default per-plugin onStartup budget (ms) before it is logged-and-skipped. */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

/**
 * Resolve the per-plugin onStartup timeout from the environment, falling back
 * to {@link DEFAULT_STARTUP_TIMEOUT_MS}. A non-positive or unparseable value
 * disables the timeout (returns `null`) so operators can opt out explicitly.
 */
function resolveStartupTimeoutMs(): number | null {
    const raw = process.env.LUMASTRA_FEATURE_STARTUP_TIMEOUT_MS;
    if (raw === undefined || raw === '') return DEFAULT_STARTUP_TIMEOUT_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
}

/**
 * Invoke onStartup for each feature, isolating per-plugin failures AND hangs.
 *
 * Each onStartup runs sequentially but under a timeout budget
 * (`LUMASTRA_FEATURE_STARTUP_TIMEOUT_MS`, default 30s). A plugin whose
 * onStartup throws is logged and skipped; a plugin whose onStartup never
 * resolves is timed-out, logged, and skipped — without it, one hung plugin
 * would block every later feature AND wedge the rest of the boot chain that
 * awaits this call (workers, Valkey connect, scheduler in hooks.server.ts).
 */
export async function runFeatureStartups(
    features: FeatureDefinition[],
    buildCtx: (pluginId: string) => PluginContext,
    signal?: AbortSignal,
): Promise<void> {
    const timeoutMs = resolveStartupTimeoutMs();
    for (const f of features) {
        signal?.throwIfAborted();
        if (typeof f.onStartup !== 'function') continue;
        try {
            await withTimeout(f.onStartup(buildCtx(f.id)), timeoutMs, f.id);
        } catch (err) {
            log.warn(
                'feature onStartup failed',
                { pluginId: f.id },
                err instanceof Error ? err : new Error(String(err)),
            );
        }
    }
    signal?.throwIfAborted();
}

/**
 * Race a promise against a rejecting timer. When `timeoutMs` is `null` the
 * promise is awaited unbounded. The timer is always cleared so a slow-but-
 * eventually-resolving plugin does not leak a pending handle.
 */
async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number | null,
    pluginId: string,
): Promise<T> {
    if (timeoutMs === null) return promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`onStartup timed out after ${timeoutMs}ms for plugin '${pluginId}'`));
        }, timeoutMs);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
