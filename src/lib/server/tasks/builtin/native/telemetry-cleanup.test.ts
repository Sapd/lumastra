// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * telemetry-cleanup task tests.
 * Verifies:
 *   - DISABLE_TELEMETRY_CLEANUP env var gates execution (runtime gate)
 *   - abort signal is forwarded to the service
 *   - real failures propagate as thrown errors (not success: false)
 *   - happy-path emits an info log and returns deleted count
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

const { cleanup } = vi.hoisted(() => ({
    cleanup: vi.fn(),
}));

vi.mock('$lib/server/services/playback-telemetry.service.js', () => ({
    playbackTelemetryService: { cleanup },
}));

import { telemetryCleanupTask } from './telemetry-cleanup.js';

type TelemetryCleanupInput = Record<string, unknown>;

function makeContext(
    overrides: Partial<TaskContext<TelemetryCleanupInput>> = {},
): TaskContext<TelemetryCleanupInput> {
    const ac = new AbortController();
    return {
        sql: {} as never,
        logger: {
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        input: {},
        reportProgress: vi.fn(),
        ...overrides,
    } as unknown as TaskContext<TelemetryCleanupInput>;
}

describe('telemetry-cleanup task', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.DISABLE_TELEMETRY_CLEANUP;
    });

    afterEach(() => {
        delete process.env.DISABLE_TELEMETRY_CLEANUP;
    });

    it('returns deleted count on success', async () => {
        cleanup.mockResolvedValue(42);
        const result = await telemetryCleanupTask.execute(makeContext());
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(42);
        expect(result.result?.message).toContain('Deleted 42');
    });

    it('forwards the abort signal to the service', async () => {
        const ac = new AbortController();
        cleanup.mockResolvedValue(0);
        await telemetryCleanupTask.execute(
            makeContext({ signal: ac.signal, abortSignal: ac.signal }),
        );
        expect(cleanup).toHaveBeenCalledWith(ac.signal);
    });

    it('surfaces abort state in stopReason and message when count > 0', async () => {
        cleanup.mockResolvedValue(5);
        const ac = new AbortController();
        ac.abort();
        const result = await telemetryCleanupTask.execute(
            makeContext({ signal: ac.signal, abortSignal: ac.signal }),
        );
        expect(result.stopReason).toBe('aborted');
        expect(result.result?.message).toContain('Aborted after deleting 5');
    });

    it('propagates thrown errors from the service', async () => {
        cleanup.mockRejectedValue(new Error('telemetry broken'));
        const ctx = makeContext();
        await expect(telemetryCleanupTask.execute(ctx)).rejects.toThrow('telemetry broken');
    });

    it('returns disabled message when DISABLE_TELEMETRY_CLEANUP is set', async () => {
        process.env.DISABLE_TELEMETRY_CLEANUP = 'true';
        const result = await telemetryCleanupTask.execute(makeContext());
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(result.result?.message).toContain('DISABLE_TELEMETRY_CLEANUP');
        expect(cleanup).not.toHaveBeenCalled();
    });

    it('returns zero itemsProcessed and no-op message when nothing to delete', async () => {
        cleanup.mockResolvedValue(0);
        const result = await telemetryCleanupTask.execute(makeContext());
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(result.result?.message).toContain('No old telemetry records');
    });
});
