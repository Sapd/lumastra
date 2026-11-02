// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
    pause: vi.fn(),
    resume: vi.fn(),
    force: vi.fn(),
    reschedule: vi.fn(),
}));
vi.mock('$lib/server/tasks/registry.js', () => ({ registry: { getTask: () => ({ id: 'test' }) } }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}), getTaskDb: () => ({}) }));
vi.mock('$lib/server/tasks/scheduler-state.js', () => ({
    getSchedulerState: async () => ({ paused: true }),
    pauseTask: mocks.pause,
    resumeTask: mocks.resume,
}));
vi.mock('$lib/server/tasks/circuit-breaker.js', () => ({
    CircuitBreaker: class {
        peek = async () => ({ state: 'closed', allowed: true });
        forceEnable = mocks.force;
    },
}));
vi.mock('$lib/server/tasks/trigger-service.js', () => ({
    rescheduleAfterResume: mocks.reschedule,
}));
vi.mock('$lib/server/cache/valkey.js', () => ({ getCoordinationClient: () => null }));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: vi.fn(),
    auditActor: () => ({ username: 'admin' }),
}));
import { mount } from '$lib/server/api/mount.js';
import { def } from './[taskId]/state.js';

function event(body: unknown): RequestEvent {
    const url = new URL('http://localhost/api/v1/tasks/test/state');
    return {
        url,
        request: new Request(url, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        params: { taskId: 'test' },
        locals: {
            principal: {
                kind: 'pat',
                userId: '00000000-0000-4000-8000-000000000001',
                username: 'admin',
                scopes: ['tasks:admin'],
                isAdmin: false,
            },
        },
        route: { id: null },
    } as unknown as RequestEvent;
}

describe('P3 task switches PATCH', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it.each(['internal', 'v1'] as const)(
        '%s keeps PUT absent and preserves the omitted breaker switch',
        async (surface) => {
            const handlers = mount(def, { surface });
            expect(handlers.PUT).toBeUndefined();
            const response = await handlers.PATCH!(event({ schedule: 'paused' }));
            expect(response.status).toBe(200);
            expect(mocks.pause).toHaveBeenCalledOnce();
            expect(mocks.force).not.toHaveBeenCalled();
            expect(mocks.resume).not.toHaveBeenCalled();
        },
    );
    it('preserves the omitted schedule when resetting a breaker', async () => {
        const response = await mount(def, { surface: 'v1' }).PATCH!(event({ breaker: 'reset' }));
        expect(response.status).toBe(200);
        expect(mocks.force).toHaveBeenCalledOnce();
        expect(mocks.pause).not.toHaveBeenCalled();
        expect(mocks.resume).not.toHaveBeenCalled();
        expect(mocks.reschedule).not.toHaveBeenCalled();
    });
});
