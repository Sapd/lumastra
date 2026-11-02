// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const start = vi.hoisted(() => vi.fn());
vi.mock('./orchestrator.js', () => ({ orchestrator: { startRun: start } }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFileHealthSnapshot: async () => ({ health_issues: [] }),
    getFilesWithHealthIssues: vi.fn(),
    countFilesWithHealthIssues: vi.fn(),
}));
vi.mock('$lib/server/database/queries/plugin-failure-events.queries.js', () => ({
    findLatestFailureEventId: async () => 'history',
    markFailureEventsResolved: vi.fn(),
}));
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getTask: () => ({ failures: { retry: vi.fn() } }) },
}));
vi.mock('$lib/server/utils/audit-log.js', () => ({ auditLog: vi.fn(), auditActor: vi.fn() }));
import { BackpressureError } from './backpressure.js';
import { TaskError } from '@sapd/lumastra-plugin-sdk';
import { def as health } from '$lib/server/api/defs/admin/media/file-health.js';
import { def as retry } from '$lib/server/api/defs/tasks/[taskId]/failures/[itemId]/retry.js';
import { mount } from '$lib/server/api/mount.js';
import { adminSession } from '$lib/server/api/principal-locals.test-helpers.js';
const FILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
beforeEach(() => vi.clearAllMocks());
it.each([health, retry])(
    'both selected enqueue entry points preserve expected refusal statuses and backoff',
    async (def) => {
        for (const [error, status, backoff] of [
            [new BackpressureError(1250), 429, '2'],
            [
                new TaskError({ kind: 'transient', message: 'queue temporarily unavailable' }),
                503,
                '5',
            ],
            [new TaskError({ kind: 'permanent', message: 'invalid task input' }), 400, null],
        ] as const) {
            start.mockRejectedValueOnce(error);
            const url = new URL('http://localhost/api/admin/media/file-health');
            const event = {
                url,
                request: new Request(url, {
                    method: 'POST',
                    body: JSON.stringify({ fileId: FILE }),
                    headers: { 'content-type': 'application/json' },
                }),
                params: { taskId: 'media-probe', itemId: FILE },
                locals: adminSession(),
                route: { id: null },
                getClientAddress: () => '127.0.0.1',
                setHeaders: vi.fn(),
            } as unknown as RequestEvent;
            const response = await mount(def, { surface: 'internal' }).POST!(event);
            expect(response.status).toBe(status);
            expect(response.headers.get('retry-after')).toBe(backoff);
            expect(await response.text()).not.toContain('runId');
        }
    },
);
