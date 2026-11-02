// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the shared reconcile module so this suite is about the task
// DECLARATION and its delegation, not about Valkey/BullMQ.
const reconcileAndReadStatus = vi.fn();
vi.mock('../../global-pause-reconcile.js', async () => {
    const actual = await vi.importActual<typeof import('../../global-pause-reconcile.js')>(
        '../../global-pause-reconcile.js',
    );
    return {
        ...actual,
        reconcileAndReadStatus: (...args: unknown[]) => reconcileAndReadStatus(...args),
    };
});

import { pauseReconcileTask } from './pause-reconcile.js';
import { registry } from '../../registry.js';
import { GLOBAL_PAUSE_RECONCILE_TASK_ID } from '../../global-pause-reconcile.js';

interface MinimalCtx {
    logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
}

function ctx(): MinimalCtx {
    return { logger: { warn: vi.fn(), info: vi.fn() } };
}

describe('pause-reconcile task declaration', () => {
    beforeEach(() => {
        reconcileAndReadStatus.mockReset();
        reconcileAndReadStatus.mockResolvedValue({
            globalPause: { active: false },
            quietHours: { enabled: false, start: '01:00', end: '07:00', active: false },
        });
    });

    it('declares the id the global-pause-reconcile exemption is keyed on', () => {
        // The whole anti-deadlock design depends on these being the SAME
        // constant, not two independently-typed strings — see
        // global-pause-reconcile.ts's module doc.
        expect(pauseReconcileTask.id).toBe(GLOBAL_PAUSE_RECONCILE_TASK_ID);
    });

    it('self-registers under the id the builtin loader lists', () => {
        expect(registry.getTask(GLOBAL_PAUSE_RECONCILE_TASK_ID)).toBe(pauseReconcileTask);
    });

    it('runs on startup — a restart mid-pause must resume on schedule, not wait a full interval', () => {
        expect(pauseReconcileTask.schedule?.runOnStartup).toBe(true);
    });

    it('reconciles at minute-ish granularity — the pause window is only granular to hours', () => {
        expect(pauseReconcileTask.schedule?.every).toBe('1m');
    });

    it('is leader-gated the way every other cluster-singleton builtin is', () => {
        expect(pauseReconcileTask.resourceClass).toBe('maintenance');
        expect(pauseReconcileTask.scope).toBe('global');
        expect(pauseReconcileTask.identityFor?.({})).toBe('global');
        expect(pauseReconcileTask.quotas?.maxConcurrent).toBe(1);
    });

    it('delegates to the shared reconcile function used by the HTTP endpoint', async () => {
        const c = ctx();
        const res = await pauseReconcileTask.execute?.(c as never);
        expect(reconcileAndReadStatus).toHaveBeenCalledTimes(1);
        expect(res).toMatchObject({
            success: true,
            result: { globalPauseActive: false, quietHoursActive: false },
        });
    });

    it('reports an active pause in its result', async () => {
        reconcileAndReadStatus.mockResolvedValue({
            globalPause: { active: true, resumeAt: '2026-08-26T12:00:00.000Z' },
            quietHours: { enabled: true, start: '01:00', end: '07:00', active: true },
        });
        const res = await pauseReconcileTask.execute?.(ctx() as never);
        expect(res).toMatchObject({
            success: true,
            result: {
                globalPauseActive: true,
                globalPauseResumeAt: '2026-08-26T12:00:00.000Z',
                quietHoursActive: true,
            },
        });
    });
});
