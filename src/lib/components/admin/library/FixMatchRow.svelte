<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  One row of the Fix matches workbench, shared by the "Never matched" and
  "Broken match" views so both read as one tool: select box, optional expand
  toggle, poster thumbnail, title + meta lines, actions on the right. On a
  phone the actions drop to their own line under the title instead of
  squeezing the title to a few characters.
-->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import { Icon, ChevronDown, ChevronRight } from 'svelte-hero-icons';
    import { getCatalogPosterUrl } from '$lib/utils/image-utils';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        /** media_items id — drives the poster thumbnail. */
        posterId: string;
        title: string;
        selected: boolean;
        selectable?: boolean;
        ontoggleselect: () => void;
        /** Set for rows with children to show (series); omitted otherwise. */
        expanded?: boolean;
        ontoggleexpand?: () => void;
        /** Type badge, year, counts … */
        meta: Snippet;
        /** Extra lines under the meta line (file, failure reason …). */
        details?: Snippet;
        actions: Snippet;
        /** Expanded content (episode list). Rendered only while `expanded`. */
        children?: Snippet;
    }

    let {
        posterId,
        title,
        selected,
        selectable = true,
        ontoggleselect,
        expanded,
        ontoggleexpand,
        meta,
        details,
        actions,
        children,
    }: Props = $props();

    let posterFailed = $state(false);
</script>

<div class="rounded-lg border border-surface-700 bg-surface-800 overflow-hidden">
    <div
        class="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-3 sm:flex-nowrap sm:items-center sm:px-4">
        <div class="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
            {#if selectable}
                <input
                    type="checkbox"
                    checked={selected}
                    onchange={ontoggleselect}
                    aria-label={m.admin_fix_matches_select_item({ title })}
                    class="mt-1 shrink-0 rounded border-surface-600 bg-surface-800 text-blue-500 sm:mt-0" />
            {/if}
            {#if ontoggleexpand}
                <button
                    type="button"
                    class="shrink-0 rounded p-0.5 transition-colors hover:bg-surface-700"
                    aria-expanded={expanded}
                    aria-label={expanded
                        ? m.admin_fix_matches_collapse({ title })
                        : m.admin_fix_matches_expand({ title })}
                    onclick={ontoggleexpand}>
                    <Icon
                        src={expanded ? ChevronDown : ChevronRight}
                        class="h-4 w-4 text-surface-400" />
                </button>
            {:else}
                <div class="hidden w-5 shrink-0 sm:block"></div>
            {/if}
            <div
                class="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-700">
                {#if !posterFailed}
                    <img
                        src={getCatalogPosterUrl(posterId, { size: 'thumb' })}
                        alt=""
                        loading="lazy"
                        class="h-full w-full object-cover"
                        onerror={() => (posterFailed = true)} />
                {/if}
            </div>
            <div class="min-w-0 flex-1">
                <p
                    class="font-medium text-white break-words line-clamp-2 sm:line-clamp-1 sm:break-all"
                    {title}>
                    {title}
                </p>
                <div class="mt-0.5 text-xs text-surface-400">
                    {@render meta()}
                </div>
                {@render details?.()}
            </div>
        </div>
        <div class="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 sm:w-auto">
            {@render actions()}
        </div>
    </div>
    {#if expanded && children}
        <div class="border-t border-surface-700 bg-surface-850 px-4 py-2">
            {@render children()}
        </div>
    {/if}
</div>
