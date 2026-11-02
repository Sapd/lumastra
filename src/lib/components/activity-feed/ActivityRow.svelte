<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  One dense line per activity event. Everything beyond "who, what, where,
  how far" lives in the detail panel the row opens — the row answers the
  scanning questions, the panel answers the debugging ones.
-->

<script lang="ts">
    import { Icon } from 'svelte-hero-icons';
    import { getCatalogPosterUrl, handleImageError } from '$lib/utils/image-utils';
    import { formatDuration } from '$lib/utils/time-formatting';
    import { displayName } from '$lib/utils/data-extraction';
    import { deviceLabel } from '$lib/components/admin/client-diagnostics/user-agent';
    import {
        type ActivityItem,
        getActivityColor,
        getActivityIcon,
        getActivityVerb,
        getProgress,
        getSubtitle,
        isViewingActivity,
        labelPlayMethod,
        playMethodBadge,
    } from './activity-utils';

    let {
        activity,
        selected = false,
        onselect,
    }: {
        activity: ActivityItem;
        selected?: boolean;
        onselect: (item: ActivityItem) => void;
    } = $props();

    const viewing = $derived(isViewingActivity(activity));
    const posterUrl = $derived(
        activity.mediaId ? getCatalogPosterUrl(activity.mediaId, { size: 'thumb' }) : null,
    );
    const progress = $derived(viewing ? getProgress(activity) : null);
    const user = $derived(
        displayName((activity.author.displayName ?? '') || activity.author.userId),
    );
    const client = $derived(
        [activity.clientName, activity.clientVersion?.replace(/\s*\(.*\)$/, '')]
            .filter(Boolean)
            .join(' '),
    );
    // Web clients record the raw user agent as the device name; show it the
    // way client diagnostics does ("Chrome on macOS"), full string on hover.
    const deviceInfo = $derived(deviceLabel(activity.deviceName, null));
    const device = $derived(activity.deviceName ? deviceInfo.label : '');
    const subtitle = $derived(getSubtitle(activity));
    const time = $derived(
        new Date(activity.activityTime).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        }),
    );
    let posterFailed = $state(false);
</script>

<button
    type="button"
    class="row group grid w-full grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2 text-left
        transition-colors hover:bg-surface-700/40 focus-visible:bg-surface-700/40 focus-visible:outline-none
        md:grid-cols-[4rem_2.25rem_minmax(0,1fr)_8rem_minmax(0,14rem)_7rem]
        {selected ? 'bg-primary-500/10 hover:bg-primary-500/15' : ''}"
    aria-current={selected ? 'true' : undefined}
    onclick={() => onselect(activity)}>
    <!-- Time (md+) -->
    <span class="hidden whitespace-nowrap font-mono text-xs tabular-nums text-surface-400 md:block">
        {time}
    </span>

    <!-- Poster, or the event icon when there is no artwork -->
    <span
        class="relative flex h-12 w-9 items-center justify-center overflow-hidden rounded bg-surface-700/60">
        {#if posterUrl && !posterFailed}
            <img
                src={posterUrl}
                alt=""
                loading="lazy"
                class="h-full w-full object-cover"
                onerror={(event) => {
                    posterFailed = true;
                    handleImageError(event, { hideOnError: true });
                }} />
        {:else}
            <Icon
                src={getActivityIcon(activity.activityType)}
                class="h-5 w-5 {getActivityColor(activity.activityType)}" />
        {/if}
        {#if activity.isActive}
            <span
                class="absolute right-0.5 top-0.5 h-2 w-2 animate-pulse rounded-full bg-green-400 ring-2 ring-surface-800"
                title="Session is live"></span>
        {/if}
    </span>

    <!-- Title + status -->
    <span class="min-w-0">
        <span class="flex min-w-0 items-baseline gap-2">
            <span class="truncate text-sm font-medium text-surface-50">{activity.title}</span>
            {#if activity.occurrenceCount && activity.occurrenceCount > 1}
                <span
                    class="shrink-0 rounded bg-warning-500/15 px-1 text-[0.65rem] font-semibold text-warning-300"
                    title="{activity.occurrenceCount} identical events collapsed"
                    >×{activity.occurrenceCount}</span>
            {/if}
        </span>
        <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
            <Icon
                src={getActivityIcon(activity.activityType)}
                class="h-3.5 w-3.5 shrink-0 {getActivityColor(activity.activityType)}" />
            <span class="shrink-0 font-medium {getActivityColor(activity.activityType)}"
                >{getActivityVerb(activity)}</span>
            {#if subtitle}
                <span class="truncate text-surface-400">· {subtitle}</span>
            {/if}
        </span>
        <!-- Narrow screens fold user + device into a third line -->
        <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-surface-400 md:hidden">
            <span class="shrink-0 text-surface-200">{user}</span>
            {#if device || client}
                <span class="truncate">· {device || client}</span>
            {/if}
        </span>
    </span>

    <!-- User (md+) -->
    <span class="hidden truncate text-sm text-surface-200 md:block" title={user}>{user}</span>

    <!-- Device / client / play method (md+) -->
    <span class="hidden min-w-0 md:block">
        {#if device || client}
            <span
                class="block truncate text-xs text-surface-200"
                title={deviceInfo.tooltip ?? [device, client].filter(Boolean).join(' · ')}>
                {device || client}
            </span>
            <span class="mt-0.5 flex min-w-0 items-center gap-1.5">
                {#if device && client}
                    <span class="truncate text-xs text-surface-500">{client}</span>
                {/if}
                {#if activity.playMethod}
                    <span
                        class="{playMethodBadge(
                            activity.playMethod,
                        )} shrink-0 !px-1.5 !py-0 !text-[0.65rem]"
                        >{labelPlayMethod(activity.playMethod)}</span>
                {/if}
            </span>
        {:else}
            <span class="text-xs text-surface-600">—</span>
        {/if}
    </span>

    <!-- Progress / outcome -->
    <span class="flex flex-col items-end gap-1 text-right">
        <span class="whitespace-nowrap font-mono text-xs tabular-nums text-surface-400 md:hidden">
            {time}
        </span>
        {#if progress !== null}
            <span class="hidden w-full md:block">
                <span class="block h-1 w-full overflow-hidden rounded-full bg-surface-700">
                    <span
                        class="block h-full rounded-full {activity.activityType === 'finished'
                            ? 'bg-green-500'
                            : 'bg-primary-500'}"
                        style:width="{Math.max(progress, 2)}%"></span>
                </span>
            </span>
            <span class="text-xs tabular-nums text-surface-400">
                {[
                    activity.watchTimeSeconds === null
                        ? null
                        : formatDuration(activity.watchTimeSeconds),
                    `${Math.round(progress)}%`,
                ]
                    .filter(Boolean)
                    .join(' · ')}
            </span>
        {/if}
    </span>
</button>
