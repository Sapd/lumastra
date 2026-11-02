<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module lang="ts">
    export interface UserWithIssue {
        user_id: string;
        username?: string | null;
        total_sessions: number;
        avg_health_score: number;
        rebuffers: number;
        sessions_with_issues: number;
    }
</script>

<script lang="ts">
    import HealthScoreBadge from './badges/HealthScoreBadge.svelte';
    import SessionDetailDrawer from './SessionDetailDrawer.svelte';
    import SortableHeader, { type SortDirection } from './SortableHeader.svelte';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        users: UserWithIssue[];
    }

    let { users }: Props = $props();

    type SortKey = 'name' | 'sessions' | 'health' | 'rebuffers' | 'problemRate';

    // Worst health first matches the server order; any column re-sorts, so a
    // 5-session user no longer outranks the one with 42 rebuffers by default
    // only because the table could not be sorted another way.
    let sortKey = $state<SortKey>('health');
    let sortDir = $state<SortDirection>('asc');

    function problemRate(user: UserWithIssue): number {
        return user.total_sessions > 0 ? user.sessions_with_issues / user.total_sessions : 0;
    }

    function sortValue(user: UserWithIssue, key: SortKey): number | string {
        switch (key) {
            case 'name':
                return (user.username ?? user.user_id).toLowerCase();
            case 'sessions':
                return user.total_sessions;
            case 'health':
                return user.avg_health_score ?? Number.POSITIVE_INFINITY;
            case 'rebuffers':
                return user.rebuffers;
            case 'problemRate':
                return problemRate(user);
        }
    }

    let sortedUsers = $derived(
        [...users].sort((a, b) => {
            const va = sortValue(a, sortKey);
            const vb = sortValue(b, sortKey);
            const cmp =
                typeof va === 'string' && typeof vb === 'string'
                    ? va.localeCompare(vb)
                    : Number(va) - Number(vb);
            return sortDir === 'asc' ? cmp : -cmp;
        }),
    );

    function sortBy(key: SortKey): void {
        if (sortKey === key) {
            sortDir = sortDir === 'asc' ? 'desc' : 'asc';
            return;
        }
        sortKey = key;
        // Health reads worst-first ascending; every count reads worst-first descending.
        sortDir = key === 'health' || key === 'name' ? 'asc' : 'desc';
    }

    function directionFor(key: SortKey): SortDirection | null {
        return sortKey === key ? sortDir : null;
    }

    let openUserId = $state<string | null>(null);

    function openDrawer(userId: string): void {
        openUserId = userId;
    }

    function closeDrawer(): void {
        openUserId = null;
    }

    function issueRatio(user: UserWithIssue): string {
        const total = user.total_sessions;
        const withIssues = user.sessions_with_issues;
        if (total <= 0) return `${withIssues}/0`;
        const pct = Math.min(100, Math.round((withIssues / total) * 100));
        return `${withIssues}/${total} (${pct}%)`;
    }
</script>

{#if openUserId !== null}
    {@const user = users.find((u) => u.user_id === openUserId)}
    <SessionDetailDrawer
        endpoint="/api/admin/playback-quality/user/{encodeURIComponent(openUserId)}"
        label={user?.username ?? openUserId ?? ''}
        onclose={closeDrawer} />
{/if}

<div class="bg-surface-800/50 border border-surface-700 rounded-xl overflow-x-auto">
    <table class="w-full min-w-[36rem]">
        <thead class="bg-surface-700/50">
            <tr>
                <SortableHeader
                    label={m.admin_pbquality_col_user()}
                    align="left"
                    direction={directionFor('name')}
                    onsort={() => sortBy('name')} />
                <SortableHeader
                    label={m.admin_quality_sessions()}
                    direction={directionFor('sessions')}
                    onsort={() => sortBy('sessions')} />
                <SortableHeader
                    label={m.admin_pbquality_col_health()}
                    direction={directionFor('health')}
                    onsort={() => sortBy('health')} />
                <SortableHeader
                    label={m.admin_quality_rebuffers()}
                    direction={directionFor('rebuffers')}
                    onsort={() => sortBy('rebuffers')} />
                <SortableHeader
                    label={m.admin_pbquality_col_problem_rate()}
                    title={m.admin_pbquality_col_problem_rate_hint()}
                    direction={directionFor('problemRate')}
                    onsort={() => sortBy('problemRate')} />
            </tr>
        </thead>
        <tbody class="divide-y divide-surface-700">
            {#each sortedUsers as user (user.user_id)}
                {@const isOpen = openUserId === user.user_id}
                {@const name = user.username ?? user.user_id}
                <tr
                    class="hover:bg-surface-700/30 transition-colors focus-within:bg-surface-700/30">
                    <td class="px-4 py-3">
                        <button
                            class="text-left w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded"
                            onclick={() => openDrawer(user.user_id)}
                            aria-expanded={isOpen}
                            aria-label={m.admin_pbquality_view_sessions_for({ name })}>
                            <div class="font-medium">{name}</div>
                            {#if user.username}
                                <div
                                    class="text-xs text-surface-500 font-mono truncate max-w-xs mt-0.5"
                                    title={user.user_id}>
                                    {user.user_id.slice(0, 12)}…
                                </div>
                            {/if}
                        </button>
                    </td>
                    <td class="px-4 py-3 text-center tabular-nums">{user.total_sessions}</td>
                    <td class="px-4 py-3 text-center">
                        <HealthScoreBadge score={user.avg_health_score} variant="text" />
                    </td>
                    <td class="px-4 py-3 text-center tabular-nums">
                        <span class={user.rebuffers > 0 ? 'text-orange-400' : ''}>
                            {user.rebuffers}
                        </span>
                    </td>
                    <td class="px-4 py-3 text-center text-sm tabular-nums">
                        {#if user.sessions_with_issues > 0}
                            <a
                                href={resolve(
                                    `/admin/users/client-diagnostics?kind=playback_incident&userId=${encodeURIComponent(user.user_id)}`,
                                )}
                                class="text-orange-400 underline decoration-dotted underline-offset-2 hover:text-orange-300"
                                title={m.admin_pbquality_view_incidents_for({ name })}>
                                {issueRatio(user)}
                            </a>
                        {:else}
                            {issueRatio(user)}
                        {/if}
                    </td>
                </tr>
            {/each}
        </tbody>
    </table>
</div>
