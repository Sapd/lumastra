// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/navigation', () => ({
    pushState: navigation.push,
    replaceState: navigation.replace,
}));
vi.mock('$lib/paths', () => ({ resolve: (p: string) => p, stripBase: (p: string) => p }));
const currentPage = writable({ state: {} as App.PageState });
vi.mock('$app/stores', () => ({
    page: {
        subscribe: (run: Parameters<typeof currentPage.subscribe>[0]) => currentPage.subscribe(run),
    },
}));
import { modals } from './modal.store';
import { reconcileModalsFromUrl } from './modal-url-sync';
const { openMediaModalFromUrl } = vi.hoisted(() => ({ openMediaModalFromUrl: vi.fn() }));
vi.mock('$lib/utils/modal-utils', () => ({ openMediaModalFromUrl }));

beforeEach(async () => {
    await modals.closeAll();
    window.history.replaceState({}, '', '/browse?q=matrix');
    currentPage.set({ state: { musicPlaylistOrigin: true } });
    navigation.push.mockReset().mockImplementation((url: string, state: App.PageState) => {
        window.history.pushState({}, '', url);
        currentPage.set({ state });
    });
    navigation.replace.mockReset().mockImplementation((url: string, state: App.PageState) => {
        window.history.replaceState({}, '', url);
        currentPage.set({ state });
    });
});

function actor(id: number): void {
    modals.openEntity(
        {} as never,
        { actorId: id, actorName: `Actor ${id}` },
        { trailKey: `actor:${id}` },
    );
}

describe('modal navigation history', () => {
    it('in-app Back traverses the known parent entry without pushing the child again', async () => {
        actor(1);
        actor(2);
        const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
        await modals.close();
        expect(back).toHaveBeenCalledTimes(1);
        expect(navigation.push).toHaveBeenCalledTimes(2);
        back.mockRestore();
    });

    it('returns from cast to the movie even when query parameter order changes', async () => {
        modals.openEntity(
            {} as never,
            {
                externalIds: { internal: 'a3f5e8c7-1234-5678-90ab-cdef12345678' },
                mediaType: 'movie',
                title: 'A movie',
            },
            { trailKey: 'media:a3f5e8c7-1234-5678-90ab-cdef12345678' },
        );
        actor(1);
        const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
        await modals.close();
        expect(back).toHaveBeenCalledTimes(1);
        expect(navigation.push).toHaveBeenCalledTimes(2);
        back.mockRestore();
    });

    it('preserves unrelated page state while opening and closing details', async () => {
        actor(1);
        expect(navigation.push.mock.calls[0][1]).toMatchObject({ musicPlaylistOrigin: true });
        await modals.closeAll();
        expect(navigation.replace.mock.calls.at(-1)?.[1]).toMatchObject({
            musicPlaylistOrigin: true,
        });
    });

    it('a same-entity replacement emits no temporary empty URL or extra history entry', () => {
        actor(1);
        modals.replace({} as never, { actorId: 1, actorName: 'Updated' }, { trailKey: 'actor:1' });
        expect(navigation.push).toHaveBeenCalledTimes(1);
        expect(navigation.replace).toHaveBeenCalledTimes(1);
        expect(navigation.replace.mock.calls[0][0]).toContain('actor=1');
    });
});

it('finishes rapid history traversals at the latest URL while a modal is loading', async () => {
    const id = 'a3f5e8c7-1234-5678-90ab-cdef12345678';
    let finish!: () => void;
    openMediaModalFromUrl.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
            finish = resolve;
        });
        modals.openEntity(
            {} as never,
            { externalIds: { internal: id }, mediaType: 'movie' },
            { trailKey: `media:${id}` },
        );
        return true;
    });
    window.history.replaceState({}, '', `/browse?modal=${id}`);
    const first = reconcileModalsFromUrl();
    await vi.waitFor(() => expect(openMediaModalFromUrl).toHaveBeenCalledTimes(1));
    window.history.replaceState({}, '', '/browse');
    const latest = reconcileModalsFromUrl();
    finish();
    await Promise.all([first, latest]);
    expect(modals.count).toBe(0);
    expect(window.location.search).toBe('');
    expect(navigation.push).not.toHaveBeenCalled();
});
