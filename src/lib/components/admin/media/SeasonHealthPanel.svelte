<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { Icon, CheckCircle, ExclamationTriangle } from 'svelte-hero-icons';

    interface EpisodeGroup {
        groupId: string;
        groupName: string;
        episodeCount: number;
        groupType?: string;
        countScore?: number;
        structureScore?: number;
        chapterScore?: number;
        chapterNameMatch?: number | null;
    }

    interface SeasonHealthData {
        localCount: number;
        providerCount: number;
        match: boolean;
        missingCount: number;
        episodesWithChapters: number;
        episodesWithChapterData: Array<{
            episodeNumber: number;
            chapterCount: number;
        }>;
        episodeGroups: EpisodeGroup[];
    }

    interface Props {
        data: SeasonHealthData;
        seasonNumber: number;
        /** Show detailed score breakdown per episode group */
        detailed?: boolean;
        applyingGroupId?: string | null;
        onapplygroup?: (groupId: string, groupType?: string) => void;
    }

    let {
        data,
        seasonNumber,
        detailed = false,
        applyingGroupId = null,
        onapplygroup,
    }: Props = $props();
</script>

<!-- Stats Grid -->
<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
    <div class="bg-surface-800/50 rounded-lg p-3">
        <div class="text-xs text-surface-400 uppercase">{m.media_plain_local_episodes()}</div>
        <div class="text-2xl font-bold text-white">{data.localCount}</div>
    </div>
    <div class="bg-surface-800/50 rounded-lg p-3">
        <div class="text-xs text-surface-400 uppercase">{m.media_plain_provider_episodes()}</div>
        <div class="text-2xl font-bold text-white">{data.providerCount}</div>
    </div>
    <div class="bg-surface-800/50 rounded-lg p-3">
        <div class="text-xs text-surface-400 uppercase">{m.media_plain_missing()}</div>
        <div class="text-2xl font-bold {data.missingCount > 0 ? 'text-red-400' : 'text-green-400'}">
            {data.missingCount}
        </div>
    </div>
    <div class="bg-surface-800/50 rounded-lg p-3">
        <div class="text-xs text-surface-400 uppercase">{m.media_plain_with_chapters()}</div>
        <div class="text-2xl font-bold text-white">
            {data.episodesWithChapters}
        </div>
    </div>
</div>

<!-- Match Status -->
<div
    class="flex items-center gap-2 p-3 rounded-lg {data.match
        ? 'bg-green-900/20'
        : 'bg-red-900/20'}">
    {#if data.match}
        <Icon src={CheckCircle} class="w-5 h-5 text-green-400" />
        <span class="text-green-400">{m.media_plain_count_matches()}</span>
    {:else}
        <Icon src={ExclamationTriangle} class="w-5 h-5 text-red-400" />
        <span class="text-red-400">
            {m.media_plain_count_comparison({
                local: data.localCount,
                provider: data.providerCount,
                missing: data.missingCount,
            })}
        </span>
    {/if}
</div>

<!-- Episode Groups -->
{#if data.episodeGroups.length > 0}
    <div>
        <h4 class="text-sm font-medium text-surface-300 uppercase tracking-wide mb-3">
            {m.media_plain_order_options()}
        </h4>
        {#if detailed}
            <p class="text-xs text-surface-500 mb-3">
                {m.media_plain_order_scope()}
            </p>
        {/if}
        <div class="space-y-2">
            {#each data.episodeGroups as group (group.groupId)}
                <div
                    class="bg-surface-800/40 border border-surface-700/50 rounded-lg p-{detailed
                        ? '4'
                        : '3'}">
                    <div class="flex items-center justify-between">
                        <div>
                            <div class="flex items-center gap-2">
                                <div class="text-surface-200 font-medium">
                                    {group.groupName}
                                </div>
                                {#if detailed && group.countScore != null}
                                    <span
                                        class="text-xs px-2 py-0.5 rounded-full {group.countScore >=
                                        60
                                            ? 'bg-green-400/10 text-green-400'
                                            : group.countScore >= 30
                                              ? 'bg-yellow-400/10 text-yellow-400'
                                              : 'bg-surface-400/10 text-surface-400'}">
                                        {m.media_plain_score({ score: group.countScore })}
                                    </span>
                                {/if}
                            </div>
                            <div class="text-xs text-surface-500 mt-1">
                                {m.media_plain_episodes({ count: group.episodeCount })}
                            </div>
                        </div>
                        {#if onapplygroup}
                            <button
                                class="btn variant-filled-primary text-sm px-3 py-1"
                                disabled={applyingGroupId === group.groupId}
                                onclick={() => onapplygroup?.(group.groupId, group.groupType)}>
                                {#if applyingGroupId === group.groupId}
                                    Applying...
                                {:else}
                                    Apply
                                {/if}
                            </button>
                        {/if}
                    </div>
                    <!-- Detailed score breakdown -->
                    {#if detailed && group.countScore != null}
                        <div class="mt-3 pt-3 border-t border-surface-700/30">
                            <div class="grid grid-cols-4 gap-2 text-xs">
                                <div>
                                    <div class="text-surface-500">{m.media_plain_count()}</div>
                                    <div class="text-surface-300 font-mono">
                                        {group.countScore}%
                                    </div>
                                </div>
                                <div>
                                    <div class="text-surface-500">{m.media_plain_structure()}</div>
                                    <div class="text-surface-300 font-mono">
                                        {group.structureScore}%
                                    </div>
                                </div>
                                <div>
                                    <div class="text-surface-500">{m.media_plain_chapters()}</div>
                                    <div class="text-surface-300 font-mono">
                                        {group.chapterScore}%
                                    </div>
                                </div>
                                <div>
                                    <div class="text-surface-500">
                                        {m.media_plain_chapter_names()}
                                    </div>
                                    <div class="text-surface-300 font-mono">
                                        {group.chapterNameMatch != null
                                            ? `${group.chapterNameMatch}%`
                                            : m.media_plain_not_available()}
                                    </div>
                                </div>
                            </div>
                        </div>
                    {/if}
                </div>
            {/each}
        </div>
    </div>
{/if}

<!-- Episodes with Chapters -->
{#if data.episodesWithChapterData.length > 0}
    <div>
        <h4 class="text-sm font-medium text-surface-300 uppercase tracking-wide mb-3">
            {m.media_plain_episodes_with_chapters()}
        </h4>
        {#if detailed}
            <div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                {#each data.episodesWithChapterData as ep (ep.episodeNumber)}
                    <div class="bg-surface-800/40 rounded-lg p-2 text-center">
                        <div class="text-surface-200 font-medium">
                            E{ep.episodeNumber}
                        </div>
                        <div class="text-xs text-surface-500">
                            {m.media_plain_chapter_count({ count: ep.chapterCount })}
                        </div>
                    </div>
                {/each}
            </div>
        {:else}
            <div class="flex flex-wrap gap-2">
                {#each data.episodesWithChapterData as ep (ep.episodeNumber)}
                    <span class="px-2 py-1 bg-surface-700/50 rounded text-sm text-surface-300">
                        E{ep.episodeNumber}: {m.media_plain_chapter_count({
                            count: ep.chapterCount,
                        })}
                    </span>
                {/each}
            </div>
        {/if}
    </div>
{/if}
