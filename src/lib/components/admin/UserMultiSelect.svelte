<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  A filterable checkbox list of local users, for picking broadcast recipients.

  Takes its users as a PROP rather than fetching them: /admin/notifications
  already seeds the list server-side in its `+page.server.ts` (the same pattern
  /admin/users uses), so fetching here would mean a second request for data the
  page already has, and a first render that flashes empty.

  Selection is a `SvelteSet<string>` of user IDs owned by the PARENT and mutated
  in place — the idiom /admin/users/+page.svelte uses for its per-row pending
  sets. A `SvelteSet` is reactive on mutation, so `add`/`delete` re-render
  without the parent having to reassign anything; a plain `Set` would silently
  not update the UI.

  IDs, not usernames: the broadcast API takes `users.id` UUIDs, and a username
  can be renamed between the moment an admin picks it and the moment they press
  send.
-->

<script lang="ts">
    import type { SvelteSet } from 'svelte/reactivity';
    import * as m from '$lib/paraglide/messages.js';
    import type { LocalUser } from '$lib/schemas/api-admin-responses';

    interface Props {
        users: LocalUser[];
        /** Selected user IDs. Mutated in place — the parent owns this set. */
        selected: SvelteSet<string>;
        disabled?: boolean;
    }

    let { users, selected, disabled = false }: Props = $props();

    let filter = $state('');

    // Disabled accounts are hidden rather than shown-and-greyed: the server
    // rejects them as unknown recipients (they cannot log in, so a durable row
    // for them would never be read), and offering a checkbox that produces a
    // 422 on send is worse than not offering it. Deleted users never reach the
    // admin list at all.
    const selectable = $derived(users.filter((user) => !user.disabled));

    const visible = $derived.by(() => {
        const needle = filter.trim().toLowerCase();
        if (!needle) return selectable;
        return selectable.filter(
            (user) =>
                user.username.toLowerCase().includes(needle) ||
                (user.displayName ?? '').toLowerCase().includes(needle),
        );
    });

    function toggle(id: string): void {
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
    }

    /**
     * Select every user CURRENTLY VISIBLE, not every user.
     *
     * With an active filter that is the useful meaning ("everyone in the
     * support group"), and without one the two are identical. Selecting rows
     * the admin cannot see would be the surprising reading.
     */
    function selectAllVisible(): void {
        for (const user of visible) selected.add(user.id);
    }

    function clearSelection(): void {
        selected.clear();
    }
</script>

<div class="rounded border border-surface-600 bg-surface-800/50">
    <div class="flex flex-wrap items-center gap-2 border-b border-surface-700 p-2">
        <input
            type="search"
            bind:value={filter}
            {disabled}
            placeholder={m.admin_broadcast_recipients_filter()}
            aria-label={m.admin_broadcast_recipients_filter()}
            class="min-w-0 flex-1 rounded border border-surface-600 bg-surface-900 px-2 py-1 text-sm text-surface-100 placeholder:text-surface-500 disabled:opacity-50" />
        <button
            type="button"
            class="rounded px-2 py-1 text-xs text-primary-400 hover:text-primary-300 disabled:opacity-50"
            disabled={disabled || visible.length === 0}
            onclick={selectAllVisible}>
            {m.admin_broadcast_recipients_select_all()}
        </button>
        <button
            type="button"
            class="rounded px-2 py-1 text-xs text-surface-400 hover:text-surface-200 disabled:opacity-50"
            disabled={disabled || selected.size === 0}
            onclick={clearSelection}>
            {m.admin_broadcast_recipients_clear()}
        </button>
    </div>

    <div class="max-h-56 overflow-y-auto p-1">
        {#if visible.length === 0}
            <p class="px-2 py-4 text-center text-sm text-surface-500">
                {m.admin_broadcast_recipients_none()}
            </p>
        {:else}
            {#each visible as user (user.id)}
                <label
                    class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface-700/50">
                    <input
                        type="checkbox"
                        {disabled}
                        checked={selected.has(user.id)}
                        onchange={() => toggle(user.id)}
                        class="h-3.5 w-3.5 shrink-0 rounded border-surface-500 bg-surface-900 text-primary-500" />
                    <span class="truncate text-surface-200">{user.username}</span>
                    {#if user.displayName && user.displayName !== user.username}
                        <span class="truncate text-xs text-surface-500">{user.displayName}</span>
                    {/if}
                </label>
            {/each}
        {/if}
    </div>

    <p class="border-t border-surface-700 px-2 py-1 text-xs text-surface-400" role="status">
        {m.admin_broadcast_recipients_selected({ count: selected.size })}
    </p>
</div>
