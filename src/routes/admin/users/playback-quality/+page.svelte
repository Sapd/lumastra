<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteSet } from 'svelte/reactivity';
    /**
     * Playback Quality Dashboard
     * Shows playback telemetry data including health scores, rebuffering events,
     * bandwidth stats, and users/devices with issues.
     */
    import { onMount } from 'svelte';
    import {
        Icon,
        ChartBar,
        ExclamationCircle,
        Users,
        DevicePhoneMobile,
        ArrowPath,
        Signal,
        Clock,
        ServerStack,
        Trash,
        Tv,
    } from 'svelte-hero-icons';
    import {
        AdminPageHeader,
        ChartCard,
        StatCard,
        UsersIssueTable,
        DevicesIssueTable,
        ActionModal,
    } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import type { UserWithIssue } from '$lib/components/admin/playback/UsersIssueTable.svelte';
    import type { DeviceWithIssue } from '$lib/components/admin/playback/DevicesIssueTable.svelte';
    import HealthScoreBadge from '$lib/components/admin/playback/badges/HealthScoreBadge.svelte';
    import PlayMethodBadge from '$lib/components/admin/playback/badges/PlayMethodBadge.svelte';
    import IssueBadge from '$lib/components/admin/playback/badges/IssueBadge.svelte';
    import FormFactorIcon from '$lib/components/admin/playback/badges/FormFactorIcon.svelte';
    import Skeleton from '$lib/components/ui/Skeleton.svelte';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import {
        formatHealthScore,
        getHealthScoreColor,
        getHealthScoreBg,
        getPlayMethodBg,
        getPlayMethodLabel,
        getPlayMethodColor,
        formatIssue,
        formatBandwidth,
        getClientTypeLabel,
        formatTranscodeReasonBucket,
        transcodeReasonBucketCategory,
        getTranscodeReasonBarWidth,
        getFormFactorLabel,
        getFormFactorColor,
        FORM_FACTORS,
        toFormFactor,
        type FormFactorKey,
        type TranscodeReasonCategory,
    } from '$lib/utils/admin/playback-formatters';
    import * as adminApi from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages.js';

    interface QualitySummary {
        total_sessions: number;
        avg_health_score: number;
        min_health_score: number;
        poor_sessions?: number;
        avg_bandwidth_mbps: number;
        total_rebuffers: number;
        total_server_errors: number;
        sessions_with_issues: number;
        unique_users: number;
        unique_devices: number;
        mobile_sessions: number;
        desktop_sessions: number;
        live_sessions: number;
        vod_sessions: number;
    }

    interface TranscodingStat {
        play_method: string;
        session_count: number;
        avg_health_score: number;
        rebuffers: number;
        video_transcoding: number;
        audio_transcoding: number;
        avg_compression_ratio: number;
    }

    interface DeviceTypeStat {
        device_type: string;
        session_count: number;
        avg_health_score: number;
        rebuffers: number;
        avg_bandwidth_mbps: number;
    }

    interface StreamTypeStat {
        stream_type: string;
        session_count: number;
        avg_health_score: number;
        rebuffers: number;
        avg_bandwidth_mbps: number;
    }

    interface ClientTypeStat {
        client_type: string;
        session_count: number;
        avg_health_score: number;
        rebuffers: number;
    }

    interface DailyTrend {
        date: string;
        sessions: number;
        avg_health_score: number;
        rebuffers: number;
        avg_bandwidth_mbps: number;
    }

    interface CommonIssue {
        issue: string;
        count: number;
    }

    interface DailyByDeviceType {
        date: string;
        /** Device class: mobile / tablet / tv / desktop / unknown. */
        device_type: string;
        session_count: number;
        avg_health_score: number;
        rebuffers: number;
    }

    interface TranscodeReason {
        reason_bucket: string;
        session_count: number;
        avg_health_score: number;
        rebuffers: number;
    }

    interface CrossTabEntry {
        /** Device class: mobile / tablet / tv / desktop / unknown. */
        device_type: string;
        play_method: string;
        session_count: number;
        avg_health_score: number;
        rebuffers: number;
        avg_bandwidth_mbps: number;
    }

    interface DeliveryPercentiles {
        p50Ms: number;
        p95Ms: number;
        p99Ms: number;
        sampleCount: number;
    }

    // Tooltip explanations for metrics
    const tooltips = {
        healthScore: m.admin_pbquality_tooltip_health_score(),
        bandwidth: m.admin_pbquality_tooltip_bandwidth(),
        rebuffers: m.admin_pbquality_tooltip_rebuffers(),
        serverErrors: m.admin_pbquality_tooltip_server_errors(),
        compression: m.admin_pbquality_tooltip_compression(),
        delivery: m.admin_pbquality_tooltip_delivery(),
    };

    // Analytics data state
    let analyticsData = $state({
        summary: null as QualitySummary | null,
        byClientType: [] as ClientTypeStat[],
        transcodingStats: [] as TranscodingStat[],
        deviceTypeStats: [] as DeviceTypeStat[],
        streamTypeStats: [] as StreamTypeStat[],
        dailyTrends: [] as DailyTrend[],
        dailyByDeviceType: [] as DailyByDeviceType[],
        transcodeReasons: [] as TranscodeReason[],
        crossTabAnalysis: [] as CrossTabEntry[],
        usersWithIssues: [] as UserWithIssue[],
        devicesWithIssues: [] as DeviceWithIssue[],
        commonIssues: [] as CommonIssue[],
        deliveryPercentiles: null as DeliveryPercentiles | null,
        scoringModelVersion: null as number | null,
        transcodesWithoutReason: 0,
    });

    // Page state
    let pageState = $state({
        loading: true,
        error: null as string | null,
        days: 7,
        isClearing: false,
        showClearModal: false,
        clearConfirmInput: '',
    });

    onMount(() => {
        loadQualityStats();
    });

    // Bumped per request: switching 7 -> 30 -> 14 days quickly must not let the
    // slower 7-day response land last and show under the 14-day selector.
    let loadGeneration = 0;

    async function loadQualityStats() {
        const generation = ++loadGeneration;
        pageState.loading = true;
        pageState.error = null;

        try {
            const { data, error: apiError } = await adminApi.getPlaybackQuality(pageState.days);
            if (generation !== loadGeneration) return;
            if (apiError) {
                pageState.error = apiError;
                return;
            }
            if (!data) {
                pageState.error = m.route_admin_playback_load_error();
                return;
            }

            analyticsData.summary = (data.summary as QualitySummary | undefined) ?? null;
            analyticsData.byClientType = (data.byClientType as ClientTypeStat[]) || [];
            analyticsData.transcodingStats = (data.transcodingStats as TranscodingStat[]) || [];
            analyticsData.deviceTypeStats = (data.deviceTypeStats as DeviceTypeStat[]) || [];
            analyticsData.streamTypeStats = (data.streamTypeStats as StreamTypeStat[]) || [];
            analyticsData.dailyTrends = (data.dailyTrends as DailyTrend[]) || [];
            analyticsData.dailyByDeviceType = (data.dailyByDeviceType as DailyByDeviceType[]) || [];
            analyticsData.transcodeReasons = (data.transcodeReasons as TranscodeReason[]) || [];
            analyticsData.crossTabAnalysis = (data.crossTabAnalysis as CrossTabEntry[]) || [];
            analyticsData.usersWithIssues = (data.usersWithIssues as UserWithIssue[]) || [];
            analyticsData.devicesWithIssues = (data.devicesWithIssues as DeviceWithIssue[]) || [];
            analyticsData.commonIssues = (data.commonIssues as CommonIssue[]) || [];
            analyticsData.deliveryPercentiles =
                (data.deliveryPercentiles as DeliveryPercentiles | undefined) ?? null;
            analyticsData.scoringModelVersion = data.scoringModelVersion ?? null;
            analyticsData.transcodesWithoutReason = data.transcodesWithoutReason ?? 0;
        } catch (error) {
            if (generation !== loadGeneration) return;
            console.error('Failed to load quality stats:', error);
            pageState.error = getErrorMessage(error, m.route_admin_playback_load_error());
        } finally {
            if (generation === loadGeneration) pageState.loading = false;
        }
    }

    function handleDaysChange() {
        loadQualityStats();
    }

    // Clear playback quality data — called by ActionModal on confirm
    async function clearPlaybackData() {
        pageState.isClearing = true;
        try {
            const { error } = await adminApi.clearPlaybackQuality();
            if (error) {
                throw new Error(error);
            }
            pageState.showClearModal = false;
            pageState.clearConfirmInput = '';
            toasts.success(m.admin_pbquality_clear_success());
            await loadQualityStats();
        } catch (error) {
            console.error('Failed to clear playback data:', error);
            toasts.error(getErrorMessage(error, m.admin_pbquality_clear_error()));
        } finally {
            pageState.isClearing = false;
        }
    }

    function shortDate(date: string): string {
        return date.split('-').slice(1).join('/');
    }

    function sharePercent(count: number, total: number): number {
        return total > 0 ? Math.min(100, Math.max(0, (count / total) * 100)) : 0;
    }

    // Sessions per day. `percentage` is the day's share of the window, which is
    // what the chart tooltip prints next to the count ("70 sessions (12%)").
    let dailyChartData = $derived.by(() => {
        const total = analyticsData.dailyTrends.reduce((sum, d) => sum + d.sessions, 0);
        return analyticsData.dailyTrends
            .slice()
            .reverse()
            .map((d) => ({
                label: shortDate(d.date),
                count: d.sessions,
                percentage: Math.round(sharePercent(d.sessions, total)),
            }));
    });

    let clientTypeChartData = $derived.by(() => {
        const total = analyticsData.byClientType.reduce((sum, c) => sum + c.session_count, 0);
        return analyticsData.byClientType.map((c) => ({
            label: getClientTypeLabel(c.client_type),
            count: c.session_count,
            percentage: Math.round(sharePercent(c.session_count, total)),
        }));
    });

    function sessionsTotalLabel(total: number): string {
        return m.admin_pbquality_sessions_total({ count: total.toLocaleString() });
    }

    // Device classes that actually occur in the window, in display order. Every
    // per-device panel draws from this, so an install without TVs shows no TV
    // column and a class never appears as an all-"—" row.
    let presentFormFactors = $derived(
        FORM_FACTORS.filter((ff) =>
            analyticsData.deviceTypeStats.some(
                (d) => toFormFactor(d.device_type) === ff && d.session_count > 0,
            ),
        ),
    );

    let deviceTypeCards = $derived(
        presentFormFactors
            .map((ff) =>
                analyticsData.deviceTypeStats.find((d) => toFormFactor(d.device_type) === ff),
            )
            .filter((d): d is DeviceTypeStat => d !== undefined),
    );

    // Build cross-tab matrix data
    let crossTabMatrix = $derived(
        (() => {
            const hasUnknown = analyticsData.crossTabAnalysis.some(
                (e) => e.play_method === 'unknown',
            );
            const playMethods = hasUnknown
                ? ['DirectPlay', 'DirectStream', 'Transcode', 'unknown']
                : ['DirectPlay', 'DirectStream', 'Transcode'];
            const deviceTypes = FORM_FACTORS.filter((ff) =>
                analyticsData.crossTabAnalysis.some((e) => toFormFactor(e.device_type) === ff),
            );

            const matrix: Record<string, Record<string, CrossTabEntry | null>> = {};
            for (const dt of deviceTypes) {
                matrix[dt] = {};
                for (const pm of playMethods) {
                    const entry = analyticsData.crossTabAnalysis.find(
                        (e) => toFormFactor(e.device_type) === dt && e.play_method === pm,
                    );
                    matrix[dt][pm] = entry || null;
                }
            }
            return { matrix, playMethods, deviceTypes };
        })(),
    );

    // Daily health per device class for the time-series chart.
    let dailyDeviceTypeData = $derived.by(() => {
        const dates = [...new SvelteSet(analyticsData.dailyByDeviceType.map((d) => d.date))].sort();
        const series = FORM_FACTORS.filter((ff) =>
            analyticsData.dailyByDeviceType.some((d) => toFormFactor(d.device_type) === ff),
        );
        const byDate = dates.map((date) => ({
            date,
            points: series.map((ff) => {
                const row = analyticsData.dailyByDeviceType.find(
                    (d) => d.date === date && toFormFactor(d.device_type) === ff,
                );
                return {
                    formFactor: ff as FormFactorKey,
                    score: row?.avg_health_score ?? 0,
                    sessions: row?.session_count ?? 0,
                };
            }),
        }));
        return { dates, series, byDate };
    });

    // Y-axis for the health-over-time chart: baseline 70, top 100.
    // Scores below 70 clamp to 0 % so they still appear as a sliver.
    const CHART_MIN = 70;
    const CHART_MAX = 100;
    const CHART_RANGE = CHART_MAX - CHART_MIN;

    function scoreToHeight(score: number): string {
        if (score <= 0) return '0%';
        const clamped = Math.max(CHART_MIN, Math.min(CHART_MAX, score));
        // A floor so a sub-70 day still reads as a bar, not as "no data".
        return `${Math.max(2, ((clamped - CHART_MIN) / CHART_RANGE) * 100)}%`;
    }

    const CLEAR_WORD = 'CLEAR';
