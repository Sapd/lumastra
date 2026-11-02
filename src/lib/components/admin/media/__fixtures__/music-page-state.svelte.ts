// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { SvelteURL } from 'svelte/reactivity';
export const page = $state({
    state: {} as App.PageState,
    url: new SvelteURL('http://localhost/admin/library/media/album-1?tab=tracks'),
});
export function setMusicUrl(href: string): void {
    page.url = new SvelteURL(href, 'http://localhost');
    page.state = {};
}
export function setMusicShallowUrl(href: string | null): void {
    page.state = href ? { adminWorkspaceUrl: new SvelteURL(href, 'http://localhost').href } : {};
}
