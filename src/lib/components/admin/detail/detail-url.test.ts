// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { openDetail, replaceDetail, parseTaskDetailPath } from './detail-url.js';

const navigation = vi.hoisted(() => ({ pushState: vi.fn(), replaceState: vi.fn() }));
const state: App.PageState = {
    adminWorkspaceUrl: 'http://localhost/admin/tasks?q=harbor',
    musicPlaylistOrigin: true,
};
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/navigation', () => navigation);
vi.mock('$lib/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$app/stores', () => ({
    page: {
        subscribe: (run: (page: { state: App.PageState }) => void) => {
            run({ state });
            return () => {};
        },
    },
}));

describe('detail panel history state', () => {
    it.each([
        ['open', openDetail, navigation.pushState],
        ['replace', replaceDetail, navigation.replaceState],
    ] as const)('%s preserves unrelated page state', (_name, write, spy) => {
        write('/admin/tasks/lantern');
        expect(spy).toHaveBeenLastCalledWith('/admin/tasks/lantern', {
            ...state,
            detailPanel: { path: '/admin/tasks/lantern' },
        });
    });
});

describe('parseTaskDetailPath', () => {
    it('reads the task id from a plain detail path', () => {
        expect(parseTaskDetailPath('/admin/tasks/plugin%3Aimage-sync')).toEqual({
            taskId: 'plugin:image-sync',
        });
    });

    it('opens the runs tab without folding the query into the task id', () => {
        expect(parseTaskDetailPath('/admin/tasks/plugin%3Aimage-sync?tab=runs')).toEqual({
            taskId: 'plugin:image-sync',
            tab: 'runs',
        });
    });

    it('ignores unknown tabs', () => {
        expect(parseTaskDetailPath('/admin/tasks/image-sync?tab=nope')).toEqual({
            taskId: 'image-sync',
        });
    });
});
