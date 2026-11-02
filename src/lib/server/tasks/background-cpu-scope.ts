// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { AsyncLocalStorage } from 'node:async_hooks';

interface BackgroundCpuScope {
    checkpoint: () => Promise<void>;
}
const scope = new AsyncLocalStorage<BackgroundCpuScope>();

/** Scoped to task execution: playback FFmpeg and on-demand providers never enter here. */
export function withBackgroundCpu<T>(checkpoint: () => Promise<void>, execute: () => T): T {
    return scope.run({ checkpoint }, execute);
}
export function inBackgroundCpuTask(): boolean {
    return scope.getStore() !== undefined;
}
export async function backgroundCpuCheckpoint(): Promise<void> {
    await scope.getStore()?.checkpoint();
}

export function isBackgroundCpuTask(resourceClass: string, taskId: string): boolean {
    // analysis is folded into cpu by the registry; keep the legacy mode covered.
    // Sonic invokes Python/sidecar inference despite using the embedding pool.
    return (
        resourceClass === 'cpu' ||
        resourceClass === 'analysis' ||
        taskId === 'sonic-embedding-backfill'
    );
}
