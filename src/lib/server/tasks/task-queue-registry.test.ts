// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { TaskQueueRegistry } from './task-queue-registry.js';

function seededRegistry(): {
    registry: TaskQueueRegistry;
    failedClose: ReturnType<typeof vi.fn>;
    successfulClose: ReturnType<typeof vi.fn>;
    failure: Error;
} {
    // Seed the owned-resource seam without opening Redis connections. The actual
    // production closeAll loop and strict error propagation remain under test.
    const registry = new TaskQueueRegistry({ connection: { host: 'localhost', port: 1 } });
    const failure = new Error('injected per-task queue close failure');
    const failedClose = vi.fn().mockRejectedValue(failure);
    const successfulClose = vi.fn().mockResolvedValue(undefined);
    const internals = registry as unknown as { queues: Map<string, Queue> };
    internals.queues.set('failed-task', { close: failedClose } as unknown as Queue);
    internals.queues.set('healthy-task', { close: successfulClose } as unknown as Queue);
    return { registry, failedClose, successfulClose, failure };
}

describe('per-task queue shutdown', () => {
    it('strictly reports failed closure, attempts other queues and retains the unresolved handle', async () => {
        const { registry, failedClose, successfulClose, failure } = seededRegistry();
        await expect(registry.closeAll({ strict: true })).rejects.toSatisfy(
            (error: unknown) =>
                error instanceof AggregateError &&
                error.errors.some((entry) => entry.err === failure),
        );
        expect(failedClose).toHaveBeenCalledOnce();
        expect(successfulClose).toHaveBeenCalledOnce();
        expect(registry.has('failed-task')).toBe(true);
        expect(registry.has('healthy-task')).toBe(false);
        failedClose.mockResolvedValue(undefined);
        await expect(registry.closeAll({ strict: true })).resolves.toBeUndefined();
        expect(registry.allQueues()).toHaveLength(0);
    });

    it('preserves tolerant cleanup for existing callers', async () => {
        const { registry, successfulClose } = seededRegistry();
        await expect(registry.closeAll()).resolves.toBeUndefined();
        expect(successfulClose).toHaveBeenCalledOnce();
        expect(registry.allQueues()).toHaveLength(0);
    });
});
