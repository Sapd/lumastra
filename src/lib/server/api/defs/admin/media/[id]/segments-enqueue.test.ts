// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    adminSession,
    adminOwnersReadWritePat,
} from '$lib/server/api/principal-locals.test-helpers.js';
const mocks = vi.hoisted(() => ({ start: vi.fn(), mediaType: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => () => Promise.resolve([{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }]),
}));
vi.mock('$lib/server/database/queries/media-segments.queries.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/queries/media-segments.queries.js')>()),
    getMediaTypeById: mocks.mediaType,
}));
vi.mock('$lib/server/database/queries/media-segment-input.queries.js', () => ({
    getAnalyzerReadinessBatch: vi.fn(async (_sql, ids: string[]) =>
        ids.map((mediaId) => ({
            mediaId,
            state: 'ready',
            inputIdentity: 'current',
            fileId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            filePath: '/fictional/current.mkv',
            alternate: false,
            proof: null,
        })),
    ),
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({ orchestrator: { startRun: mocks.start } }));
import { mount } from '$lib/server/api/mount.js';
import { def } from './segments.js';
const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function event(scope: string, admin = true, id = ID): RequestEvent {
    const url = new URL(`http://localhost/api/admin/media/${id}/segments`);
    return {
        url,
        request: new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scope }),
        }),
        params: { id },
        locals: admin ? adminSession() : adminOwnersReadWritePat(),
        route: { id: '/api/admin/media/[id]/segments' },
        cookies: { get: vi.fn(), set: vi.fn() },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
        fetch: vi.fn(),
    } as unknown as RequestEvent;
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.start.mockResolvedValue({ runId: 'selected-run', deduped: false });
});
it.each(['episode', 'movie'])(
    'the mounted %s action enqueues exactly its selected item',
    async (type) => {
        mocks.mediaType.mockResolvedValue(type);
        const response = await mount(def, { surface: 'internal' }).POST!(event('single'));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ runId: 'selected-run' });
        expect(mocks.start).toHaveBeenCalledExactlyOnceWith(
            'lumastra-intro-analyzer',
            { mediaId: ID },
            expect.objectContaining({ subject: { type: 'mediaItem', id: ID } }),
        );
    },
);
it.each([
    ['tv', 'seriesId'],
    ['season', 'seasonId'],
])('the mounted %s parent action retains its parent scope', async (type, key) => {
    mocks.mediaType.mockResolvedValue(type);
    expect((await mount(def, { surface: 'internal' }).POST!(event('children'))).status).toBe(200);
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(
        'lumastra-intro-analyzer',
        { [key]: ID },
        expect.objectContaining({ subject: { type: 'mediaItem', id: ID } }),
    );
});
it('rejects a token without admin authority before enqueue', async () => {
    expect((await mount(def, { surface: 'internal' }).POST!(event('single', false))).status).toBe(
        403,
    );
    expect(mocks.start).not.toHaveBeenCalled();
});
it('does not accept an alias or an invalid scope', async () => {
    expect(
        (await mount(def, { surface: 'internal' }).POST!(event('single', true, 'tmdb:550:movie')))
            .status,
    ).toBe(422);
    expect((await mount(def, { surface: 'internal' }).POST!(event('library'))).status).toBe(422);
    expect(mocks.start).not.toHaveBeenCalled();
});
