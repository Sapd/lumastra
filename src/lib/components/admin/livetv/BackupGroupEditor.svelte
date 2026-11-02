<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { Icon, XMark, Plus, Scissors, Star, Eye, EyeSlash } from 'svelte-hero-icons';
    import { apiGet, apiPost, apiPut, apiDelete } from '$lib/api/client.js';
    import {
        BackupGroupsAdminResponseSchema,
        ChannelUpdatedResponseSchema,
        LiveTvAckResponseSchema,
        SetGroupsOnAirResponseSchema,
        type BackupGroupsAdminResponse,
        type BackupGroupAdmin,
        type BackupGroupMember,
    } from '$lib/schemas/livetv.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import * as m from '$lib/paraglide/messages.js';
    import { LiveTvChannelHealthSchema } from '$lib/schemas/livetv-failures.js';
    import CategoryPicker from './CategoryPicker.svelte';
    import FeedHealthBadge from './FeedHealthBadge.svelte';
    import { allFeedsOffline } from './feed-health.js';
    import {
        DEFAULT_GROUP_FILTER,
        filterGroups,
        filterOptions,
        groupFacts,
        memberMatches,
        onAirFeedId,
        type GroupFilter,
        type GroupProblem,
    } from './backup-group-view.js';

    const qualityColors: Record<string, string> = {
        uhd: 'bg-purple-900/50 text-purple-300 border-purple-700/50',
        fhd: 'bg-blue-900/50 text-blue-300 border-blue-700/50',
        hd: 'bg-green-900/50 text-green-300 border-green-700/50',
        sd: 'bg-surface-700/50 text-surface-400 border-surface-600/50',
    };

    let groups = $state<BackupGroupAdmin[]>([]);
    let ungroupedChannels = $state<BackupGroupMember[]>([]);
    let loading = $state(true);

    // Selection state for split mode (per group)
    let splitGroupId = $state<string | null>(null);
    // eslint-disable-next-line svelte/no-unnecessary-state-wrap -- reassigned on mode enter/cancel
    let splitSelectedIds = $state<SvelteSet<string>>(new SvelteSet());

    // Selection state for creating new group from ungrouped
    let createMode = $state(false);
    // eslint-disable-next-line svelte/no-unnecessary-state-wrap -- reassigned on mode enter/cancel
    let createSelectedIds = $state<SvelteSet<string>>(new SvelteSet());

    // Expanded state per group
    // eslint-disable-next-line svelte/no-unnecessary-state-wrap -- reassigned in loadData
    let expandedGroups = $state<SvelteSet<string>>(new SvelteSet());

    async function loadData(): Promise<void> {
        loading = true;
        const { data, error } = await apiGet(
            '/api/admin/livetv/backup-groups',
            BackupGroupsAdminResponseSchema,
        );
        if (error) {
            toasts.error(error);
        } else if (data) {
            groups = data.groups;
            ungroupedChannels = data.ungroupedChannels;
            // Expand all groups by default if <= 10
            if (data.groups.length <= 10) {
                expandedGroups = new SvelteSet(data.groups.map((g) => g.id));
            }
        }
        loading = false;
    }

    $effect(() => {
        untrack(() => loadData());
    });

    function toggleExpand(groupId: string): void {
        const next = new SvelteSet(expandedGroups);
        if (next.has(groupId)) {
            next.delete(groupId);
        } else {
            next.add(groupId);
        }
        expandedGroups = next;
    }

    // --- Remove channel from group (AC #2) ---
    async function handleRemove(groupId: string, channelId: string): Promise<void> {
        const prevGroups = JSON.parse(JSON.stringify(groups));
        const prevUngrouped = JSON.parse(JSON.stringify(ungroupedChannels));

        // Optimistic: find channel, move to ungrouped, update group
        const group = groups.find((g) => g.id === groupId);
        if (!group) return;
        const channel = group.channels.find((c) => c.id === channelId);
        if (!channel) return;

        group.channels = group.channels.filter((c) => c.id !== channelId);
        if (group.channels.length <= 1) {
            // Group dissolves
            if (group.channels.length === 1) {
                ungroupedChannels = [...ungroupedChannels, group.channels[0]];
            }
            groups = groups.filter((g) => g.id !== groupId);
        } else {
            groups = [...groups];
        }
        ungroupedChannels = [...ungroupedChannels, channel];

        const { error } = await apiDelete(
            `/api/admin/livetv/backup-groups/${groupId}/channels`,
            LiveTvAckResponseSchema,
            { channelId },
        );

        if (error) {
            groups = prevGroups;
            ungroupedChannels = prevUngrouped;
            toasts.error(m.admin_livetv_backup_group_save_error());
        }
    }

    // --- Make a feed the group's primary (the feed viewers get) ---
    async function handleSetPrimary(groupId: string, channelId: string): Promise<void> {
        const group = groups.find((g) => g.id === groupId);
        if (!group || group.primaryChannelId === channelId) return;
        const previous = group.primaryChannelId;
        group.primaryChannelId = channelId;
        groups = [...groups];

        const { error } = await apiPut(
            `/api/admin/livetv/backup-groups/${groupId}/primary`,
            LiveTvAckResponseSchema,
            { channelId },
        );

        if (error) {
            const g = groups.find((x) => x.id === groupId);
            if (g) {
                g.primaryChannelId = previous;
                groups = [...groups];
            }
            toasts.error(m.admin_livetv_backup_group_save_error());
        }
    }

    // --- Clear a feed's failure streak ---
    async function handleResetHealth(channelId: string): Promise<void> {
        const { data, error } = await apiPost(
            `/api/admin/livetv/channels/${channelId}/health/reset`,
            LiveTvChannelHealthSchema,
        );
        if (error || !data) {
            toasts.error(m.admin_livetv_health_reset_error());
            return;
        }
        for (const g of groups) {
            for (const ch of g.channels) if (ch.id === channelId) ch.health = data;
        }
        groups = [...groups];
        ungroupedChannels = ungroupedChannels.map((ch) =>
            ch.id === channelId ? { ...ch, health: data } : ch,
        );
        toasts.success(m.admin_livetv_health_reset_done());
    }

    // --- Take whole stations off air / put them on air (one request for all) ---
    // Viewers fall back to the next visible feed, so hiding one feed no longer
    // removes a station: off air hides every feed; on air shows one (the primary,
    // or the best feed when the primary is degraded) and hides the rest.
    async function handleSetOnAir(groupIds: string[], onAir: boolean): Promise<void> {
        const ids = new Set(groupIds);
        const previous = new Map<string, boolean>(); // eslint-disable-line svelte/prefer-svelte-reactivity -- rollback temp
        for (const g of groups) {
            if (!ids.has(g.id)) continue;
            const pick = onAir ? onAirFeedId(g) : undefined;
            for (const ch of g.channels) {
                previous.set(ch.id, ch.isVisible);
                ch.isVisible = onAir && ch.id === pick;
            }
        }
        groups = [...groups];

        const { error } = await apiPut(
            '/api/admin/livetv/backup-groups/visibility',
            SetGroupsOnAirResponseSchema,
            { groupIds, onAir },
        );
        if (error) {
            for (const g of groups) {
                for (const ch of g.channels) {
                    const was = previous.get(ch.id);
                    if (was !== undefined) ch.isVisible = was;
                }
            }
            groups = [...groups];
            toasts.error(m.admin_livetv_backup_group_save_error());
        }
    }

    // Bulk on/off air for the listed (filtered) groups, after a confirm with the count.
    let pendingBulk = $state<'on' | 'off' | null>(null);
    let bulkBusy = $state(false);

    async function confirmBulk(): Promise<void> {
        if (!pendingBulk) return;
        const onAir = pendingBulk === 'on';
        pendingBulk = null;
        bulkBusy = true;
        await handleSetOnAir(
            shownGroups.map((g) => g.id),
            onAir,
        );
        bulkBusy = false;
    }

    // --- Show / hide one feed (same call as Channel Management's eye) ---
    async function handleToggleVisible(groupId: string, channelId: string): Promise<void> {
        const flip = (): boolean | undefined => {
            const ch = groups
                .find((g) => g.id === groupId)
                ?.channels.find((c) => c.id === channelId);
            if (!ch) return undefined;
            ch.isVisible = !ch.isVisible;
            groups = [...groups];
            return ch.isVisible;
        };
        const isVisible = flip();
        if (isVisible === undefined) return;

        const { error } = await apiPut(
            `/api/admin/livetv/channels/${channelId}`,
            ChannelUpdatedResponseSchema,
            { isVisible },
        );
        if (error) {
            flip();
            toasts.error(m.admin_livetv_backup_group_save_error());
        }
    }

    // --- Split group (AC #3) ---
    function enterSplitMode(groupId: string): void {
        splitGroupId = groupId;
        splitSelectedIds = new SvelteSet();
    }

    function cancelSplitMode(): void {
        splitGroupId = null;
        splitSelectedIds = new SvelteSet();
    }

    function toggleSplitChannel(channelId: string): void {
        const next = new SvelteSet(splitSelectedIds);
        if (next.has(channelId)) {
            next.delete(channelId);
        } else {
            next.add(channelId);
        }
        splitSelectedIds = next;
    }

    async function handleSplit(): Promise<void> {
        if (!splitGroupId || splitSelectedIds.size === 0) return;

        const prevGroups = JSON.parse(JSON.stringify(groups));
        const channelIds = Array.from(splitSelectedIds);
        const gId = splitGroupId;

        // Optimistic: move channels to a new group
        const originalGroup = groups.find((g) => g.id === gId);
        if (!originalGroup) return;

        const movedChannels = originalGroup.channels.filter((c) => splitSelectedIds.has(c.id));
        originalGroup.channels = originalGroup.channels.filter((c) => !splitSelectedIds.has(c.id));

        const newGroup: BackupGroupAdmin = {
            id: `temp-${Date.now()}`,
            name: movedChannels[0]?.name ?? m.admin_livetv_backup_group_new_group(),
            primaryChannelId: movedChannels[0]?.id,
            channels: movedChannels,
        };

        if (originalGroup.channels.length <= 1) {
            if (originalGroup.channels.length === 1) {
                ungroupedChannels = [...ungroupedChannels, originalGroup.channels[0]];
            }
            groups = [...groups.filter((g) => g.id !== gId), newGroup];
        } else {
            groups = [...groups, newGroup];
        }

        cancelSplitMode();

        const { error } = await apiPost(
            `/api/admin/livetv/backup-groups/${gId}/split`,
            LiveTvAckResponseSchema,
            { channelIds },
        );

        if (error) {
            groups = prevGroups;
            toasts.error(m.admin_livetv_backup_group_save_error());
        } else {
            // Reload to get real IDs and correct primaries
            await loadData();
        }
    }

    // --- Create group from ungrouped (AC #4) ---
    function enterCreateMode(): void {
        createMode = true;
        createSelectedIds = new SvelteSet();
    }

    function cancelCreateMode(): void {
        createMode = false;
        createSelectedIds = new SvelteSet();
    }

    function toggleCreateChannel(channelId: string): void {
        const next = new SvelteSet(createSelectedIds);
        if (next.has(channelId)) {
            next.delete(channelId);
        } else {
            next.add(channelId);
        }
        createSelectedIds = next;
    }

    async function handleCreate(): Promise<void> {
        if (createSelectedIds.size < 2) return;

        const prevGroups = JSON.parse(JSON.stringify(groups));
        const prevUngrouped = JSON.parse(JSON.stringify(ungroupedChannels));
        const channelIds = Array.from(createSelectedIds);

        // Optimistic: move to new group
        const movedChannels = ungroupedChannels.filter((c) => createSelectedIds.has(c.id));
        ungroupedChannels = ungroupedChannels.filter((c) => !createSelectedIds.has(c.id));
        const newGroup: BackupGroupAdmin = {
            id: `temp-${Date.now()}`,
            name: movedChannels[0]?.name ?? m.admin_livetv_backup_group_new_group(),
            primaryChannelId: movedChannels[0]?.id,
            channels: movedChannels,
        };
        groups = [...groups, newGroup];
        cancelCreateMode();

        const { error } = await apiPost(
            '/api/admin/livetv/backup-groups',
            LiveTvAckResponseSchema,
            { channelIds },
        );

        if (error) {
            groups = prevGroups;
            ungroupedChannels = prevUngrouped;
            toasts.error(m.admin_livetv_backup_group_save_error());
        } else {
            await loadData();
        }
    }

    // --- Add to existing group (AC #5) ---
    async function handleAddToGroup(groupId: string, channelId: string): Promise<void> {
        const prevGroups = JSON.parse(JSON.stringify(groups));
        const prevUngrouped = JSON.parse(JSON.stringify(ungroupedChannels));

        // Optimistic
        const channel = ungroupedChannels.find((c) => c.id === channelId);
        if (!channel) return;
        ungroupedChannels = ungroupedChannels.filter((c) => c.id !== channelId);
        const group = groups.find((g) => g.id === groupId);
        if (group) {
            group.channels = [...group.channels, channel];
            groups = [...groups];
        }

        const { error } = await apiPost(
            `/api/admin/livetv/backup-groups/${groupId}/channels`,
            LiveTvAckResponseSchema,
            { channelId },
        );

        if (error) {
            groups = prevGroups;
            ungroupedChannels = prevUngrouped;
            toasts.error(m.admin_livetv_backup_group_save_error());
        }
    }

    // =========================================================================
    // Finding your way: ~1,200 groups and ~9,000 ungrouped channels on a large
    // provider. Filters + sort (backup-group-view.ts), rendered a page at a time.
    // =========================================================================
    const GROUP_PAGE = 50;
    const UNGROUPED_PAGE = 100;

    let filter = $state<GroupFilter>({ ...DEFAULT_GROUP_FILTER });
    let groupLimit = $state(GROUP_PAGE);
    let ungroupedLimit = $state(UNGROUPED_PAGE);

    let facts = $derived(new Map(groups.map((g) => [g.id, groupFacts(g)])));
    let problemCount = $derived([...facts.values()].filter((f) => f.problems.length > 0).length);
    // Groups whose hidden primary can be fixed by making the on-air feed primary.
    let fixablePrimaries = $derived(
        groups.flatMap((g) => {
            const f = facts.get(g.id);
            return f?.shownId && f.problems.includes('primary-hidden')
                ? [{ groupId: g.id, channelId: f.shownId }]
                : [];
        }),
    );
    let fixingAll = $state(false);

    async function fixAllPrimaries(): Promise<void> {
        fixingAll = true;
        // One request per group, in order: a failure rolls back only that group.
        for (const { groupId, channelId } of fixablePrimaries) {
            await handleSetPrimary(groupId, channelId);
        }
        fixingAll = false;
    }
    let options = $derived(
        filterOptions(groups, ungroupedChannels, m.admin_livetv_uncategorized()),
    );
    let shownGroups = $derived(filterGroups(groups, facts, filter));
    let pagedGroups = $derived(shownGroups.slice(0, groupLimit));
    let shownUngrouped = $derived(
        ungroupedChannels.filter(
            (ch) =>
                memberMatches(ch, filter) &&
                (filter.air === 'all' || ch.isVisible === (filter.air === 'on-air')),
        ),
    );
    let pagedUngrouped = $derived(shownUngrouped.slice(0, ungroupedLimit));
    let isFiltered = $derived(JSON.stringify(filter) !== JSON.stringify(DEFAULT_GROUP_FILTER));

    function setFilter(patch: Partial<GroupFilter>): void {
        filter = { ...filter, ...patch };
        // A new filter starts at the first page again.
        groupLimit = GROUP_PAGE;
        ungroupedLimit = UNGROUPED_PAGE;
    }

    function expandShown(expand: boolean): void {
        if (!expand) {
            expandedGroups = new SvelteSet();
            return;
        }
        expandedGroups = new SvelteSet([...expandedGroups, ...pagedGroups.map((g) => g.id)]);
    }

    function problemLabel(problem: GroupProblem): string {
        switch (problem) {
            case 'primary-hidden':
                return m.admin_livetv_bg_problem_primary_hidden();
            case 'no-primary':
                return m.admin_livetv_bg_problem_no_primary();
            case 'mixed-countries':
                return m.admin_livetv_bg_problem_mixed_countries();
            case 'mixed-categories':
                return m.admin_livetv_bg_problem_mixed_categories();
        }
    }

    function problemHint(problem: GroupProblem): string {
        switch (problem) {
            case 'primary-hidden':
                return m.admin_livetv_bg_problem_primary_hidden_hint();
            case 'no-primary':
                return m.admin_livetv_bg_problem_no_primary_hint();
            case 'mixed-countries':
                return m.admin_livetv_bg_problem_mixed_countries_hint();
            case 'mixed-categories':
                return m.admin_livetv_bg_problem_mixed_categories_hint();
        }
    }

    let groupPickerItems = $derived(
        groups.map((g) => ({ id: g.id, name: g.name, count: g.channels.length })),
    );

    // Add-to-group dropdown state
    let addDropdownChannelId = $state<string | null>(null);

    function toggleAddDropdown(channelId: string): void {
        addDropdownChannelId = addDropdownChannelId === channelId ? null : channelId;
    }
