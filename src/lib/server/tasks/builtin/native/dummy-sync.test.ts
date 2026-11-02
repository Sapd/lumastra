// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { runTask } from '@sapd/lumastra-plugin-sdk-testing';
import { dummySyncTask } from './dummy-sync.js';

describe('native dummy-sync', () => {
    it('completes successfully with default mode', async () => {
        const result = await runTask(dummySyncTask, {
            itemCount: 3,
            itemDelayMs: 0,
            mode: 'ok' as const,
        });
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(3);
    });

    it('throws when mode is "fail"', async () => {
        await expect(
            runTask(dummySyncTask, {
                itemCount: 4,
                itemDelayMs: 0,
                mode: 'fail' as const,
            }),
        ).rejects.toThrow(/Simulated failure/);
    });

    it('honours abort signal', async () => {
        const controller = new AbortController();
        controller.abort();
        const result = await runTask(
            dummySyncTask,
            { itemCount: 10, itemDelayMs: 0, mode: 'ok' as const },
            { signal: controller.signal, abortSignal: controller.signal },
        );
        expect(result.success).toBe(false);
        expect(result.stopReason).toBe('aborted');
    });

    it('exposes the canonical task surface', () => {
        expect(dummySyncTask.id).toBe('dummy-sync');
        expect(dummySyncTask.resourceClass).toBe('maintenance');
        // Demo exemplars must NOT have a schedule so production replicas
        // don't poll fake work. Operators trigger via /admin/tasks.
        expect(dummySyncTask.schedule).toBeUndefined();
    });
});
