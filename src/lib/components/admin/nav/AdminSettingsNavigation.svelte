<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { afterNavigate } from '$app/navigation';
    import type { AdminNavPage } from '$lib/config/admin-nav';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import { Icon, ChevronDown } from 'svelte-hero-icons';
    import { settingsPageGroups } from '../admin-nav.utils.js';
    import { adminNavHover } from '$lib/stores/admin-nav-hover.svelte.js';

    let { pages, activePath }: { pages: AdminNavPage[]; activePath: string | null } = $props();
    let open = $state(false);
    let groups = $derived(settingsPageGroups(pages));
    // Strip order follows the directory's grouping so the two views agree.
    let orderedPages = $derived(groups.flatMap((group) => group.pages));
    afterNavigate(() => {
        open = false;
    });
</script>

<nav class="mb-5" aria-label={m.admin_nav_section_settings()}>
    <div class="rounded-xl border border-surface-700 bg-surface-800/30">
        <!-- Every settings page stays one click away: a scrollable strip on phones,
             a wrapping row on wider screens. The descriptive directory below is
             the "what lives where" view, opened on demand. -->
        <div class="flex items-center gap-2 px-2 py-2">
            <ul
                class="flex min-w-0 flex-1 gap-1 overflow-x-auto lg:flex-wrap lg:overflow-visible"
                aria-label={m.admin_redesign_settings_browse()}>
                {#each orderedPages as item (item.path)}
                    <li class="shrink-0">
                        <a
                            href={resolve(item.path)}
                            aria-current={activePath === item.path ? 'page' : undefined}
                            onpointerenter={() => adminNavHover.enter(item.path)}
                            onpointerleave={() => adminNavHover.leave(item.path)}
                            class="block whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-primary-400 {activePath ===
                            item.path
                                ? 'bg-primary-500/15 font-medium text-primary-200'
                                : adminNavHover.path === item.path
                                  ? 'bg-surface-700/50 text-white'
                                  : 'text-surface-300 hover:bg-surface-700/50 hover:text-white'}"
                            >{item.title()}</a>
                    </li>
                {/each}
            </ul>
            <button
                type="button"
                class="flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-surface-600 px-3 py-1.5 text-sm text-surface-300 transition-colors hover:bg-surface-700/50 hover:text-white focus-visible:outline-2 focus-visible:outline-primary-400"
                aria-label={m.admin_redesign_settings_browse()}
                aria-expanded={open}
                aria-controls="admin-settings-directory"
                onclick={() => (open = !open)}>
                <span class="hidden sm:inline">{m.admin_redesign_settings_browse()}</span>
                <Icon
                    src={ChevronDown}
                    class="h-4 w-4 transition-transform {open ? 'rotate-180' : ''}"
                    aria-hidden="true" />
            </button>
        </div>
        {#if open}
            <div
                id="admin-settings-directory"
                class="grid gap-5 border-t border-surface-700 p-4 md:grid-cols-3">
                {#each groups as group (group.id)}
                    <div>
                        <h2
                            class="mb-2 text-xs font-medium uppercase tracking-wide text-surface-400">
                            {group.label}
                        </h2>
                        <ul class="space-y-1">
                            {#each group.pages as item (item.path)}
                                <li>
                                    <a
                                        href={resolve(item.path)}
                                        aria-current={activePath === item.path ? 'page' : undefined}
                                        onpointerenter={() => adminNavHover.enter(item.path)}
                                        onpointerleave={() => adminNavHover.leave(item.path)}
                                        class="block rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-primary-400 {activePath ===
                                        item.path
                                            ? 'bg-primary-500/10 text-primary-200'
                                            : adminNavHover.path === item.path
                                              ? 'bg-surface-700/50 text-white'
                                              : 'text-surface-300 hover:bg-surface-700/50 hover:text-white'}">
                                        {item.title()}
                                        {#if item.description}<span
                                                class="mt-1 block text-xs font-normal leading-relaxed text-surface-400"
                                                >{item.description()}</span
                                            >{/if}
                                    </a>
                                </li>
                            {/each}
                        </ul>
                    </div>
                {/each}
            </div>
        {/if}
    </div>
</nav>
