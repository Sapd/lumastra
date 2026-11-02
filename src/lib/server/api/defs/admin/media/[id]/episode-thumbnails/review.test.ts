// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    adminSession,
    adminOwnersReadWritePat,
} from '$lib/server/api/principal-locals.test-helpers.js';

const mocks = vi.hoisted(() => ({
    item: vi.fn(),
    list: vi.fn(),
    capture: vi.fn(),
    start: vi.fn(),
    begin: vi.fn(),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({ begin: mocks.begin }) }));
vi.mock('$lib/server/database/queries/image-sync.queries.js', () => ({
    getMediaItemForImageSync: mocks.item,
}));
vi.mock('$lib/server/database/queries/media-artwork.queries.js', () => ({
    listSharedEpisodeThumbReview: mocks.list,
}));
vi.mock('$lib/server/services/explicit-episode-thumbnail.service.js', () => ({
    captureExplicitEpisodeThumbnailInput: mocks.capture,
    explicitEpisodeThumbnailReviewToken: () => 'a'.repeat(64),
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({ orchestrator: { startRun: mocks.start } }));
import { mount } from '$lib/server/api/mount.js';
import { def as reviewDef } from './review.js';
import { def as regenerateDef } from './regenerate.js';

const id = '781cf231-79ed-448e-b4b9-5adc65b70229';
const episodeId = '157ed980-23aa-4cde-99ce-bf3770af11d1';
const fileId = 'a5577691-ea6d-4086-b5a8-b03ad43e8ea8';
const candidateId = 'bfaf9048-c913-4989-96fd-1a92efb65455';
const input = {
    episodeId,
    fileId,
    videoPath: '/library/current.mkv',
    selectedCandidateId: candidateId,
    durationSeconds: 600,
    fileGeneration: 'file',
    mediaGeneration: 'media',
    siblingGeneration: 'siblings',
    artworkGeneration: 'artwork',
    physicalIdentity: 'physical',
    span: { base: 0, duration: 600 },
};
const row = {
    episodeId,
    episodeTitle: 'Fictional episode',
    seasonNumber: 1,
    episodeNumber: 2,
    selectedCandidateId: candidateId,
    artworkPath: '/library/shared-thumb.jpg',
    sharedCount: 2,
    candidateCount: 3,
    chosenBy: 'auto',
    locked: false,
    provider: 'local-folder',
    suppressed: false,
    sourceFileId: fileId,
    sourcePath: '/library/current.mkv',
    sourceMissing: false,
    sourceDurationSeconds: 600,
    sourceSharedCount: 2,
    startOffsetMs: null,
    endOffsetMs: null,
};

function event(route: 'review' | 'regenerate', admin = true, body?: object): RequestEvent {
    const targetId = route === 'review' ? id : episodeId;
    const url = new URL(`http://localhost/api/admin/media/${targetId}/episode-thumbnails/${route}`);
    if (route === 'review') url.search = '?limit=1&offset=1';
    return {
        url,
        request: new Request(
            url,
            body
                ? {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify(body),
                  }
                : undefined,
        ),
        params: { id: targetId },
        locals: admin ? adminSession() : adminOwnersReadWritePat(),
        route: { id: `/api/admin/media/[id]/episode-thumbnails/${route}` },
        cookies: { get: vi.fn(), set: vi.fn() },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
        fetch: vi.fn(),
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.item.mockResolvedValue({ id, media_type: 'tv' });
    mocks.list.mockResolvedValue({ total: 2, rows: [row] });
    mocks.capture.mockResolvedValue(input);
    mocks.start.mockResolvedValue({ runId: 'reviewed-run', deduped: false });
    mocks.begin.mockImplementation(async (_options, callback) => callback({ snapshot: true }));
});

it('mounts an admin-only bounded review with strict response shape', async () => {
    const response = await mount(reviewDef, { surface: 'internal' }).GET!(event('review'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
        total: 2,
        limit: 1,
        offset: 1,
        rows: [{ episodeId, reviewToken: 'a'.repeat(64) }],
    });
    expect(mocks.list).toHaveBeenCalledWith(expect.anything(), id, 1, 1);
    expect(mocks.begin).toHaveBeenCalledWith(
        'isolation level repeatable read read only',
        expect.any(Function),
    );
    expect(mocks.capture).toHaveBeenCalledWith({ snapshot: true }, episodeId);
    expect(
        (await mount(reviewDef, { surface: 'internal' }).GET!(event('review', false))).status,
    ).toBe(403);
});

it('rejects a page observation after a changed source before queuing work', async () => {
    mocks.item.mockResolvedValue({ id: episodeId, media_type: 'episode' });
    const response = await mount(regenerateDef, { surface: 'internal' }).POST!(
        event('regenerate', true, {
            scope: 'episode',
            reviewToken: 'b'.repeat(64),
        }),
    );
    expect(response.status).toBe(409);
    expect(mocks.start).not.toHaveBeenCalled();
});

it('carries the request-time episode snapshot into the queued task', async () => {
    mocks.item.mockResolvedValue({ id: episodeId, media_type: 'episode' });
    const response = await mount(regenerateDef, { surface: 'internal' }).POST!(
        event('regenerate', true, {
            scope: 'episode',
            reviewToken: 'a'.repeat(64),
        }),
    );
    expect(response.status).toBe(200);
    expect(mocks.start).toHaveBeenCalledWith(
        'episode-thumbnail-extract',
        expect.objectContaining({ reviewedInput: input }),
        expect.anything(),
    );
    expect(
        (
            await mount(regenerateDef, { surface: 'internal' }).POST!(
                event('regenerate', false, {
                    scope: 'episode',
                    reviewToken: 'a'.repeat(64),
                }),
            )
        ).status,
    ).toBe(403);
});
