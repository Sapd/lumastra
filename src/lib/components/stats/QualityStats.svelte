<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { QualityStats } from '$lib/types/personal-stats';
    import { Icon, Signal, Sparkles, Cog } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        data: QualityStats;
    }

    let { data }: Props = $props();

    // Calculate resolution totals
    let totalResolution = $derived(
        data.resolution.uhd4k + data.resolution.hd1080 + data.resolution.hd720 + data.resolution.sd,
    );

    function getResolutionPercentage(count: number): number {
        return totalResolution > 0 ? Math.round((count / totalResolution) * 100) : 0;
    }

    function formatBitrate(kbps: number): string {
        return kbps > 1000
            ? `${(kbps / 1000).toFixed(1)} ${m.stats_quality_bitrate_mbps()}`
            : `${kbps} ${m.stats_quality_bitrate_kbps()}`;
    }

    function hdrSessionLabel(count: number): string {
        return count === 1 ? m.stats_quality_sessions_one() : m.stats_quality_sessions({ count });
    }
</script>

<div class="bg-gray-800/50 rounded-xl p-6 border border-gray-700/50">
    <div class="flex items-center gap-2 mb-4">
        <Icon src={Signal} class="w-5 h-5 text-green-400" aria-hidden="true" />
        <h3 class="text-lg font-bold text-white">{m.stats_quality_title()}</h3>
    </div>

    <!-- Direct Play vs Transcode — only when the backend has real play-method
         data. These fields are omitted (not 0) when unavailable, so the whole
         block is hidden rather than rendering a fabricated "100% / 0%". -->
    {#if data.directPlayPercentage !== undefined && data.transcodePercentage !== undefined}
        <div class="grid grid-cols-2 gap-4 mb-6">
            <div
                class="bg-green-900/30 rounded-lg p-4 text-center border border-green-700/30"
                aria-label="{m.stats_quality_direct_play()}: {data.directPlayPercentage}%">
                <p class="text-2xl font-bold text-green-400" aria-hidden="true">
                    {data.directPlayPercentage}%
                </p>
                <p class="text-hint" aria-hidden="true">{m.stats_quality_direct_play()}</p>
            </div>
            <div
                class="bg-orange-900/30 rounded-lg p-4 text-center border border-orange-700/30"
                aria-label="{m.stats_quality_transcoded()}: {data.transcodePercentage}%">
                <p class="text-2xl font-bold text-orange-400" aria-hidden="true">
                    {data.transcodePercentage}%
                </p>
                <p class="text-hint" aria-hidden="true">{m.stats_quality_transcoded()}</p>
            </div>
        </div>
    {/if}

    <!-- Resolution Breakdown -->
    <div class="space-y-3">
        <p class="text-muted mb-2">{m.stats_quality_resolution()}</p>

        {#if totalResolution === 0}
            <p class="text-hint text-center py-2">{m.stats_quality_no_resolution_data()}</p>
        {:else}
            <!-- 4K -->
            {#if data.resolution.uhd4k > 0}
                <div class="flex items-center gap-3">
                    <span class="text-hint w-16" aria-hidden="true"
                        >{m.stats_quality_res_4k()}</span>
                    <div
                        class="flex-1 bg-gray-700 rounded-full h-2"
                        role="progressbar"
                        aria-valuenow={getResolutionPercentage(data.resolution.uhd4k)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label="{m.stats_quality_res_4k()}: {getResolutionPercentage(
                            data.resolution.uhd4k,
                        )}%">
                        <div
                            class="bg-purple-500 h-2 rounded-full"
                            style="width: {getResolutionPercentage(data.resolution.uhd4k)}%">
                        </div>
                    </div>
                    <span class="text-xs text-purple-400 w-10 text-right" aria-hidden="true"
                        >{getResolutionPercentage(data.resolution.uhd4k)}%</span>
                </div>
            {/if}

            <!-- 1080p -->
            {#if data.resolution.hd1080 > 0}
                <div class="flex items-center gap-3">
                    <span class="text-hint w-16" aria-hidden="true"
                        >{m.stats_quality_res_1080p()}</span>
                    <div
                        class="flex-1 bg-gray-700 rounded-full h-2"
                        role="progressbar"
                        aria-valuenow={getResolutionPercentage(data.resolution.hd1080)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label="{m.stats_quality_res_1080p()}: {getResolutionPercentage(
                            data.resolution.hd1080,
                        )}%">
                        <div
                            class="bg-blue-500 h-2 rounded-full"
                            style="width: {getResolutionPercentage(data.resolution.hd1080)}%">
                        </div>
                    </div>
                    <span class="text-xs text-blue-400 w-10 text-right" aria-hidden="true"
                        >{getResolutionPercentage(data.resolution.hd1080)}%</span>
                </div>
            {/if}

            <!-- 720p -->
            {#if data.resolution.hd720 > 0}
                <div class="flex items-center gap-3">
                    <span class="text-hint w-16" aria-hidden="true"
                        >{m.stats_quality_res_720p()}</span>
                    <div
                        class="flex-1 bg-gray-700 rounded-full h-2"
                        role="progressbar"
                        aria-valuenow={getResolutionPercentage(data.resolution.hd720)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label="{m.stats_quality_res_720p()}: {getResolutionPercentage(
                            data.resolution.hd720,
                        )}%">
                        <div
                            class="bg-cyan-500 h-2 rounded-full"
                            style="width: {getResolutionPercentage(data.resolution.hd720)}%">
                        </div>
                    </div>
                    <span class="text-xs text-cyan-400 w-10 text-right" aria-hidden="true"
                        >{getResolutionPercentage(data.resolution.hd720)}%</span>
                </div>
            {/if}

            <!-- SD -->
            {#if data.resolution.sd > 0}
                <div class="flex items-center gap-3">
                    <span class="text-hint w-16" aria-hidden="true"
                        >{m.stats_quality_res_sd()}</span>
                    <div
                        class="flex-1 bg-gray-700 rounded-full h-2"
                        role="progressbar"
                        aria-valuenow={getResolutionPercentage(data.resolution.sd)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label="{m.stats_quality_res_sd()}: {getResolutionPercentage(
                            data.resolution.sd,
                        )}%">
                        <div
                            class="bg-gray-500 h-2 rounded-full"
                            style="width: {getResolutionPercentage(data.resolution.sd)}%">
                        </div>
                    </div>
                    <span class="text-hint w-10 text-right" aria-hidden="true"
                        >{getResolutionPercentage(data.resolution.sd)}%</span>
                </div>
            {/if}
        {/if}
        <!-- Sessions without a recorded resolution are left out of the shares
             above rather than counted as SD. -->
        {#if data.resolution.unknown}
            <p class="text-caption mt-2">
                {m.stats_quality_res_unknown({ count: data.resolution.unknown })}
            </p>
        {/if}
    </div>

    <!-- HDR Stats — hdrCount is omitted when there is no backing data. -->
    {#if data.hdrCount && data.hdrCount > 0}
        <div class="mt-4 pt-4 border-t border-gray-700">
            <div class="between">
                <div class="flex items-center gap-2">
                    <Icon src={Sparkles} class="w-4 h-4 text-yellow-400" aria-hidden="true" />
                    <span class="text-subtitle">{m.stats_quality_hdr()}</span>
                </div>
                <span class="text-sm font-medium text-yellow-400"
                    >{hdrSessionLabel(data.hdrCount)}</span>
            </div>
        </div>
    {/if}

    <!-- Average Bitrate -->
    {#if data.avgBitrateKbps}
        <div class="mt-4 pt-4 border-t border-gray-700">
            <div class="between">
                <div class="flex items-center gap-2">
                    <Icon src={Cog} class="w-4 h-4 text-gray-400" aria-hidden="true" />
                    <span class="text-subtitle">{m.stats_quality_avg_bitrate()}</span>
                </div>
                <span class="text-muted">
                    {formatBitrate(data.avgBitrateKbps)}
                </span>
            </div>
        </div>
    {/if}
</div>
