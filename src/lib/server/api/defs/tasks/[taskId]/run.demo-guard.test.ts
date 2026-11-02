// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 6, C6: `tmdb-metadata-sync.ts`'s `demo: true` task claimed to
 * be "hidden in production" but was directly triggerable through this def —
 * `registry.getTask()` was consulted with no `demo` check before dispatch.
 * This seam test drives the real handler (registry/orchestrator/audit-log are
 * the only mocked leaves) to pin the fix: a demo task is refused with 404 in
 * production, while a non-demo task and a demo task in development both still
 * run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const registryGetTaskMock = vi.fn();
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getTask: (...a: unknown[]) => registryGetTaskMock(...a) },
}));

const startRunMock = vi.fn();
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: (...a: unknown[]) => startRunMock(...a) },
}));

vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: vi.fn(),
    auditActor: () => ({ username: 'alice' }),
}));

const { def } = await import('./run.js');

function makeEvent(taskId: string): RequestEvent {
    const url = new URL(`https://app.example/api/v1/tasks/${taskId}/run`);
    return {
        params: { taskId },
        url,
        request: new Request(url.toString(), { method: 'POST', body: '{}' }),
        locals: { principal: { userId: 'u1', username: 'alice' } },
    } as unknown as RequestEvent;
}

// NODE_ENV is read directly by the guard at call time. Save/restore around
// each case so a thrown assertion never leaks a mode into another test.
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('POST /api/v1/tasks/{taskId}/run — demo task guard (C6)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        startRunMock.mockResolvedValue({ runId: 'run_1', deduped: false });
    });

    afterEach(() => {
        process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    });

    it('refuses a demo task in production with 404', async () => {
        process.env.NODE_ENV = 'production';
        registryGetTaskMock.mockReturnValue({ id: 'tmdb-metadata', demo: true });

        const res = await def.handlers.POST!(makeEvent('tmdb-metadata'), {
            input: { body: {} },
        } as never);

        expect(res.status).toBe(404);
        expect(startRunMock).not.toHaveBeenCalled();
    });

    it('control: a non-demo task in production is still accepted', async () => {
        process.env.NODE_ENV = 'production';
        registryGetTaskMock.mockReturnValue({ id: 'metadata-sync' });

        const res = await def.handlers.POST!(makeEvent('metadata-sync'), {
            input: { body: {} },
        } as never);

        expect(res.status).toBe(202);
        expect(startRunMock).toHaveBeenCalledWith('metadata-sync', {}, expect.anything());
    });

    it('control: a demo task in development is still accepted', async () => {
        process.env.NODE_ENV = 'development';
        registryGetTaskMock.mockReturnValue({ id: 'tmdb-metadata', demo: true });

        const res = await def.handlers.POST!(makeEvent('tmdb-metadata'), {
            input: { body: {} },
        } as never);

        expect(res.status).toBe(202);
        expect(startRunMock).toHaveBeenCalledWith('tmdb-metadata', {}, expect.anything());
    });
});

it('selected-file health input is admin-only even through the generic task trigger', async () => {
    vi.clearAllMocks();
    registryGetTaskMock.mockReturnValue({ id: 'media-probe' });
    const response = await def.handlers.POST!(makeEvent('media-probe'), {
        input: { body: { input: { fileId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } } },
    } as never);
    expect(response.status).toBe(403);
    expect(startRunMock).not.toHaveBeenCalled();
});
