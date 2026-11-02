<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  A command the operator is meant to RUN, with a copy button.

  Rendered in a <pre> with `whitespace-pre` and its own horizontal scroll: a
  wrapped shell command is a command that gets pasted wrong, and a path with a
  space in it is exactly where that bites.
-->
<script lang="ts">
    import { Icon, ClipboardDocument, Check } from 'svelte-hero-icons';

    interface Props {
        /** Command or config fragment, verbatim. Never truncated for display. */
        text: string;
        /** Short label above the block, e.g. "Give the folder to Lumastra". */
        label?: string;
        /** One line under the label explaining what it does. */
        hint?: string;
    }

    let { text, label, hint }: Props = $props();

    let copied = $state(false);

    async function copy(): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            copied = true;
            setTimeout(() => (copied = false), 2000);
        } catch {
            // Clipboard is unavailable (insecure origin, denied permission).
            // The text is right there and selectable — silently doing nothing is
            // correct; a toast about a failed convenience would be noise.
        }
    }
</script>

<div class="space-y-1">
    {#if label}
        <p class="text-xs font-medium text-surface-200">{label}</p>
    {/if}
    {#if hint}
        <p class="text-xs text-surface-400">{hint}</p>
    {/if}
    <div class="flex items-start gap-2">
        <pre
            class="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded border border-surface-700/50 bg-surface-900/70 p-3 text-xs leading-relaxed text-surface-100">{text}</pre>
        <button
            type="button"
            class="btn btn-sm variant-soft shrink-0"
            aria-label="Copy to clipboard"
            onclick={() => void copy()}>
            <Icon src={copied ? Check : ClipboardDocument} class="h-4 w-4" />
        </button>
    </div>
</div>
