<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin IA redesign, spec §7: "three visually distinct states everywhere:
  loading (with timeout), empty, error (with retry)." Wraps a `ClassifiedError
  | null` (from `$lib/utils/admin/error-contract`) into consistent copy +
  a Retry action, and turns a `loading` that overruns `timeoutMs` into a
  retryable error itself — kills the "eternal Loading…" class of bug
  (spec §8) that previously left tabs spinning forever on a wedged request.
-->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import { Icon, ExclamationTriangle, ArrowPath } from 'svelte-hero-icons';
    import ProgressRadial from '$lib/components/ui/ProgressRadial.svelte';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        loading: boolean;
        error: ClassifiedError | null;
        empty?: boolean;
        /** Loading past this many ms is treated as a retryable timeout. Default 15s (spec §6). */
        timeoutMs?: number;
        onretry?: () => void;
        emptyMessage?: string;
        children?: Snippet;
        emptySnippet?: Snippet;
    }

    let {
        loading,
        error,
        empty = false,
        timeoutMs = 15000,
        onretry,
        emptyMessage,
        children,
        emptySnippet,
    }: Props = $props();

    let timedOut = $state(false);

    $effect(() => {
        if (!loading) {
            timedOut = false;
            return;
        }
        timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
        }, timeoutMs);
        return () => clearTimeout(timer);
    });

    // A loading-timeout is itself a network-class problem: something never
    // came back. Route it through the same classifier used everywhere else
    // so the copy/retry affordance stays consistent (spec §7's single error
    // contract, not a bespoke timeout message).
    let timeoutError = $derived.by((): ClassifiedError => {
        const err = classifyError(
            new DOMException('Timed out waiting for a response', 'AbortError'),
        );
        return { ...err, message: m.admin_async_timeout_message() };
    });

    let displayError = $derived(error ?? (timedOut ? timeoutError : null));
</script>

{#if displayError}
    <div
        class="flex flex-col gap-2 rounded border border-red-700/30 bg-red-900/20 p-3 text-sm text-red-300">
        <div class="flex items-start gap-2">
            <Icon src={ExclamationTriangle} class="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <span class="flex-1">{displayError.message}</span>
        </div>
        {#if displayError.detail}
            <details class="text-xs text-red-300/70">
                <summary class="cursor-pointer">{m.admin_error_details_toggle()}</summary>
                <p class="mt-1 whitespace-pre-wrap font-mono">{displayError.detail}</p>
            </details>
        {/if}
        {#if displayError.retryable && onretry}
            <button
                type="button"
                class="inline-flex w-fit items-center gap-1.5 rounded bg-red-800/60 px-2.5 py-1.5 text-xs font-medium text-red-100 transition-colors hover:bg-red-800"
                onclick={onretry}>
                <Icon src={ArrowPath} class="h-3.5 w-3.5" />
                {m.common_retry()}
            </button>
        {/if}
    </div>
{:else if loading}
    <div class="flex flex-col items-center justify-center gap-3 py-8 text-center">
        <ProgressRadial width="w-6" />
        <p class="text-sm text-surface-500">{m.loading_default()}</p>
    </div>
{:else if empty}
    {#if emptySnippet}
        {@render emptySnippet()}
    {:else}
        <p class="py-6 text-center text-sm italic text-surface-500">
            {emptyMessage ?? m.admin_async_empty_default()}
        </p>
    {/if}
{:else if children}
    {@render children()}
{/if}
