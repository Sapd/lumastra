<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin activity history: one compact toolbar, a day-grouped dense list, and
  the shared DetailPanel for everything an event carries. Filters live in the
  URL (?user=&type=&days=&q=) so a filtered view survives refresh/back and can
  be shared.
-->

<script lang="ts">
    import { onMount, untrack } from 'svelte';
    import { goto } from '$app/navigation';
    import { page } from '$app/state';
    import { SvelteURLSearchParams } from 'svelte/reactivity';
    import { Icon, ArrowPath, MagnifyingGlass, XMark } from 'svelte-hero-icons';
    import { apiGet } from '$lib/api/client';
    import { getLocalUsers } from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages.js';
    import {
        ActivityFeedResponseSchema,
        ActivityTypeSchema,
        type ActivityType,
    } from '$lib/schemas/activity-feed';
    import type { LocalUser } from '$lib/schemas/api-admin-responses';
    import LoadingState from '$lib/components/ui/LoadingState.svelte';
    import DetailPanel from '$lib/components/admin/detail/DetailPanel.svelte';
    import ActivityRow from './ActivityRow.svelte';
    import ActivityDetail from './ActivityDetail.svelte';
    import {
        type ActivityItem,
        formatDayHeading,
        getActivityVerb,
        groupByDay,
        isViewingActivity,
    } from './activity-utils';

    let { limit = 50 }: { limit?: number } = $props();

    const DEFAULT_DAYS = 30;
    const DAY_OPTIONS = [
        { value: 1, label: '24 hours' },
        { value: 7, label: '7 days' },
        { value: 30, label: '30 days' },
        { value: 90, label: '90 days' },
        { value: 365, label: '1 year' },
        { value: 3650, label: 'All' },
    ] as const;
    const TYPE_OPTIONS: { value: ActivityType; label: string }[] = [
        { value: 'started', label: 'Started' },
        { value: 'finished', label: 'Finished' },
        { value: 'abandoned', label: 'Stopped' },
        { value: 'rating', label: 'Ratings' },
        { value: 'watchlist_add', label: 'Watchlist added' },
        { value: 'watchlist_remove', label: 'Watchlist removed' },
    ];

    // --- URL-backed filters ---------------------------------------------
    const userId = $derived(page.url.searchParams.get('user') ?? '');
    const activityType = $derived.by((): ActivityType | '' => {
        const parsed = ActivityTypeSchema.safeParse(page.url.searchParams.get('type'));
        return parsed.success ? parsed.data : '';
    });
    const days = $derived.by(() => {
        const raw = Number(page.url.searchParams.get('days'));
        return DAY_OPTIONS.some((o) => o.value === raw) ? raw : DEFAULT_DAYS;
    });
    const search = $derived(page.url.searchParams.get('q') ?? '');
    const hasFilters = $derived(Boolean(userId || activityType || search || days !== DEFAULT_DAYS));

    function setParams(changes: Record<string, string>): void {
        const params = new SvelteURLSearchParams(page.url.searchParams);
        for (const [key, value] of Object.entries(changes)) {
            if (value) params.set(key, value);
            else params.delete(key);
        }
        const query = params.toString();
        void goto(query ? `?${query}` : page.url.pathname, {
            replaceState: true,
            keepFocus: true,
            noScroll: true,
        });
    }

    // Search applies as you type, debounced; the draft mirrors the URL when
    // the URL changes for another reason (back/forward, Clear).
    let searchDraft = $derived(search);
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    function onSearchInput(value: string): void {
        searchDraft = value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => setParams({ q: value.trim() }), 300);
    }

    // --- Data -------------------------------------------------------------
    let activities: ActivityItem[] = $state([]);
    let users: LocalUser[] = $state([]);
    let loading = $state(true);
    let loadingMore = $state(false);
    let error = $state('');
    let hasMore = $state(true);
    // Bumped per fresh load: a slow response for filters the operator has
    // already changed away from must not overwrite (or append to) the new list.
    let generation = 0;

    const groups = $derived(groupByDay(activities));
    const playbackCount = $derived(activities.filter(isViewingActivity).length);
    const distinctUsers = $derived(new Set(activities.map((item) => item.author.userId)).size);

    async function loadActivities(append = false): Promise<void> {
        if (append && (loadingMore || !hasMore)) return;
        const requestGeneration = append ? generation : ++generation;

        if (append) loadingMore = true;
        else {
            loading = true;
            error = '';
        }

        const result = await apiGet('/api/admin/activity', ActivityFeedResponseSchema, {
            params: {
                limit,
                offset: append ? activities.length : 0,
                days,
                ...(activityType ? { activityType } : {}),
                ...(userId ? { userId } : {}),
                ...(search ? { search } : {}),
            },
        });
        if (requestGeneration !== generation) return;

        if (result.data) {
            if (append) {
                // Offset paging shifts as new activity arrives; a repeated row
                // would make the keyed each throw on its duplicate key.
                const seen = new Set(activities.map((a) => `${a.activityType}:${a.id}`));
                activities = [
                    ...activities,
                    ...result.data.items.filter((a) => !seen.has(`${a.activityType}:${a.id}`)),
                ];
            } else {
                activities = result.data.items;
            }
            hasMore = result.data.page.hasMore;
        } else if (!append) {
            activities = [];
            hasMore = false;
            error = result.error ?? 'Failed to load activity';
        } else {
            // A failed "Load more" used to just stop spinning.
            toasts.error(m.error_loading({ error: result.error ?? '' }));
        }
        loading = false;
        loadingMore = false;
    }

    // Re-fetch whenever a filter changes (tracks the four derived filters).
    $effect(() => {
        void [userId, activityType, days, search];
        untrack(() => void loadActivities());
    });

    onMount(() => {
        void getLocalUsers().then((result) => {
            if (result.data) users = result.data.items;
        });
        return () => clearTimeout(searchTimer);
    });

    // --- Detail panel -----------------------------------------------------
    let selected = $state<ActivityItem | null>(null);
    const detailTabs = [{ id: 'detail', label: 'Details' }] as const;
    const selectedKey = $derived(selected ? `${selected.activityType}:${selected.id}` : null);
