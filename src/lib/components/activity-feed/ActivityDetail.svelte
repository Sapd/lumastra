<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Everything the feed knows about one event, grouped by the question it
  answers (what happened / how was it delivered / which client / which ids).
  Rendered inside the shared admin DetailPanel.
-->

<script lang="ts">
    import { Icon, ArrowTopRightOnSquare, Funnel } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import { getCatalogPosterUrl, handleImageError } from '$lib/utils/image-utils';
    import { formatDuration, formatRelativeTime } from '$lib/utils/time-formatting';
    import {
        type ActivityItem,
        formatBitrate,
        formatMessage,
        getActivityColor,
        getActivityIcon,
        getProgress,
        getSubtitle,
        isViewingActivity,
        labelPlayMethod,
        playMethodBadge,
    } from './activity-utils';

    let {
        activity,
        onfilteruser,
    }: { activity: ActivityItem; onfilteruser?: (userId: string) => void } = $props();

    type Field = {
        label: string;
        value: string | number | null | undefined;
        mono?: boolean;
        wide?: boolean;
    };

    const viewing = $derived(isViewingActivity(activity));
    const progress = $derived(viewing ? getProgress(activity) : null);
    const posterUrl = $derived(
        activity.mediaId ? getCatalogPosterUrl(activity.mediaId, { size: 'thumb' }) : null,
    );
    const clientLabel = $derived(
        [activity.clientName, activity.clientVersion].filter(Boolean).join(' '),
    );

    function present(fields: Field[]): Field[] {
        return fields.filter((f) => f.value !== null && f.value !== undefined && f.value !== '');
    }

    const playback = $derived(
        present([
            {
                label: 'Play method',
                value: activity.playMethod && labelPlayMethod(activity.playMethod),
            },
            { label: 'Transcode mode', value: activity.transcodeMode },
            { label: 'Playback plan', value: activity.planMode },
            { label: 'Transcode codec', value: activity.transcodeCodec },
            {
                label: 'Resolution',
                value:
                    activity.resolution ??
                    (activity.resolutionWidth ? `${activity.resolutionWidth}px wide` : null),
            },
            { label: 'Video', value: activity.videoCodec },
            { label: 'Audio', value: activity.audioCodec },
            { label: 'Container', value: activity.container },
            { label: 'Bitrate', value: activity.bitrate ? formatBitrate(activity.bitrate) : null },
            { label: 'Subtitles', value: activity.subtitleMethod },
            { label: 'Delivery path', value: activity.deliveryPath },
            { label: 'Stop reason', value: activity.stopReason },
            { label: 'Plan reasons', value: activity.planReasons?.join(', '), wide: true },
        ]),
    );

    const client = $derived(
        present([
            { label: 'Device', value: activity.deviceName },
            { label: 'Client', value: clientLabel },
            { label: 'IP address', value: activity.ipAddress, mono: true },
            { label: 'Source', value: activity.sourceService },
            { label: 'Device ID', value: activity.deviceId, mono: true, wide: true },
            { label: 'User agent', value: activity.userAgent, mono: true, wide: true },
        ]),
    );

    const identifiers = $derived(
        present([
            { label: 'Activity ID', value: activity.id, mono: true },
            { label: 'Recorded at', value: new Date(activity.createdAt).toLocaleString() },
            {
                label: 'Last session update',
                value:
                    activity.lastUpdateTime && new Date(activity.lastUpdateTime).toLocaleString(),
            },
            { label: 'User ID', value: activity.author.userId, mono: true, wide: true },
            { label: 'Media ID', value: activity.mediaId, mono: true, wide: true },
            { label: 'Play session', value: activity.sourcePlaySessionId, mono: true, wide: true },
            { label: 'Source session', value: activity.sourceSessionId, mono: true, wide: true },
            ...Object.entries(activity.externalIds)
                .filter(([, value]) => value !== null)
                .map(([provider, value]) => ({ label: `${provider} ID`, value, mono: true })),
        ]),
    );
</script>

