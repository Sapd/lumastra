// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({
    latest: vi.fn(),
    resolve: vi.fn(),
    enqueue: vi.fn(),
    retry: vi.fn(),
}));
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getTask: () => ({ failures: { retry: mocks.retry } }) },
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/plugin-failure-events.queries.js', () => ({
    findLatestFailureEventId: mocks.latest,
    markFailureEventsResolved: mocks.resolve,
}));
vi.mock('$lib/server/tasks/file-health-recheck.js', () => ({
    enqueueFileHealthRecheck: mocks.enqueue,
}));
import { def } from './retry.js';
const FILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const event = (admin = true) =>
    ({
        params: { taskId: 'media-probe', itemId: FILE },
        locals: { principal: { isAdmin: admin } },
    }) as unknown as RequestEvent;
beforeEach(() => {
    vi.clearAllMocks();
    mocks.latest.mockResolvedValue('1');
    mocks.enqueue.mockResolvedValue({ runId: 'run_selected', deduped: false });
});
it('queue acceptance keeps historical failures unresolved and reports no item success', async () => {
    const response = await def.handlers.POST!(event(), {} as never);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ runId: 'run_selected', retried: false });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.retry).not.toHaveBeenCalled();
});
it('keeps the historical-event guard rather than making arbitrary retries valid', async () => {
    mocks.latest.mockResolvedValue(null);
    expect((await def.handlers.POST!(event(), {} as never)).status).toBe(404);
    expect(mocks.enqueue).not.toHaveBeenCalled();
});
it('selected file retries are admin-only', async () => {
    expect((await def.handlers.POST!(event(false), {} as never)).status).toBe(403);
    expect(mocks.enqueue).not.toHaveBeenCalled();
});
