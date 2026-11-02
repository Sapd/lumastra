<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    // Per-row shortcut for the two changes admins make in bulk (role, sign-in
    // lock), so promoting five users is five menu picks rather than five
    // open-drawer → Access tab → button trips. It only REQUESTS the change: the
    // page routes both through the same confirmations the drawer uses.
    import { Icon, EllipsisVertical, ShieldCheck, NoSymbol, CheckCircle } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import type { LocalUser } from '$lib/schemas/api-admin-responses';

    let {
        user,
        isSelf,
        busy = false,
        onToggleAdmin,
        onSetDisabled,
    }: {
        user: LocalUser;
        isSelf: boolean;
        busy?: boolean;
        onToggleAdmin: (username: string, currentIsAdmin: boolean) => void;
        onSetDisabled: (username: string, currentDisabled: boolean) => void;
    } = $props();

    let open = $state(false);
    let root: HTMLDivElement | undefined = $state();
    let trigger: HTMLButtonElement | undefined = $state();

    function close(restoreFocus: boolean): void {
        open = false;
        if (restoreFocus) trigger?.focus();
    }

    function choose(action: () => void): void {
        close(true);
        action();
    }

    function focusFirstItem(node: HTMLElement): void {
        node.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    }

    function onMenuKeydown(event: KeyboardEvent): void {
        const items = [
            ...(root?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
                []),
        ];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            items[(index + step + items.length) % items.length]?.focus();
        } else if (event.key === 'Tab') {
            close(false);
        }
    }
</script>

<svelte:window
    onpointerdown={(event) => {
        if (open && !root?.contains(event.target as Node)) close(false);
    }}
    onkeydown={(event) => {
        if (open && event.key === 'Escape') {
            event.preventDefault();
            close(true);
        }
    }} />

<div class="relative" bind:this={root}>
    <button
        type="button"
        bind:this={trigger}
        class="inline-flex h-11 w-11 items-center justify-center rounded-lg text-surface-400 hover:bg-surface-700/60 hover:text-white focus-visible:outline-2 focus-visible:outline-primary-400 disabled:opacity-50"
        aria-label={m.admin_users_quick_actions({ username: user.username })}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onclick={() => (open = !open)}>
        <Icon src={EllipsisVertical} class="h-5 w-5" />
    </button>
    {#if open}
        <div
            role="menu"
            tabindex="-1"
            class="absolute right-0 top-full z-20 mt-1 min-w-60 rounded-lg border border-surface-700 bg-surface-800 p-1 shadow-xl shadow-black/40"
            onkeydown={onMenuKeydown}
            {@attach focusFirstItem}>
            <button
                type="button"
                role="menuitem"
                class="flex min-h-11 w-full items-center gap-2 rounded px-3 text-left text-sm text-surface-200 hover:bg-surface-700 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isSelf}
                onclick={() => choose(() => onToggleAdmin(user.username, user.isAdmin))}>
                <Icon src={ShieldCheck} class="h-4 w-4 text-surface-400" />
                {user.isAdmin ? m.users_directory_revoke() : m.users_directory_grant()}
            </button>
            {#if !isSelf}
                <button
                    type="button"
                    role="menuitem"
                    class="flex min-h-11 w-full items-center gap-2 rounded px-3 text-left text-sm {user.disabled
                        ? 'text-surface-200'
                        : 'text-red-300'} hover:bg-surface-700"
                    onclick={() => choose(() => onSetDisabled(user.username, user.disabled))}>
                    <Icon
                        src={user.disabled ? CheckCircle : NoSymbol}
                        class="h-4 w-4 {user.disabled ? 'text-surface-400' : 'text-red-400'}" />
                    {user.disabled ? m.admin_users_quick_enable() : m.admin_users_quick_disable()}
                </button>
            {/if}
        </div>
    {/if}
</div>
