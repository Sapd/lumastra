// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable svelte/no-navigation-without-resolve -- every call below is
   already wrapped in resolve() from $lib/paths; the rule only recognizes
   imports from $app/paths directly (same rationale as modal-url-sync.ts). */

/**
 * URL-backing helpers for the shared `DetailPanel` shell (admin IA redesign,
 * spec §6): "URL-backed (`/admin/tasks/<id>` is what the panel shows) so
 * refresh/share/back work."
 *
 * Uses SvelteKit shallow routing (`pushState`/`replaceState`) instead of a
 * real navigation: opening a detail item from a list pushes the item's own
 * route onto the history stack and stamps `page.state.detailPanel` so the
 * list page knows to render the panel over itself, WITHOUT tearing down the
 * list (no `load()` re-run, no scroll reset). A refresh, a shared link, or a
 * narrow-screen visit hits the item's own route directly — `page.state` is
 * always `{}` on those (SvelteKit's shallow-routing contract), so the
 * dedicated page-mode route renders instead. That symmetry is what gives
 * every `DetailPanel` consumer "same component, two renderings" for free —
 * callers never need a manual "open in full page" escape hatch.
 *
 * Contract for list pages (steps 6/7 wire the actual task/run lists onto
 * this): call `openDetail('/admin/tasks/<id>')` on row click, and render
 * `<DetailPanel mode="auto">` when `page.state.detailPanel` is set, reading
 * the id back out of `page.url.pathname`. Call `closeDetail(listPath)` from
 * the panel's `onclose`.
 */

import { browser } from '$app/environment';
import { goto, pushState, replaceState } from '$app/navigation';
import { page } from '$app/stores';
import { get } from 'svelte/store';
import { resolve } from '$lib/paths';

/**
 * Push the detail item's own URL onto history and mark it as a
 * shallow-routed panel open. `path` is an absolute app path (e.g.
 * `/admin/tasks/abc123`) — base-path prefixing for subfolder deployments is
 * handled here, callers pass the bare path.
 */
export function openDetail(path: string): void {
    if (!browser) return;
    // No-op on a redundant open for the SAME target (e.g. a fast
    // double-click on a row before the UI settles): without this guard each
    // call unconditionally pushes another identical history entry, and
    // `closeDetail`'s single `history.back()` only pops one of them — the
    // panel then appears to not close on the first click (edge case hunter
    // finding 2026-07-10 #4). A different target still pushes normally so
    // switching rows keeps its own back-stop.
    if (get(page).state.detailPanel?.path === path) return;
    pushState(resolve(path), { ...get(page).state, detailPanel: { path } });
}

/**
 * Same as `openDetail`, but replaces the current history entry instead of
 * pushing a new one — for panel-to-panel switches (e.g. clicking a different
 * row while one is already open) where a back-button stop per row isn't
 * wanted.
 */
export function replaceDetail(path: string): void {
    if (!browser) return;
    replaceState(resolve(path), { ...get(page).state, detailPanel: { path } });
}

/**
 * Close the panel. If it was opened via shallow routing (`page.state.
 * detailPanel` set), step back in history so the URL and any earlier shallow
 * state are restored together. Otherwise (direct link / page-mode / no
 * history to step back into) navigate to the list's own URL.
 */
export function closeDetail(fallbackPath: string): void {
    if (!browser) return;
    const current = get(page);
    if (current.state.detailPanel) {
        history.back();
    } else {
        void goto(resolve(fallbackPath));
    }
}

/**
 * Split a task detail path stamped by `openDetail()` into the task id (its
 * final path segment) and the optional panel tab (`?tab=runs` — the
 * "Execution history" entry point).
 */
export function parseTaskDetailPath(path: string): { taskId: string; tab?: 'runs' } {
    const url = new URL(path, 'http://detail.invalid');
    const raw = url.pathname.split('/').pop() ?? '';
    let taskId = raw;
    try {
        taskId = decodeURIComponent(raw);
    } catch {
        // Malformed escape: keep the raw segment.
    }
    return url.searchParams.get('tab') === 'runs' ? { taskId, tab: 'runs' } : { taskId };
}