{#snippet section(title: string, fields: Field[])}
    {#if fields.length > 0}
        <section>
            <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-surface-400">
                {title}
            </h3>
            <dl
                class="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-surface-700/50 bg-surface-800/40 p-3 text-xs">
                {#each fields as field (field.label)}
                    <div class={field.wide ? 'col-span-2' : ''}>
                        <dt class="text-surface-500">{field.label}</dt>
                        <dd
                            class="mt-0.5 select-all text-surface-100 [overflow-wrap:anywhere] {field.mono
                                ? 'font-mono text-[0.7rem]'
                                : ''}">
                            {field.value}
                        </dd>
                    </div>
                {/each}
            </dl>
        </section>
    {/if}
{/snippet}

<div class="space-y-5">
    <!-- Summary -->
    <div class="flex gap-4">
        {#if posterUrl}
            <img
                src={posterUrl}
                alt=""
                class="h-28 w-[4.7rem] shrink-0 rounded object-cover"
                onerror={(event) => handleImageError(event, { hideOnError: true })} />
        {/if}
        <div class="min-w-0 flex-1 space-y-2">
            <p class="flex items-start gap-2 text-sm font-medium text-surface-50">
                <Icon
                    src={getActivityIcon(activity.activityType)}
                    class="mt-0.5 h-4 w-4 shrink-0 {getActivityColor(activity.activityType)}" />
                <span>{formatMessage(activity)}</span>
            </p>
            {#if getSubtitle(activity)}
                <p class="text-xs text-surface-400">{getSubtitle(activity)}</p>
            {/if}
            <p class="text-xs text-surface-400">
                {new Date(activity.activityTime).toLocaleString()} · {formatRelativeTime(
                    activity.activityTime,
                )}
            </p>
            <div class="flex flex-wrap items-center gap-1.5">
                {#if activity.isActive}
                    <span class="badge-soft-green"
                        >{activity.isPaused ? 'Live · paused' : 'Live'}</span>
                {/if}
                {#if activity.playMethod}
                    <span class={playMethodBadge(activity.playMethod)}
                        >{labelPlayMethod(activity.playMethod)}</span>
                {/if}
                {#if activity.occurrenceCount && activity.occurrenceCount > 1}
                    <span class="badge-soft-yellow">×{activity.occurrenceCount} collapsed</span>
                {/if}
            </div>
        </div>
    </div>

    {#if progress !== null}
        <div class="space-y-1.5">
            <div class="h-1.5 overflow-hidden rounded-full bg-surface-700" aria-hidden="true">
                <div
                    class="h-full rounded-full {activity.activityType === 'finished'
                        ? 'bg-green-500'
                        : 'bg-primary-500'}"
                    style:width="{progress}%">
                </div>
            </div>
            <div class="flex flex-wrap justify-between gap-2 text-xs text-surface-400">
                <span>
                    {#if activity.currentPositionSeconds !== null && activity.totalDurationSeconds !== null}
                        {formatDuration(activity.currentPositionSeconds)} / {formatDuration(
                            activity.totalDurationSeconds,
                        )}
                    {:else if activity.totalDurationSeconds !== null}
                        Runtime {formatDuration(activity.totalDurationSeconds)}
                    {/if}
                </span>
                <span class="tabular-nums">
                    {[
                        activity.watchTimeSeconds === null
                            ? null
                            : `Watched ${formatDuration(activity.watchTimeSeconds)}`,
                        `${Math.round(progress)}%`,
                    ]
                        .filter(Boolean)
                        .join(' · ')}
                </span>
            </div>
        </div>
    {/if}

    <div class="flex flex-wrap gap-2">
        {#if onfilteruser}
            <button
                type="button"
                class="btn btn-sm variant-soft"
                onclick={() => onfilteruser?.(activity.author.userId)}>
                <Icon src={Funnel} class="h-4 w-4" />
                <span>Only {(activity.author.displayName ?? '') || 'this user'}</span>
            </button>
        {/if}
        {#if activity.mediaId}
            <a
                class="btn btn-sm variant-soft"
                href={resolve(`/admin/library/media/${encodeURIComponent(activity.mediaId)}`)}>
                <Icon src={ArrowTopRightOnSquare} class="h-4 w-4" />
                <span>Open media</span>
            </a>
        {/if}
    </div>

    {@render section('Playback', playback)}
    {@render section('Client', client)}
    {@render section('Identifiers', identifiers)}

    {#if activity.metadata}
        <details class="group">
            <summary
                class="cursor-pointer select-none text-xs font-medium text-surface-400 hover:text-surface-200"
                >Raw event metadata</summary>
            <pre
                class="mt-2 max-h-80 overflow-auto rounded-lg bg-surface-950 p-3 font-mono text-[0.7rem] text-surface-200">{JSON.stringify(
                    activity.metadata,
                    null,
                    2,
                )}</pre>
        </details>
    {/if}
</div>