</script>

<div class="space-y-8">
    <AdminPageHeader
        icon={adminPageIcons['/admin/users/playback-quality']}
        title={m.route_admin_playback_title()}
        description={m.route_admin_playback_description()}>
        <div class="flex flex-wrap items-center gap-2 sm:gap-3">
            <!-- L21 + L24: disable while loading, aria-label -->
            <select
                bind:value={pageState.days}
                onchange={handleDaysChange}
                aria-label={m.admin_pbquality_aria_time_range()}
                aria-busy={pageState.loading && analyticsData.summary !== null}
                disabled={pageState.loading}
                class="bg-surface-700 border border-surface-600 rounded-lg px-4 py-2 text-sm focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed">
                <option value={7}>{m.route_admin_playback_last_7_days()}</option>
                <option value={14}>{m.route_admin_playback_last_14_days()}</option>
                <option value={30}>{m.route_admin_playback_last_30_days()}</option>
            </select>
            <button
                onclick={loadQualityStats}
                class="btn btn-blue"
                aria-label={m.admin_pbquality_aria_refresh()}
                disabled={pageState.loading}>
                <Icon src={ArrowPath} class="w-4 h-4 {pageState.loading ? 'animate-spin' : ''}" />
                {m.btn_refresh()}
            </button>
            <!-- L13: destructive, irreversible — a quiet trigger for a type-to-confirm
                 modal, not a solid red button beside Refresh. -->
            <button
                onclick={() => {
                    pageState.clearConfirmInput = '';
                    pageState.showClearModal = true;
                }}
                class="btn btn-sm btn-soft-red flex items-center gap-2"
                aria-label={m.admin_pbquality_aria_clear_data()}
                disabled={pageState.isClearing || pageState.loading}>
                <Icon src={Trash} class="w-4 h-4" />
                {m.admin_pbquality_clear_button()}
            </button>
        </div>
    </AdminPageHeader>

    <!-- L21: loading overlay when data already exists -->
    {#if pageState.loading && analyticsData.summary !== null}
        <div class="relative">
            <div
                class="absolute inset-0 bg-surface-900/60 rounded-xl z-10 flex items-center justify-center"
                aria-live="polite"
                aria-label={m.admin_pbquality_aria_loading_update()}>
                <Icon src={ArrowPath} class="w-8 h-8 text-blue-400 animate-spin" />
            </div>
        </div>
    {/if}

    {#if pageState.loading && !analyticsData.summary}
        <!-- First load: the page's own shape, not a lone spinner. -->
        <div class="space-y-6" aria-busy="true" aria-label={m.loading()}>
            <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {#each [0, 1, 2, 3, 4] as n (n)}
                    <Skeleton height="h-28" rounded="lg" />
                {/each}
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {#each [0, 1, 2] as n (n)}
                    <Skeleton height="h-24" rounded="lg" />
                {/each}
            </div>
            <Skeleton height="h-56" rounded="lg" />
        </div>
    {:else if pageState.error}
        <div class="bg-red-500/10 border border-red-500/50 rounded-lg p-6 text-center">
            <Icon src={ExclamationCircle} class="w-8 h-8 text-red-400 mx-auto mb-2" />
            <p class="text-red-400">{pageState.error}</p>
            <button onclick={loadQualityStats} class="btn btn-red mt-4">
                {m.retry()}
            </button>
        </div>
    {:else if analyticsData.summary}
        <!-- L20: empty state replaces all detail grids when no sessions -->
        {#if !analyticsData.summary.total_sessions}
            <div class="text-center py-12 bg-surface-800/50 border border-surface-700 rounded-xl">
                <Icon src={ChartBar} class="w-12 h-12 text-surface-500 mx-auto mb-4" />
                <h3 class="text-xl font-semibold text-surface-300 mb-2">
                    {m.route_admin_playback_empty_title()}
                </h3>
                <p class="text-surface-500">
                    {m.route_admin_playback_empty_body()}
                </p>
            </div>
        {:else}
            {@const summary = analyticsData.summary}
            <!-- Summary Cards -->
            <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
                <StatCard
                    variant="glass"
                    icon={Signal}
                    title={m.route_admin_playback_avg_health_score()}
                    value={formatHealthScore(summary.avg_health_score)}
                    subtitle={summary.poor_sessions !== undefined
                        ? m.admin_pbquality_poor_sessions({ count: summary.poor_sessions })
                        : m.admin_pbquality_min_value({
                              value: formatHealthScore(summary.min_health_score),
                          })}
                    valueColor={getHealthScoreColor(summary.avg_health_score)}
                    tooltip={tooltips.healthScore} />

                <StatCard
                    variant="glass"
                    icon={ChartBar}
                    title={m.route_admin_playback_total_sessions()}
                    value={summary.total_sessions.toLocaleString()}
                    subtitle={m.admin_pbquality_users_devices({
                        users: summary.unique_users,
                        devices: summary.unique_devices,
                    })} />

                <StatCard
                    variant="glass"
                    icon={Clock}
                    title={m.route_admin_playback_rebuffer_events()}
                    value={summary.total_rebuffers}
                    subtitle={m.admin_pbquality_sessions_with_issues({
                        count: summary.sessions_with_issues,
                    })}
                    valueColor={summary.total_rebuffers > 0 ? 'text-orange-400' : 'text-green-400'}
                    tooltip={tooltips.rebuffers} />

                <StatCard
                    variant="glass"
                    icon={ServerStack}
                    title={m.route_admin_playback_server_errors()}
                    value={summary.total_server_errors}
                    valueColor={summary.total_server_errors > 0 ? 'text-red-400' : 'text-green-400'}
                    tooltip={tooltips.serverErrors} />

                <StatCard
                    variant="glass"
                    icon={Signal}
                    title={m.route_admin_playback_avg_bandwidth()}
                    value={formatBandwidth(summary.avg_bandwidth_mbps)}
                    valueColor="text-blue-400"
                    tooltip={tooltips.bandwidth} />
            </div>

            <!-- Server segment-delivery latency percentiles -->
            {#if analyticsData.deliveryPercentiles}
                {@const dp = analyticsData.deliveryPercentiles}
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <StatCard
                        variant="glass"
                        icon={Clock}
                        title={m.admin_pbquality_delivery_p50()}
                        value="{Math.round(dp.p50Ms)} ms"
                        subtitle={m.admin_pbquality_samples({
                            count: dp.sampleCount.toLocaleString(),
                        })}
                        valueColor="text-green-400"
                        tooltip={tooltips.delivery} />
                    <StatCard
                        variant="glass"
                        icon={Clock}
                        title={m.admin_pbquality_delivery_p95()}
                        value="{Math.round(dp.p95Ms)} ms"
                        valueColor="text-yellow-400"
                        tooltip={tooltips.delivery} />
                    <StatCard
                        variant="glass"
                        icon={Clock}
                        title={m.admin_pbquality_delivery_p99()}
                        value="{Math.round(dp.p99Ms)} ms"
                        valueColor="text-orange-400"
                        tooltip={tooltips.delivery} />
                </div>
            {/if}

            <!-- Transcoding Breakdown -->
            {#if analyticsData.transcodingStats.length > 0}
                <div class="space-y-4">
                    <h3 class="text-xl font-semibold flex items-center gap-2">
                        <Icon src={ServerStack} class="w-6 h-6 text-orange-400" />
                        {m.route_admin_playback_transcoding_breakdown()}
                    </h3>
                    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        {#each analyticsData.transcodingStats as stat (stat.play_method)}
                            <div
                                class="bg-surface-800/50 border {getPlayMethodBg(
                                    stat.play_method,
                                )} rounded-xl p-4">
                                <div class="between mb-3">
                                    <PlayMethodBadge method={stat.play_method} />
                                    <HealthScoreBadge score={stat.avg_health_score} />
                                </div>
                                <div class="grid grid-cols-2 gap-3 text-sm">
                                    <div>
                                        <div class="text-surface-400">
                                            {m.admin_quality_sessions()}
                                        </div>
                                        <div class="font-semibold text-white">
                                            {stat.session_count}
                                        </div>
                                    </div>
                                    <div>
                                        <div class="text-surface-400">
                                            {m.admin_quality_rebuffers()}
                                        </div>
                                        <div
                                            class="font-semibold {stat.rebuffers > 0
                                                ? 'text-orange-400'
                                                : 'text-white'}">
                                            {stat.rebuffers}
                                        </div>
                                    </div>
                                    {#if stat.play_method === 'Transcode'}
                                        <div>
                                            <div class="text-surface-400">
                                                {m.admin_pbquality_video_transcode()}
                                            </div>
                                            <div class="font-semibold text-white">
                                                {stat.video_transcoding}
                                            </div>
                                        </div>
                                        {#if stat.avg_compression_ratio}
                                            <div>
                                                <div
                                                    class="text-surface-400"
                                                    title={tooltips.compression}>
                                                    {m.admin_pbquality_compression()}
                                                </div>
                                                <div class="font-semibold text-white">
                                                    {Number(stat.avg_compression_ratio).toFixed(1)}x
                                                </div>
                                            </div>
                                        {/if}
                                    {/if}
                                </div>
                            </div>
                        {/each}
                    </div>
                </div>
            {/if}

            <!-- Quality by device class (phone / tablet / TV / desktop) -->
            {#if deviceTypeCards.length > 0}
                <div class="space-y-4">
                    <h3 class="text-xl font-semibold flex items-center gap-2">
                        <Icon src={DevicePhoneMobile} class="w-6 h-6 text-purple-400" />
                        {m.route_admin_playback_quality_by_device()}
                    </h3>
                    <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                        {#each deviceTypeCards as stat (stat.device_type)}
                            <div class="bg-surface-800/50 border border-surface-700 rounded-xl p-4">
                                <div class="between mb-2">
                                    <span class="font-medium flex items-center gap-2">
                                        <FormFactorIcon
                                            formFactor={stat.device_type}
                                            class="w-5 h-5" />
                                        {getFormFactorLabel(stat.device_type)}
                                        <span class="text-caption font-normal">
                                            {m.admin_pbquality_share_of_sessions({
                                                percent: sharePercent(
                                                    stat.session_count,
                                                    summary.total_sessions,
                                                ).toFixed(0),
                                            })}
                                        </span>
                                    </span>
                                    <HealthScoreBadge score={stat.avg_health_score} />
                                </div>
                                <div class="grid grid-cols-3 gap-4 text-sm">
                                    <div>
                                        <div class="text-surface-400">
                                            {m.admin_quality_sessions()}
                                        </div>
                                        <div class="font-semibold">{stat.session_count}</div>
                                    </div>
                                    <div>
                                        <div class="text-surface-400">
                                            {m.admin_quality_rebuffers()}
                                        </div>
                                        <div
                                            class="font-semibold {stat.rebuffers > 0
                                                ? 'text-orange-400'
                                                : ''}">
                                            {stat.rebuffers}
                                        </div>
                                    </div>
                                    <div>
                                        <div class="text-surface-400">
                                            {m.admin_quality_bandwidth()}
                                        </div>
                                        <div class="font-semibold">
                                            {formatBandwidth(stat.avg_bandwidth_mbps)}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        {/each}
                    </div>
                </div>
            {/if}

            <!-- Stream Type Quality — only when there is more than one type to
                 compare; a single "VOD 100 %" card repeats the page totals. -->
            {#if analyticsData.streamTypeStats.length > 1}
                <div class="space-y-4">
                    <h3 class="text-xl font-semibold flex items-center gap-2">
                        <Icon src={Tv} class="w-6 h-6 text-red-400" />
                        {m.route_admin_playback_quality_by_stream()}
                    </h3>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {#each analyticsData.streamTypeStats as stat (stat.stream_type)}
                            <div class="bg-surface-800/50 border border-surface-700 rounded-xl p-4">
                                <div class="between mb-2">
                                    <span class="font-medium">
                                        {stat.stream_type === 'live'
                                            ? m.widget_live_tv()
                                            : m.admin_pbquality_vod()}
                                        <span class="text-caption font-normal ml-1">
                                            {m.admin_pbquality_share_of_sessions({
                                                percent: sharePercent(
                                                    stat.session_count,
                                                    summary.total_sessions,
                                                ).toFixed(0),
                                            })}
                                        </span>
                                    </span>
                                    <HealthScoreBadge score={stat.avg_health_score} />
                                </div>
                                <div class="grid grid-cols-3 gap-4 text-sm">
                                    <div>
                                        <div class="text-surface-400">
                                            {m.admin_quality_sessions()}
                                        </div>
                                        <div class="font-semibold">{stat.session_count}</div>
                                    </div>
                                    <div>
                                        <div class="text-surface-400">
                                            {m.admin_quality_rebuffers()}
                                        </div>
                                        <div
                                            class="font-semibold {stat.rebuffers > 0
                                                ? 'text-orange-400'
                                                : ''}">
                                            {stat.rebuffers}
                                        </div>
                                    </div>
                                    <div>
                                        <div class="text-surface-400">
                                            {m.admin_quality_bandwidth()}
                                        </div>
                                        <div class="font-semibold">
                                            {formatBandwidth(stat.avg_bandwidth_mbps)}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        {/each}
                    </div>
                </div>
            {/if}

            <!-- Time-Series Health by device class — L14 + L15: accessible figure,
                 visually-hidden table, normalized Y-axis -->
            {#if dailyDeviceTypeData.dates.length > 0}
                <div class="space-y-4">
                    <h3 class="text-xl font-semibold flex items-center gap-2">
                        <Icon src={ChartBar} class="w-6 h-6 text-blue-400" />
                        {m.route_admin_playback_health_over_time()}
                        {#if analyticsData.scoringModelVersion}
                            <span
                                class="ml-2 text-xs font-normal text-surface-500"
                                title={m.admin_pbquality_scoring_model_version({
                                    version: String(analyticsData.scoringModelVersion),
                                })}>
                                v{analyticsData.scoringModelVersion}
                            </span>
                        {/if}
                    </h3>
                    <div class="bg-surface-800/50 border border-surface-700 rounded-xl p-4">
                        <figure>
                            <figcaption class="sr-only">
                                {m.admin_pbquality_chart_caption()}
                            </figcaption>

                            <!-- Visually-hidden data table for screen readers -->
                            <!-- sr-only on a wrapping div, NOT on the <table>: a table ignores width:1px
                                 (it keeps its min-content width), and as position:absolute with no positioned
                                 ancestor it escapes every overflow clip — on phones it widened the layout
                                 viewport to ~1100px, stretching all position:fixed layers with it. -->
                            <div class="sr-only">
                                <table>
                                    <caption>{m.route_admin_playback_health_over_time()}</caption>
                                    <thead>
                                        <tr>
                                            <th scope="col">{m.admin_pbquality_chart_date()}</th>
                                            {#each dailyDeviceTypeData.series as ff (ff)}
                                                <th scope="col">
                                                    {m.admin_pbquality_chart_score_col({
                                                        device: getFormFactorLabel(ff),
                                                    })}
                                                </th>
                                                <th scope="col">
                                                    {m.admin_pbquality_chart_sessions_col({
                                                        device: getFormFactorLabel(ff),
                                                    })}
                                                </th>
                                            {/each}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {#each dailyDeviceTypeData.byDate as day (day.date)}
                                            <tr>
                                                <th scope="row">{day.date}</th>
                                                {#each day.points as point (point.formFactor)}
                                                    <td
                                                        >{point.sessions > 0
                                                            ? point.score
                                                            : '—'}</td>
                                                    <td
                                                        >{point.sessions > 0
                                                            ? point.sessions
                                                            : '—'}</td>
                                                {/each}
                                            </tr>
                                        {/each}
                                    </tbody>
                                </table>
                            </div>

                            <!-- Visual chart -->
                            <div aria-hidden="true">
                                <div class="flex flex-wrap items-center gap-x-6 gap-y-2 mb-4">
                                    {#each dailyDeviceTypeData.series as ff (ff)}
                                        <div class="flex items-center gap-2">
                                            <div
                                                class="w-3 h-3 rounded-full {getFormFactorColor(ff)
                                                    .swatch}">
                                            </div>
                                            <span class="text-caption"
                                                >{getFormFactorLabel(ff)}</span>
                                        </div>
                                    {/each}
                                </div>
                                <div class="relative h-48">
                                    <!-- L15: Y-axis labels show the 70–100 range -->
                                    <div
                                        class="absolute left-0 top-0 bottom-6 w-10 flex flex-col justify-between text-caption">
                                        <span>100</span>
                                        <span>93</span>
                                        <span>85</span>
                                        <span>78</span>
                                        <span>70</span>
                                    </div>
                                    <div class="ml-12 h-full relative">
                                        <div
                                            class="absolute inset-x-0 top-0 bottom-6 flex flex-col justify-between pointer-events-none">
                                            {#each [0, 1, 2, 3, 4] as n (n)}
                                                <div class="border-t border-surface-700/50 w-full">
                                                </div>
                                            {/each}
                                        </div>
                                        <!-- items-stretch: each day column must fill the plot height,
                                             or the bars' % heights resolve against an auto-height
                                             column and every bar renders 0 px tall. -->
                                        <div
                                            class="absolute inset-x-0 bottom-6 top-0 flex items-stretch justify-around gap-1">
                                            {#each dailyDeviceTypeData.byDate as day (day.date)}
                                                <div
                                                    class="flex-1 flex items-end justify-center gap-0.5 group relative">
                                                    {#each day.points as point (point.formFactor)}
                                                        {#if point.sessions > 0}
                                                            <div
                                                                class="w-2 rounded-t transition-all group-hover:opacity-90 {getFormFactorColor(
                                                                    point.formFactor,
                                                                ).swatch}"
                                                                style="height: {scoreToHeight(
                                                                    point.score,
                                                                )}">
                                                            </div>
                                                        {:else}
                                                            <div class="w-2"></div>
                                                        {/if}
                                                    {/each}
                                                    <div
                                                        class="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-surface-900 border border-surface-700 rounded px-2 py-1 text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                                                        <div class="font-medium">
                                                            {shortDate(day.date)}
                                                        </div>
                                                        {#each day.points as point (point.formFactor)}
                                                            <div
                                                                class={point.sessions > 0
                                                                    ? getFormFactorColor(
                                                                          point.formFactor,
                                                                      ).text
                                                                    : 'text-surface-500'}>
                                                                {point.sessions > 0
                                                                    ? m.admin_pbquality_chart_score_tooltip(
                                                                          {
                                                                              device: getFormFactorLabel(
                                                                                  point.formFactor,
                                                                              ),
                                                                              score: point.score,
                                                                              count: point.sessions,
                                                                          },
                                                                      )
                                                                    : m.admin_pbquality_chart_no_data(
                                                                          {
                                                                              device: getFormFactorLabel(
                                                                                  point.formFactor,
                                                                              ),
                                                                          },
                                                                      )}
                                                            </div>
                                                        {/each}
                                                    </div>
                                                </div>
                                            {/each}
                                        </div>
                                        <!-- L14: only render X-axis labels for shown ticks -->
                                        <div
                                            class="absolute bottom-0 left-0 right-0 flex justify-around text-caption">
                                            {#each dailyDeviceTypeData.dates as date, i (date)}
                                                {#if i % Math.ceil(dailyDeviceTypeData.dates.length / 7) === 0}
                                                    <span>{shortDate(date)}</span>
                                                {/if}
                                            {/each}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </figure>
                    </div>
                </div>
            {/if}

            <!-- Transcoding Reasons Breakdown — grouped by operation cost:
                 remux (repackage only) → audio transcode → video transcode. -->
            {#if analyticsData.transcodeReasons.length > 0 || analyticsData.transcodesWithoutReason > 0}
                {@const maxCount = Math.max(
                    1,
                    ...analyticsData.transcodeReasons.map((r) => r.session_count),
                )}
                {@const reasonGroups = (
                    [
                        {
                            key: 'remux',
                            label: m.admin_pbquality_reason_cat_remux(),
                            hint: m.admin_pbquality_reason_cat_remux_hint(),
                            dot: 'bg-sky-400',
                            bar: 'bg-sky-500/70',
                        },
                        {
                            key: 'audio_transcode',
                            label: m.admin_pbquality_reason_cat_audio(),
                            hint: m.admin_pbquality_reason_cat_audio_hint(),
                            dot: 'bg-yellow-400',
                            bar: 'bg-yellow-500/70',
                        },
                        {
                            key: 'video_transcode',
                            label: m.admin_pbquality_reason_cat_video(),
                            hint: m.admin_pbquality_reason_cat_video_hint(),
                            dot: 'bg-orange-400',
                            bar: 'bg-orange-500/70',
                        },
                    ] satisfies {
                        key: TranscodeReasonCategory;
                        label: string;
                        hint: string;
                        dot: string;
                        bar: string;
                    }[]
                ).map((g) => ({
                    ...g,
                    reasons: analyticsData.transcodeReasons.filter(
                        (r) => transcodeReasonBucketCategory(r.reason_bucket) === g.key,
                    ),
                }))}
                <div class="space-y-4">
                    <div>
                        <h3 class="text-xl font-semibold flex items-center gap-2">
                            <Icon src={ServerStack} class="w-6 h-6 text-orange-400" />
                            {m.route_admin_playback_why_transcoding()}
                        </h3>
                        <p class="text-caption mt-1">{m.admin_pbquality_reasons_overlap_hint()}</p>
                    </div>
                    <div
                        class="bg-surface-800/50 border border-surface-700 rounded-xl p-4 space-y-5">
                        {#each reasonGroups as group (group.key)}
                            {#if group.reasons.length > 0}
                                <div class="space-y-3">
                                    <div class="flex flex-wrap items-baseline gap-x-2">
                                        <span class="w-2 h-2 rounded-full {group.dot}"></span>
                                        <span class="text-sm font-semibold text-surface-100"
                                            >{group.label}</span>
                                        <span class="text-caption text-surface-400"
                                            >{group.hint}</span>
                                    </div>
                                    {#each group.reasons as reason, reasonIdx (reason.reason_bucket + '-' + reasonIdx)}
                                        <div class="flex items-center gap-3">
                                            <div
                                                class="w-28 sm:w-48 shrink-0 text-sm text-surface-300 truncate"
                                                title={formatTranscodeReasonBucket(
                                                    reason.reason_bucket,
                                                )}>
                                                {formatTranscodeReasonBucket(reason.reason_bucket)}
                                            </div>
                                            <!-- Bar = session count, in the category's colour;
                                                 health is the number on the right. -->
                                            <div
                                                class="flex-1 h-4 bg-surface-700/50 rounded-full overflow-hidden">
                                                <div
                                                    class="h-full rounded-full transition-all {group.bar}"
                                                    style="width: {getTranscodeReasonBarWidth(
                                                        reason.session_count,
                                                        maxCount,
                                                    )}">
                                                </div>
                                            </div>
                                            <div class="w-16 sm:w-20 text-right whitespace-nowrap">
                                                <span class="font-medium text-white"
                                                    >{reason.session_count}</span>
                                                <span class="text-caption ml-1"
                                                    >{m.admin_pbquality_sess()}</span>
                                            </div>
                                            <div class="w-12 sm:w-16 text-right">
                                                <HealthScoreBadge
                                                    score={reason.avg_health_score}
                                                    variant="text" />
                                            </div>
                                        </div>
                                    {/each}
                                </div>
                            {/if}
                        {/each}
                        {#if analyticsData.transcodesWithoutReason > 0}
                            <p class="text-sm text-surface-400 border-t border-surface-700 pt-3">
                                {m.admin_pbquality_reasons_unexplained({
                                    count: analyticsData.transcodesWithoutReason,
                                })}
                            </p>
                        {/if}
                    </div>
                </div>
            {/if}

            <!-- Cross-Tab Analysis: device class × play method — L23: caption,
                 th scope="row", accessible empty cells. Only worth a matrix when
                 there is more than one device class to compare. -->
            {#if crossTabMatrix.deviceTypes.length > 1}
                <div class="space-y-4">
                    <h3 class="text-xl font-semibold flex items-center gap-2">
                        <Icon src={ChartBar} class="w-6 h-6 text-green-400" />
                        {m.route_admin_playback_health_by_device_method()}
                    </h3>
                    <div
                        class="bg-surface-800/50 border border-surface-700 rounded-xl p-4 overflow-x-auto">
                        <table
                            class="w-full min-w-[32rem]"
                            aria-label={m.route_admin_playback_health_by_device_method()}>
                            <caption class="sr-only"
                                >{m.admin_pbquality_crosstab_caption()}</caption>
                            <thead>
                                <tr>
                                    <th
                                        class="text-left px-4 py-2 text-surface-400 font-medium w-32"
                                        scope="col"></th>
                                    {#each crossTabMatrix.playMethods as method (method)}
                                        <th
                                            class="text-center px-4 py-2 {getPlayMethodColor(
                                                method,
                                            )} font-medium"
                                            scope="col">
                                            {getPlayMethodLabel(method)}
                                        </th>
                                    {/each}
                                </tr>
                            </thead>
                            <tbody>
                                {#each crossTabMatrix.deviceTypes as deviceType (deviceType)}
                                    <tr>
                                        <th class="px-4 py-3 font-medium text-left" scope="row">
                                            <span class="flex items-center gap-2">
                                                <FormFactorIcon formFactor={deviceType} />
                                                {getFormFactorLabel(deviceType)}
                                            </span>
                                        </th>
                                        {#each crossTabMatrix.playMethods as method (method)}
                                            {@const entry =
                                                crossTabMatrix.matrix[deviceType][method]}
                                            <td class="px-4 py-3 text-center">
                                                {#if entry}
                                                    <div
                                                        class="inline-block px-3 py-2 rounded-lg {getHealthScoreBg(
                                                            entry.avg_health_score,
                                                        )} border {entry.avg_health_score >= 90
                                                            ? 'border-green-500/30'
                                                            : entry.avg_health_score >= 70
                                                              ? 'border-yellow-500/30'
                                                              : 'border-orange-500/30'} min-w-24">
                                                        <div
                                                            class="text-lg font-bold {getHealthScoreColor(
                                                                entry.avg_health_score,
                                                            )}">
                                                            {formatHealthScore(
                                                                entry.avg_health_score,
                                                            )}
                                                        </div>
                                                        <div class="text-hint">
                                                            {m.admin_pbquality_n_sessions({
                                                                count: entry.session_count,
                                                            })}
                                                        </div>
                                                        {#if entry.rebuffers > 0}
                                                            <div class="text-xs text-orange-400">
                                                                {m.admin_pbquality_n_rebuffers({
                                                                    count: entry.rebuffers,
                                                                })}
                                                            </div>
                                                        {/if}
                                                    </div>
                                                {:else}
                                                    <span
                                                        class="text-surface-500 text-sm"
                                                        aria-label={m.admin_pbquality_no_data()}
                                                        >—</span>
                                                {/if}
                                            </td>
                                        {/each}
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                </div>
            {/if}

            <!-- Charts Row -->
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {#if dailyChartData.length > 0}
                    <ChartCard
                        title={m.admin_pbquality_sessions_by_day()}
                        chartType="bar"
                        data={dailyChartData}
                        valueType="count"
                        summaryLabel={sessionsTotalLabel}
                        chartColor="#3b82f6" />
                {/if}

                {#if clientTypeChartData.length > 0}
                    <ChartCard
                        title={m.admin_pbquality_sessions_by_client_type()}
                        chartType="doughnut"
                        data={clientTypeChartData}
                        valueType="count"
                        summaryLabel={sessionsTotalLabel} />
                {/if}
            </div>

            <!-- Client Type Details -->
            {#if analyticsData.byClientType.length > 0}
                <div class="space-y-4">
                    <h3 class="text-xl font-semibold flex items-center gap-2">
                        <Icon src={DevicePhoneMobile} class="w-6 h-6 text-purple-400" />
                        {m.route_admin_playback_quality_by_client()}
                    </h3>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {#each analyticsData.byClientType as client (client.client_type)}
                            <div class="bg-surface-800/50 border border-surface-700 rounded-xl p-4">
                                <div class="between mb-2">
                                    <span class="font-medium"
                                        >{getClientTypeLabel(client.client_type)}</span>
                                    <HealthScoreBadge score={client.avg_health_score} />
                                </div>
                                <div class="grid grid-cols-2 gap-4 text-sm">
                                    <div>
                                        <div class="text-surface-400">
                                            {m.admin_quality_sessions()}
                                        </div>
                                        <div class="font-semibold">
                                            {client.session_count}
                                        </div>
                                    </div>
                                    <div>
                                        <div class="text-surface-400">
                                            {m.admin_quality_rebuffers()}
                                        </div>
                                        <div
                                            class="font-semibold {client.rebuffers > 0
                                                ? 'text-orange-400'
                                                : ''}">
                                            {client.rebuffers}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        {/each}
                    </div>
                </div>
            {/if}
            <!-- Common Issues -->
            {#if analyticsData.commonIssues.length > 0}
                {@const symptoms = analyticsData.commonIssues.filter(
                    (i) => !i.issue.startsWith('cause:'),
                )}
                {@const rootCauses = analyticsData.commonIssues.filter((i) =>
                    i.issue.startsWith('cause:'),
                )}
                <div class="space-y-4">
                    <h3 class="text-xl font-semibold flex items-center gap-2">
                        <Icon src={ExclamationCircle} class="w-6 h-6 text-orange-400" />
                        {m.route_admin_playback_common_issues()}
                    </h3>
                    <div
                        class="bg-surface-800/50 border border-surface-700 rounded-xl p-4 space-y-4">
                        {#if symptoms.length > 0}
                            <div>
                                <div class="text-caption uppercase tracking-wide mb-2">
                                    {m.route_admin_playback_symptoms()}
                                </div>
                                <div class="flex flex-wrap gap-2">
                                    {#each symptoms as issue (issue.issue)}
                                        {@const formatted = formatIssue(issue.issue)}
                                        <div
                                            class="flex items-center gap-2 px-3 py-2 bg-surface-700/50 rounded-lg">
                                            <span class="text-surface-300">{formatted.label}</span>
                                            <span
                                                class="px-2 py-0.5 bg-orange-500/20 text-orange-400 text-xs rounded-full">
                                                {issue.count}
                                            </span>
                                        </div>
                                    {/each}
                                </div>
                            </div>
                        {/if}
                        {#if rootCauses.length > 0}
                            <div>
                                <div class="text-caption uppercase tracking-wide mb-2">
                                    {m.route_admin_playback_root_causes()}
                                </div>
                                <div class="flex flex-wrap gap-2">
                                    {#each rootCauses as issue (issue.issue)}
                                        {@const formatted = formatIssue(issue.issue)}
                                        <div
                                            class="flex items-center gap-2 px-3 py-2 bg-red-900/30 border border-red-500/30 rounded-lg">
                                            <span class="text-red-300">{formatted.label}</span>
                                            <span class="badge badge-error">
                                                {issue.count}
                                            </span>
                                        </div>
                                    {/each}
                                </div>
                            </div>
                        {/if}
                    </div>
                </div>
            {/if}

            <!-- Users with Issues -->
            {#if analyticsData.usersWithIssues.length > 0}
                <div class="space-y-4">
                    <h3 class="text-xl font-semibold flex items-center gap-2">
                        <Icon src={Users} class="w-6 h-6 text-blue-400" />
                        {m.route_admin_playback_users_with_issues()}
                    </h3>
                    <UsersIssueTable users={analyticsData.usersWithIssues} />
                </div>
            {/if}

            <!-- Devices with Issues -->
            {#if analyticsData.devicesWithIssues.length > 0}
                <div class="space-y-4">
                    <h3 class="text-xl font-semibold flex items-center gap-2">
                        <Icon src={DevicePhoneMobile} class="w-6 h-6 text-purple-400" />
                        {m.route_admin_playback_devices_with_issues()}
                    </h3>
                    <DevicesIssueTable devices={analyticsData.devicesWithIssues} />
                </div>
            {/if}
        {/if}
    {/if}
</div>

<!-- L13: Clear telemetry ActionModal with type-to-confirm -->
{#if pageState.showClearModal}
    <ActionModal
        title={m.route_admin_playback_clear_data()}
        confirmText={m.route_admin_playback_clear_data()}
        confirmColor="red"
        disabled={pageState.clearConfirmInput.trim().toUpperCase() !== CLEAR_WORD ||
            pageState.isClearing}
        onclose={() => {
            pageState.showClearModal = false;
            pageState.clearConfirmInput = '';
        }}
        onconfirm={clearPlaybackData}>
        <p class="text-surface-300">
            {m.route_admin_playback_clear_confirm()}
        </p>
        <div class="mt-4">
            <label for="clear-confirm-input" class="block text-sm text-surface-400 mb-2">
                {m.admin_pbquality_clear_type_to_confirm({ word: CLEAR_WORD })}
            </label>
            <input
                id="clear-confirm-input"
                type="text"
                class="w-full bg-surface-700 border border-surface-600 rounded-lg px-4 py-2 text-white placeholder-surface-500 focus:outline-hidden focus:ring-2 focus:ring-red-500 focus:border-transparent"
                placeholder={CLEAR_WORD}
                bind:value={pageState.clearConfirmInput}
                data-autofocus />
        </div>
    </ActionModal>
{/if}
