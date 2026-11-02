<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Group-valued array input — chips plus an autocompleting add field.

  Replaces the bare comma-separated text box for settings tagged `uiHints.groups`.
  The box was the silent-failure shape this codebase keeps hitting: a typo, or a
  group that was never created, produced zero matches with no error, no warning,
  and no way to tell "misconfigured" apart from "nobody is in it". SOCIAL_TRUST_GROUPS
  in particular goes fully dark on an unmatched name.

  Two rules govern the design:

  1. UNKNOWN NAMES ARE ALWAYS ACCEPTED. Groups can arrive from an IdP that has not
     yet had a user log in, so "not in the known list" does not mean "wrong". The
     input warns and never blocks.
  2. THE STORED SHAPE DOES NOT CHANGE. The parent contract for `type: 'array'`
     settings is a comma-separated STRING (parsed on save), so `onchange` still
     emits exactly that. This component is a different way to edit the same value,
     not a different value.

  Matching is case-insensitive because the consumers fold case in Postgres
  (`lower()` on both sides), so `Family` and `family` must not read as two groups
  or as an unknown name.
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { Icon, XMark, Plus, ExclamationTriangle } from 'svelte-hero-icons';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import type { BaseInputProps } from './registry';
    import { loadKnownGroups } from './known-groups.svelte';
    import {
        foldGroupName as fold,
        parseGroupList,
        mergeGroupNames,
    } from '$lib/utils/group-array-parse';

    interface Props extends BaseInputProps {}

    let { setting, value, disabled = false, envLocked = false, onchange }: Props = $props();

    let isDisabled = $derived(disabled || envLocked || setting.uiHints?.envOnly);

    let knownGroups = $state<string[]>([]);
    let knownLoaded = $state(false);
    let draft = $state('');

    // onMount, not $effect: this depends on nothing reactive and must run exactly
    // once, client-side only. Under SSR a top-level call would fire a server-side
    // fetch and — because the cache in known-groups lives in module scope, which the
    // server shares across every request — could pin an empty list for the process's
    // lifetime. onMount never runs on the server, so the question does not arise.
    onMount(() => {
        void loadKnownGroups().then((groups) => {
            knownGroups = groups;
            knownLoaded = true;
        });
    });

    /**
     * The chip list. De-duplication happens in `parseGroupList` and is load-bearing:
     * the `{#each}` below is KEYED BY NAME, and a stored `"admin,admin"` — legal in
     * a hand-edited settings.json or an env var — would otherwise be duplicate keys,
     * which is a hard Svelte runtime error rather than a warning.
     */
    let selected = $derived(parseGroupList(value));

    let selectedFolded = $derived(new Set(selected.map(fold)));

    /** Known groups not already chosen — the add-field's suggestion list. */
    let suggestions = $derived(knownGroups.filter((g) => !selectedFolded.has(fold(g))));

    /**
     * Chosen names with no match in the known list. Only meaningful once the list
     * has actually loaded: before that, everything looks unknown.
     */
    let unknownSelected = $derived.by(() => {
        if (!knownLoaded || knownGroups.length === 0) return new Set<string>();
        const knownFolded = new Set(knownGroups.map(fold));
        return new Set(selected.filter((s) => !knownFolded.has(fold(s))));
    });

    function commit(next: string[]): void {
        onchange?.(next.join(', '));
    }

    /**
     * Adds a typed entry or a PASTED comma-separated string. The keydown handler
     * only catches a typed comma, so without the split a paste would be stored as
     * one group literally named "a, b" and silently become two on the next parse.
     */
    function addGroup(name: string): void {
        const next = mergeGroupNames(selected, name);
        if (next.length !== selected.length) commit(next);
        draft = '';
    }

    function removeGroup(name: string): void {
        commit(selected.filter((s) => s !== name));
    }

    function handleKeydown(e: KeyboardEvent): void {
        // Enter and comma both commit; the comma keeps muscle memory from the old
        // comma-separated field working.
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            addGroup(draft);
        } else if (e.key === 'Backspace' && draft === '' && selected.length > 0) {
            removeGroup(selected[selected.length - 1]);
        }
    }

    const datalistId = $derived(`known-groups-${setting.key}`);
</script>

<div class="w-64">
    {#if selected.length > 0}
        <div class="flex flex-wrap gap-1 mb-1.5">
            {#each selected as group (group)}
                {@const isUnknown = unknownSelected.has(group)}
                <span
                    class="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 text-xs rounded
                           {isUnknown
                        ? 'bg-warning-500/20 text-warning-200'
                        : 'bg-surface-600 text-surface-100'}">
                    {#if isUnknown}
                        <Tooltip
                            text="No group with this name exists yet. Fine if your identity provider will send it — otherwise this entry matches nobody."
                            position="top"
                            fixed>
                            <Icon src={ExclamationTriangle} class="w-3 h-3" />
                        </Tooltip>
                    {/if}
                    <span class="font-mono">{group}</span>
                    {#if !isDisabled}
                        <button
                            type="button"
                            class="p-0.5 rounded hover:bg-surface-500 transition-colors"
                            aria-label={`Remove ${group}`}
                            onclick={() => removeGroup(group)}>
                            <Icon src={XMark} class="w-3 h-3" />
                        </button>
                    {/if}
                </span>
            {/each}
        </div>
    {/if}

    <div class="flex gap-1">
        <input
            type="text"
            id={setting.key}
            class="input input-sm flex-1 min-w-0 {isDisabled
                ? 'opacity-50 cursor-not-allowed'
                : ''}"
            disabled={isDisabled}
            list={datalistId}
            bind:value={draft}
            placeholder={selected.length > 0
                ? 'Add group…'
                : setting.uiHints?.placeholder || 'group name'}
            onkeydown={handleKeydown} />
        <datalist id={datalistId}>
            {#each suggestions as group (group)}
                <option value={group}></option>
            {/each}
        </datalist>
        <button
            type="button"
            class="btn btn-sm variant-soft shrink-0"
            disabled={isDisabled || draft.trim() === ''}
            aria-label="Add group"
            onclick={() => addGroup(draft)}>
            <Icon src={Plus} class="w-3.5 h-3.5" />
        </button>
    </div>

    {#if knownLoaded && knownGroups.length === 0}
        <p class="text-hint mt-1 text-xs">
            No groups found yet — create one under Access Groups, or type a name your identity
            provider sends.
        </p>
    {/if}
</div>
