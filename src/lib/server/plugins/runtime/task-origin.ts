// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which external plugin contributed each task. Built-in tasks have no entry.
 *
 * Kept out of `TaskRegistry` on purpose: the registry is mocked wholesale by
 * the loader tests, and provenance is presentation data (the admin catalog
 * labels a plugin's task so an operator can tell the SDK's "Sample Task"
 * example from a core one), not something task scheduling depends on.
 */
const taskPlugins = new Map<string, string>();

/** Record that `taskId` was registered by the external plugin `pluginId`. */
export function markTaskFromPlugin(taskId: string, pluginId: string): void {
    taskPlugins.set(taskId, pluginId);
}

/** The external plugin that contributed `taskId`, or undefined for a built-in task. */
export function pluginIdForTask(taskId: string): string | undefined {
    return taskPlugins.get(taskId);
}
