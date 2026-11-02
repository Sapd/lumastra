<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  THE admin help disclosure. Two shapes, one behaviour:

    variant="icon"   — the round "?" beside a page heading; the body floats
                       over the page. Was hand-rolled <details> markup, copied
                       into /admin/tasks, /admin/tasks/runs and
                       /admin/tasks/pipeline, each with its own outside-click
                       and Escape handling.
    variant="inline" — a text disclosure that expands in the document flow.
                       Replaces WhatIsThisPage.svelte, which was this same job
                       in a different shape.

  Together with TermTooltip (glossary/) this is the whole help vocabulary:
  HelpPopover explains a screen, TermTooltip explains a word. There is no third
  pattern — don't add one.

  Copy budget for variant="icon": at most three short sentences plus the
  `learnMoreHref` link. Help that is read is help attached to the thing the
  operator is confused about; a fourth paragraph is where it stops being read.
  Longer material belongs behind the link, on /admin/help/tasks.

  Escape is handled by a local action on the <details>, not by a window
  listener and not by a keydown attribute:
    - element-scoped, so it fires BEFORE any ancestor's Escape handler and
      `stopPropagation()` actually keeps it there. That matters on the task
      detail page, where DetailPanel's dialog closes the whole panel on
      Escape — a window listener would run after it and the panel would
      already be gone.
    - an action rather than `onkeydown={...}`, because <details> is a
      non-interactive element and a keydown attribute on it trips
      `a11y_no_noninteractive_element_interactions`.
  It only fires while `open`, so Escape still reaches the panel when the
  popover is shut.

  Outside-click closes the icon variant only: it is an overlay that covers the
  page, so leaving it open is actively in the way. The inline variant sits in
  the flow and closing it as soon as the operator clicks anything else would
  yank away copy they are still reading.
-->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { Action } from 'svelte/action';
    import * as m from '$lib/paraglide/messages.js';
    import { clickOutside } from '$lib/utils/click-outside';

    interface Props {
        /** Overlay "?" beside a heading, or an in-flow text disclosure. */
        variant?: 'icon' | 'inline';
        /** Disclosure label for `variant="inline"`. Defaults to "What is this page?". */
        summary?: string;
        /**
         * Already-resolved in-app href for the "Learn more" link, e.g.
         * `resolve('/admin/help/tasks#runs')`. Omit for a popover with no
         * deeper page behind it.
         */
        learnMoreHref?: string;
        /** Link text. Defaults to the shared "Learn more" copy. */
        learnMoreLabel?: string;
        /** The help copy. Bare `<p>` elements — the wrapper spaces them. */
        children: Snippet;
    }

    let { variant = 'icon', summary, learnMoreHref, learnMoreLabel, children }: Props = $props();

    let details: HTMLDetailsElement | undefined = $state();

    function close(): void {
        if (details) details.open = false;
    }

    const escapeToClose: Action<HTMLElement> = (node) => {
        const onKeydown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape' || !details?.open) return;
            event.stopPropagation();
            event.preventDefault();
            close();
        };
        node.addEventListener('keydown', onKeydown);
        return {
            destroy() {
                node.removeEventListener('keydown', onKeydown);
            },
        };
    };
</script>

{#if variant === 'icon'}
    <details
        bind:this={details}
        class="group relative shrink-0"
        aria-label={m.admin_aria_help()}
        use:escapeToClose
        use:clickOutside={close}>
        <summary
            class="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-sm text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 [&::-webkit-details-marker]:hidden"
            aria-label={m.admin_aria_what_does_this_show()}>
            ?
        </summary>
        <div
            class="absolute right-0 z-20 mt-2 w-80 space-y-2 rounded border border-zinc-700 bg-zinc-950/95 p-3 text-xs text-zinc-300 shadow-xl backdrop-blur">
            {@render children()}
            {#if learnMoreHref}
                <p>
                    <a href={learnMoreHref} class="text-sky-400 underline hover:text-sky-300">
                        {learnMoreLabel ?? m.admin_help_learn_more()}
                    </a>
                </p>
            {/if}
        </div>
    </details>
{:else}
    <details
        bind:this={details}
        class="rounded-xl border border-surface-700 bg-surface-800/30 text-sm"
        use:escapeToClose>
        <summary
            class="cursor-pointer px-4 py-3 font-medium text-surface-200 hover:bg-surface-800/60">
            {summary ?? m.audit_help_summary()}
        </summary>
        <div class="space-y-2 px-4 pb-4 pt-1 text-surface-400">
            {@render children()}
            {#if learnMoreHref}
                <p>
                    <a href={learnMoreHref} class="text-sky-400 underline hover:text-sky-300">
                        {learnMoreLabel ?? m.admin_help_learn_more()}
                    </a>
                </p>
            {/if}
        </div>
    </details>
{/if}
