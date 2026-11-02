// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
const mocks = vi.hoisted(() => ({ sql: vi.fn(), sync: vi.fn(), start: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => mocks.sql }));
vi.mock('$lib/server/services/metadata-sync-single.service.js', () => ({
    syncSingleItem: mocks.sync,
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({ orchestrator: { startRun: mocks.start } }));
import { def } from './sync.js';
const id = '00000000-0000-4000-8000-000000000001';
const event = {
    params: { id },
    locals: { user: { username: 'operator' } },
} as unknown as RequestEvent;
function context(includeChildren: boolean): ApiContext<NonNullable<typeof def.request>> {
    return {
        surface: 'internal',
        input: {
            params: undefined,
            query: undefined,
            body: { includeChildren, forceChildren: false },
        },
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.mockResolvedValue([{ media_type: 'tv', metadata_locked: true }]);
    mocks.sync.mockResolvedValue({ updated: false, fieldsChanged: [] });
    mocks.start.mockResolvedValue({ runId: 'accepted-run', deduped: false });
});
it('refreshes a title without overriding a saved editing lock and returns the declared response', async () => {
    const response = await def.handlers.POST!(event, context(false));
    expect(mocks.sync).toHaveBeenCalledWith(mocks.sql, id, { force: true, respectLocks: true });
    expect(await response.json()).toEqual({ success: true, updated: false, fieldsChanged: [] });
});
it('queues parent maintenance with independent saved parent and child locks respected', async () => {
    const response = await def.handlers.POST!(event, context(true));
    expect(mocks.start).toHaveBeenCalledWith(
        'series-sync',
        expect.objectContaining({ force: true, respectLocks: true, forceChildren: false }),
        expect.anything(),
    );
    expect(await response.json()).toMatchObject({ success: true, runId: 'accepted-run' });
});