</script>

<div class="space-y-4">
    <div class="flex items-center justify-between">
        <div>
            <h2 class="text-lg font-semibold">
                {m.admin_livetv_backup_groups()}
            </h2>
            <p class="text-sm text-surface-400">
                {m.admin_livetv_backup_groups_description()}
            </p>
        </div>
    </div>

    {#if loading}
        <div class="space-y-3">
            {#each Array(3) as _, i (i)}
                <div class="bg-surface-800 rounded-lg p-4">
                    <div class="h-6 bg-surface-700 rounded animate-pulse w-48"></div>
                    <div class="mt-3 space-y-2">
                        <div class="h-5 bg-surface-700 rounded animate-pulse w-full"></div>
                        <div class="h-5 bg-surface-700 rounded animate-pulse w-3/4"></div>
                    </div>
                </div>
            {/each}
        </div>
    {:else if groups.length === 0 && ungroupedChannels.length === 0}
        <div class="bg-surface-800 rounded-lg p-8 text-center">
            <p class="text-surface-400">
                {m.admin_livetv_backup_group_empty()}
            </p>
        </div>
    {:else}
        <!-- Filters -->
        <input
            type="search"
            value={filter.query}
            oninput={(e) => setFilter({ query: e.currentTarget.value })}
            placeholder={m.admin_livetv_bg_search()}
            aria-label={m.admin_livetv_bg_search()}
            class="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-white placeholder-surface-500 focus:border-yellow-500 focus:outline-none" />
        <div class="flex flex-wrap items-center gap-2">
            <select
                value={filter.categoryId}
                onchange={(e) => setFilter({ categoryId: e.currentTarget.value })}
                aria-label={m.admin_livetv_bg_any_category()}
                class="rounded-lg border border-surface-700 bg-surface-800 px-2 py-2 text-sm text-surface-200">
                <option value="">{m.admin_livetv_bg_any_category()}</option>
                {#each options.categories as opt (opt.value)}
                    <option value={opt.value}>{opt.label} ({opt.count})</option>
                {/each}
            </select>
            {#if options.countries.length > 1}
                <select
                    value={filter.country}
                    onchange={(e) => setFilter({ country: e.currentTarget.value })}
                    aria-label={m.admin_livetv_bg_any_country()}
                    class="rounded-lg border border-surface-700 bg-surface-800 px-2 py-2 text-sm text-surface-200">
                    <option value="">{m.admin_livetv_bg_any_country()}</option>
                    {#each options.countries as opt (opt.value)}
                        <option value={opt.value}>{opt.label} ({opt.count})</option>
                    {/each}
                </select>
            {/if}
            <select
                value={filter.air}
                onchange={(e) => setFilter({ air: e.currentTarget.value as GroupFilter['air'] })}
                aria-label={m.admin_livetv_bg_air_label()}
                class="rounded-lg border border-surface-700 bg-surface-800 px-2 py-2 text-sm text-surface-200">
                <option value="all">{m.admin_livetv_bg_air_all()}</option>
                <option value="on-air">{m.admin_livetv_bg_air_on()}</option>
                <option value="off-air">{m.admin_livetv_bg_air_off()}</option>
            </select>
            <select
                value={filter.sort}
                onchange={(e) => setFilter({ sort: e.currentTarget.value as GroupFilter['sort'] })}
                aria-label={m.admin_livetv_bg_sort_label()}
                class="rounded-lg border border-surface-700 bg-surface-800 px-2 py-2 text-sm text-surface-200">
                <option value="name">{m.admin_livetv_bg_sort_name()}</option>
                <option value="size">{m.admin_livetv_bg_sort_size()}</option>
                <option value="category">{m.admin_livetv_bg_sort_category()}</option>
            </select>
            {#if problemCount > 0}
                <label
                    class="flex cursor-pointer items-center gap-2 rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-300">
                    <input
                        type="checkbox"
                        checked={filter.problemsOnly}
                        onchange={(e) => setFilter({ problemsOnly: e.currentTarget.checked })}
                        class="h-4 w-4 rounded border-surface-600 bg-surface-700 text-yellow-500" />
                    {m.admin_livetv_bg_problems_only({ count: problemCount })}
                </label>
            {/if}
            {#if fixablePrimaries.length > 1}
                <button
                    type="button"
                    disabled={fixingAll}
                    class="rounded-lg bg-yellow-700/70 px-3 py-2 text-sm text-white hover:bg-yellow-600 disabled:opacity-50"
                    title={m.admin_livetv_bg_fix_primary_hint()}
                    onclick={fixAllPrimaries}>
                    {m.admin_livetv_bg_fix_all_primaries({ count: fixablePrimaries.length })}
                </button>
            {/if}
        </div>
        <div class="flex flex-wrap items-center gap-3 text-xs text-surface-400">
            <span
                >{m.admin_livetv_bg_showing({
                    shown: shownGroups.length,
                    total: groups.length,
                })}</span>
            {#if isFiltered}
                <button
                    type="button"
                    class="text-yellow-400 hover:text-yellow-300"
                    onclick={() => setFilter({ ...DEFAULT_GROUP_FILTER })}>
                    {m.admin_livetv_bg_reset_filters()}
                </button>
            {/if}
            {#if shownGroups.length > 0}
                <button
                    type="button"
                    disabled={bulkBusy}
                    class="rounded border border-surface-600 px-2 py-0.5 text-surface-300 hover:border-surface-400 hover:text-white disabled:opacity-50"
                    onclick={() => (pendingBulk = 'off')}>
                    {m.admin_livetv_bg_bulk_off({ count: shownGroups.length })}
                </button>
                <button
                    type="button"
                    disabled={bulkBusy}
                    class="rounded border border-surface-600 px-2 py-0.5 text-surface-300 hover:border-surface-400 hover:text-white disabled:opacity-50"
                    onclick={() => (pendingBulk = 'on')}>
                    {m.admin_livetv_bg_bulk_on({ count: shownGroups.length })}
                </button>
            {/if}
            <span class="ml-auto flex gap-3">
                <button
                    type="button"
                    class="hover:text-surface-200"
                    onclick={() => expandShown(true)}>
                    {m.admin_livetv_bg_expand_all()}
                </button>
                <button
                    type="button"
                    class="hover:text-surface-200"
                    onclick={() => expandShown(false)}>
                    {m.admin_livetv_bg_collapse_all()}
                </button>
            </span>
        </div>

        {#if pendingBulk}
            <div
                class="flex flex-wrap items-center gap-3 rounded-lg border border-yellow-800/40 bg-yellow-900/20 px-4 py-2 text-sm"
                role="alertdialog"
                aria-label={pendingBulk === 'off'
                    ? m.admin_livetv_bg_bulk_off({ count: shownGroups.length })
                    : m.admin_livetv_bg_bulk_on({ count: shownGroups.length })}>
                <span class="text-yellow-200">
                    {pendingBulk === 'off'
                        ? m.admin_livetv_bg_bulk_confirm_off({ count: shownGroups.length })
                        : m.admin_livetv_bg_bulk_confirm_on({ count: shownGroups.length })}
                </span>
                <button
                    type="button"
                    class="rounded bg-yellow-600 px-2 py-1 text-xs text-white hover:bg-yellow-700"
                    onclick={confirmBulk}>
                    {m.confirm()}
                </button>
                <button
                    type="button"
                    class="rounded bg-surface-700 px-2 py-1 text-xs text-surface-300 hover:bg-surface-600"
                    onclick={() => (pendingBulk = null)}>
                    {m.cancel()}
                </button>
            </div>
        {/if}

        {#if shownGroups.length === 0 && groups.length > 0}
            <p class="rounded-lg bg-surface-800 p-4 text-sm text-surface-400">
                {m.admin_livetv_bg_no_match()}
            </p>
        {/if}

        <!-- Backup Groups -->
        {#each pagedGroups as group (group.id)}
            {@const f = facts.get(group.id)}
            <div class="bg-surface-800 rounded-lg overflow-hidden">
                <!-- Group Header -->
                <div
                    class="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-750 transition-colors text-left cursor-pointer"
                    role="button"
                    tabindex="0"
                    onclick={() => toggleExpand(group.id)}
                    onkeydown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleExpand(group.id);
                        }
                    }}>
                    <div class="flex flex-wrap items-center gap-2">
                        <span class="text-xs text-surface-500">
                            {expandedGroups.has(group.id) ? '▼' : '▶'}
                        </span>
                        <span class="font-medium">{group.name}</span>
                        <span class="text-xs text-surface-500">
                            {m.admin_livetv_bg_feed_count({ count: group.channels.length })}
                        </span>
                        {#if f}
                            {#if f.categoryName}
                                <span class="text-xs text-surface-500">· {f.categoryName}</span>
                            {/if}
                            {#each f.countries as country (country)}
                                <span
                                    class="rounded border border-surface-600 px-1 text-[10px] uppercase text-surface-400">
                                    {country}
                                </span>
                            {/each}
                            <span
                                class="text-xs {f.visibleCount > 0
                                    ? 'text-green-400'
                                    : 'text-surface-500'}">
                                {f.visibleCount > 0
                                    ? m.admin_livetv_bg_on_air({
                                          visible: f.visibleCount,
                                          total: group.channels.length,
                                      })
                                    : m.admin_livetv_bg_air_off()}
                            </span>
                            {#if allFeedsOffline(group.channels)}
                                <span
                                    class="rounded border border-red-700/50 bg-red-900/40 px-1.5 text-[11px] text-red-300"
                                    title={m.admin_livetv_health_group_offline_hint()}
                                    data-testid="group-all-offline">
                                    {m.admin_livetv_health_group_offline()}
                                </span>
                            {/if}
                            {#each f.problems as problem (problem)}
                                <span
                                    class="rounded border border-amber-700/50 bg-amber-900/40 px-1.5 text-[11px] text-amber-300"
                                    title={problemHint(problem)}
                                    data-problem={problem}>
                                    {problemLabel(problem)}
                                </span>
                            {/each}
                        {/if}
                    </div>
                    {#if f?.shownId && f.problems.includes('primary-hidden') && splitGroupId !== group.id}
                        {@const shownId = f.shownId}
                        <button
                            type="button"
                            class="ml-auto mr-2 shrink-0 rounded bg-yellow-700/70 px-2 py-1 text-xs text-white hover:bg-yellow-600"
                            title={m.admin_livetv_bg_fix_primary_hint()}
                            onclick={(e) => {
                                e.stopPropagation();
                                void handleSetPrimary(group.id, shownId);
                            }}>
                            {m.admin_livetv_bg_fix_primary()}
                        </button>
                    {/if}
                    {#if f && splitGroupId !== group.id}
                        <button
                            type="button"
                            class="mr-2 shrink-0 rounded px-2 py-1 text-xs {f.visibleCount > 0
                                ? 'bg-surface-700 text-surface-300 hover:bg-surface-600'
                                : 'bg-green-800/60 text-green-100 hover:bg-green-700'} {f.shownId &&
                            f.problems.includes('primary-hidden')
                                ? ''
                                : 'ml-auto'}"
                            aria-label={f.visibleCount > 0
                                ? m.admin_livetv_bg_take_off_air_named({ name: group.name })
                                : m.admin_livetv_bg_put_on_air_named({ name: group.name })}
                            onclick={(e) => {
                                e.stopPropagation();
                                void handleSetOnAir([group.id], f.visibleCount === 0);
                            }}>
                            {f.visibleCount > 0
                                ? m.admin_livetv_bg_take_off_air()
                                : m.admin_livetv_bg_put_on_air()}
                        </button>
                    {/if}
                    {#if splitGroupId !== group.id}
                        <button
                            class="text-xs px-2 py-1 rounded bg-surface-700 hover:bg-surface-600 text-surface-300"
                            onclick={(e) => {
                                e.stopPropagation();
                                enterSplitMode(group.id);
                            }}
                            title={m.admin_livetv_backup_group_split()}>
                            <Icon src={Scissors} class="w-3.5 h-3.5 inline" />
                            {m.admin_livetv_backup_group_split_short()}
                        </button>
                    {/if}
                </div>

                <!-- Split Mode Bar -->
                {#if splitGroupId === group.id}
                    <div
                        class="flex items-center gap-2 px-4 py-2 bg-yellow-900/20 border-t border-yellow-800/30">
                        <span class="text-xs text-yellow-400">
                            {m.admin_livetv_backup_group_select_to_split({
                                count: splitSelectedIds.size.toString(),
                            })}
                        </span>
                        <button
                            class="text-xs px-2 py-1 rounded bg-yellow-700 hover:bg-yellow-600 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                            disabled={splitSelectedIds.size === 0}
                            onclick={handleSplit}>
                            {m.admin_livetv_backup_group_split()}
                        </button>
                        <button
                            class="text-xs px-2 py-1 rounded bg-surface-700 hover:bg-surface-600 text-surface-300"
                            onclick={cancelSplitMode}>
                            {m.admin_livetv_backup_group_cancel()}
                        </button>
                    </div>
                {/if}

                <!-- Channel Members -->
                {#if expandedGroups.has(group.id)}
                    <div class="border-t border-surface-700">
                        {#each group.channels as channel (channel.id)}
                            <div
                                class="flex items-center gap-3 px-4 py-2 hover:bg-surface-750 transition-colors border-b border-surface-700/50 last:border-0"
                                data-channel-id={channel.id}>
                                <!-- Split checkbox -->
                                {#if splitGroupId === group.id}
                                    <input
                                        type="checkbox"
                                        checked={splitSelectedIds.has(channel.id)}
                                        onchange={() => toggleSplitChannel(channel.id)}
                                        class="rounded border-surface-600" />
                                {/if}

                                <!-- Primary indicator -->
                                {#if channel.id === group.primaryChannelId}
                                    <Icon
                                        src={Star}
                                        solid
                                        class="w-4 h-4 text-yellow-500 shrink-0"
                                        title={m.admin_livetv_backup_group_primary()} />
                                {:else if splitGroupId !== group.id}
                                    <button
                                        type="button"
                                        class="shrink-0 rounded text-surface-500 hover:text-yellow-400"
                                        title={m.admin_livetv_backup_group_make_primary()}
                                        aria-label={m.admin_livetv_backup_group_make_primary_named({
                                            name: channel.adminDisplayName ?? channel.name,
                                        })}
                                        onclick={() => handleSetPrimary(group.id, channel.id)}>
                                        <Icon src={Star} class="h-4 w-4" />
                                    </button>
                                {:else}
                                    <div class="w-4 h-4 shrink-0"></div>
                                {/if}

                                <!-- Channel name -->
                                <div class="min-w-0 flex-1">
                                    <span
                                        class="block text-sm truncate"
                                        class:text-yellow-300={channel.id ===
                                            group.primaryChannelId}>
                                        {channel.adminDisplayName ?? channel.name}
                                    </span>
                                    <FeedHealthBadge
                                        health={channel.health}
                                        onReset={() => handleResetHealth(channel.id)} />
                                </div>

                                <!-- Quality badge -->
                                {#if channel.qualityTier}
                                    <span
                                        class="text-xs px-1.5 py-0.5 rounded border {qualityColors[
                                            channel.qualityTier
                                        ] ?? 'bg-surface-700 text-surface-400'}">
                                        {channel.qualityTier.toUpperCase()}
                                    </span>
                                {:else}
                                    <span
                                        class="text-xs px-1.5 py-0.5 rounded border bg-surface-700/50 text-surface-500 border-surface-600/50">
                                        —
                                    </span>
                                {/if}

                                <!-- The feed viewers get, and show / hide -->
                                {#if channel.id === f?.shownId}
                                    <span
                                        class="rounded bg-green-900/50 px-1.5 text-[11px] text-green-300"
                                        title={m.admin_livetv_bg_on_air_feed_hint()}>
                                        {m.admin_livetv_bg_on_air_feed()}
                                    </span>
                                {/if}
                                <button
                                    type="button"
                                    class="rounded p-1 hover:bg-surface-700"
                                    aria-label={channel.isVisible
                                        ? m.admin_livetv_bg_hide_feed({
                                              name: channel.adminDisplayName ?? channel.name,
                                          })
                                        : m.admin_livetv_bg_show_feed({
                                              name: channel.adminDisplayName ?? channel.name,
                                          })}
                                    title={channel.isVisible
                                        ? m.admin_livetv_bulk_hide()
                                        : m.admin_livetv_bulk_show()}
                                    onclick={() => handleToggleVisible(group.id, channel.id)}>
                                    <Icon
                                        src={channel.isVisible ? Eye : EyeSlash}
                                        class="h-4 w-4 {channel.isVisible
                                            ? 'text-green-400'
                                            : 'text-surface-500'}" />
                                </button>

                                <!-- Remove button -->
                                {#if splitGroupId !== group.id}
                                    <button
                                        class="p-1 rounded hover:bg-red-900/30 text-surface-500 hover:text-red-400 transition-colors"
                                        title={m.admin_livetv_backup_group_remove()}
                                        onclick={() => handleRemove(group.id, channel.id)}>
                                        <Icon src={XMark} class="w-4 h-4" />
                                    </button>
                                {/if}
                            </div>
                        {/each}
                    </div>
                {/if}
            </div>
        {/each}
        {#if shownGroups.length > groupLimit}
            {@render showMore(shownGroups.length - groupLimit, GROUP_PAGE, () => {
                groupLimit += GROUP_PAGE;
            })}
        {/if}

        <!-- Ungrouped Channels Section -->
        {#if ungroupedChannels.length > 0}
            <div class="bg-surface-800 rounded-lg overflow-hidden">
                <div
                    class="flex items-center justify-between px-4 py-3 border-b border-surface-700">
                    <h3 class="font-medium text-surface-300">
                        {m.admin_livetv_backup_group_ungrouped()}
                        <span class="text-xs text-surface-500">
                            ({isFiltered
                                ? m.admin_livetv_category_count_shown({
                                      shown: shownUngrouped.length,
                                      total: ungroupedChannels.length,
                                  })
                                : ungroupedChannels.length})
                        </span>
                    </h3>
                    {#if !createMode}
                        <button
                            class="text-xs px-2 py-1 rounded bg-surface-700 hover:bg-surface-600 text-surface-300"
                            onclick={enterCreateMode}>
                            <Icon src={Plus} class="w-3.5 h-3.5 inline" />
                            {m.admin_livetv_backup_group_create()}
                        </button>
                    {:else}
                        <div class="flex items-center gap-2">
                            <span class="text-xs text-blue-400">
                                {m.admin_livetv_selected_count({ count: createSelectedIds.size })}
                            </span>
                            <button
                                class="text-xs px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                                disabled={createSelectedIds.size < 2}
                                onclick={handleCreate}
                                title={createSelectedIds.size < 2
                                    ? m.admin_livetv_backup_group_min_channels()
                                    : ''}>
                                {m.admin_livetv_backup_group_create()}
                            </button>
                            <button
                                class="text-xs px-2 py-1 rounded bg-surface-700 hover:bg-surface-600 text-surface-300"
                                onclick={cancelCreateMode}>
                                {m.admin_livetv_backup_group_cancel()}
                            </button>
                        </div>
                    {/if}
                </div>

                <div>
                    {#each pagedUngrouped as channel (channel.id)}
                        <div
                            class="flex items-center gap-3 px-4 py-2 hover:bg-surface-750 transition-colors border-b border-surface-700/50 last:border-0"
                            data-channel-id={channel.id}>
                            <!-- Create-mode checkbox -->
                            {#if createMode}
                                <input
                                    type="checkbox"
                                    checked={createSelectedIds.has(channel.id)}
                                    onchange={() => toggleCreateChannel(channel.id)}
                                    class="rounded border-surface-600" />
                            {/if}

                            <div class="min-w-0 flex-1">
                                <span class="block text-sm truncate">
                                    {channel.adminDisplayName ?? channel.name}
                                </span>
                                <FeedHealthBadge
                                    health={channel.health}
                                    onReset={() => handleResetHealth(channel.id)} />
                            </div>

                            <!-- Quality badge -->
                            {#if channel.qualityTier}
                                <span
                                    class="text-xs px-1.5 py-0.5 rounded border {qualityColors[
                                        channel.qualityTier
                                    ] ?? 'bg-surface-700 text-surface-400'}">
                                    {channel.qualityTier.toUpperCase()}
                                </span>
                            {:else}
                                <span
                                    class="text-xs px-1.5 py-0.5 rounded border bg-surface-700/50 text-surface-500 border-surface-600/50">
                                    —
                                </span>
                            {/if}

                            <!-- Add to group dropdown -->
                            {#if !createMode && groups.length > 0}
                                <div class="relative">
                                    <button
                                        class="p-1 rounded hover:bg-blue-900/30 text-surface-500 hover:text-blue-400 transition-colors"
                                        title={m.admin_livetv_backup_group_add_to()}
                                        onclick={() => toggleAddDropdown(channel.id)}>
                                        <Icon src={Plus} class="w-4 h-4" />
                                    </button>
                                    {#if addDropdownChannelId === channel.id}
                                        <div
                                            class="absolute right-0 top-full mt-1 z-20 w-72 bg-surface-900 border border-surface-700 rounded-lg shadow-lg"
                                            role="dialog"
                                            aria-label={m.admin_livetv_backup_group_add_to()}
                                            tabindex="-1"
                                            onkeydown={(e) => {
                                                if (e.key === 'Escape') {
                                                    addDropdownChannelId = null;
                                                }
                                            }}>
                                            <CategoryPicker
                                                categories={groupPickerItems}
                                                placeholder={m.admin_livetv_bg_find_group()}
                                                showPosition={false}
                                                onPick={(groupId) => {
                                                    addDropdownChannelId = null;
                                                    handleAddToGroup(groupId, channel.id);
                                                }} />
                                        </div>
                                    {/if}
                                </div>
                            {/if}
                        </div>
                    {/each}
                    {#if shownUngrouped.length > ungroupedLimit}
                        {@render showMore(
                            shownUngrouped.length - ungroupedLimit,
                            UNGROUPED_PAGE,
                            () => {
                                ungroupedLimit += UNGROUPED_PAGE;
                            },
                        )}
                    {/if}
                </div>
            </div>
        {/if}
    {/if}
</div>

{#snippet showMore(remaining: number, page: number, more: () => void)}
    <div class="flex justify-center py-2 text-sm">
        <button type="button" class="text-yellow-400 hover:text-yellow-300" onclick={more}>
            {m.admin_livetv_show_more_channels({ count: Math.min(page, remaining), remaining })}
        </button>
    </div>
{/snippet}
