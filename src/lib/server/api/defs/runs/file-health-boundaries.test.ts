// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), cancel: vi.fn(), bulk: vi.fn() }));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        getRun: mocks.get,
        listRuns: mocks.list,
        cancelRun: mocks.cancel,
        nuclearStop: mocks.bulk,
    },
}));
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getTask: () => ({ name: 'Media Probe' }) },
}));
vi.mock('$lib/server/database/connection.js', () => ({ getTaskDb: () => null }));
vi.mock('$lib/server/utils/audit-log.js', () => ({ auditLog: vi.fn(), auditActor: vi.fn() }));
import { mount } from '$lib/server/api/mount.js';
import { adminSession, principalLocals } from '$lib/server/api/principal-locals.test-helpers.js';
import { def as single } from './[id]/cancel.js';
import { def as bulk } from './cancel.js';
import { def as detail } from './[id].js';
import { def as list } from './index.js';
const FILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const run = {
    id: 'run_selected',
    taskId: 'media-probe',
    label: 'Media Probe',
    state: 'completed',
    input: { fileId: FILE },
    trigger: { kind: 'manual' },
    startedAt: '2026-10-24T00:00:00Z',
    stages: [],
    actor: { type: 'system' },
    result: {
        success: true,
        itemsProcessed: 1,
        result: {
            recheck: {
                fileId: FILE,
                outcome: 'warning',
                issues: [
                    { type: 'video_decode_gaps', detail: '/private/secret.mkv decoder output' },
                ],
                reason: 'warnings_remain',
                rawReason: '/private/secret.mkv failed',
            },
        },
        nested: { secret: '/private/secret.mkv ffmpeg credentials' },
    },
};
function event(path: string, admin = false, method = 'POST'): RequestEvent {
    const url = new URL(`http://localhost/api/v1/runs/${path}`);
    return {
        url,
        request: new Request(url, {
            method,
            ...(method === 'POST'
                ? { body: '{}', headers: { 'content-type': 'application/json' } }
                : {}),
        }),
        params: { id: run.id },
        route: {
            id:
                method === 'GET'
                    ? path
                        ? '/api/v1/runs/[id]'
                        : '/api/v1/runs'
                    : path.startsWith('cancel?')
                      ? '/api/v1/runs/cancel'
                      : '/api/v1/runs/[id]/cancel',
        },
        locals: admin
            ? adminSession()
            : principalLocals({
                  kind: 'pat',
                  ownerIsAdmin: true,
                  tokenScopes: ['tasks:run', 'runs:read'],
              }),
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
        cookies: { get: vi.fn(), set: vi.fn() },
    } as unknown as RequestEvent;
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(run);
    mocks.list.mockResolvedValue({ runs: [run] });
    mocks.cancel.mockResolvedValue({ accepted: true });
    mocks.bulk.mockResolvedValue({ cancelled: 1, orphaned: 0, escalated: 0 });
});
it.each([false, true])(
    'single selected-file cancellation requires an admin principal (admin=%s)',
    async (admin) => {
        const response = await mount(single, { surface: 'v1' }).POST!(
            event('run_selected/cancel', admin),
        );
        expect(response.status).toBe(admin ? 200 : 403);
        expect(mocks.cancel).toHaveBeenCalledTimes(admin ? 1 : 0);
    },
);
it.each([false, true])(
    'bulk media-probe cancellation requires admin before any side effects (admin=%s)',
    async (admin) => {
        const response = await mount(bulk, { surface: 'v1' }).POST!(
            event('cancel?byTask=media-probe', admin),
        );
        expect(response.status).toBe(admin ? 200 : 403);
        expect(mocks.bulk).toHaveBeenCalledTimes(admin ? 1 : 0);
    },
);
it('retains ordinary tasks:run cancellation for a broad run and unrelated tasks', async () => {
    mocks.get.mockResolvedValue({ ...run, input: {} });
    expect((await mount(single, { surface: 'v1' }).POST!(event('run_broad/cancel'))).status).toBe(
        200,
    );
    expect(
        (await mount(bulk, { surface: 'v1' }).POST!(event('cancel?byTask=other-task'))).status,
    ).toBe(200);
});
it.each([false, true])(
    'ordinary runs:read never exposes selected raw evidence through list=%s',
    async (collection) => {
        const response = collection
            ? await mount(list, { surface: 'v1' }).GET!(event('', false, 'GET'))
            : await mount(detail, { surface: 'v1' }).GET!(event('run_selected', false, 'GET'));
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(JSON.stringify(body)).not.toContain('/private/');
        const saved = collection ? body.items[0] : body;
        expect(saved.result.recheck).toMatchObject({
            fileId: FILE,
            outcome: 'warning',
            issues: [{ type: 'video_decode_gaps' }],
        });
    },
);

it('fails closed when a nonadmin cancellation cannot resolve the run identity', async () => {
    mocks.get.mockResolvedValue(null);
    expect((await mount(single, { surface: 'v1' }).POST!(event('run_unknown/cancel'))).status).toBe(
        404,
    );
    expect(mocks.cancel).not.toHaveBeenCalled();
});

it.each([
    null,
    {
        recheck: {
            fileId: FILE,
            outcome: 'healthy',
            issues: [],
            raw: '/private/legacy.mkv ffmpeg credentials',
        },
    },
    { success: false, result: run.result.result },
])('mounted GET drops legacy or malformed selected results: %j', async (result) => {
    mocks.get.mockResolvedValue({ ...run, result });
    const response = await mount(detail, { surface: 'v1' }).GET!(
        event('run_selected', false, 'GET'),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('/private/');
});
it.each([{ input: {} }, { taskId: 'other-task' }])(
    'mounted GET preserves ordinary result contracts: %j',
    async (extra) => {
        mocks.get.mockResolvedValue({ ...run, ...extra });
        const response = await mount(detail, { surface: 'v1' }).GET!(
            event('run_selected', false, 'GET'),
        );
        expect(response.status).toBe(200);
        expect((await response.json()).result).toEqual(run.result);
    },
);
