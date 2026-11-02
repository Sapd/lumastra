// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AdminChannel, AdminChannelCategory } from '$lib/schemas/livetv.js';

const apiPut = vi.fn();
vi.mock('$lib/api/client.js', () => ({
    apiPut: (...args: unknown[]) => apiPut(...args),
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
    apiGet: vi.fn(),
}));
vi.mock('$lib/stores/toast.store.js', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { ChannelStore } = await import('./channel-store.svelte.js');

function ch(id: string, categoryId?: string, isVisible = true): AdminChannel {
    return { id, name: id, isVisible, categoryId } as AdminChannel;
}
function cat(id: string, channels: AdminChannel[]): AdminChannelCategory {
    return { id, name: id, sortOrder: 0, isVisible: true, channels };
}
const ids = (store: InstanceType<typeof ChannelStore>, id: string): string[] =>
    (store.categories.find((c) => c.id === id)?.channels ?? []).map((c) => c.id);

describe('ChannelStore moves to a category', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        apiPut.mockResolvedValue({ data: { success: true }, error: null });
    });
    afterEach(() => {
        vi.useRealTimers();
        apiPut.mockReset();
    });

    function seeded(): InstanceType<typeof ChannelStore> {
        const store = new ChannelStore();
        store.seed(
            [
                cat('news', [ch('n1', 'news'), ch('n2', 'news'), ch('n3', 'news')]),
                cat('sport', [ch('s1', 'sport'), ch('s2', 'sport')]),
            ].map((c) => ({
                ...c,
                channels: c.channels.map((x, i) => ({ ...x, sortOrder: i })),
            })),
        );
        return store;
    }

    function withHidden(): InstanceType<typeof ChannelStore> {
        const store = new ChannelStore();
        store.seed([
            cat('news', [ch('p', 'news'), ch('p2', 'news', false), ch('q', 'news')]),
            cat('sport', [ch('s1', 'sport')]),
        ]);
        return store;
    }

    test('an edit made while a save is in flight is saved by the next request', async () => {
        const store = seeded();
        let resolveFirst: (v: unknown) => void = () => {};
        apiPut.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
        store.contextMoveToCategory('n1', 'sport');
        await vi.advanceTimersByTimeAsync(600); // first save starts, still pending
        store.contextMoveToCategory('n2', 'sport', 'top');
        resolveFirst({ data: { success: true }, error: null });
        await vi.advanceTimersByTimeAsync(600);

        expect(apiPut).toHaveBeenCalledTimes(2);
        const second = (apiPut.mock.calls[1] as [string, unknown, { channels?: unknown[] }])[2];
        expect(second.channels).toEqual(
            expect.arrayContaining([{ id: 'n2', sortOrder: 0, categoryId: 'sport' }]),
        );
    });

    test('a second save sends only what changed since the first one stored', async () => {
        const store = seeded();
        store.contextMoveToCategory('n1', 'sport', 'top');
        await vi.advanceTimersByTimeAsync(600);
        store.contextMoveToCategory('s2', 'sport', 'top');
        await vi.advanceTimersByTimeAsync(600);

        expect(apiPut).toHaveBeenCalledTimes(2);
        const second = (apiPut.mock.calls[1] as [string, unknown, { channels?: unknown[] }])[2];
        // sport n1, s1, s2 -> s2, n1, s1: three renumbered rows; news is untouched.
        expect(second.channels).toEqual([
            { id: 's2', sortOrder: 0, categoryId: 'sport' },
            { id: 'n1', sortOrder: 1, categoryId: 'sport' },
            { id: 's1', sortOrder: 2, categoryId: 'sport' },
        ]);
    });

    test('a failed save drops the pending save of the edit it rolled back', async () => {
        const store = seeded();
        let resolveFirst: (v: unknown) => void = () => {};
        apiPut.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
        store.contextMoveToCategory('n1', 'sport');
        await vi.advanceTimersByTimeAsync(600);
        store.contextMoveToCategory('n2', 'sport');
        resolveFirst({ data: null, error: 'boom' });
        await vi.advanceTimersByTimeAsync(600);

        expect(apiPut).toHaveBeenCalledTimes(1);
        expect(ids(store, 'news')).toEqual(['n1', 'n2', 'n3']);
    });

    test('switching hidden channels out of view drops them from the selection', () => {
        const store = withHidden();
        store.setShowHidden(true);
        store.enterSelectionMode();
        store.selectAllInCategory('news');
        expect(store.selectedIds.has('p2')).toBe(true);
        store.setShowHidden(false);
        expect([...store.selectedIds].sort()).toEqual(['p', 'q']);
    });

    test('with hidden channels out of view a move carries the hidden feed behind it', () => {
        const store = withHidden();
        store.contextMoveToCategory('p', 'sport');
        expect(ids(store, 'news')).toEqual(['q']);
        expect(ids(store, 'sport')).toEqual(['s1', 'p', 'p2']);
    });

    test('with hidden channels shown, a move takes only the channel', () => {
        const store = withHidden();
        store.setShowHidden(true);
        store.contextMoveToCategory('p', 'sport');
        expect(ids(store, 'news')).toEqual(['p2', 'q']);
    });

    test('select all in a category leaves out channels that are not shown', () => {
        const store = withHidden();
        store.enterSelectionMode();
        store.selectAllInCategory('news');
        expect([...store.selectedIds].sort()).toEqual(['p', 'q']);
        expect(store.allSelected()).toBe(false); // sport's s1 is not selected
        store.toggleSelectAll();
        expect(store.allSelected()).toBe(true);
        expect(store.selectedIds.has('p2')).toBe(false);
    });

    test('bulk move lists the channels under the new category and saves only them', async () => {
        const store = seeded();
        store.enterSelectionMode();
        store.toggleSelect('n3');
        store.toggleSelect('n1');
        store.bulkMoveToCategory('sport', 'top');

        expect(ids(store, 'news')).toEqual(['n2']);
        expect(ids(store, 'sport')).toEqual(['n1', 'n3', 's1', 's2']);
        expect(store.selectedIds.size).toBe(0);

        await vi.advanceTimersByTimeAsync(600);
        expect(apiPut).toHaveBeenCalledTimes(1);
        const [url, , body] = apiPut.mock.calls[0] as [string, unknown, { channels: unknown[] }];
        expect(url).toBe('/api/admin/livetv/channels/reorder');
        expect(body.channels).toEqual(
            expect.arrayContaining([
                { id: 'n1', sortOrder: 0, categoryId: 'sport' },
                { id: 'n3', sortOrder: 1, categoryId: 'sport' },
            ]),
        );
    });

    test('a drag into another category carries the hidden feed when hidden channels are out of view', () => {
        const store = withHidden();
        const filter = { query: '', hideHidden: true };
        store.noteChannelDragConsider('p', 'dragStarted');
        // The sport zone's visible payload after the drop: p landed before s1.
        store.applyChannelDrop(
            'sport',
            [ch('p', 'news'), ch('s1', 'sport')],
            'p',
            filter,
            'droppedIntoZone',
        );
        expect(ids(store, 'news')).toEqual(['q']);
        expect(ids(store, 'sport')).toEqual(['p', 'p2', 's1']);
    });

    test('a drag with hidden channels shown moves only the dragged channel', () => {
        const store = withHidden();
        store.noteChannelDragConsider('p', 'dragStarted');
        store.applyChannelDrop(
            'sport',
            [ch('p', 'news'), ch('s1', 'sport')],
            'p',
            { query: '', hideHidden: false },
            'droppedIntoZone',
        );
        expect(ids(store, 'news')).toEqual(['p2', 'q']);
    });

    test('a keyboard reorder in a filtered pane keeps the hidden feed behind its channel', () => {
        const store = withHidden();
        // Visible order q, p (p moved down): p2 stays right after p.
        store.applyChannelZone('news', [ch('q', 'news'), ch('p', 'news')], {
            query: '',
            hideHidden: true,
        });
        expect(ids(store, 'news')).toEqual(['q', 'p', 'p2']);
    });

    test('context move appends at the end by default', () => {
        const store = seeded();
        store.contextMoveToCategory('s1', 'news');
        expect(ids(store, 'news')).toEqual(['n1', 'n2', 'n3', 's1']);
        expect(ids(store, 'sport')).toEqual(['s2']);
    });
});
