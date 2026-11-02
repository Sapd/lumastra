// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { BacklogResponseSchema } from '$lib/schemas/task-definition.schema.js';

const { getTask, stages } = vi.hoisted(() => ({ getTask: vi.fn(), stages: vi.fn() }));
vi.mock('$lib/server/tasks/registry.js', () => ({ registry: { getTask } }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    buildAdminContextStub: vi.fn(() => ({})),
}));

import { mount } from '$lib/server/api/mount.js';
import { def } from './backlog.js';

function makeEvent(surface: 'internal' | 'v1'): RequestEvent {
    const path = `${surface === 'v1' ? '/api/v1' : '/api'}/tasks/example/backlog`;
    const url = new URL(path, 'https://app.example');
    return {
        url,
        request: new Request(url),
        params: { taskId: 'example' },
        route: { id: path },
        locals: {
            principal: {
                kind: 'session',
                userId: 'admin',
                username: 'admin',
                userGroups: [],
                scopes: ['admin', 'tasks:admin', 'tasks:read'],
                isAdmin: true,
            },
        },
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    getTask.mockReturnValue({ id: 'example', backlog: { unitLabel: 'items', stages } });
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe.each(['internal', 'v1'] as const)('task backlog (%s)', (surface) => {
    it.each(['test', 'production'])('preserves row keys through %s conformance', async (mode) => {
        // Production used to strip every id, making all keyed rows undefined.
        // Test mode must also accept the real handler without contract drift.
        vi.stubEnv('NODE_ENV', mode);
        const reportedStages = [
            { id: 'remaining', label: 'Remaining', count: 10 },
            { id: 'failed', label: 'Failed', count: 1 },
            { id: 'ineligible', label: 'Ineligible', count: 17 },
        ];
        stages.mockResolvedValue(reportedStages);
        const { GET } = mount(def, { surface });
        const response = await GET!(makeEvent(surface));

        expect(response.status).toBe(200);
        const body = BacklogResponseSchema.parse(await response.json());
        expect(body.stages).toEqual(reportedStages);
        expect(new Set(body.stages.map((stage) => stage.id)).size).toBe(3);
        expect(body.remainingHint).toBe(28);
        expect(body.unitLabel).toBe('items');
    });
});
