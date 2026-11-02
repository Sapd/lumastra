// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * handle-trigger-failure — fail-loud helper for `orchestrator.startRun` callers.
 *
 * A `try { startRun(...) } catch (err) { logger.warn(...) }` pattern around
 * a missing task id blends into normal log noise and can stay invisible for
 * hours. This helper escalates the failure so it surfaces immediately:
 *
 *   - Dev (NODE_ENV !== 'production'): re-throw. Tests and dev sessions
 *     crash loudly — a stack trace beats a buried warn.
 *   - Prod: log at `error` level with the structured tag
 *     `TASK_REGISTRY_INCONSISTENCY` so operators can grep / alert on it.
 *     The caller proceeds normally (e.g. the lifecycle catalog write still
 *     lands); only visibility is escalated.
 *
 * Use from EVERY catch around `orchestrator.startRun(...)`. The helper is
 * not specific to "Unknown task" errors — Valkey-unreachable, identity
 * collisions, etc. also re-throw in dev and log at error in prod, because
 * silent failure is never the right default for a background trigger.
 */

import type { LoggerInstance } from '$lib/server/utils/logger';

const TAG = 'TASK_REGISTRY_INCONSISTENCY';

/**
 * Returns true if an error is the orchestrator's "Unknown task: <id>"
 * permanent-kind TaskError. We can't import TaskError directly (sdk import
 * would introduce a cycle for this generic helper), so we check both
 * detection signals:
 *
 *   - error.name === 'TaskError' AND the (kind === 'permanent') metadata
 *     dagre-style attached on the SDK's TaskError class
 *   - English message prefix as a fallback for the case where TaskError
 *     subclasses are not wired through, or the error has been re-wrapped
 *
 * Belt-and-suspenders: if the SDK ever rewords the message, the class-name
 * check still fires; if the SDK ever renames the class, the message regex
 * still fires.
 */
function isUnknownTaskError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (err.name === 'TaskError' && (err as Error & { kind?: string }).kind === 'permanent') {
        return /unknown task/i.test(err.message);
    }
    return /^Unknown task: /.test(err.message);
}

export interface HandleTriggerFailureOpts {
    /** Service-supplied logger for context-rich messages. */
    logger: Pick<LoggerInstance, 'error' | 'warn'>;
    /** What the caller was trying to do (e.g. 'enqueue embedding regeneration'). */
    action: string;
    /** Task id the caller asked for; included in the structured payload. */
    taskId: string;
    /** Anything else worth recording (mediaId, userId, route, etc). */
    context?: Record<string, unknown>;
}

/**
 * Centralized policy for catch handlers around `orchestrator.startRun()`.
 *
 *  - Dev: re-throw so the misconfiguration surfaces immediately in test
 *    output / browser console / supervisor logs. No silent failures.
 *  - Prod: log at error level with the TASK_REGISTRY_INCONSISTENCY tag so
 *    operators can grep / alertmanager / log-aggregator catch it within
 *    seconds. Lifecycle hooks then return normally — the catalog write
 *    must still complete on prod.
 */
export function handleTriggerFailure(err: unknown, opts: HandleTriggerFailureOpts): void {
    const isProduction = process.env.NODE_ENV === 'production';
    const registryInconsistency = isUnknownTaskError(err);
    const error = err instanceof Error ? err : new Error(String(err));

    // Canonical fields go LAST so caller-supplied context (which may include
    // its own taskId/tag/etc. by accident) can never overwrite the structured
    // signals operator alerting rules depend on.
    const payload: Record<string, unknown> = {
        ...opts.context,
        tag: registryInconsistency ? TAG : 'TASK_TRIGGER_FAILURE',
        taskId: opts.taskId,
        action: opts.action,
        registryInconsistency,
    };

    if (!isProduction) {
        // Dev: re-throw. The orchestrator never crashes prod for an
        // unknown task — but dev sessions / CI tests must.
        opts.logger.error(`task trigger failed (dev re-throw): ${opts.action}`, error, payload);
        throw error;
    }

    // Prod: log at error so operators see it in /admin/runs and any
    // log-aggregator alerting rule that watches for the tag.
    opts.logger.error(`task trigger failed: ${opts.action}`, error, payload);
}

/**
 * Convenience helper for routes that DO want to surface the failure to
 * the caller (admin endpoints in particular). Returns true if the error
 * is a registry inconsistency the caller should map to a 5xx response.
 */
export function isTaskRegistryInconsistency(err: unknown): boolean {
    return isUnknownTaskError(err);
}
