// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type { WatchSyncDefinition, TaskDefinition } from './types.js';
import { defineTask, parseDuration } from './define-task.js';
import { PluginDefinitionError } from './errors.js';

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function fail(id: string, message: string): never {
    throw new PluginDefinitionError({
        id,
        message,
        phase: 'registration',
        contract: 'defineWatchSync',
    });
}

export interface WatchSyncAutoTaskOpts {
    pushEvery?: string;
    pullEvery?: string;
}

export interface WatchSyncWithAutoTasks extends WatchSyncDefinition {
    __autoTasks: TaskDefinition[];
}

export function defineWatchSync(
    def: WatchSyncDefinition,
    opts?: WatchSyncAutoTaskOpts,
): WatchSyncWithAutoTasks {
    if (!def.id) fail('(unknown)', 'id is required');
    if (!ID_PATTERN.test(def.id)) {
        fail(def.id, `id must match /^[a-z][a-z0-9-]*$/, got: ${def.id}`);
    }
    if (typeof def.name !== 'string' || !def.name) {
        fail(def.id, 'name is mandatory');
    }
    if (typeof def.version !== 'string' || !def.version) {
        fail(def.id, 'version is mandatory');
    }
    if (typeof def.providerName !== 'string' || !def.providerName) {
        fail(def.id, 'providerName is mandatory');
    }
    if (typeof def.isAvailable !== 'function') {
        fail(def.id, 'isAvailable is mandatory');
    }
    if (typeof def.resolveIds !== 'function') {
        fail(def.id, 'resolveIds is mandatory');
    }
    if (typeof def.pushWatchState !== 'function') {
        fail(def.id, 'pushWatchState is mandatory');
    }
    if (def.pullWatchState !== undefined && typeof def.pullWatchState !== 'function') {
        fail(def.id, 'pullWatchState must be a function when provided');
    }
    if (def.listPullUsers !== undefined && typeof def.listPullUsers !== 'function') {
        fail(def.id, 'listPullUsers must be a function when provided');
    }
    if (def.pushResumePosition !== undefined && typeof def.pushResumePosition !== 'function') {
        fail(def.id, 'pushResumePosition must be a function when provided');
    }

    if (opts?.pushEvery && parseDuration(opts.pushEvery) === null) {
        fail(def.id, `pushEvery '${opts.pushEvery}' is not a valid duration`);
    }
    if (opts?.pullEvery && parseDuration(opts.pullEvery) === null) {
        fail(def.id, `pullEvery '${opts.pullEvery}' is not a valid duration`);
    }

    // pushEvery/pullEvery are retained on the options surface for backwards
    // compatibility with legacy callers, but NEITHER stub task now declares a
    // schedule — the watch-sync engine drives timing entirely. Declaring a
    // schedule would make the scheduler fire these stubs periodically, and
    // their execute() bodies always throw → polluted run history.
    //
    // Warn at definition time so a plugin author who passes these values
    // doesn't get silent no-op behavior — the engine ignores them entirely.
    if (opts?.pushEvery || opts?.pullEvery) {
        console.warn(
            `defineWatchSync(${def.id}): pushEvery/pullEvery options are ignored; ` +
                `the watch-sync engine drives push/pull cycles directly. Configure cadence ` +
                `at the engine level instead.`,
        );
    }
    void opts?.pushEvery;
    void opts?.pullEvery;

    // NOTE: __autoTasks are vestigial stubs. The new watch-sync engine calls
    // def.pushWatchState / def.pullWatchState directly via the engine's push
    // and pull cycles rather than enqueuing these tasks. They are retained for
    // registry compatibility (task IDs appear in admin UI) but their execute()
    // bodies throw to prevent direct invocation, AND they declare no schedule
    // so the scheduler never fires them automatically.
    const pushTask = defineTask({
        id: `${def.id}-push`,
        name: `${def.id} — Push Watch State`,
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {
            database: def.capabilities?.database ?? false,
            http: def.capabilities?.http ?? false,
        },
        resourceClass: 'io',
        // Admin IA redesign §3.3: every watch-sync provider's auto-synthesized
        // stub belongs in the Watch sync purpose group, set once here rather
        // than by each provider file.
        purpose: 'watch-sync',
        // No `schedule:` — the watch-sync engine owns push timing. See the
        // module-level note above for why. `manualOnly` declares the contract
        // that this stub is never auto-fired (the engine drives push directly),
        // so the boot trigger-coverage audit doesn't flag it as orphaned.
        manualOnly: true,
        // execute() always throws (see below) — the admin UI must not offer
        // a "Run" button that's guaranteed to fail.
        notManuallyRunnable: true,
        // Registry plumbing, not an operator task: hidden behind "Show system
        // tasks" on /admin/tasks (spec 2026-09-27 §1.3). The engine's own
        // "Import/Export Watch State" tasks are what an operator watches.
        visibility: 'system',
        inputSchema: z.object({}),
        identityFor: () => 'global',
        async execute(_ctx) {
            throw new Error(
                `defineWatchSync auto-push task for '${def.id}' is a stub and cannot be run directly. ` +
                    `Push is driven by the watch-sync engine cycle — see /admin/extensions for status. ` +
                    `Trigger a manual push via the engine rather than enqueuing this task directly.`,
            );
        },
    });

    const pullTask = defineTask({
        id: `${def.id}-pull`,
        name: `${def.id} — Pull Watch State`,
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {
            database: def.capabilities?.database ?? false,
            http: def.capabilities?.http ?? false,
        },
        resourceClass: 'io',
        purpose: 'watch-sync',
        // No `schedule:` — same reasoning as push. `manualOnly` for the same
        // reason: never auto-fired, so the trigger-coverage audit skips it.
        manualOnly: true,
        // execute() always throws (see below) — the admin UI must not offer
        // a "Run" button that's guaranteed to fail.
        notManuallyRunnable: true,
        // Registry plumbing, not an operator task: hidden behind "Show system
        // tasks" on /admin/tasks (spec 2026-09-27 §1.3). The engine's own
        // "Import/Export Watch State" tasks are what an operator watches.
        visibility: 'system',
        inputSchema: z.object({ since: z.string().optional() }),
        identityFor: () => 'global',
        async execute(_ctx) {
            throw new Error(
                `defineWatchSync auto-pull task for '${def.id}' is a stub and cannot be run directly. ` +
                    `Pull is driven by the watch-sync engine cycle — see /admin/extensions for status. ` +
                    `Trigger a manual pull via the engine rather than enqueuing this task directly.`,
            );
        },
    });

    return {
        ...def,
        __autoTasks: [pushTask as TaskDefinition, pullTask as TaskDefinition],
    };
}
