// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/tasks/{taskId}/run — how startRun refusals map to HTTP. An open
 * circuit breaker is an expected, temporary state: it must not surface as a
 * generic 500.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { TaskError } from '@sapd/lumastra-plugin-sdk';

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getTask: () => ({ id: 'metadata-sync' }) },
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

function makeEvent(): RequestEvent {
    const url = new URL('https://app.example/api/v1/tasks/metadata-sync/run');
    return {
        params: { taskId: 'metadata-sync' },
        url,
        request: new Request(url.toString(), { method: 'POST', body: '{}' }),
        locals: { principal: { userId: 'u1', username: 'alice' } },
    } as unknown as RequestEvent;
}

describe('POST /api/v1/tasks/{taskId}/run — refusals', () => {
    beforeEach(() => vi.clearAllMocks());

    it('an open circuit breaker answers 503 with the reason', async () => {
        startRunMock.mockRejectedValue(
            new TaskError({
                message: 'Circuit breaker is open for task metadata-sync: open_with_cooldown',
                kind: 'transient',
            }),
        );
        const res = await def.handlers.POST!(makeEvent(), { input: { body: {} } } as never);
        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('Circuit breaker is open');
    });

    it('a permanent refusal stays a validation error (422)', async () => {
        startRunMock.mockRejectedValue(
            new TaskError({ message: 'Quota exceeded for task metadata-sync', kind: 'permanent' }),
        );
        const res = await def.handlers.POST!(makeEvent(), { input: { body: {} } } as never);
        expect(res.status).toBe(422);
    });
});
