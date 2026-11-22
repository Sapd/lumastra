// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from 'vitest';
import { apiPut } from '$lib/api/client.js';
import type { AdminChannelCategory } from '$lib/schemas/livetv.js';
import { toasts } from '$lib/stores/toast.store.js';
import * as m from '$lib/paraglide/messages.js';
import { ChannelStore } from './channel-store.svelte.js';

vi.mock('$lib/api/client.js', () => ({
    apiPut: vi.fn(),
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
}));
vi.mock('$lib/stores/toast.store.js', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function category(count: number, isVisible: boolean): AdminChannelCategory {
    return {
        id: 'news',
        name: 'News',
        sortOrder: 0,
        isVisible,
        channels: Array.from({ length: count }, (_, sortOrder) => ({
            id: `news-${sortOrder}`,
            name: `News ${sortOrder}`,
            images: {},
            sortOrder,
            categoryId: 'news',
            isVisible,
        })),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiPut).mockReset();
    vi.mocked(apiPut).mockResolvedValue({ data: null, error: null, status: 200 });
});

test('explains why a channel in a hidden category cannot be shown', async () => {
    const store = new ChannelStore();
    store.seed([category(1, false)]);

    await store.toggleVisibility('news-0', true);

    expect(toasts.info).toHaveBeenCalledWith(m.admin_livetv_channel_in_hidden_category());
    expect(apiPut).not.toHaveBeenCalled();
    expect(store.channelById('news-0')?.isVisible).toBe(false);
});

test('hides a category in one request and undoes both batches for 1001 channels', async () => {
    const store = new ChannelStore();
    const news = category(1001, true);
    const ids = news.channels.map((channel) => channel.id);
    store.seed([news]);
    vi.mocked(apiPut)
        .mockResolvedValueOnce(categoryResult(ids))
        .mockResolvedValueOnce(categoryResult(ids.slice(0, 1000)))
        .mockResolvedValueOnce(categoryResult(ids.slice(1000)));

    await store.hideAllChannelsInCategory(news.id);

    expect(apiPut).toHaveBeenCalledExactlyOnceWith(
        '/api/admin/livetv/categories/news',
        expect.anything(),
        { channelVisibility: 'hide' },
    );
    expect(store.categories[0].isVisible).toBe(true);
    expect(store.categories[0].channels.every((channel) => !channel.isVisible)).toBe(true);
    expect(store.keepShown.size).toBe(1001);
    await store.performUndo();
    expect(
        vi
            .mocked(apiPut)
            .mock.calls.slice(1)
            .map(([, , body]) => body),
    ).toEqual([
        { channelVisibility: { showIds: ids.slice(0, 1000) } },
        { channelVisibility: { showIds: ['news-1000'] } },
    ]);
    expect(store.categories[0].channels.every((channel) => channel.isVisible)).toBe(true);
});

function categoryResult(ids: string[]): {
    data: { success: true; updatedCount: number; updatedChannelIds: string[] };
    error: null;
    status: number;
} {
    return {
        data: { success: true, updatedCount: ids.length, updatedChannelIds: ids },
        error: null,
        status: 200,
    };
}

test('offers another Undo for only the channels whose restore failed', async () => {
    const store = new ChannelStore();
    const news = category(1001, true);
    const ids = news.channels.map((channel) => channel.id);
    store.seed([news]);
    vi.mocked(apiPut)
        .mockResolvedValueOnce(categoryResult(ids))
        .mockResolvedValueOnce(categoryResult(ids.slice(0, 1000)))
        .mockResolvedValueOnce({ data: null, error: 'Failed to restore', status: 500 })
        .mockResolvedValueOnce(categoryResult(ids.slice(1000)));

    await store.hideAllChannelsInCategory(news.id);
    await store.performUndo();

    expect(store.channelById('news-0')?.isVisible).toBe(true);
    expect(store.channelById('news-1000')?.isVisible).toBe(false);
    expect(toasts.error).toHaveBeenCalledWith(m.admin_livetv_bulk_error());
    expect(store.undoState?.message).toBe(m.admin_livetv_bulk_hide_undo({ count: 1 }));

    await store.performUndo();
    expect(apiPut).toHaveBeenLastCalledWith(
        '/api/admin/livetv/categories/news',
        expect.anything(),
        {
            channelVisibility: { showIds: ['news-1000'] },
        },
    );
    expect(store.categories[0].channels.every((channel) => channel.isVisible)).toBe(true);
});

test('refreshes authoritative visibility when a category hide response is lost', async () => {
    const store = new ChannelStore();
    store.seed([category(1, true)]);
    store.onNumbersChanged = vi.fn();
    vi.mocked(apiPut).mockResolvedValueOnce({ data: null, error: 'Timed out', status: 0 });

    await store.hideAllChannelsInCategory('news');

    expect(store.onNumbersChanged).toHaveBeenCalledOnce();
    expect(store.visibilityActionInFlight).toBe(false);
    expect(store.undoState).toBeNull();
    expect(toasts.error).toHaveBeenCalledWith(m.admin_livetv_bulk_error());
});

test('restores a rejected selected batch and unlocks visibility actions', async () => {
    const store = new ChannelStore();
    const news = category(1001, true);
    store.seed([news]);
    for (const channel of news.channels) store.selectedIds.add(channel.id);
    vi.mocked(apiPut)
        .mockResolvedValueOnce({ data: { updatedCount: 1000 }, error: null, status: 200 })
        .mockRejectedValueOnce(new Error('Contract mismatch'));

    await store.executeBulkAction('hide');

    expect(store.channelById('news-0')?.isVisible).toBe(false);
    expect(store.channelById('news-1000')?.isVisible).toBe(true);
    expect(store.visibilityActionInFlight).toBe(false);
    expect([...store.selectedIds]).toEqual(['news-1000']);
    expect(toasts.error).toHaveBeenCalledWith(m.admin_livetv_bulk_error());
    await store.performUndo();
});

test('bulk Show gives the hidden-category hint and shows eligible selected channels', async () => {
    const store = new ChannelStore();
    const news = category(1, false);
    const sport = {
        ...category(1, false),
        id: 'sport',
        isVisible: true,
        channels: [{ ...news.channels[0], id: 'sport-0', categoryId: 'sport' }],
    };
    store.seed([news, sport]);
    store.selectedIds.add('news-0');
    store.selectedIds.add('sport-0');

    await store.executeBulkAction('show');

    expect(toasts.info).toHaveBeenCalledWith(m.admin_livetv_channel_in_hidden_category());
    expect(apiPut).toHaveBeenCalledExactlyOnceWith(
        '/api/admin/livetv/channels/bulk',
        expect.anything(),
        { action: 'show', channelIds: ['sport-0'] },
    );
    expect(store.channelById('news-0')?.isVisible).toBe(false);
    expect(store.channelById('sport-0')?.isVisible).toBe(true);
    expect([...store.selectedIds]).toEqual(['news-0']);
    await store.performUndo();
});

test('reports the number of channels renumbered and reloads the list', async () => {
    const store = new ChannelStore();
    store.onNumbersChanged = vi.fn();
    vi.mocked(apiPut).mockResolvedValueOnce({
        data: { success: true, updatedCount: 0, renumbered: 3 },
        error: null,
        status: 200,
    });

    await store.setCategoryNumberStart('news', 100);

    expect(toasts.success).toHaveBeenCalledWith(
        m.admin_livetv_number_start_renumbered({ count: 3, start: 100 }),
    );
    expect(store.onNumbersChanged).toHaveBeenCalledOnce();
});
