<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { page } from '$app/state';
    import { adminWorkspaceUrl, writeAdminWorkspaceUrl } from './admin-workspace-url';
    import * as m from '$lib/paraglide/messages.js';
    import type { LocalUser } from '$lib/schemas/api-admin-responses';
    import Avatar from '$lib/components/ui/Avatar.svelte';
    import SearchInput from '$lib/components/ui/SearchInput.svelte';
    import Pagination from '$lib/components/ui/Pagination.svelte';
    import { getAvatarUrl } from '$lib/utils/image-utils';
    import { needsLoginAttention, loginMethods, lastActive } from './users/user-directory';
    import UserQuickActions from './users/UserQuickActions.svelte';

    let {
        users = [],
        loading = false,
        currentUsername,
        onOpenDetails,
        formatDate,
        onToggleAdmin,
        onSetDisabled,
        busyUsers = new Set<string>(),
    }: {
        users?: LocalUser[];
        loading?: boolean;
        currentUsername?: string;
        onOpenDetails: (username: string) => void;
        formatDate: (date: string | null | undefined) => string;
        /** Row quick actions render only when both handlers are supplied. */
        onToggleAdmin?: (username: string, currentIsAdmin: boolean) => void;
        onSetDisabled?: (username: string, currentDisabled: boolean) => void;
        /** Users with a role/disable change in flight — their quick actions are disabled. */
        busyUsers?: ReadonlySet<string>;
    } = $props();

    // Forward-auth can hand the session a differently-cased username.
    function isCurrentUser(username: string): boolean {
        return currentUsername != null && username.toLowerCase() === currentUsername.toLowerCase();
    }

    let workspaceUrl = $derived(adminWorkspaceUrl(page.url, page.state));
    const PAGE_SIZE = 20;
    let query = $derived(workspaceUrl.searchParams.get('q') ?? '');
    let filter = $derived(
        validOption('filter', ['all', 'admins', 'streaming', 'disabled', 'attention'], 'all'),
    );
    let sort = $derived(validOption('sort', ['recent', 'name', 'newest'], 'recent'));
    function validOption(key: string, options: string[], fallback: string): string {
        const value = workspaceUrl.searchParams.get(key);
        return value && options.includes(value) ? value : fallback;
    }
    let requestedPage = $derived(Math.max(1, Number(workspaceUrl.searchParams.get('p')) || 1));
    let filters = $derived([
        { key: 'all', label: m.admin_users_filter_all(), count: users.length },
        {
            key: 'admins',
            label: m.admin_users_filter_admins(),
            count: users.filter((u) => u.isAdmin).length,
        },
        {
            key: 'streaming',
            label: m.users_directory_streaming(),
            count: users.filter((u) => u.currentlyStreaming).length,
        },
        {
            key: 'disabled',
            label: m.admin_users_filter_disabled(),
            count: users.filter((u) => u.disabled).length,
        },
        {
            key: 'attention',
            label: m.users_directory_attention(),
            count: users.filter(needsLoginAttention).length,
        },
    ]);

    function update(values: Record<string, string | null>, replace = false): void {
        const url = new URL(workspaceUrl);
        for (const [key, value] of Object.entries(values)) {
            if (value) url.searchParams.set(key, value);
            else url.searchParams.delete(key);
        }
        writeAdminWorkspaceUrl(url, page.state, replace);
    }

    function clearFilters(): void {
        update({ q: null, filter: null, p: null });
    }

    let filtered = $derived.by(() => {
        const q = query.trim().toLocaleLowerCase();
        const result = users.filter((user) => {
            if (filter === 'admins' && !user.isAdmin) return false;
            if (filter === 'streaming' && !user.currentlyStreaming) return false;
            if (filter === 'disabled' && !user.disabled) return false;
            if (filter === 'attention' && !needsLoginAttention(user)) return false;
            return [user.username, user.displayName, user.email].some((value) =>
                value?.toLocaleLowerCase().includes(q),
            );
        });
        return result.sort((a, b) => {
            if (sort === 'name')
                return (a.displayName ?? a.username).localeCompare(b.displayName ?? b.username);
            if (sort === 'newest') return Date.parse(b.createdAt) - Date.parse(a.createdAt);
            if (Boolean(a.currentlyStreaming) !== Boolean(b.currentlyStreaming))
                return a.currentlyStreaming ? -1 : 1;
            return (
                Date.parse(lastActive(b) ?? '1970-01-01') -
                Date.parse(lastActive(a) ?? '1970-01-01')
            );
        });
    });
    let offset = $derived(
        (Math.min(Math.floor(requestedPage), Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))) -
            1) *
            PAGE_SIZE,
    );
    let visible = $derived(filtered.slice(offset, offset + PAGE_SIZE));