</script>

<div class="space-y-4">
    <!-- Toolbar -->
    <div class="flex flex-col gap-2 xl:flex-row xl:items-center">
        <label class="relative block min-w-0 xl:w-64 xl:shrink-0">
            <span class="sr-only">Search activity</span>
            <Icon
                src={MagnifyingGlass}
                class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-400" />
            <input
                class="input input-sm w-full pl-8"
                type="search"
                value={searchDraft}
                oninput={(e) => onSearchInput(e.currentTarget.value)}
                placeholder="Title, user, device, client…" />
        </label>

        <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center xl:flex-nowrap">
            <label>
                <span class="sr-only">User</span>
                <select
                    class="select w-full !py-1.5 !pl-2.5 !pr-8 !text-sm sm:w-auto"
                    value={userId}
                    onchange={(e) => setParams({ user: e.currentTarget.value })}>
                    <option value="">All users</option>
                    {#each users as user (user.id)}
                        <option value={user.id}>{user.username}</option>
                    {/each}
                    {#if userId && !users.some((u) => u.id === userId)}
                        <option value={userId}
                            >{activities.find((a) => a.author.userId === userId)?.author
                                .displayName || 'Selected user'}</option>
                    {/if}
                </select>
            </label>

            <label>
                <span class="sr-only">Activity type</span>
                <select
                    class="select w-full !py-1.5 !pl-2.5 !pr-8 !text-sm sm:w-auto"
                    value={activityType}
                    onchange={(e) => setParams({ type: e.currentTarget.value })}>
                    <option value="">All activity</option>
                    {#each TYPE_OPTIONS as option (option.value)}
                        <option value={option.value}>{option.label}</option>
                    {/each}
                </select>
            </label>

            <!-- Time range: segmented on wide screens, a select on phones -->
            <div
                class="hidden rounded-md border border-surface-700 bg-surface-800 p-0.5 sm:inline-flex"
                role="radiogroup"
                aria-label="Time range">
                {#each DAY_OPTIONS as option (option.value)}
                    <button
                        type="button"
                        role="radio"
                        aria-checked={days === option.value}
                        class="rounded px-2 py-1 text-xs font-medium transition-colors {days ===
                        option.value
                            ? 'bg-primary-500/20 text-primary-200'
                            : 'text-surface-400 hover:text-surface-100'}"
                        onclick={() =>
                            setParams({
                                days: option.value === DEFAULT_DAYS ? '' : String(option.value),
                            })}>
                        {option.label}
                    </button>
                {/each}
            </div>
            <label class="sm:hidden">
                <span class="sr-only">Time range</span>
                <select
                    class="select w-full !py-1.5 !pl-2.5 !pr-8 !text-sm"
                    value={days}
                    onchange={(e) =>
                        setParams({
                            days:
                                Number(e.currentTarget.value) === DEFAULT_DAYS
                                    ? ''
                                    : e.currentTarget.value,
                        })}>
                    {#each DAY_OPTIONS as option (option.value)}
                        <option value={option.value}>{option.label}</option>
                    {/each}
                </select>
            </label>
        </div>

        <button
            type="button"
            class="btn-icon btn-icon-sm variant-ghost-surface hidden shrink-0 xl:ml-auto xl:inline-flex"
            onclick={() => void loadActivities()}
            disabled={loading}
            title="Refresh"
            aria-label="Refresh activity">
            <Icon src={ArrowPath} class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
        </button>
    </div>

    <!-- Result summary + clear, one quiet line -->
    <div class="-mt-2 flex min-h-6 items-center gap-3 text-xs text-surface-400">
        {#if activities.length > 0}
            <span>
                {activities.length}{hasMore ? '+' : ''} events · {playbackCount} playback · {distinctUsers}
                {distinctUsers === 1 ? 'user' : 'users'}
            </span>
        {/if}
        {#if hasFilters}
            <button
                type="button"
                class="inline-flex items-center gap-1 text-primary-300 hover:text-primary-200"
                onclick={() => setParams({ user: '', type: '', days: '', q: '' })}>
                <Icon src={XMark} class="h-3.5 w-3.5" />
                Clear filters
            </button>
        {/if}
        <button
            type="button"
            class="ml-auto inline-flex items-center gap-1 hover:text-surface-200 xl:hidden"
            onclick={() => void loadActivities()}
            disabled={loading}
            aria-label="Refresh activity">
            <Icon src={ArrowPath} class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
            Refresh
        </button>
    </div>

    <LoadingState
        loading={loading && activities.length === 0}
        {error}
        isEmpty={activities.length === 0}
        emptyMessage={hasFilters ? 'No activity matches these filters' : 'No activity recorded yet'}
        loadingMessage="Loading activity…">
        <div
            class="overflow-hidden rounded-lg border border-surface-700/60 bg-surface-800/60 transition-opacity {loading
                ? 'opacity-60'
                : ''}">
            <!-- Column headings (md+) -->
            <div
                class="hidden grid-cols-[4rem_2.25rem_minmax(0,1fr)_8rem_minmax(0,14rem)_7rem] gap-x-3 border-b border-surface-700/60 px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wide text-surface-500 md:grid">
                <span>Time</span>
                <span></span>
                <span>Title</span>
                <span>User</span>
                <span>Device · client</span>
                <span class="text-right">Progress</span>
            </div>

            {#each groups as group (group.key)}
                <section aria-label={formatDayHeading(group.items[0].activityTime)}>
                    <h3
                        class="flex items-baseline justify-between border-b border-surface-700/40 bg-surface-900/40 px-3 py-1 text-xs font-semibold text-surface-300">
                        <span>{formatDayHeading(group.items[0].activityTime)}</span>
                        <span class="font-normal text-surface-500">{group.items.length}</span>
                    </h3>
                    <ul class="divide-y divide-surface-700/30">
                        {#each group.items as activity (`${activity.activityType}:${activity.id}`)}
                            <li>
                                <ActivityRow
                                    {activity}
                                    selected={selectedKey ===
                                        `${activity.activityType}:${activity.id}`}
                                    onselect={(item) => (selected = item)} />
                            </li>
                        {/each}
                    </ul>
                </section>
            {/each}
        </div>

        {#if hasMore}
            <div class="mt-3 text-center">
                <button
                    class="btn btn-sm variant-soft"
                    type="button"
                    onclick={() => void loadActivities(true)}
                    disabled={loadingMore}>
                    {loadingMore ? 'Loading…' : 'Load more'}
                </button>
            </div>
        {:else if activities.length > 0}
            <p class="mt-3 text-center text-xs text-surface-500">End of retained activity</p>
        {/if}
    </LoadingState>
</div>

{#if selected}
    {@const current = selected}
    <DetailPanel
        titleText={current.title}
        subtitle="{getActivityVerb(current)} · {(current.author.displayName ?? '') ||
            current.author.userId}"
        tabs={detailTabs}
        activeTab="detail"
        onTabChange={() => {}}
        mode="panel"
        onclose={() => (selected = null)}>
        <ActivityDetail
            activity={current}
            onfilteruser={userId === current.author.userId
                ? undefined
                : (id) => {
                      selected = null;
                      setParams({ user: id });
                  }} />
    </DetailPanel>
{/if}
