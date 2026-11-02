<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { GLOSSARY } from './glossary.js';
    import type { Snippet } from 'svelte';

    interface Props {
        /** Glossary key. */
        term: string;
        /** The visible headline text the dotted underline wraps. */
        children?: Snippet;
    }
    let { term, children }: Props = $props();

    let open = $state(false);
    const entry = $derived(GLOSSARY[term]);
</script>

{#if entry}
    <!--
      The whitespace here is load-bearing, which is why it is written tightly.
      A newline between the label and the `{#if}` becomes a real text node
      INSIDE this span, so every glossary term rendered a trailing space:
      "Active :" instead of "Active:" wherever a caller writes
      `<TermTooltip>…</TermTooltip>:`, and the dotted underline ran on past the
      word. Keep the label, the conditional and the closing tag adjacent.
    -->
    <span
        class="relative cursor-help"
        role="button"
        tabindex="0"
        onmouseenter={() => (open = true)}
        onmouseleave={() => (open = false)}
        onfocus={() => (open = true)}
        onblur={() => (open = false)}
        ><span class="border-b border-dotted border-surface-400">{@render children?.()}</span
        >{#if open}
            <span
                class="absolute left-0 top-full z-50 mt-1 w-72 rounded border border-surface-600 bg-surface-900 p-3 text-xs shadow-lg"
                role="tooltip">
                <span class="block font-semibold">{entry.term()}</span>
                <span class="mt-1 block text-surface-300">{entry.definition()}</span>
                {#if entry.docHref}
                    <!-- Deepens the definition above; never replaces it. Marked
                         as leaving the app (label + arrow + title) because a
                         self-hosted install may well be offline, and an
                         unmarked link that silently fails is worse than one the
                         operator chose not to follow. -->
                    <a
                        class="mt-1 block text-blue-400 hover:underline"
                        href={entry.docHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={m.admin_docs_external_hint()}>
                        {m.admin_docs_troubleshooting_guide()}
                        <span aria-hidden="true">↗</span>
                    </a>
                {/if}
            </span>
        {/if}</span>
{:else}
    {@render children?.()}
{/if}