</script>

<div class="space-y-5" aria-busy={loading}>
    <div class="flex flex-wrap gap-2" role="group" aria-label={m.users_directory_filters()}>
        {#each filters as item (item.key)}
            <button
                class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-primary-400 {filter ===
                item.key
                    ? 'border-primary-500/50 bg-primary-500/10 text-primary-200'
                    : 'border-surface-700 bg-surface-800/40 text-surface-400 hover:text-white hover:border-surface-500'}"
                aria-pressed={filter === item.key}
                onclick={() => update({ filter: item.key === 'all' ? null : item.key, p: null })}>
                {item.label}<span class="rounded bg-surface-700/60 px-1.5 text-xs tabular-nums"
                    >{item.count}</span>
            </button>
        {/each}
    </div>

    <div class="rounded-xl border border-surface-700 bg-surface-800/40 overflow-hidden">
        <div
            class="flex flex-col gap-3 border-b border-surface-700 p-4 sm:flex-row sm:items-center">
            <div class="min-w-0 flex-1">
                <SearchInput
                    aria-label={m.admin_users_filter_placeholder()}
                    value={query}
                    placeholder={m.users_directory_search_placeholder()}
                    oninput={({ value }) => update({ q: value || null, p: null }, true)}
                    onclear={() => update({ q: null, p: null }, true)} />
            </div>
            <label class="flex items-center gap-2 text-sm text-surface-400">
                {m.users_directory_sort()}
                <select
                    class="rounded-lg border border-surface-600 bg-surface-800 px-3 py-2 text-surface-200"
                    value={sort}
                    onchange={(event) => update({ sort: event.currentTarget.value, p: null })}>
                    <option value="recent">{m.admin_users_sort_recent()}</option>
                    <option value="name">{m.admin_users_sort_name()}</option>
                    <option value="newest">{m.admin_users_sort_newest()}</option>
                </select>
            </label>
        </div>

        <div
            class="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_1.5rem] gap-5 border-b border-surface-700/60 px-5 py-3 text-xs font-medium text-surface-400 lg:grid {onToggleAdmin &&
            onSetDisabled
                ? 'lg:pr-[4.75rem]'
                : ''}"
            aria-hidden="true">
            <span>{m.admin_users_col_user()}</span><span>{m.users_directory_role()}</span>
            <span>{m.users_directory_login()}</span><span>{m.admin_users_col_activity()}</span><span
            ></span>
        </div>
        <ul class="divide-y divide-surface-700/60">
            {#each visible as user (user.username)}
                <li class="flex items-start lg:items-center">
                    <button
                        class="group grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-5 text-left transition-colors hover:bg-surface-700/30 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-400 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_1.5rem] lg:gap-5 lg:px-5"
                        aria-label={m.admin_users_open_details({ username: user.username })}
                        onclick={() => onOpenDetails(user.username)}>
                        <span class="flex min-w-0 items-center gap-3">
                            <Avatar
                                src={getAvatarUrl(user.username)}
                                username={user.username}
                                alt=""
                                size="sm" />
                            <span class="min-w-0">
                                <span class="flex items-center gap-2">
                                    <span class="truncate font-medium text-white"
                                        >{user.displayName || user.username}</span>
                                    {#if isCurrentUser(user.username)}<span
                                            class="text-xs text-surface-400"
                                            >{m.users_directory_you()}</span
                                        >{/if}
                                </span>
                                <span class="mt-0.5 block truncate text-xs text-surface-400"
                                    >{user.email || user.username}</span>
                                {#if user.disabled}<span
                                        class="mt-1 inline-block text-xs text-red-300"
                                        >{m.admin_users_filter_disabled()}</span
                                    >{/if}
                            </span>
                        </span>
                        <span class="hidden text-sm text-surface-300 lg:block">
                            {user.isAdmin
                                ? m.admin_users_administrator()
                                : m.users_directory_member()}
                            <!-- Group-derived is the norm; only the exception earns a line. -->
                            {#if user.adminPinned}<span class="mt-1 block text-xs text-surface-500"
                                    >{m.users_directory_manual()}</span
                                >{/if}
                        </span>
                        <span
                            class="hidden text-sm lg:block {needsLoginAttention(user)
                                ? 'text-amber-300'
                                : 'text-surface-400'}">{loginMethods(user)}</span>
                        <span class="hidden min-w-0 text-sm lg:block">
                            <span
                                class={user.currentlyStreaming
                                    ? 'text-emerald-300'
                                    : 'text-surface-300'}
                                >{user.currentlyStreaming
                                    ? m.users_directory_streaming()
                                    : formatDate(lastActive(user))}</span>
                            {#if user.lastWatchedTitle}<span
                                    class="mt-1 block truncate text-xs text-surface-500"
                                    title={user.lastWatchedTitle}
                                    >{user.lastWatchedTitle}{#if user.lastActivitySource === 'jellyfin'}
                                        · {m.users_directory_via_jellyfin()}{/if}</span
                                >{/if}
                        </span>
                        <span
                            class="col-start-2 row-start-1 text-surface-500 group-hover:text-white lg:col-auto lg:row-auto"
                            aria-hidden="true">→</span>
                        <span
                            class="col-span-2 flex flex-wrap gap-x-4 gap-y-2 border-t border-surface-700/40 pt-3 text-xs lg:hidden">
                            <span class="text-surface-300"
                                >{user.isAdmin
                                    ? m.admin_users_administrator()
                                    : m.users_directory_member()}</span>
                            <span
                                class={needsLoginAttention(user)
                                    ? 'text-amber-300'
                                    : 'text-surface-400'}>{loginMethods(user)}</span>
                            <span
                                class={user.currentlyStreaming
                                    ? 'text-emerald-300'
                                    : 'text-surface-400'}
                                >{user.currentlyStreaming
                                    ? m.users_directory_streaming()
                                    : formatDate(lastActive(user))}</span>
                        </span>
                    </button>
                    {#if onToggleAdmin && onSetDisabled}
                        <div class="shrink-0 pr-2 pt-4 lg:pr-3 lg:pt-0">
                            <UserQuickActions
                                {user}
                                isSelf={isCurrentUser(user.username)}
                                busy={busyUsers.has(user.username)}
                                {onToggleAdmin}
                                {onSetDisabled} />
                        </div>
                    {/if}
                </li>
            {:else}
                <li class="px-6 py-14 text-center">
                    <p class="font-medium text-surface-200">
                        {loading ? m.users_directory_loading() : m.users_directory_empty()}
                    </p>
                    {#if query || filter !== 'all'}
                        <p class="mt-2 text-sm text-surface-400">
                            {m.users_directory_empty_hint()}
                        </p>
                        <button class="btn btn-surface mt-4" onclick={clearFilters}
                            >{m.users_directory_clear()}</button>
                    {/if}
                </li>
            {/each}
        </ul>
        <div
            class="flex flex-wrap items-center justify-between gap-3 border-t border-surface-700 px-4 py-3 text-xs text-surface-400">
            <!-- The paginator below already says "1-20 of N" for an unfiltered list. -->
            <span aria-live="polite"
                >{#if query || filter !== 'all' || filtered.length <= PAGE_SIZE}{m.users_directory_results(
                        { count: filtered.length, total: users.length },
                    )}{/if}</span>
            {#if query || filter !== 'all'}<button
                    class="hover:text-white underline underline-offset-4"
                    onclick={clearFilters}>{m.users_directory_clear()}</button
                >{/if}
        </div>
    </div>
    {#if filtered.length > PAGE_SIZE}
        <Pagination
            mode="simple"
            {offset}
            limit={PAGE_SIZE}
            hasMore={offset + PAGE_SIZE < filtered.length}
            totalCount={filtered.length}
            onpageChange={({ offset: next }) => update({ p: String(next / PAGE_SIZE + 1) })} />
    {/if}
</div>
