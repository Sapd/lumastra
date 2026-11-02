// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { pushState, replaceState } from '$app/navigation';
import { page } from '$app/stores';
import { get } from 'svelte/store';

export function openMusicPreview(key: 'station' | 'collection' | 'mix', id: number | string): void {
    const current = get(page);
    const url = new URL(current.url);
    for (const other of ['station', 'collection', 'mix']) url.searchParams.delete(other);
    url.searchParams.set(key, String(id));
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- current.url already includes the deployment base
    pushState(url.href, { ...current.state, musicPreviewUrl: url.href, musicPreviewPushed: true });
}

export function closeMusicPreview(key: 'station' | 'collection' | 'mix'): void {
    const current = get(page);
    if (current.state.musicPreviewPushed) {
        history.back();
        return;
    }
    const url = new URL(current.url);
    url.searchParams.delete(key);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- current.url already includes the deployment base
    replaceState(url.href, { ...current.state, musicPreviewUrl: url.href });
}
