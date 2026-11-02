// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({
    db: vi.fn(),
    snapshot: vi.fn(),
    enqueue: vi.fn(),
    page: vi.fn(),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: mocks.db }));
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFileHealthSnapshot: mocks.snapshot,
}));
vi.mock('$lib/server/database/queries/file-health-page.queries.js', async (importOriginal) => {
    const original =
        await importOriginal<
            typeof import('$lib/server/database/queries/file-health-page.queries.js')
        >();
    return { ...original, getFileHealthPage: mocks.page };
});
vi.mock('$lib/server/tasks/file-health-recheck.js', () => ({
    enqueueFileHealthRecheck: mocks.enqueue,
}));
import { def, FileHealthResponseSchema } from './file-health.js';
import { mount } from '$lib/server/api/mount.js';
import {
    adminSession,
    adminOwnersReadWritePat,
} from '$lib/server/api/principal-locals.test-helpers.js';
const FILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function event(admin = true, fileId = FILE): RequestEvent {
    const url = new URL('http://localhost/api/admin/media/file-health');
    return {
        url,
        request: new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ fileId }),
        }),
        params: {},
        locals: admin ? adminSession() : adminOwnersReadWritePat(),
        route: { id: '/api/admin/media/file-health' },
        cookies: { get: vi.fn(), set: vi.fn() },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
        fetch: vi.fn(),
    } as unknown as RequestEvent;
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.mockReturnValue({});
    mocks.snapshot.mockResolvedValue({ health_issues: [] });
    mocks.enqueue.mockResolvedValue({ runId: 'run_selected', deduped: false });
});
it('an admin can recheck a physical file without history or a media link', async () => {
    const response = await mount(def, { surface: 'internal' }).POST!(event());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ runId: 'run_selected', deduped: false });
    expect(mocks.snapshot).toHaveBeenCalledWith({}, FILE);
    expect(mocks.enqueue).toHaveBeenCalledWith(FILE, expect.anything());
});
it('refuses a non-admin token even when its owner is admin', async () => {
    const response = await mount(def, { surface: 'internal' }).POST!(event(false));
    expect(response.status).toBe(403);
    expect(mocks.enqueue).not.toHaveBeenCalled();
});
it('validates UUIDs before any file query or enqueue', async () => {
    const response = await mount(def, { surface: 'internal' }).POST!(event(true, 'bad'));
    expect(response.status).toBe(422);
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
});
it('returns 404 for an absent physical file', async () => {
    mocks.snapshot.mockResolvedValue(undefined);
    expect((await mount(def, { surface: 'internal' }).POST!(event())).status).toBe(404);
    expect(mocks.enqueue).not.toHaveBeenCalled();
});
it('returns the identical run when already queued, without claiming healthy', async () => {
    mocks.enqueue.mockResolvedValue({ runId: 'run_selected', deduped: true });
    const response = await mount(def, { surface: 'internal' }).POST!(event());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runId: 'run_selected', deduped: true });
});

it('canonicalizes UUID case so alternate spellings target the same queued file', async () => {
    await mount(def, { surface: 'internal' }).POST!(event(true, FILE.toUpperCase()));
    expect(mocks.snapshot).toHaveBeenCalledWith({}, FILE);
    expect(mocks.enqueue).toHaveBeenCalledWith(FILE, expect.anything());
});

it('GET validates scope and cursor before reading and returns a complete page', async () => {
    const input = event();
    input.url.searchParams.set('scope', 'informational');
    input.request = new Request(input.url);
    mocks.page.mockResolvedValue({
        files: [],
        count: 2,
        recorded: 2,
        actionable: 1,
        informational: 1,
        matching: 1,
        nextCursor: null,
        snapshotAt: '2026-10-25T12:00:00Z',
        scope: 'informational',
    });
    const response = await mount(def, { surface: 'internal' }).GET!(input);
    expect(response.status).toBe(200);
    expect(FileHealthResponseSchema.parse(await response.json()).informational).toBe(1);
    expect(mocks.page).toHaveBeenCalledWith({}, { scope: 'informational' });
    input.url.searchParams.set('cursor', 'bad');
    input.request = new Request(input.url);
    expect((await mount(def, { surface: 'internal' }).GET!(input)).status).toBe(422);
    expect(mocks.page).toHaveBeenCalledTimes(1);
    for (const bad of [
        '2026-02-30T12:00:00.000001Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        '0000-01-01T12:00:00.000001Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    ]) {
        input.url.searchParams.set('cursor', bad);
        input.request = new Request(input.url);
        expect((await mount(def, { surface: 'internal' }).GET!(input)).status).toBe(422);
    }
    expect(mocks.page).toHaveBeenCalledTimes(1);
});

it('keeps the detailed page on the admin-only internal surface', async () => {
    const input = event(false);
    input.request = new Request(input.url);
    const response = await mount(def, { surface: 'internal' }).GET!(input);
    expect(response.status).toBe(403);
    expect(mocks.page).not.toHaveBeenCalled();
    expect(def.visibility).toBe('internal');
});
