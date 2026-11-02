<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Makes a nav dot explain itself on arrival: mounted in a section landing
  page's HEADER (AdminPageHeader's action slot), shows the open attention
  items that light THAT section's sidebar dot (same `sectionForItem` mapping
  the server uses for `sectionStatus`, via AttentionList's `section` filter).
  Renders nothing when the section has no open items.

  A compact "N findings" pill whose list opens as a dropdown OVER the page,
  never in the document flow. The admin-status payload arrives after mount,
  and this used to be an in-flow strip above the content: every landing
  pushed the page ~40px down half a second in, under the operator's pointer
  (on the media browser a click aimed at one row hit the next). In the header
  it lands in space the header row already reserves, and opening it moves
  nothing either.
-->

<script lang="ts">
    import type { Action } from 'svelte/action';
    import { onMount, type Snippet } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import type { AdminSectionId } from '$lib/schemas/api-admin-status-payload.js';
    import { adminStatus } from '$lib/stores/admin-status.store.svelte.js';
    import { sectionForItem } from '$lib/shared/attention-section-map.js';
    import { clickOutside } from '$lib/utils/click-outside';
    import AttentionList from './AttentionList.svelte';

    interface Props {
        /** Which admin nav section's open items to show (same id as the sidebar dot). */
        section: AdminSectionId;
        /**
         * Page-owned warnings shown at the top of the list and counted in the
         * pill — the tasks page's "file watcher hasn't checked in" row used to
         * sit outside the box, uncounted by it.
         */
        extra?: Snippet;
        /** How many rows `extra` renders. */
        extraCount?: number;
    }
    let { section, extra, extraCount = 0 }: Props = $props();

    /** An item older than this with no movement reads as permanent decoration. */
    const STALE_MS = 7 * 24 * 60 * 60 * 1000;

    // Same store as the bell/Home/AttentionList — ref-counted, safe to start
    // alongside the AttentionList this component conditionally mounts below.
    onMount(() => {
        adminStatus.start();
        return () => adminStatus.stop();
    });

    const openItems = $derived(
        (adminStatus.payload?.attention.items ?? []).filter(
            (i) => !i.acked && !i.snoozed && sectionForItem(i) === section,
        ),
    );
    const openCount = $derived(openItems.length + extraCount);

    /**
     * Every open item over a week old and not moving: say so, and say what
     * helps. Month-old "unchanged" warnings train an operator to skip the list
     * a NEW problem will appear in.
     */
    const staleHint = $derived(
        openItems.length > 0 &&
            openItems.every(
                (i) =>
                    Date.now() - Date.parse(i.firstSeen) > STALE_MS &&
                    (!i.trend || i.trend.direction === 'flat'),
            ),
    );

    let open = $state(false);
    const panelId = $derived(`section-attention-${section}`);

    // Element-scoped, for the reason HelpPopover gives: it must fire before an
    // ancestor's Escape handler so stopPropagation keeps it here.
    const escapeToClose: Action<HTMLElement> = (node) => {
        const onKeydown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape' || !open) return;
            event.stopPropagation();
            event.preventDefault();
            open = false;
        };
        node.addEventListener('keydown', onKeydown);
        return {
            destroy() {
                node.removeEventListener('keydown', onKeydown);
            },
        };
    };
</script>

{#if openCount > 0}
    <div class="relative shrink-0" use:escapeToClose use:clickOutside={() => (open = false)}>
        <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-950/30 px-2.5 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-900/40"
            aria-expanded={open}
            aria-controls={panelId}
            onclick={() => (open = !open)}>
            <span class="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true"></span>
            <span class="sr-only">{m.admin_attention_section_summary({ count: openCount })}</span>
            <span aria-hidden="true">{m.admin_attention_section_pill({ count: openCount })}</span>
        </button>
        {#if open}
            <div
                id={panelId}
                class="absolute right-0 z-20 mt-2 max-h-[min(70dvh,32rem)] w-[min(90vw,32rem)] overflow-y-auto rounded-lg border border-surface-700 bg-surface-900/95 p-3 text-left shadow-xl backdrop-blur">
                {#if extra}
                    <div class="mb-2 space-y-1 rounded border border-amber-500/30 px-2.5 py-2">
                        {@render extra()}
                    </div>
                {/if}
                {#if staleHint}
                    <p class="mb-2 text-[11px] text-surface-400">
                        {m.admin_attention_section_stale_hint()}
                    </p>
                {/if}
                {#if openItems.length > 0}
                    <AttentionList {section} showVerdict={false} />
                {/if}
            </div>
        {/if}
    </div>
{/if}
