// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sync-plugin types — re-export shim for the task-system execution surfaces.
 *
 * The actual definitions live in `$lib/server/tasks/sync-context-types`;
 * this file exists so older import paths keep resolving.
 */

export type {
    PluginBacklogManifest,
    PluginBacklogStatus,
    SyncResumeManifest,
    SyncExecutionContext,
    SyncTaskResult,
    SyncTaskResultSerialized,
    FailedItem,
    ListFailedItemsOptions,
    ListFailedItemsResult,
    RetryItemResult,
} from '../../tasks/sync-context-types.js';
