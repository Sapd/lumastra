// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import {
    queueCategoryDelete,
    updateLiveTvCategory,
} from '$lib/server/services/livetv/category-admin.service.js';
import {
    deleteEmptyCategory,
    getCategoryDeletionSnapshot,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import { def } from './index.js';

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn().mockResolvedValue({}) },
}));
vi.mock('$lib/server/services/livetv/category-admin.service.js', () => ({
    updateLiveTvCategory: vi.fn(),
    queueCategoryDelete: vi.fn(),
}));
vi.mock('$lib/server/database/queries/livetv-channels.queries.js', () => ({
    deleteEmptyCategory: vi.fn(),
    getCategoryById: vi.fn(),
    getCategoryDeletionSnapshot: vi.fn(),
}));
vi.mock('$lib/server/services/livetv-cache.service.js', () => ({
    invalidateLiveTvCaches: vi.fn(),
}));

const CATEGORY_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const REVISION = 'a'.repeat(64);
const ACTOR_ID = 'aaaaaaaa-0000-4000-8000-000000000003';
const CHANNEL_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const { PUT, DELETE } = mount(def, { surface: 'v1' });

function updateCategory(body: unknown, scopes = ['livetv:admin']): Promise<Response> {
    const url = new URL(`http://localhost/api/v1/livetv/admin/categories/${CATEGORY_ID}`);
    const event = {
        url,
        request: new Request(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        params: { categoryId: CATEGORY_ID },
        route: { id: '/api/v1/livetv/admin/categories/[id]' },
        locals: { principal: { scopes } },
    } as unknown as RequestEvent;
    return Promise.resolve(PUT!(event));
}

describe('category PUT', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(updateLiveTvCategory).mockReset();
    });

    it('returns the renumbered count and invalidates after the category service succeeds', async () => {
        vi.mocked(updateLiveTvCategory).mockResolvedValue({
            success: true,
            updatedCount: 0,
            renumbered: 3,
        });
        const response = await updateCategory({ numberStart: 100 });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ success: true, updatedCount: 0, renumbered: 3 });
        expect(updateLiveTvCategory).toHaveBeenCalledWith({}, CATEGORY_ID, { numberStart: 100 });
        const saveOrder = vi.mocked(updateLiveTvCategory).mock.invocationCallOrder[0];
        const invalidateOrder = vi.mocked(invalidateLiveTvCaches).mock.invocationCallOrder[0];
        expect(saveOrder).toBeLessThan(invalidateOrder);
    });

    it('reports a failed category transaction without invalidating caches', async () => {
        vi.mocked(updateLiveTvCategory).mockRejectedValue(new Error('renumber failed'));
        const response = await updateCategory({ numberStart: 100 });

        expect(response.status).toBe(500);
        expect(invalidateLiveTvCaches).not.toHaveBeenCalled();
    });

    it('returns the exact visibility changes from the category service', async () => {
        vi.mocked(updateLiveTvCategory).mockResolvedValue({
            success: true,
            updatedCount: 1,
            updatedChannelIds: [CHANNEL_ID],
        });
        const response = await updateCategory({ channelVisibility: 'hide' });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            success: true,
            updatedCount: 1,
            updatedChannelIds: [CHANNEL_ID],
        });
        expect(updateLiveTvCategory).toHaveBeenCalledWith({}, CATEGORY_ID, {
            channelVisibility: 'hide',
        });
    });

    it('requires Live TV admin scope for category channel changes', async () => {
        const response = await updateCategory({ channelVisibility: 'hide' }, ['read']);

        expect(response.status).toBe(403);
        expect(updateLiveTvCategory).not.toHaveBeenCalled();
    });
});

function deleteCategory(
    withChannels: string | undefined,
    scopes = ['livetv:admin'],
    categoryId = CATEGORY_ID,
): Promise<Response> {
    const url = new URL(`http://localhost/api/v1/livetv/admin/categories/${categoryId}`);
    if (withChannels !== undefined) url.searchParams.set('withChannels', withChannels);
    const event = {
        url,
        request: new Request(url, { method: 'DELETE' }),
        params: { categoryId },
        route: { id: '/api/v1/livetv/admin/categories/[id]' },
        locals: { principal: { kind: 'pat', scopes, username: 'owner', userId: ACTOR_ID } },
    } as unknown as RequestEvent;
    return Promise.resolve(DELETE!(event));
}

describe('category DELETE', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getCategoryDeletionSnapshot).mockResolvedValue({
            id: CATEGORY_ID,
            revision: REVISION,
        });
    });

    it('queues destructive deletion only after explicit opt-in', async () => {
        vi.mocked(deleteEmptyCategory).mockResolvedValueOnce({
            deleted: false,
            reason: 'has_channels',
        });
        expect((await deleteCategory(undefined)).status).toBe(422);
        expect(queueCategoryDelete).not.toHaveBeenCalled();

        vi.mocked(queueCategoryDelete).mockResolvedValueOnce('delete-run');
        const response = await deleteCategory('true');
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ taskId: 'delete-run' });
        expect(queueCategoryDelete).toHaveBeenCalledExactlyOnceWith(
            CATEGORY_ID,
            REVISION,
            ACTOR_ID,
        );
        expect(invalidateLiveTvCaches).not.toHaveBeenCalled();
    });

    it('rejects an invalid destructive-delete query value before dispatch', async () => {
        expect((await deleteCategory('yes')).status).toBe(422);
        expect(queueCategoryDelete).not.toHaveBeenCalled();
        expect(deleteEmptyCategory).not.toHaveBeenCalled();
    });

    it('queues the canonical category ID for an accepted alternate UUID spelling', async () => {
        vi.mocked(queueCategoryDelete).mockResolvedValueOnce('delete-run');

        const idWithoutDashes = CATEGORY_ID.replaceAll('-', '').toUpperCase();
        expect((await deleteCategory('true', ['livetv:admin'], idWithoutDashes)).status).toBe(202);
        expect(queueCategoryDelete).toHaveBeenCalledExactlyOnceWith(
            CATEGORY_ID,
            REVISION,
            ACTOR_ID,
        );
    });

    it('returns a 404 when the category is missing', async () => {
        vi.mocked(getCategoryDeletionSnapshot).mockResolvedValueOnce(null);
        expect((await deleteCategory('true')).status).toBe(404);
        expect(queueCategoryDelete).not.toHaveBeenCalled();
    });

    it('does not claim deletion was queued when the task runner fails', async () => {
        vi.mocked(queueCategoryDelete).mockRejectedValueOnce(new Error('runner unavailable'));
        expect((await deleteCategory('true')).status).toBe(503);
    });

    it('requires Live TV admin scope for destructive deletion', async () => {
        expect((await deleteCategory('true', ['read'])).status).toBe(403);
        expect(queueCategoryDelete).not.toHaveBeenCalled();
    });
});
