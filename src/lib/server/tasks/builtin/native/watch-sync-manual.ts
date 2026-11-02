// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Sync Manual — native defineTask implementation (Task 7).
 *
 * User-triggered, per-user "Import" (pull) or "Export" (push) against one
 * watch-sync provider. Unlike `watch-sync-pull`/`watch-sync-push` (global,
 * scheduled, every 5m), this task is `manualOnly` and scoped to exactly one
 * user — an API route (Task 11) starts a run via
 * `orchestrator.startRun('watch-sync-manual', input, { userId: input.userId, ... })`
 * and reads its progress back.
 *
 * Direction semantics:
 * - `pull` ("Import"): clears the user's persisted pull cursor for the
 *   provider FIRST so the pull is a full historical re-import rather than
 *   an incremental one from the old watermark, THEN calls
 *   `watchSyncEngine.runPullForUser`.
 * - `push` ("Export"): re-queues the user's decisive watch-state events for
 *   the provider FIRST (clears their `pushed_to_providers` membership so
 *   they look un-pushed again) so the push re-sends the user's entire
 *   current state regardless of what the scheduled push cycle already
 *   sent, THEN calls `watchSyncEngine.runPushForUser`.
 *
 * `runPushForUser`/`runPullForUser` take the watch-sync PLUGIN id (e.g.
 * `'mal-watch-sync'`), not the short provider name (`'mal'`) used
 * elsewhere (identity, `pushed_to_providers`, `watch_state_pull_log`) —
 * this task maps `provider -> `${provider}-watch-sync`` at the call site.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import {
    watchSyncEngine,
    type WatchSyncProgressReporter,
} from '$lib/server/services/watch-sync-engine.service.js';
import { resetPullCursor } from '$lib/server/database/queries/watch-sync-pull-log.queries.js';
import { requeueUserEventsForProvider } from '$lib/server/database/queries/user-media-events.queries.js';
import { toUserId } from '$lib/shared/user-id.js';

const WATCH_SYNC_MANUAL_PROVIDERS = ['mal', 'trakt'] as const;
type WatchSyncManualProvider = (typeof WATCH_SYNC_MANUAL_PROVIDERS)[number];

const inputSchema = z.object({
    userId: z.string().guid(),
    provider: z.enum(WATCH_SYNC_MANUAL_PROVIDERS),
    direction: z.enum(['pull', 'push']),
});

type WatchSyncManualInput = z.infer<typeof inputSchema>;

interface WatchSyncManualResult {
    summary: string;
    itemsProcessed: number;
}

const pluginIdFor = (provider: WatchSyncManualProvider): string => `${provider}-watch-sync`;

export const watchSyncManualTask = defineTask<WatchSyncManualInput, WatchSyncManualResult>({
    id: 'watch-sync-manual',
    purpose: 'watch-sync',
    name: 'Watch Sync Manual Import/Export',
    description: 'Runs a one-off Import or Export against a watch-sync provider for one user.',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true, http: true },
    resourceClass: 'io',

    // One-shot: enqueued only by the user/admin-facing Import/Export action
    // (Task 11's API route), never scheduled.
    manualOnly: true,

    identityFor: (input) => `${input.userId}-${input.provider}-${input.direction}`,
    scope: 'user',

    // Per-user guard: prevents a single user from double-triggering the same
    // Import/Export while one is already in flight (e.g. a double-click).
    // This does NOT serialize across users — see spec §8.5 clarification in
    // the task brief: aggregate provider call-rate is already bounded by the
    // plugin's shared module-level throttle chain, so a global lock here
    // would only add needless cross-user serialization.
    // ttl must be >= timeout.hard (SDK-enforced); 30m matches the hard cap.
    exclusiveWith: { scope: 'user', ttl: '30m' },

    inputSchema,

    timeout: { hard: '30m', soft: '25m' },

    async execute(ctx: TaskContext<WatchSyncManualInput>) {
        const { signal, sql, input } = ctx;
        const { provider, direction } = input;

        if (signal.aborted) {
            ctx.logger.info('Manual watch sync cancelled before start', { provider, direction });
            return {
                success: true,
                itemsProcessed: 0,
                stopReason: 'aborted' as const,
                result: { summary: 'Cancelled before start', itemsProcessed: 0 },
            };
        }

        const userId = toUserId(input.userId);
        const pluginId = pluginIdFor(provider);

        ctx.logger.info('Manual watch sync started', { provider, direction, userId: input.userId });

        let lastProcessed = 0;
        const reporter: WatchSyncProgressReporter = (p) => {
            lastProcessed = p.processed;
            ctx.reportProgress(p.processed, p.total, p.currentItem);
        };

        if (direction === 'pull') {
            await resetPullCursor(sql, userId, provider);
            await watchSyncEngine.runPullForUser(input.userId, pluginId, reporter);
        } else {
            await requeueUserEventsForProvider(sql, userId, provider);
            await watchSyncEngine.runPushForUser(input.userId, pluginId, reporter);
        }

        // The awaited work above runs to completion (the engine methods don't
        // thread `ctx.signal` mid-run), so reaching here means it finished. We
        // do NOT recompute `signal.aborted` post-hoc and flip stopReason to
        // 'aborted' — that would mislabel a fully-completed run as cancelled if
        // a cancel arrived while the (uninterruptible) work was already
        // finishing. 'aborted' is reported ONLY from the pre-work early return.
        const verb = direction === 'pull' ? 'Import' : 'Export';
        ctx.logger.info(`Manual watch sync ${verb.toLowerCase()} finished`, {
            provider,
            itemsProcessed: lastProcessed,
        });

        return {
            success: true,
            itemsProcessed: lastProcessed,
            result: {
                summary: `${verb} (${provider}): ${lastProcessed} processed`,
                itemsProcessed: lastProcessed,
            },
        };
    },
});

registry.registerTask(watchSyncManualTask);
