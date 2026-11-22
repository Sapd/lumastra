// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { updateLiveTvCategory } from '$lib/server/services/livetv/category-admin.service.js';
import { def } from './index.js';

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn().mockResolvedValue({}) },
}));
vi.mock('$lib/server/services/livetv/category-admin.service.js', () => ({
    updateLiveTvCategory: vi.fn(),
}));
vi.mock('$lib/server/services/livetv-cache.service.js', () => ({
    invalidateLiveTvCaches: vi.fn(),
}));

const CATEGORY_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const CHANNEL_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const { PUT } = mount(def, { surface: 'v1' });

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
