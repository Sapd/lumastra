<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Which user groups may see a library — "All Users" when none are set.

  A controlled field of the library page's Settings form: it edits `value`
  and saves nothing itself. Access used to have its own Edit / Save inside
  that form — two saves for one form, and an edited-but-unsaved access list
  looked saved. The form's single Save now sends it with everything else
  (PATCH /api/admin/libraries/[id] `allowed_groups`, which needs the
  access:admin scope).
-->

<script lang="ts">
    import { Icon, UserGroup, XMark } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        /** User group names allowed; empty = all users. */
        value: string[];
        /** Every known user group name, for the "known group" picker. */
        availableGroups: string[];
        /** Set when the permission map failed to load — never show "All Users" on error. */
        loadError?: string | null;
        onRetry?: () => void;
    }

    let { value = $bindable(), availableGroups, loadError = null, onRetry }: Props = $props();

    let customInput = $state('');

    const unselected = $derived(availableGroups.filter((g) => !value.includes(g)));

    function addGroup(name: string): void {
        const trimmed = name.trim();
        if (trimmed && !value.includes(trimmed)) value = [...value, trimmed];
    }

    function addCustomGroup(): void {
        if (customInput.trim()) {
            addGroup(customInput);
            customInput = '';
        }
    }

    function removeGroup(name: string): void {
        value = value.filter((g) => g !== name);
    }
</script>

<div class="space-y-2">
    <div class="flex items-center gap-2">
        <Icon src={UserGroup} class="w-4 h-4 text-surface-500 shrink-0" />
        <span class="text-sm text-surface-400">{m.admin_library_access()}</span>
    </div>
    {#if loadError}
        <div class="flex flex-wrap items-center gap-2">
            <span
                class="inline-flex items-center gap-1 rounded-full bg-red-900/30 border border-red-700/40 px-2 py-0.5 text-xs text-red-400">
                {m.admin_library_err_load_permissions()}
            </span>
            {#if onRetry}
                <button
                    type="button"
                    class="text-xs text-red-400 hover:text-red-300 transition-colors"
                    onclick={onRetry}>
                    {m.retry()}
                </button>
            {/if}
        </div>
    {:else}
        <div class="flex flex-wrap items-center gap-1.5">
            {#if value.length === 0}
                <span
                    class="inline-flex items-center gap-1 rounded-full bg-green-900/30 border border-green-700/40 px-2 py-0.5 text-xs text-green-400">
                    {m.admin_library_all_users()}
                </span>
            {/if}
            {#each value as g (g)}
                <span
                    class="inline-flex items-center gap-0.5 rounded-full bg-blue-900/40 border border-blue-700/50 px-2 py-0.5 text-xs text-blue-300">
                    <Icon src={UserGroup} class="w-3 h-3" />
                    {g}
                    <button
                        type="button"
                        class="ml-0.5 p-0.5 text-blue-400/60 hover:text-blue-200 transition-colors"
                        aria-label={m.admin_library_remove_item({ item: g })}
                        title={m.admin_library_remove_item({ item: g })}
                        onclick={() => removeGroup(g)}>
                        <Icon src={XMark} class="w-3 h-3" />
                    </button>
                </span>
            {/each}
        </div>
        <div class="flex flex-wrap items-center gap-2">
            {#if unselected.length > 0}
                <select
                    class="input input-sm text-xs w-40"
                    aria-label={m.admin_library_known_group()}
                    onchange={(e) => {
                        const target = e.currentTarget;
                        if (target.value) {
                            addGroup(target.value);
                            target.value = '';
                        }
                    }}>
                    <option value="">{m.admin_library_known_group()}</option>
                    {#each unselected as g (g)}
                        <option value={g}>{g}</option>
                    {/each}
                </select>
            {/if}
            <!-- No nested <form>: this sits inside the Settings form, and Enter
                 here must add the group, not submit the whole form. -->
            <span class="inline-flex items-center gap-1">
                <input
                    type="text"
                    class="input input-sm text-xs w-40"
                    placeholder={m.admin_placeholder_custom_group()}
                    aria-label={m.admin_placeholder_custom_group()}
                    bind:value={customInput}
                    onkeydown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            addCustomGroup();
                        }
                    }} />
                <button
                    type="button"
                    class="btn btn-sm btn-ghost px-2"
                    aria-label={m.admin_placeholder_custom_group()}
                    disabled={!customInput.trim()}
                    onclick={addCustomGroup}>
                    +
                </button>
            </span>
        </div>
    {/if}
</div>
