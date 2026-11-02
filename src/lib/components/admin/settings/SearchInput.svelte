<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, MagnifyingGlass, XMark } from 'svelte-hero-icons';

    interface Props {
        value?: string;
        placeholder?: string;
    }

    let { value = $bindable(''), placeholder = 'Search...' }: Props = $props();

    let _inputElement: HTMLInputElement | undefined = $state();

    function clearSearch() {
        value = '';
        _inputElement?.focus();
    }

    // Export focus method for parent components
    export function focus() {
        _inputElement?.focus();
    }

    export function blur() {
        _inputElement?.blur();
    }
</script>

<div class="relative">
    <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
        <Icon src={MagnifyingGlass} class="w-5 h-5 text-surface-400" />
    </div>
    <input
        bind:this={_inputElement}
        bind:value
        type="text"
        {placeholder}
        aria-label="Search"
        class="w-full pl-10 pr-10 py-3 bg-surface-800 border border-surface-700 rounded-lg text-surface-200 placeholder-surface-500 focus:outline-hidden focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500 transition-colors" />
    {#if value.trim()}
        <button
            type="button"
            class="absolute inset-y-0 right-0 pr-3 flex items-center text-surface-400 hover:text-surface-200 transition-colors"
            onclick={clearSearch}
            aria-label="Clear search">
            <Icon src={XMark} class="w-5 h-5" />
        </button>
    {:else}
        <div class="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
            <kbd
                class="hidden sm:inline-flex items-center px-2 py-1 text-caption bg-surface-700 rounded border border-surface-600"
                >/</kbd>
        </div>
    {/if}
</div>
